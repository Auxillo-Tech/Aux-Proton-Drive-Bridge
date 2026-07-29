'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require(path.join(root, 'package.json')).version;
const names = {
  appImage: `Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage`,
  deb: `Aux.Proton.Drive.Bridge-${version}-amd64.deb`,
  rpm: `Aux.Proton.Drive.Bridge-${version}-x86_64.rpm`
};
const artifacts = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, path.join(dist, name)]));
for (const [key, artifact] of Object.entries(artifacts)) {
  if (!fs.statSync(artifact, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing ${key} release artifact: ${artifact}`);
}
const unexpectedPackages = fs.readdirSync(dist).filter(name => /\.(?:AppImage|deb|rpm)$/.test(name) && !Object.values(names).includes(name));
if (unexpectedPackages.length) throw new Error(`Unexpected or stale package artifacts: ${unexpectedPackages.join(', ')}`);

function locate(base, basename) {
  const pending = [base];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.name === basename) return absolute;
    }
  }
  throw new Error(`Unable to locate ${basename} under ${base}`);
}

const expectedFuses = [
  'RunAsNode is Disabled',
  'EnableNodeOptionsEnvironmentVariable is Disabled',
  'EnableNodeCliInspectArguments is Disabled',
  'EnableEmbeddedAsarIntegrityValidation is Enabled',
  'OnlyLoadAppFromAsar is Enabled',
  'GrantFileProtocolExtraPrivileges is Disabled',
  'WasmTrapHandlers is Enabled'
];
function inspectInstallation(label, base) {
  const executable = locate(base, 'aux-proton-drive-bridge');
  const archive = locate(base, 'app.asar');
  const fuseRead = childProcess.spawnSync(process.execPath, [
    path.join(root, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js'), 'read', '--app', executable
  ], { encoding: 'utf8' });
  if (fuseRead.status !== 0) throw new Error(`${label} fuse inspection failed: ${fuseRead.stderr}`);
  for (const state of expectedFuses) if (!fuseRead.stdout.includes(state)) throw new Error(`${label} unexpected fuse state: ${state}`);
  const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packagedManifest.version !== version) throw new Error(`${label} embeds version ${packagedManifest.version}, expected ${version}`);
  return {
    executable,
    archive,
    asarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    fuses: fuseRead.stdout.trim().split('\n').slice(2)
  };
}

function extractRpm(artifact, destination) {
  const bsdtar = childProcess.spawnSync('bsdtar', ['-xf', artifact, '-C', destination], { encoding: 'utf8' });
  if (bsdtar.status === 0) return;
  if (bsdtar.error && bsdtar.error.code !== 'ENOENT') throw bsdtar.error;

  const extract = childProcess.spawnSync('bash', ['-euo', 'pipefail', '-c', 'rpm2cpio "$1" | cpio -idmu', 'extract-rpm', artifact], {
    cwd: destination,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (extract.status !== 0) throw new Error(`RPM extraction failed: ${extract.stderr || extract.error?.message || 'unknown error'}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-packages-'));
try {
  const appImageRoot = path.join(temporary, 'appimage');
  fs.mkdirSync(appImageRoot);
  const extract = childProcess.spawnSync(artifacts.appImage, ['--appimage-extract'], { cwd: appImageRoot, encoding: 'utf8' });
  if (extract.status !== 0) throw new Error(`AppImage extraction failed: ${extract.stderr}`);
  const debRoot = path.join(temporary, 'deb');
  const rpmRoot = path.join(temporary, 'rpm');
  fs.mkdirSync(debRoot);
  fs.mkdirSync(rpmRoot);
  childProcess.execFileSync('dpkg-deb', ['--extract', artifacts.deb, debRoot]);
  extractRpm(artifacts.rpm, rpmRoot);

  const installations = {
    unpacked: inspectInstallation('linux-unpacked', path.join(dist, 'linux-unpacked')),
    appImage: inspectInstallation('AppImage', path.join(appImageRoot, 'squashfs-root')),
    deb: inspectInstallation('DEB', debRoot),
    rpm: inspectInstallation('RPM', rpmRoot)
  };
  const hashes = new Set(Object.values(installations).map(item => item.asarSha256));
  if (hashes.size !== 1) throw new Error('AppImage, DEB, RPM, and unpacked ASAR payloads differ');

  const archive = installations.unpacked.archive;
  const archiveEntries = asar.listPackage(archive).map(entry => entry.replace(/^\//, ''));
  for (const expected of [
    'src/main/main.js',
    'src/renderer/index.html',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'assets/release-public-key.pem',
    'node_modules/better-sqlite3/prebuilds/linux-x64.node'
  ]) {
    if (!archiveEntries.includes(expected)) throw new Error(`Missing ASAR entry: ${expected}`);
  }
  if (archiveEntries.includes('assets/icon-source.png')) throw new Error('Original high-resolution source icon must not be shipped');
  const forbiddenEntry = archiveEntries.find(entry => /(^|\/)(?:test|scripts|\.git|\.env|credentials?)(?:\/|$)/i.test(entry) || /private.*key|session.*json/i.test(entry));
  if (forbiddenEntry) throw new Error(`Forbidden ASAR entry: ${forbiddenEntry}`);

  const extractedAsar = path.join(temporary, 'asar');
  asar.extractAll(archive, extractedAsar);
  const pending = [extractedAsar];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) { pending.push(absolute); continue; }
      if (entry.isSymbolicLink() || fs.statSync(absolute).size > 2 * 1024 * 1024) continue;
      const content = fs.readFileSync(absolute);
      if (content.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')) || content.includes(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----'))) {
        throw new Error(`Private key material found in ASAR: ${path.relative(extractedAsar, absolute)}`);
      }
    }
  }

  const debList = childProcess.execFileSync('dpkg-deb', ['--contents', artifacts.deb], { encoding: 'utf8' });
  const rpmList = childProcess.execFileSync('rpm', ['-qlp', artifacts.rpm], { encoding: 'utf8' });
  for (const [format, listing] of [['DEB', debList], ['RPM', rpmList]]) {
    for (const expected of ['aux-proton-drive-bridge', 'app.asar', 'install-file-manager-integration.sh', 'aux-proton-drive-bridge.desktop']) {
      if (!listing.includes(expected)) throw new Error(`${format} is missing ${expected}`);
    }
  }
  const debDepends = childProcess.execFileSync('dpkg-deb', ['--field', artifacts.deb, 'Depends'], { encoding: 'utf8' });
  for (const dependency of ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0']) {
    if (!debDepends.includes(dependency)) throw new Error(`DEB dependency metadata is missing ${dependency}`);
  }
  const rpmDepends = childProcess.execFileSync('rpm', ['-qpR', artifacts.rpm], { encoding: 'utf8' });
  for (const dependency of ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', 'libXtst', 'xdg-utils', 'at-spi2-core', 'libuuid', 'libsecret']) {
    if (!rpmDepends.includes(dependency)) throw new Error(`RPM dependency metadata is missing ${dependency}`);
  }

  console.log(JSON.stringify({
    ok: true,
    artifacts: Object.values(names),
    asarEntries: archiveEntries.length,
    asarSha256: [...hashes][0],
    packageVersions: version,
    fuseSetsVerified: Object.keys(installations),
    dependencyMetadata: { deb: true, rpm: true },
    privateKeyMaterial: false
  }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
