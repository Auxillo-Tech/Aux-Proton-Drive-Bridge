# Security model

Aux Proton Drive Bridge is an unofficial desktop bridge over Proton's official `proton-drive` CLI.

## Credential handling

- The app never asks for Proton passwords.
- Login is delegated to `proton-drive auth login`, which opens Proton's browser-based authentication flow.
- Sessions are stored by Proton's CLI in the configured OS secret store, such as libsecret/KWallet/GNOME Keyring or `pass`.
- The app does not store Proton passwords, recovery phrases, 2FA codes, or session JSON.
- All operation logs are automatically redacted for auth tokens, JWTs, and GitHub tokens before storage.

## Process model

- Renderer `nodeIntegration` is disabled.
- Electron context isolation is enabled.
- Renderer access is limited to a narrow preload API (specific IPC channels only).
- Proton CLI commands are executed with argv arrays, not shell-interpolated command strings.
- Proton CLI operations are serialized to prevent SQLite cache-lock conflicts.
- IPC path inputs (upload/download paths) are validated to be within the home directory.

## Sync metadata database

- Sync state is stored in a local SQLite database (`sync-metadata.db`) in the app's user data directory.
- The database uses WAL mode for safe concurrent access.
- File paths and metadata are stored, but no credentials or tokens.

## Update mechanism

- Update checks use GitHub's Releases API with authenticated requests (via `gh auth token` or environment variable).
- No update is downloaded or installed without explicit user action.
- Downloaded updates are saved to the app's user data directory.

## Content Security Policy

The renderer enforces a strict CSP:

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none';
```

This prevents inline script injection, plugin execution, base URI manipulation, and form submissions to external targets.

## Current limitations

- Packaging is not yet signed for all distributions. Signing scripts (`scripts/sign-release.sh`) are included for GPG and signify/minisign.
- Proton CLI behavior and compatibility depend on Proton's upstream CLI/SDK.
