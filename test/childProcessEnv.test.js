'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChildEnv } = require('../src/main/childProcessEnv');

test('child process environment excludes release credentials and unrelated secrets', () => {
  const previous = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    SIGNING_KEY: process.env.SIGNING_KEY,
    TEST_PASSWORD: process.env.TEST_PASSWORD,
    PATH: process.env.PATH
  };
  try {
    process.env.GH_TOKEN = 'github-secret';
    process.env.GITHUB_TOKEN = 'github-secret-2';
    process.env.SIGNING_KEY = 'release-secret';
    process.env.TEST_PASSWORD = 'password-secret';
    const env = buildChildEnv({ PROTON_DRIVE_LOG_LEVEL: 'ERROR' });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.SIGNING_KEY, undefined);
    assert.equal(env.TEST_PASSWORD, undefined);
    assert.equal(env.PATH, previous.PATH);
    assert.equal(env.PROTON_DRIVE_LOG_LEVEL, 'ERROR');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
