🌐 [English](README.md) · **Deutsch** · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

Inoffizielle Linux-Desktop-Brücke für Proton Drive, die das offizielle `proton-drive` CLI von Proton verwendet.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Status

Version **`0.3.0`** - Voll ausgestattete Synchronisation, Übertragungswarteschlange, Konfliktlösung und FUSE-Mount-Unterstützung.

Aux Proton Drive Bridge bietet Linux-Anwendern eine grafische Oberfläche für Proton-Drive-Operationen über das offizielle Proton-CLI.

## Hauptfunktionen

- **Sync-Metadaten-DB** - SQLite-gestützte Nachverfolgung des lokalen und entfernten Status jeder synchronisierten Datei
- **Live-Übertragungswarteschlange** - Gleichzeitige Übertragungen mit Priorität, Pause/Fortsetzen, Abbrechen, Wiederholen
- **Fortschrittsanalyse** - Echtzeit-Analyse der proton-drive CLI-Ausgabe für Übertragungsfortschritt
- **Konflikterkennung und -lösung** - Erkennt LOCAL_REMOTE_MODIFY, LOCAL_DELETE_REMOTE_MODIFY, TYPE_MISMATCH, HASH_MISMATCH mit Lösungsstrategien
- **Bidirektionale Synchronisation** - Lokale Dateisystemüberwachung via fs.watch + Fernabfrage via CLI
- **Synchronisationsmodi** - Konservativ (nur Hochladen, Vorhandenes überspringen), Einweg-Hochladen, Einweg-Herunterladen, Bidirektional
- **Auto-Update** - GitHub-Releases-basierte Update-Prüfung und -Download
- **Release-Signierung** - GPG- und signify/minisign-Signierungsskripte
- **Dateimanager-Integration** - Kontextmenü-Skripte für Nautilus, Dolphin, Thunar
- **Optionaler FUSE-Mount** - Proton Drive als Dateisystemverzeichnis einbinden
- **Registerkarten-Oberfläche** - Separate Tabs für Dateien, Sync-Dashboard, Konflikte, Warteschlange, FUSE und Updates

## Schnellinstallation

### AppImage
Herunterladen und ausführen:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```
Ausführbar machen und aus dem Dateimanager oder Terminal starten.

### Debian / Ubuntu / Mint / Pop!_OS
Herunterladen:
```
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```
Installation mit dem grafischen Paketmanager oder `apt`/`dpkg`.

### Fedora / RHEL / openSUSE
Herunterladen:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```
Installation mit dem grafischen Paketmanager, `dnf`, `zypper` oder `rpm`.

## Systemvoraussetzungen

- Linux x64
- Proton Drive CLI als `proton-drive` verfügbar
- Ein Proton-Konto
- Browserzugang für die Proton-Anmeldung
- Linux-Secrets-Speicher, der von Proton CLI unterstützt wird (KWallet, GNOME Keyring/libsecret oder `pass`)
- FUSE: optional, nur für die FUSE-Mount-Funktion erforderlich

## Sicherheitsmodell

Aux Proton Drive Bridge fragt niemals nach Ihrem Proton-Passwort. Die Authentifizierung wird an das offizielle Proton-CLI/Browser-Flow delegiert - Anmeldeinformationen werden nicht in der App gespeichert.

---

> Vollständige Dokumentation auf Englisch: [README.md](README.md)

---

## Unterstützung

Wenn Aux Proton Drive Bridge hilfreich ist, kannst du mir einen [Kaffee ausgeben](https://www.buymeacoffee.com/auxillo).
