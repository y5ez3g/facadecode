<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**在自己的多台機器上執行 AI 程式開發 Agent。**

Facade Code 在你的機器上執行一群 AI 程式開發 CLI。Agent 可以互相尋找、傳訊息、讀取畫面，並在終端機輸入文字。你可以透過 Shell、VS Code 或任何支援 MCP 的應用程式指揮它們。每台機器執行自己的 Orchestrator，並透過 SSH 互連。

[![官網: facadecode.com](https://img.shields.io/badge/%E5%AE%98%E7%B6%B2-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: 安裝](https://img.shields.io/badge/VS%20Code%20Marketplace-%E5%AE%89%E8%A3%9D-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: 安裝](https://img.shields.io/badge/Open%20VSX-%E5%AE%89%E8%A3%9D-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: 回報問題](https://img.shields.io/badge/Issues-%E5%9B%9E%E5%A0%B1%E5%95%8F%E9%A1%8C-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · **繁體中文** · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![在 facadecode.com 觀看 2 分鐘示範](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## 安裝

### Shell

一行安裝指令從首次包含獨立安裝套件的版本起可用。
Shell 安裝套件支援 macOS、Linux 和 Windows 的 x64 與 arm64。

在 macOS 或 Linux 上執行這個指令。

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

在 Windows PowerShell 中執行這個指令。

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

安裝程式會將 `facade` 和 `facade-mcp` 加入 PATH。開啟新的終端機，以使用更新後的 PATH。執行 `facade upgrade` 升級。在各台機器上安裝並登入所需的 CLI。內建選項有 Claude Code、Codex、Antigravity、Muse Code、OpenCode 和 Pi。

IDE 的啟動程式也叫 `facade`。兩者都安裝時，Shell 使用 PATH 中排在前面的程式。IDE 預覽版退役後，這個命令名稱歸 Orchestrator。執行 `facade version`。看到形如 `facade <version>` 的輸出，就確認使用的是 Shell 指令。

### VS Code

```sh
code --install-extension facade.facadecode
```

擴充套件隨附 Orchestrator。在活動列開啟 **Facade Code**，再選擇 **新增 Agent**、**Go to Agent** 或 **Resume Agent**。macOS、Linux 和 Windows 均有 x64 和 arm64 組建。

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

將 `facade-mcp` 新增為 stdio MCP 伺服器。這個範例使用 `mcpServers` 物件。

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

外部連線在第一次呼叫工具時以 Guest 身分加入。傳送訊息後，使用 `send_message` 傳回的 `read_messages` 呼叫等待回覆。

## 跨機器工作

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

使用 `facade list` 顯示的位址。用平常的 SSH 目標和選項註冊其他機器。若要從外部連上 WSL 或 Dev Container，先在該環境內設定 SSH，再以相同方式註冊。也可以在環境內直接執行 Facade。

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --folder /work/app --worktree feat-x claude
```

Facade 會在需要時於遠端機器安裝相同版本。Facade 在遠端機器使用固定的安裝路徑。需要手動安裝時，選用與本機 Orchestrator 相同的版本。在 VS Code 中用 **Go to Agent** 開啟 Agent 的終端機。工作區記住開啟的 Agent、它們的幫手及 Pin。關閉終端機分頁後 Agent 仍會執行。**Resume Agent** 和 `facade resume` 會列出可接續的工作。

> **YOLO 預設開啟。** 開啟時，Agent 可操作已連線機器上的其他 Agent。將該機器的 `facade.json` 設為 `"yolo": false`，即可沿用 CLI 自己的核准和沙箱，並將 MCP 存取限於呼叫者的建立樹。設定在下次啟動或 resume 時生效。用 `facade status` 查詢檔案位置。

[產品文件](../../facade-code.md) · [詞彙表](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**多專案。單視窗。**

在專屬工作區列中組織專案、功能 worktree 與 Agent 團隊。在帶有各自相關檔案與終端機的專案之間切換，同時 Agent 在背景繼續運作。

下載 IDE 預覽版：[macOS (Apple 晶片, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [所有版本](https://github.com/y5ez3g/facadecode/releases)

IDE 預覽版可與現有編輯器並行安裝，使用自己的設定及擴充套件。 其擴充套件來自 [Open VSX](https://open-vsx.org)；少數專有 Microsoft 擴充套件（例如 Remote Development 與 C/C++）僅在官方 Microsoft 組建版本中執行。架構與規格見 [`docs/ide/`](../../ide/)。

## 從原始碼建置

- **擴充套件：**將 [`extension/AGENTS.md`](../../../extension/AGENTS.md) 提供給你的程式設計 Agent 即可建置封裝套件。
- **Orchestrator / Shell.** [建置說明](../../../core/README.md).
- **IDE：**將 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) 提供給你的程式設計 Agent 即可建置應用程式。

關於貢獻指南與分支規範，請參閱 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 與 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)。

## 回饋

- **問題與建議：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在 IDE 中選取 **說明 > 回報問題**。
- **安全性弱點：**請根據 [`SECURITY.md`](../../../SECURITY.md) 進行私密回報。

## 授權條款

採用 MIT 授權條款，與上游 VS Code 保持一致。有關 Microsoft 的著作權聲明與 Facade Code 貢獻者聲明，請參閱 [`LICENSE.txt`](../../../LICENSE.txt)。

<sub>Facade Code 為獨立產品，與所展示的第三方工具提供商沒有關聯、贊助或背書關係。所有第三方商標與標誌均屬其各自擁有者所有。</sub>
