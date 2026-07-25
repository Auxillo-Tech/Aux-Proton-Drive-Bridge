🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · **Português**

---

# Aux Proton Drive Bridge

Ponte de desktop Linux não oficial para o Proton Drive utilizando a CLI oficial `proton-drive` da Proton.

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## Status

Versão **`0.3.0`** — Sincronização completa, fila de transferência, resolução de conflitos e suporte a montagem FUSE.

O Aux Proton Drive Bridge oferece aos usuários Linux uma interface gráfica para operações do Proton Drive através da CLI oficial da Proton.

## Principais recursos

- **Banco de dados de metadados de sincronização** — Rastreamento baseado em SQLite do estado local e remoto de cada arquivo monitorado
- **Fila de transferência ao vivo** — Transferências simultâneas com prioridade, pausa/retomada, cancelamento, repetição
- **Analisador de progresso** — Análise em tempo real da saída da CLI do proton-drive para progresso de transferências
- **Detecção e resolução de conflitos** — Detecta LOCAL_REMOTE_MODIFY, LOCAL_DELETE_REMOTE_MODIFY, TYPE_MISMATCH, HASH_MISMATCH com estratégias de resolução
- **Mecanismo de sincronização bidirecional** — Monitoramento do sistema de arquivos local via fs.watch + polling remoto via CLI
- **Modos de sincronização** — Conservador (apenas upload, pular existentes), Upload unidirecional, Download unidirecional, Bidirecional
- **Atualizador automático** — Verificação e download de atualizações baseado em GitHub Releases
- **Assinatura de versões** — Scripts de assinatura GPG e signify/minisign
- **Integração com gerenciador de arquivos** — Scripts de menu de contexto para Nautilus, Dolphin, Thunar
- **Montagem FUSE opcional** — Montar o Proton Drive como um diretório do sistema de arquivos
- **Interface com abas** — Abas separadas para Arquivos, Painel de Sincronização, Conflitos, Fila, FUSE e Atualizações

## Instalação rápida

### AppImage
Baixar e executar:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```
Tornar executável e iniciar a partir do gerenciador de arquivos ou terminal.

### Debian / Ubuntu / Mint / Pop!_OS
Baixar:
```
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```
Instalar com o instalador gráfico de pacotes ou com `apt`/`dpkg`.

### Fedora / RHEL / openSUSE
Baixar:
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```
Instalar com o instalador gráfico de pacotes, `dnf`, `zypper` ou `rpm`.

## Requisitos

- Linux x64
- Proton Drive CLI disponível como `proton-drive`
- Uma conta Proton
- Acesso ao navegador para login Proton
- Armazenamento de segredos Linux compatível com Proton CLI (KWallet, GNOME Keyring/libsecret ou `pass`)
- FUSE: opcional, necessário apenas para o recurso de montagem FUSE

## Modelo de segurança

O Aux Proton Drive Bridge nunca solicita sua senha Proton. A autenticação é delegada ao fluxo oficial CLI/navegador da Proton — as credenciais não são armazenadas no aplicativo.

---

> Documentação completa em inglês: [README.md](README.md)
