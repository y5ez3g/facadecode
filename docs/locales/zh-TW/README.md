<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**VS Code 的多 Agent 編排器。**

在同一個 IDE 視窗中執行各家原生 Agent CLI、編輯程式碼並審查變更。使用你自己的帳戶與訂閱，讓 Agent 跨視窗和跨機器共同協作。

[![官網: facadecode.com](https://img.shields.io/badge/%E5%AE%98%E7%B6%B2-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: 安裝](https://img.shields.io/badge/VS%20Code%20Marketplace-%E5%AE%89%E8%A3%9D-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: 安裝](https://img.shields.io/badge/Open%20VSX-%E5%AE%89%E8%A3%9D-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: 下載 IDE](https://img.shields.io/badge/Releases-%E4%B8%8B%E8%BC%89%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: 回報問題](https://img.shields.io/badge/Issues-%E5%9B%9E%E5%A0%B1%E5%95%8F%E9%A1%8C-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · **繁體中文** · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![在 facadecode.com 觀看 2 分鐘示範](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## 安裝

```sh
code --install-extension facade.facadecode
```

或從 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) 或 [Open VSX](https://open-vsx.org/extension/facade/facadecode) 安裝 **Facade Code**。支援 macOS（Apple 晶片）、Linux (x64) 與 Windows (x64)。

接下來，安裝並登入你打算使用的任何受支援 Agent CLI：Claude Code、Codex、Antigravity、Muse Code、OpenCode 或 Pi。Facade Code 會使用各 CLI 本身的登入狀態與訂閱啟動它們。

> **Agent 預設不經確認即可執行命令。** 在預設啟用 `facade.yolo` 的情況下，Agent 無需事先詢問即可執行命令與修改檔案。將其關閉即可還原各 CLI 標準的確認提示。詳見[擴充套件 README](../../../extension/README.md#install)。

## Agent Panel

**你的 Agent 與你的 IDE，身處同一個視窗。**

Facade Code 在你的檔案旁邊的編輯器終端機分頁中直接執行原生 Agent CLI（Claude Code、Codex、Antigravity、Muse Code、OpenCode 與 Pi），使用各 CLI 自己的命令、工具、帳戶與訂閱。面板中的資訊卡可即時追蹤每個 Agent 的狀態。

- **與你的程式碼並肩工作。** 每個 Agent 都在編輯器區域的專屬終端機分頁中執行。關閉分頁只會將其隱藏，Agent 會在背景繼續運作；點擊其資訊卡即可再次開啟。
- **跨 Agent 追蹤狀態。** 資訊卡顯示最後傳送給每個 Agent 的內容，以及它是否正在工作、需要權限或遇到了錯誤，詳情中則顯示其標題、資料夾以及是誰啟動了它。Agent 會在視窗重新載入與擴充套件重啟期間持續運作。
- **資料夾與 worktree。** 在任何工作區資料夾中執行 Agent，或動態建立 Git worktree 以保持程式碼變更相互獨立。固定對话可在重新開啟工作區時將其還原，或從歷程記錄中還原過往的對話工作階段。

## Agent Use

**讓 Agent 像你一樣操作其他 Agent。**

透過 MCP 與終端機通訊協定，Agent 可以啟動、停止、尋找其他 Agent 並與其收發訊息，還能讀取對方的終端機螢幕、輸入文字並按鍵。

- **啟動和停止 Agent。** 任何 Agent 都可以使用六款 CLI 中的任意一款，在目前電腦上各 Facade 視窗的任何資料夾或新 worktree 中啟動其他 Agent，並為其指派第一個工作。帶有相同請求 ID 的重試請求絕不會啟動重複的 Agent。
- **傳送訊息。** Agent 之間可以相互收發訊息，也能向你傳送訊息。Facade 會一次性貼上整則訊息並傳送。如果有未傳送的文字或提示問題阻擋，傳送將會等待，直到輸入區域空閒。
- **終端機控制。** Agent 可以讀取其他 Agent 的螢幕、輸入命令並按鍵，以回答提示或協助受阻的同伴。當子 Agent 等待權限、回答或登入達到 20 秒時，啟動它的 Agent 會收到通知。

## Agent Mesh

**跨視窗、跨機器、跨位置連接 Agent。**

Facade Code 將你在這台電腦上開啟的各 Facade 視窗中的 Agent 連接成一個網路。開啟 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 視窗即可將協作擴展到另一台機器。

- **跨視窗。** 啟用 `facade.yolo` 時，Agent 可以觸及你在這台電腦上各 Facade 視窗中的每一個 Agent，無論是本機還是 Remote - SSH 視窗。將其關閉時，Agent 只能觸及它自己的群組：即由你啟動的 Agent 及其衍生啟動的 Agent。
- **透過 SSH 擴展。** 在 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 視窗中，Agent 直接在遠端機器上執行，使用該機器上的工具、檔案與帳戶。本機 Agent 可以直接啟動並控制 Remote - SSH 視窗中的 Agent。
- **透過手機協調。** 使用 [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) 將 Claude 行動端 App 連接到電腦上的 Claude Code 工作階段。該工作階段可以透過 Facade 協調其他 Agent，並將進度回報到你的手機。

<sub>Remote Control 需要受支援的 Claude Code 版本、符合資格的訂閱以及完整範圍的登入。詳見其[設定需求](https://code.claude.com/docs/en/remote-control#requirements)。</sub>

## Facade Code IDE (Preview)

**多專案。單視窗。**

在專屬工作區列中組織專案、功能 worktree 與 Agent 團隊。在帶有各自相關檔案與終端機的專案之間切換，同時 Agent 在背景繼續運作。

下載 IDE 預覽版：[macOS (Apple 晶片, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [所有版本](https://github.com/y5ez3g/facadecode/releases)

該 IDE 是 VS Code 的分支版本，與現有編輯器並行安裝且不共用任何內容：設定、擴充套件與 `facade` 命令完全獨立。其擴充套件來自 [Open VSX](https://open-vsx.org)；少數專有 Microsoft 擴充套件（例如 Remote Development 與 C/C++）僅在官方 Microsoft 組建版本中執行。架構與規格見 [`docs/ide/`](../../ide/)。

## 從原始碼建置

- **擴充套件：**將 [`extension/AGENTS.md`](../../../extension/AGENTS.md) 提供給你的程式設計 Agent 即可建置封裝套件。
- **IDE：**將 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) 提供給你的程式設計 Agent 即可建置應用程式。

關於貢獻指南與分支規範，請參閱 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 與 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)。

## 回饋

- **問題與建議：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在 IDE 中選取 **說明 > 回報問題**。
- **安全性弱點：**請根據 [`SECURITY.md`](../../../SECURITY.md) 進行私密回報。

## 授權條款

採用 MIT 授權條款，與上游 VS Code 保持一致。有關 Microsoft 的著作權聲明與 Facade Code 貢獻者聲明，請參閱 [`LICENSE.txt`](../../../LICENSE.txt)。

<sub>Facade Code 為獨立產品，與所展示的第三方工具提供商沒有關聯、贊助或背書關係。所有第三方商標與標誌均屬其各自擁有者所有。</sub>
