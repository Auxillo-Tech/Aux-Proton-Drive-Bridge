const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_EVENT_TEXT = 1000;
const MAX_EVENTS_PER_OPERATION = 50;
const MAX_OPERATIONS = 200;

function redactSensitive(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(payload=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/(#payload=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(access_token=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/(refresh_token=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|client[_-]?secret|pass(?:word|phrase)?|private[_-]?key|oauth[_-]?code|credential|csrf|xsrf|token|secret|ticket|sas)\s*[=:]\s*)[^\s&#,;]+/gi, '$1[REDACTED]')
    .replace(/([?&#](?:code|key|auth|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
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
      if (/password|passphrase|token|secret|payload|session|cookie|authorization|credential|csrf|xsrf|ticket|api.?key|private.?key|client.?secret|oauth.?code/i.test(key)) out[key] = '[REDACTED]';
      else out[key] = sanitizeForStorage(raw);
    }
    return out;
  }
  return String(value);
}

function shouldForwardOperationEvent(action, payload = {}) {
  // Remote JSON listings and browser-login URLs can contain private metadata. Both are
  // consumed in the main process and must not be copied into DOM logs or persistent history.
  if (action === 'list' && payload.stream === 'stdout') return false;
  if (action === 'login' && /https?:\/\/\S+/i.test(String(payload.text || ''))) return false;
  return true;
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

  function recoverStaleRunning(maxAgeMs = 2 * 60_000) {
    const data = load();
    const now = Date.now();
    let changed = 0;
    for (const op of data.operations) {
      if (op.status !== 'running') continue;
      const started = Date.parse(op.startedAt || '') || 0;
      if (!started || now - started < maxAgeMs) continue;
      op.status = 'failed';
      op.finishedAt = new Date().toISOString();
      op.updatedAt = op.finishedAt;
      op.error = op.error || 'Operation interrupted (app quit or process killed before completion)';
      changed += 1;
    }
    if (changed) save(data);
    return changed;
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
    const safeLimit = Number.isFinite(Number(limit)) ? Math.min(500, Math.max(1, Math.trunc(Number(limit)))) : 50;
    return load().operations.slice(-safeLimit).reverse();
  }

  function clear() {
    save({ version: 1, operations: [] });
  }

  return { filePath: resolved, begin, appendEvent, finish, list, clear, recoverStaleRunning, redactSensitive, sanitizeForStorage };
}

module.exports = { createOperationStore, redactSensitive, sanitizeForStorage, shouldForwardOperationEvent };
