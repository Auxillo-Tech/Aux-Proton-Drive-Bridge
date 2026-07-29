const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createFuseMount, MOUNT_STATE, DEFAULT_MOUNT_PREFIX } = require('../src/main/fuseMount');

describe('fuseMount — state management (no real FUSE)', () => {
  let tmpDir;
  let mount;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-test-'));
    mount = createFuseMount({
      mountPoint: path.join(tmpDir, 'proton-mount'),
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    });
  });

  after(() => {
    mount.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('starts in UNMOUNTED state', () => {
    assert.strictEqual(mount.MOUNT_STATE, MOUNT_STATE);
    const status = mount.getStatus();
    assert.strictEqual(status.state, 'unmounted');
  });

  it('reports FUSE availability check without crashing', () => {
    // This should return false in test environments without /dev/fuse
    const available = mount.isFuseAvailable();
    // Don't assert on the value since it depends on the test environment
    assert.ok(typeof available === 'boolean');
  });

  it('reports unavailable when the Proton CLI has no mount command', () => {
    const fakeCli = path.join(tmpDir, 'fake-proton-drive');
    fs.writeFileSync(fakeCli, '#!/bin/sh\necho "Command not found: filesystem mount" >&2\nexit 1\n', { mode: 0o755 });
    const unsupported = createFuseMount({
      mountPoint: path.join(tmpDir, 'unsupported-mount'),
      cliBin: fakeCli,
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    });
    assert.strictEqual(unsupported.isFuseAvailable(), false);
    unsupported.destroy();
  });

  it('getStatus returns expected shape', () => {
    const status = mount.getStatus();
    assert.ok('state' in status);
    assert.ok('mountPoint' in status);
    assert.ok('isMounted' in status);
    assert.ok('isFuseAvailable' in status);
    assert.ok('error' in status);
    assert.ok('canMount' in status);
    assert.ok('canUnmount' in status);
    assert.strictEqual(status.isMounted, false);
    assert.strictEqual(status.canUnmount, false);
  });

  it('exposes MOUNT_STATE constants', () => {
    assert.strictEqual(MOUNT_STATE.UNMOUNTED, 'unmounted');
    assert.strictEqual(MOUNT_STATE.MOUNTING, 'mounting');
    assert.strictEqual(MOUNT_STATE.MOUNTED, 'mounted');
    assert.strictEqual(MOUNT_STATE.UNMOUNTING, 'unmounting');
    assert.strictEqual(MOUNT_STATE.ERROR, 'error');
  });

  it('exposes DEFAULT_MOUNT_PREFIX', () => {
    assert.ok(DEFAULT_MOUNT_PREFIX.endsWith('ProtonDrive-FUSE'));
  });

  it('calling unmount on unmounted state returns ok', async () => {
    const result = await mount.unmount();
    assert.strictEqual(result.ok, true);
  });

  it.skip('registers and fires state change events', () => {
    // Requires a real FUSE mount to trigger state changes; skipped in test env
  });

  it('destroy cleans up without error', () => {
    const m = createFuseMount({ mountPoint: path.join(tmpDir, 'destroy-test') });
    m.destroy();
    assert.ok(true);
  });
});
