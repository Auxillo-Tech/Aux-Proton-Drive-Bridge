# Install Aux Proton Bridge

Aux Proton Bridge is distributed as Linux release artifacts from GitHub Releases.

Release page:

<https://github.com/Auxillo-Tech/Aux-proton-drive-bridge/releases/tag/v0.1.0>

> The repository/release may be private until Auxillo changes repository visibility to public.

## Supported targets for v0.1.0

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

Expected v0.1.0 assets:

```text
Aux.Proton.Bridge-0.1.0-x86_64.AppImage
Aux.Proton.Bridge-0.1.0-amd64.deb
Aux.Proton.Bridge-0.1.0-x86_64.rpm
aux-proton-bridge-0.1.0-source.tar.gz
aux-proton-bridge-0.1.0-source.zip
SHA256SUMS.txt
release-manifest.json
```

## Install on Debian / Ubuntu / Mint / Pop!_OS

Download:

```text
Aux.Proton.Bridge-0.1.0-amd64.deb
```

Option A — graphical install:

1. Double-click the `.deb` file.
2. Install with the distro's Software app/package installer.
3. Launch **Aux Proton Bridge** from the application menu.

Option B — terminal install:

```bash
sudo apt install ./Aux.Proton.Bridge-0.1.0-amd64.deb
```

If using `dpkg` directly:

```bash
sudo dpkg -i ./Aux.Proton.Bridge-0.1.0-amd64.deb
sudo apt -f install
```

Uninstall:

```bash
sudo apt remove aux-proton-bridge
```

## Install on Fedora

Download:

```text
Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

Install:

```bash
sudo dnf install ./Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

Launch **Aux Proton Bridge** from the application menu.

Uninstall:

```bash
sudo dnf remove aux-proton-bridge
```

## Install on RHEL / Rocky / Alma

Download the `.rpm` asset.

Install:

```bash
sudo dnf install ./Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

or on older systems:

```bash
sudo yum install ./Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

## Install on openSUSE

Download the `.rpm` asset.

Install:

```bash
sudo zypper install ./Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

## Install on Arch / Manjaro / EndeavourOS

Use the AppImage for v0.1.0.

Download:

```text
Aux.Proton.Bridge-0.1.0-x86_64.AppImage
```

Make it executable:

```bash
chmod +x ./Aux.Proton.Bridge-0.1.0-x86_64.AppImage
```

Run:

```bash
./Aux.Proton.Bridge-0.1.0-x86_64.AppImage
```

Future work: AUR package.

## Install on other Linux distributions

Use the AppImage.

```bash
chmod +x ./Aux.Proton.Bridge-0.1.0-x86_64.AppImage
./Aux.Proton.Bridge-0.1.0-x86_64.AppImage
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
npm run smoke:source
npm run dist:x64
npm run release:source
npm run release:manifest
npm run smoke:appimage
```

Artifacts appear in:

```text
dist/
```

## First run after install

1. Launch **Aux Proton Bridge**.
2. Click **Sign in**.
3. Complete Proton login in your browser.
4. Return to the app.
5. Click **Refresh files**.
6. Choose a local folder.
7. Download or upload.

## Current packaging limitations

- v0.1.0 packages are unsigned.
- v0.1.0 is x64 only.
- AppImage is the fallback for distros without `.deb`/`.rpm` support.
- Wider distro qualification is still pending.
