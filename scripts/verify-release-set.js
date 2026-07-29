'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require(path.join(root, 'package.json')).version;
const manifestArtifacts = [
  `Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage`,
  `Aux.Proton.Drive.Bridge-${version}-amd64.deb`,
  `Aux.Proton.Drive.Bridge-${version}-x86_64.rpm`,
  `aux-proton-drive-bridge-${version}-source.tar.gz`,
  `aux-proton-drive-bridge-${version}-source.zip`,
  `aux-proton-drive-bridge-${version}-aur.tar.gz`,
  'latest-linux.yml',
  'sbom.cdx.json'
].sort();
const signedArtifacts = [...manifestArtifacts, 'release-manifest.json'].sort();
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex');

for (const name of signedArtifacts) {
  if (!fs.statSync(path.join(dist, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing exact release artifact: ${name}`);
}
const releaseLooking = fs.readdirSync(dist).filter(name =>
  /\.(?:AppImage|deb|rpm)$/.test(name) || /-(?:source|aur)\.(?:tar\.gz|zip)$/.test(name)
);
const unexpected = releaseLooking.filter(name => !signedArtifacts.includes(name));
if (unexpected.length) throw new Error(`Unexpected or mixed-version release artifacts: ${unexpected.join(', ')}`);

const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'release-manifest.json'), 'utf8'));
if (manifest.version !== version || manifest.gitTag !== `v${version}`) throw new Error('Release manifest identity does not match package version');
const declared = manifest.artifacts.map(item => item.name).sort();
if (JSON.stringify(declared) !== JSON.stringify(manifestArtifacts)) throw new Error('Release manifest artifact set is not exact');
for (const item of manifest.artifacts) {
  const stat = fs.statSync(path.join(dist, item.name));
  if (item.size !== stat.size || item.sha256 !== sha256(item.name)) throw new Error(`Release manifest metadata mismatch: ${item.name}`);
}
const latest = fs.readFileSync(path.join(dist, 'latest-linux.yml'), 'utf8');
if (!latest.includes(`version: ${version}`) || !latest.includes(`Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage`)) {
  throw new Error('latest-linux.yml does not identify the exact AppImage release');
}

if (process.argv.includes('--checksums')) {
  const lines = fs.readFileSync(path.join(dist, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  const checksums = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/);
    if (!match || checksums.has(match[2])) throw new Error(`Invalid or duplicate checksum line: ${line}`);
    checksums.set(match[2], match[1]);
  }
  const names = [...checksums.keys()].sort();
  if (JSON.stringify(names) !== JSON.stringify(signedArtifacts)) throw new Error('Signed checksum artifact set is not exact');
  for (const [name, digest] of checksums) if (sha256(name) !== digest) throw new Error(`Checksum mismatch: ${name}`);
}
console.log(JSON.stringify({ ok: true, version, manifestArtifacts: manifestArtifacts.length, checksums: process.argv.includes('--checksums') }));
