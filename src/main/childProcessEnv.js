'use strict';

const SAFE_ENV_KEYS = new Set([
  'HOME', 'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK',
  'http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'
]);

function buildChildEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key) || key.startsWith('LC_') ||
        (key.startsWith('PROTON_DRIVE_') && !/TOKEN|SECRET|PASSWORD|PASS|KEY|AUTH/i.test(key))) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

module.exports = { buildChildEnv, SAFE_ENV_KEYS };
