🌐 [English](README.md) · [Deutsch](README.de.md) · **简体中文** · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

**Linux 缺失的那款 Proton Drive 桌面客户端。** 浏览、上传、下载并同步你的 Proton Drive——支持单向与双向同步、选择性同步、冲突处理、传输队列和签名发布。基于 Proton 官方的 `proton-drive` CLI 构建,你的凭据永远不会离开 Proton 自己的工具。

> 非官方社区项目。与 Proton AG 无隶属、认可或赞助关系。

![文件视图](docs/screenshots/files-tab.png)

## 项目缘由

Proton 没有为 Linux 提供 Proton Drive 桌面客户端。官方 CLI 能完成核心工作,但只能在终端中使用。Aux Proton Drive Bridge 将该 CLI 封装成完整的桌面应用——认证与加密完全保留在 Proton 自己的客户端中。

## 功能

- **浏览与传输** — 列出 `/my-files`,下载所选项目或全部内容,上传文件和文件夹
- **后台同步引擎** — 四种模式:保守(仅上传、跳过已存在)、单向上传、单向下载、完全双向
- **选择性同步** — 排除模式对两个方向都生效:被排除的项目既不上传也不下载
- **冲突检测与审查** — 双端修改、删除对修改、类型与哈希不匹配,均配有安全的解决策略;同步绝不传播删除
- **传输队列** — 并发传输,支持优先级、暂停/恢复、取消及持久历史记录
- **单向备份配置** — 以保守语义定时备份文件夹
- **桌面集成** — 系统托盘、文件管理器右键菜单(Nautilus、Dolphin、Thunar)、面向 GNOME Software / KDE Discover 的 AppStream 元数据
- **签名发布与内置更新器** — SHA-256 校验和由固定的 Ed25519 密钥签名

## 安装

最新版本: **<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>**

- **AppImage** — 适用于任何 Linux x86_64,添加执行权限后运行
- **`.deb`** — 适用于 Debian / Ubuntu / Mint / Pop!_OS:`sudo apt install ./<文件>.deb`
- **`.rpm`** — 适用于 Fedora / RHEL / openSUSE:`sudo dnf install ./<文件>.rpm`
- **AUR 压缩包** — 适用于 Arch(内含 PKGBUILD)

校验下载:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`SHA256SUMS.txt.sig` 是对 `SHA256SUMS.txt` 的 Ed25519 签名(指纹 `2148f39cd1004977cfde1d0a4be7b4fa`,公钥见 `release-manifest.json`)。

## 运行要求

- Linux x86_64
- 可通过 `proton-drive` 调用的 Proton Drive CLI
- Proton 账户及用于 Proton 登录的浏览器
- CLI 支持的密钥存储(KWallet、GNOME Keyring/libsecret 或 `pass`)

## 快速上手

1. 安装 Proton Drive CLI,确认 `proton-drive version` 可用。
2. 启动 Aux Proton Drive Bridge,点击 **Sign in** ——登录在浏览器中完成。
3. 点击 **Refresh files**,选择项目,选定本地文件夹,进行下载或上传。
4. 打开 **Sync** 标签页,以所需模式启动后台同步。
5. 在 **Conflicts** 标签页中处理被标记的冲突。

安全默认值:下载会合并文件夹并跳过已存在的文件;同步绝不会删除任何一侧的数据。

## 文档(英文)

- [`docs/INSTALL.md`](docs/INSTALL.md) — 按发行版系列的安装说明
- [`docs/USAGE.md`](docs/USAGE.md) — 登录、传输、同步模式
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — 常见 Linux/CLI/密钥环问题
- [`docs/SECURITY.md`](docs/SECURITY.md) — 凭据处理与安全模型

## 支持

Aux Proton Drive Bridge 是自由开源软件(MIT)。如果它对你有帮助,欢迎[请我喝杯咖啡](https://www.buymeacoffee.com/auxillo) ☕
