🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · **Español** · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

**El cliente de escritorio de Proton Drive que le falta a Linux.** Explora, sube, descarga y sincroniza tu Proton Drive — con sincronización unidireccional y bidireccional, sincronización selectiva, gestión de conflictos, cola de transferencias y versiones firmadas. Construido sobre el CLI oficial `proton-drive` de Proton: tus credenciales nunca salen de las herramientas de Proton.

> Proyecto comunitario no oficial. Sin afiliación, respaldo ni patrocinio de Proton AG.

![Vista de archivos](docs/screenshots/files-tab.png)

## Por qué existe

Proton no ofrece un cliente de escritorio de Proton Drive para Linux. Su CLI oficial hace el trabajo pesado, pero vive en la terminal. Aux Proton Drive Bridge envuelve ese CLI en una aplicación de escritorio completa — la autenticación y el cifrado permanecen por completo en el cliente de Proton.

## Características

- **Explorar y transferir** — listar `/my-files`, descargar elementos seleccionados o todo, subir archivos y carpetas
- **Motor de sincronización en segundo plano** — cuatro modos: conservador (solo subida, omite existentes), subida unidireccional, descarga unidireccional y bidireccional completo
- **Sincronización selectiva** — los patrones de exclusión actúan en ambas direcciones: lo excluido no se sube ni se descarga
- **Detección y revisión de conflictos** — modificaciones en ambos lados, borrar-contra-modificar, conflictos de tipo y de hash, con estrategias seguras; la sincronización nunca propaga borrados
- **Cola de transferencias** — transferencias concurrentes con prioridad, pausa/reanudación, cancelación e historial persistente
- **Perfiles de copia de seguridad unidireccional** — copias programadas de carpetas con semántica conservadora
- **Integración de escritorio** — bandeja del sistema, menús contextuales del gestor de archivos (Nautilus, Dolphin, Thunar), metadatos AppStream para GNOME Software / KDE Discover
- **Versiones firmadas y actualizador integrado** — sumas SHA-256 firmadas con una clave Ed25519 fija

## Instalación

Última versión: **<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>**

- **AppImage** para cualquier Linux x86_64 — dar permisos de ejecución y ejecutar
- **`.deb`** para Debian / Ubuntu / Mint / Pop!_OS — `sudo apt install ./<archivo>.deb`
- **`.rpm`** para Fedora / RHEL / openSUSE — `sudo dnf install ./<archivo>.rpm`
- **Tarball AUR** para Arch (PKGBUILD incluido)

Verifica tu descarga:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`SHA256SUMS.txt.sig` es una firma Ed25519 sobre `SHA256SUMS.txt` (huella `2148f39cd1004977cfde1d0a4be7b4fa`, clave pública en `release-manifest.json`).

## Requisitos

- Linux x86_64
- Proton Drive CLI disponible como `proton-drive`
- Una cuenta de Proton y un navegador para el inicio de sesión de Proton
- Un almacén de secretos compatible con el CLI (KWallet, GNOME Keyring/libsecret o `pass`)

## Inicio rápido

1. Instala el Proton Drive CLI y confirma que `proton-drive version` funciona.
2. Inicia Aux Proton Drive Bridge y pulsa **Sign in** — el inicio de sesión se completa en el navegador.
3. Pulsa **Refresh files**, selecciona elementos, elige una carpeta local y descarga o sube.
4. Abre la pestaña **Sync** para iniciar la sincronización en el modo que prefieras.
5. Revisa lo señalado en la pestaña **Conflicts**.

Valores seguros por defecto: las descargas fusionan carpetas y omiten archivos existentes; la sincronización nunca borra nada en ningún lado.

## Documentación (en inglés)

- [`docs/INSTALL.md`](docs/INSTALL.md) — instalación por familia de distribución
- [`docs/USAGE.md`](docs/USAGE.md) — inicio de sesión, transferencias, modos de sincronización
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — problemas comunes de Linux/CLI/llavero
- [`docs/SECURITY.md`](docs/SECURITY.md) — manejo de credenciales y modelo de seguridad

## Apoyo

Aux Proton Drive Bridge es libre y de código abierto (MIT). Si te resulta útil, puedes [invitarme a un café](https://www.buymeacoffee.com/auxillo) ☕
