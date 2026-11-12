const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { parseExternalCommand } = require('../src/main/externalCommand');

const installer = path.join(__dirname, '..', 'scripts', 'install-file-manager-integration.sh');

// Splits the Exec line of a desktop entry and expands the file field codes the way the
// Desktop Entry Specification describes (quoted arguments, \\ \" \` \$ escapes inside
// quotes, %F = every file as its own argument, %f = one file, %% = a percent sign).
function execArgv(execLine, files) {
  const tokens = [];
  let current = null;
  let quoted = false;
  for (let i = 0; i < execLine.length; i++) {
    const c = execLine[i];
    if (quoted) {
      if (c === '\\' && '"`$\\'.includes(execLine[i + 1])) { current += execLine[++i]; continue; }
      if (c === '"') { quoted = false; continue; }
      current += c;
    } else if (c === '"') {
      quoted = true;
      current = current ?? '';
    } else if (c === ' ') {
      if (current !== null) tokens.push(current);
      current = null;
    } else {
      current = (current ?? '') + c;
    }
  }
  if (current !== null) tokens.push(current);
  const argv = [];
  for (const token of tokens) {
    if (token === '%F') argv.push(...files);
    else if (token === '%f') argv.push(files[0]);
    else argv.push(token.replace(/%%/g, '%'));
  }
  return argv;
}

describe('file manager integration', () => {
  let root;
  let home;
  let recorder;
  let recordDir;
  let selection;
  const names = [
    'plain.txt',
    'with space.txt',
    'it\'s "quoted".txt',
    'new\nline.txt',
    '$(touch pwned).txt',
    '`id`.txt',
    '-leading-dash.txt',
    'back\\slash.txt',
    'percent %F %f %%.txt',
    'semi;colon & amp | pipe.txt',
    'ünïcödé 文件.txt'
  ];

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-integration-'));
    home = path.join(root, 'home dir');
    fs.mkdirSync(home);
    recordDir = path.join(root, 'calls');
    fs.mkdirSync(recordDir);
    // Stands in for the installed app: records its exact argument list, NUL separated.
    recorder = path.join(root, 'fake-app');
    fs.writeFileSync(recorder, `#!/bin/sh\nn=$(ls "${recordDir}" | wc -l)\nprintf '%s\\0' "$@" > "${recordDir}/call-$n"\n`, { mode: 0o755 });
    const filesDir = path.join(root, 'selected folder');
    fs.mkdirSync(filesDir);
    selection = names.map(name => path.join(filesDir, name));
    for (const file of selection) fs.writeFileSync(file, 'x');
    const result = spawnSync('bash', [installer], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'share'), BIN_PATH: recorder },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const desktopFile = name => fs.readFileSync(path.join(home, 'share', name), 'utf8');
  const execLine = text => text.split('\n').find(line => line.startsWith('Exec=')).slice('Exec='.length);
  const calls = () => fs.readdirSync(recordDir).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
    .map(file => fs.readFileSync(path.join(recordDir, file), 'utf8').split('\0').slice(0, -1));
  const reset = () => { for (const file of fs.readdirSync(recordDir)) fs.rmSync(path.join(recordDir, file)); };
  // The app sees its own executable first, as process.argv does.
  const asProcessArgv = args => ['/opt/electron/aux-proton-drive-bridge', ...args];

  it('Thunar: one launch carries every selected file and the app uploads all of them, in order', () => {
    reset();
    const argv = execArgv(execLine(desktopFile('Thunar/sendto/aux-proton-drive-bridge.desktop')), selection);
    execFileSync(argv[0], argv.slice(1));
    const recorded = calls();
    assert.equal(recorded.length, 1, 'Thunar starts the program once for the whole selection');
    const command = parseExternalCommand(asProcessArgv(recorded[0]));
    assert.equal(command.action, 'upload');
    assert.deepEqual(command.localPaths, selection);
  });

  it('Thunar: a single selected file still works', () => {
    reset();
    const argv = execArgv(execLine(desktopFile('Thunar/sendto/aux-proton-drive-bridge.desktop')), [selection[3]]);
    execFileSync(argv[0], argv.slice(1));
    assert.deepEqual(parseExternalCommand(asProcessArgv(calls()[0])).localPaths, [selection[3]]);
  });

  it('keeps working for the Thunar entry that older versions installed (--path before the first file only)', () => {
    const command = parseExternalCommand(asProcessArgv(['--upload', '--path', ...selection]));
    assert.deepEqual(command.localPaths, selection);
  });

  it('Dolphin: every file is uploaded, one launch per file, names unchanged', () => {
    reset();
    for (const file of selection) {
      const argv = execArgv(execLine(desktopFile('kio/servicemenus/aux-proton-drive-bridge.desktop')), [file]);
      execFileSync(argv[0], argv.slice(1));
    }
    const uploaded = calls().flatMap(args => parseExternalCommand(asProcessArgv(args)).localPaths);
    assert.deepEqual(uploaded, selection);
  });

  it('Nautilus: every selected file is uploaded, names unchanged', () => {
    reset();
    const script = path.join(home, 'share', 'nautilus', 'scripts', 'Aux Proton Drive Bridge', 'Upload to Proton Drive');
    // The script calls $HOME/.local/bin/aux-proton-drive-bridge, which the installer linked to the stand-in.
    execFileSync(script, selection, { env: { ...process.env, HOME: home } });
    const uploaded = calls().flatMap(args => parseExternalCommand(asProcessArgv(args)).localPaths);
    assert.deepEqual(uploaded, selection);
  });
});

