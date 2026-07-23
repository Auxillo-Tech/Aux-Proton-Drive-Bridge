const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_EVENT_TEXT = 4000;
const MAX_EVENTS_PER_OPERATION = 200;
const MAX_OPERATIONS = 500;

function redactSensitive(value) {
  return String(value ?? '')
    .replace(/(payload=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/(#payload=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(access_token=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/(refresh_token=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g, '[REDACTED_JWT]');
}

function sanitizeForStorage(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitive(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizeForStorage);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (/password|token|secret|payload|session|cookie/i.test(key)) out[key] = '[REDACTED]';
      else out[key] = sanitizeForStorage(raw);
    }
    return out;
  }
  return String(value);
}

function createOperationStore(filePath) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      if (!parsed || !Array.isArray(parsed.operations)) return { version: 1, operations: [] };
      return { version: 1, operations: parsed.operations };
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, operations: [] };
      const corruptPath = `${resolved}.corrupt-${Date.now()}`;
      fs.renameSync(resolved, corruptPath);
      return { version: 1, operations: [] };
    }
  }

  function save(data) {
    const trimmed = {
      version: 1,
      operations: data.operations.slice(-MAX_OPERATIONS)
    };
    const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, resolved);
  }

  function begin(action, options = {}) {
    const data = load();
    const now = new Date().toISOString();
    const op = {
      id: crypto.randomUUID(),
      action,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      options: sanitizeForStorage(options),
      exitCode: null,
      error: null,
      events: []
    };
    data.operations.push(op);
    save(data);
    return op;
  }

  function update(id, updater) {
    const data = load();
    const idx = data.operations.findIndex(op => op.id === id);
    if (idx === -1) return null;
    const op = data.operations[idx];
    updater(op);
    op.updatedAt = new Date().toISOString();
    save(data);
    return op;
  }

  function appendEvent(id, stream, text) {
    return update(id, op => {
      op.events.push({
        at: new Date().toISOString(),
        stream: sanitizeForStorage(stream),
        text: redactSensitive(text).slice(0, MAX_EVENT_TEXT)
      });
      if (op.events.length > MAX_EVENTS_PER_OPERATION) op.events = op.events.slice(-MAX_EVENTS_PER_OPERATION);
    });
  }

  function finish(id, status, result = {}) {
    return update(id, op => {
      op.status = status;
      op.finishedAt = new Date().toISOString();
      op.exitCode = Number.isInteger(result.code) ? result.code : null;
      op.error = result.error ? redactSensitive(result.error) : null;
      if (result.stdout) op.stdoutTail = redactSensitive(result.stdout).slice(-MAX_EVENT_TEXT);
      if (result.stderr) op.stderrTail = redactSensitive(result.stderr).slice(-MAX_EVENT_TEXT);
    });
  }

  function list(limit = 50) {
    return load().operations.slice(-limit).reverse();
  }

  function clear() {
    save({ version: 1, operations: [] });
  }

  return { filePath: resolved, begin, appendEvent, finish, list, clear, redactSensitive, sanitizeForStorage };
}

module.exports = { createOperationStore, redactSensitive, sanitizeForStorage };
