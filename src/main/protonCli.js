const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');
const { withProtonProcessLock } = require('./protonProcessLock');
const { buildChildEnv } = require('./childProcessEnv');

const VALID_FILE_STRATEGIES = new Set(['keep-both', 'replace', 'skip']);
const VALID_FOLDER_STRATEGIES = new Set(['merge', 'keep-both', 'replace', 'skip']);
const DEFAULT_LOCAL_FOLDER = path.join(os.homedir(), 'ProtonDrive');
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const LONG_TIMEOUT_MS = 2 * 60 * 60_000;
const ASYNC_PARSE_THRESHOLD_BYTES = 512 * 1024;
const activeChildren = new Set();


function normalizeRemotePath(parent, name) {
  const base = String(parent || '/my-files').replace(/\/+$/, '') || '/my-files';
  const safeName = String(name || '').replace(/\//g, '\/');
  return `${base}/${safeName}`;
}

function buildCommand(action, options = {}, trustedBin = null) {
  const bin = trustedBin || process.env.PROTON_DRIVE_BIN || 'proton-drive';
  if (action === 'version') return { bin, args: ['version'] };
  if (action === 'login') return { bin, args: ['auth', 'login'] };
  if (action === 'logout') return { bin, args: ['auth', 'logout'] };
  if (action === 'list') return { bin, args: ['filesystem', 'list', '-j', options.path || '/my-files'] };
  if (action === 'info') return { bin, args: ['filesystem', 'info', '-j', options.path || '/my-files'] };
  if (action === 'download') {
    const paths = Array.isArray(options.paths) && options.paths.length ? options.paths : ['/my-files'];
    const localFolder = options.localFolder || DEFAULT_LOCAL_FOLDER;
    const fileStrategy = options.fileConflictStrategy || 'skip';
    const folderStrategy = options.folderConflictStrategy || 'merge';
    if (!VALID_FILE_STRATEGIES.has(fileStrategy)) throw new Error(`Invalid file conflict strategy: ${fileStrategy}`);
    if (!VALID_FOLDER_STRATEGIES.has(folderStrategy)) throw new Error(`Invalid folder conflict strategy: ${folderStrategy}`);
    return { bin, args: ['filesystem', 'download', '--folder-conflict-strategy', folderStrategy, '--file-conflict-strategy', fileStrategy, ...paths, localFolder] };
  }
  if (action === 'upload') {
    const localPaths = Array.isArray(options.localPaths) && options.localPaths.length ? options.localPaths : [];
    if (!localPaths.length) throw new Error('No local paths selected for upload');
    const parentPath = options.parentPath || '/my-files';
    const fileStrategy = options.fileConflictStrategy || 'skip';
    const folderStrategy = options.folderConflictStrategy || 'merge';
    if (!VALID_FILE_STRATEGIES.has(fileStrategy)) throw new Error(`Invalid file conflict strategy: ${fileStrategy}`);
    if (!VALID_FOLDER_STRATEGIES.has(folderStrategy)) throw new Error(`Invalid folder conflict strategy: ${folderStrategy}`);
    return { bin, args: ['filesystem', 'upload', '--folder-conflict-strategy', folderStrategy, '--file-conflict-strategy', fileStrategy, ...localPaths, parentPath] };
  }
  throw new Error(`Unsupported Proton Drive action: ${action}`);
}

function parseListOutput(output, options = {}) {
  const text = String(output ?? '');
  const requireJson = options.requireJson === true;
  if (requireJson && !text.trim()) throw new Error('Remote returned an empty JSON listing');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (requireJson) throw new Error(`Remote returned invalid JSON listing: ${error.message}`);
  }

  if (parsed !== undefined) {
    if (!Array.isArray(parsed)) {
      if (requireJson) throw new Error('Remote JSON listing must have an array root');
    } else {
      if (requireJson) {
        const invalidIndex = parsed.findIndex(item => {
          const hasName = Boolean(item?.name?.ok && typeof item.name.value === 'string' && item.name.value);
          const hasUid = Boolean(item?.uid);
          return (!hasName && !hasUid) || !['file', 'folder'].includes(item?.type);
        });
        if (invalidIndex !== -1) throw new Error(`Remote JSON listing contains an invalid row at index ${invalidIndex}`);
      }
      return parsed
        .filter(item => (item.name?.ok && item.name.value) || item.uid)
        .map(item => {
          const claimedDigests = item.activeRevision?.value?.claimedDigests;
          const sha1 = claimedDigests?.sha1Verified === true && /^[0-9a-f]{40}$/i.test(claimedDigests.sha1 || '')
            ? `sha1:${claimedDigests.sha1.toLowerCase()}` : null;
          return {
            type: item.type === 'folder' ? 'folder' : 'file',
            name: item.name?.ok ? item.name.value : String(item.uid),
            size: Number(item.activeRevision?.value?.claimedSize ?? item.totalStorageSize ?? item.file?.size ?? item.size ?? 0),
            modified: item.activeRevision?.value?.claimedModificationTime || item.modificationTime || item.modified || null,
            ...(sha1 ? { hash: sha1 } : {}),
            uid: item.uid || null
          };
        });
    }
  }

  // Human-readable parsing is retained for explicit non-JSON callers only.
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(raw => {
      const marker = ' - ';
      const idx = raw.lastIndexOf(marker);
      const name = idx >= 0 ? raw.slice(idx + marker.length) : raw;
      const type = raw.startsWith('🗂') ? 'folder' : raw.startsWith('📄') ? 'file' : 'unknown';
      return { type, name, raw };
    });
}

