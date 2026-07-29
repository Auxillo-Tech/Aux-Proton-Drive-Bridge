/**
 * GitHub Releases updater with redirect-safe downloads and mandatory integrity checks.
 */
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app } = require('electron');

const GITHUB_OWNER = 'Auxillo-Tech';
const GITHUB_REPO = 'Aux-Proton-Drive-Bridge';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const DEFAULT_RELEASE_PUBLIC_KEY = path.join(__dirname, '..', '..', 'assets', 'release-public-key.pem');

function isSafeAssetName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    path.basename(name) === name && name !== '.' && name !== '..' && !name.includes('\0');
}

function parseChecksums(text) {
  const result = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && isSafeAssetName(match[2])) result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function verifyFileSha256(filePath, expectedHash) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(expectedHash || ''))) throw new Error('Invalid expected checksum');
  const actual = sha256File(filePath);
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'))) {
    throw new Error(`Update checksum mismatch: expected ${expectedHash}, received ${actual}`);
  }
  return true;
}

function releaseKeyId(publicKey) {
  const key = crypto.createPublicKey(publicKey);
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
}

function verifyChecksumManifestSignature(manifest, signatureEnvelope, publicKeyPem) {
  const publicKey = crypto.createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Release public key must be Ed25519');
  let envelope;
  try { envelope = JSON.parse(Buffer.isBuffer(signatureEnvelope) ? signatureEnvelope.toString('utf8') : String(signatureEnvelope)); }
  catch { throw new Error('Invalid release signature envelope'); }
  if (envelope.version !== 1 || envelope.algorithm !== 'Ed25519' || envelope.file !== 'SHA256SUMS.txt' || envelope.keyId !== releaseKeyId(publicKeyPem)) {
    throw new Error('Release signature metadata does not match the pinned key');
  }
  const signature = Buffer.from(String(envelope.signature || ''), 'base64');
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(manifest), publicKey, signature)) {
    throw new Error('Release checksum manifest signature verification failed');
  }
  return true;
}

