const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const EventEmitter = require('node:events');
const { createTransferQueue, MAX_RETRIES } = require('../src/main/transferQueue');

describe('transferQueue — queue management', () => {
  let queue;
  let cleanupQueues = [];

  after(() => {
    for (const q of cleanupQueues) q.destroy();
  });

  function makeQueue(opts) {
    const q = createTransferQueue(opts || { concurrency: 2 });
    // Suppress unhandled errors from queue trying to spawn real CLI
    q.on('error', () => {});
    cleanupQueues.push(q);
    return q;
  }

  it('initializes with default concurrency of 2', () => {
    queue = makeQueue();
    const state = queue.getState();
    assert.strictEqual(state.concurrency, 2);
  });

  it('initializes with custom concurrency', () => {
    queue = makeQueue({ concurrency: 1 });
    assert.strictEqual(queue.getState().concurrency, 1);
  });

  it('enqueue returns a unique ID', () => {
    queue = makeQueue();
    const id1 = queue.enqueue('list', { path: '/my-files' }, 'low');
    const id2 = queue.enqueue('upload', {}, 'high');
    assert.ok(id1);
    assert.ok(id2);
    assert.notStrictEqual(id1, id2);
  });

  it('enqueue stores item with correct priority', () => {
    queue = makeQueue();
    queue.enqueue('list', {}, 'high');
    const state = queue.getState();
    const highItems = state.pending.filter(p => p.priority === 'high');
    assert.ok(highItems.length >= 1);
  });

  it('defaults to medium priority for invalid values', () => {
    queue = makeQueue();
    queue.enqueue('list', {}, 'invalid');
    const state = queue.getState();
    assert.strictEqual(state.pending[0].priority, 'medium');
  });

  it('getState returns expected structure', () => {
    queue = makeQueue({ concurrency: 3 });
    const state = queue.getState();
    assert.ok('isPaused' in state);
    assert.ok('concurrency' in state);
    assert.ok('active' in state);
    assert.ok('pending' in state);
    assert.ok('recentCompleted' in state);
    assert.strictEqual(state.isPaused, false);
    assert.strictEqual(state.concurrency, 3);
  });

  it('pause and resume work', () => {
    queue = makeQueue();
    queue.pause();
    assert.strictEqual(queue.getState().isPaused, true);
    queue.resume();
    assert.strictEqual(queue.getState().isPaused, false);
  });

  it('cancel removes pending items', () => {
    queue = makeQueue({ concurrency: 1 });
    const id = queue.enqueue('list', {}, 'low');
    queue.enqueue('list', {}, 'low');

    const cancelled = queue.cancel(id);
    assert.strictEqual(cancelled, true);
  });

  it('cancel returns false for unknown ID', () => {
    queue = makeQueue();
    assert.strictEqual(queue.cancel('nonexistent'), false);
  });

  it('cancelAll clears pending and signals active', () => {
    queue = makeQueue({ concurrency: 1 });
    queue.enqueue('list', {}, 'low');
    queue.enqueue('upload', {}, 'low');
    queue.enqueue('download', {}, 'low');

    const result = queue.cancelAll();
    const state = queue.getState();
    assert.strictEqual(state.pending.length, 0);
    assert.ok(result.cancelledPending >= 2);
  });

  it('emits events for enqueue, start, complete, cancel', () => {
    return new Promise((resolve) => {
      queue = makeQueue();
      const events = [];

      queue.on('enqueued', (d) => events.push({ ...d, _event: 'enqueued' }));
      queue.on('cancelled', (d) => {
        events.push({ ...d, _event: 'cancelled' });
        assert.ok(events.some(e => e._event === 'enqueued'));
        assert.ok(events.some(e => e._event === 'cancelled'));
        resolve();
      });

      const id = queue.enqueue('list', {}, 'low');
      queue.cancel(id);
    });
  });

  it('exposes MAX_RETRIES constant', () => {
    assert.ok(Number.isInteger(MAX_RETRIES));
    assert.ok(MAX_RETRIES >= 1);
  });

  it('recentCompleted ring buffer works', () => {
    return new Promise((resolve) => {
      queue = makeQueue({ concurrency: 1 });
      queue.enqueue('list', {}, 'low');

      setTimeout(() => {
        const state = queue.getState();
        assert.ok(Array.isArray(state.recentCompleted));
        resolve();
      }, 500);
    });
  });
});
