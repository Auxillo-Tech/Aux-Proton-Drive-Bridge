const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const VALID_FILE_STRATEGIES = new Set(['keep-both', 'replace', 'skip']);
const VALID_FOLDER_STRATEGIES = new Set(['merge', 'keep-both', 'replace', 'skip']);
const DEFAULT_LOCAL_FOLDER = path.join(os.homedir(), 'ProtonDrive');

function normalizeRemotePath(parent, name) {
  const base = String(parent || '/my-files').replace(/\/+$/, '') || '/my-files';
  const safeName = String(name || '').replace(/\//g, '\/');
  return `${base}/${safeName}`;
}

function buildCommand(action, options = {}) {
  const bin = options.bin || process.env.PROTON_DRIVE_BIN || 'proton-drive';
  if (action === 'version') return { bin, args: ['version'] };
  if (action === 'login') return { bin, args: ['auth', 'login'] };
  if (action === 'logout') return { bin, args: ['auth', 'logout'] };
  if (action === 'list') return { bin, args: ['filesystem', 'list', options.path || '/my-files'] };
  if (action === 'info') return { bin, args: ['filesystem', 'info', options.path || '/my-files'] };
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

function runProton(action, options = {}, eventSink) {
  const { bin, args } = buildCommand(action, options);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, env: { ...process.env, PROTON_DRIVE_LOG_LEVEL: options.logLevel || 'ERROR' } });
    let stdout = '';
    let stderr = '';
    const emit = (stream, data) => {
      const text = data.toString();
      if (stream === 'stdout') stdout += text; else stderr += text;
      if (typeof eventSink === 'function') eventSink({ stream, text });
    };
    child.stdout.on('data', data => emit('stdout', data));
    child.stderr.on('data', data => emit('stderr', data));
    child.on('error', reject);
    child.on('close', code => {
      const result = { code, stdout, stderr, command: [bin, ...args] };
      if (code === 0) resolve(result);
      else {
        const err = new Error(stderr.trim() || stdout.trim() || `proton-drive exited ${code}`);
        err.result = result;
        reject(err);
      }
    });
  });
}

async function getStatus() {
  try {
    const version = await runProton('version', { logLevel: 'ERROR' });
    return { installed: true, version: version.stdout.trim(), authenticated: true, busy: false };
  } catch (err) {
    const text = String(err.message || '');
    const busy = text.includes('database is locked') || text.includes('SQLITE_BUSY');
    const needsLogin = text.includes('You need to login first');
    return { installed: !text.includes('ENOENT'), version: '', authenticated: !needsLogin && !busy, busy, error: text };
  }
}

module.exports = { DEFAULT_LOCAL_FOLDER, buildCommand, getStatus, normalizeRemotePath, parseListOutput, runProton };
