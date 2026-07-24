# Install Aux Proton Drive Bridge

Aux Proton Drive Bridge is distributed as Linux release artifacts from GitHub Releases.

Release page:

<https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/tag/v0.3.0>

> The repository/release may be private until Auxillo changes repository visibility to public.

## Supported targets for v0.3.0

| Linux family | Recommended artifact | Notes |
|---|---|---|
| Debian / Ubuntu / Mint / Pop!_OS | `.deb` | Best native package for Debian-family systems. |
| Fedora / RHEL / Rocky / Alma | `.rpm` | Best native package for Fedora/RHEL-family systems. |
| openSUSE / SUSE | `.rpm` | Should install with `zypper`; verify on target distro. |
| Arch / Manjaro / EndeavourOS | AppImage | AUR packaging is future work. |
| Other x64 Linux distros | AppImage | Best fallback. |

## Requirements

- Linux x64
- Proton Drive CLI installed and available as `proton-drive`
- A Proton account
- Browser access for Proton login
- Working secret/keyring provider supported by Proton CLI:
  - KDE: KWallet
  - GNOME/Cinnamon/etc.: GNOME Keyring/libsecret
  - other/headless: `pass`, if supported by the CLI

Check Proton CLI:

```bash
proton-drive version
```

Check login/list manually if needed:

```bash
proton-drive auth login
proton-drive filesystem list /my-files
```

## Verify downloaded release files

Download `SHA256SUMS.txt` from the same release as the package, then verify from the folder containing the artifacts:

```bash
sha256sum -c SHA256SUMS.txt
```

Expected v0.3.0 assets:

```text
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
aux-proton-drive-bridge-0.3.0-source.tar.gz
aux-proton-drive-bridge-0.3.0-source.zip
SHA256SUMS.txt
release-manifest.json
```

Release assets also include GPG signatures (`.asc`) and/or signify signatures (`.sig`) when published.

## Install on Debian / Ubuntu / Mint / Pop!_OS

Download:

```text
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```

Option A — graphical install:

1. Double-click the `.deb` file.
2. Install with the distro's Software app/package installer.
3. Launch **Aux Proton Drive Bridge** from the application menu.

Option B — terminal install:

```bash
sudo apt install ./Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```

If using `dpkg` directly:

```bash
sudo dpkg -i ./Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
sudo apt -f install
```

Uninstall:

```bash
sudo apt remove aux-proton-drive-bridge
```

## Install on Fedora

Download:

```text
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```

Install:

```bash
sudo dnf install ./Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```

Launch **Aux Proton Drive Bridge** from the application menu.

Uninstall:

```bash
sudo dnf remove aux-proton-drive-bridge
```

## Install on RHEL / Rocky / Alma

Download the `.rpm` asset.

Install:

```bash
sudo dnf install ./Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```

or on older systems:

```bash
sudo yum install ./Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```

## Install on openSUSE

Download the `.rpm` asset.

Install:

```bash
sudo zypper install ./Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```

## Install on Arch / Manjaro / EndeavourOS

Use the AppImage for v0.3.0.

Download:

```text
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```

Make it executable:

```bash
chmod +x ./Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```

Run:

```bash
./Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```

Future work: AUR package.

## Install on other Linux distributions

Use the AppImage.

```bash
chmod +x ./Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
./Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```

If AppImage does not launch because FUSE is missing, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Install from source

Use this only for development/testing.

Requirements:

- Node.js 22+
- npm
- Proton Drive CLI

```bash
git clone https://github.com/Auxillo-Tech/Aux-proton-drive-bridge.git
cd Aux-proton-drive-bridge
npm install
npm run check
npm start
```

## Build packages from source

```bash
npm install
npm run check
npm run release:all          # Build, sign, and generate manifest
```

Or step by step:

```bash
npm run smoke:source         # Verify source runs
npm run dist:x64             # Build AppImage, .deb, .rpm
npm run release:source       # Create source archives
npm run release:manifest     # Generate SHA256SUMS + release manifest
npm run release:sign         # GPG/signify sign all artifacts
npm run smoke:appimage       # Verify packaged AppImage
```

Artifacts appear in:

```text
dist/
```

## First run after install

1. Launch **Aux Proton Drive Bridge**.
2. Click **Sign in**.
3. Complete Proton login in your browser.
4. Return to the app.
5. Click **Refresh files**.
6. Choose a local folder.
7. Download or upload.

## Updating to a newer version

When a new release is available:

**AppImage:** Download the new `.AppImage` and replace the old file.

**Debian/Ubuntu:** `sudo apt install ./Aux.Proton.Drive.Bridge-*.deb`

**Fedora/RHEL:** `sudo rpm -Uvh ./Aux.Proton.Drive.Bridge-*.rpm`

You can also use the **Updates** tab in the app to check for and download new versions automatically.

## Current packaging limitations

- v0.3.0 is x64 only.
- Wider distro qualification is still pending.
