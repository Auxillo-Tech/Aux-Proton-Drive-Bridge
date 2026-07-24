/**
 * fuseMount.js — Optional FUSE Mount Support
 *
 * Provides a FUSE-based mount point for Proton Drive using
 * proton-drive CLI as the backend. When mounted, files appear
 * as a regular directory in the filesystem.
 *
 * Uses libfuse3 through child_process (mount.proton-drive or
 * a custom FUSE implementation via the CLI).
 *
 * Note: Requires proton-drive CLI to support FUSE natively,
 * or a wrapper script. This module provides the integration
 * layer and UI state management.
 */

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DEFAULT_MOUNT_PREFIX = path.join(os.homedir(), 'ProtonDrive-FUSE');

// Mount states
const MOUNT_STATE = Object.freeze({
  UNMOUNTED: 'unmounted',
  MOUNTING: 'mounting',
  MOUNTED: 'mounted',
  UNMOUNTING: 'unmounting',
  ERROR: 'error'
});

/**
 * Create a FUSE mount manager.
 * @param {object} [options]
 * @param {string} [options.mountPoint] - Where to mount Proton Drive
 * @param {string} [options.cliBin] - Path to proton-drive binary
 * @param {object} [options.logger] - Optional logger
 * @returns {object} FuseMount API
 */
function createFuseMount(options = {}) {
  const mountPoint = options.mountPoint || DEFAULT_MOUNT_PREFIX;
  const cliBin = options.cliBin || process.env.PROTON_DRIVE_BIN || 'proton-drive';
  const logger = options.logger || console;

  let state = MOUNT_STATE.UNMOUNTED;
  let mountProcess = null;
  let errorMessage = null;

  // Callbacks
  const listeners = {};

  function on(event, handler) {
    (listeners[event] ||= []).push(handler);
    return () => {
      listeners[event] = listeners[event]?.filter(h => h !== handler) || [];
    };
  }

  function emit(event, data) {
    for (const handler of (listeners[event] || [])) {
      try { handler(data); } catch (e) { logger.error('FuseMount listener error:', e); }
    }
  }

  function setState(newState) {
    state = newState;
    emit('state_change', { state: newState, ts: new Date().toISOString() });
  }

  /**
   * Check if FUSE is available on this system.
   */
  function isFuseAvailable() {
    try {
      // Check for FUSE kernel module
      const fuseExists = fs.existsSync('/dev/fuse');
      // Check for mount.fuse or relevant tool
      const hasFuse3 = execFileSync('which', ['mount.fuse3'], true);
      if (fuseExists) return true;

      // Also check if proton-drive has native FUSE
      const helpOut = execFileSync(cliBin, ['filesystem', 'mount', '--help'], true);
      return helpOut.includes('--fuse') || helpOut.includes('mount point');
    } catch {
      return false;
    }
  }

  function execFileSync(bin, args, noThrow) {
    try {
      const result = require('node:child_process').execFileSync(bin, args, { encoding: 'utf8', timeout: 5000 });
      return result.trim();
    } catch (err) {
      if (noThrow) return '';
      throw err;
    }
  }

  /**
   * Mount Proton Drive at the configured mount point.
   */
  async function mount() {
    if (state === MOUNT_STATE.MOUNTED) {
      return { ok: true, mountPoint };
    }
    if (state === MOUNT_STATE.MOUNTING) {
      return { ok: false, error: 'Already mounting' };
    }

    setState(MOUNT_STATE.MOUNTING);
    errorMessage = null;

    try {
      fs.mkdirSync(mountPoint, { recursive: true });

      // Try proton-drive's native mount command first
      const bin = cliBin;
      const args = ['filesystem', 'mount', mountPoint];

      mountProcess = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PROTON_DRIVE_LOG_LEVEL: 'ERROR' }
      });

      let stderr = '';

      mountProcess.stderr.on('data', data => {
        stderr += data.toString();
        emit('log', { stream: 'stderr', text: data.toString().trim() });
      });

      mountProcess.stdout.on('data', data => {
        emit('log', { stream: 'stdout', text: data.toString().trim() });
      });

      mountProcess.on('error', (err) => {
        errorMessage = err.message;
        setState(MOUNT_STATE.ERROR);
        emit('error', { message: err.message });
      });

      mountProcess.on('close', (code) => {
        if (code === 0) {
          setState(MOUNT_STATE.MOUNTED);
          emit('mounted', { mountPoint, ts: new Date().toISOString() });
        } else if (state !== MOUNT_STATE.UNMOUNTING) {
          // Process exited unexpectedly
          errorMessage = stderr || `mount exited with code ${code}`;
          setState(MOUNT_STATE.ERROR);
          emit('error', { message: errorMessage, code });
        }
        mountProcess = null;
      });

      // Wait briefly to verify mount started
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if the mount point is usable
      if (state === MOUNT_STATE.MOUNTING) {
        // Mount is still running — consider it mounted
        setState(MOUNT_STATE.MOUNTED);
        emit('mounted', { mountPoint, ts: new Date().toISOString() });
      }

      return { ok: state === MOUNT_STATE.MOUNTED, mountPoint };
    } catch (err) {
      errorMessage = err.message;
      setState(MOUNT_STATE.ERROR);
      emit('error', { message: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Unmount Proton Drive.
   */
  async function unmount() {
    if (state === MOUNT_STATE.UNMOUNTED) {
      return { ok: true };
    }

    setState(MOUNT_STATE.UNMOUNTING);

    try {
      // Kill the mount process first
      if (mountProcess) {
        mountProcess.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
        if (mountProcess) {
          mountProcess.kill('SIGKILL');
        }
      }

      // Then try fusermount3/fusermount as fallback
      try {
        if (fs.existsSync('/usr/bin/fusermount3')) {
          execFileSync('fusermount3', ['-u', mountPoint], true);
        } else if (fs.existsSync('/usr/bin/fusermount')) {
          execFileSync('fusermount', ['-u', mountPoint], true);
        } else {
          execFileSync('umount', [mountPoint], true);
        }
      } catch {
        // umount may fail if already unmounted — that's fine
      }

      setState(MOUNT_STATE.UNMOUNTED);
      emit('unmounted', { mountPoint, ts: new Date().toISOString() });
      return { ok: true, mountPoint };
    } catch (err) {
      errorMessage = err.message;
      setState(MOUNT_STATE.ERROR);
      emit('error', { message: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Get current mount status.
   */
  function getStatus() {
    const isMounted = state === MOUNT_STATE.MOUNTED &&
      (fs.existsSync(mountPoint) && fs.statSync(mountPoint).isDirectory());

    if (!isMounted && state === MOUNT_STATE.MOUNTED) {
      // Mount disappeared
      setState(MOUNT_STATE.ERROR);
      errorMessage = 'Mount point no longer accessible';
    }

    let available = false;
    try { available = isFuseAvailable(); } catch { available = false; }

    return {
      state,
      mountPoint,
      isMounted: state === MOUNT_STATE.MOUNTED && isMounted,
      isFuseAvailable: available,
      error: errorMessage,
      canMount: available && state !== MOUNT_STATE.MOUNTED,
      canUnmount: state === MOUNT_STATE.MOUNTED || state === MOUNT_STATE.ERROR
    };
  }

  function destroy() {
    unmount().catch(() => {});
    mountProcess = null;
    listeners.error = [];
    listeners.state_change = [];
  }

  return {
    mount,
    unmount,
    getStatus,
    isFuseAvailable,
    on,
    destroy,
    MOUNT_STATE
  };
}

module.exports = { createFuseMount, MOUNT_STATE, DEFAULT_MOUNT_PREFIX };
