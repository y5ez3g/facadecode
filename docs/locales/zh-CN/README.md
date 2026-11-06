<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**VS Code 的多 Agent 编排器。**

在同一个 IDE 窗口中运行各家原生 Agent CLI、编辑代码并审查变更。使用你自己的账户和订阅，让 Agent 跨窗口和跨机器协作。

[![官网: facadecode.com](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: 安装](https://img.shields.io/badge/VS%20Code%20Marketplace-%E5%AE%89%E8%A3%85-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: 安装](https://img.shields.io/badge/Open%20VSX-%E5%AE%89%E8%A3%85-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: 下载 IDE](https://img.shields.io/badge/Releases-%E4%B8%8B%E8%BD%BD%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: 报告问题](https://img.shields.io/badge/Issues-%E6%8A%A5%E5%91%8A%E9%97%AE%E9%A2%98-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · **简体中文** · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![在 facadecode.com 观看 2 分钟演示](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## 安装

```sh
code --install-extension facade.facadecode
```

或从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) 或 [Open VSX](https://open-vsx.org/extension/facade/facadecode) 安装 **Facade Code**。它支持 macOS（Apple 芯片）、Linux (x64) 和 Windows (x64)。

接下来，安装并登录你计划使用的任何受支持的 Agent CLI：Claude Code、Codex、Antigravity、Muse Code、OpenCode 或 Pi。Facade Code 会使用各 CLI 自己的登录状态和订阅启动它们。

> **Agent 默认无需确认即可运行命令。** 在默认启用 `facade.yolo` 的情况下，Agent 无需预先询问即可运行命令和修改文件。将其关闭即可恢复各 CLI 标准的确认提示。详见[扩展 README](../../../extension/README.md#install)。

## Agent Panel

**你的 Agent 与你的 IDE，同处一个窗口。**

Facade Code 在你的文件旁边的编辑器终端标签页中直接运行原生 Agent CLI（Claude Code、Codex、Antigravity、Muse Code、OpenCode 和 Pi），使用各 CLI 自己的命令、工具、账户和订阅。面板中的卡片可实时跟踪每个 Agent 的状态。

- **与你的代码并肩工作。** 每个 Agent 都在编辑器区域的专属终端标签页中运行。关闭标签页只会将其隐藏，Agent 将在后台继续运行；点击其卡片可再次打开。
- **跨 Agent 跟踪状态。** 卡片显示最后发送给每个 Agent 的内容，以及它是否正在工作、需要权限或遇到了错误，详情中则显示其标题、文件夹以及是谁启动了它。Agent 会在窗口重新加载和扩展重启期间持续运行。
- **文件夹与 worktree。** 在任何工作区文件夹中运行 Agent，或动态创建 Git worktree 以保持代码变更相互独立。固定对话可在重新打开工作区时将其恢复，或从历史记录中恢复过去的会话。

## Agent Use

**让 Agent 像你一样操作其他 Agent。**

通过 MCP 和终端协议，Agent 可以启动、停止、查找其他 Agent 并与其收发消息，还可以读取对方的终端屏幕、输入文本并按键。

- **启动和停止 Agent。** 任何 Agent 都可以使用六款 CLI 中的任意一款，在当前计算机上各 Facade 窗口的任意文件夹或新 worktree 中启动其他 Agent，并为其分配第一个任务。带有相同请求 ID 的重试请求绝不会启动重复的 Agent。
- **发送消息。** Agent 之间可以相互收发消息，也可以向你发送消息。Facade 会一次性粘贴整条消息并发送。如果有未发送的文本或提示问题阻挡，发送将会等待，直到输入区域空闲。
- **终端控制。** Agent 可以读取其他 Agent 的屏幕、输入命令并按键，以回答提示或协助受阻的伙伴。当子 Agent 等待权限、回答或登录达到 20 秒时，启动它的 Agent 会收到通知。

## Agent Mesh

**跨窗口、跨机器、跨位置连接 Agent。**

Facade Code 将你在本台计算机上打开的各 Facade 窗口中的 Agent 连接成一个网络。打开 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 窗口即可将协作扩展到另一台机器。

- **跨窗口。** 启用 `facade.yolo` 时，Agent 可以触达你在本台计算机上各 Facade 窗口中的每一个 Agent，无论是本地还是 Remote - SSH 窗口。将其关闭时，Agent 只能触达它自己的群组：即由你启动的 Agent 及其衍生启动的 Agent。
- **通过 SSH 扩展。** 在 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 窗口中，Agent 直接在远程机器上运行，使用该机器上的工具、文件和账户。本地 Agent 可以直接启动和控制 Remote - SSH 窗口中的 Agent。
- **通过手机协调。** 使用 [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) 将 Claude 移动端 App 连接到计算机上的 Claude Code 会话。该会话可以通过 Facade 协调其他 Agent，并将进度汇报到你的手机。

<sub>Remote Control 需要受支持的 Claude Code 版本、符合条件的订阅以及完整范围的登录。详见其[设置要求](https://code.claude.com/docs/en/remote-control#requirements)。</sub>

## Facade Code IDE (Preview)

**多项目。单窗口。**

在专属工作区栏中组织项目、功能 worktree 和 Agent 团队。在带有各自相关文件和终端的项目之间切换，同时 Agent 在后台继续工作。

下载 IDE 预览版：[macOS (Apple 芯片, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [所有发布版本](https://github.com/y5ez3g/facadecode/releases)

该 IDE 是 VS Code 的一个分支版本，与现有编辑器并行安装且不共享任何内容：设置、扩展和 `facade` 命令完全独立。其扩展来自 [Open VSX](https://open-vsx.org)；少数专有 Microsoft 扩展（如 Remote Development 和 C/C++）仅在官方 Microsoft 构建版本中运行。架构与规范见 [`docs/ide/`](../../ide/)。

## 从源码构建

- **扩展：**将 [`extension/AGENTS.md`](../../../extension/AGENTS.md) 提供给你的编程 Agent 即可构建安装包。
- **IDE：**将 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) 提供给你的编程 Agent 即可构建应用程序。

关于贡献指南和分支规范，请参阅 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 和 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)。

## 反馈

- **问题与建议：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在 IDE 中选择 **帮助 > 报告问题**。
- **安全漏洞：**请根据 [`SECURITY.md`](../../../SECURITY.md) 进行私密汇报。

## 许可证

采用 MIT 许可证，与上游 VS Code 保持一致。有关 Microsoft 的版权声明和 Facade Code 贡献者声明，请参阅 [`LICENSE.txt`](../../../LICENSE.txt)。

<sub>Facade Code 是一款独立产品，与所示第三方工具的提供商没有关联、赞助或认可关系。所有第三方商标和徽标均归其各自所有者所有。</sub>
