# Release status

Status: engineering MVP / private beta foundation.

## Verified gates

- Source unit tests: `npm run check`
- Dependency audit: `npm audit --json`
- Electron source smoke: `npm run smoke:source`

## Required before public 1.0

- Packaged artifact smoke test passes
- AppImage, deb, rpm generated and checksummed
- GitHub Release assets verified
- Bidirectional sync database implemented
- Conflict handling expanded beyond safe skip/merge defaults
- Optional signing/attestation path chosen
