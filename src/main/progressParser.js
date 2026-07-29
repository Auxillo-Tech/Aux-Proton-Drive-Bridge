/**
 * progressParser.js — Proton Drive CLI Progress Parser
 *
 * Parses proton-drive CLI stderr/stdout for real-time transfer progress.
 * Handles multiple output formats:
 *   - "Downloading file.ext (45%)"
 *   - "Uploading report.pdf — 2.3 MB / 5.1 MB"
 *   - Progress bar lines: "[====>                   ] 12%"
 *   - Explicit ETA lines: "ETA: 1m 23s"
 *   - File completion lines: "✓ file.ext"
 */

const SPEED_WINDOW_MS = 3000;

/**
 * Parse a raw line of CLI output into a structured progress event.
 * @param {string} line - Raw output line from proton-drive CLI
 * @param {object} [state] - Mutable state object for tracking across lines
 * @returns {object|null} Parsed progress event or null if not a progress line
 */
function parseProgressLine(line, state = {}) {
  if (!line || typeof line !== 'string') return null;

  const trimmed = line.trim();
  if (!trimmed) return null;

  // ── File completion (checkmark prefix) ──────────────────────
  const completedMatch = trimmed.match(/^[✓✔✅]\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*(KB|MB|GB)\))?$/);
  if (completedMatch) {
    const name = completedMatch[1].trim();
    const sizeBytes = completedMatch[2] ? parseSize(completedMatch[2], completedMatch[3]) : 0;
    return { type: 'file_complete', name, path: name, bytes: sizeBytes, pct: 100 };
  }

  // ── Error lines ────────────────────────────────────────────
  const errMatch = trimmed.match(/^[✗✘×❌]\s+(.+)$/);
  if (errMatch) {
    return { type: 'file_error', name: errMatch[1].trim(), error: errMatch[1].trim() };
  }

  // ── Percentage-based: "Downloading file.ext (45%)" ──────────
  const pctMatch = trimmed.match(/^(Uploading|Downloading|Syncing)\s+(.+?)\s*\((\d{1,3})%\)$/i);
  if (pctMatch) {
    const action = pctMatch[1].toLowerCase();
    const name = pctMatch[2].trim();
    const pct = parseInt(pctMatch[3], 10);
    return {
      type: 'progress',
      action,
      name,
      path: name,
      pct: Math.min(100, Math.max(0, pct))
    };
  }

  // ── Size-based: "filename — 2.3 MB / 5.1 MB" ──────────────
  const sizeMatch = trimmed.match(/^(.+?)\s*[—–-]\s+([\d.]+)\s*(KB|MB|GB|B)\s*\/\s*([\d.]+)\s*(KB|MB|GB|B)$/);
  if (sizeMatch) {
    const name = sizeMatch[1].trim();
    const current = parseSize(sizeMatch[2], sizeMatch[3]);
    const total = parseSize(sizeMatch[4], sizeMatch[5]);
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    // Track speed
    const now = Date.now();
    if (!state.lastBytes) state.lastBytes = {};
    const prev = state.lastBytes[name] || { bytes: current, time: now };

    let speed = 0;
    const elapsed = now - prev.time;
    if (elapsed > 0 && prev.bytes > 0) {
      speed = Math.max(0, Math.round((current - prev.bytes) / (elapsed / 1000)));
    }
    state.lastBytes[name] = { bytes: current, time: now };

    return {
      type: 'progress',
      action: 'transfer',
      name,
      path: name,
      current,
      total,
      pct: Math.min(100, Math.max(0, pct)),
      speed,
      speedLabel: formatSpeed(speed),
      eta: speed > 0 ? formatEta((total - current) / speed) : null
    };
  }

  // ── Progress bar: "[====>                   ] 12%" ──────────
  const barMatch = trimmed.match(/^\[[= >]+]\s*(\d{1,3})%/);
  if (barMatch) {
    return { type: 'progress', action: 'chunk', pct: parseInt(barMatch[1], 10) };
  }

  // ── ETA line: "ETA: 1m 23s" ───────────────────────────────
  const etaMatch = trimmed.match(/^ETA:\s*(.+)$/i);
  if (etaMatch) {
    return { type: 'eta', eta: etaMatch[1].trim() };
  }

  // ── Generic "X of Y" ───────────────────────────────────────
  const skippedMatch = trimmed.match(/^Skipped:\s*(?:(\d+)\b|(.+))$/i);
  if (skippedMatch) {
    return { type: 'skipped', count: skippedMatch[1] ? Number(skippedMatch[1]) : 1, detail: skippedMatch[2]?.trim() || null };
  }

  const ofMatch = trimmed.match(/^(\d+)\s+of\s+(\d+)\s+items?/i);
  if (ofMatch) {
    return {
      type: 'progress',
      action: 'batch',
      currentItem: parseInt(ofMatch[1], 10),
      totalItems: parseInt(ofMatch[2], 10),
      pct: Math.round((parseInt(ofMatch[1], 10) / parseInt(ofMatch[2], 10)) * 100)
    };
  }

  return null;
}

/**
 * Batch-process lines from a transfer and produce a summary.
 * @param {string[]} lines - Array of output lines
 * @returns {object} Transfer summary with files, errors, progress info
 */
function summarizeTransfer(lines) {
  const completed = [];
  const errors = [];
  let lastPct = 0;
  let currentFile = '';
  const skipped = [];
  let totalSkipped = 0;

  for (const line of (lines || [])) {
    const parsed = parseProgressLine(line);
    if (!parsed) continue;

    switch (parsed.type) {
      case 'file_complete':
        completed.push({ name: parsed.name, bytes: parsed.bytes });
        break;
      case 'file_error':
        errors.push({ name: parsed.name, error: parsed.error });
        break;
      case 'progress':
        if (parsed.pct !== undefined && parsed.pct > lastPct) lastPct = parsed.pct;
        if (parsed.name) currentFile = parsed.name;
        break;
      case 'skipped':
        totalSkipped += parsed.count;
        if (parsed.detail) skipped.push(parsed.detail);
        break;
    }
  }

  return {
    completed,
    errors,
    lastProgress: lastPct,
    currentFile,
    totalCompleted: completed.length,
    totalErrors: errors.length,
    skipped,
    totalSkipped
  };
}

// ── Helpers ──────────────────────────────────────────────────

function parseSize(value, unit) {
  const num = parseFloat(value) || 0;
  switch ((unit || '').toUpperCase()) {
    case 'GB': return num * 1024 * 1024 * 1024;
    case 'MB': return num * 1024 * 1024;
    case 'KB': return num * 1024;
    default: return num;
  }
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

module.exports = { parseProgressLine, summarizeTransfer };
