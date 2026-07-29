🌐 **English** · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

# Aux Proton Drive Bridge

Unofficial Linux desktop bridge for Proton Drive using Proton's official `proton-drive` CLI.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Status

Version **`0.3.0`** - Full-featured sync, transfer queue, conflict resolution, and FUSE mount support.

Aux Proton Drive Bridge gives Linux users a GUI for Proton Drive operations through Proton's official CLI. It includes persistent sync metadata, bidirectional sync, a live transfer queue, conflict management, signed updates, and capability-gated mount status.

## Download

GitHub release:

<https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/latest>

Release assets include:

- AppImage for broad Linux compatibility
- `.deb` for Debian/Ubuntu/Mint/Pop!_OS-family systems
- `.rpm` for Fedora/RHEL/openSUSE-family systems
- source archives
- `SHA256SUMS.txt`
- `release-manifest.json`
- required Ed25519 signature (`SHA256SUMS.txt.sig`)

> Current repository visibility may be private until Auxillo chooses to make it public.

## What works now

### v0.3.0 - New features

- **Sync metadata DB** - SQLite-backed tracking of every tracked file's local and remote state
- **Live transfer queue** - Concurrent transfers with priority, pause/resume, cancel, retry
- **Progress parser** - Real-time parsing of proton-drive CLI output for transfer progress
- **Conflict detection & resolution** - Detects LOCAL_REMOTE_MODIFY, LOCAL_DELETE_REMOTE_MODIFY, TYPE_MISMATCH, HASH_MISMATCH conflicts with resolution strategies
- **Bidirectional sync engine** - Local filesystem watching via fs.watch + remote polling via CLI
- **Sync modes** - Conservative (upload-only, skip existing), One-way upload, One-way download, Bidirectional
- **Auto-updater** - GitHub Releases-based update checking and download
- **Release signing** - GPG and signify/minisign signing scripts
- **File manager integration** - Nautilus, Dolphin, Thunar context menu scripts
- **Optional FUSE mount** - Mount Proton Drive as a filesystem directory
- **Tabbed UI** - Separate tabs for Files, Sync Dashboard, Conflicts, Queue, FUSE, and Updates

### v0.2.x - Existing features

- Detects the installed Proton Drive CLI
- Opens Proton browser login via `proton-drive auth login`
- Lists `/my-files`
- Downloads selected files/folders
- Downloads all visible `/my-files` entries
- Uploads local files/folders to `/my-files`
- Lets the user choose a local destination folder
- Opens the local download folder
- Shows activity logs and persistent transfer history
- Serializes Proton CLI operations to reduce SQLite cache-lock conflicts
- Keeps Proton authentication in Proton CLI's configured OS secret store
- One-way backup profile with scheduler (30 min)
- System tray with quick actions
- Background close-to-tray mode

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
- FUSE is unavailable with Proton Drive CLI 0.6.0 because that CLI has no mount command

The installed CLI owns authentication. The bridge supports one active Proton account/session at a time; saved backup settings do not create separate authentication contexts.

## Quick install

### AppImage

Download and run:

```text
Aux.Proton.Drive.Bridge-0.3.1-x86_64.AppImage
```

Make it executable and run it from your file manager or terminal.

### Debian / Ubuntu / Mint / Pop!_OS

Download:

```text
Aux.Proton.Drive.Bridge-0.3.1-amd64.deb
```

Install with your graphical package installer or with `apt`/`dpkg`.

### Fedora / RHEL / openSUSE

Download:

```text
Aux.Proton.Drive.Bridge-0.3.1-x86_64.rpm
```

Install with your graphical package installer, `dnf`, `zypper`, or `rpm`.

See full instructions: [`docs/INSTALL.md`](docs/INSTALL.md).

## How to use

1. Install Proton Drive CLI and confirm `proton-drive version` works.
2. Launch Aux Proton Drive Bridge.
3. Click **Sign in**.
4. Complete Proton login in the browser.
5. Click **Refresh files**.
6. Select files/folders from `/my-files`.
7. Pick the local destination folder.
8. Click **Download selected**, **Download everything**, or **Upload files/folders**.
9. Check the **Sync** tab to start background sync.
10. View **Conflicts** tab to resolve any detected conflicts.
11. Check the **FUSE Mount** tab for capability status. Proton Drive CLI 0.6.0 reports mounting as unavailable.

Sync never propagates deletion. It restores or preserves the surviving copy according to the selected direction instead of deleting cloud or local data. Skipped transfers remain unresolved and are shown as conflicts.

See full usage guide: [`docs/USAGE.md`](docs/USAGE.md).

## Documentation

- [`docs/INSTALL.md`](docs/INSTALL.md) - install instructions by distro family
- [`docs/USAGE.md`](docs/USAGE.md) - sign-in, list, download, upload, sync, workflow
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) - common Linux/CLI/keyring problems
- [`docs/SECURITY.md`](docs/SECURITY.md) - credential handling and app security model
- [`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md) - current release state and limitations

## Build from source

```bash
npm ci
npm run check
npm start
```

Build local release artifacts:

```bash
npm run check
npm run dist:linux     # Build AppImage, .deb, .rpm on Linux
```

Release outputs are written to `dist/`.

## Security model

Key points:

- Aux Proton Drive Bridge never asks for your Proton password.
- Authentication is delegated to Proton's official CLI/browser flow.
- Renderer `nodeIntegration` is disabled.
- Electron context isolation is enabled.
- CLI calls are executed as argv arrays, not shell strings.
- Credentials and tokens are redacted from logs and stored data.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Roadmap

### v0.3.1

Implemented foundations:

- Sync metadata DB (SQLite)
- Live transfer queue
- Progress parser
- Conflict system
- Bidirectional sync
- Auto-update via GitHub Releases
- Signing/attestation scripts
- File manager integration
- Explicit unsupported FUSE status for CLI 0.6.0, with no speculative mount process
- Desktop notifications
- Conflict review UI with metadata diff viewer

### Future

- AUR packaging - PKGBUILD available in `dist/aur/`
- Flatpak packaging - manifest available in `dist/flatpak/`
- Wider distro qualification
- Desktop notifications for all events
- Advanced conflict diff viewer with content comparison
- Multi-account simultaneous sync

---

## Support

Aux Proton Drive Bridge is free and open source. If it helps your workflow, you can [buy me a coffee](https://www.buymeacoffee.com/auxillo).

