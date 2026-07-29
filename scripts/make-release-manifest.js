'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const git = (...args) => childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const releasePublicKeySha256 = sha256(path.join(root, 'assets', 'release-public-key.pem'));
if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Refusing to create release metadata from a dirty worktree');
const commit = git('rev-parse', 'HEAD');
const tag = `v${pkg.version}`;
if (git('rev-list', '-n', '1', tag) !== commit) throw new Error(`Release tag ${tag} does not point to HEAD`);

const required = [
  `Aux.Proton.Drive.Bridge-${pkg.version}-x86_64.AppImage`,
  `Aux.Proton.Drive.Bridge-${pkg.version}-amd64.deb`,
  `Aux.Proton.Drive.Bridge-${pkg.version}-x86_64.rpm`,
  `aux-proton-drive-bridge-${pkg.version}-source.tar.gz`,
  `aux-proton-drive-bridge-${pkg.version}-source.zip`,
  `aux-proton-drive-bridge-${pkg.version}-aur.tar.gz`,
  'sbom.cdx.json',
  'latest-linux.yml'
];
for (const name of required) {
  if (!fs.statSync(path.join(dist, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Incomplete release set: missing ${name}`);
}
const artifacts = required.sort().map(name => {
  const data = fs.readFileSync(path.join(dist, name));
  return { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
});
const manifest = {
  schemaVersion: 1,
  product: 'Aux Proton Drive Bridge',
  version: pkg.version,
  generatedAt: git('show', '-s', '--format=%cI', 'HEAD'),
  gitCommit: commit,
  gitTag: `v${pkg.version}`,
  releasePublicKeySha256,
  platform: 'linux-x64',
  artifacts,
  signing: {
    algorithm: 'Ed25519',
    signature: 'SHA256SUMS.txt.sig',
    signedFile: 'SHA256SUMS.txt',
    publicKey: 'assets/release-public-key.pem',
    required: true
  },
  requiredGates: [
    'npm run check',
    'npm audit --audit-level=moderate',
    'npm run smoke:modules',
    'npm run smoke:source',
    'npm run smoke:appimage',
    'npm run e2e:source',
    'npm run e2e:restart',
    'npm run e2e:packaged',
    'npm run inspect:artifacts',
    'npm run test:installed',
    'npm run test:aur',
    'npm run release:sign:verify'
  ]
};
fs.writeFileSync(path.join(dist, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ version: pkg.version, gitTag: tag, gitCommit: commit, artifacts: artifacts.length }));
