'use strict';

// Full UI walk over the real renderer: every tab, every safe button, and all four
// sync modes in both directions against the live account — using disposable files
// only. The real remote inventory is fenced off with selective-sync ignore
// patterns so no production item is downloaded, uploaded, or modified, and the
// disposable remote files are permanently removed afterwards.
//
// Buttons that open native OS dialogs (login/logout, choose folder/files) are
// asserted for presence and enabled/disabled state but not clicked: logout would
// drop the machine-wide CLI session, and native dialogs cannot be driven by CDP.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn, spawnSync } = childProcess;

const root = path.resolve(__dirname, '..');
const expectedVersion = require(path.join(root, 'package.json')).version;
const port = 9344;
const runId = `${Date.now().toString(36)}${process.pid}`;
const walkFolder = fs.mkdtempSync(path.join(os.homedir(), '.aux-proton-ui-walk-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-ui-walk-state-'));
const upName = `edi-ui-walk-up-${runId}.txt`;
const consName = `edi-ui-walk-cons-${runId}.txt`;
const biName = `edi-ui-walk-bi-${runId}.txt`;
const ignoredName = `edi-ui-walk-skip-${runId}.ignored`;
// Fence: JD's real root folders are all named "N. Something"; old harness leaks
// use edi-e2e-temp-*; *.ignored proves selective sync excludes local files.
const fencePatterns = ['?. *', 'edi-e2e-temp-*', '*.ignored'];
const disposableNames = [upName, consName, biName];

const executable = process.env.E2E_EXECUTABLE || path.join(root, 'node_modules', '.bin', 'electron');
const debugArgs = [`--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`];
const args = process.env.E2E_EXECUTABLE
  ? [...debugArgs, '--download-here', walkFolder]
  : ['.', ...debugArgs, '--download-here', walkFolder];
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', AUX_PROTON_DRIVE_USER_DATA_DIR: userDataDir };
const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  throw new Error(`CDP page did not appear. Logs: ${processOutput.slice(-2000)}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.exception?.description || 'uncaught exception');
      return;
    }
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
  return { call, evaluate, errors, close: () => socket.close() };
}

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
    }, 15_000);
    second.once('error', reject);
    second.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Second instance exited ${code}: ${output.slice(-1000)}`));
    });
  });
}

