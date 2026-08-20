🌐 [English](README.md) · **Deutsch** · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

**Der Proton-Drive-Desktop-Client, der Linux fehlt.** Durchsuchen, hochladen, herunterladen und synchronisieren Sie Ihr Proton Drive — mit Einweg- und bidirektionaler Synchronisation, selektiver Synchronisation, Konfliktbehandlung, Übertragungswarteschlange und signierten Releases. Aufgebaut auf Protons offiziellem `proton-drive`-CLI: Ihre Zugangsdaten verlassen Protons eigene Werkzeuge nie.

> Inoffizielles Community-Projekt. Nicht mit Proton AG verbunden, von ihr unterstützt oder gesponsert.

![Dateiansicht](docs/screenshots/files-tab.png)

## Warum dieses Projekt

Proton bietet keinen Linux-Desktop-Client für Proton Drive an. Das offizielle CLI erledigt die eigentliche Arbeit, lebt aber im Terminal. Aux Proton Drive Bridge verpackt dieses CLI in eine vollwertige Desktop-App — Authentifizierung und Verschlüsselung bleiben vollständig bei Protons eigenem Client.

## Funktionen

- **Durchsuchen und Übertragen** — `/my-files` auflisten, ausgewählte Elemente oder alles herunterladen, Dateien und Ordner hochladen
- **Hintergrund-Synchronisation** — vier Modi: konservativ (nur Hochladen, Vorhandenes überspringen), Einweg-Hochladen, Einweg-Herunterladen, bidirektional
- **Selektive Synchronisation** — Ausschlussmuster wirken in beide Richtungen: ausgeschlossene Elemente werden weder hoch- noch heruntergeladen
- **Konflikterkennung** — beidseitige Änderungen, Löschen-gegen-Ändern, Typ- und Hash-Konflikte mit sicheren Lösungsstrategien; die Synchronisation löscht niemals Daten
- **Übertragungswarteschlange** — parallele Übertragungen mit Priorität, Pause/Fortsetzen, Abbrechen und dauerhafter Historie
- **Einweg-Backup-Profile** — geplante Ordner-Backups mit konservativer Semantik
- **Desktop-Integration** — Systemtray, Dateimanager-Kontextmenüs (Nautilus, Dolphin, Thunar), AppStream-Metadaten für GNOME Software / KDE Discover
- **Signierte Releases und In-App-Updater** — SHA-256-Prüfsummen, signiert mit festem Ed25519-Schlüssel

## Installation

Neueste Version: **<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>**

- **AppImage** für alle Linux-x86_64-Systeme — ausführbar machen und starten
- **`.deb`** für Debian / Ubuntu / Mint / Pop!_OS — `sudo apt install ./<datei>.deb`
- **`.rpm`** für Fedora / RHEL / openSUSE — `sudo dnf install ./<datei>.rpm`
- **AUR-Tarball** für Arch (PKGBUILD enthalten)

Download prüfen:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`SHA256SUMS.txt.sig` ist eine Ed25519-Signatur über `SHA256SUMS.txt` (Fingerprint `2148f39cd1004977cfde1d0a4be7b4fa`, öffentlicher Schlüssel in `release-manifest.json`).

## Voraussetzungen

- Linux x86_64
- Proton Drive CLI als `proton-drive` verfügbar
- Ein Proton-Konto und ein Browser für Protons Login
- Ein vom Proton-CLI unterstützter Schlüsselspeicher (KWallet, GNOME Keyring/libsecret oder `pass`)

## Schnellstart

1. Proton Drive CLI installieren und `proton-drive version` prüfen.
2. Aux Proton Drive Bridge starten und auf **Sign in** klicken — der Login läuft im Browser.
3. **Refresh files** klicken, Elemente auswählen, lokalen Ordner wählen, herunter- oder hochladen.
4. Im **Sync**-Tab die Hintergrund-Synchronisation im gewünschten Modus starten.
5. Gemeldete Konflikte im **Conflicts**-Tab prüfen.

Sichere Standardwerte: Downloads führen Ordner zusammen und überspringen vorhandene Dateien; die Synchronisation löscht auf keiner Seite Daten.

## Dokumentation (Englisch)

- [`docs/INSTALL.md`](docs/INSTALL.md) — Installation je Distributionsfamilie
- [`docs/USAGE.md`](docs/USAGE.md) — Anmeldung, Übertragungen, Sync-Modi
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — häufige Linux-/CLI-/Keyring-Probleme
- [`docs/SECURITY.md`](docs/SECURITY.md) — Umgang mit Zugangsdaten und Sicherheitsmodell

## Unterstützung

Aux Proton Drive Bridge ist frei und quelloffen (MIT). Wenn es Ihnen hilft, können Sie [einen Kaffee spendieren](https://www.buymeacoffee.com/auxillo) ☕
