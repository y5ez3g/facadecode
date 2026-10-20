<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**당신과 AI 팀을 위한 하나의 IDE.**

VS Code 기반. Claude Code, Codex, Antigravity, Muse Code, Qwen Code 같은 네이티브 에이전트 CLI를 그대로 실행합니다.

[다운로드](https://github.com/y5ez3g/facadecode/releases) ·
[사양](../../facade-code-spec/) ·
[버그 신고](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · **한국어** · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code는 VS Code의 포크입니다. 모든 벤더의 네이티브 에이전트가 당신의 프로젝트와 기능에서 함께 일하고, 당신은 같은 창에서 코드를 리뷰하며 어떤 에이전트든 직접 이끌 수 있습니다.

- 🧑‍💻 **프로젝트와 기능 단위로 정리된 완전한 VS Code.** 한 창에서 여러 프로젝트와 기능을 동시에 개발하세요. 각 기능은 하나의 git worktree이며, 전담 에이전트 팀이 붙습니다.
- 🤖 **벤더를 넘나드는 네이티브 에이전트 CLI 팀.** 에이전트는 당신이 이미 구독 중인 요금제로 동작합니다. Facade Code 안에서 에이전트들은 다른 에이전트를 시작하고, 메시지를 주고받으며, 일이 막히면 서로 도와줍니다.
- 👥 **Super Engineer 또는 Super Team.** 여러 에이전트를 직접 지휘하거나, 리드 모델을 정해 전문가들을 병렬로 조율하게 하세요.

## 설치

[Releases](https://github.com/y5ez3g/facadecode/releases)에서 최신 버전을 내려받으세요. macOS(Apple 실리콘)용 `.dmg`, Windows(x64)용 설치 프로그램, Ubuntu(x64)용 `.deb`가 있습니다.

**사전 준비**: 사용하려는 에이전트 CLI(Claude Code, Codex, Antigravity, Muse Code, Qwen Code 중 원하는 조합)를 설치하고 로그인해 두세요. Facade Code는 각 CLI의 네이티브 인증과 구독을 그대로 사용해 직접 실행합니다.

Facade Code는 VS Code와 나란히 설치되며 아무것도 공유하지 않습니다. 설정, 확장, `facade` 명령줄 도구가 모두 완전히 분리되어 있습니다.

## 빠른 시작

1. **프로젝트 열기**:
   ```sh
   facade ~/code/space-shooter
   ```
   또는 **File > Open Folder**(파일 > 폴더 열기)를 쓰거나, 폴더를 워크스페이스 바에 끌어다 놓으세요. 폴더는 git 저장소여야 합니다(worktree에는 git이 필요합니다. 새로 시작한다면 먼저 `git init`을 실행하세요).

2. **테크 리드 시작하기**:
   제목 표시줄의 로봇 아이콘(Agent 메뉴)을 클릭하거나, 명령 팔레트에서 **Agents: Start Agent...**(에이전트 시작)를 실행한 뒤 Claude Code나 Codex를 고르세요. Facade Code 안에서 실행한 에이전트에는 Facade의 MCP 도구가 갖춰집니다.

3. **테크 리드용 프롬프트 건네기**:
   ```text
   너는 테크 리드야. Facade로 데모용 브라우저(데스크톱) 네온 우주 슈팅 게임을 만들어 줘.
   룩앤필을 맡을 PD 한 명은 Codex를 통해 GPT Sol 6(gpt-6-sol, max)로, 병렬로 일할
   Muse 1.3 엔지니어(muse-spark-1.3, max) 세 명을 붙여 줘. 규모는 작게, 30분 정도면
   만들 수 있는 수준으로: 스테이지 하나, 적 세 종류, 2페이즈 보스, 파워업, 점수와 콤보.
   기능을 늘리는 것보다 완성도와 마무리가 중요해. 엔지니어는 자기 작업을 직접 머지하고,
   너는 나중에 리뷰해. 짧은 계획, 스윔레인 다이어그램, PD의 목업을 담은 HTML 페이지 하나를
   보내 주고, 내가 승인할 때까지 시작하지 말고 기다려.
   ```

4. **팀의 협업 지켜보기**:
   새로 실행된 PD와 엔지니어가 워크스페이스 바에서 각자의 프로젝트와 기능 아래에 나타납니다. HTML 계획을 승인하면 바로 만들기 시작합니다. 언제든 어느 에이전트의 터미널이든 클릭해 들어가서 출력을 확인하거나 직접 대화할 수 있습니다.

*(참고: 이 예시 프롬프트는 에이전트 5개를 최대 추론 수준으로 실행합니다. 가진 요금제에 맞게 CLI, 모델, 추론 수준, 엔지니어 수를 조정하세요.)*

## 기능

### 세션이 아니라 프로젝트와 기능

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

대부분의 에이전트 도구는 에이전트 세션마다 worktree를 하나씩 만듭니다. Facade Code는 반대입니다. worktree 하나가 기능 하나이고, 저장소 아래에 나열되며, 당신이 거기에 에이전트를 배정합니다.

기능 하나에는 에이전트가 여럿 필요한 경우가 많습니다. 코드를 쓰는 에이전트가 자기 작업을 잘 설명하지 못하거나 디자인 감각이 부족할 수 있으니, 같은 worktree에서 다른 에이전트들이 문서, 디자인, 리뷰를 돕습니다. 에이전트는 오고 가도, 기능은 남습니다.

- **워크스페이스 바**: 모든 저장소와 기능을 한 열에 보여 줍니다. 하나를 클릭하면 창 전체(탐색기, 편집기, 터미널, 소스 제어)가 전환되고, 떠날 때 모습 그대로 복원됩니다. 프로젝트끼리 섞이지 않습니다. [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md)를 참고하세요.
- **worktree 수명 주기**: **New Worktree**(새 worktree)는 브랜치를 만들고, `.worktreeinclude`에 적힌 로컬 파일을 동기화하고, 초기 설정을 실행합니다. **Delete Worktree**(worktree 삭제)는 지우기 전에 무엇이 사라지는지 자세히 보여 줍니다. [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md)를 참고하세요.
- **병렬 하위 작업**: 서로 독립적인 작업은 별도의 worktree로 나눌 수 있습니다.

### 모든 벤더로 꾸린 팀

- **당신의 요금제로 도는 네이티브 CLI**: Claude Code, Codex, Muse Code, Antigravity, Qwen Code가 각자의 통합 터미널에서, 이미 가진 구독으로 실행됩니다.
- **에이전트가 에이전트를 실행**: 에이전트는 현재 기능이나 새 worktree에서 다른 에이전트(어느 벤더의 CLI나 모델이든)를 실행하고 작업을 맡길 수 있습니다. [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md)와 [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md)를 참고하세요.
- **메시지**: 에이전트끼리 메시지를 주고받고, 결과를 요청한 쪽에 보고하며, 사람의 승인이 필요한 결정이 있으면 당신에게 알립니다. [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md)를 참고하세요.
- **서로 막힌 곳 풀어 주기**: 에이전트는 다른 에이전트의 터미널을 읽고, 프롬프트에 답하고, 키 입력을 보내서, 당신을 방해하지 않고 막힌 작업자를 돕습니다. [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md)를 참고하세요.
- **어느 에이전트에든 개입 가능**: 에이전트마다 자기 기능 아래에 자기 터미널 행이 있습니다. 무엇을 하고 있는지 보이고, 언제든 직접 입력할 수 있습니다.
- **표준 MCP**: 모든 오케스트레이션 도구는 표준 MCP 서버로 제공됩니다.

## 두 가지 작업 방식

병목은 개발자의 주의력입니다. 두 모드는 위임의 두 단계를 나타냅니다.

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **당신의 역할** | 직접 손을 쓰는 엔지니어 | 엔지니어링 매니저 |
| **직접 상대하는 대상** | 여러 에이전트와 직접 | 테크 리드 에이전트와 1:1 |
| **에이전트를 조율하는 쪽** | 당신 | 테크 리드 |
| **적합한 경우** | 가까이서 이끌어야 하는 기능: 탐색적인 작업, 직접 판단하고 싶은 설계 결정, 자주 바뀌는 요구 사항 | 깔끔하게 나눌 수 있는, 크고 잘 정의된 기능 |

같은 창에서 둘을 섞어 쓸 수 있습니다. 민감한 기능은 직접 꼼꼼히 챙기고, 범위가 분명한 작업은 리드에게 맡기세요.

- **Super Engineer**: 직접 worktree를 열고, 여러 저장소에 걸쳐 에이전트에게 작업을 맡기고, 끝나는 대로 코드를 리뷰합니다.
- **Super Team**: 기능 하나를 테크 리드 역할의 에이전트에게 넘깁니다. 리드는 작업을 나누고, 인터페이스 계약을 정하고, 작업자를 실행하고, 결과물을 리뷰합니다.
  - 강한 모델이 이끌고, 더 빠르고 저렴한 모델이 이미 가진 요금제로 병렬 구현하며, 서로 다른 벤더의 모델이 서로의 작업을 리뷰합니다.
  - 프롬프트 하나면 꾸릴 수 있고([빠른 시작](#빠른-시작) 참고), 반복해서 쓰는 팀 워크플로는 skill로 적어 둘 수 있습니다.

*(이 README도 같은 방식으로 쓰였습니다. 에이전트 하나가 분석하고, 하나가 초안을 쓰고, 마지막 결정은 사람이 내렸습니다.)*

## 왜 만들었나

대부분의 AI 코딩 도구는 두 진영으로 나뉩니다. 사람이 한 줄 한 줄 따라가야 하는 Copilot 스타일의 IDE, 그리고 코드 리뷰와 디버깅을 외부 편집기에 맡기는 에이전트 IDE. 어느 쪽도 벤더를 넘나드는 네이티브 에이전트 팀을 당신의 주력 IDE 안에 모아 주지 않습니다.

우리는 한 명의 개발자가 에이전트 팀과 함께 여러 프로젝트와 기능을 이끄는 미래를 믿습니다. 모델마다 잘하는 일이 다르니, 팀은 여러 벤더로 꾸려야 합니다. 그리고 당신이 리뷰하는 코드를 쓰는 게 에이전트이니, 그 팀은 당신의 IDE 안에 있어야 합니다.

## 여전히 VS Code

Facade Code는 여러 프로젝트와 에이전트를 관리하는 데 꼭 필요한 부분만 바꿉니다.

- **워크스페이스 바**가 첫 번째 열을 차지하고, **작업 표시줄**은 제목 표시줄 오른쪽 위로 옮겨집니다(`workbench.activityBar.location`으로 되돌릴 수 있습니다).
- 업스트림의 Copilot과 채팅은 기본적으로 꺼져 있습니다(설정 하나로 다시 켤 수 있습니다).
- 나머지는 모두 그대로인 VS Code입니다. 편집기, 설정, 키 바인딩, `.vscode/`, `.code-workspace` 파일까지.
- 확장은 [Open VSX](https://open-vsx.org)에서 설치합니다. Remote Development, C/C++ 같은 일부 Microsoft 독점 확장은 Microsoft 공식 빌드에만 라이선스가 있어 포크에서는 실행할 수 없습니다.

## 소스에서 빌드하기

[`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md)를 에이전트에게 건네고, 빌드를 맡기세요.

기여 가이드라인과 브랜치 규칙은 [`CONTRIBUTING.md`](CONTRIBUTING.md)와 [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md)를 참고하세요.

## 피드백

- **버그와 아이디어**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) 또는 편집기의 **Help > Report Issue**(도움말 > 문제 보고).
- **보안 취약점**: [`SECURITY.md`](SECURITY.md)에 따라 비공개로 제보해 주세요.

## 라이선스

MIT, 업스트림 VS Code와 같습니다. Microsoft의 저작권 고지와 Facade Code 기여자들의 고지는 [`LICENSE.txt`](../../LICENSE.txt)를 참고하세요.
