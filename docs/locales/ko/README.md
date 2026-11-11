<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**VS Code를 위한 멀티 에이전트 오케스트레이터.**

동일한 IDE 창에서 네이티브 에이전트 CLI를 실행하고 코드를 편집하며 변경 사항을 검토하세요. 본인 소유의 계정과 구독을 사용하고 에이전트가 창과 머신을 넘어 협업하도록 지원합니다.

[![웹사이트: facadecode.com](https://img.shields.io/badge/%EC%9B%B9%EC%82%AC%EC%9D%B4%E3%83%88-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: 설치](https://img.shields.io/badge/VS%20Code%20Marketplace-%EC%84%A4%EC%B9%98-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: 설치](https://img.shields.io/badge/Open%20VSX-%EC%84%A4%EC%B9%98-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: IDE 다운로드](https://img.shields.io/badge/Releases-IDE%20%EB%8B%A4%EC%9A%B4%EB%A1%9C%EB%93%9C-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: 버그 신고](https://img.shields.io/badge/Issues-%EB%B2%84%EA%B7%B8%20%EC%8B%A0%EA%B3%A0-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · **한국어** · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![facadecode.com에서 2분 데모 영상 보기](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## 설치

```sh
code --install-extension facade.facadecode
```

또는 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) 나 [Open VSX](https://open-vsx.org/extension/facade/facadecode) 에서 **Facade Code**를 설치하세요. macOS(Apple silicon), Linux(x64), Windows(x64)에서 실행됩니다.

다음으로 사용하려는 지원 에이전트 CLI(Claude Code, Codex, Antigravity, Muse Code, OpenCode 또는 Pi)를 설치하고 로그인하세요. Facade Code는 각 CLI의 자체 로그인 및 구독을 사용하여 실행합니다.

> **에이전트는 기본적으로 승인 확인 없이 실행됩니다.** `yolo`가 기본적으로 활성화되어 있어 에이전트가 먼저 묻지 않고 명령을 실행하고 파일을 변경할 수 있습니다. 각 CLI의 표준 승인 프롬프트를 복원하려면 이 설정을 끄세요. 자세한 내용은 [확장 README](../../../extension/README.md#install)를 참조하세요.

## Agent Panel

**에이전트와 IDE가 같은 창에.**

Facade Code는 파일 옆의 편집기 터미널 탭에서 네이티브 에이전트 CLI(Claude Code, Codex, Antigravity, Muse Code, OpenCode, Pi)를 직접 실행하며 각 CLI 고유의 명령, 도구, 계정 및 구독을 사용합니다. 패널의 카드를 통해 각 에이전트의 상태를 실시간으로 추적할 수 있습니다.

- **코드 옆에서 작업.** 각 에이전트는 편집기 영역의 전용 터미널 탭에서 실행됩니다. 탭을 닫아도 뷰가 숨겨질 뿐 에이전트는 백그라운드에서 계속 실행되며, 카드를 클릭하면 다시 열립니다.
- **에이전트 전반의 상태 추적.** 카드는 각 에이전트에 마지막으로 전송된 내용과 현재 작업 중인지, 권한이 필요한지, 오류가 발생했는지를 보여주며, 세부 정보에는 제목, 폴더, 누가 시작했는지가 표시됩니다. 에이전트는 창 다시 로드 및 확장 재시작 중에도 계속 실행됩니다.
- **폴더 및 worktree.** 모든 작업 영역 폴더에서 에이전트를 실행하거나 Git worktree를 즉석에서 생성하여 코드 변경 사항을 분리하세요. 대화를 고정하면 작업 영역을 다시 열 때 대화가 복원되며, 기록에서 과거 세션을 다시 시작할 수도 있습니다.

## Agent Use

**사용자처럼 에이전트가 다른 에이전트를 직접 작동하도록 하세요.**

MCP 및 터미널 프로토콜을 통해 에이전트는 다른 에이전트를 시작, 중지, 검색하고 메시지를 교환하며, 상대의 터미널 화면을 읽고 텍스트를 입력하거나 키를 누를 수 있습니다.

- **에이전트 시작 및 중지.** 모든 에이전트는 6개 CLI 중 하나를 사용하여 이 컴퓨터의 Facade 창에 있는 폴더나 새 worktree에서 다른 에이전트를 시작하고 첫 번째 작업을 할당할 수 있습니다. 동일한 요청 ID를 공유하는 재시도 요청은 에이전트를 중복 생성하지 않습니다.
- **메시지 전송.** 에이전트끼리 서로 메시지를 주고받을 수 있으며 사용자에게 메시지를 보낼 수도 있습니다. Facade는 전체 메시지를 한 번에 붙여넣고 전송합니다. 전송되지 않은 텍스트나 프롬프트 질문이 입력 창을 가로막고 있는 경우 입력 창이 비워질 때까지 전송이 대기합니다.
- **터미널 제어.** 에이전트는 다른 에이전트의 화면을 읽고 명령을 입력하며 키를 전송하여 프롬프트에 응답하거나 막힌 동료를 도울 수 있습니다. 하위 에이전트가 권한, 응답 또는 로그인을 기다린 지 20초가 지나면 이를 시작한 에이전트에게 알림이 전달됩니다.

## Agent Mesh

**창, 머신, 위치를 넘어 에이전트를 연결하세요.**

Facade Code는 이 컴퓨터에서 열려 있는 Facade 창의 에이전트들을 하나의 네트워크로 연결합니다. [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 창을 열어 협업을 다른 머신으로 확장하세요.

- **창을 넘어.** `yolo`가 켜져 있으면 에이전트가 로컬 창과 Remote - SSH 창을 가리지 않고 이 컴퓨터의 모든 Facade 창에 있는 에이전트에 도달할 수 있습니다. 꺼져 있으면 자신이 속한 그룹(사용자가 시작한 에이전트 및 그 에이전트가 파생 시작한 에이전트)에만 도달합니다.
- **SSH를 통한 확장.** [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) 창에서 에이전트는 원격 머신의 도구, 파일, 계정을 사용하여 원격 호스트에서 직접 실행됩니다. 로컬 에이전트가 Remote - SSH 창에 있는 에이전트를 직접 시작하고 지시할 수 있습니다.
- **휴대폰에서 조정.** [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)을 사용하여 휴대폰의 Claude 앱을 컴퓨터의 Claude Code 세션에 연결하세요. 해당 세션이 Facade를 통해 다른 에이전트를 조정하고 진행 상황을 휴대폰으로 보고합니다.

<sub>Remote Control을 사용하려면 지원되는 Claude Code 버전, 적격 구독 및 전체 범위 로그인이 필요합니다. [설정 요구 사항](https://code.claude.com/docs/en/remote-control#requirements)을 참조하세요.</sub>

## Facade Code IDE (Preview)

**여러 프로젝트. 하나의 창.**

전용 작업 영역 표시줄에서 프로젝트, 기능 worktree 및 에이전트 팀을 정리하세요. 에이전트가 백그라운드에서 계속 작업하는 동안 관련 파일과 터미널이 포함된 프로젝트 사이를 전환할 수 있습니다.

IDE 미리 보기 다운로드: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [모든 릴리스](https://github.com/y5ez3g/facadecode/releases)

이 IDE는 기존 편집기와 함께 별도로 설치되는 VS Code의 포크로, 설정, 확장 프로그램 및 `facade` 명령을 전혀 공유하지 않습니다. 확장 프로그램은 [Open VSX](https://open-vsx.org)에서 제공되며, Remote Development 및 C/C++ 같은 일부 Microsoft 전용 독점 확장 프로그램은 공식 Microsoft 빌드에서만 실행됩니다. 아키텍처 및 사양은 [`docs/ide/`](../../ide/)에 있습니다.

## 소스에서 빌드

- **확장 프로그램:** 패키지를 빌드하려면 코딩 에이전트에게 [`extension/AGENTS.md`](../../../extension/AGENTS.md)를 제공하세요.
- **IDE:** 애플리케이션을 빌드하려면 코딩 에이전트에게 [`docs/ide/RELEASE.md`](../../ide/RELEASE.md)를 제공하세요.

기여 가이드라인 및 브랜치 규칙에 대한 자세한 내용은 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) 및 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)를 참조하세요.

## 피드백

- **버그 및 제안:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) 또는 IDE의 **도움말 > 문제 보고**.
- **보안 취약점:** [`SECURITY.md`](../../../SECURITY.md)에 따라 비공개로 보고해 주세요.

## 라이선스

업스트림 VS Code와 동일한 MIT 라이선스입니다. Microsoft 저작권 고지 및 Facade Code 기여자 고지는 [`LICENSE.txt`](../../../LICENSE.txt)를 참조하세요.

<sub>Facade Code는 독립적인 제품이며 표시된 타사 도구 제공업체와 제휴, 보증 또는 후원 관계가 아닙니다. 모든 타사 상표 및 로고는 해당 소유자의 자산입니다.</sub>
