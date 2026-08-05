# Changelog

All notable releases of Aux Proton Drive Bridge are listed here.
The GitHub Releases page is the canonical source for installable artifacts:
https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases

## 0.3.4 - 2026-08-05

Auth and session reliability fix, plus first-time local/remote pairing.

### Fixed

- Electron no longer strips desktop session env vars (`XAUTHORITY`,
  `XDG_CURRENT_DESKTOP`, KDE/Qt keys) required for Proton CLI browser login
- Sign-in now opens the Proton login URL through Electron when the CLI prints it,
  so login works even when the spawned CLI cannot launch a browser itself
- Log out treats already-signed-out sessions as success and recovers when the
  CLI process is killed mid-logout (`exited null`)
- Interrupted/running operation history is recovered on startup instead of
  leaving logout/list stuck forever
- Auth buttons ignore spam clicks while another action is already running
- Status refresh can force a live CLI probe after login/logout
- Sync start warns when tens of thousands of local items are pending
- After a bulk download, paths already present on both sides with the same type
  and size are paired as synced instead of becoming thousands of `both_create`
  conflicts or re-upload attempts for hundreds of GB

## 0.3.3 - 2026-08-03

Large sync-tree stability fix.

### Fixed

- Local and remote scans now yield to Electron's event loop instead of freezing
  the window while large trees are processed. Ignored and symbolic-link entries
  are also counted, bounded, and included in cooperative scheduling
- Stopping sync now cancels cooperative local and remote scan processing promptly
- Large directories are enumerated asynchronously, and filtered tracked rows still
  participate in cooperative yielding and cancellation
- A restart requested while `stop()` is still settling is rejected explicitly,
  preventing a lost initial cycle or stale `stopped` event
- Filesystem watcher transfers are deferred while an authoritative synchronization
  cycle is scanning and remain deferred if the remote poll is skipped or fails,
  preventing uploads before remote conflict discovery completes
- JSON remote snapshots now fail closed on empty output, malformed JSON, non-array
  roots, or invalid rows; only a successfully parsed literal `[]` means an empty folder
- Sync startup no longer scans the local tree twice
- Full scans emit one summary event instead of flooding the renderer with one
  event per created, modified, or deleted item
- Conflict detection now uses immutable last-synced hashes, preventing a
  same-size, same-timestamp local edit from being overwritten when both sides change
- Remote synchronization now tracks Proton's verified SHA-1 revision digest, so
  same-size, same-timestamp remote edits participate in order-independent conflict
  detection without losing the latest local or remote observations
- Large remote JSON listings are parsed in a worker while traversal yields between
  entries, preventing flat directories from blocking Electron's main event loop
- Version 4 databases migrate missing synchronized remote hashes conservatively as
  `legacy:unknown`; the first verified digest remains an unresolved remote change
  until synchronization or conflict resolution establishes a trusted baseline
- Versioned local fingerprints combine sampled content, file size, and filesystem
  change time so normal edits remain detectable when size and modification time
  are preserved, including edits beyond the first 64 KiB and files over 100 MiB
- Remote snapshots support up to 100,000 items, use constant-time queue traversal,
  and emit one summarized renderer event per poll
- Transfer output is emitted once per line, operation-history progress writes are
  rate-limited using the queue's production payload fields while preserving structured
  errors and terminal updates, and the renderer activity log uses constant-time appends
  capped at 500 lines
- Periodic scan failures are reported without leaving rejected timer promises unhandled

### Changed

- Unchanged local entries are no longer rewritten on every poll
- Sync event retention now prunes old records using the event ID boundary
- Sync metadata schema 6 stores independent last-synced local and remote hash baselines
  plus a persistent post-upload verification snapshot
- Watcher events invalidate an active authoritative listing immediately on receipt,
  before content debounce, and always request a fresh remote cycle; they never schedule
  uploads directly after skipped, failed, or stale remote observations
- Completed uploads remain uncommitted until an authoritative remote listing exposes a
  verified SHA-1 digest matching the uploaded local file, preventing stale-baseline
  reverse transfers and false conflicts
- Post-upload verification fails closed when local content changes or the remote digest
  differs, and clears obsolete pending conflict-resolution intent before recording the
  new conflict
- A remote snapshot captured before upload completion is superseded before reconciliation
  and cannot verify that upload or advance synchronized baselines
- A local edit during post-upload verification clears verification ownership, invalidates
  in-flight snapshots, pins the cancelled upload's expected remote digest at enqueue with a
  single `sha1:` prefix (preserved across beginUploadVerification), adopts only a matching
  remote revision as a re-upload baseline, conflicts on third-party remote digests (including
  when the pin is missing and remote advanced past last sync), skips false remote-delete
  conflicts while reupload is pending, does not false-conflict when a prior own revision is
  still listed during a successor upload/verification, cancels into reupload when the local
  file changes during the in-flight transfer before verification starts, and still converges
  after the new content is uploaded and verified, including previously synced files
- Post-upload verification waits when the listing still shows the last-synced remote
  (including before the async content pin lands, including size-changing uploads, and even
  if a stale pin still names that prior own revision), beginUploadVerification clears stale
  pins so complete re-pins the just-uploaded content, and reupload-pending paths no longer
  treat that last-synced remote as a third-party edit
- Each path tracks its latest in-flight upload transfer id so a stale complete from an
  earlier transfer (after an edit-driven re-enqueue) cannot bind verification or open a
  false hash_mismatch conflict
- Digests from our own uploads (including superseded intermediates) are remembered so a
  successor verification waits when the listing still shows an intermediate own revision
  instead of sticky-conflicting
- Own intermediate upload digests are durable in sync metadata schema 9 (`own_upload_digests`)
  so restart during successor verification lag does not sticky-conflict
- Upload complete binds verification to the pre-complete local intent: a quiet post-transfer
  edit cancels into reupload instead of verifying the wrong bytes against the finished upload
- Size-changing upload verification also waits when the listing still reports the last-synced
  size without a verified remote digest (digest lag after size update)
- The transitive `brace-expansion` build dependency is pinned to `5.0.9`, addressing
  `GHSA-rgw5-rvv9-x895`
- The transitive `fast-uri` build dependency is pinned to `3.1.5`, addressing
  `GHSA-7p8r-x3mc-p8w7`
- The AUR package installs the extracted application payload without requiring FUSE,
  declares its Electron runtime dependencies, and has disposable build, install,
  launch, and uninstall coverage
- Release smoke tests always create isolated user-data, HOME, and XDG directories,
  remove inherited credentials, use a fake Proton CLI, and cannot migrate or modify
  the operator's production profile
- Renderer transfer refreshes and file chooser actions report promise failures instead
  of leaving rejected IPC calls unhandled

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