describe('externalCommand - command line parsing', () => {
  it('collects repeated --path values wherever they are', () => {
    assert.deepEqual(parseExternalCommand(['app', '--upload', '--path', '/a b', '--path', '/c']).localPaths, ['/a b', '/c']);
  });

  it('collects absolute paths after --upload, mixed with --path', () => {
    assert.deepEqual(parseExternalCommand(['/usr/bin/app', '--upload', '/a', '--path', '/b', '/c']).localPaths, ['/a', '/b', '/c']);
  });

  it('does not take the executable path in front of --upload for a file', () => {
    assert.deepEqual(parseExternalCommand(['/usr/bin/app', '--no-sandbox', '--upload', '/a']).localPaths, ['/a']);
  });

  it('takes a --path value that starts with a dash and ignores unrelated flags after it', () => {
    assert.deepEqual(parseExternalCommand(['app', '--upload', '--path', '--odd', '--no-sandbox']).localPaths, ['--odd']);
  });

  it('refuses a relative bare argument instead of silently dropping the file', () => {
    assert.throws(() => parseExternalCommand(['app', '--upload', '/a', 'relative.txt']), /does not understand/);
  });

  it('still requires at least one file', () => {
    assert.throws(() => parseExternalCommand(['app', '--upload']), /at least one/);
    assert.throws(() => parseExternalCommand(['app', '--upload', '--path']), /at least one/);
  });

  it('parses the other commands as before', () => {
    assert.deepEqual(parseExternalCommand(['app', '--install-file-manager-integration']), { action: 'install-file-manager-integration' });
    assert.deepEqual(parseExternalCommand(['app', '--download-here', '/x y']), { action: 'open-download-folder', localFolder: '/x y' });
    assert.equal(parseExternalCommand(['app']), null);
    assert.throws(() => parseExternalCommand(['app', '--download-here']), /folder path/);
  });
});

