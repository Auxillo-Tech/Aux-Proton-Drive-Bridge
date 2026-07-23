# Release status

Status: engineering MVP / private beta foundation.

## Current release candidate

- Version: 0.2.1
- GitHub release: <https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/tag/v0.2.1>
- Generated release metadata: `dist/release-manifest.json`
- Canonical checksums: `dist/SHA256SUMS.txt`

Do not copy mutable source-archive hashes into this file; this file is included inside the source archives, so changing it changes the archive digest. The generated manifest/checksum file is the canonical source of artifact hashes.

## Verified gates

- Source tests/static checks: `npm run check` — passed
- Dependency audit: `npm audit --json` — 0 vulnerabilities
- Electron source smoke: `npm run smoke:source` — passed
- Packaged AppImage smoke: `npm run smoke:appimage` — passed
- Artifact checksums: `cd dist && sha256sum -c SHA256SUMS.txt` — passed
- GitHub release manifest downloaded and verified — passed

## Release artifacts

The v0.2.1 release set contains:

- `Aux.Proton.Bridge-0.2.1-x86_64.AppImage`
- `Aux.Proton.Bridge-0.2.1-amd64.deb`
- `Aux.Proton.Bridge-0.2.1-x86_64.rpm`
- `aux-proton-bridge-0.2.1-source.tar.gz`
- `aux-proton-bridge-0.2.1-source.zip`
- `SHA256SUMS.txt`
- `release-manifest.json`

## Current limitations

- Not yet a true bidirectional sync daemon.
- Deletes are not automated.
- Conflict behavior is conservative: folder merge and file skip.
- Linux packages are unsigned.
- Proton CLI behavior depends on Proton's upstream CLI/SDK.
- Wider distro qualification beyond this Fedora 44 x64 build host is still pending.

## Required before public 1.0

- Signed or attested release path chosen
- Persistent sync metadata database implemented
- Conflict review UI implemented
- Background tray/service mode implemented
- Wider distro qualification
- Optional AUR packaging
