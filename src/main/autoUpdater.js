/**
 * autoUpdater.js — GitHub Releases Auto-Update for Electron
 *
 * Checks GitHub Releases for newer versions, downloads updates,
 * and applies them. Works with AppImage, .deb, and .rpm targets.
 *
 * Uses GitHub's Releases API to check for updates without
 * requiring any external auto-update service.
 */

const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const GITHUB_OWNER = 'Auxillo-Tech';
const GITHUB_REPO = 'Aux-proton-drive-bridge';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // Every 6 hours

/**
 * Create an auto-updater instance.
 * @param {object} [options]
 * @param {string} [options.currentVersion] - Current app version (from package.json)
 * @param {string} [options.downloadDir] - Where to save downloaded updates
 * @param {object} [options.logger] - Optional logger with .info/.warn/.error
 * @returns {object} AutoUpdater API
 */
function createAutoUpdater(options = {}) {
  const currentVersion = options.currentVersion || '0.0.0';
  const downloadDir = options.downloadDir || path.join(app?.getPath?.('userData') || process.cwd(), 'updates');
  const logger = options.logger || console;
  const userAgent = `${GITHUB_REPO}/${currentVersion}`;

  let updateCheckTimer = null;
  let availableUpdate = null;
  let cachedToken = null;

  // Try to get a GitHub token for private repo access
  function getGitHubToken() {
    if (cachedToken) return cachedToken;
    try {
      const { execFileSync } = require('node:child_process');
      const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 3000 }).trim();
      if (token) { cachedToken = token; return token; }
    } catch {}
    if (process.env.GH_TOKEN) { cachedToken = process.env.GH_TOKEN; return cachedToken; }
    if (process.env.GITHUB_TOKEN) { cachedToken = process.env.GITHUB_TOKEN; return cachedToken; }
    return null;
  }

  function buildHeaders() {
    const headers = {
      'User-Agent': userAgent,
      Accept: 'application/vnd.github.v3+json'
    };
    const token = getGitHubToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  // ── Version comparison ─────────────────────────────────────

  function parseVersion(v) {
    const parts = String(v || '').replace(/^v/, '').split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  }

  function isNewer(v1, v2) {
    const a = parseVersion(v1);
    const b = parseVersion(v2);
    if (b.major !== a.major) return b.major > a.major;
    if (b.minor !== a.minor) return b.minor > a.minor;
    return b.patch > a.patch;
  }

  // ── HTTP helpers ───────────────────────────────────────────

  function httpsGet(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: buildHeaders(), timeout: 10000 }, (res) => {
        res.setTimeout(10000);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 302 && res.headers.location) {
            // Redirect (e.g., GitHub asset download)
            httpsGet(res.headers.location).then(resolve).catch(reject);
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Invalid JSON from GitHub API')); }
        });
      }).on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API request timed out')); });
    });
  }

  function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const req = https.get(url, { headers: buildHeaders(), timeout: 30000 }, (res) => {
        if (res.statusCode >= 400) {
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', chunk => { received += chunk.length; });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve({ filePath: destPath, size: received, name: path.basename(destPath), bytesReceived: received, bytesTotal: total });
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
      req.on('timeout', () => { req.destroy(); fs.unlink(destPath, () => {}); reject(new Error('Download timed out')); });
    });
  }

  // ── Update check ───────────────────────────────────────────

  async function checkForUpdates() {
    try {
      const releases = await httpsGet(`${RELEASES_API}?per_page=5`);
      if (!Array.isArray(releases) || releases.length === 0) {
        return { hasUpdate: false, reason: 'no-releases' };
      }

      // Find the latest non-draft, non-prerelease, or pre-release if that's all we have
      const latest = releases.find(r => !r.draft) || releases[0];
      const latestTag = (latest.tag_name || '').replace(/^v/, '');
      const releaseVersion = latestTag;

      if (isNewer(currentVersion, releaseVersion)) {
        availableUpdate = {
          version: releaseVersion,
          tagName: latest.tag_name,
          releaseUrl: latest.html_url,
          publishedAt: latest.published_at,
          body: (latest.body || '').slice(0, 2000),
          assets: (latest.assets || []).map(a => ({
            name: a.name,
            size: a.size,
            contentType: a.content_type,
            downloadUrl: a.browser_download_url,
            state: a.state
          })),
          prerelease: latest.prerelease || false
        };
        logger.info(`Update available: ${currentVersion} → ${releaseVersion}`);
        return { hasUpdate: true, update: availableUpdate };
      }

      return { hasUpdate: false, currentVersion, latestVersion: releaseVersion };
    } catch (err) {
      logger.error('Update check failed:', err.message);
      return { hasUpdate: false, error: err.message };
    }
  }

  // ── Download update ────────────────────────────────────────

  function getBestAsset(update) {
    if (!update || !update.assets) return null;

    // Determine platform-appropriate asset
    const isAppImage = process.platform === 'linux';
    const isDeb = process.platform === 'linux';
    const isRpm = process.platform === 'linux';

    // Priority: AppImage > deb > rpm > zip/tar.gz
    for (const asset of update.assets) {
      if (asset.name.endsWith('.AppImage')) return asset;
    }
    for (const asset of update.assets) {
      if (asset.name.endsWith('.deb')) return asset;
    }
    for (const asset of update.assets) {
      if (asset.name.endsWith('.rpm')) return asset;
    }
    // Fallback to source
    for (const asset of update.assets) {
      if (asset.name.endsWith('.tar.gz') || asset.name.endsWith('.zip')) return asset;
    }
    return update.assets[0] || null;
  }

  async function downloadUpdate(update) {
    const asset = getBestAsset(update);
    if (!asset) throw new Error('No downloadable asset found in release');

    fs.mkdirSync(downloadDir, { recursive: true });
    const destPath = path.join(downloadDir, asset.name);

    logger.info(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
    await downloadFile(asset.downloadUrl, destPath);

    // Verify file
    const stat = fs.statSync(destPath);
    return {
      filePath: destPath,
      size: stat.size,
      name: asset.name,
      asset
    };
  }

  // ── Apply update ───────────────────────────────────────────

  async function applyUpdate(downloadedAsset) {
    const filePath = downloadedAsset.filePath;
    const name = downloadedAsset.name;

    if (name.endsWith('.AppImage')) {
      // Replace the running AppImage
      const exePath = process.env.APPIMAGE || process.argv[0];
      if (exePath && exePath.endsWith('.AppImage')) {
        fs.chmodSync(filePath, 0o755);
        fs.copyFileSync(filePath, exePath);
        logger.info('AppImage updated. Restart to apply.');
        return { method: 'replace_appimage', path: exePath };
      } else {
        // Fallback: tell user where the new AppImage is
        return { method: 'downloaded', path: filePath, instruction: `Replace your AppImage with: ${filePath}` };
      }
    } else if (name.endsWith('.deb')) {
      return { method: 'dpkg', path: filePath, instruction: `Install: sudo dpkg -i ${filePath}` };
    } else if (name.endsWith('.rpm')) {
      return { method: 'rpm', path: filePath, instruction: `Install: sudo rpm -Uvh ${filePath}` };
    } else {
      return { method: 'manual', path: filePath, instruction: `Extract ${name} and replace application files` };
    }
  }

  // ── Full update flow ───────────────────────────────────────

  async function checkAndDownload() {
    const check = await checkForUpdates();
    if (!check.hasUpdate) return check;

    try {
      const downloaded = await downloadUpdate(check.update);
      return { ...check, downloaded };
    } catch (err) {
      logger.error('Download failed:', err.message);
      return { ...check, downloadError: err.message };
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  function startPeriodicCheck() {
    if (updateCheckTimer) return;
    updateCheckTimer = setInterval(() => {
      checkForUpdates().catch(err => logger.error('Periodic update check failed:', err.message));
    }, UPDATE_CHECK_INTERVAL);
    updateCheckTimer.unref?.();
  }

  function stopPeriodicCheck() {
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
  }

  function getAvailableUpdate() {
    return availableUpdate;
  }

  return {
    checkForUpdates,
    downloadUpdate,
    applyUpdate,
    checkAndDownload,
    startPeriodicCheck,
    stopPeriodicCheck,
    getAvailableUpdate,
    isNewer,
    parseVersion
  };
}

module.exports = { createAutoUpdater };
