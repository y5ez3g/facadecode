<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**自分のマシンで AI コーディングエージェントを実行。**

Facade Code は複数の AI コーディング CLI を自分のマシンで実行します。エージェントは互いを探し、メッセージを送り、画面を読み、端末に入力できます。Shell、VS Code、MCP 対応アプリから操作できます。各マシンは自身の Orchestrator を実行し、SSH で接続します。

[![ウェブサイト: facadecode.com](https://img.shields.io/badge/%E3%82%A6%E3%82%A7%E3%83%96%E3%82%B5%E3%82%A4%E3%83%88-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: インストール](https://img.shields.io/badge/VS%20Code%20Marketplace-%E3%82%A4%E3%83%B3%E3%82%B9%E3%83%88%E3%83%BC%E3%83%AB-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: インストール](https://img.shields.io/badge/Open%20VSX-%E3%82%A4%E3%83%B3%E3%82%B9%E3%83%88%E3%83%BC%E3%83%AB-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: バグを報告](https://img.shields.io/badge/Issues-%E3%83%90%E3%82%B0%E3%82%92%E5%A0%B1%E5%91%8A-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · **日本語** · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![facadecode.com で 2 分間のデモを見る](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## インストール

### Shell

1 行で実行できるインストーラーは、単体パッケージが含まれる最初のリリースから利用できます。
Shell パッケージは macOS、Linux、Windows の x64 と arm64 に対応します。

macOS または Linux では、次のコマンドを実行します。

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

Windows では、PowerShell で次のコマンドを実行します。

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

インストーラーは `facade` と `facade-mcp` を PATH に追加します。新しい端末を開いて、更新された PATH を使用します。更新は `facade upgrade` で行います。使う CLI を各マシンにインストールし、ログインしてください。組み込み CLI は Claude Code、Codex、Antigravity、Muse Code、OpenCode、Pi です。

IDE の起動コマンドも `facade` です。両方をインストールした場合、Shell は PATH の先頭にある方を使います。IDE プレビューの終了後、この名前は Orchestrator 用になります。`facade version` を実行し、`facade <version>` 形式の行が表示されれば Shell のコマンドを使用しています。

### VS Code

```sh
code --install-extension facade.facadecode
```

拡張機能には Orchestrator が含まれます。アクティビティバーで **Facade Code** を開き、**新しいエージェント**、**Go to Agent**、または **Resume Agent** を選びます。macOS、Linux、Windows 向けに x64 と arm64 のパッケージがあります。

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

`facade-mcp` を stdio MCP サーバーとして追加します。この例では `mcpServers` オブジェクトを使います。

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

外部接続は最初のツール呼び出し時に Guest として参加します。送信後は `send_message` が返す `read_messages` 呼び出しで返信を待ちます。

## 複数のマシンで作業する

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

`facade list` に表示されるアドレスを使います。別のマシンを使う場合は、普段の SSH 接続先とオプションで登録します。WSL や Dev Container に外部から接続するには、その環境内で SSH を設定し、同じ方法で登録します。環境内で Facade を直接実行することもできます。

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --folder /work/app --worktree feat-x claude
```

必要に応じて、Facade がリモートマシンに対応するバージョンをインストールします。Facade はリモートマシンで固定のインストールパスを使います。手動でインストールする場合は、ローカルの Orchestrator と同じバージョンを使います。VS Code の **Go to Agent** で実行中のエージェントの端末を開けます。ワークスペースは開いたエージェント、そこから起動したエージェント、Pin を記憶します。端末タブを閉じてもエージェントは動き続けます。**Resume Agent** と `facade resume` は再開できる作業を表示します。

> **YOLO は既定でオンです。** オンの場合、エージェントは接続先のマシンにいる他のエージェントを操作できます。実行先の `facade.json` で `"yolo": false` を指定すると、CLI の承認設定とサンドボックスが適用され、MCP の範囲は呼び出し元の作成ツリー内に限られます。次回の起動または resume から有効です。`facade status` でファイルの場所を確認できます。

[製品ドキュメント（中国語）](../../facade-code.md) · [用語集](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**複数のプロジェクト。ひとつのウィンドウ。**

専用のワークスペースバーでプロジェクト、機能 worktree、エージェントチームを整理します。エージェントをバックグラウンドで動かしたまま、関連するファイルやターミナルを備えたプロジェクト間を切り替えられます。

IDE プレビュー版のダウンロード：[macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [すべてのリリース](https://github.com/y5ez3g/facadecode/releases)

IDE プレビューは既存のエディターと共存し、独自の設定と拡張機能を使います。 拡張機能は [Open VSX](https://open-vsx.org) から提供されます。Microsoft 独自のいくつかの拡張機能（Remote Development や C/C++ など）は公式の Microsoft ビルドでのみ動作します。アーキテクチャと仕様は [`docs/ide/`](../../ide/) にあります。

## ソースからのビルド

- **拡張機能：**コーディングエージェントに [`extension/AGENTS.md`](../../../extension/AGENTS.md) を渡してパッケージをビルドします。
- **Orchestrator / Shell.** [ビルド手順](../../../core/README.md).
- **IDE：**コーディングエージェントに [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) を渡してアプリケーションをビルドします。

コントリビューションガイドラインとブランチのルールについては、[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) および [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md) を参照してください。

## フィードバック

- **バグ報告とアイデア：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)、または IDE の **ヘルプ > 問題の報告**。
- **セキュリティの脆弱性：**[`SECURITY.md`](../../../SECURITY.md) に従って非公開で報告してください。

## ライセンス

上流の VS Code と同じく MIT ライセンスです。Microsoft の著作権表記および Facade Code コントリビューターの表記については [`LICENSE.txt`](../../../LICENSE.txt) を参照してください。

<sub>Facade Code は独立した製品であり、表示されているサードパーティツールの提供元と提携、推奨、または後援の関係にはありません。すべてのサードパーティの商標およびロゴは、それぞれの所有者に帰属します。</sub>
