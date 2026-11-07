<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**在 VS Code 里，同时跑多个 Coding Agent。**

直接在 VS Code 里跑各家 Agent CLI，用你自己的 Coding Plan。支持多 Agent 协作，还能跨机器组网。

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

接着装好并登录你要用的 Agent CLI：Claude Code、Codex、Antigravity、Muse Code、OpenCode 或 Pi。Facade Code 直接用各家 CLI 自己的登录和 Coding Plan 把它们跑起来。

> **注意：默认情况下 Agent 会直接跑命令、改文件，不会先问你。** `facade.yolo` 会跳过 CLI 原来的确认提示，关掉它就能恢复。详见[扩展 README](../../../extension/README.md#install)。

## Agent Panel

**在 VS Code 里直接跑各家 Agent CLI。**

Claude Code、Codex、Antigravity、Muse Code、OpenCode 和 Pi 都直接跑在编辑器标签页里，用的是各家 CLI 自己的命令、工具、账号和 Coding Plan。每个 Agent 在面板里都有一张卡片，状态一眼看清。

- **终端就开在编辑器里。** 每个 Agent 的终端都是编辑器里的一个标签页。关掉标签页只是收起来，Agent 在后台照常跑，点一下面板卡片就能切回来。
- **Agent 状态一眼看清。** 卡片上显示你最后发给它的话，以及它在干活、等权限还是报错了；点开能看标题、目录和是谁起的。窗口刷新、扩展重启，Agent 都还在。
- **文件夹和独立 Worktree。** 可以在任意工作区目录起 Agent，也能顺手新建一个 Git Worktree。会话可以固定，下次打开工作区自动恢复；旧会话也能从历史记录里翻出来。

## Agent Use

**Agent 之间能互相控制——直接给对方敲命令、看对方的屏幕。**

走 MCP 和终端协议，各家 Agent 能互相起、停、查、发消息（比如让 Claude Code 去调 Codex）。每个 CLI 用的还是自己的工具和上下文，还能看对方的终端、直接敲命令、按键。

- **互相起、互相停。** 任何 Agent 都能用这六款 CLI 里的任意一款，在这台电脑的任意窗口、目录或新 Worktree 里起别的 Agent，并交代第一个任务。同一个请求 ID 重试，不会重复起 Agent。
- **互发消息。** Agent 之间能互相发消息，也能主动通知你。消息整段送达；如果对方输入框里还有没发出去的字，或者有提示没处理，会等输入框空了再发。
- **接管终端、帮忙解围。** 一个 Agent 能直接看另一个的终端、帮它敲命令和按键，替它解卡。Agent 等权限、输入或登录超过 20 秒，起它的 Agent 会收到提醒。

## Agent Mesh

**所有 Agent 都在同一个网里：连上一个，就能调所有的。**

Facade Code 会把你电脑上所有 VS Code 窗口里的 Agent 连起来。开个 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 窗口，远程机器也能加进来。

- **所有窗口自动连起来。** `facade.yolo` 开着时，Agent 能找到你电脑上所有 Facade 窗口里的 Agent，本地和 Remote - SSH 都算。关掉后，Agent 只能联系自己这一组：你起的那个 Agent，以及它一路起出来的下级 Agent。
- **SSH 把别的机器也拉进来。** 在 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 窗口里，Agent 直接跑在远程机器上，用那台机器的环境、文件和账号。本地的 Agent 可以直接给它们派活、发消息。
- **出门用手机调。** 给电脑上带队的会话开 [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)，手机上的 Claude app 连上就行。CLI 照常跑，消息实时同步。随时看进展、拍板，让带队会话继续调其他 Agent。

<sub>使用 Remote Control 需要支持此特性的 Claude Code 版本、对应的订阅方案以及完整权限登录。详见其[设置要求](https://code.claude.com/docs/en/remote-control#requirements)。</sub>

## Facade Code IDE (Preview)

**项目再多，窗口只要一个。**

在专门的工作区栏里管项目、功能 Worktree 和 Agent 团队。切项目时文件和终端都还在，后台的 Agent 继续跑。

下载 IDE 预览版：[macOS (Apple 芯片, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [所有发布版本](https://github.com/y5ez3g/facadecode/releases)

Facade Code IDE 是基于 VS Code 的分支版本，跟你原本装的 VS Code 互不干扰：设置、扩展和 `facade` 命令行工具完全独立。扩展统一通过 [Open VSX](https://open-vsx.org) 下载；少数微软自家的闭源扩展（如 Remote Development 和 C/C++）仅能在微软官方原版中使用。架构设计与规格文档详见 [`docs/ide/`](../../ide/)。

## 从源码构建

- **扩展：**将 [`extension/AGENTS.md`](../../../extension/AGENTS.md) 交给你的 coding agent 即可构建安装包。
- **IDE：**将 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) 交给你的 coding agent 即可构建应用程序。

关于贡献指南和分支规范，请参阅 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 和 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)。

## 反馈

- **问题与建议：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在 IDE 中选择 **帮助 > 报告问题**。
- **安全漏洞：**请根据 [`SECURITY.md`](../../../SECURITY.md) 私下报告。

## 许可证

采用 MIT 许可证，与上游 VS Code 保持一致。微软的版权声明与 Facade Code 贡献者声明详见 [`LICENSE.txt`](../../../LICENSE.txt)。

<sub>Facade Code 是一款独立产品，与页面所列第三方工具及其厂商无关联、背书或赞助关系。所有第三方商标和徽标均归各自权利人所有。</sub>
