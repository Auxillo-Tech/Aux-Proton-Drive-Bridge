const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const version = require(path.join(root, 'package.json')).version;
const base = `aux-proton-drive-bridge-${version}-source`;
const tarPath = path.join(dist, `${base}.tar.gz`);
const zipPath = path.join(dist, `${base}.zip`);
const excludes = [
  '--exclude=.git',
  '--exclude=node_modules',
  '--exclude=dist',
  '--exclude=.cache'
];
childProcess.execFileSync('tar', ['czf', tarPath, ...excludes, '-C', path.dirname(root), path.basename(root)], { stdio: 'inherit' });
childProcess.execFileSync('zip', ['-qr', zipPath, path.basename(root), '-x', `${path.basename(root)}/.git/*`, `${path.basename(root)}/node_modules/*`, `${path.basename(root)}/dist/*`, `${path.basename(root)}/.cache/*`], { cwd: path.dirname(root), stdio: 'inherit' });
console.log(`created ${tarPath}`);
console.log(`created ${zipPath}`);
