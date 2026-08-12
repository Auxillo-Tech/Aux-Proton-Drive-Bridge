# Release status

Status: **v0.3.6 local release candidate** - Reliable sync, transfer queue, conflict recovery, signed updates, and Linux package targets.

Version: 0.3.6
Publication: not yet published; the current public release remains v0.3.5
Planned release page: <https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/tag/v0.3.6>

## Release gates

A v0.3.6 release is valid only when all of these commands pass from one clean Git revision:

- Source tests/static checks: pending final v0.3.6 verification
- Dependency audit: `npm audit --json` - 0 vulnerabilities
- Source and installed-package results are recorded only after the final matrix completes

## Release assets

- `Aux.Proton.Drive.Bridge-0.3.6-x86_64.AppImage`
- `Aux.Proton.Drive.Bridge-0.3.6-amd64.deb`
- `Aux.Proton.Drive.Bridge-0.3.6-x86_64.rpm`
- `aux-proton-drive-bridge-0.3.6-source.tar.gz`
- `aux-proton-drive-bridge-0.3.6-source.zip`
- `aux-proton-drive-bridge-0.3.6-aur.tar.gz`
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
