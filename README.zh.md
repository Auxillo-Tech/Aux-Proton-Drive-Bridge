🌐 [English](README.md) · [Deutsch](README.de.md) · **简体中文** · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

使用 Proton 官方 `proton-drive` CLI 的非官方 Linux 桌面桥接工具。

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## 状态

版本 **`0.3.0`** - 功能完整的同步、传输队列、冲突解决和 FUSE 挂载支持。

Aux Proton Drive Bridge 通过 Proton 官方 CLI 为 Linux 用户提供 Proton Drive 操作的图形界面。

## 主要功能

- **同步元数据库** - 基于 SQLite 跟踪每个受控文件的本地和远程状态
- **实时传输队列** - 支持优先级、暂停/恢复、取消、重试的并发传输
- **进度解析器** - 实时解析 proton-drive CLI 输出以获取传输进度
- **冲突检测与解决** - 检测 LOCAL_REMOTE_MODIFY、LOCAL_DELETE_REMOTE_MODIFY、TYPE_MISMATCH、HASH_MISMATCH 并提��解决策略
- **双向同步引擎** - 通过 fs.watch 监控本地文件系统 + 通过 CLI 远程轮询
- **同步模式** - 保守模式（仅上传，跳过已有文件）、单向上传、单向下载、双向同步
- **自动更新** - 基于 GitHub Releases 的更新检查和下载
- **发布签名** - GPG 和 signify/minisign 签名脚本
- **文件管理器集成** - Nautilus、Dolphin、Thunar 上下文菜单脚本
- **可选 FUSE 挂载** - 将 Proton Drive 挂载为文件系统目录
- **标签页界面** - 文件、同步面板、冲突、队列、FUSE 和更新分别使用独立标签页

## 快速安装

### AppImage
下载并运行：
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.AppImage
```
赋予执行权限后从文件管理器或终端运行。

### Debian / Ubuntu / Mint / Pop!_OS
下载：
```
Aux.Proton.Drive.Bridge-0.3.0-amd64.deb
```
使用图形化包管理器或 `apt`/`dpkg` 安装。

### Fedora / RHEL / openSUSE
下载：
```
Aux.Proton.Drive.Bridge-0.3.0-x86_64.rpm
```
使用图形化包管理器、`dnf`、`zypper` 或 `rpm` 安装。

## 系统要求

- Linux x64
- 可用的 Proton Drive CLI（`proton-drive`）
- 一个 Proton 账户
- 用于 Proton 登录的浏览器访问
- Proton CLI 支持的 Linux 密钥存储（KWallet、GNOME Keyring/libsecret 或 `pass`）
- FUSE：可选，仅 FUSE 挂载功能需要

## 安全模型

Aux Proton Drive Bridge 从不询问您的 Proton 密码。身份验证委托给官方的 Proton CLI/浏览器流程 凭据不会存储在应用程序中。

---

> 完整英文文档：[README.md](README.md)
