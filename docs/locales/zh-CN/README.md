<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**在 VS Code 里同时指挥多个 coding agent。**

在同一个 IDE 窗口里运行原生 agent CLI、写代码并审查改动。用你自己的账号和订阅，让 agent 跨窗口、跨机器协同工作。

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

接下来，安装并登录你想使用的任何 agent CLI：Claude Code、Codex、Antigravity、Muse Code、OpenCode 或 Pi。Facade Code 会直接用各 CLI 自己的登录状态和订阅启动它们。

> **注意：默认情况下 agent 会直接运行命令和改动文件，不会先问你。** 在 `facade.yolo` 开启时，agent 所有操作都不会弹框请求确认。如果你希望恢复各 CLI 原本的确认提示，可以在设置里关掉它。详见[扩展 README](../../../extension/README.md#install)。

## Agent Panel

**你的 agent 和你的 IDE，都在同一个窗口里。**

Facade Code 在代码文件旁边的编辑器终端标签页中直接运行原生 agent CLI（Claude Code、Codex、Antigravity、Muse Code、OpenCode 和 Pi），使用各 CLI 自己的命令、工具、账号和订阅。每个 agent 在面板里都有一张卡片，一眼就能看清当前状态。

- **终端直接开在编辑器里。** 每个 agent 的终端都是编辑器里的专属标签页。关掉标签页也只是收起，agent 在后台继续跑，点一下面板卡片就能随时切回来。
- **所有 agent 状态一目了然。** 卡片上直接显示你发给它的上一句话，以及它是在干活、等权限还是报了错；点开详情能看标题、工作目录和是谁启动的。窗口刷新或者扩展重启，agent 依然都在。
- **文件夹与独立 worktree。** 可以在任何工作区目录下起 agent，也能顺手新开一个 Git worktree，各做各的代码互不冲突。常用会话可以固定在面板上，下次打开工作区自动恢复，或者随时从历史记录里把旧会话翻出来。

## Agent Use

**让 agent 像你一样，直接操作其他 agent。**

借助 MCP 和终端协议，不同厂商的 agent 之间能相互启动、停止、查找和发消息（比如让 Claude Code 指挥 Codex）。每个 CLI 保留各自原有的工具和上下文管理方式，还能读取彼此的终端屏幕、敲入命令、发送按键。

- **互相启动与停止。** 任何 agent 都能用这六款 CLI 中的任意一款，在当前电脑任意窗口的目录或新 worktree 里启动其他 agent 并交代第一个任务。即使遇到重试，只要请求 ID 一样，就不会误启动重复的 agent。
- **互发消息汇报。** agent 之间能互相发消息，也能主动给你发通知。Facade 会把整段消息直接送达；如果输入框里还有没发出去的字或弹出的提示没处理完，会等输入框空出来再发。
- **终端接管与解困。** 一个 agent 能直接看另一个 agent 的终端屏幕、代敲命令和按键，帮队友回答提示或解决卡住的问题。如果子 agent 等待权限、输入或登录超过 20 秒，启动它的 agent 就会收到提醒。

## Agent Mesh

**不管在哪个窗口、哪台机器，所有 agent 全都互通。**

Facade Code 能打通你电脑上所有编辑器窗口里的 agent。打开一个 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 窗口，协作网络就能立刻延伸到另一台机器上。

- **所有窗口自动组网。** 在默认开启 `facade.yolo` 时，agent 能直接找到你电脑上任何一个 Facade 窗口里的所有 agent，不管本地还是 Remote - SSH。关掉它后，agent 只能联系它自己的小团队：即你启动的那个 agent，以及它后面一路启动起来的下级 agent。
- **用 SSH 把其他机器拉进团队。** 在 [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 窗口里，agent 直接运行在远程机器上，就地使用远程机器上的环境、文件和账号。本地电脑上的 agent 可以直接给它们派任务、互发消息。
- **出门在外用手机指挥。** 给电脑上的带队会话开启 [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)，手机上的 Claude app 就能直接连上来。电脑上的 CLI 照常跑，手机和电脑消息实时同步。你可以随时看进展、拍板做决定，让带队会话继续调度其他 agent。

<sub>使用 Remote Control 需要支持此特性的 Claude Code 版本、对应的订阅方案以及完整权限登录。详见其[设置要求](https://code.claude.com/docs/en/remote-control#requirements)。</sub>

## Facade Code IDE (Preview)

**项目再多，窗口只要一个。**

在专用的工作区栏里统一管理项目、功能 worktree 和 agent 团队。随时切换项目，对应的文件和终端都在原处，后台跑着的 agent 照样不受打扰。

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
