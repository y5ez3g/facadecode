<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**一个 IDE，装下你和你的 AI 团队。**

基于 VS Code。直接运行各家原生的 agent CLI，比如 Claude Code、Codex、Antigravity、Muse Code 和 Qwen Code。

[下载](https://github.com/y5ez3g/facadecode/releases) ·
[规格文档](../../facade-code-spec/) ·
[报告问题](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · **简体中文** · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code 是 VS Code 的一个分支（fork）。各家厂商的原生 agent 在这里一起做你的项目和功能，你在同一个窗口里审代码，随时指挥其中任何一个 agent。

- 🧑‍💻 **完整的 VS Code，按项目和功能组织。** 在一个窗口里同时开发多个项目和功能。每个功能就是一个 git worktree，配一支专属的 agent 团队。
- 🤖 **跨厂商的原生 agent CLI 团队。** agent 用的是你自己的订阅。在 Facade Code 里，agent 能互相启动、互发消息、帮彼此解围。
- 👥 **Super Engineer（超级工程师）或 Super Team（超级团队）。** 你可以亲自指挥多个 agent，也可以指定一个主力模型，让它协调多个各有所长的 agent 并行工作。

## 安装

从 [Releases](https://github.com/y5ez3g/facadecode/releases) 下载最新版本：macOS（Apple 芯片）用 `.dmg`，Windows（x64）用安装程序，Ubuntu（x64）用 `.deb`。

**前提**：先安装并登录你想用的 agent CLI（Claude Code、Codex、Antigravity、Muse Code、Qwen Code，任意组合）。Facade Code 直接运行它们，用的是它们原生的登录和订阅。

Facade Code 和 VS Code 可以同时安装，两者什么都不共享：设置、扩展和 `facade` 命令行工具完全独立。

## 快速开始

1. **打开一个项目**：
   ```sh
   facade ~/code/space-shooter
   ```
   也可以用 **File > Open Folder**（文件 > 打开文件夹），或者把文件夹拖到工作区栏上。文件夹必须是 git 仓库（worktree 依赖 git；新项目请先运行 `git init`）。

2. **启动一个技术负责人**：
   点击标题栏里的机器人图标（Agent 菜单），或者在命令面板里运行 **Agents: Start Agent...**（启动 agent），然后选 Claude Code 或 Codex。从 Facade Code 里启动的 agent 会带上 Facade 的 MCP 工具。

3. **把下面这段提示词交给技术负责人**：
   ```text
   你是技术负责人。用 Facade 做一个浏览器（桌面端）上的霓虹风太空射击游戏，用来演示。
   配一名产品设计师（PD），通过 Codex 用 GPT Sol 6（gpt-6-sol, max），负责视觉和手感；
   再配三名 Muse 1.3 工程师（muse-spark-1.3, max）并行开发。规模要小，大约半小时做完：
   一关、三种敌人、一个两阶段的 Boss、强化道具、计分和连击。宁可做完、做好，也别堆功能。
   工程师各自合并自己的改动，你事后再审查。先发我一个 HTML 页面，里面有简短的计划、
   一张泳道图和 PD 的设计稿，等我批准后再开工。
   ```

4. **看团队协作**：
   新启动的 PD 和工程师会出现在工作区栏里，挂在对应的项目和功能下面。你批准 HTML 计划后，他们就开始做。你随时可以点进任何一个 agent 的终端，查看输出或直接和它对话。

*（注意：这段示例提示词会启动 5 个 agent，全部用 max 推理强度。请按你手头的订阅调整 CLI、模型、推理强度和工程师人数。）*

## 功能

### 以项目和功能为单位，而不是会话

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

大多数 agent 工具给每个 agent 会话建一个 worktree。Facade Code 反过来：每个 worktree 就是一个功能，列在它所属的仓库下面，由你把 agent 分配进去。

一个功能往往不止需要一个 agent。写代码的那个未必讲得清自己做了什么，也未必有设计眼光，所以其他 agent 来帮忙写文档、做设计、做审查，都在同一个 worktree 里。agent 来来去去，功能一直都在。

- **工作区栏**：在一列里列出所有仓库和功能。点一下就切换整个窗口（资源管理器、编辑器、终端和源代码管理），恢复成你离开时的样子。项目之间不会混在一起。见 [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md)。
- **Worktree 生命周期**：**New Worktree**（新建 worktree）会创建分支、同步 `.worktreeinclude` 里列出的本地文件，并运行初始化。**Delete Worktree**（删除 worktree）在删除前会列出哪些内容会丢失。见 [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md)。
- **并行子任务**：互相独立的任务可以分到各自的 worktree 里。

### 一支来自各家厂商的团队

- **原生 CLI，用你自己的订阅**：Claude Code、Codex、Muse Code、Antigravity 和 Qwen Code 各自运行在自己的集成终端里。
- **Agent 启动 agent**：一个 agent 可以在当前功能或新的 worktree 里启动其他 agent（任意厂商的 CLI 或模型），并给它们派任务。见 [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) 和 [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md)。
- **消息**：agent 之间互发消息，把结果汇报给派活的一方，遇到需要人来拍板的事就通知你。见 [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md)。
- **互相解围**：一个 agent 可以读另一个 agent 的终端、回答它的提示、给它发按键，帮卡住的工程师脱困，不用打扰你。见 [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md)。
- **每一个你都能插手**：每个 agent 在它的功能下面都有自己的一行终端。你看得到它在做什么，随时可以直接在里面打字。
- **标准 MCP**：所有编排工具都通过一个标准 MCP 服务器提供。

## 两种工作方式

开发者的注意力是瓶颈。这两种模式代表两种放手的程度：

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **你的角色** | 亲自动手的工程师 | 工程经理 |
| **你直接对接的是** | 多个 agent | 一个技术负责人 agent，一对一 |
| **谁来协调 agent** | 你 | 技术负责人 |
| **适合** | 需要紧密指导的功能：探索性的工作、你想亲自判断的设计决策、经常变动的需求 | 需求明确、能拆成独立任务的大功能 |

两种方式可以在同一个窗口里混用：敏感的功能自己盯紧，范围清楚的工作交给技术负责人。

- **Super Engineer**：你自己开 worktree，给各个仓库里的 agent 派任务，每个做完就审它的代码。
- **Super Team**：你把一个功能交给一个 agent，让它当技术负责人。它拆分任务、定好接口约定、启动工程师，并审查他们的产出。
  - 强模型带队；更快、更便宜的模型用你现有的订阅并行实现；不同厂商的模型互相审查。
  - 一段提示词就能把团队搭起来（见[快速开始](#快速开始)）；反复使用的团队流程可以写成 skill。

*（这份 README 也是这样写出来的：一个 agent 分析，一个 agent 起草，最后由人拍板。）*

## 为什么

大多数 AI 编程工具分两派：一派是 Copilot 式的 IDE，人得一行一行跟着看；另一派是 Agent IDE，审代码和调试要交给外部的编辑器。两派都没有把一支跨厂商的原生 agent 团队放进你的主力 IDE 里。

我们相信，未来是一个开发者带着一支 agent 团队，同时推进多个项目和功能。不同的模型擅长不同的事，所以团队应该跨厂商。又因为代码是 agent 写、由你来审，这支团队就该待在你的 IDE 里。

## 仍然是 VS Code

Facade Code 只改了多项目管理和 agent 管理必须改的地方：

- **工作区栏**占了第一列；**活动栏**移到了标题栏右上角（可以用 `workbench.activityBar.location` 改回去）。
- 上游的 Copilot 和聊天默认关闭（改一项设置就能重新打开）。
- 其他都是原样的 VS Code：编辑器、设置、快捷键、`.vscode/` 和 `.code-workspace` 文件。
- 扩展从 [Open VSX](https://open-vsx.org) 安装。少数微软专有扩展，比如 Remote Development 和 C/C++，只授权给微软官方版本使用，在分支版本里无法运行。

## 从源码构建

把 [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) 交给你的 agent，让它去构建。

贡献指南和分支规则见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md)。

## 反馈

- **Bug 和建议**：[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或者在编辑器里用 **Help > Report Issue**（帮助 > 报告问题）。
- **安全漏洞**：请按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 许可证

MIT，与上游 VS Code 一致。微软的版权声明和 Facade Code 贡献者的声明见 [`LICENSE.txt`](../../LICENSE.txt)。
