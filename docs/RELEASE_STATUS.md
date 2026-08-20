# Release status

Status: **v0.3.7** - Reliable shutdown, sync correctness, transfer queue, conflict recovery, signed updates, and Linux package targets.

Version: 0.3.7
Release page: <https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/tag/v0.3.7>

## Release gates

A release is valid only when all of these pass from one clean Git revision:

- Source tests/static checks: `npm run check` (unit suite + static checks)
- Dependency audit: `npm audit` - 0 vulnerabilities
- Smokes: `smoke:modules`, `smoke:source`, `smoke:appimage`
- E2E: `e2e:source`, `e2e:restart`, `e2e:packaged`, `e2e:live-installed`, `e2e:ui` (full renderer walk incl. all four sync modes in both directions, live)
- Disposable installed-package tests (`test:installed`) and AUR container validation (`test:aur`)
- Signed checksum set verified with the pinned Ed25519 key (`release:sign:verify`)

## Release assets

- `Aux.Proton.Drive.Bridge-<version>-x86_64.AppImage`
- `Aux.Proton.Drive.Bridge-<version>-amd64.deb`
- `Aux.Proton.Drive.Bridge-<version>-x86_64.rpm`
- `aux-proton-drive-bridge-<version>-source.tar.gz`
- `aux-proton-drive-bridge-<version>-source.zip`
- `aux-proton-drive-bridge-<version>-aur.tar.gz`
- `latest-linux.yml`
- `sbom.cdx.json`
- `release-manifest.json`
- `SHA256SUMS.txt`
- `SHA256SUMS.txt.sig`

The checksum manifest must have a valid Ed25519 signature from the public key in `assets/release-public-key.pem`. The application updater pins the same public key and rejects unsigned or invalid checksum manifests.

## Feature state

| Feature | State |
|---|---|
| Authenticated Proton CLI list, upload, and download | Implemented |
| Serialized and bounded Proton CLI operations | Implemented |
| Persistent SQLite sync metadata | Implemented |
| Transfer queue and retry handling | Implemented |
| No-delete bidirectional sync | Implemented |
| Selective sync excludes fencing both directions | Implemented (0.3.7) |
| Reliable quit / SIGTERM shutdown on Linux | Implemented (0.3.7) |
| Single-instance command deduplication | Implemented (0.3.7) |
| Conflict persistence and deferred resolution | Implemented |
| Signed GitHub release updater | Implemented |
| File manager integration | Implemented |
| AppStream metadata in deb/rpm | Implemented (0.3.7) |
| Automatic recovery for large transfer batches and legacy false conflicts | Implemented |
| AMD Navi 48 startup compatibility | Automatic software-rendering fallback |
| AppImage, DEB, and RPM | Supported release targets |
| AUR metadata | Generated and container-validated per release; AUR publication is separate |
| Flatpak | Not shipped |

## Current limitations

- Linux x64 only.
- Sync never propagates deletion. It preserves or restores the surviving copy.
- Proton Drive CLI 0.6.0 supports one active authenticated account.
- Flatpak remains blocked until there is an authoritative immutable Proton Drive CLI source and an offline sandbox build path.
- GitHub Releases are the public distribution channel. AUR publication remains a separate maintainer action after local release validation.
