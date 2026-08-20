const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require(path.join(root, 'package.json')).version;
const appImage = fs.readdirSync(dist).find(name => name === `Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage`);
if (!appImage) throw new Error(`No AppImage for version ${version} found in dist/`);
const appPath = path.join(dist, appImage);
fs.chmodSync(appPath, 0o755);
const env = {
  ...process.env,
  APPIMAGE_EXTRACT_AND_RUN: '1',
  ELECTRON_ENABLE_LOGGING: '1',
  XDG_CONFIG_HOME: path.join(root, '.cache', 'smoke-config'),
  XDG_CACHE_HOME: path.join(root, '.cache', 'smoke-cache'),
  XDG_DATA_HOME: path.join(root, '.cache', 'smoke-data')
};
const child = spawn(appPath, ['--remote-debugging-port=9340', '--remote-allow-origins=http://127.0.0.1:9340'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', d => output += d);
child.stderr.on('data', d => output += d);

function descendantPids(pid) {
  const out = childProcess.spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  const direct = out.status === 0 ? out.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : [];
  return direct.flatMap(child => [child, ...descendantPids(child)]);
}
function killTree(pid, signal) {
  for (const childPid of descendantPids(pid).reverse()) {
    try { process.kill(childPid, signal); } catch {}
  }
  try { process.kill(pid, signal); } catch {}
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9340, path: pathname }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}
(async () => {
  try {
    let page = null;
    for (let i = 0; i < 100; i++) {
      try {
        const pages = await getJson('/json');
        page = pages.find(p => p.type === 'page' && String(p.title).includes('Aux Proton Drive Bridge')) || pages.find(p => p.type === 'page') || pages[0] || null;
        if (page && String(page.title).includes('Aux Proton Drive Bridge')) break;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!page) throw new Error('CDP page did not appear: ' + output.slice(-2000));
    if (!String(page.title).includes('Aux Proton Drive Bridge')) throw new Error(`Unexpected title: ${page.title}; logs=${output.slice(-2000)}`);
    console.log('packaged AppImage smoke passed:', appImage, page.title);
  } finally {
    // Graceful first. Under APPIMAGE_EXTRACT_AND_RUN the wrapper process does
    // not forward signals, so aim SIGTERM at the extracted Electron main
    // process (the descendant without a --type= child-process flag) instead.
    // Signalling the whole tree kills renderers out from under Chromium and
    // manufactures SIGTRAP core dumps.
    const mainPid = descendantPids(child.pid).find(pid => {
      try { return !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type='); } catch { return false; }
    }) ?? child.pid;
    try { process.kill(mainPid, 'SIGTERM'); } catch {}
    const exited = await Promise.race([
      new Promise(resolve => child.once('close', () => resolve(true))),
      new Promise(resolve => setTimeout(() => resolve(false), 30_000))
    ]);
    if (!exited) {
      killTree(child.pid, 'SIGKILL');
      throw new Error('App did not exit within 30s of SIGTERM (graceful shutdown regression)');
    }
  }
})().then(() => process.exit(0)).catch(err => { console.error(err); killTree(child.pid, 'SIGKILL'); process.exit(1); });