describe('upload selection - one unusable item does not stop the others', () => {
  const { partitionUploadPaths, summariseRefused, runUploadCommand, displayName } = require('../src/main/uploadSelection');
  let root;
  let home;
  let outside;
  let sel;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-select-'));
    home = path.join(root, 'home');
    outside = path.join(root, 'elsewhere');
    fs.mkdirSync(home);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(home, 'first good.txt'), 'x');
    fs.writeFileSync(path.join(home, 'last-good.txt'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(home, 'nas-link.txt'));
    fs.symlinkSync(path.join(home, 'no-such-target'), path.join(home, 'broken-link.txt'));
    sel = {
      good1: path.join(home, 'first good.txt'),
      outsideLink: path.join(home, 'nas-link.txt'),
      missing: path.join(home, 'deleted after selecting.txt'),
      good2: path.join(home, 'last-good.txt'),
      brokenLink: path.join(home, 'broken-link.txt'),
      outsideFile: path.join(outside, 'secret.txt')
    };
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function fakes() {
    const granted = [];
    const enqueued = [];
    const reports = [];
    return {
      granted, enqueued, reports,
      deps: {
        home,
        grant: p => granted.push(p),
        enqueue: paths => { enqueued.push([...paths]); return { ok: true, queued: true, transferId: 't1' }; },
        report: (refused, options) => reports.push({ refused, options })
      }
    };
  }

  it('partitions good from refused, keeps order, names refused items by base name only', () => {
    const { good, refused } = partitionUploadPaths([sel.good1, sel.outsideLink, sel.missing, sel.good2], { home });
    assert.deepEqual(good, [sel.good1, sel.good2]);
    assert.deepEqual(refused.map(item => item.name), ['nas-link.txt', 'deleted after selecting.txt']);
    assert.match(refused[0].reason, /outside your home folder/);
    assert.equal(refused[1].reason, 'does not exist');
    const text = summariseRefused(refused);
    assert.ok(!text.includes('first good'), text);
    assert.ok(!text.includes('last-good'), text);
    assert.ok(!text.includes(root), 'no directory names, only the item base name');
  });

  it('uploads the two good files in one transfer, grants only them and reports the two bad ones', async () => {
    const f = fakes();
    const result = await runUploadCommand([sel.good1, sel.outsideLink, sel.missing, sel.good2], f.deps);
    assert.deepEqual(f.enqueued, [[sel.good1, sel.good2]]);
    assert.deepEqual(f.granted, [sel.good1, sel.good2]);
    assert.equal(f.reports.length, 1);
    assert.deepEqual(f.reports[0].refused.map(item => item.name), ['nas-link.txt', 'deleted after selecting.txt']);
    assert.equal(f.reports[0].options.announce, true);
    const reported = JSON.stringify(f.reports[0].refused);
    assert.ok(!reported.includes('first good') && !reported.includes('last-good'), reported);
    assert.equal(result.uploaded, 2);
    assert.equal(result.refused, 2);
  });

  it('refuses a file outside the home folder and a broken link without touching the good one', async () => {
    const f = fakes();
    await runUploadCommand([sel.outsideFile, sel.good1, sel.brokenLink], f.deps);
    assert.deepEqual(f.enqueued, [[sel.good1]]);
    assert.deepEqual(f.granted, [sel.good1]);
    assert.deepEqual(f.reports[0].refused.map(item => item.name), ['secret.txt', 'broken-link.txt']);
  });

  it('a clean selection uploads everything and reports nothing', async () => {
    const f = fakes();
    await runUploadCommand([sel.good1, sel.good2], f.deps);
    assert.deepEqual(f.enqueued, [[sel.good1, sel.good2]]);
    assert.equal(f.reports.length, 0);
  });

  it('keeps an error when every item is refused, naming them, granting and queueing nothing', async () => {
    const f = fakes();
    await assert.rejects(runUploadCommand([sel.outsideLink, sel.missing], f.deps), error => {
      assert.match(error.message, /Nothing was uploaded/);
      assert.match(error.message, /nas-link\.txt/);
      assert.match(error.message, /deleted after selecting\.txt/);
      return true;
    });
    assert.deepEqual(f.granted, []);
    assert.deepEqual(f.enqueued, []);
    assert.equal(f.reports.length, 1);
    assert.equal(f.reports[0].options.announce, false, 'the thrown error is the visible message');
  });

  it('never grants a refused path, even when it comes first', async () => {
    const f = fakes();
    await runUploadCommand([sel.outsideLink, sel.good2], f.deps);
    assert.ok(!f.granted.includes(sel.outsideLink));
    assert.deepEqual(f.granted, [sel.good2]);
  });

  it('refuses more than 1000 files and says the limit', async () => {
    const f = fakes();
    const many = Array.from({ length: 1001 }, (_, i) => path.join(home, `f${i}`));
    await assert.rejects(runUploadCommand(many, f.deps), /limited to 1000 files per upload/);
    assert.deepEqual(f.enqueued, []);
    assert.deepEqual(f.granted, []);
  });

  it('shows hostile file names as one harmless line of text', () => {
    assert.equal(displayName('/h/evil\nname\u202e.txt'), 'evil?name?.txt');
    assert.equal(displayName(`/h/${'a'.repeat(200)}`).length, 80);
  });
});

describe('upload selection - wiring in main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf('async function handleExternalCommand'), main.indexOf('// ── Lazy initializers'));

  it('the external upload command goes through runUploadCommand, not a grant loop over every path', () => {
    assert.match(handler, /runUploadCommand\(command\.localPaths/);
    assert.ok(!/for \(const localPath of command\.localPaths\)/.test(handler), 'a loop that grants every path first stops the whole upload on one bad item');
  });

  it('the file pickers check each chosen path on its own', () => {
    assert.match(main, /grantPickedPaths\(result\.filePaths, 'Selected upload path'\)/);
    assert.match(main, /grantPickedPaths\(result\.filePaths, 'Selected backup path'\)/);
    assert.ok(!/result\.filePaths\.map\(localPath => grantLocalPath/.test(main));
  });
});
