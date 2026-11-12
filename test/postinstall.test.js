const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'patch-dependency-compat.js');

// The script looks for node_modules next to its own scripts folder, so run a copy in a throwaway tree.
function runIn(prepare) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.copyFileSync(script, path.join(root, 'scripts', 'patch-dependency-compat.js'));
    prepare?.(root);
    return spawnSync(process.execPath, [path.join(root, 'scripts', 'patch-dependency-compat.js')], { encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('postinstall succeeds on a production-only install that has no minimatch', () => {
  const result = runIn();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no minimatch installations found/i);
});

test('postinstall still fails when an installed minimatch does not work', () => {
  const result = runIn(root => {
    const dir = path.join(root, 'node_modules', 'minimatch');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'minimatch', version: '10.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { minimatch: () => false };');
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed compatibility verification/);
});
