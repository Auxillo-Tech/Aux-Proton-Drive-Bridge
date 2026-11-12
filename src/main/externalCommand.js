// Parses the command line the app is started or re-launched with by the file-manager
// integrations (see scripts/install-file-manager-integration.sh).
//
//   --install-file-manager-integration
//   --upload --path /a --path /b          one --path per file
//   --upload /a /b /c                     Thunar: all selected files, as absolute paths
//   --download-here /folder
//
// File names are only ever compared and passed on as they are: no shell, no splitting on
// spaces, quotes or newlines.
const path = require('node:path');

function parseUploadPaths(args, uploadIndex) {
  const localPaths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path') {
      if (args[i + 1]) localPaths.push(args[++i]);
    } else if (i > uploadIndex) {
      if (path.isAbsolute(arg)) {
        // An older Thunar entry ran "--upload --path %F", so everything after the first
        // file arrives as a bare absolute path.
        localPaths.push(arg);
      } else if (!arg.startsWith('-')) {
        throw new Error(`--upload does not understand the argument ${JSON.stringify(arg)}; pass absolute paths or --path`);
      }
    }
  }
  return localPaths;
}

function parseExternalCommand(argv = []) {
  const args = argv.map(String);
  if (args.includes('--install-file-manager-integration')) return { action: 'install-file-manager-integration' };
  const uploadIndex = args.indexOf('--upload');
  if (uploadIndex >= 0) {
    const localPaths = parseUploadPaths(args, uploadIndex);
    if (!localPaths.length) throw new Error('--upload requires at least one --path argument');
    return { action: 'upload', localPaths };
  }
  const downloadIndex = args.indexOf('--download-here');
  if (downloadIndex >= 0) {
    if (!args[downloadIndex + 1]) throw new Error('--download-here requires a folder path');
    return { action: 'open-download-folder', localFolder: args[downloadIndex + 1] };
  }
  return null;
}

module.exports = { parseExternalCommand };
