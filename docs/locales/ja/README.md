<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**VS Code のためのマルチエージェント オーケストレーター。**

ネイティブなエージェント CLI の実行、コード編集、変更内容のレビューを同じ IDE ウィンドウ内で行えます。自身のアカウントやサブスクリプションを使用し、ウィンドウやマシンを越えてエージェント同士を連携させましょう。

[![ウェブサイト: facadecode.com](https://img.shields.io/badge/%E3%82%A6%E3%82%A7%E3%83%96%E3%82%B5%E3%82%A4%E3%83%88-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: インストール](https://img.shields.io/badge/VS%20Code%20Marketplace-%E3%82%A4%E3%83%B3%E3%82%B9%E3%83%88%E3%83%BC%E3%83%AB-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: インストール](https://img.shields.io/badge/Open%20VSX-%E3%82%A4%E3%83%B3%E3%82%B9%E3%83%88%E3%83%BC%E3%83%AB-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: IDE をダウンロード](https://img.shields.io/badge/Releases-IDE%20%E3%82%92%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: バグを報告](https://img.shields.io/badge/Issues-%E3%83%90%E3%82%B0%E3%82%92%E5%A0%B1%E5%91%8A-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · **日本語** · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![facadecode.com で 2 分間のデモを見る](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## インストール

```sh
code --install-extension facade.facadecode
```

または、[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) や [Open VSX](https://open-vsx.org/extension/facade/facadecode) から **Facade Code** をインストールします。macOS (Apple silicon)、Linux (x64)、Windows (x64) で動作します。

次に、使用予定のサポートされているエージェント CLI（Claude Code、Codex、Antigravity、Muse Code、OpenCode、Pi）をインストールしてサインインします。Facade Code は各 CLI 独自のサインインとサブスクリプションを使用して起動します。

> **エージェントはデフォルトで確認なしで実行されます。** `yolo` がデフォルトで有効になっているため、エージェントは確認を求めずにコマンドを実行しファイルを変更できます。これを無効にすると、各 CLI の標準の確認プロンプトに戻ります。[拡張機能の README](../../../extension/README.md#install) を参照してください。

## Agent Panel

**あなたとエージェント、そして IDE が同じウィンドウに。**

Facade Code は、ファイルと同じエディターのターミナルタブ内でネイティブなエージェント CLI（Claude Code、Codex、Antigravity、Muse Code、OpenCode、Pi）を直接実行し、各 CLI 自身のコマンド、ツール、アカウント、サブスクリプションを使用します。パネル内のカードで各エージェントのステータスをリアルタイムに追跡できます。

- **コードの隣で作業。** 各エージェントはエディター領域内の専用ターミナルタブで実行されます。タブを閉じると表示が非表示になるだけで、エージェントはバックグラウンドで動き続けます。カードをクリックすればいつでも再び開きます。
- **複数のエージェントのステータスを追跡。** カードには、各エージェントに最後に送信された内容と、作業中か、許可が必要か、エラーが発生したかが表示され、詳細にはタイトル、フォルダー、誰が起動したかが表示されます。エージェントはウィンドウの再読み込みや拡張機能の再起動を越えて実行を継続します。
- **フォルダーと worktree。** 任意のワークスペースフォルダーでエージェントを実行するか、Git worktree をその場で作成してコードの変更を分離します。会話をピン留めしておけばワークスペースを再度開いたときに復元でき、履歴から過去のセッションを再開することも可能です。

## Agent Use

**あなたと同じように、エージェントに他のエージェントを操作させましょう。**

MCP とターミナルプロトコルを介して、エージェントは他のエージェントの起動、停止、検出、メッセージのやり取り、ターミナル画面の読み取り、テキスト入力、キー送信を行うことができます。

- **エージェントの起動と停止。** 任意のエージェントが、このコンピューター上の Facade ウィンドウ内にある任意のフォルダーや新しい worktree で 6 つの CLI のいずれかを使用して他のエージェントを起動し、最初のタスクを与えることができます。同一のリクエスト ID による再試行リクエストで重複したエージェントが作成されることはありません。
- **メッセージの送信。** エージェント同士でメッセージをやり取りしたり、あなたにメッセージを送信したりできます。Facade はメッセージ全体を一度に貼り付けて送信します。未送信のテキストやプロンプトの質問が入力欄にある場合、入力欄が空くまで送信は待機します。
- **ターミナルの制御。** エージェントは他のエージェントの画面を読み取り、コマンドを入力し、キーを送信してプロンプトに回答したり、ブロックされた仲間を助けたりできます。子エージェントが許可、回答、またはサインインを待って 20 秒が経過すると、それを起動したエージェントに通知されます。

## Agent Mesh

**ウィンドウ、マシン、拠点を越えてエージェントをつなぎます。**

Facade Code は、このコンピューター上で開いている Facade ウィンドウのエージェントをひとつのネットワークに接続します。[VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) ウィンドウを開くことで、その連携を別のマシンへと拡張できます。

- **ウィンドウを越えて。** `yolo` が有効な場合、エージェントはこのコンピューター上の各 Facade ウィンドウ（ローカルと Remote - SSH の両方）のすべてのエージェントに到達できます。無効な場合、エージェントは自身が属するグループ（あなたが起動したエージェントおよびそこから起動されたエージェント）にのみ到達できます。
- **SSH 経由で拡張。** [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) ウィンドウでは、エージェントはリモートマシンのツール、ファイル、アカウントを使用して直接そのマシン上で実行されます。ローカルのエージェントから Remote - SSH ウィンドウ内のエージェントを直接起動したり指示を出したりできます。
- **スマートフォンから調整。** [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) を使用して、スマートフォンの Claude アプリをコンピューター上の Claude Code セッションに接続します。そのセッションが Facade を通じて他のエージェントを調整し、進行状況をスマートフォンに報告します。

<sub>Remote Control には、サポートされているバージョンの Claude Code、対象のサブスクリプション、およびフルスコープでのサインインが必要です。[セットアップ要件](https://code.claude.com/docs/en/remote-control#requirements) を参照してください。</sub>

## Facade Code IDE (Preview)

**複数のプロジェクト。ひとつのウィンドウ。**

専用のワークスペースバーでプロジェクト、機能 worktree、エージェントチームを整理します。エージェントをバックグラウンドで動かしたまま、関連するファイルやターミナルを備えたプロジェクト間を切り替えられます。

IDE プレビュー版のダウンロード：[macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [すべてのリリース](https://github.com/y5ez3g/facadecode/releases)

この IDE は VS Code のフォークであり、既存のエディターと共存してインストールされ、設定、拡張機能、`facade` コマンドなど何も共有しません。拡張機能は [Open VSX](https://open-vsx.org) から提供されます。Microsoft 独自のいくつかの拡張機能（Remote Development や C/C++ など）は公式の Microsoft ビルドでのみ動作します。アーキテクチャと仕様は [`docs/ide/`](../../ide/) にあります。

## ソースからのビルド

- **拡張機能：**コーディングエージェントに [`extension/AGENTS.md`](../../../extension/AGENTS.md) を渡してパッケージをビルドします。
- **IDE：**コーディングエージェントに [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) を渡してアプリケーションをビルドします。

コントリビューションガイドラインとブランチのルールについては、[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) および [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md) を参照してください。

## フィードバック

- **バグ報告とアイデア：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)、または IDE の **ヘルプ > 問題の報告**。
- **セキュリティの脆弱性：**[`SECURITY.md`](../../../SECURITY.md) に従って非公開で報告してください。

## ライセンス

上流の VS Code と同じく MIT ライセンスです。Microsoft の著作権表記および Facade Code コントリビューターの表記については [`LICENSE.txt`](../../../LICENSE.txt) を参照してください。

<sub>Facade Code は独立した製品であり、表示されているサードパーティツールの提供元と提携、推奨、または後援の関係にはありません。すべてのサードパーティの商標およびロゴは、それぞれの所有者に帰属します。</sub>
