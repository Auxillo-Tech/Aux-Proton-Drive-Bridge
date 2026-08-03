const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn } = childProcess;

const root = path.join(__dirname, '..');
const port = 9340;
const syncFolder = fs.mkdtempSync(path.join(os.homedir(), '.aux-proton-e2e-'));
const secondFolder = fs.mkdtempSync(path.join(os.homedir(), '.aux-proton-e2e-second-'));
const commandUploadFile = path.join(secondFolder, 'command-upload.txt');
fs.writeFileSync(commandUploadFile, 'queued by second-instance E2E');
const unapprovedFile = path.join(os.homedir(), `.aux-proton-e2e-unapproved-${process.pid}`);
fs.writeFileSync(unapprovedFile, 'must not be readable through renderer IPC');
const unapprovedDir = path.join(os.homedir(), `.aux-proton-e2e-unapproved-dir-${process.pid}`);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-e2e-state-'));
const executable = process.env.E2E_EXECUTABLE || path.join(root, 'node_modules', '.bin', 'electron');
const debugArgs = [`--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`];
const args = process.env.E2E_EXECUTABLE
  ? [...debugArgs, '--download-here', syncFolder]
  : ['.', ...debugArgs, '--download-here', syncFolder];
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', AUX_PROTON_DRIVE_USER_DATA_DIR: userDataDir };
const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let processOutput = '';
child.stdout.on('data', data => { processOutput += data; });
child.stderr.on('data', data => { processOutput += data; });

function runSecondInstance(extraArgs) {
  const secondArgs = process.env.E2E_EXECUTABLE ? extraArgs : ['.', ...extraArgs];
  return new Promise((resolve, reject) => {
    const second = spawn(executable, secondArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    second.stdout.on('data', data => { output += data; });
    second.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => {
      second.kill('SIGKILL');
      reject(new Error(`Second instance did not exit: ${output.slice(-1000)}`));
    }, 10_000);
    second.once('error', reject);
    second.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Second instance exited ${code}: ${output.slice(-1000)}`));
    });
  });
}

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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pages = await getJson('/json');
      const page = pages.find(item => item.type === 'page' && String(item.title).includes('Aux Proton Drive Bridge'));
      if (page) return page;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`CDP page did not appear. Logs: ${processOutput.slice(-1500)}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  function isExpectedBlockedAssetProbeError(text) {
    return (
      text.includes('app://bundle/package.json') &&
      (
        text.includes('Content Security Policy') ||
        text.includes('Refused to connect') ||
        text.includes('Fetch API cannot load')
      )
    );
  }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.text || 'Renderer exception');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      const text = message.params.entry.text || '';
      if (!isExpectedBlockedAssetProbeError(text)) errors.push(text);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
  });
  async function call(method, params = {}) {
    await ready;
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 120_000).unref();
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    return result.result?.value;
  }
  return { call, evaluate, errors, close: () => socket.close() };
}

