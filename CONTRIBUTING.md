# Contributing to Aux Proton Drive Bridge

Aux Proton Drive Bridge is free open-source software under the MIT License. Contributions are welcome.

## Types of contributions

- **Bug reports** - open an issue with reproduction steps, expected vs actual behavior, and environment details.
- **Security reports** - follow `SECURITY.md`; do not open a public issue for vulnerabilities.
- **Code contributions** - pull request workflow below.
- **Documentation** - README, INSTALL, USAGE, and troubleshooting improvements.

## Pull request workflow

1. Work from a feature branch based on `main`.
2. Run validation before opening a PR:
   ```bash
   npm ci
   npm test
   ```
3. Describe the change clearly, including security or compatibility impact.
4. Keep Proton authentication delegated to the official `proton-drive` CLI. Do not add password capture in the app.
5. CI / checks should pass before merge.

## Code standards

- Electron main process and preload stay tightly scoped.
- Prefer argv arrays for CLI execution (no shell-interpolated Proton commands).
- Do not log secrets, tokens, or session material.
- Path inputs that touch the filesystem must stay within safe roots.
- Keep renderer free of Node integration; use the existing preload bridge.

## Security-sensitive areas

Changes in these areas need extra review:

- Proton CLI invocation and environment handling
- path validation for upload/download/mount
- sync metadata database
- auto-update and release verification
- Electron `webPreferences`, CSP, and preload surface

## License

By contributing, you agree that your contributions are licensed under the MIT License.

## Code of Conduct

Please read and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
