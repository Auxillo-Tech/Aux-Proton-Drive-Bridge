const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLinuxGraphicsWorkaround } = require('../src/main/linuxGraphics');

function writeDevice(root, card, vendor, device) {
  const target = path.join(root, card, 'device');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'vendor'), `${vendor}\n`);
  fs.writeFileSync(path.join(target, 'device'), `${device}\n`);
}

test('selects SwiftShader for the verified AMD Navi 48 PCI device', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-drm-'));
  writeDevice(root, 'card1', '0x1002', '0x7550');
  assert.deepEqual(detectLinuxGraphicsWorkaround({ platform: 'linux', drmRoot: root }), {
    useAngle: 'swiftshader',
    reason: 'amd-navi48-7550'
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('does not force software rendering on unrelated GPUs or platforms', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-drm-'));
  writeDevice(root, 'card0', '0x10de', '0x2684');
  assert.equal(detectLinuxGraphicsWorkaround({ platform: 'linux', drmRoot: root }), null);
  writeDevice(root, 'card1', '0x1002', '0x7550');
  assert.equal(detectLinuxGraphicsWorkaround({ platform: 'darwin', drmRoot: root }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
