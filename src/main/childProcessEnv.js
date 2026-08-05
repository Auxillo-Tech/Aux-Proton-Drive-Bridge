'use strict';

// Desktop/session keys the Proton CLI needs so `auth login` can open a browser
// and talk to the session bus / secret store under Electron.
const SAFE_ENV_KEYS = new Set([
  'HOME', 'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_CLASS',
  'XDG_SESSION_ID', 'XDG_VTNR', 'XDG_SEAT', 'XDG_MENU_PREFIX',
  'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'SSH_AUTH_SOCK', 'DESKTOP_SESSION', 'BROWSER',
  'KDE_FULL_SESSION', 'KDE_SESSION_VERSION', 'KDE_SESSION_UID', 'KDEDIRS',
  'QT_QPA_PLATFORM', 'QT_QPA_PLATFORMTHEME', 'QT_WAYLAND_RECONNECT',
  'GTK_MODULES', 'GDK_BACKEND',
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