function createAutoUpdater(options = {}) {
  const currentVersion = options.currentVersion || '0.0.0';
  const downloadDir = options.downloadDir || path.join(app?.getPath?.('userData') || process.cwd(), 'updates');
  const logger = options.logger || console;
  const releasesApi = options.releasesApi || RELEASES_API;
  const releasePublicKey = options.releasePublicKey || fs.readFileSync(DEFAULT_RELEASE_PUBLIC_KEY, 'utf8');
  const userAgent = `${GITHUB_REPO}/${currentVersion}`;
  let updateCheckTimer = null;
  let availableUpdate = null;
  let verifiedDownload = null;
  let cachedToken = null;
  let checksumCache = null;

  function getGitHubToken() {
    if (cachedToken) return cachedToken;
    if (process.env.GH_TOKEN) return (cachedToken = process.env.GH_TOKEN);
    if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN);
    try {
      const { execFileSync } = require('node:child_process');
      const token = execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (token) return (cachedToken = token);
    } catch {}
    return null;
  }

  function headersFor(url, accept = 'application/vnd.github+json') {
    const parsed = new URL(url);
    const headers = { 'User-Agent': userAgent, Accept: accept };
    const isGitHub = parsed.hostname === 'github.com' || parsed.hostname === 'api.github.com' || parsed.hostname.endsWith('.github.com');
    const token = isGitHub ? getGitHubToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function request(url, { accept, redirects = 0, timeout = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (redirects > MAX_REDIRECTS) return reject(new Error('Too many update download redirects'));
      const parsed = new URL(url);
      const transport = parsed.protocol === 'http:' ? http : parsed.protocol === 'https:' ? https : null;
      if (!transport) return reject(new Error(`Unsupported update URL protocol: ${parsed.protocol}`));
      const req = transport.get(parsed, { headers: headersFor(url, accept), timeout }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const redirect = new URL(res.headers.location, parsed);
          if (parsed.protocol === 'https:' && redirect.protocol !== 'https:') {
            reject(new Error('Refusing insecure HTTPS-to-HTTP update redirect'));
            return;
          }
          const nextUrl = redirect.toString();
          request(nextUrl, { accept, redirects: redirects + 1, timeout }).then(resolve, reject);
          return;
        }
        resolve({ res, url: parsed.toString() });
      });
      req.on('timeout', () => req.destroy(new Error('Update request timed out')));
      req.on('error', reject);
    });
  }

  async function requestBuffer(url, { accept, maxBytes = MAX_METADATA_BYTES } = {}) {
    const { res } = await request(url, { accept, timeout: 15_000 });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const chunks = [];
      let total = 0;
      for await (const chunk of res) {
        total += chunk.length;
        if (total > 8192) {
          res.destroy();
          break;
        }
        chunks.push(chunk);
      }
      throw new Error(`GitHub API ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res) {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        throw new Error('Update metadata response is too large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function requestJson(url) {
    const data = await requestBuffer(url, { accept: 'application/vnd.github+json' });
    try { return JSON.parse(data.toString('utf8')); }
    catch { throw new Error('Invalid JSON from GitHub API'); }
  }

  function parseVersion(value) {
    const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
  }

  function isNewer(v1, v2) {
    const a = parseVersion(v1);
    const b = parseVersion(v2);
    if (!a || !b) return false;
    return b.major !== a.major ? b.major > a.major : b.minor !== a.minor ? b.minor > a.minor : b.patch > a.patch;
  }

  async function checkForUpdates() {
    try {
      const releases = await requestJson(`${releasesApi}?per_page=10`);
      if (!Array.isArray(releases)) throw new Error('Unexpected GitHub releases response');
      const latest = releases.find(release => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(String(release.tag_name || '')));
      if (!latest) return { hasUpdate: false, reason: 'no-stable-releases' };
      const releaseVersion = String(latest.tag_name || '').replace(/^v/, '');
      if (!isNewer(currentVersion, releaseVersion)) {
        availableUpdate = null;
        return { hasUpdate: false, currentVersion, latestVersion: releaseVersion };
      }
      availableUpdate = {
        version: releaseVersion,
        tagName: latest.tag_name,
        releaseUrl: latest.html_url,
        publishedAt: latest.published_at,
        body: String(latest.body || '').slice(0, 2000),
        prerelease: false,
        assets: (latest.assets || []).filter(asset => isSafeAssetName(asset.name)).map(asset => ({
          name: asset.name,
          size: Number(asset.size || 0),
          contentType: asset.content_type,
          downloadUrl: asset.browser_download_url,
          apiUrl: asset.url,
          digest: asset.digest || null,
          state: asset.state
        }))
      };
      logger.info(`Update available: ${currentVersion} -> ${releaseVersion}`);
      return { hasUpdate: true, currentVersion, latestVersion: releaseVersion, update: availableUpdate };
    } catch (error) {
      logger.error('Update check failed:', error.message);
      return { hasUpdate: false, error: error.message };
    }
  }

  function getBestAsset(update) {
    if (!update?.assets || !/^\d+\.\d+\.\d+$/.test(String(update.version || '')) || update.tagName !== `v${update.version}`) return null;
    if (process.platform !== 'linux') return null;
    const arches = process.arch === 'x64' ? ['x86_64', 'x64'] : process.arch === 'arm64' ? ['arm64', 'aarch64'] : [];
    const expectedNames = arches.map(arch => `Aux.Proton.Drive.Bridge-${update.version}-${arch}.AppImage`);
    return update.assets.find(asset => expectedNames.includes(asset.name) && asset.state !== 'deleted') || null;
  }

  async function expectedChecksum(update, asset) {
    const digest = String(asset.digest || '');
    const apiDigest = /^sha256:[a-fA-F0-9]{64}$/.test(digest) ? digest.slice(7).toLowerCase() : null;
    const checksumAsset = update.assets.find(item => /^(SHA256SUMS(?:\.txt)?|checksums\.txt)$/i.test(item.name));
    if (!checksumAsset) throw new Error('Release has no SHA256 checksum manifest');
    const signatureAsset = update.assets.find(item => item.name === 'SHA256SUMS.txt.sig');
    if (!signatureAsset) throw new Error('Release has no signed checksum manifest');
    if (!checksumCache || checksumCache.tagName !== update.tagName) {
      const [data, signature] = await Promise.all([
        requestBuffer(checksumAsset.apiUrl || checksumAsset.downloadUrl, {
          accept: checksumAsset.apiUrl ? 'application/octet-stream' : 'text/plain'
        }),
        requestBuffer(signatureAsset.apiUrl || signatureAsset.downloadUrl, {
          accept: signatureAsset.apiUrl ? 'application/octet-stream' : 'application/json', maxBytes: MAX_SIGNATURE_BYTES
        })
      ]);
      verifyChecksumManifestSignature(data, signature, releasePublicKey);
      checksumCache = { tagName: update.tagName, checksums: parseChecksums(data.toString('utf8')) };
    }
    const checksum = checksumCache.checksums.get(asset.name);
    if (!checksum) throw new Error(`Checksum manifest does not contain ${asset.name}`);
    if (apiDigest && apiDigest !== checksum) throw new Error('GitHub asset digest disagrees with the signed checksum manifest');
    return checksum;
  }

  async function downloadToFile(url, destination, expectedSize) {
    if (!Number.isFinite(expectedSize) || expectedSize <= 0 || expectedSize > MAX_ARTIFACT_BYTES) {
      throw new Error(`Invalid update asset size: ${expectedSize}`);
    }
    const partPath = `${destination}.part-${process.pid}-${Date.now()}`;
    try {
      const { res } = await request(url, { accept: 'application/octet-stream', timeout: 30_000 });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        throw new Error(`Download failed: HTTP ${res.statusCode}`);
      }
      const file = fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 });
      let received = 0;
      await new Promise((resolve, reject) => {
        res.on('data', chunk => {
          received += chunk.length;
          if (received > expectedSize || received > MAX_ARTIFACT_BYTES) {
            res.destroy(new Error('Update download exceeded declared size'));
          }
        });
        res.on('error', reject);
        file.on('error', reject);
        file.on('finish', resolve);
        res.pipe(file);
      });
      if (expectedSize > 0 && received !== expectedSize) throw new Error(`Download size mismatch: expected ${expectedSize}, received ${received}`);
      fs.renameSync(partPath, destination);
      return received;
    } catch (error) {
      try { fs.rmSync(partPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function downloadUpdate(update = availableUpdate) {
    const asset = getBestAsset(update);
    if (!asset) throw new Error('No supported Linux package found in release');
    const checksum = await expectedChecksum(update, asset);
    fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
    const destination = path.join(downloadDir, asset.name);
    const bytes = await downloadToFile(asset.apiUrl || asset.downloadUrl, destination, asset.size);
    try {
      verifyFileSha256(destination, checksum);
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
    fs.chmodSync(destination, asset.name.endsWith('.AppImage') ? 0o755 : 0o600);
    verifiedDownload = { filePath: destination, size: bytes, name: asset.name, sha256: checksum, verified: true, asset };
    return { ...verifiedDownload };
  }

  async function applyUpdate(downloadedAsset) {
    if (!downloadedAsset?.verified || !verifiedDownload ||
        path.resolve(downloadedAsset.filePath || '') !== path.resolve(verifiedDownload.filePath) ||
        downloadedAsset.sha256 !== verifiedDownload.sha256 || downloadedAsset.name !== verifiedDownload.name) {
      throw new Error('Refusing to apply an update not verified in this session');
    }
    const filePath = path.resolve(downloadedAsset.filePath);
    const name = downloadedAsset.name;
    if (!isSafeAssetName(name) || !fs.statSync(filePath).isFile()) throw new Error('Invalid downloaded update');
    verifyFileSha256(filePath, downloadedAsset.sha256);
    if (name.endsWith('.AppImage')) {
      const executable = process.env.APPIMAGE || process.argv[0];
      if (!executable.endsWith('.AppImage')) {
        return { method: 'downloaded', path: filePath, instruction: `Replace your AppImage with: ${filePath}` };
      }
      const resolvedExecutable = path.resolve(executable);
      const temp = `${resolvedExecutable}.new-${process.pid}`;
      const backup = `${resolvedExecutable}.previous`;
      try {
        fs.copyFileSync(filePath, temp);
        fs.chmodSync(temp, 0o755);
        const fd = fs.openSync(temp, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.copyFileSync(resolvedExecutable, backup);
        fs.renameSync(temp, resolvedExecutable);
      } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw error;
      }
      return { method: 'replace_appimage', path: resolvedExecutable, backup };
    }
    if (name.endsWith('.deb')) return { method: 'dpkg', path: filePath, instruction: `Install with your package manager: ${filePath}` };
    if (name.endsWith('.rpm')) return { method: 'rpm', path: filePath, instruction: `Install with your package manager: ${filePath}` };
    throw new Error('Unsupported update package type');
  }

  async function checkAndDownload() {
    const check = await checkForUpdates();
    if (!check.hasUpdate) return check;
    try { return { ...check, downloaded: await downloadUpdate(check.update) }; }
    catch (error) { return { ...check, downloadError: error.message }; }
  }

  function startPeriodicCheck() {
    if (updateCheckTimer) return;
    updateCheckTimer = setInterval(() => checkForUpdates().catch(error => logger.error(error.message)), UPDATE_CHECK_INTERVAL);
    updateCheckTimer.unref?.();
  }

  function stopPeriodicCheck() {
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }

  return {
    checkForUpdates, downloadUpdate, applyUpdate, checkAndDownload,
    startPeriodicCheck, stopPeriodicCheck,
    getAvailableUpdate: () => availableUpdate,
    getBestAsset, isNewer, parseVersion
  };
}

module.exports = {
  createAutoUpdater,
  isSafeAssetName,
  parseChecksums,
  releaseKeyId,
  sha256File,
  verifyChecksumManifestSignature,
  verifyFileSha256
};
