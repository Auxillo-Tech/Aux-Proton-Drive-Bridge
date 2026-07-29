# Changelog

All notable releases of Aux Proton Drive Bridge are listed here.
The GitHub Releases page is the canonical source for installable artifacts:
https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases

## 0.3.1 - 2026-07-29

Public Linux release line for the Proton Drive desktop bridge.

### Highlights

- Signed AppImage, `.deb`, and `.rpm` packages plus source archives
- Auxillo brand UI alignment
- FUSE mount capability gated when the Proton CLI has no mount support
- Release integrity via `SHA256SUMS.txt` + detached signature and `release-public-key.pem`
- CycloneDX SBOM and AUR metadata package included with the release

### Notes

- Unofficial bridge using Proton's official CLI
- Not affiliated with, endorsed by, or sponsored by Proton AG

## 0.2.1 - 2026-07-23

Background and tray foundation.

### Added

- System tray entry with show / run backup now / quit actions
- Close-to-tray behavior
- Background scheduler foundation for enabled backup profiles
- Conservative scheduler defaults: upload only, skip existing, merge folders, no delete propagation

### Included from 0.2.0

- Persistent local operation history and transfer history UI
- Redacted operation storage
- Conservative one-way backup profile UI

## 0.2.0 - 2026-07-23

Persistent operation history and one-way backup profile foundation.

## 0.1.0 - 2026-07-23

Initial engineering release of the Linux Proton Drive bridge.