function parseListOutputAsync(output, options = {}) {
  const text = String(output ?? '');
  if (Buffer.byteLength(text) < ASYNC_PARSE_THRESHOLD_BYTES) {
    return Promise.resolve().then(() => parseListOutput(text, options));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'remoteListParserWorker.js'), { workerData: { text, options } });
    worker.once('message', message => {
      if (message?.ok) resolve(message.rows);
      else reject(new Error(message?.error || 'Remote listing parser failed'));
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`Remote listing parser exited with code ${code}`));
    });
  });
}

// Array-based serialized queue (fixed max size, no growing promise chain)
const MAX_QUEUE_SIZE = 100;
const protonQueue = [];

function runProton(action, options = {}, eventSink) {
  return new Promise((resolve, reject) => {
    if (protonQueue.length >= MAX_QUEUE_SIZE) {
      reject(new Error(`Proton Drive command queue is full (${MAX_QUEUE_SIZE})`));
      return;
    }
    protonQueue.push({ action, options, eventSink, resolve, reject });
    process.nextTick(drainQueue);
  });
}

function drainQueue() {
  if (drainQueue.running) return;
  drainQueue.running = true;
  function next() {
    if (!protonQueue.length) { drainQueue.running = false; return; }
    const job = protonQueue.shift();
    runProtonNow(job.action, job.options, job.eventSink)
      .then(job.resolve).catch(job.reject).finally(next);
  }
  next();
}

function runProtonNow(action, options = {}, eventSink) {
  const { bin, args } = buildCommand(action, options);
  return withProtonProcessLock(() => new Promise((resolve, reject) => {
    const timeoutMs = ['download', 'upload', 'login'].includes(action) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      env: buildChildEnv({ PROTON_DRIVE_LOG_LEVEL: options.logLevel || 'ERROR' })
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      settle(new Error(`Proton Drive ${action} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      if (error) reject(error); else resolve(result);
    };
    const emit = (stream, data) => {
      if (settled) return;
      const text = data.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        settle(new Error(`Proton Drive ${action} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      if (stream === 'stdout') stdout += text; else stderr += text;
      if (typeof eventSink === 'function') eventSink({ stream, text });
    };
    child.stdout.on('data', data => emit('stdout', data));
    child.stderr.on('data', data => emit('stderr', data));
    child.on('error', error => settle(error));
    child.on('close', (code, signal) => {
      const result = { code, signal: signal || null, stdout, stderr, command: [bin, ...args] };
      if (code === 0) {
        // Defense: some CLI builds print auth errors with confusing exit codes.
        const combined = `${stdout}\n${stderr}`;
        if (action !== 'logout' && /need to login|not logged in|unauthenticated/i.test(combined)) {
          const err = new Error(stderr.trim() || stdout.trim() || 'You need to login first');
          err.result = result;
          settle(err);
          return;
        }
        settle(null, result);
        return;
      }
      if (code === null || code === undefined) {
        const err = new Error(
          signal
            ? `Proton Drive ${action} was killed (${signal}) before it finished`
            : `Proton Drive ${action} ended without an exit code (process was interrupted)`
        );
        err.result = result;
        settle(err);
        return;
      }
      const err = new Error(stderr.trim() || stdout.trim() || `proton-drive exited ${code}`);
      err.result = result;
      settle(err);
    });
  }));
}

function shutdownProtonProcesses() {
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch {}
  }
  activeChildren.clear();
}

let cachedStatus = null;
let cachedStatusAt = 0;
const STATUS_CACHE_MS = 30_000;

function clearStatusCache() {
  cachedStatus = null;
  cachedStatusAt = 0;
}

function extractLoginUrl(text) {
  const match = String(text || '').match(/https:\/\/account\.proton\.me\/desktop\/login[^\s]+/i);
  return match ? match[0] : null;
}

function isAlreadyLoggedOutMessage(text) {
  return /need to login|not logged in|unauthenticated|already logged out|no (active )?session/i.test(String(text || ''));
}

async function getStatus(options = {}) {
  if (!options.force && cachedStatus && Date.now() - cachedStatusAt < STATUS_CACHE_MS) return { ...cachedStatus };
  try {
    const version = await runProton('version', { logLevel: 'ERROR' });
    try {
      await runProton('info', { path: '/my-files', logLevel: 'ERROR' });
      cachedStatus = { installed: true, version: version.stdout.trim(), authenticated: true, busy: false };
    } catch (authErr) {
      const text = String(authErr.message || '');
      const busy = /database is locked|SQLITE_BUSY/i.test(text);
      cachedStatus = {
        installed: true,
        version: version.stdout.trim(),
        authenticated: false,
        busy,
        error: text
      };
    }
  } catch (err) {
    const text = String(err.message || '');
    const busy = /database is locked|SQLITE_BUSY/i.test(text);
    cachedStatus = { installed: !/ENOENT|not found/i.test(text), version: '', authenticated: false, busy, error: text };
  }
  cachedStatusAt = Date.now();
  return { ...cachedStatus };
}

module.exports = {
  DEFAULT_LOCAL_FOLDER,
  buildCommand,
  clearStatusCache,
  extractLoginUrl,
  getStatus,
  isAlreadyLoggedOutMessage,
  normalizeRemotePath,
  parseListOutput,
  parseListOutputAsync,
  runProton,
  shutdownProtonProcesses
};
