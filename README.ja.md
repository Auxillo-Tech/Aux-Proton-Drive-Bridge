🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · **日本語** · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

Proton の公式 `proton-drive` CLI を使用した非公式の Linux デスクトップブリッジ。

> Not affiliated with, endorsed by, or sponsored by Proton AG.

## ステータス

バージョン **`0.3.3`** - 完全な同期、転送キュー、競合解決、FUSE マウントサポート。

Aux Proton Drive Bridge は、Proton の公式 CLI を介して Proton Drive 操作用の GUI を Linux ユーザーに提供します。

## 主な機能

- **同期メタデータ DB** - SQLite ベースで追跡対象ファイルのローカルおよびリモート状態を管理
- **ライブ転送キュー** - 優先度、一時停止/再開、キャンセル、再試行が可能な同時転送
- **進捗パーサー** - proton-drive CLI 出力をリアルタイム解析して転送進捗を表示
- **競合検出と解決** - LOCAL_REMOTE_MODIFY、LOCAL_DELETE_REMOTE_MODIFY、TYPE_MISMATCH、HASH_MISMATCH を検出し解決戦略を提供
- **双方向同期エンジン** - fs.watch によるローカルファイルシステム監視 + CLI によるリモートポーリング
- **同期モード** - 保守的（アップロードのみ、既存ファイルはスキップ）、片方向アップロード、片方向ダウンロード、双方向
- **自動アップデーター** - GitHub Releases ベースの更新確認とダウンロード
- **リリース署名** - GPG および signify/minisign 署名スクリプト
- **ファイルマネージャー統合** - Nautilus、Dolphin、Thunar のコンテキストメニュースクリプト
- **オプションの FUSE マウント** - Proton Drive をファイルシステムディレクトリとしてマウント
- **タブ付き UI** - ファイル、同期ダッシュボード、競合、キュー、FUSE、更新の各タブ

## クイックインストール

### AppImage
ダウンロードして実行：
```
Aux.Proton.Drive.Bridge-0.3.3-x86_64.AppImage
```
実行可能にしてファイルマネージャーまたはターミナルから起動。

### Debian / Ubuntu / Mint / Pop!_OS
ダウンロード：
```
Aux.Proton.Drive.Bridge-0.3.3-amd64.deb
```
グラフィカルパッケージインストーラーまたは `apt`/`dpkg` でインストール。

### Fedora / RHEL / openSUSE
ダウンロード：
```
Aux.Proton.Drive.Bridge-0.3.3-x86_64.rpm
```
グラフィカルパッケージインストーラー、`dnf`、`zypper`、または `rpm` でインストール。

## システム要件

- Linux x64
- `proton-drive` として利用可能な Proton Drive CLI
- Proton アカウント
- Proton ログイン用のブラウザアクセス
- Proton CLI がサポートする Linux シークレットストア（KWallet、GNOME Keyring/libsecret、`pass`）
- FUSE：オプション、FUSE マウント機能にのみ必要

## セキュリティモデル

Aux Proton Drive Bridge は Proton パスワードを決して要求しません。認証は Proton の公式 CLI/ブラウザフローに委任され、認証情報はアプリケーションに保存されません。

---

> 完全な英語ドキュメント：[README.md](README.md)

---

## サポート

Aux Proton Drive Bridge が役立つ場合は、[コーヒーを奢ってください](https://www.buymeacoffee.com/auxillo)。
