'use strict';

const fs = require('node:fs');
const path = require('node:path');
module.exports = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const candidates = [
    context.packager.executableName,
    context.packager.platformSpecificBuildOptions?.executableName,
    context.packager.appInfo?.productFilename,
    'aux-proton-drive-bridge'
  ].filter(Boolean);
  const executablePath = candidates
    .map(name => path.join(context.appOutDir, name))
    .find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error(`Unable to find packaged Electron executable in ${context.appOutDir}`);

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  });
};
