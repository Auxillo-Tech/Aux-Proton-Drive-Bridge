🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · **Português** · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

**O cliente de desktop do Proton Drive que falta no Linux.** Navegue, envie, baixe e sincronize o seu Proton Drive — com sincronização unidirecional e bidirecional, sincronização seletiva, gestão de conflitos, fila de transferências e versões assinadas. Construído sobre o CLI oficial `proton-drive` da Proton: as suas credenciais nunca saem das ferramentas da Proton.

> Projeto comunitário não oficial. Sem afiliação, aval ou patrocínio da Proton AG.

![Vista de ficheiros](docs/screenshots/files-tab.png)

## Porque existe

A Proton não oferece um cliente de desktop do Proton Drive para Linux. O CLI oficial faz o trabalho pesado, mas vive no terminal. O Aux Proton Drive Bridge envolve esse CLI numa aplicação de desktop completa — a autenticação e a cifragem ficam inteiramente no cliente da Proton.

## Funcionalidades

- **Navegar e transferir** — listar `/my-files`, baixar itens selecionados ou tudo, enviar ficheiros e pastas
- **Motor de sincronização em segundo plano** — quatro modos: conservador (só envio, ignora existentes), envio unidirecional, descarga unidirecional e bidirecional completo
- **Sincronização seletiva** — os padrões de exclusão valem nos dois sentidos: itens excluídos não são enviados nem baixados
- **Deteção e revisão de conflitos** — modificações dos dois lados, apagar-contra-modificar, conflitos de tipo e de hash, com estratégias seguras; a sincronização nunca propaga eliminações
- **Fila de transferências** — transferências concorrentes com prioridade, pausa/retoma, cancelamento e histórico persistente
- **Perfis de cópia de segurança unidirecional** — cópias agendadas de pastas com semântica conservadora
- **Integração no desktop** — bandeja do sistema, menus de contexto dos gestores de ficheiros (Nautilus, Dolphin, Thunar), metadados AppStream para GNOME Software / KDE Discover
- **Versões assinadas e atualizador integrado** — somas SHA-256 assinadas com uma chave Ed25519 fixa

## Instalação

Última versão: **<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>**

- **AppImage** para qualquer Linux x86_64 — tornar executável e correr
- **`.deb`** para Debian / Ubuntu / Mint / Pop!_OS — `sudo apt install ./<ficheiro>.deb`
- **`.rpm`** para Fedora / RHEL / openSUSE — `sudo dnf install ./<ficheiro>.rpm`
- **Tarball AUR** para Arch (PKGBUILD incluído)

Verifique a sua transferência:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`SHA256SUMS.txt.sig` é uma assinatura Ed25519 de `SHA256SUMS.txt` (impressão digital `2148f39cd1004977cfde1d0a4be7b4fa`, chave pública em `release-manifest.json`).

## Requisitos

- Linux x86_64
- Proton Drive CLI disponível como `proton-drive`
- Uma conta Proton e um navegador para o início de sessão da Proton
- Um cofre de segredos suportado pelo CLI (KWallet, GNOME Keyring/libsecret ou `pass`)

## Início rápido

1. Instale o Proton Drive CLI e confirme que `proton-drive version` funciona.
2. Abra o Aux Proton Drive Bridge e clique em **Sign in** — o início de sessão termina no navegador.
3. Clique em **Refresh files**, selecione itens, escolha uma pasta local, baixe ou envie.
4. Abra o separador **Sync** para iniciar a sincronização no modo pretendido.
5. Reveja o que for assinalado no separador **Conflicts**.

Predefinições seguras: as descargas fundem pastas e ignoram ficheiros existentes; a sincronização nunca apaga nada de nenhum dos lados.

## Documentação (em inglês)

- [`docs/INSTALL.md`](docs/INSTALL.md) — instalação por família de distribuição
- [`docs/USAGE.md`](docs/USAGE.md) — sessão, transferências, modos de sincronização
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — problemas comuns de Linux/CLI/chaveiro
- [`docs/SECURITY.md`](docs/SECURITY.md) — tratamento de credenciais e modelo de segurança

## Apoio

O Aux Proton Drive Bridge é livre e de código aberto (MIT). Se lhe for útil, pode [pagar-me um café](https://www.buymeacoffee.com/auxillo) ☕
