# Security model

Aux Proton Bridge is an unofficial desktop bridge over Proton's official `proton-drive` CLI.

## Credential handling

- The app never asks for Proton passwords.
- Login is delegated to `proton-drive auth login`, which opens Proton's browser-based authentication flow.
- Sessions are stored by Proton's CLI in the configured OS secret store, such as libsecret/KWallet/GNOME Keyring or `pass`.
- The app does not store Proton passwords, recovery phrases, 2FA codes, or session JSON.

## Process model

- Renderer `nodeIntegration` is disabled.
- Electron context isolation is enabled.
- Renderer access is limited to a narrow preload API.
- Proton CLI commands are executed with argv arrays, not shell-interpolated command strings.
- Proton CLI operations are serialized to reduce SQLite cache-lock conflicts.

## Current limitations

- This is not yet a true bidirectional sync daemon.
- Deletes are manual and should stay conservative until conflict metadata is implemented.
- Packaging is currently unsigned.
- Proton CLI behavior and compatibility depend on Proton's upstream CLI/SDK.
