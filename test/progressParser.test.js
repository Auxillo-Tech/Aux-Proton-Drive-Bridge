const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseProgressLine, summarizeTransfer } = require('../src/main/progressParser');

describe('progressParser — parseProgressLine', () => {

  it('returns null for empty/non-progress lines', () => {
    assert.strictEqual(parseProgressLine(''), null);
    assert.strictEqual(parseProgressLine('  '), null);
    assert.strictEqual(parseProgressLine(null), null);
    assert.strictEqual(parseProgressLine(undefined), null);
    assert.strictEqual(parseProgressLine('Starting Proton Drive CLI…'), null);
    assert.strictEqual(parseProgressLine('Connected to remote server'), null);
  });

  it('parses percentage-based progress: "Downloading file.ext (45%)"', () => {
    const result = parseProgressLine('Downloading report.pdf (45%)');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.type, 'progress');
    assert.strictEqual(result.action, 'downloading');
    assert.strictEqual(result.name, 'report.pdf');
    assert.strictEqual(result.pct, 45);

    const upload = parseProgressLine('Uploading photo.jpg (100%)');
    assert.strictEqual(upload.action, 'uploading');
    assert.strictEqual(upload.pct, 100);
  });

  it('parses percentage-based progress: "Syncing project (0%)"', () => {
    const result = parseProgressLine('Syncing project (0%)');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.action, 'syncing');
    assert.strictEqual(result.pct, 0);
  });

  it('parses size-based progress: "filename — 2.3 MB / 5.1 MB"', () => {
    const state = {};
    const result = parseProgressLine('report.pdf — 2.3 MB / 5.1 MB', state);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.type, 'progress');
    assert.strictEqual(result.name, 'report.pdf');
    assert.strictEqual(result.current, 2.3 * 1024 * 1024);
    assert.strictEqual(result.total, 5.1 * 1024 * 1024);
    assert.strictEqual(result.pct, 45); // round(2.3/5.1*100)
  });

  it('handles bytes, KB, GB size units', () => {
    const s1 = () => {};
    const r1 = parseProgressLine('file.txt — 500 B / 1 KB', { lastBytes: {} });
    assert.strictEqual(r1.current, 500);
    assert.strictEqual(r1.total, 1024);

    const r2 = parseProgressLine('big.iso — 1.0 GB / 4.5 GB', { lastBytes: {} });
    assert.strictEqual(r2.current, 1 * 1024 * 1024 * 1024);
    assert.strictEqual(r2.total, 4.5 * 1024 * 1024 * 1024);
  });

  it('parses file completion: "✓ file.ext"', () => {
    const result = parseProgressLine('✓ report.pdf');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.type, 'file_complete');
    assert.strictEqual(result.name, 'report.pdf');
    assert.strictEqual(result.pct, 100);
  });

  it('parses file completion with size: "✓ file.ext (2.3 MB)"', () => {
    const result = parseProgressLine('✓ photo.jpg (2.3 MB)');
    assert.strictEqual(result.type, 'file_complete');
    assert.strictEqual(result.bytes, 2.3 * 1024 * 1024);
  });

  it('accepts multiple checkmark unicode variants', () => {
    assert.strictEqual(parseProgressLine('✓ done.txt').type, 'file_complete');
    assert.strictEqual(parseProgressLine('✔ done.txt').type, 'file_complete');
    assert.strictEqual(parseProgressLine('✅ done.txt').type, 'file_complete');
  });

  it('parses error lines: "✗ failed.txt"', () => {
    const result = parseProgressLine('✗ failed_upload.txt');
    assert.strictEqual(result.type, 'file_error');
    assert.ok(result.error);
  });

  it('parses progress bars: "[====>                   ] 12%"', () => {
    const result = parseProgressLine('[====>                   ] 12%');
    assert.strictEqual(result.type, 'progress');
    assert.strictEqual(result.action, 'chunk');
    assert.strictEqual(result.pct, 12);
  });

  it('parses ETA lines: "ETA: 1m 23s"', () => {
    const result = parseProgressLine('ETA: 1m 23s');
    assert.strictEqual(result.type, 'eta');
    assert.strictEqual(result.eta, '1m 23s');
  });

  it('parses "X of Y items" batch progress', () => {
    const result = parseProgressLine('5 of 120 items');
    assert.strictEqual(result.type, 'progress');
    assert.strictEqual(result.action, 'batch');
    assert.strictEqual(result.currentItem, 5);
    assert.strictEqual(result.totalItems, 120);
    assert.strictEqual(result.pct, 4); // round(5/120*100)
  });

});

describe('progressParser — summarizeTransfer', () => {

  it('returns empty summary for no lines', () => {
    const s = summarizeTransfer([]);
    assert.strictEqual(s.totalCompleted, 0);
    assert.strictEqual(s.totalErrors, 0);
    assert.strictEqual(s.lastProgress, 0);
  });

  it('tracks completed files and errors across lines', () => {
    const lines = [
      'Downloading file1.txt (30%)',
      'Downloading file1.txt (60%)',
      '✓ file1.txt',
      'Downloading file2.txt (40%)',
      '✗ file3_bad.txt',
      '✓ file2.txt'
    ];
    const s = summarizeTransfer(lines);
    assert.strictEqual(s.totalCompleted, 2);
    assert.strictEqual(s.totalErrors, 1);
    assert.strictEqual(s.completed[0].name, 'file1.txt');
    assert.strictEqual(s.completed[1].name, 'file2.txt');
    assert.strictEqual(s.errors[0].name, 'file3_bad.txt');
  });

  it('tracks last perceived progress percentage', () => {
    const lines = [
      'Downloading bigfile.txt (10%)',
      'Downloading bigfile.txt (50%)',
      'Downloading bigfile.txt (90%)'
    ];
    const s = summarizeTransfer(lines);
    assert.strictEqual(s.lastProgress, 90);
  });

  it('tracks current file name from the latest progress line', () => {
    const lines = [
      'Downloading a.txt (20%)',
      'Downloading b.txt (50%)'
    ];
    const s = summarizeTransfer(lines);
    assert.strictEqual(s.currentFile, 'b.txt');
  });

});
