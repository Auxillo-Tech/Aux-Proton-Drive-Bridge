🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · **Español** · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

Puente de escritorio Linux no oficial para Proton Drive que utiliza la CLI oficial `proton-drive` de Proton.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Estado

Versión **`0.3.0`** — Sincronización completa, cola de transferencia, resolución de conflictos y soporte de montaje FUSE.

Aux Proton Drive Bridge brinda a los usuarios de Linux una interfaz gráfica para operaciones de Proton Drive a través de la CLI oficial de Proton.

## Características principales

- **Base de datos de metadatos de sincronización** — Seguimiento basado en SQLite del estado local y remoto de cada archivo rastreado
- **Cola de transferencia en vivo** — Transferencias simultáneas con prioridad, pausa/reanudación, cancelación, reintento
- **Analizador de progreso** — Análisis en tiempo real de la salida de la CLI de proton-drive para el progreso de transferencias
- **Detección y resolución de conflictos** — Detecta LOCAL_REMOTE_MODIFY, LOCAL_DELETE_REMOTE_MODIFY, TYPE_MISMATCH, HASH_MISMATCH con estrategias de resolución
- **Motor de sincronización bidireccional** — Vigilancia del sistema de archivos local mediante fs.watch + sondeo remoto mediante CLI
- **Modos de sincronización** — Conservador (solo subida, saltar existentes), Subida unidireccional, Descarga unidireccional, Bidireccional
- **Actualizador automático** — Verificación y descarga de actualizaciones basada en GitHub Releases
- **Firmado de versiones** — Scripts de firma GPG y signify/minisign
- **Integración con el administrador de archivos** — Scripts de menú contextual para Nautilus, Dolphin, Thunar
- **Montaje FUSE opcional** — Monta Proton Drive como un directorio del sistema de archivos
- **Interfaz con pestañas** — Pestañas separadas para Archivos, Panel de Sincronización, Conflictos, Cola, FUSE y Actualizaciones

## Instalación rápida

### AppImage
Descargar y ejecutar:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```
Hacerlo ejecutable y ejecutarlo desde el administrador de archivos o la terminal.

### Debian / Ubuntu / Mint / Pop!_OS
Descargar:
```
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```
Instalar con el instalador de paquetes gráfico o con `apt`/`dpkg`.

### Fedora / RHEL / openSUSE
Descargar:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```
Instalar con el instalador de paquetes gráfico, `dnf`, `zypper` o `rpm`.

## Requisitos

- Linux x64
- Proton Drive CLI disponible como `proton-drive`
- Una cuenta de Proton
- Acceso al navegador para iniciar sesión en Proton
- Almacén de secretos de Linux compatible con Proton CLI (KWallet, GNOME Keyring/libsecret o `pass`)
- FUSE: opcional, solo necesario para la función de montaje FUSE

## Modelo de seguridad

Aux Proton Drive Bridge nunca solicita su contraseña de Proton. La autenticación se delega al flujo oficial CLI/navegador de Proton — las credenciales no se almacenan en la aplicación.

---

> Documentación completa en inglés: [README.md](README.md)
