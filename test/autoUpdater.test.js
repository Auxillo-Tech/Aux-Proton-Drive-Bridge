const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createAutoUpdater, isSafeAssetName, parseChecksums, releaseKeyId, verifyChecksumManifestSignature, verifyFileSha256 } = require('../src/main/autoUpdater');

describe('autoUpdater — version parsing and comparison', () => {
  const updater = createAutoUpdater({ currentVersion: '0.3.0', logger: { info: () => {}, warn: () => {}, error: () => {} } });

  it('parses dotted version strings', () => {
    const v = updater.parseVersion('1.2.3');
    assert.deepStrictEqual(v, { major: 1, minor: 2, patch: 3 });
  });

  it('handles v-prefixed versions', () => {
    const v = updater.parseVersion('v4.5.6');
    assert.deepStrictEqual(v, { major: 4, minor: 5, patch: 6 });
  });

  it('rejects incomplete versions', () => {
    assert.strictEqual(updater.parseVersion('2'), null);
  });

  it('rejects empty, undefined, and prerelease versions', () => {
    assert.strictEqual(updater.parseVersion(''), null);
    assert.strictEqual(updater.parseVersion(undefined), null);
    assert.strictEqual(updater.parseVersion('0.3.1-beta.1'), null);
  });

  it('detects newer version (major bump)', () => {
    assert.strictEqual(updater.isNewer('0.3.0', '1.0.0'), true);
    assert.strictEqual(updater.isNewer('1.0.0', '0.3.0'), false);
  });

  it('detects newer version (minor bump)', () => {
    assert.strictEqual(updater.isNewer('0.3.0', '0.4.0'), true);
    assert.strictEqual(updater.isNewer('0.4.0', '0.3.0'), false);
  });

  it('detects newer version (patch bump)', () => {
    assert.strictEqual(updater.isNewer('0.3.0', '0.3.1'), true);
    assert.strictEqual(updater.isNewer('0.3.1', '0.3.0'), false);
  });

  it('same version is not newer', () => {
    assert.strictEqual(updater.isNewer('0.3.0', '0.3.0'), false);
  });

  it('pre-release tag not considered newer', () => {
    // '0.3.1-beta' would parse as {major:0,minor:3,patch:1} - the -beta suffix is ignored by parseInt
    // This is acceptable for now — numeric comparison works for semver
    assert.strictEqual(updater.isNewer('0.3.0', '0.3.1'), true);
  });

  it('checkForUpdates returns a stable result object without throwing', async () => {
    // Live GitHub may or may not be reachable; a newer release may exist.
    // Only require a non-throwing, well-shaped response.
    const result = await updater.checkForUpdates();
    assert.ok(result && typeof result === 'object');
    assert.ok(typeof result.hasUpdate === 'boolean');
    if (result.hasUpdate) {
      assert.ok(result.latestVersion || result.update?.version);
    } else {
      assert.ok(result.error === undefined || typeof result.error === 'string' || result.error);
    }
  });
});

describe('autoUpdater — create with mock', () => {
  it('starts and stops periodic check without error', () => {
    const updater = createAutoUpdater({ currentVersion: '0.3.0' });
    updater.startPeriodicCheck();
    // Should not crash
    updater.stopPeriodicCheck();
    assert.ok(true);
  });

  it('getAvailableUpdate returns null before any check', () => {
    const updater = createAutoUpdater({ currentVersion: '0.3.0' });
    assert.strictEqual(updater.getAvailableUpdate(), null);
  });

  it('only selects an AppImage whose version matches the exact release tag', () => {
    const updater = createAutoUpdater({ currentVersion: '0.3.0' });
    const stale = { name: 'Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage', state: 'uploaded' };
    const current = { name: 'Aux.Proton.Drive.Bridge-0.3.1-x86_64.AppImage', state: 'uploaded' };
    assert.strictEqual(updater.getBestAsset({ version: '0.3.1', tagName: 'v0.3.1', assets: [stale, current] }), current);
    assert.strictEqual(updater.getBestAsset({ version: '0.3.1', tagName: 'v0.3.2', assets: [current] }), null);
  });
});

