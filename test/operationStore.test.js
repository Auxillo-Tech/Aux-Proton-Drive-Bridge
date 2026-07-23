const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperationStore, redactSensitive, sanitizeForStorage } = require('../src/main/operationStore');

test('operation store persists operation lifecycle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-ops-'));
  const store = createOperationStore(path.join(dir, 'operations.json'));
  const op = store.begin('download', { paths: ['/my-files/A'], localFolder: '/tmp/out' });
  store.appendEvent(op.id, 'stdout', 'started');
  store.finish(op.id, 'succeeded', { code: 0, stdout: 'done' });
  const [saved] = createOperationStore(path.join(dir, 'operations.json')).list();
  assert.equal(saved.id, op.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.events[0].text, 'started');
  assert.equal(saved.options.localFolder, '/tmp/out');
});

test('operation store redacts auth payloads and tokens', () => {
  const text = 'open https://account.proton.me/desktop/login?x=1#payload=secretstuff and ghp_abcdefghijklmnopqrstuvwxyz';
  assert.equal(redactSensitive(text), 'open https://account.proton.me/desktop/login?x=1#payload=[REDACTED] and [REDACTED_GITHUB_TOKEN]');
  assert.deepEqual(sanitizeForStorage({ token: 'abc', nested: { ok: 'safe', payload: 'secret' } }), {
    token: '[REDACTED]',
    nested: { ok: 'safe', payload: '[REDACTED]' }
  });
});
