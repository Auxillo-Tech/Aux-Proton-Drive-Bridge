# Release status

Status: **v0.3.0** — Full-featured sync, transfer queue, conflict resolution, FUSE mount, and auto-update.

## v0.3.0

Version: 0.3.0
GitHub release: <https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/tag/v0.3.0>

## Verified gates

- Source tests/static checks: `npm run check` — passed
- Dependency audit: `npm audit --json` — 0 vulnerabilities (verified)

## New in v0.3.0

| Feature | Status |
|---|---|
| Sync metadata DB (SQLite) | ✅ |
| Live transfer queue | ✅ |
| Progress parser | ✅ |
| Conflict detection & resolution | ✅ |
| Bidirectional sync engine | ✅ |
| Local filesystem watching | ✅ |
| Remote state polling | ✅ |
| GitHub Releases auto-update | ✅ |
| Release signing (GPG + signify) | ✅ |
| File manager integration (Nautilus/Dolphin/Thunar) | ✅ |
| Optional FUSE mount | ✅ |
| Tabbed UI with dashboards | ✅ |
| Renamed to Aux Proton Drive Bridge | ✅ |
| Auxillo brand mark logo | ✅ |

## v0.2.1 features (carried forward)

- CLI status detection
- Browser-based Proton login
- File/folder listing of `/my-files`
- Download selected, download all, upload
- Custom local folder selection
- One-way backup profile with scheduler (30 min)
- Persistent operation history
- Activity log
- System tray with quick actions and background mode
- Electron security: contextIsolation, no nodeIntegration
- CLI operation serialization to reduce cache lock conflicts
- Credential redaction from stored data
- All source/config renamed from `aux-proton-bridge` → `aux-proton-drive-bridge`

## Release artifacts (v0.3.0)

- `Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage`
- `Aux.Proton.Drive.Bridge-0.3.0-amd64.deb`
- `Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm`
- `aux-proton-drive-bridge-0.3.0-source.tar.gz`
- `aux-proton-drive-bridge-0.3.0-source.zip`
- `SHA256SUMS.txt`
- `release-manifest.json`
- GPG signatures (`.asc`) and/or signify signatures (`.sig`)

## Current limitations

- Bidirectional sync is experimental. Start with Conservative mode.
- FUSE mount depends on proton-drive CLI mount capabilities.
- Conflict review UI is basic (text-based resolution buttons).
- AUR and Flatpak packaging still pending.
- Wider distro qualification beyond Fedora 44 x64 build host still pending.

## Required before public 1.0

- [x] Signed or attested release path chosen
- [x] Persistent sync metadata database implemented
- [x] Conflict review UI implemented
- [x] Background tray/service mode implemented
- [x] Live transfer queue with concurrency
- [x] Progress reporting
- [x] Bidirectional sync engine
- [x] Auto-update mechanism
- [x] File manager integration
- [ ] Wider distro qualification
- [ ] AUR packaging
- [ ] Flatpak packaging
