const { spawn } = require('node:child_process');
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

function parseListOutput(output) {
  // Try JSON format first (used when -j flag is passed)
  try {
    const parsed = JSON.parse(String(output || ''));
    if (Array.isArray(parsed)) {
      return parsed
        .filter(item => (item.name?.ok && item.name.value) || item.uid)
        .map(item => ({
          type: item.type === 'folder' ? 'folder' : 'file',
          name: item.name?.ok ? item.name.value : String(item.uid),
          size: Number(item.activeRevision?.value?.claimedSize ?? item.totalStorageSize ?? item.file?.size ?? item.size ?? 0),
          modified: item.activeRevision?.value?.claimedModificationTime || item.modificationTime || item.modified || null,
          uid: item.uid || null
        }));
    }
  } catch {
    // Not JSON — fall back to text parsing
  }

  // Text fallback: parse human-readable listing format
  return String(output || '')
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
    child.on('close', code => {
      const result = { code, stdout, stderr, command: [bin, ...args] };
      if (code === 0) settle(null, result);
      else {
        const err = new Error(stderr.trim() || stdout.trim() || `proton-drive exited ${code}`);
        err.result = result;
        settle(err);
      }
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
      const needsLogin = /need to login|not logged in|unauthenticated/i.test(text);
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
  getStatus,
  normalizeRemotePath,
  parseListOutput,
  runProton,
  shutdownProtonProcesses
};
