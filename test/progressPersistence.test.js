const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createProgressPersistenceGate } = require('../src/main/progressPersistence');

describe('progressPersistence', () => {
  it('persists the first progress message, then limits routine messages to one per interval', () => {
    let now = 1000;
    const gate = createProgressPersistenceGate({ intervalMs: 1000, now: () => now });
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stdout', percent: 10 }), true);
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stdout', percent: 20 }), false);
    now = 1999;
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stdout', percent: 30 }), false);
    now = 2000;
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stdout', percent: 40 }), true);
  });

  it('always preserves structured errors and production terminal progress and resets completed transfers', () => {
    let now = 1000;
    const gate = createProgressPersistenceGate({ intervalMs: 1000, now: () => now });
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stderr', type: 'progress', pct: 10 }), true);
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stderr', type: 'progress', pct: 20 }), false);
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stderr', type: 'file_error', error: 'failed' }), true);
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stdout', type: 'file_complete', pct: 100 }), true);
    gate.clear('transfer-1');
    assert.strictEqual(gate.shouldPersist('transfer-1', { stream: 'stdout', type: 'progress', pct: 1 }), true);
  });
});
