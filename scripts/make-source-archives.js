'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const trackedChanges = childProcess.execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
if (trackedChanges) throw new Error('Refusing to archive a dirty tracked worktree');

fs.mkdirSync(dist, { recursive: true });
const base = `aux-proton-drive-bridge-${version}-source`;
const prefix = `${base}/`;
childProcess.execFileSync('git', ['archive', '--format=tar.gz', `--prefix=${prefix}`, '-o', path.join(dist, `${base}.tar.gz`), 'HEAD'], { cwd: root, stdio: 'inherit' });
childProcess.execFileSync('git', ['archive', '--format=zip', `--prefix=${prefix}`, '-o', path.join(dist, `${base}.zip`), 'HEAD'], { cwd: root, stdio: 'inherit' });
console.log(JSON.stringify({ tar: `${base}.tar.gz`, zip: `${base}.zip` }));
