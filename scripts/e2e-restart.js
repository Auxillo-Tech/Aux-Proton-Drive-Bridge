'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', '.bin', 'electron');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-restart-state-'));
const approvedDir = fs.mkdtempSync(path.join(os.homedir(), '.aux-proton-restart-approved-'));
const approvedFile = path.join(approvedDir, 'persisted.txt');
fs.writeFileSync(approvedFile, 'restart capability test');
let child;

function descendants(pid) {
  const result = childProcess.spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  const direct = result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : [];
  return direct.flatMap(id => [id, ...descendants(id)]);
}

function killTree(signal) {
  for (const pid of descendants(child.pid).reverse()) {
    try { process.kill(pid, signal); } catch {}
  }
  try { process.kill(child.pid, signal); } catch {}
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

async function connect(port) {
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      page = (await getJson(port, '/json')).find(item => item.type === 'page' && String(item.title).includes('Aux Proton Drive Bridge'));
      if (page) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!page) throw new Error('Restart E2E page did not appear');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  async function evaluate(expression) {
    const response = await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      setTimeout(() => { if (pending.delete(id)) reject(new Error('Restart E2E CDP timeout')); }, 30_000).unref();
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Restart E2E evaluation failed');
    return response.result?.value;
  }
  return { evaluate, close: () => socket.close() };
}

async function launch(port, extraArgs = []) {
  child = childProcess.spawn(electron, ['.', `--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`, ...extraArgs], {
    cwd: root,
    env: { ...process.env, AUX_PROTON_DRIVE_USER_DATA_DIR: stateDir },
    stdio: 'ignore'
  });
  return connect(port);
}

async function stop(cdp) {
  cdp.close();
  // Graceful first: SIGTERM to the main process only. Tree-wide TERM kills
  // renderers out from under Chromium and manufactures SIGTRAP core dumps.
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  const exited = await Promise.race([
    new Promise(resolve => child.once('close', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 30_000))
  ]);
  if (!exited) {
    killTree('SIGKILL');
    throw new Error('App did not exit within 30s of SIGTERM (graceful shutdown regression)');
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}

(async () => {
  let cdp = await launch(9341, ['--download-here', approvedDir]);
  const saved = await cdp.evaluate(`(async () => {
    const api = window.auxProtonDriveBridge;
    return api.saveBackupProfile({ enabled: false, mode: 'one-way-upload', localPaths: [${JSON.stringify(approvedFile)}], remoteParentPath: '/my-files' });
  })()`);
  if (!saved.localPaths?.includes(approvedFile)) throw new Error('Backup profile did not persist approved path');
  await stop(cdp);

  cdp = await launch(9342);
  const restored = await cdp.evaluate(`(async () => {
    const api = window.auxProtonDriveBridge;
    const profile = await api.getBackupProfile();
    await api.transfer.pause();
    const queued = await api.uploadPaths({ localPaths: [${JSON.stringify(approvedFile)}], parentPath: '/my-files' });
    const state = await api.transfer.getState();
    await api.transfer.cancelAll();
    await api.transfer.resume();
    return { profile, queued, pending: state.pending.length };
  })()`);
  if (!restored.profile.localPaths?.includes(approvedFile) || !restored.queued?.transferId || restored.pending < 1) {
    throw new Error(`Restart persistence failed: ${JSON.stringify(restored)}`);
  }
  await stop(cdp);
  console.log(JSON.stringify({ ok: true, profilePersisted: true, capabilityRestored: true }));
})().finally(() => {
  if (child?.exitCode === null) killTree('SIGKILL');
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(approvedDir, { recursive: true, force: true });
}).catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
