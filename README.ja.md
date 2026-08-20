🌐 [English](README.md) · [Deutsch](README.de.md) · [简体中文](README.zh.md) · [Italiano](README.it.md) · [Español](README.es.md) · [Français](README.fr.md) · **日本語** · [Português](README.pt.md) · [Русский](README.ru.md)

---

# Aux Proton Drive Bridge

**Linux に欠けている Proton Drive デスクトップクライアント。** Proton Drive の閲覧・アップロード・ダウンロード・同期を、一方向/双方向同期、選択同期、競合処理、転送キュー、署名付きリリースとともに提供します。Proton 公式の `proton-drive` CLI の上に構築されているため、認証情報が Proton のツール外に出ることはありません。

> 非公式のコミュニティプロジェクトです。Proton AG とは提携・承認・後援の関係にありません。

![ファイル画面](docs/screenshots/files-tab.png)

## このプロジェクトの理由

Proton は Linux 向け Proton Drive デスクトップクライアントを提供していません。公式 CLI が主要な処理を担いますが、ターミナル上でしか使えません。Aux Proton Drive Bridge はその CLI を完全なデスクトップアプリに包み込みます — 認証と暗号化はすべて Proton 自身のクライアントに委ねられます。

## 機能

- **閲覧と転送** — `/my-files` の一覧表示、選択項目または全体のダウンロード、ファイル/フォルダーのアップロード
- **バックグラウンド同期エンジン** — 4 つのモード:保守的(アップロードのみ・既存はスキップ)、一方向アップロード、一方向ダウンロード、完全双方向
- **選択同期** — 除外パターンは両方向に有効:除外された項目はアップロードもダウンロードもされません
- **競合の検出とレビュー** — 双方変更、削除対変更、型・ハッシュ不一致を安全な解決戦略付きで検出。同期が削除を伝播することはありません
- **転送キュー** — 優先度付き並行転送、一時停止/再開、キャンセル、永続的な履歴
- **一方向バックアッププロファイル** — 保守的セマンティクスによるフォルダーの定期バックアップ
- **デスクトップ統合** — システムトレイ、ファイルマネージャーのコンテキストメニュー(Nautilus、Dolphin、Thunar)、GNOME Software / KDE Discover 向け AppStream メタデータ
- **署名付きリリースとアプリ内アップデーター** — SHA-256 チェックサムを固定 Ed25519 鍵で署名

## インストール

最新リリース: **<https://github.com/Auxillo-Tech/Aux-Proton-Drive-Bridge/releases/latest>**

- **AppImage** — あらゆる Linux x86_64 向け。実行権限を付与して起動
- **`.deb`** — Debian / Ubuntu / Mint / Pop!_OS 向け。`sudo apt install ./<ファイル>.deb`
- **`.rpm`** — Fedora / RHEL / openSUSE 向け。`sudo dnf install ./<ファイル>.rpm`
- **AUR tarball** — Arch 向け(PKGBUILD 同梱)

ダウンロードの検証:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`SHA256SUMS.txt.sig` は `SHA256SUMS.txt` に対する Ed25519 署名です(フィンガープリント `2148f39cd1004977cfde1d0a4be7b4fa`、公開鍵は `release-manifest.json` に記載)。

## 動作要件

- Linux x86_64
- `proton-drive` として利用可能な Proton Drive CLI
- Proton アカウントと、Proton ログイン用のブラウザー
- CLI が対応するシークレットストア(KWallet、GNOME Keyring/libsecret、または `pass`)

## クイックスタート

1. Proton Drive CLI をインストールし、`proton-drive version` が動くことを確認します。
2. Aux Proton Drive Bridge を起動し **Sign in** をクリック — ログインはブラウザーで完了します。
3. **Refresh files** をクリックし、項目を選択し、ローカルフォルダーを選んでダウンロード/アップロードします。
4. **Sync** タブで希望のモードのバックグラウンド同期を開始します。
5. **Conflicts** タブで検出された競合を確認します。

安全な既定値:ダウンロードはフォルダーを統合し既存ファイルをスキップします。同期はどちら側のデータも決して削除しません。

## ドキュメント(英語)

- [`docs/INSTALL.md`](docs/INSTALL.md) — ディストリビューション別のインストール手順
- [`docs/USAGE.md`](docs/USAGE.md) — サインイン、転送、同期モード
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — Linux/CLI/キーリングのよくある問題
- [`docs/SECURITY.md`](docs/SECURITY.md) — 認証情報の扱いとセキュリティモデル

## サポート

Aux Proton Drive Bridge は自由かつオープンソース(MIT)です。役に立ったら [コーヒーをおごって](https://www.buymeacoffee.com/auxillo) いただけると嬉しいです ☕
