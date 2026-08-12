const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperationStore, redactSensitive, sanitizeForStorage, shouldForwardOperationEvent } = require('../src/main/operationStore');

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
  assert.deepEqual(sanitizeForStorage({ passphrase: 'one', apiKey: 'two', authorization: 'Bearer three', privateKey: 'four', nested: { client_secret: 'five' } }), {
    passphrase: '[REDACTED]', apiKey: '[REDACTED]', authorization: '[REDACTED]', privateKey: '[REDACTED]', nested: { client_secret: '[REDACTED]' }
  });
  assert.equal(redactSensitive('authorization: Bearer placeholder apiKey=def'), 'authorization: Bearer [REDACTED] apiKey=[REDACTED]');
  const awsLike = `AKIA${'A'.repeat(16)}`;
  const privateKeyLike = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`;
  const generic = redactSensitive(`credential=opaque-value ${awsLike} ${privateKeyLike}`);
  assert.equal(generic.includes('opaque-value'), false);
  assert.equal(generic.includes(awsLike), false);
  assert.equal(generic.includes('BEGIN PRIVATE KEY'), false);
});

test('large remote listing stdout is not forwarded to the renderer or persistent history', () => {
  assert.equal(shouldForwardOperationEvent('list', { stream: 'stdout', text: '[{"name":"private"}]' }), false);
  assert.equal(shouldForwardOperationEvent('list', { stream: 'stderr', text: 'warning' }), true);
  assert.equal(shouldForwardOperationEvent('download', { stream: 'stdout', text: 'progress' }), true);
});

test('browser login URLs are not forwarded to renderer activity or persistent history', () => {
  assert.equal(shouldForwardOperationEvent('login', {
    stream: 'stdout',
    text: 'Open https://account.proton.me/auth?payload=private-browser-ticket'
  }), false);
  assert.equal(shouldForwardOperationEvent('login', { stream: 'system', text: 'Proton sign-in URL opened in the browser' }), true);
});

test('operation store bounds retained operations, events, and event text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-ops-bounds-'));
  const file = path.join(dir, 'operations.json');
  const store = createOperationStore(file);
  const detailed = store.begin('download', { detail: true });
  for (let eventIndex = 0; eventIndex < 55; eventIndex++) {
    store.appendEvent(detailed.id, 'stdout', `${eventIndex}:${'x'.repeat(1500)}`);
  }
  store.finish(detailed.id, 'succeeded', { code: 0 });
  for (let opIndex = 0; opIndex < 205; opIndex++) {
    const op = store.begin('download', { index: opIndex });
    store.finish(op.id, 'succeeded', { code: 0 });
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(data.operations.length, 200);
  const saved = data.operations.find(operation => operation.id === detailed.id);
  // The detailed operation is deliberately older than the 200-operation cap.
  assert.strictEqual(saved, undefined);

  const recent = store.begin('download', { detail: 'recent' });
  for (let eventIndex = 0; eventIndex < 55; eventIndex++) {
    store.appendEvent(recent.id, 'stdout', `${eventIndex}:${'x'.repeat(1500)}`);
  }
  const current = store.list(1)[0];
  assert.strictEqual(current.events.length, 50);
  assert.ok(current.events.every(event => event.text.length <= 1000));
  assert.ok(fs.statSync(file).size < 2 * 1024 * 1024, 'operation history exceeded its bounded storage envelope');
});

test('operation store recovers stale running operations from interrupted sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-ops-stale-'));
  const file = path.join(dir, 'operations.json');
  const store = createOperationStore(file);
  const op = store.begin('logout', {});
  // Backdate startedAt so recovery treats it as stale.
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.operations[0].startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  data.operations[0].updatedAt = data.operations[0].startedAt;
  fs.writeFileSync(file, JSON.stringify(data));
  const recovered = createOperationStore(file).recoverStaleRunning(60_000);
  assert.equal(recovered, 1);
  const [saved] = createOperationStore(file).list();
  assert.equal(saved.id, op.id);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error || '', /interrupted/i);
});
