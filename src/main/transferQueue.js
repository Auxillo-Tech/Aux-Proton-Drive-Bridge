/**
 * transferQueue.js — Live Transfer Queue with Concurrency Control
 *
 * Manages concurrent file transfers with:
 *   - Configurable concurrency (default 2)
 *   - Priority queuing (high/medium/low)
 *   - Progress events for real-time UI
 *   - Pause/resume/cancel per operation
 *   - Automatic retry on recoverable errors
 *   - Integration with syncDb and progressParser
 */

const EventEmitter = require('node:events');
const { buildCommand } = require('./protonCli');
const { parseProgressLine, summarizeTransfer } = require('./progressParser');
const { withProtonProcessLock } = require('./protonProcessLock');
const { buildChildEnv } = require('./childProcessEnv');

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_DEPTH = 1000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Create a new transfer queue.
 * @param {object} [options]
 * @param {number} [options.concurrency=2] - Max simultaneous transfers
 * @param {object} [options.syncDb] - Optional syncDb instance for metadata tracking
 * @returns {object} TransferQueue API
 */
function createTransferQueue(options = {}) {
  const concurrency = Math.max(1, options.concurrency || 2);
  const syncDb = options.syncDb || null;
  const spawnImpl = options.spawn || require('node:child_process').spawn;
  const protonBin = options.protonBin || process.env.PROTON_DRIVE_BIN || 'proton-drive';
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : RETRY_DELAY_MS;
  const transferTimeoutMs = Number.isFinite(options.transferTimeoutMs)
    ? Math.max(1000, options.transferTimeoutMs)
    : DEFAULT_TRANSFER_TIMEOUT_MS;

  const emitter = new EventEmitter();
  const pending = [];        // { id, action, options, priority, retries, createdAt }
  const active = new Map();  // id -> { operation, controller }
  const completed = [];      // recent completed operations (ring buffer)
  const COMPLETED_MAX = 100;
  const idleWaiters = new Set();

  let isPaused = false;
  let nextId = 1;

  // ── Internal helpers ──────────────────────────────────────

  function generateId() {
    return `tx-${Date.now()}-${nextId++}`;
  }

  function emit(event, payload) {
    emitter.emit(event, payload);
  }

  function notifyIdleWaiters() {
    if (active.size || pending.length) return;
    for (const resolve of idleWaiters) resolve(true);
    idleWaiters.clear();
  }

  function dequeue() {
    if (isPaused) return;

    const available = concurrency - active.size;
    if (available <= 0) return;

    // Sort pending by priority, then by creation time
    pending.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.createdAt - b.createdAt;
    });

    const toStart = pending.splice(0, available);
    for (const item of toStart) {
      executeTransfer(item);
    }
  }

  async function executeTransfer(item) {
    const controller = new AbortController();
    active.set(item.id, { operation: item, controller });

    emit('start', { id: item.id, action: item.action, options: item.options, ts: new Date().toISOString() });

    try {
      const result = await runTransferWithRetry(item, controller.signal);
      active.delete(item.id);

      // Store in completed ring buffer
      const wasSkipped = result.summary?.totalSkipped > 0;
      const hadErrors = result.summary?.totalErrors > 0;
      const status = hadErrors ? 'failed' : (wasSkipped ? 'skipped' : 'succeeded');
      const record = { id: item.id, action: item.action, options: item.options, status, result, completedAt: new Date().toISOString() };
      completed.unshift(record);
      if (completed.length > COMPLETED_MAX) completed.length = COMPLETED_MAX;

      const payload = { id: item.id, action: item.action, options: item.options, result, ts: new Date().toISOString() };
      if (hadErrors) emit('error', { ...payload, error: `Proton Drive reported ${result.summary.totalErrors} transfer error(s)` });
      else emit(wasSkipped ? 'skipped' : 'complete', payload);
    } catch (err) {
      active.delete(item.id);

      if (err.name === 'AbortError' || err.cancelled) {
        const record = { id: item.id, action: item.action, options: item.options, status: 'cancelled', error: err.message, completedAt: new Date().toISOString() };
        completed.unshift(record);
        if (completed.length > COMPLETED_MAX) completed.length = COMPLETED_MAX;
        emit('cancelled', { id: item.id, action: item.action, options: item.options, ts: new Date().toISOString() });
      } else {
        const record = { id: item.id, action: item.action, options: item.options, status: 'failed', error: err.message, completedAt: new Date().toISOString() };
        completed.unshift(record);
        if (completed.length > COMPLETED_MAX) completed.length = COMPLETED_MAX;
        emit('error', { id: item.id, action: item.action, options: item.options, error: err.message, ts: new Date().toISOString() });
      }
    }

    // Try next
    dequeue();
    notifyIdleWaiters();
  }

  async function runTransferWithRetry(item, signal) {
    let lastError;

    for (let attempt = 1; attempt <= Math.min(MAX_RETRIES, Math.max(item.retries || 1, 1)); attempt++) {
      if (signal.aborted) throw Object.assign(new Error('Transfer cancelled'), { cancelled: true, name: 'AbortError' });

      if (attempt > 1) {
        emit('retry', { id: item.id, attempt, maxRetries: MAX_RETRIES, ts: new Date().toISOString() });
        await new Promise(r => setTimeout(r, retryDelayMs));
      }

      try {
        const result = await runTransferOnce(item, signal);
        return result;
      } catch (err) {
        if (err.cancelled || err.name === 'AbortError') throw err;

        lastError = err;
        if (err.message && (
          err.message.includes('ENOENT') ||
          err.message.includes('EACCES') ||
          err.message.includes('ENOSPC') ||
          err.message.includes('not found')
        )) break;
        const transient = err.result?.code == null || /ECONN|ETIMEDOUT|network|temporar|connection reset|timeout|database is locked|SQLITE_BUSY|rate limit|\b429\b|\b5\d\d\b/i.test(err.message || '');
        if (!transient) break;

        emit('progress', { id: item.id, action: item.action, stream: 'stderr', text: `Attempt ${attempt} failed: ${err.message}`, ts: new Date().toISOString() });
      }
    }

    throw lastError || new Error('Transfer failed after retries');
  }

  function runTransferOnce(item, signal) {
    return withProtonProcessLock(() => new Promise((resolve, reject) => {
      const { bin, args } = buildCommand(item.action, item.options, protonBin);
      const env = buildChildEnv({ PROTON_DRIVE_LOG_LEVEL: item.options.logLevel || 'ERROR' });

      const child = spawnImpl(bin, args, { shell: false, windowsHide: true, env, signal });

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      const allLines = [];
      const lineBuffers = { stdout: '', stderr: '' };
      let settled = false;
      const timeout = setTimeout(() => {
        cleanupChild();
        settle(new Error(`Proton Drive ${item.action} timed out after ${transferTimeoutMs} ms`));
      }, transferTimeoutMs);
      timeout.unref?.();

      function settle(err, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(result);
      }

      function cleanupChild() {
        try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      }

      function appendOutput(stream, text) {
        const textBytes = Buffer.byteLength(text);
        if (outputBytes + textBytes > MAX_OUTPUT_BYTES) {
          cleanupChild();
          settle(new Error(`Proton Drive ${item.action} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
          return false;
        }
        outputBytes += textBytes;
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        return true;
      }

      function consumeOutput(stream, text, flush = false) {
        lineBuffers[stream] += text;
        const parts = lineBuffers[stream].split('\n');
        const remainder = parts.pop() || '';
        lineBuffers[stream] = flush ? '' : remainder;
        if (flush && remainder) parts.push(remainder);
        for (const line of parts) {
          if (!line) continue;
          allLines.push(line);
          const parsed = parseProgressLine(line);
          emit('progress', { id: item.id, action: item.action, stream, text: line, ...(parsed || {}), ts: new Date().toISOString() });
        }
      }

      child.stdout.on('data', data => {
        if (settled) return;
        const text = data.toString();
        if (!appendOutput('stdout', text)) return;
        consumeOutput('stdout', text);
      });

      child.stderr.on('data', data => {
        if (settled) return;
        const text = data.toString();
        if (!appendOutput('stderr', text)) return;
        consumeOutput('stderr', text);
      });

      child.on('error', (err) => settle(err));

      child.on('close', code => {
        consumeOutput('stdout', '', true);
        consumeOutput('stderr', '', true);
        const result = { code, stdout, stderr, command: [bin, ...args] };

        if (code === 0) {
          const summary = summarizeTransfer(allLines);
          settle(null, { ...result, summary });
        } else {
          const err = new Error(stderr.trim() || stdout.trim() || `proton-drive exited ${code}`);
          err.result = result;
          settle(err);
        }
      });

      // Ensure child cleanup if signal aborts
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', cleanupChild, { once: true });
      }
    }), signal);
  }

  // ── Public API ─────────────────────────────────────────────

  function enqueue(action, options = {}, priority = 'medium') {
    if (pending.length + active.size >= MAX_QUEUE_DEPTH) {
      throw new Error(`Transfer queue is full (${MAX_QUEUE_DEPTH})`);
    }
    if (!['high', 'medium', 'low'].includes(priority)) priority = 'medium';
    const id = generateId();
    const item = { id, action, options, priority, retries: options.retries || MAX_RETRIES, createdAt: Date.now() };
    pending.push(item);
    emit('enqueued', { id, action, options, priority, ts: new Date().toISOString() });
    setImmediate(dequeue);
    return id;
  }

  function cancel(id) {
    const controller = active.get(id);
    if (controller) {
      controller.controller.abort();
      return true;
    }

    const idx = pending.findIndex(p => p.id === id);
    if (idx >= 0) {
      const removed = pending.splice(idx, 1);
      emit('cancelled', { id, action: removed[0].action, options: removed[0].options, ts: new Date().toISOString() });
      return true;
    }
    return false;
  }

  function cancelAll() {
    // Cancel active
    for (const [id, entry] of active) {
      entry.controller.abort();
    }
    // Clear pending
    const cancelled = pending.splice(0);
    for (const item of cancelled) {
      emit('cancelled', { id: item.id, action: item.action, options: item.options, ts: new Date().toISOString() });
    }
    notifyIdleWaiters();
    return { cancelledActive: active.size, cancelledPending: cancelled.length };
  }

  function waitForIdle(timeoutMs = 10_000) {
    if (!active.size && !pending.length) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); idleWaiters.delete(done); resolve(true); };
      const timer = setTimeout(() => {
        idleWaiters.delete(done);
        reject(new Error(`Transfer queue did not become idle within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      idleWaiters.add(done);
    });
  }

  function waitForSettled(ids, timeoutMs = 10_000) {
    const wanted = new Set(ids || []);
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = () => {
        const outstanding = pending.some(item => wanted.has(item.id)) || [...active.keys()].some(id => wanted.has(id));
        if (!outstanding) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error(`Transfers did not settle within ${timeoutMs} ms`));
        setTimeout(check, 20);
      };
      check();
    });
  }

  function pause() {
    isPaused = true;
    emit('paused', { ts: new Date().toISOString() });
  }

  function resume() {
    isPaused = false;
    emit('resumed', { ts: new Date().toISOString() });
    dequeue();
  }

  function getState() {
    return {
      isPaused,
      concurrency,
      active: Array.from(active.values()).map(e => ({
        id: e.operation.id,
        action: e.operation.action,
        options: e.operation.options,
        startedAt: new Date(e.operation.createdAt).toISOString()
      })),
      pending: pending.map(p => ({
        id: p.id,
        action: p.action,
        options: p.options,
        priority: p.priority
      })),
      recentCompleted: completed.slice(0, 20)
    };
  }

  function on(event, handler) {
    emitter.on(event, handler);
    return () => emitter.off(event, handler);
  }

  async function destroy() {
    cancelAll();
    await waitForIdle();
    emitter.removeAllListeners();
  }

  return { enqueue, cancel, cancelAll, pause, resume, getState, waitForIdle, waitForSettled, on, destroy, emitter };
}

module.exports = { createTransferQueue, MAX_RETRIES, MAX_QUEUE_DEPTH };