(async () => {
  let cdp;
  try {
    const page = await waitForPage();
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await cdp.call('Log.enable');

    const boot = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 80 && !document.querySelector('#statusText')?.textContent; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const api = window.auxProtonDriveBridge;
      if (!api) throw new Error('Preload API missing');
      const version = await api.getAppVersion();
      const status = await api.getStatus();
      const sync = await api.syncEngine.getState();
      const files = await api.listMyFiles();
      return {
        title: document.title,
        version,
        tabCount: document.querySelectorAll('.tab').length,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
        installed: status.installed,
        authenticated: status.authenticated,
        engineActive: sync.engineActive,
        remoteItemCount: files.items.length
      };
    })()`);

    if (boot.title !== 'Aux Proton Drive Bridge') throw new Error(`Unexpected title: ${boot.title}`);
    if (!boot.version || boot.tabCount !== 6 || !boot.csp.includes("script-src 'self'")) throw new Error(`Invalid renderer shell: ${JSON.stringify(boot)}`);
    if (!boot.installed || !boot.authenticated) throw new Error(`Live Proton CLI is not ready: ${JSON.stringify(boot)}`);
    if (boot.engineActive) throw new Error('Sync engine auto-started without user consent');

    const tabState = await cdp.evaluate(`(async () => {
      const result = {};
      for (const name of ['files','sync','conflicts','queue','fuse','updates']) {
        document.querySelector('#tab' + name[0].toUpperCase() + name.slice(1)).click();
        await new Promise(r => setTimeout(r, 150));
        result[name] = document.querySelector('#panel' + name[0].toUpperCase() + name.slice(1)).classList.contains('active');
      }
      const fuse = await window.auxProtonDriveBridge.fuse.getStatus();
      return { result, fuseAvailable: fuse.isFuseAvailable, fuseReason: fuse.capabilityReason || null };
    })()`);
    if (Object.values(tabState.result).some(value => value !== true)) throw new Error(`Tab navigation failed: ${JSON.stringify(tabState)}`);
    if (tabState.fuseAvailable) throw new Error('FUSE reported available even though the installed CLI has no mount command');

    const capability = await cdp.evaluate(`(async () => {
      const api = window.auxProtonDriveBridge;
      await api.transfer.pause();
      let rejected = false;
      try { await api.uploadPaths({ localPaths: [${JSON.stringify(unapprovedFile)}], parentPath: '/my-files' }); }
      catch { rejected = true; }
      let openFolderGrantsCapability = false;
      // Do not await openFolder: the probe must not depend on the file-manager launch
      // resolving; any capability grant would happen before that regardless.
      api.openFolder(${JSON.stringify(unapprovedDir)}).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      try {
        await api.downloadAll({ localFolder: ${JSON.stringify(unapprovedDir)} });
        openFolderGrantsCapability = true;
      } catch { }
      await api.transfer.cancelAll();
      await api.transfer.resume();
      const blockedAsset = await fetch('app://bundle/package.json').then(async response => response.status === 204 && (await response.text()) === '').catch(() => true);
      return { rejected, openFolderGrantsCapability, blockedAsset, selectedFolder: document.querySelector('#localFolderInput')?.value || '' };
    })()`);
    if (!capability.rejected || capability.openFolderGrantsCapability || !capability.blockedAsset || capability.selectedFolder !== syncFolder) {
      throw new Error(`Local path capability enforcement failed: ${JSON.stringify(capability)}`);
    }

    await runSecondInstance(['--download-here', secondFolder]);
    const secondFolderApplied = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 50; i++) {
        const selected = await window.auxProtonDriveBridge.getDefaultLocalFolder();
        const rendered = document.querySelector('#localFolderInput')?.value || '';
        if (selected === ${JSON.stringify(secondFolder)} && rendered === selected) return { ok: true, selected, rendered };
        await new Promise(r => setTimeout(r, 100));
      }
      return { ok: false, selected: await window.auxProtonDriveBridge.getDefaultLocalFolder(), rendered: document.querySelector('#localFolderInput')?.value || '' };
    })()`);
    if (!secondFolderApplied.ok) throw new Error(`Second-instance --download-here command was not applied: ${JSON.stringify(secondFolderApplied)}`);

    await cdp.evaluate('window.auxProtonDriveBridge.transfer.pause()');
    await runSecondInstance(['--upload', '--path', commandUploadFile]);
    const commandQueue = await cdp.evaluate('window.auxProtonDriveBridge.transfer.getState()');
    const queuedCommand = commandQueue.pending.find(item => item.action === 'upload' && item.options.localPaths?.includes(commandUploadFile));
    if (!queuedCommand) throw new Error(`Second-instance upload was not queued: ${JSON.stringify(commandQueue)}`);
    await cdp.evaluate(`(async () => {
      await window.auxProtonDriveBridge.transfer.cancelAll();
      await window.auxProtonDriveBridge.transfer.resume();
    })()`);

    const lifecycle = await cdp.evaluate(`(async () => {
      const api = window.auxProtonDriveBridge;
      const started = await api.syncEngine.start('conservative', ${JSON.stringify(syncFolder)}, 60000);
      const during = await api.syncEngine.getState();
      await api.syncEngine.stop();
      const after = await api.syncEngine.getState();
      return { started: started.engineActive, during: during.engineActive, after: after.engineActive, folder: during.localFolder };
    })()`);
    if (!lifecycle.started || !lifecycle.during || lifecycle.after || lifecycle.folder !== syncFolder) {
      throw new Error(`Sync lifecycle failed: ${JSON.stringify(lifecycle)}`);
    }

    const selectiveSync = await cdp.evaluate(`(async () => {
      const api = window.auxProtonDriveBridge;
      const saved = await api.syncEngine.setIgnorePatterns(['node_modules', '*.iso', '  ', 'node_modules']);
      const fetched = await api.syncEngine.getIgnorePatterns();
      const state = await api.syncEngine.getState();
      let invalidRejected = false;
      try { await api.syncEngine.setIgnorePatterns('not-an-array'); }
      catch { invalidRejected = true; }
      const cleared = await api.syncEngine.setIgnorePatterns([]);
      return { saved, fetched, statePatterns: state.ignorePatterns, invalidRejected, clearedCount: cleared.length };
    })()`);
    const expectedPatterns = JSON.stringify(['node_modules', '*.iso']);
    if (JSON.stringify(selectiveSync.saved) !== expectedPatterns ||
        JSON.stringify(selectiveSync.fetched) !== expectedPatterns ||
        JSON.stringify(selectiveSync.statePatterns) !== expectedPatterns ||
        !selectiveSync.invalidRejected || selectiveSync.clearedCount !== 0) {
      throw new Error(`Selective sync ignore patterns failed: ${JSON.stringify(selectiveSync)}`);
    }

    const logBound = await cdp.evaluate(`(() => {
      document.querySelector('#clearLogBtn').click();
      for (let i = 0; i < 750; i++) log('bounded-log-' + i);
      const output = document.querySelector('#logOutput');
      return {
        nodes: output.childNodes.length,
        hasFirst: output.textContent.includes('bounded-log-0'),
        hasLast: output.textContent.includes('bounded-log-749')
      };
    })()`);
    if (logBound.nodes > 500 || logBound.hasFirst || !logBound.hasLast) {
      throw new Error(`Renderer log bound failed: ${JSON.stringify(logBound)}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    if (cdp.errors.length) throw new Error(`Renderer errors: ${cdp.errors.join(' | ')}`);
    console.log(JSON.stringify({
      ok: true,
      version: boot.version,
      remoteItemCount: boot.remoteItemCount,
      tabs: Object.keys(tabState.result).length,
      pathCapabilityEnforced: capability.rejected,
      rendererProtocolRestricted: capability.blockedAsset,
      secondInstanceCommands: true,
      fuseCapabilityGate: tabState.fuseReason,
      syncLifecycle: lifecycle,
      selectiveSync: true
    }));
  } finally {
    cdp?.close();
    killTree('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
    killTree('SIGKILL');
    fs.rmSync(syncFolder, { recursive: true, force: true });
    fs.rmSync(secondFolder, { recursive: true, force: true });
    fs.rmSync(unapprovedFile, { force: true });
    fs.rmSync(unapprovedDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().then(() => process.exit(0)).catch(error => {
  console.error(error.stack || error.message);
  console.error(processOutput.slice(-2000));
  killTree('SIGKILL');
  process.exit(1);
});
