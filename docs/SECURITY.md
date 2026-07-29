# Security model

Aux Proton Drive Bridge is an unofficial desktop bridge over Proton's official `proton-drive` CLI.

## Credential handling

- The app never asks for Proton passwords.
- Login is delegated to `proton-drive auth login`, which opens Proton's browser-based authentication flow.
- Sessions are stored by Proton's CLI in the configured OS secret store, such as libsecret/KWallet/GNOME Keyring or `pass`.
- The app does not store Proton passwords, recovery phrases, 2FA codes, or session JSON.
- Operation logs and sync-event details are redacted for authorization headers, bearer tokens, JWTs, API keys, passwords, cookies, and GitHub tokens before storage.

## Process model

- Renderer `nodeIntegration` is disabled.
- Electron context isolation is enabled.
- The renderer is sandboxed and access is limited to a narrow preload API.
- IPC handlers verify the sender frame and reconstruct allowlisted DTOs instead of forwarding renderer objects.
- Proton CLI commands are executed with argv arrays, not shell-interpolated command strings.
- Proton CLI operations are serialized, queue-bounded, output-bounded, and time-bounded.
- Child processes receive an allowlisted environment that excludes parent-process tokens and credentials.
- IPC path inputs are canonicalized with symlink-aware checks, restricted to the home directory, and accepted only after an application-controlled file picker, saved profile, default location, or explicit desktop-integration command grants that path.
- Renderer assets use a secure custom `app://` protocol instead of privileged `file://` renderer pages.
- Packaged Electron fuses disable Run-as-Node, `NODE_OPTIONS`, inspector flags, and extra `file://` privileges while enforcing ASAR loading and embedded ASAR integrity.

## Sync metadata database

- Sync state is stored in a local SQLite database (`sync-metadata.db`) in the app's user data directory.
- The database uses WAL mode for safe concurrent access.
- File paths and metadata are stored, but no credentials or tokens.

## Update mechanism

- Update checks use GitHub's Releases API over HTTPS. Authentication is optional for private repositories or higher API limits.
- No update is downloaded or installed without explicit user action.
- Downloaded updates are saved to the app's user data directory.
- The updater rejects HTTPS downgrades, oversized responses, unsafe asset names, checksum mismatches, unsigned checksum manifests, and invalid Ed25519 signatures.

## Content Security Policy

The renderer enforces a strict CSP:

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none';
```

This prevents inline script injection, plugin execution, base URI manipulation, and form submissions to external targets.

## Current limitations

- Linux distribution packages are not signed by distro-specific package repositories. Release integrity is provided by the required Ed25519-signed checksum manifest.
- Proton CLI behavior and compatibility depend on Proton's upstream CLI/SDK.
