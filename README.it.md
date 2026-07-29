🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · **Italiano** · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

Bridge desktop Linux non ufficiale per Proton Drive che utilizza la CLI ufficiale `proton-drive` di Proton.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Stato

Versione **`0.3.0`** - Sincronizzazione completa, coda di trasferimento, risoluzione conflitti e supporto mount FUSE.

Aux Proton Drive Bridge offre agli utenti Linux un'interfaccia grafica per le operazioni di Proton Drive tramite la CLI ufficiale di Proton.

## Funzionalità principali

- **Database metadati sincronizzazione** - Tracciamento basato su SQLite dello stato locale e remoto di ogni file tracciato
- **Coda di trasferimento live** - Trasferimenti simultanei con priorità, pausa/ripresa, annullamento, riprova
- **Parser di avanzamento** - Analisi in tempo reale dell'output CLI di proton-drive per l'avanzamento dei trasferimenti
- **Rilevamento e risoluzione conflitti** - Rileva LOCAL_REMOTE_MODIFY, LOCAL_DELETE_REMOTE_MODIFY, TYPE_MISMATCH, HASH_MISMATCH con strategie di risoluzione
- **Motore di sincronizzazione bidirezionale** - Monitoraggio del filesystem locale tramite fs.watch + polling remoto tramite CLI
- **Modalità di sincronizzazione** - Conservativa (solo upload, salta esistenti), Upload unidirezionale, Download unidirezionale, Bidirezionale
- **Aggiornamento automatico** - Controllo e download aggiornamenti basato su GitHub Releases
- **Firma dei rilasci** - Script di firma GPG e signify/minisign
- **Integrazione file manager** - Script menu contestuale per Nautilus, Dolphin, Thunar
- **Mount FUSE opzionale** - Monta Proton Drive come directory del filesystem
- **Interfaccia a schede** - Schede separate per File, Dashboard Sync, Conflitti, Coda, FUSE e Aggiornamenti

## Installazione rapida

### AppImage
Scarica ed esegui:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```
Rendilo eseguibile e avvialo dal file manager o dal terminale.

### Debian / Ubuntu / Mint / Pop!_OS
Scarica:
```
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```
Installa con il gestore pacchetti grafico o con `apt`/`dpkg`.

### Fedora / RHEL / openSUSE
Scarica:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```
Installa con il gestore pacchetti grafico, `dnf`, `zypper` o `rpm`.

## Requisiti

- Linux x64
- Proton Drive CLI disponibile come `proton-drive`
- Un account Proton
- Accesso al browser per il login Proton
- Archivio segreti Linux supportato da Proton CLI (KWallet, GNOME Keyring/libsecret o `pass`)
- FUSE: opzionale, richiesto solo per la funzione mount FUSE

## Modello di sicurezza

Aux Proton Drive Bridge non richiede mai la password Proton. L'autenticazione è delegata al flusso ufficiale CLI/browser di Proton - le credenziali non vengono memorizzate nell'app.

---

> Documentazione completa in inglese: [README.md](README.md)

---

## Supporto

Se Aux Proton Drive Bridge ti è utile, puoi [offrirmi un caffè](https://www.buymeacoffee.com/auxillo).
