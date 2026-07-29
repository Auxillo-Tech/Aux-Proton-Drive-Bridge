const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isPathInside, assertPathInside, assertSafePathInside } = require('../src/main/pathSafety');

test('path boundary validation rejects prefix lookalikes and traversal', () => {
  const home = '/home/jd';
  assert.strictEqual(isPathInside('/home/jd/ProtonDrive', home), true);
  assert.strictEqual(isPathInside('/home/jd', home), true);
  assert.strictEqual(isPathInside('/home/jd-malicious/file', home), false);
  assert.strictEqual(isPathInside('/home/jd/../root/file', home), false);
  assert.throws(() => assertPathInside('/home/jd-malicious/file', home, 'test path'), /test path/);
});

test('real-path validation rejects symlinks escaping the allowed root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-outside-'));
  const link = path.join(root, 'escape');
  fs.symlinkSync(outside, link);
  assert.throws(() => assertSafePathInside(link, root, 'Upload path', { mustExist: true }), /resolves outside/);
  assert.strictEqual(assertSafePathInside(path.join(root, 'new-file'), root), path.join(root, 'new-file'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
