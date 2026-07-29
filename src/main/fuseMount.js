const path = require('node:path');
const os = require('node:os');

const DEFAULT_MOUNT_PREFIX = path.join(os.homedir(), 'ProtonDrive-FUSE');
const UNSUPPORTED_REASON = 'FUSE mounting is unavailable in this release because Proton Drive CLI 0.6.0 has no mount command and no safely owned mount helper is bundled';

const MOUNT_STATE = Object.freeze({
  UNMOUNTED: 'unmounted',
  MOUNTING: 'mounting',
  MOUNTED: 'mounted',
  UNMOUNTING: 'unmounting',
  ERROR: 'error'
});

function createFuseMount(options = {}) {
  const mountPoint = options.mountPoint || DEFAULT_MOUNT_PREFIX;
  const logger = options.logger || console;
  let state = MOUNT_STATE.UNMOUNTED;
  let errorMessage = null;
  const listeners = new Map();

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function emit(event, data) {
    for (const handler of listeners.get(event) || []) {
      try { handler(data); } catch (error) { logger.error('FuseMount listener error:', error); }
    }
  }

  function setState(nextState) {
    state = nextState;
    emit('state_change', { state, ts: new Date().toISOString() });
  }

  function isFuseAvailable() {
    return false;
  }

  async function mount() {
    errorMessage = UNSUPPORTED_REASON;
    setState(MOUNT_STATE.ERROR);
    emit('error', { message: errorMessage });
    return { ok: false, error: errorMessage };
  }

  async function unmount() {
    errorMessage = null;
    setState(MOUNT_STATE.UNMOUNTED);
    return { ok: true, mountPoint };
  }

  function getStatus() {
    return {
      state,
      mountPoint,
      isMounted: false,
      isFuseAvailable: false,
      capabilityReason: UNSUPPORTED_REASON,
      error: errorMessage,
      canMount: false,
      canUnmount: false
    };
  }

  async function destroy() {
    await unmount();
    listeners.clear();
  }

  return { mount, unmount, getStatus, isFuseAvailable, on, destroy, MOUNT_STATE };
}

module.exports = { createFuseMount, MOUNT_STATE, DEFAULT_MOUNT_PREFIX, UNSUPPORTED_REASON };
