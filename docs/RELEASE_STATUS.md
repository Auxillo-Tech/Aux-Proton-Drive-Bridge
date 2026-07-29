# Release status

Status: **v0.3.0** - Full-featured sync, transfer queue, conflict resolution, FUSE mount, and auto-update.

Version: 0.3.1
Publication: not yet published to GitHub Releases
Release page after publication: <https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/tag/v0.3.1>

## Release gates

A v0.3.1 release is valid only when all of these commands pass from one clean Git revision:

- Source tests/static checks: `npm run check` - passed
- Dependency audit: `npm audit --json` - 0 vulnerabilities (verified)

## Release assets

- `Aux.Proton.Drive.Bridge-0.3.1-x86_64.AppImage`
- `Aux.Proton.Drive.Bridge-0.3.1-amd64.deb`
- `Aux.Proton.Drive.Bridge-0.3.1-x86_64.rpm`
- `aux-proton-drive-bridge-0.3.1-source.tar.gz`
- `aux-proton-drive-bridge-0.3.1-source.zip`
- `aux-proton-drive-bridge-0.3.1-aur.tar.gz`
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
| Conflict persistence and deferred resolution | Implemented |
| Signed GitHub release updater | Implemented |
| File manager integration | Implemented |
| Explicit unsupported mount status | Implemented |
| Native FUSE mount with Proton Drive CLI 0.6.0 | Unavailable because the CLI has no mount command |
| AppImage, DEB, and RPM | Supported release targets |
| AUR metadata | Generated and container-validated per release; AUR publication is separate |
| Flatpak | Not shipped |

## Current limitations

- Linux x64 only.
- Sync never propagates deletion. It preserves or restores the surviving copy.
- Proton Drive CLI 0.6.0 supports one active authenticated account and exposes no mount command.
- Flatpak remains blocked until there is an authoritative immutable Proton Drive CLI source and an offline sandbox build path.
- GitHub publication and AUR publication are maintainer actions performed after local release validation.
