# Changelog

All notable releases of Aux Proton Drive Bridge are listed here.
The GitHub Releases page is the canonical source for installable artifacts:
https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases

## 0.3.2 - 2026-08-01

Selective sync and the full Auxillo desktop shell.

### Added

- Selective sync: user-defined exclude patterns (`*` within a name, `**` across
  folders), persisted across restarts, editable live from the Sync tab
- Sync mode, poll interval, and last open tab are remembered across restarts

### Changed

- Interface reworked into the Auxillo desktop app shell shared with Aux
  Command: branded topbar, tab strip, status bar, and glass panels
- Inter and JetBrains Mono typefaces are bundled (SIL OFL 1.1) so the UI
  renders identically on every distribution

### Security

- `proton:openFolder` no longer grants filesystem write capability to
  renderer-supplied paths, and the file-manager launch can no longer hang
  the request; the e2e suite now probes this bypass directly

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
