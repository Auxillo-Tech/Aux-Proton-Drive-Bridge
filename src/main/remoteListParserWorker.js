'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { parseListOutput } = require('./protonCli');

try {
  const text = typeof workerData === 'string' ? workerData : workerData?.text;
  const options = typeof workerData === 'string' ? {} : workerData?.options;
  parentPort.postMessage({ ok: true, rows: parseListOutput(text, options) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || String(error) });
}
