'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const aurDir = path.join(dist, 'aur');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const appImageName = `Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage`;
const appImagePath = path.join(dist, appImageName);
const licensePath = path.join(root, 'LICENSE');
if (!fs.existsSync(appImagePath)) throw new Error(`Missing AppImage: ${appImagePath}`);
const checksum = crypto.createHash('sha256').update(fs.readFileSync(appImagePath)).digest('hex');
const licenseChecksum = crypto.createHash('sha256').update(fs.readFileSync(licensePath)).digest('hex');
const sourceUrl = `https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/download/v${version}/${appImageName}`;

const pkgbuild = `# Maintainer: Auxillo <support@auxillo.tech>
pkgname=aux-proton-drive-bridge-bin
pkgver=${version}
pkgrel=1
pkgdesc="Unofficial Linux desktop bridge for Proton Drive using the official Proton Drive CLI"
arch=('x86_64')
url="https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge"
license=('MIT')
depends=('proton-drive-cli' 'libsecret' 'xdg-utils')
provides=('aux-proton-drive-bridge')
conflicts=('aux-proton-drive-bridge')
options=('!strip')
source=("${appImageName}::${sourceUrl}" 'LICENSE')
sha256sums=('${checksum}' '${licenseChecksum}')

package() {
  install -Dm755 "\${srcdir}/${appImageName}" "\${pkgdir}/opt/aux-proton-drive-bridge/${appImageName}"
  install -dm755 "\${pkgdir}/usr/bin"
  printf '%s\\n' '#!/bin/sh' 'exec "/opt/aux-proton-drive-bridge/${appImageName}" --appimage-extract-and-run "$@"' > "\${pkgdir}/usr/bin/aux-proton-drive-bridge"
  chmod 755 "\${pkgdir}/usr/bin/aux-proton-drive-bridge"
  install -Dm644 "\${srcdir}/LICENSE" "\${pkgdir}/usr/share/licenses/aux-proton-drive-bridge/LICENSE"

  cd "\${srcdir}"
  chmod +x "${appImageName}"
  "./${appImageName}" --appimage-extract >/dev/null
  if compgen -G "squashfs-root/usr/share/applications/*.desktop" > /dev/null; then
    install -Dm644 squashfs-root/usr/share/applications/*.desktop -t "\${pkgdir}/usr/share/applications"
  elif [[ -f squashfs-root/aux-proton-drive-bridge.desktop ]]; then
    install -Dm644 squashfs-root/aux-proton-drive-bridge.desktop "\${pkgdir}/usr/share/applications/aux-proton-drive-bridge.desktop"
  fi
  if [[ -d squashfs-root/usr/share/icons ]]; then
    cp -a squashfs-root/usr/share/icons "\${pkgdir}/usr/share/"
  elif [[ -f squashfs-root/aux-proton-drive-bridge.png ]]; then
    install -Dm644 squashfs-root/aux-proton-drive-bridge.png "\${pkgdir}/usr/share/icons/hicolor/256x256/apps/aux-proton-drive-bridge.png"
  fi
  rm -rf squashfs-root
}
`;

fs.rmSync(aurDir, { recursive: true, force: true });
fs.mkdirSync(aurDir, { recursive: true });
fs.writeFileSync(path.join(aurDir, 'PKGBUILD'), pkgbuild, { mode: 0o644 });
fs.copyFileSync(licensePath, path.join(aurDir, 'LICENSE'));
const srcinfo = `pkgbase = aux-proton-drive-bridge-bin
\tpkgdesc = Unofficial Linux desktop bridge for Proton Drive using the official Proton Drive CLI
\tpkgver = ${version}
\tpkgrel = 1
\turl = https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge
\tarch = x86_64
\tlicense = MIT
\tdepends = proton-drive-cli
\tdepends = libsecret
\tdepends = xdg-utils
\tprovides = aux-proton-drive-bridge
\tconflicts = aux-proton-drive-bridge
\toptions = !strip
\tsource = ${appImageName}::${sourceUrl}
\tsource = LICENSE
\tsha256sums = ${checksum}
\tsha256sums = ${licenseChecksum}

pkgname = aux-proton-drive-bridge-bin
`;
fs.writeFileSync(path.join(aurDir, '.SRCINFO'), srcinfo, { mode: 0o644 });
const archiveName = `aux-proton-drive-bridge-${version}-aur.tar.gz`;
const archivePath = path.join(dist, archiveName);
const commitTime = childProcess.execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
childProcess.execFileSync('tar', [
  '--sort=name', `--mtime=@${commitTime}`, '--owner=0', '--group=0', '--numeric-owner',
  '-czf', archivePath, '-C', dist, 'aur'
]);
console.log(JSON.stringify({ version, appImageName, checksum, archiveName }));
