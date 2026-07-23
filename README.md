# Aux Proton Bridge

Unofficial Linux desktop bridge for Proton Drive using Proton's official `proton-drive` CLI.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Status

Engineering MVP / private beta foundation.

Aux Proton Bridge is already usable for manual Proton Drive operations through a Linux GUI, but it is **not yet a full Dropbox-style bidirectional sync client**. The current release deliberately uses conservative transfer defaults to avoid destructive surprises.

## What works now

- Detects the installed Proton Drive CLI
- Opens Proton browser login via `proton-drive auth login`
- Lists `/my-files`
- Downloads selected files/folders
- Downloads all visible `/my-files` entries
- Uploads local files/folders to `/my-files`
- Lets the user choose a local destination folder
- Opens the local download folder
- Shows activity logs
- Serializes Proton CLI operations to reduce SQLite cache-lock conflicts
- Keeps Proton authentication in Proton CLI's configured OS secret store

## Safe defaults

Downloads use:

- folder conflict strategy: `merge`
- file conflict strategy: `skip`

This means existing local files should not be overwritten during early testing.

## Requirements

- Linux x64
- Proton Drive CLI available as `proton-drive`
- A Proton account
- Browser access for Proton login
- Linux secret store supported by Proton CLI, such as KWallet, GNOME Keyring/libsecret, or `pass`

## Install from source

```bash
npm install
npm start
```

## Build release artifacts

```bash
npm run check
npm run smoke:source
npm run dist:x64
npm run release:manifest
npm run smoke:appimage
```

Release outputs are written to `dist/`.

## Security model

See [`docs/SECURITY.md`](docs/SECURITY.md).

Key points:

- Aux Proton Bridge never asks for your Proton password.
- Authentication is delegated to Proton's official CLI/browser flow.
- Renderer `nodeIntegration` is disabled.
- Electron context isolation is enabled.
- CLI calls are executed as argv arrays, not shell strings.

## Roadmap

### Next

- Background tray mode
- One-way local-folder backup profile
- Transfer queue UI
- Better progress parsing
- Persistent sync metadata database
- Conservative delete handling

### Later

- Bidirectional sync
- Conflict database and conflict review UI
- File manager integration
- Optional FUSE mount
- GitHub Releases auto-update path
- Signing/attestation

## Documentation

- [`docs/INSTALL.md`](docs/INSTALL.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md)
