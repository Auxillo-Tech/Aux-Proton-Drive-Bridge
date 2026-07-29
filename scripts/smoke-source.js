const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.join(__dirname, '..');
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
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
  }
})().then(() => process.exit(0)).catch(err => { console.error(err); killTree(child.pid, 'SIGKILL'); process.exit(1); });
