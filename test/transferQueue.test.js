const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const EventEmitter = require('node:events');
const { createTransferQueue, MAX_RETRIES, MAX_QUEUE_DEPTH } = require('../src/main/transferQueue');

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

  it('rejects enqueue when the bounded queue is full', () => {
    queue = makeQueue({ concurrency: 1 });
    queue.pause();
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) queue.enqueue('list', { path: '/my-files' });
    assert.throws(() => queue.enqueue('list', { path: '/my-files' }), /queue is full/);
  });
});

describe('transferQueue — execution safety', () => {
  function scriptedSpawn(outcomes, tracker = {}) {
    return (_bin, _args, options = {}) => {
      const outcome = outcomes.shift() || { code: 0 };
      tracker.calls = (tracker.calls || 0) + 1;
      tracker.active = (tracker.active || 0) + 1;
      tracker.maxActive = Math.max(tracker.maxActive || 0, tracker.active);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        tracker.active--;
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      };
      const finish = () => {
        for (const chunk of (Array.isArray(outcome.stdout) ? outcome.stdout : [outcome.stdout]).filter(Boolean)) child.stdout.emit('data', Buffer.from(chunk));
        for (const chunk of (Array.isArray(outcome.stderr) ? outcome.stderr : [outcome.stderr]).filter(Boolean)) child.stderr.emit('data', Buffer.from(chunk));
        tracker.active--;
        child.emit('close', outcome.code ?? 0, null);
      };
      const timer = setTimeout(finish, outcome.delay || 0);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        tracker.active--;
        child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      }, { once: true });
      return child;
    };
  }

  it('retries a transient non-zero CLI failure', async () => {
    const tracker = {};
    const queue = createTransferQueue({ concurrency: 1, retryDelayMs: 0, spawn: scriptedSpawn([
      { code: 1, stderr: 'network timeout' },
      { code: 0, stdout: '✓ uploaded.txt' }
    ], tracker) });
    const completed = new Promise((resolve, reject) => {
      queue.on('complete', resolve);
      queue.on('error', payload => reject(new Error(payload.error)));
    });
    queue.enqueue('upload', { localPaths: ['/tmp/uploaded.txt'], parentPath: '/my-files', retries: 2 });
    await completed;
    assert.strictEqual(tracker.calls, 2);
    await queue.destroy();
  });

  it('treats the transfer timeout as an inactivity limit and resets it on progress', async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let closed = false;
      const timers = [
        setTimeout(() => child.stdout.emit('data', Buffer.from('Downloading a (25%)\n')), 600),
        setTimeout(() => child.stdout.emit('data', Buffer.from('Downloading b (50%)\n')), 1200),
        setTimeout(() => {
          if (closed) return;
          closed = true;
          child.emit('close', 0, null);
        }, 1700)
      ];
      child.kill = () => {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      };
      return child;
    };
    const queue = createTransferQueue({
      concurrency: 1,
      retryDelayMs: 0,
      transferTimeoutMs: 1000,
      spawn
    });
    const completed = new Promise((resolve, reject) => {
      queue.on('complete', resolve);
      queue.on('error', payload => reject(new Error(payload.error)));
    });
    queue.enqueue('download', { paths: ['/my-files/large'], localFolder: '/tmp', retries: 1 });
    await completed;
    await queue.destroy();
  });

  it('kills a chatty child that repeats the same output without progressing', async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let closed = false;
      const spam = setInterval(() => child.stderr.emit('data', Buffer.from('Retrying chunk 12...\n')), 200);
      child.kill = () => {
        if (closed) return;
        closed = true;
        clearInterval(spam);
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      };
      return child;
    };
    const queue = createTransferQueue({ concurrency: 1, retryDelayMs: 0, transferTimeoutMs: 1000, spawn });
    const failed = new Promise(resolve => queue.on('error', resolve));
    queue.enqueue('download', { paths: ['/my-files/stuck'], localFolder: '/tmp', retries: 1 });
    const payload = await failed;
    assert.match(payload.error, /made no progress/);
    await queue.destroy();
  });

  it('enforces an absolute duration ceiling even when output keeps changing', async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let closed = false;
      let tick = 0;
      const spam = setInterval(() => child.stderr.emit('data', Buffer.from(`Retrying chunk ${tick++} at ${Date.now()}\n`)), 200);
      child.kill = () => {
        if (closed) return;
        closed = true;
        clearInterval(spam);
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      };
      return child;
    };
    const queue = createTransferQueue({
      concurrency: 1, retryDelayMs: 0, transferTimeoutMs: 1000, maxTransferDurationMs: 1500, spawn
    });
    const failed = new Promise(resolve => queue.on('error', resolve));
    queue.enqueue('download', { paths: ['/my-files/wedged'], localFolder: '/tmp', retries: 1 });
    const payload = await failed;
    assert.match(payload.error, /exceeded the maximum duration/);
    await queue.destroy();
  });

  it('emits skipped instead of complete for a zero-exit skipped transfer', async () => {
    const queue = createTransferQueue({ concurrency: 1, spawn: scriptedSpawn([{ code: 0, stdout: 'Skipped: 1' }]) });
    let completed = false;
    queue.on('complete', () => { completed = true; });
    const payload = await new Promise(resolve => {
      queue.on('skipped', resolve);
      queue.enqueue('upload', { localPaths: ['/tmp/existing.txt'], parentPath: '/my-files' });
    });
    assert.strictEqual(completed, false);
    assert.strictEqual(payload.result.summary.totalSkipped, 1);
    await queue.destroy();
  });

  it('emits an error instead of complete for zero-exit per-file failures', async () => {
    const queue = createTransferQueue({ concurrency: 1, spawn: scriptedSpawn([{ code: 0, stdout: '✗ failed.txt\n' }]) });
    let completed = false;
    queue.on('complete', () => { completed = true; });
    const payload = await new Promise(resolve => {
      queue.on('error', resolve);
      queue.enqueue('upload', { localPaths: ['/tmp/failed.txt'], parentPath: '/my-files' });
    });
    assert.strictEqual(completed, false);
    assert.strictEqual(payload.result.summary.totalErrors, 1);
    await queue.destroy();
  });

  it('detects skipped lines split across process output chunks', async () => {
    const queue = createTransferQueue({ concurrency: 1, spawn: scriptedSpawn([{ code: 0, stdout: ['Skipped:', ' 1\n'] }]) });
    let completed = false;
    queue.on('complete', () => { completed = true; });
    const payload = await new Promise(resolve => {
      queue.on('skipped', resolve);
      queue.enqueue('upload', { localPaths: ['/tmp/existing.txt'], parentPath: '/my-files' });
    });
    assert.strictEqual(completed, false);
    assert.strictEqual(payload.result.summary.totalSkipped, 1);
    await queue.destroy();
  });

  it('emits each transfer output line once instead of duplicating parsed and raw progress', async () => {
    const queue = createTransferQueue({ concurrency: 1, spawn: scriptedSpawn([{
      code: 0,
      stdout: 'Downloading first.txt (25%)\nDownloading second.txt (50%)\n'
    }]) });
    const messages = [];
    queue.on('progress', payload => messages.push(payload.text));
    await new Promise((resolve, reject) => {
      queue.on('complete', resolve);
      queue.on('error', payload => reject(new Error(payload.error)));
      queue.enqueue('download', { paths: ['/my-files'], localFolder: '/tmp' });
    });
    assert.deepStrictEqual(messages, [
      'Downloading first.txt (25%)',
      'Downloading second.txt (50%)'
    ]);
    await queue.destroy();
  });

  it('awaits active cancellation before removing queue listeners', async () => {
    const queue = createTransferQueue({ concurrency: 1, spawn: scriptedSpawn([{ code: 0, delay: 1000 }]) });
    let cancelled = false;
    queue.on('cancelled', () => { cancelled = true; });
    queue.enqueue('upload', { localPaths: ['/tmp/cancel.txt'], parentPath: '/my-files' });
    while (!queue.getState().active.length) await new Promise(resolve => setTimeout(resolve, 1));
    await queue.destroy();
    assert.strictEqual(cancelled, true);
    assert.strictEqual(queue.getState().active.length, 0);
  });

  it('serializes Proton CLI processes across separate queue instances', async () => {
    const tracker = {};
    const spawn = scriptedSpawn([{ code: 0, delay: 20 }, { code: 0, delay: 20 }], tracker);
    const first = createTransferQueue({ concurrency: 1, spawn });
    const second = createTransferQueue({ concurrency: 1, spawn });
    let finished = 0;
    const done = new Promise(resolve => {
      const mark = () => { if (++finished === 2) resolve(); };
      first.on('complete', mark);
      second.on('complete', mark);
    });
    first.enqueue('list', { path: '/my-files' });
    second.enqueue('list', { path: '/my-files' });
    await done;
    assert.strictEqual(tracker.maxActive, 1);
    await first.destroy();
    await second.destroy();
  });
});
