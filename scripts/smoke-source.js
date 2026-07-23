const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), ['.', '--remote-debugging-port=9339', '--remote-allow-origins=http://127.0.0.1:9339'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', d => output += d);
child.stderr.on('data', d => output += d);
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
        page = pages.find(p => p.type === 'page' && String(p.title).includes('Aux Proton Bridge')) || pages.find(p => p.type === 'page') || pages[0] || null;
        if (page && String(page.title).includes('Aux Proton Bridge')) break;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!page) throw new Error('CDP page did not appear: ' + output.slice(-1000));
    if (!String(page.title).includes('Aux Proton Bridge')) throw new Error(`Unexpected title: ${page.title}; url=${page.url}; logs=${output.slice(-1000)}`);
    console.log('source smoke passed:', page.title);
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1000).unref();
  }
})().catch(err => { console.error(err); child.kill('SIGKILL'); process.exit(1); });
