<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**在自己的几台机器上运行 AI 编程 Agent。**

Facade Code 在你的机器上运行一群 AI 编程 CLI。Agent 可以互相查找、发消息、读屏和往终端里打字。你可从 Shell、VS Code 或任何支持 MCP 的应用指挥它们。每台机器运行自己的 Orchestrator，通过 SSH 互连。

[![官网: facadecode.com](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: 安装](https://img.shields.io/badge/VS%20Code%20Marketplace-%E5%AE%89%E8%A3%85-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: 安装](https://img.shields.io/badge/Open%20VSX-%E5%AE%89%E8%A3%85-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: 报告问题](https://img.shields.io/badge/Issues-%E6%8A%A5%E5%91%8A%E9%97%AE%E9%A2%98-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · **简体中文** · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![在 facadecode.com 观看 2 分钟演示](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## 安装

### Shell

一行安装命令从首次包含独立安装包的版本开始可用。
Shell 安装包支持 macOS、Linux 和 Windows 的 x64 与 arm64。

在 macOS 或 Linux 上运行这条命令。

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

在 Windows PowerShell 中运行这条命令。

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

安装器将 `facade` 和 `facade-mcp` 加入 PATH。打开一个新终端，让新的 PATH 生效。运行 `facade upgrade` 升级。在各台机器上安装并登录所需的 CLI。内置选项有 Claude Code、Codex、Antigravity、Muse Code、OpenCode 和 Pi。

IDE 的启动器也叫 `facade`。两者都装时，Shell 运行 PATH 中排在前面的程序。IDE 预览版退役后，这个命令名归 Orchestrator。运行 `facade --version`。看到形如 `facade <version>` 的输出，就确认用的是 Shell 命令。

### VS Code

```sh
code --install-extension facade.facadecode
```

扩展自带 Orchestrator。在活动栏打开 **Facade Code**，选择 **新建 Agent**、**Go to Agent** 或 **Resume Agent**。macOS、Linux 和 Windows 均有 x64 和 arm64 构建。

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

把 `facade-mcp` 配成 stdio MCP 服务。这个示例使用 `mcpServers` 对象。

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

外部连接在第一次调用工具时以 Guest 加入。发信后，用 `send_message` 返回的 `read_messages` 调用等回信。

## 跨机器工作

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

使用 `facade list` 给出的地址。用平时的 SSH 目标和选项登记另一台机器。要从外面连接 WSL 或 Dev Container，先在里面配置 SSH，再按同样的方式登记。也可以在里面直接运行 Facade。

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

需要时 Facade 在远机装上匹配版本。Facade 在远机使用固定的安装路径。需要手动安装时，选和本机 Orchestrator 相同的版本。在 VS Code 中用 **Go to Agent** 打开 Agent 终端。工作区记住打开过的 Agent、它们的帮手和 Pin。关闭终端 tab 后 Agent 照常运行。**Resume Agent** 和 `facade resume` 会列出可继续的工作。

> **YOLO 默认开启。** 开着时 Agent 可操作已连通机器上的其他 Agent。将所在机器的 `facade.json` 设为 `"yolo": false`，就会沿用 CLI 自己的确认与沙箱，且 MCP 只限调用者的创建树。下次启动或 resume 时生效。用 `facade status` 查看文件位置。

[产品正文](../../facade-code.md) · [词表](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**多项目。单窗口。**

在专属工作区栏中组织项目、功能 worktree 和 Agent 团队。在带有各自相关文件和终端的项目之间切换，同时 Agent 在后台继续工作。

下载 IDE 预览版：[macOS (Apple 芯片, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [所有发布版本](https://github.com/y5ez3g/facadecode/releases)

IDE 预览版可和现有编辑器并行安装，有自己的设置和扩展。 其扩展来自 [Open VSX](https://open-vsx.org)；少数专有 Microsoft 扩展（如 Remote Development 和 C/C++）仅在官方 Microsoft 构建版本中运行。架构与规范见 [`docs/ide/`](../../ide/)。

## 从源码构建

- **扩展：**将 [`extension/AGENTS.md`](../../../extension/AGENTS.md) 提供给你的编程 Agent 即可构建安装包。
- **Orchestrator / Shell.** [构建说明](../../../core/README.md).
- **IDE：**将 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) 提供给你的编程 Agent 即可构建应用程序。

关于贡献指南和分支规范，请参阅 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 和 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)。

## 反馈

- **问题与建议：**[GitHub Issues](https://github.com/y5ez3g/facadecode/issues)，或在 IDE 中选择 **帮助 > 报告问题**。
- **安全漏洞：**请根据 [`SECURITY.md`](../../../SECURITY.md) 进行私密汇报。

## 许可证

采用 MIT 许可证，与上游 VS Code 保持一致。有关 Microsoft 的版权声明和 Facade Code 贡献者声明，请参阅 [`LICENSE.txt`](../../../LICENSE.txt)。

<sub>Facade Code 是一款独立产品，与所示第三方工具的提供商没有关联、赞助或认可关系。所有第三方商标和徽标均归其各自所有者所有。</sub>
