'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'node_modules');
const patched = [];
const verified = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const full = path.join(directory, entry.name);
    const packageFile = path.join(full, 'package.json');
    if (fs.existsSync(packageFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        if (manifest.name === 'minimatch') patchAndVerify(full, manifest.version);
      } catch (error) {
        throw new Error(`Unable to inspect ${packageFile}: ${error.message}`);
      }
    }
    walk(full);
  }
}

function patchAndVerify(directory, version) {
  const major = Number(String(version).split('.')[0]);
  const entry = path.join(directory, 'minimatch.js');
  if (major < 9) {
    if (!fs.existsSync(entry)) throw new Error(`Legacy minimatch ${version} has no minimatch.js at ${directory}`);
    let source = fs.readFileSync(entry, 'utf8');
    if (!source.includes('braceExpansionCompat')) {
      const pattern = /^(var|const) expand = require\('brace-expansion'\)$/m;
      if (!pattern.test(source)) throw new Error(`Unknown minimatch ${version} brace-expansion import at ${entry}`);
      source = source.replace(pattern, (_, declaration) =>
        `${declaration} braceExpansionCompat = require('brace-expansion')\n` +
        `${declaration} expand = typeof braceExpansionCompat === 'function' ? braceExpansionCompat : braceExpansionCompat.expand\n` +
        `if (typeof expand !== 'function') throw new TypeError('brace-expansion does not expose expand()')`
      );
      fs.writeFileSync(entry, source);
      patched.push(`${version}:${entry}`);
    }
  }

  const resolved = require.resolve(directory);
  delete require.cache[resolved];
  const loaded = require(directory);
  const match = typeof loaded === 'function' ? loaded : loaded.minimatch;
  if (typeof match !== 'function' || !match('bridge.js', '*.js') || match('bridge.txt', '*.js')) {
    throw new Error(`minimatch ${version} failed compatibility verification at ${directory}`);
  }
  verified.push(`${version}:${directory}`);
}

walk(root);
if (!verified.length) throw new Error('No minimatch installations found to verify');
console.log(`Dependency compatibility verified for ${verified.length} minimatch installations; patched ${patched.length}.`);