function runCli(cliArgs, options = {}) {
  const result = spawnSync('proton-drive', cliArgs, {
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `proton-drive ${cliArgs.join(' ')} failed`);
  return result.stdout;
}

function remoteExists(parent, expectedName) {
  const rows = JSON.parse(runCli(['filesystem', 'list', '-j', parent]));
  return rows.some(item => item?.name?.ok && item.name.value === expectedName);
}

// While the app is running its own serialized proton-drive operations, a
// concurrent CLI invocation can fail on the shared SQLite cache lock; polls
// treat that as "not yet" instead of failing the walk.
function remoteExistsTolerant(parent, expectedName) {
  try { return remoteExists(parent, expectedName); } catch { return false; }
}

async function cleanupDisposableRemote() {
  for (const name of disposableNames) {
    if (!/^edi-ui-walk-[a-z]+-[a-z0-9]+\.txt$/.test(name)) throw new Error(`Refusing unsafe cleanup name: ${name}`);
    // Listings can serve a stale view for a few seconds after trash/delete;
    // retry the round before declaring the cleanup failed.
    let gone = false;
    for (let attempt = 1; attempt <= 5 && !gone; attempt++) {
      try {
        if (remoteExists('/my-files', name)) runCli(['filesystem', 'trash', `/my-files/${name}`]);
        if (remoteExists('/trash', name)) runCli(['filesystem', 'delete', `/trash/${name}`]);
        gone = !remoteExists('/my-files', name) && !remoteExists('/trash', name);
      } catch { gone = false; }
      if (!gone) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!gone) throw new Error(`Disposable remote cleanup did not remove ${name}`);
  }
}

async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

(async () => {
  let cdp;
  let anyUploaded = false;
  let walkCompleted = false;
  const passed = [];
  try {
    const page = await waitForPage();
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');

    // ── Boot: authenticated, right version, right folder ──
    const boot = await cdp.evaluate(`(async () => {
      const api = window.auxProtonDriveBridge;
      for (let i = 0; i < 100; i++) {
        const status = await api.getStatus({ force: true });
        if (status.installed && status.authenticated) {
          return { version: await api.getAppVersion(), authenticated: true, folder: await api.getDefaultLocalFolder() };
        }
        await new Promise(r => setTimeout(r, 250));
      }
      return { authenticated: false };
    })()`);
    if (!boot.authenticated || boot.version !== expectedVersion || boot.folder !== walkFolder) {
      throw new Error(`App not ready for UI walk: ${JSON.stringify(boot)}`);
    }
    passed.push('boot');

    // ── Tab walk: every tab activates its panel exclusively ──
    const tabs = ['Files', 'Sync', 'Conflicts', 'Queue', 'Updates'];
    for (const tab of tabs) {
      const state = await cdp.evaluate(`(() => {
        document.getElementById('tab${tab}').click();
        const activeTabs = [...document.querySelectorAll('.tab.active')].map(el => el.id);
        const activePanels = [...document.querySelectorAll('.tab-panel.active')].map(el => el.id);
        return { activeTabs, activePanels };
      })()`);
      if (state.activeTabs.join() !== `tab${tab}` || state.activePanels.join() !== `panel${tab}`) {
        throw new Error(`Tab ${tab} activation failed: ${JSON.stringify(state)}`);
      }
    }
    passed.push('tabs');

    // ── Files tab: refresh, auth button states, empty-selection guard ──
    await cdp.evaluate(`document.getElementById('tabFiles').click()`);
    await cdp.evaluate(`document.getElementById('refreshBtn').click()`);
    await waitFor('remote file list to render', () => cdp.evaluate(
      `document.querySelectorAll('#fileList .file-row').length`
    ), 60_000);
    const buttonStates = await cdp.evaluate(`({
      login: document.getElementById('loginBtn').disabled,
      logout: document.getElementById('logoutBtn').disabled,
      upload: document.getElementById('uploadBtn').disabled,
      chooseFolder: document.getElementById('chooseFolderBtn').disabled,
      refresh: document.getElementById('refreshBtn').disabled
    })`);
    if (!buttonStates.login || buttonStates.logout || buttonStates.upload || buttonStates.chooseFolder) {
      throw new Error(`Unexpected auth button states: ${JSON.stringify(buttonStates)}`);
    }
    // Clear the default folder selection through the UI, then prove the
    // empty-selection guard on Download selected.
    await cdp.evaluate(`(() => {
      for (const box of document.querySelectorAll('#fileList input[type=checkbox]')) {
        if (box.checked) box.click();
      }
      document.getElementById('downloadSelectedBtn').click();
    })()`);
    const emptyGuard = await cdp.evaluate(`document.getElementById('logOutput').textContent.includes('Nothing selected.')`);
    if (!emptyGuard) throw new Error('Download selected did not warn on empty selection');
    await cdp.evaluate(`(() => {
      document.getElementById('clearLogBtn').click();
      return document.getElementById('logOutput').textContent;
    })()`).then(text => {
      if (text !== '') throw new Error('Clear log did not empty the log');
    });
    passed.push('files');

    // ── Queue tab: pause / resume / cancel-all round trip ──
    await cdp.evaluate(`document.getElementById('tabQueue').click()`);
    await cdp.evaluate(`document.getElementById('queuePauseBtn').click()`);
    await waitFor('queue paused', () => cdp.evaluate(`window.auxProtonDriveBridge.transfer.getState().then(s => s.isPaused === true)`), 10_000, 250);
    await cdp.evaluate(`document.getElementById('queueResumeBtn').click()`);
    await waitFor('queue resumed', () => cdp.evaluate(`window.auxProtonDriveBridge.transfer.getState().then(s => s.isPaused === false)`), 10_000, 250);
    await cdp.evaluate(`document.getElementById('queueCancelAllBtn').click()`);
    passed.push('queue');

    // ── Conflicts tab: refresh renders stats with no open conflicts ──
    await cdp.evaluate(`document.getElementById('tabConflicts').click()`);
    await cdp.evaluate(`document.getElementById('conflictRefreshBtn').click()`);
    await waitFor('conflict stats to render', () => cdp.evaluate(
      `document.getElementById('conflictStats').textContent.length > 0`
    ), 15_000, 250);
    passed.push('conflicts');

    // ── Updates tab: live release check against GitHub ──
    await cdp.evaluate(`document.getElementById('tabUpdates').click()`);
    await cdp.evaluate(`document.getElementById('updateCheckBtn').click()`);
    await waitFor('update check result', () => cdp.evaluate(`(() => {
      const latest = document.getElementById('updateLatestVersion').textContent.trim();
      return latest.length > 0 && latest !== '—';
    })()`), 60_000);
    const updateInfo = await cdp.evaluate(`({
      current: document.getElementById('updateCurrentVersion').textContent.trim(),
      latest: document.getElementById('updateLatestVersion').textContent.trim()
    })`);
    if (!updateInfo.current.includes(expectedVersion)) {
      throw new Error(`Updates tab shows wrong current version: ${JSON.stringify(updateInfo)}`);
    }
    passed.push('updates');

    // ── Sync tab: fence off real inventory via selective sync UI ──
    await cdp.evaluate(`document.getElementById('tabSync').click()`);
    await cdp.evaluate(`(() => {
      document.getElementById('ignorePatternsInput').value = ${JSON.stringify(fencePatterns.join('\n'))};
      document.getElementById('saveIgnorePatternsBtn').click();
    })()`);
    await waitFor('ignore patterns active', () => cdp.evaluate(
      `document.getElementById('ignorePatternsStatus').textContent.includes('${fencePatterns.length} patterns active')`
    ), 10_000, 250);
    passed.push('selective-sync-ui');

    const startSync = async (mode) => {
      // A start right after a stop can be rejected while the engine is still
      // tearing down (the UI logs the error); retry the click until it takes.
      for (let attempt = 1; ; attempt++) {
        await cdp.evaluate(`(() => {
          document.getElementById('syncModeSelect').value = ${JSON.stringify(mode)};
          document.getElementById('syncStartBtn').click();
        })()`);
        try {
          await waitFor(`sync running in ${mode}`, () => cdp.evaluate(
            `window.auxProtonDriveBridge.syncEngine.getState().then(s => s.engineActive === true && s.mode === ${JSON.stringify(mode)})`
          ), 5_000, 250);
          return;
        } catch (error) {
          if (attempt >= 6) throw error;
        }
      }
    };
    const scanNow = async () => {
      await cdp.evaluate(`document.getElementById('syncScanNowBtn').click()`);
    };
    const stopSync = async () => {
      await cdp.evaluate(`document.getElementById('syncStopBtn').click()`);
      await waitFor('sync stopped', () => cdp.evaluate(
        `window.auxProtonDriveBridge.syncEngine.getState().then(s => s.engineActive === false)`
      ), 15_000, 250);
    };

    // Direction local → remote: one-way upload, with an ignored file that must stay local.
    fs.writeFileSync(path.join(walkFolder, upName), `up ${runId}\n${crypto.randomBytes(16).toString('hex')}\n`);
    fs.writeFileSync(path.join(walkFolder, ignoredName), 'must never reach the remote');
    await startSync('one-way-upload');
    anyUploaded = true;
    await scanNow();
    await waitFor(`${upName} on remote`, () => remoteExistsTolerant('/my-files', upName), 180_000, 2000);
    if (remoteExistsTolerant('/my-files', ignoredName)) throw new Error('Selective sync uploaded an excluded file');
    await stopSync();
    passed.push('sync-one-way-upload');

    // Direction local → remote: conservative mode.
    fs.writeFileSync(path.join(walkFolder, consName), `cons ${runId}\n`);
    await startSync('conservative');
    await scanNow();
    await waitFor(`${consName} on remote`, () => remoteExistsTolerant('/my-files', consName), 180_000, 2000);
    await stopSync();
    passed.push('sync-conservative');

    // Direction remote → local: seed a remote-only file through the transfer
    // queue (second app instance), then one-way download must fetch it.
    // Seed file must live under the home directory: the app's path capability
    // guard rejects uploads from anywhere else.
    const seedDir = fs.mkdtempSync(path.join(os.homedir(), '.aux-proton-ui-walk-seed-'));
    const biSource = path.join(seedDir, biName);
    const biContent = `bi ${runId}\n${crypto.randomBytes(16).toString('hex')}\n`;
    fs.writeFileSync(biSource, biContent);
    await runSecondInstance(['--upload', '--path', biSource]);
    await waitFor('seeded upload to finish', () => cdp.evaluate(
      `window.auxProtonDriveBridge.transfer.getState().then(s => s.active.length === 0 && s.pending.length === 0)`
    ), 180_000, 1000);
    await waitFor(`${biName} on remote`, () => remoteExistsTolerant('/my-files', biName), 60_000, 2000);
    fs.rmSync(seedDir, { recursive: true, force: true });
    await startSync('one-way-download');
    await scanNow();
    await waitFor(`${biName} downloaded locally`, () => {
      const local = path.join(walkFolder, biName);
      return fs.statSync(local, { throwIfNoEntry: false })?.isFile() && fs.readFileSync(local, 'utf8') === biContent;
    }, 180_000, 2000);
    await stopSync();
    passed.push('sync-one-way-download');

    // Both directions at once: modify the uploaded file locally and confirm
    // bidirectional sync pushes it back up while nothing spurious happens.
    fs.writeFileSync(path.join(walkFolder, upName), `up-modified ${runId}\n${crypto.randomBytes(16).toString('hex')}\n`);
    await startSync('bidirectional');
    await scanNow();
    await waitFor('bidirectional cycle to settle', () => cdp.evaluate(`(async () => {
      const api = window.auxProtonDriveBridge;
      const counts = await api.sync.countByState();
      const state = await api.transfer.getState();
      const pendingStates = ['local_new', 'local_modified', 'pending_upload', 'remote_new', 'remote_modified', 'pending_download'];
      const pending = pendingStates.reduce((sum, key) => sum + Number(counts[key] || 0), 0);
      return pending === 0 && state.active.length === 0 && state.pending.length === 0;
    })()`), 240_000, 2000);
    const conflictCount = await cdp.evaluate(`window.auxProtonDriveBridge.conflict.getStats().then(s => Number(s.open || 0)).catch(() => 0)`);
    if (conflictCount > 0) throw new Error(`Bidirectional sync produced ${conflictCount} conflict(s)`);
    await stopSync();
    passed.push('sync-bidirectional');

    // ── Sync dashboard refresh + history clear still behave ──
    await cdp.evaluate(`document.getElementById('syncRefreshBtn').click()`);
    await waitFor('sync dashboard totals', () => cdp.evaluate(
      `document.getElementById('syncTotal').textContent.trim().length > 0`
    ), 10_000, 250);
    await cdp.evaluate(`document.getElementById('clearHistoryBtn').click()`);
    passed.push('dashboard-history');

    if (cdp.errors.length) throw new Error(`Renderer errors: ${cdp.errors.join(' | ')}`);
    await cleanupDisposableRemote();
    anyUploaded = false;
    walkCompleted = true;
    console.log(JSON.stringify({ ok: true, version: boot.version, passed, productionItemsTouched: 0 }));
  } finally {
    cdp?.close();
    // Graceful first: SIGTERM to the main process only. Tree-wide TERM kills
    // renderers out from under Chromium and manufactures SIGTRAP core dumps.
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    const gracefulExit = await Promise.race([
      new Promise(resolve => child.once('close', () => resolve(true))),
      new Promise(resolve => setTimeout(() => resolve(false), 30_000))
    ]);
    if (!gracefulExit) killTree('SIGKILL');
    try {
      if (anyUploaded) await cleanupDisposableRemote();
    } catch (error) { console.error(`WARNING: ${error.message}`); }
    fs.rmSync(walkFolder, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    // Only assert graceful shutdown when the walk itself succeeded; throwing
    // here while a walk error is propagating would mask the real failure.
    if (!gracefulExit && walkCompleted) throw new Error('App did not exit within 30s of SIGTERM (graceful shutdown regression)');
    if (!gracefulExit) console.error('WARNING: app did not exit within 30s of SIGTERM');
  }
})().then(() => process.exit(0)).catch(error => {
  console.error(error.stack || error.message);
  console.error(processOutput.slice(-2000));
  killTree('SIGKILL');
  process.exit(1);
});
