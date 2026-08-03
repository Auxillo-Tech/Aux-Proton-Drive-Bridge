const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-smoke-'));
const smokeUserData = path.join(smokeRoot, 'user-data');
const smokeHome = path.join(smokeRoot, 'home');
const smokeConfig = path.join(smokeRoot, 'config');
const smokeCache = path.join(smokeRoot, 'cache');
const smokeData = path.join(smokeRoot, 'data');
for (const directory of [smokeUserData, smokeHome, smokeConfig, smokeCache, smokeData]) {
  fs.mkdirSync(directory, { recursive: true });
}
const fakeProton = path.join(smokeRoot, 'proton-drive-smoke');
fs.writeFileSync(fakeProton, `#!/usr/bin/env node
const leaked = Object.keys(process.env).filter(key => key !== 'XAUTHORITY' && /(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL|AUTH)/i.test(key));
if (leaked.length) { console.error('smoke credential leak: ' + leaked.join(',')); process.exit(42); }
if (process.argv[2] === 'version') { console.log('proton-drive smoke'); process.exit(0); }
console.error('not logged in');
process.exit(1);
`, { mode: 0o700 });
const env = {
  ...process.env,
  HOME: smokeHome,
  XDG_CONFIG_HOME: smokeConfig,
  XDG_CACHE_HOME: smokeCache,
  XDG_DATA_HOME: smokeData,
  ELECTRON_ENABLE_LOGGING: '1',
  AUX_PROTON_DRIVE_USER_DATA_DIR: smokeUserData
};
for (const key of Object.keys(env)) {
  if (key !== 'XAUTHORITY' && /(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL|AUTH)/i.test(key)) delete env[key];
}
env.PROTON_DRIVE_BIN = fakeProton;
const executable = process.env.SMOKE_EXECUTABLE || path.join(root, 'node_modules', '.bin', 'electron');
const debugArgs = ['--remote-debugging-port=9339', '--remote-allow-origins=http://127.0.0.1:9339'];
const extraArgs = process.env.SMOKE_EXTRA_ARGS ? JSON.parse(process.env.SMOKE_EXTRA_ARGS) : [];
if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== 'string')) throw new Error('SMOKE_EXTRA_ARGS must be a JSON string array');
const args = process.env.SMOKE_EXECUTABLE ? [...debugArgs, ...extraArgs] : ['.', ...debugArgs, ...extraArgs];
const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    http.get({ host: '127.0.0.1', port: 9339, path: pathname }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}
(async () => {
  try {
    let page = null;
    for (let i = 0; i < 80; i++) {
      try {
        const pages = await getJson('/json');
        page = pages.find(p => p.type === 'page' && String(p.title).includes('Aux Proton Drive Bridge')) || pages.find(p => p.type === 'page') || pages[0] || null;
        if (page && String(page.title).includes('Aux Proton Drive Bridge')) break;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!page) throw new Error('CDP page did not appear: ' + output.slice(-1000));
    if (!String(page.title).includes('Aux Proton Drive Bridge')) throw new Error(`Unexpected title: ${page.title}; url=${page.url}; logs=${output.slice(-1000)}`);
    console.log(`${process.env.SMOKE_EXECUTABLE ? 'installed package' : 'source'} smoke passed:`, page.title);
  } finally {
    killTree(child.pid, 'SIGTERM');
    const killer = setTimeout(() => killTree(child.pid, 'SIGKILL'), 1000);
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 2200))
    ]);
    clearTimeout(killer);
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
})().then(() => process.exit(0)).catch(err => { console.error(err); killTree(child.pid, 'SIGKILL'); process.exit(1); });
