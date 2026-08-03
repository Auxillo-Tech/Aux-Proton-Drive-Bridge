# Install Aux Proton Drive Bridge

Aux Proton Drive Bridge is distributed as Linux release artifacts from GitHub Releases.

Release page:

<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>

## Supported targets for v0.3.3

| Linux family | Recommended artifact | Notes |
|---|---|---|
| Debian / Ubuntu / Mint / Pop!_OS | `.deb` | Best native package for Debian-family systems. |
| Fedora / RHEL / Rocky / Alma | `.rpm` | Best native package for Fedora/RHEL-family systems. |
| openSUSE / SUSE | `.rpm` | Should install with `zypper`; verify on target distro. |
| Arch / Manjaro / EndeavourOS | AppImage or validated AUR metadata | AUR publication is handled separately. |
| Other x64 Linux distros | AppImage | Best fallback. |

## Requirements

- Linux x64
- Proton Drive CLI installed and available as `proton-drive`
- A Proton account
- Browser access for Proton login
- Working secret/keyring provider supported by Proton CLI:
 KDE: KWallet
 GNOME/Cinnamon/etc.: GNOME Keyring/libsecret
 other/headless: `pass`, if supported by the CLI

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

Download `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` from the same release as the package. Obtain `assets/release-public-key.pem` and `scripts/release-signing.js` from the exact signed source tag, verify the signed JSON envelope, and then verify only the package you downloaded:

```bash
node scripts/release-signing.js --verify \
  --public assets/release-public-key.pem \
  --file SHA256SUMS.txt \
  --signature SHA256SUMS.txt.sig
grep '  Aux.Proton.Drive.Bridge-0.3.3-amd64.deb$' SHA256SUMS.txt | sha256sum -c -
```

Expected v0.3.3 assets:

```text
Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
Aux.Proton.Drive.Bridge-0.3.3-amd64.deb
Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
aux-proton-drive-bridge-0.3.3-source.tar.gz
aux-proton-drive-bridge-0.3.3-source.zip
aux-proton-drive-bridge-0.3.3-aur.tar.gz
latest-linux.yml
SHA256SUMS.txt
SHA256SUMS.txt.sig
release-manifest.json
sbom.cdx.json
```

The application updater requires the same valid Ed25519 signature before it accepts a checksum manifest.

## Install on Debian / Ubuntu / Mint / Pop!_OS

Download:

```text
Aux.Proton.Drive.Bridge-0.3.3-amd64.deb
```

Option A - graphical install:

1. Double-click the `.deb` file.
2. Install with the distro's Software app/package installer.
3. Launch **Aux Proton Drive Bridge** from the application menu.

Option B - terminal install:

```bash
sudo apt install ./Aux.Proton.Drive.Bridge-0.3.3-amd64.deb
```

If using `dpkg` directly:

```bash
sudo dpkg -i ./Aux.Proton.Drive.Bridge-0.3.3-amd64.deb
sudo apt -f install
```

Uninstall:

```bash
sudo apt remove aux-proton-drive-bridge
```

## Install on Fedora

Download:

```text
Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
```

Install:

```bash
sudo dnf install ./Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
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
sudo dnf install ./Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
```

or on older systems:

```bash
sudo yum install ./Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
```

## Install on openSUSE

Download the `.rpm` asset.

Install:

```bash
sudo zypper install ./Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
```

## Install on Arch / Manjaro / EndeavourOS

Use the AppImage directly, or download and extract `aux-proton-drive-bridge-0.3.3-aur.tar.gz` from the release. The archive contains the validated `PKGBUILD`, native `.SRCINFO`, and license file needed by `makepkg`.

Download:

```text
Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
```

Make it executable:

```bash
chmod +x ./Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
```

Run:

```bash
./Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
```

AUR metadata is validated in an Arch container for each release. Publishing it to the AUR is a separate maintainer action.

## Install file manager actions

After installing the DEB or RPM, run:

```bash
aux-proton-drive-bridge --install-file-manager-integration
```

For the AppImage, pass the same flag to its saved AppImage path. This installs user-local Nautilus, Dolphin, and Thunar actions plus icons under `~/.local`.

## Install on other Linux distributions

Use the AppImage.

```bash
chmod +x ./Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
./Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
```

If AppImage does not launch because FUSE is missing, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Install from source

Use this only for development/testing.

Requirements:

- Node.js 22+
- npm
- Proton Drive CLI

```bash
git clone https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge.git
cd Aux-Proton-Drive-Bridge
npm ci
npm run check
npm start
```

## Build packages from source

```bash
npm ci
npm run check
```

Or step by step:

```bash
npm run smoke:source         # Verify source runs
npm run dist:linux           # Build AppImage, .deb, .rpm on Linux
npm run e2e:packaged         # Exercise the packaged AppImage through CDP
npm run release:source       # Create source archives
npm run release:sbom         # Generate the CycloneDX production SBOM
npm run release:manifest     # Generate release metadata
npm run release:sign         # Generate checksums and required Ed25519 signature
npm run release:sign:verify  # Verify every checksum and the signature
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

- v0.3.3 is x64 only.
- Flatpak is not shipped because Proton Drive CLI 0.6.0 has no authoritative immutable Flatpak source or offline sandbox build path.
- Wider distro qualification is still pending.
