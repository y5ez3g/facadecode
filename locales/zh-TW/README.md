<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**一個 IDE，裝下你和你的 AI 團隊。**

以 VS Code 為基礎。直接執行各家原生的 agent CLI，例如 Claude Code、Codex、Antigravity、Muse Code 和 Qwen Code。

[下載](https://github.com/y5ez3g/facadecode/releases) ·
[規格文件](../../facade-code-spec/) ·
[回報問題](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · **繁體中文** · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code 是 VS Code 的分支（fork）。各家廠商的原生 agent 在這裡一起開發你的專案和功能，你在同一個視窗裡審查程式碼，隨時指揮其中任何一個 agent。

- 🧑‍💻 **完整的 VS Code，依專案和功能組織。** 在一個視窗裡同時開發多個專案和功能。每個功能就是一個 git worktree，配有一支專屬的 agent 團隊。
- 🤖 **跨廠商的原生 agent CLI 團隊。** agent 用的是你自己的訂閱方案。在 Facade Code 裡，agent 能互相啟動、互傳訊息，也能幫卡住的同伴解圍。
- 👥 **Super Engineer（超級工程師）或 Super Team（超級團隊）。** 你可以親自指揮多個 agent，也可以指定一個主力模型，讓它協調多個各有所長的 agent 平行工作。

## 安裝

從 [Releases](https://github.com/y5ez3g/facadecode/releases) 下載最新版本：macOS（Apple 晶片）用 `.dmg`，Windows（x64）用安裝程式，Ubuntu（x64）用 `.deb`。

**事前準備**：先安裝並登入你想用的 agent CLI（Claude Code、Codex、Antigravity、Muse Code、Qwen Code，任意組合）。Facade Code 直接執行它們，沿用它們原生的登入和訂閱。

Facade Code 可以和 VS Code 同時安裝，兩者不共用任何東西：設定、擴充功能和 `facade` 命令列工具完全分開。

## 快速開始

1. **開啟一個專案**：
   ```sh
   facade ~/code/space-shooter
   ```
   也可以用 **File > Open Folder**（檔案 > 開啟資料夾），或是把資料夾拖到工作區列上。資料夾必須是 git 儲存庫（worktree 需要 git；新專案請先執行 `git init`）。

2. **啟動一位 tech lead**：
   點選標題列上的機器人圖示（Agent 選單），或在命令選擇區執行 **Agents: Start Agent...**（啟動 agent），然後選 Claude Code 或 Codex。從 Facade Code 裡啟動的 agent 會帶有 Facade 的 MCP 工具。

3. **把這段給 tech lead 的提示詞交給它**：
   ```text
   你是 tech lead。用 Facade 做一款在瀏覽器（桌面版）上執行的霓虹風太空射擊遊戲，用來展示。
   配一位產品設計師（PD），透過 Codex 使用 GPT Sol 6（gpt-6-sol, max），負責視覺和手感；
   再配三位 Muse 1.3 工程師（muse-spark-1.3, max）平行開發。規模要小，大約半小時做完：
   一個關卡、三種敵人、一個兩階段的 Boss、強化道具、計分和連擊。寧可做完、做好，也別堆功能。
   工程師各自合併自己的變更，你事後再審查。先傳給我一個 HTML 頁面，裡面有簡短的計畫、
   一張泳道圖和 PD 的設計稿，等我核准後再開工。
   ```

4. **看團隊協作**：
   新啟動的 PD 和工程師會出現在工作區列上，排在各自的專案和功能底下。你核准 HTML 計畫後，他們就開始動工。你隨時可以點進任何一個 agent 的終端機，查看輸出或直接和它對話。

*（注意：這段範例提示詞會以最高推理強度（max）啟動 5 個 agent。請依你手上的訂閱方案調整 CLI、模型、推理強度和工程師人數。）*

## 功能

### 以專案和功能為單位，而不是工作階段

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

大多數 agent 工具會為每個 agent 工作階段建立一個 worktree。Facade Code 反過來：每個 worktree 就是一個功能，列在所屬的儲存庫底下，由你把 agent 指派進去。

一個功能往往不只需要一個 agent。寫程式碼的那個不一定說得清楚自己做了什麼，也不一定有設計眼光，所以其他 agent 會幫忙寫文件、做設計、做審查，全都在同一個 worktree 裡。agent 來來去去，功能一直都在。

- **工作區列**：在一欄裡列出所有儲存庫和功能。點一下就切換整個視窗（檔案總管、編輯器、終端機和原始檔控制），還原成你離開時的樣子。專案之間不會混在一起。請參閱 [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md)。
- **Worktree 生命週期**：**New Worktree**（新增 worktree）會建立分支、同步 `.worktreeinclude` 裡列出的本機檔案，並執行初始設定。**Delete Worktree**（刪除 worktree）在刪除前會詳細列出哪些內容會遺失。請參閱 [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md)。
- **平行子任務**：彼此獨立的任務可以分到各自的 worktree。

### 一支來自各家廠商的團隊

- **原生 CLI，用你自己的訂閱方案**：Claude Code、Codex、Muse Code、Antigravity 和 Qwen Code 各自在自己的整合式終端機裡執行。
- **Agent 啟動 agent**：一個 agent 可以在目前的功能或新的 worktree 裡啟動其他 agent（任何廠商的 CLI 或模型），並指派任務給它們。請參閱 [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) 和 [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md)。
- **訊息**：agent 之間互傳訊息，把結果回報給指派工作的一方，遇到需要人來決定的事就通知你。請參閱 [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md)。
- **互相解圍**：一個 agent 可以讀取另一個 agent 的終端機、回答它的提示、送出按鍵，幫卡住的工程師脫困，不必打擾你。請參閱 [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md)。
- **每一個你都能介入**：每個 agent 在它的功能底下都有自己的一列終端機。你看得到它在做什麼，隨時可以直接在裡面輸入。
- **標準 MCP**：所有協調工具都透過一個標準 MCP 伺服器提供。

## 兩種工作方式

開發者的注意力是瓶頸。這兩種模式代表兩種委派的程度：

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **你的角色** | 親自動手的工程師 | 工程經理 |
| **你直接溝通的對象** | 多個 agent | 一個 tech lead agent，一對一 |
| **誰來協調 agent** | 你 | tech lead |
| **適合** | 需要密切引導的功能：探索性的工作、你想親自判斷的設計決策、經常變動的需求 | 需求明確、能拆成獨立任務的大型功能 |

兩種方式可以在同一個視窗裡混用：敏感的功能自己盯緊，範圍明確的工作交給 tech lead。

- **Super Engineer**：你自己開 worktree，指派任務給各個儲存庫裡的 agent，每完成一個就審查它的程式碼。
- **Super Team**：你把一個功能交給一個 agent，讓它擔任 tech lead。它拆分任務、訂好介面約定、啟動工程師，並審查他們的成果。
  - 由強模型帶隊；更快、更便宜的模型用你現有的訂閱方案平行實作；不同廠商的模型互相審查。
  - 一段提示詞就能把團隊組起來（請參閱[快速開始](#快速開始)）；重複使用的團隊流程可以寫成 skill。

*（這份 README 也是這樣寫出來的：一個 agent 分析，一個 agent 起草，最後由人拍板。）*

## 為什麼

大多數 AI 程式設計工具分成兩派：一派是 Copilot 式的 IDE，人得一行一行跟著看；另一派是 Agent IDE，審查程式碼和除錯要交給外部的編輯器。兩派都沒有把一支跨廠商的原生 agent 團隊放進你的主力 IDE 裡。

我們相信，未來是一位開發者帶著一支 agent 團隊，同時推進多個專案和功能。不同的模型擅長不同的事，所以團隊應該跨廠商。又因為程式碼是 agent 寫、由你來審，這支團隊就該待在你的 IDE 裡。

## 依然是 VS Code

Facade Code 只改動多專案管理和 agent 管理非改不可的地方：

- **工作區列**佔了第一欄；**活動列**移到標題列的右上角（可以用 `workbench.activityBar.location` 改回來）。
- 上游的 Copilot 和聊天預設為關閉（改一項設定就能重新開啟）。
- 其他都是原本的 VS Code：編輯器、設定、鍵盤快速鍵、`.vscode/` 和 `.code-workspace` 檔案。
- 擴充功能從 [Open VSX](https://open-vsx.org) 安裝。少數微軟專有的擴充功能，例如 Remote Development 和 C/C++，只授權給微軟官方版本使用，無法在分支版本中執行。

## 從原始碼建置

把 [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) 交給你的 agent，讓它去建置。

貢獻指南和分支規則請參閱 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md)。

## 意見回饋

- **Bug 和建議**：[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在編輯器裡使用 **Help > Report Issue**（說明 > 回報問題）。
- **安全性漏洞**：請依照 [`SECURITY.md`](SECURITY.md) 私下回報。

## 授權

MIT，與上游 VS Code 相同。微軟的著作權聲明和 Facade Code 貢獻者的聲明請參閱 [`LICENSE.txt`](../../LICENSE.txt)。
