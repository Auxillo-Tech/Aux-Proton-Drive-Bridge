'use strict';

function createProgressPersistenceGate(options = {}) {
  const intervalMs = Math.max(1, Number(options.intervalMs) || 1000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const lastPersistedAt = new Map();

  function shouldPersist(transferId, payload = {}) {
    if (!transferId) return false;
    const current = now();
    const isError = payload.type === 'file_error' || Boolean(payload.error);
    const isTerminal = Number(payload.pct ?? payload.percent) >= 100;
    const previous = lastPersistedAt.get(transferId);
    if (isError || isTerminal || previous === undefined || current - previous >= intervalMs) {
      lastPersistedAt.set(transferId, current);
      return true;
    }
    return false;
  }

  function clear(transferId) {
    lastPersistedAt.delete(transferId);
  }

  return { shouldPersist, clear };
}

module.exports = { createProgressPersistenceGate };
