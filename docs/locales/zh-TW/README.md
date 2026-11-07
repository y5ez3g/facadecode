<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**在 VS Code 裡同時指揮多個 coding agent。**

在同一個 IDE 視窗裡執行原生 agent CLI、寫程式並審查變更。使用你自己的帳號與訂閱，讓 agent 跨視窗、跨機器協作。

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

接下來，安裝並登入你想使用的任何 agent CLI：Claude Code、Codex、Antigravity、Muse Code、OpenCode 或 Pi。Facade Code 會直接使用各 CLI 本身的登入狀態與訂閱啟動它們。

> **注意：預設情況下 agent 會直接執行指令並修改檔案，不會事先詢問你。** 在 `facade.yolo` 開啟時，agent 的所有操作都不會跳出提示請求確認。如果你希望還原各 CLI 原本的確認提示，可以在設定中將其關閉。詳見[擴充功能 README](../../../extension/README.md#install)。

## Agent Panel

**你的 agent 與你的 IDE，都在同一個視窗裡。**

Facade Code 在程式碼檔案旁邊的編輯器終端機分頁中直接執行原生 agent CLI（Claude Code、Codex、Antigravity、Muse Code、OpenCode 和 Pi），使用各 CLI 自己的指令、工具、帳號與訂閱。每個 agent 在面板中都有一張卡片，一眼就能看清目前狀態。

- **終端機直接開在編輯器裡。** 每個 agent 的終端機都是編輯器裡的專屬分頁。關閉分頁只是暫時收起，agent 在背景繼續執行，點一下面板卡片即可隨時切換回來。
- **所有 agent 狀態一目了然。** 卡片上直接顯示你發給它的最後一句話，以及它是在處理中、等待權限還是發生了錯誤；點開詳情能看標題、工作資料夾和是誰啟動的。視窗重新載入或擴充功能重啟，agent 依然都在。
- **資料夾與獨立 worktree。** 可以在任何工作區資料夾中啟動 agent，也能直接建立新的 Git worktree，各做各的程式碼互不衝突。常用工作階段可以釘選在面板上，下次開啟工作區時自動還原，或隨時從歷程記錄中找回過往的舊工作階段。

## Agent Use

**讓 agent 像你一樣，直接操作其他 agent。**

透過 MCP 與終端機協定，不同廠商的 agent 可以互相啟動、停止、搜尋與傳送訊息（例如讓 Claude Code 指揮 Codex）。每個 CLI 保留各自原有的工具與上下文管理方式，還能讀取彼此的終端機螢幕、輸入指令、傳送按鍵。

- **互相啟動與停止。** 任何 agent 都能使用這六款 CLI 中的任意一款，在目前電腦任意視窗的資料夾或新 worktree 中啟動其他 agent 並交付第一個任務。即使遇到重試，只要請求 ID 相同，就不會誤啟動重複的 agent。
- **互傳訊息回報。** agent 之間能互相傳送訊息，也能主動向你傳送通知。Facade 會一次將整段訊息送達；如果輸入框內還有未傳送的文字或彈出的提示尚未處理，會等輸入框清空後再傳送。
- **終端機接管與排解。** 一個 agent 能直接查看另一個 agent 的終端機螢幕、代為輸入指令與按鍵，協助隊友回答提示或解決卡住的問題。如果子 agent 等待權限、輸入或登入超過 20 秒，啟動它的 agent 就會收到提醒。

## Agent Mesh

**無論在哪個視窗、哪台機器，所有 agent 全都互通。**

Facade Code 能打通你電腦上所有編輯器視窗裡的 agent。開啟一個 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 視窗，協作網路就能立即延伸到另一台機器上。

- **所有視窗自動組網。** 在預設開啟 `facade.yolo` 時，agent 能直接找到你電腦上任何一個 Facade 視窗裡的所有 agent，無論是本機還是 Remote - SSH。將其關閉後，agent 只能聯絡它自己的小團隊：即由你啟動的那個 agent，以及它後續一路啟動的下層 agent。
- **用 SSH 把其他機器拉進團隊。** 在 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 視窗中，agent 直接在遠端機器上執行，就地使用遠端機器上的環境、檔案與帳號。本機電腦上的 agent 可以直接給它們派任務、互傳訊息。
- **外出時用手機指揮。** 為電腦上的主導工作階段開啟 [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)，手機上的 Claude app 就能直接連上來。電腦上的 CLI 照常執行，手機與電腦即時同步訊息與進度。你可以隨時查看進展、拍板做決定，讓主導工作階段繼續調度其他 agent。

<sub>使用 Remote Control 需要支援此功能的 Claude Code 版本、符合資格的訂閱方案以及完整權限登入。詳見其[設定需求](https://code.claude.com/docs/en/remote-control#requirements)。</sub>

## Facade Code IDE (Preview)

**專案再多，視窗只要一個。**

在專用的工作區側邊欄裡統一管理專案、功能 worktree 與 agent 團隊。隨時切換專案，對應的檔案與終端機都在原位，背景跑著的 agent 照樣不受打擾。

下載 IDE 預覽版：[macOS (Apple 晶片, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [所有版本](https://github.com/y5ez3g/facadecode/releases)

Facade Code IDE 是基於 VS Code 的分支版本，與你原本安裝的 VS Code 互不干擾：設定、擴充功能與 `facade` 命令列工具完全獨立。擴充功能統一透過 [Open VSX](https://open-vsx.org) 下載；少數微軟自家的封閉原始碼擴充功能（例如 Remote Development 和 C/C++）僅能在微軟官方原版中使用。架構設計與規格文件詳見 [`docs/ide/`](../../ide/)。

## 從原始碼建置

- **擴充功能：**將 [`extension/AGENTS.md`](../../../extension/AGENTS.md) 交給你的 coding agent 即可建置安裝套件。
- **IDE：**將 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) 交給你的 coding agent 即可建置應用程式。

關於貢獻指南與分支規範，請參閱 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 與 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)。

## 回饋

- **問題與建議：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在 IDE 中選取 **說明 > 回報問題**。
- **安全性弱點：**請根據 [`SECURITY.md`](../../../SECURITY.md) 私下回報。

## 授權條款

採用 MIT 授權條款，與上游 VS Code 保持一致。微軟的著作權聲明與 Facade Code 貢獻者聲明詳見 [`LICENSE.txt`](../../../LICENSE.txt)。

<sub>Facade Code 是一款獨立產品，與頁面所列第三方工具及其廠商無關聯、背書或贊助關係。所有第三方商標與標誌均屬其各自權利人所有。</sub>
