const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshUserIcons, ICON_NAME } = require('../src/main/iconRefresh');

describe('iconRefresh — user-level hicolor icon self-heal', () => {
  let dir;
  let assetDir;
  let userIconRoot;

  function userIconPath(size) {
    return path.join(userIconRoot, `${size}x${size}`, 'apps', ICON_NAME);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-refresh-'));
    assetDir = path.join(dir, 'assets');
    userIconRoot = path.join(dir, 'hicolor');
    fs.mkdirSync(assetDir, { recursive: true });
    for (const size of [16, 128, 512]) {
      fs.writeFileSync(path.join(assetDir, `icon-${size}.png`), `current-${size}`);
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites existing user icons whose content differs from the bundled assets', () => {
    fs.mkdirSync(path.dirname(userIconPath(128)), { recursive: true });
    fs.writeFileSync(userIconPath(128), 'stale-old-artwork');
    const updated = refreshUserIcons({ assetDir, userIconRoot });
    assert.deepEqual(updated, [128]);
    assert.equal(fs.readFileSync(userIconPath(128), 'utf8'), 'current-128');
  });

  it('leaves matching user icons untouched and reports nothing to update', () => {
    fs.mkdirSync(path.dirname(userIconPath(512)), { recursive: true });
    fs.writeFileSync(userIconPath(512), 'current-512');
    const before = fs.statSync(userIconPath(512)).mtimeMs;
    assert.deepEqual(refreshUserIcons({ assetDir, userIconRoot }), []);
    assert.equal(fs.statSync(userIconPath(512)).mtimeMs, before);
  });

  it('never creates user icons that do not already exist', () => {
    assert.deepEqual(refreshUserIcons({ assetDir, userIconRoot }), []);
    assert.equal(fs.existsSync(userIconPath(16)), false);
    assert.equal(fs.existsSync(userIconPath(128)), false);
  });

  it('returns nothing when the asset directory is missing or unset', () => {
    fs.mkdirSync(path.dirname(userIconPath(16)), { recursive: true });
    fs.writeFileSync(userIconPath(16), 'stale');
    assert.deepEqual(refreshUserIcons({ assetDir: path.join(dir, 'missing'), userIconRoot }), []);
    assert.deepEqual(refreshUserIcons({ userIconRoot }), []);
    assert.equal(fs.readFileSync(userIconPath(16), 'utf8'), 'stale');
  });
});
