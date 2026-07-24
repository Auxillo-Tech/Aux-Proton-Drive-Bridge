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
const { runProton, buildCommand } = require('./protonCli');
const { parseProgressLine, summarizeTransfer } = require('./progressParser');

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

const RETRYABLE_EXIT_CODES = new Set([null, undefined]);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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

  const emitter = new EventEmitter();
  const pending = [];        // { id, action, options, priority, retries, createdAt }
  const active = new Map();  // id -> { operation, controller }
  const completed = [];      // recent completed operations (ring buffer)
  const COMPLETED_MAX = 100;

  let isPaused = false;
  let nextId = 1;

  // ── Internal helpers ──────────────────────────────────────

  function generateId() {
    return `tx-${Date.now()}-${nextId++}`;
  }

  function emit(event, payload) {
    emitter.emit(event, payload);
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
      const record = { id: item.id, action: item.action, options: item.options, status: 'succeeded', result, completedAt: new Date().toISOString() };
      completed.unshift(record);
      if (completed.length > COMPLETED_MAX) completed.length = COMPLETED_MAX;

      emit('complete', { id: item.id, action: item.action, options: item.options, result, ts: new Date().toISOString() });
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
  }

  async function runTransferWithRetry(item, signal) {
    let lastError;

    for (let attempt = 1; attempt <= Math.min(MAX_RETRIES, Math.max(item.retries || 1, 1)); attempt++) {
      if (signal.aborted) throw Object.assign(new Error('Transfer cancelled'), { cancelled: true, name: 'AbortError' });

      if (attempt > 1) {
        emit('retry', { id: item.id, attempt, maxRetries: MAX_RETRIES, ts: new Date().toISOString() });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }

      try {
        const result = await runTransferOnce(item, signal);
        return result;
      } catch (err) {
        if (err.cancelled || err.name === 'AbortError') throw err;

        lastError = err;
        const exitCode = err.result?.code;

        // Non-retryable errors
        if (exitCode !== null && exitCode !== undefined && !RETRYABLE_EXIT_CODES.has(exitCode)) break;
        if (err.message && (
          err.message.includes('ENOENT') ||
          err.message.includes('EACCES') ||
          err.message.includes('ENOSPC') ||
          err.message.includes('not found')
        )) break;

        emit('progress', { id: item.id, action: item.action, stream: 'stderr', text: `Attempt ${attempt} failed: ${err.message}`, ts: new Date().toISOString() });
      }
    }

    throw lastError || new Error('Transfer failed after retries');
  }

  function runTransferOnce(item, signal) {
    return new Promise((resolve, reject) => {
      const { bin, args } = buildCommand(item.action, item.options);
      const env = { ...process.env, PROTON_DRIVE_LOG_LEVEL: item.options.logLevel || 'ERROR' };

      const { spawn } = require('node:child_process');
      const child = spawn(bin, args, { shell: false, windowsHide: true, env, signal });

      let stdout = '';
      let stderr = '';
      const allLines = [];

      child.stdout.on('data', data => {
        const text = data.toString();
        stdout += text;
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          allLines.push(line);
          const parsed = parseProgressLine(line);
          if (parsed) {
            emit('progress', { id: item.id, action: item.action, stream: 'stdout', ...parsed, ts: new Date().toISOString() });
          }
        }
        emit('progress', { id: item.id, action: item.action, stream: 'stdout', text: text.trim(), ts: new Date().toISOString() });
      });

      child.stderr.on('data', data => {
        const text = data.toString();
        stderr += text;
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          allLines.push(line);
          const parsed = parseProgressLine(line);
          if (parsed) {
            emit('progress', { id: item.id, action: item.action, stream: 'stderr', ...parsed, ts: new Date().toISOString() });
          }
        }
        emit('progress', { id: item.id, action: item.action, stream: 'stderr', text: text.trim(), ts: new Date().toISOString() });
      });

      child.on('error', reject);

      child.on('close', code => {
        const result = { code, stdout, stderr, command: [bin, ...args] };

        if (code === 0) {
          const summary = summarizeTransfer(allLines);
          resolve({ ...result, summary });
        } else {
          const err = new Error(stderr.trim() || stdout.trim() || `proton-drive exited ${code}`);
          err.result = result;
          reject(err);
        }
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────

  function enqueue(action, options = {}, priority = 'medium') {
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
    return { cancelledActive: active.size, cancelledPending: cancelled.length };
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

  function destroy() {
    cancelAll();
    emitter.removeAllListeners();
  }

  return { enqueue, cancel, cancelAll, pause, resume, getState, on, destroy, emitter };
}

module.exports = { createTransferQueue, MAX_RETRIES };
