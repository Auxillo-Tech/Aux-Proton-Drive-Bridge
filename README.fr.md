🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · **Français** · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

**Le client de bureau Proton Drive qui manque à Linux.** Parcourez, téléversez, téléchargez et synchronisez votre Proton Drive — avec synchronisation unidirectionnelle et bidirectionnelle, synchronisation sélective, gestion des conflits, file de transferts et versions signées. Construit sur le CLI officiel `proton-drive` de Proton : vos identifiants ne quittent jamais les outils de Proton.

> Projet communautaire non officiel. Sans affiliation, approbation ni parrainage de Proton AG.

![Vue des fichiers](docs/screenshots/files-tab.png)

## Pourquoi ce projet

Proton ne propose pas de client de bureau Proton Drive pour Linux. Son CLI officiel fait le gros du travail, mais vit dans un terminal. Aux Proton Drive Bridge enveloppe ce CLI dans une véritable application de bureau — l'authentification et le chiffrement restent entièrement dans le client de Proton.

## Fonctionnalités

- **Parcourir et transférer** — lister `/my-files`, télécharger la sélection ou tout, téléverser fichiers et dossiers
- **Moteur de synchronisation en arrière-plan** — quatre modes : conservateur (téléversement seul, ignore l'existant), unidirectionnel montant, unidirectionnel descendant, bidirectionnel complet
- **Synchronisation sélective** — les motifs d'exclusion agissent dans les deux sens : les éléments exclus ne sont ni téléversés ni téléchargés
- **Détection et examen des conflits** — modifications des deux côtés, suppression contre modification, conflits de type et de hachage, avec des stratégies sûres ; la synchronisation ne propage jamais les suppressions
- **File de transferts** — transferts concurrents avec priorité, pause/reprise, annulation et historique persistant
- **Profils de sauvegarde unidirectionnelle** — sauvegardes planifiées de dossiers à sémantique conservatrice
- **Intégration au bureau** — zone de notification, menus contextuels des gestionnaires de fichiers (Nautilus, Dolphin, Thunar), métadonnées AppStream pour GNOME Logiciels / KDE Discover
- **Versions signées et mise à jour intégrée** — sommes SHA-256 signées avec une clé Ed25519 épinglée

## Installation

Dernière version : **<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>**

- **AppImage** pour tout Linux x86_64 — rendre exécutable et lancer
- **`.deb`** pour Debian / Ubuntu / Mint / Pop!_OS — `sudo apt install ./<fichier>.deb`
- **`.rpm`** pour Fedora / RHEL / openSUSE — `sudo dnf install ./<fichier>.rpm`
- **Archive AUR** pour Arch (PKGBUILD inclus)

Vérifiez votre téléchargement :

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`SHA256SUMS.txt.sig` est une signature Ed25519 de `SHA256SUMS.txt` (empreinte `2148f39cd1004977cfde1d0a4be7b4fa`, clé publique dans `release-manifest.json`).

## Prérequis

- Linux x86_64
- Proton Drive CLI disponible sous le nom `proton-drive`
- Un compte Proton et un navigateur pour la connexion Proton
- Un coffre à secrets pris en charge par le CLI (KWallet, GNOME Keyring/libsecret ou `pass`)

## Démarrage rapide

1. Installez le Proton Drive CLI et vérifiez que `proton-drive version` fonctionne.
2. Lancez Aux Proton Drive Bridge et cliquez sur **Sign in** — la connexion se termine dans le navigateur.
3. Cliquez sur **Refresh files**, sélectionnez des éléments, choisissez un dossier local, téléchargez ou téléversez.
4. Ouvrez l'onglet **Sync** pour démarrer la synchronisation dans le mode voulu.
5. Examinez ce qui est signalé dans l'onglet **Conflicts**.

Valeurs par défaut sûres : les téléchargements fusionnent les dossiers et ignorent les fichiers existants ; la synchronisation ne supprime jamais rien d'aucun côté.

## Documentation (en anglais)

- [`docs/INSTALL.md`](docs/INSTALL.md) — installation par famille de distribution
- [`docs/USAGE.md`](docs/USAGE.md) — connexion, transferts, modes de synchronisation
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — problèmes courants Linux/CLI/trousseau
- [`docs/SECURITY.md`](docs/SECURITY.md) — gestion des identifiants et modèle de sécurité

## Soutien

Aux Proton Drive Bridge est libre et open source (MIT). S'il vous est utile, vous pouvez [m'offrir un café](https://www.buymeacoffee.com/auxillo) ☕
