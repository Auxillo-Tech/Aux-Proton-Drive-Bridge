# Aux Proton Bridge

Unofficial Linux desktop bridge for Proton Drive using Proton's official `proton-drive` CLI.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Status

Version `0.1.0` is a working Linux MVP / private-beta foundation.

Aux Proton Bridge gives Linux users a GUI for common Proton Drive operations through Proton's official CLI. It is usable for manual listing, download, and upload workflows. It is **not yet** a Dropbox-style bidirectional sync daemon.

## Download

GitHub release:

<https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/tag/v0.1.0>

Release assets include:

- AppImage for broad Linux compatibility
- `.deb` for Debian/Ubuntu/Mint/Pop!_OS-family systems
- `.rpm` for Fedora/RHEL/openSUSE-family systems
- source archives
- `SHA256SUMS.txt`
- `release-manifest.json`

> Current repository visibility may be private until Auxillo chooses to make it public.

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

Existing local files should not be overwritten by default.

## Requirements

- Linux x64
- Proton Drive CLI available as `proton-drive`
- A Proton account
- Browser access for Proton login
- Linux secret store supported by Proton CLI, such as KWallet, GNOME Keyring/libsecret, or `pass`

## Quick install

### AppImage

Download:

```text
Aux.Proton.Bridge-0.1.0-x86_64.AppImage
```

Then make it executable and run it from your file manager or terminal.

### Debian / Ubuntu / Mint / Pop!_OS

Download:

```text
Aux.Proton.Bridge-0.1.0-amd64.deb
```

Install with your graphical package installer or with `apt`/`dpkg`.

### Fedora / RHEL / openSUSE

Download:

```text
Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

Install with your graphical package installer, `dnf`, `zypper`, or `rpm`.

See full instructions: [`docs/INSTALL.md`](docs/INSTALL.md).

## How to use

1. Install Proton Drive CLI and confirm `proton-drive version` works.
2. Launch Aux Proton Bridge.
3. Click **Sign in**.
4. Complete Proton login in the browser.
5. Click **Refresh files**.
6. Select files/folders from `/my-files`.
7. Pick the local destination folder.
8. Click **Download selected**, **Download everything**, or **Upload files/folders**.

See full usage guide: [`docs/USAGE.md`](docs/USAGE.md).

## Documentation

- [`docs/INSTALL.md`](docs/INSTALL.md) — install instructions by distro family
- [`docs/USAGE.md`](docs/USAGE.md) — sign-in, list, download, upload, workflow
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — common Linux/CLI/keyring problems
- [`docs/SECURITY.md`](docs/SECURITY.md) — credential handling and app security model
- [`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md) — current release state and limitations

## Build from source

```bash
npm install
npm run check
npm start
```

Build local release artifacts:

```bash
npm run check
npm run smoke:source
npm run dist:x64
npm run release:source
npm run release:manifest
npm run smoke:appimage
```

Release outputs are written to `dist/`.

## Security model

Key points:

- Aux Proton Bridge never asks for your Proton password.
- Authentication is delegated to Proton's official CLI/browser flow.
- Renderer `nodeIntegration` is disabled.
- Electron context isolation is enabled.
- CLI calls are executed as argv arrays, not shell strings.

See [`docs/SECURITY.md`](docs/SECURITY.md).

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