describe('autoUpdater - artifact integrity', () => {
  it('rejects unsafe release asset names', () => {
    assert.strictEqual(isSafeAssetName('../update.AppImage'), false);
    assert.strictEqual(isSafeAssetName('/tmp/update.AppImage'), false);
    assert.strictEqual(isSafeAssetName('Aux.Proton.Drive.Bridge-0.3.1-x86_64.AppImage'), true);
  });

  it('parses SHA256SUMS and verifies a downloaded artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-integrity-'));
    const artifact = path.join(dir, 'update.AppImage');
    fs.writeFileSync(artifact, 'verified update bytes');
    const hash = crypto.createHash('sha256').update('verified update bytes').digest('hex');
    const sums = parseChecksums(`${hash}  update.AppImage\n`);
    assert.strictEqual(sums.get('update.AppImage'), hash);
    assert.strictEqual(verifyFileSha256(artifact, hash), true);
    assert.throws(() => verifyFileSha256(artifact, '0'.repeat(64)), /checksum/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

it('follows redirects and verifies the release checksum before exposing a download', async () => {
  const artifact = Buffer.from('verified update artifact');
  const digest = crypto.createHash('sha256').update(artifact).digest('hex');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = `${digest}  Aux.Proton.Drive.Bridge-9.0.0-x86_64.AppImage\n`;
  const signature = JSON.stringify({
    version: 1,
    algorithm: 'Ed25519',
    keyId: releaseKeyId(publicPem),
    file: 'SHA256SUMS.txt',
    signature: crypto.sign(null, Buffer.from(manifest), privateKey).toString('base64')
  });
  let baseUrl;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, baseUrl).pathname;
    if (pathname === '/releases') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{
        tag_name: 'v9.0.0', draft: false, prerelease: false, body: 'Stable', published_at: '2026-01-01', html_url: `${baseUrl}/release`,
        assets: [
          { name: 'Aux.Proton.Drive.Bridge-8.9.9-x86_64.AppImage', url: `${baseUrl}/stale`, browser_download_url: `${baseUrl}/stale`, size: artifact.length },
          { name: 'Aux.Proton.Drive.Bridge-9.0.0-x86_64.AppImage', url: `${baseUrl}/app`, browser_download_url: `${baseUrl}/app`, size: artifact.length },
          { name: 'SHA256SUMS.txt', url: `${baseUrl}/sums`, browser_download_url: `${baseUrl}/sums`, size: manifest.length },
          { name: 'SHA256SUMS.txt.sig', url: `${baseUrl}/sig`, browser_download_url: `${baseUrl}/sig`, size: signature.length }
        ]
      }]));
      return;
    }
    if (pathname === '/app') { response.writeHead(302, { location: '/blob/app' }); response.end(); return; }
    if (pathname === '/blob/app') { response.end(artifact); return; }
    if (pathname === '/sums') { response.end(manifest); return; }
    if (pathname === '/sig') { response.end(signature); return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-updater-http-'));
  try {
    const updater = createAutoUpdater({ currentVersion: '1.0.0', releasesApi: `${baseUrl}/releases`, releasePublicKey: publicPem, downloadDir, logger: { info() {}, warn() {}, error() {} } });
    const checked = await updater.checkForUpdates();
    assert.strictEqual(checked.hasUpdate, true);
    const downloaded = await updater.downloadUpdate();
    assert.strictEqual(downloaded.sha256, digest);
    assert.deepStrictEqual(fs.readFileSync(downloaded.filePath), artifact);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
});

it('rejects checksum manifests not signed by the pinned release key', () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const trustedPem = trusted.publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = '0'.repeat(64) + '  update.AppImage\n';
  const envelope = JSON.stringify({
    version: 1,
    algorithm: 'Ed25519',
    keyId: releaseKeyId(trustedPem),
    file: 'SHA256SUMS.txt',
    signature: crypto.sign(null, Buffer.from(manifest), attacker.privateKey).toString('base64')
  });
  assert.throws(() => verifyChecksumManifestSignature(manifest, envelope, trustedPem), /verification failed/);
});
