# Install Aux Proton Bridge

## Requirements

- Linux x64
- Proton Drive CLI installed as `proton-drive`
- Working Linux secret store for Proton CLI authentication: KWallet, GNOME Keyring/libsecret, or `pass`

## Artifacts

Release builds provide:

- AppImage for broad Linux compatibility
- `.deb` for Debian/Ubuntu-family systems
- `.rpm` for Fedora/RHEL/openSUSE-family systems
- `SHA256SUMS.txt`
- `release-manifest.json`

## First run

1. Open Aux Proton Bridge.
2. If not authenticated, click **Sign in**.
3. Complete Proton login in the browser.
4. Click **Refresh files**.
5. Select folders and download them to the chosen local folder.

## Safe transfer defaults

- Folder conflicts: merge
- File conflicts: skip

This prevents overwriting existing local files during early testing.
