const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require(path.join(root, 'package.json')).version;
const productPattern = new RegExp(`^(Aux Proton Bridge-${version}-.+\\.(AppImage|deb|rpm)|aux-proton-bridge-${version}-source\\.(tar\\.gz|zip))$`);
const files = fs.existsSync(dist) ? fs.readdirSync(dist).filter(name => productPattern.test(name)).sort() : [];
const artifacts = files.map(name => {
  const p = path.join(dist, name);
  const data = fs.readFileSync(p);
  return { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
});
const manifest = {
  product: 'Aux Proton Bridge',
  version,
  generatedAt: new Date().toISOString(),
  gitCommit: childProcess.execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim(),
  artifacts,
  verification: {
    sourceCheck: 'npm run check',
    sourceSmoke: 'npm run smoke:source',
    packagedSmoke: 'scripts/smoke-appimage.js'
  }
};
fs.writeFileSync(path.join(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
console.log(JSON.stringify(manifest, null, 2));
