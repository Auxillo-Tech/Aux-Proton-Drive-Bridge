'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn, spawnSync } = childProcess;

const root = path.resolve(__dirname, '..');
const expectedVersion = require(path.join(root, 'package.json')).version;
const executable = process.env.E2E_INSTALLED_EXECUTABLE || '/opt/Aux Proton Drive Bridge/aux-proton-drive-bridge';
if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Installed executable not found: ${executable}`);
}
const port = 9341;
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`;
const name = `edi-e2e-temp-${runId}.txt`;
const remotePath = `/my-files/${name}`;
const tempRoot = fs.mkdtempSync(path.join(os.homedir(), '.aux-proton-live-e2e-'));
const uploadFile = path.join(tempRoot, name);
const downloadFolder = path.join(tempRoot, 'download');
const userDataDir = path.join(tempRoot, 'user-data');
fs.mkdirSync(downloadFolder, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
const content = `Aux Proton Drive Bridge installed E2E ${runId}\n${crypto.randomBytes(32).toString('hex')}\n`;
fs.writeFileSync(uploadFile, content, { mode: 0o600 });
const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex');

const env = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: '1',
  AUX_PROTON_DRIVE_USER_DATA_DIR: userDataDir
};
// No GL flags here: the app's own linuxGraphics workaround must be what gets exercised.
const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--remote-allow-origins=http://127.0.0.1:${port}`,
  '--download-here', downloadFolder
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let processOutput = '';
child.stdout.on('data', data => { processOutput += data; });
child.stderr.on('data', data => { processOutput += data; });

function descendants(pid) {
  const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  const direct = result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : [];
  return direct.flatMap(id => [id, ...descendants(id)]);
}

function killTree(signal) {
  for (const pid of descendants(child.pid).reverse()) {
    try { process.kill(pid, signal); } catch {}
  }
  try { process.kill(child.pid, signal); } catch {}
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP HTTP timeout')));
    request.on('error', reject);
  });
}

async function waitForPage() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const pages = await getJson('/json');
      const page = pages.find(item => item.type === 'page' && String(item.title).includes('Aux Proton Drive Bridge'));
      if (page) return page;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Installed CDP page did not appear. Logs: ${processOutput.slice(-2000)}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  async function call(method, params = {}) {
    await ready;
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 180_000).unref();
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed';
      throw new Error(detail);
    }
    return result.result?.value;
  }
  return { call, evaluate, close: () => socket.close() };
}

function runSecondInstance(args) {
  return new Promise((resolve, reject) => {
    const second = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    second.stdout.on('data', data => { output += data; });
    second.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => {
      second.kill('SIGKILL');
      reject(new Error(`Upload second instance did not exit: ${output.slice(-1000)}`));
    }, 15_000);
    second.once('error', reject);
    second.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Upload second instance exited ${code}: ${output.slice(-1000)}`));
    });
  });
}

async function waitForTransfer(cdp, transferId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate('window.auxProtonDriveBridge.transfer.getState()');
    const completed = state.recentCompleted.find(item => item.id === transferId);
    if (completed) {
      if (completed.status !== 'succeeded') {
        throw new Error(`Transfer ${transferId} ended ${completed.status}: ${JSON.stringify(completed)}`);
      }
      return completed;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Transfer ${transferId} did not complete within ${timeoutMs} ms`);
}

function runCli(args, options = {}) {
  const result = spawnSync('proton-drive', args, {
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `proton-drive ${args.join(' ')} failed`);
  return result.stdout;
}

function remoteExists(parent, expectedName) {
  const rows = JSON.parse(runCli(['filesystem', 'list', '-j', parent]));
  return rows.some(item => item?.name?.ok && item.name.value === expectedName);
}

function cleanupDisposableRemote() {
  if (!/^edi-e2e-temp-[A-Za-z0-9.-]+\.txt$/.test(name)) throw new Error(`Refusing unsafe cleanup name: ${name}`);
  if (remoteExists('/my-files', name)) runCli(['filesystem', 'trash', remotePath]);
  if (remoteExists('/trash', name)) runCli(['filesystem', 'delete', `/trash/${name}`]);
  if (remoteExists('/my-files', name) || remoteExists('/trash', name)) {
    throw new Error(`Disposable remote cleanup did not remove ${name}`);
  }
}

(async () => {
  let cdp;
  let uploaded = false;
  try {
    const page = await waitForPage();
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    const boot = await cdp.evaluate(`(async () => {
      const api = window.auxProtonDriveBridge;
      for (let i = 0; i < 100; i++) {
        const status = await api.getStatus({ force: true });
        if (status.installed && status.authenticated) return {
          version: await api.getAppVersion(),
          authenticated: true,
          folder: await api.getDefaultLocalFolder()
        };
        await new Promise(r => setTimeout(r, 250));
      }
      return { version: await api.getAppVersion(), authenticated: false, folder: await api.getDefaultLocalFolder() };
    })()`);
    if (boot.version !== expectedVersion || !boot.authenticated || boot.folder !== downloadFolder) {
      throw new Error(`Installed app is not ready for live E2E: ${JSON.stringify(boot)}`);
    }

    await runSecondInstance(['--upload', '--path', uploadFile]);
    let uploadTransferId = null;
    const queuedDeadline = Date.now() + 15_000;
    while (Date.now() < queuedDeadline && !uploadTransferId) {
      const state = await cdp.evaluate('window.auxProtonDriveBridge.transfer.getState()');
      const candidate = [...state.active, ...state.pending, ...state.recentCompleted]
        .find(item => item.action === 'upload' && item.options?.localPaths?.includes(uploadFile));
      uploadTransferId = candidate?.id || null;
      if (!uploadTransferId) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!uploadTransferId) throw new Error('Installed app did not queue the disposable upload');
    await waitForTransfer(cdp, uploadTransferId);

    const remoteDeadline = Date.now() + 60_000;
    while (Date.now() < remoteDeadline && !remoteExists('/my-files', name)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!remoteExists('/my-files', name)) throw new Error(`Uploaded disposable file not found: ${remotePath}`);
    uploaded = true;

    const download = await cdp.evaluate(`window.auxProtonDriveBridge.downloadPaths({
      paths: [${JSON.stringify(remotePath)}],
      localFolder: ${JSON.stringify(downloadFolder)},
      fileConflictStrategy: 'replace',
      folderConflictStrategy: 'merge'
    })`);
    if (!download?.transferId) throw new Error(`Installed app did not queue the disposable download: ${JSON.stringify(download)}`);
    await waitForTransfer(cdp, download.transferId);

    const downloadedPath = path.join(downloadFolder, name);
    if (!fs.statSync(downloadedPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Downloaded file missing: ${downloadedPath}`);
    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(downloadedPath)).digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error(`Downloaded bytes differ: ${actualSha256} != ${expectedSha256}`);

    cleanupDisposableRemote();
    uploaded = false;
    console.log(JSON.stringify({
      ok: true,
      installedVersion: boot.version,
      executable,
      remotePath,
      upload: 'succeeded',
      download: 'succeeded',
      sha256: actualSha256,
      cleanup: 'permanently deleted exact disposable item',
      productionItemsTouched: 0
    }));
  } finally {
    cdp?.close();
    killTree('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
    killTree('SIGKILL');
    try {
      if (uploaded || remoteExists('/my-files', name) || remoteExists('/trash', name)) cleanupDisposableRemote();
    } catch (error) { console.error(`WARNING: ${error.message}`); }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().then(() => process.exit(0)).catch(error => {
  console.error(error.stack || error.message);
  console.error(processOutput.slice(-2000));
  killTree('SIGKILL');
  process.exit(1);
});
