🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · **Français** · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

Pont de bureau Linux non officiel pour Proton Drive utilisant la CLI officielle `proton-drive` de Proton.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Statut

Version **`0.3.0`** - Synchronisation complète, file d'attente de transfert, résolution de conflits et prise en charge du montage FUSE.

Aux Proton Drive Bridge offre aux utilisateurs Linux une interface graphique pour les opérations Proton Drive via la CLI officielle de Proton.

## Fonctionnalités principales

- **Base de données de métadonnées de synchronisation** - Suivi SQLite de l'état local et distant de chaque fichier suivi
- **File d'attente de transfert en direct** - Transferts simultanés avec priorité, pause/reprise, annulation, nouvelle tentative
- **Analyseur de progression** - Analyse en temps réel de la sortie CLI de proton-drive pour la progression des transferts
- **Détection et résolution de conflits** - Détecte LOCAL_REMOTE_MODIFY, LOCAL_DELETE_REMOTE_MODIFY, TYPE_MISMATCH, HASH_MISMATCH avec stratégies de résolution
- **Moteur de synchronisation bidirectionnelle** - Surveillance du système de fichiers local via fs.watch + interrogation à distance via CLI
- **Modes de synchronisation** - Conservateur (upload uniquement, ignorer existants), Upload unidirectionnel, Download unidirectionnel, Bidirectionnel
- **Mise à jour automatique** - Vérification et téléchargement des mises à jour basés sur GitHub Releases
- **Signature des versions** - Scripts de signature GPG et signify/minisign
- **Intégration gestionnaire de fichiers** - Scripts de menu contextuel pour Nautilus, Dolphin, Thunar
- **Montage FUSE optionnel** - Monter Proton Drive comme un répertoire du système de fichiers
- **Interface à onglets** - Onglets séparés pour Fichiers, Tableau de bord Sync, Conflits, File d'attente, FUSE et Mises à jour

## Installation rapide

### AppImage
Télécharger et exécuter :
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```
Rendre exécutable et lancer depuis le gestionnaire de fichiers ou le terminal.

### Debian / Ubuntu / Mint / Pop!_OS
Télécharger :
```
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```
Installer avec l'installateur graphique ou avec `apt`/`dpkg`.

### Fedora / RHEL / openSUSE
Télécharger :
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```
Installer avec l'installateur graphique, `dnf`, `zypper` ou `rpm`.

## Configuration requise

- Linux x64
- Proton Drive CLI disponible en tant que `proton-drive`
- Un compte Proton
- Accès au navigateur pour la connexion Proton
- Stockage de secrets Linux pris en charge par Proton CLI (KWallet, GNOME Keyring/libsecret ou `pass`)
- FUSE : optionnel, requis uniquement pour la fonction de montage FUSE

## Modèle de sécurité

Aux Proton Drive Bridge ne demande jamais votre mot de passe Proton. L'authentification est déléguée au flux officiel CLI/navigateur de Proton - les identifiants ne sont pas stockés dans l'application.

---

> Documentation complète en anglais : [README.md](README.md)

---

## Soutien

Si Aux Proton Drive Bridge vous aide, vous pouvez [m'offrir un café](https://www.buymeacoffee.com/auxillo).
