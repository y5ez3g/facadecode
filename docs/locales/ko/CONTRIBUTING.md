# Facade Code에 기여하기

도와주셔서 고맙습니다. Facade Code는 [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode)에서 공개적으로 개발됩니다.

## 버그와 아이디어

[issue](https://github.com/y5ez3g/facadecode/issues)를 열어 주세요. Help > Report Issue(도움말 > 문제 보고)를 쓰면 버전이 채워진 새 issue가 열립니다. 먼저 기존 issue를 검색해 보시고, 버그라면 다음을 적어 주세요.

- 무엇을 했고, 무엇을 기대했고, 실제로 무슨 일이 일어났는지
- 버전(Help > About(도움말 > 정보)에서 확인)과 운영 체제
- 에이전트 문제라면 어떤 에이전트 CLI의 어떤 버전인지

보안 취약점은 issue로 신고하지 마세요. [`SECURITY.md`](SECURITY.md)를 참고하세요.

## 코드

이 저장소의 작업 방식은 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md)에 있습니다. 빌드 준비, 변경 사항을 검사하는 명령, 아래 규칙의 전체 내용이 담겨 있습니다.

- `main`에서 `feature/<name>` 이름으로 브랜치를 만듭니다.
- rebase하지 않고 항상 merge합니다. 기능은 리뷰를 거쳐 `--no-ff`로 `main`에 들어갑니다.
- Facade Code의 파일은 한곳에 모으고, VS Code의 파일에는 로직을 다시 쓰는 대신 선택적인 훅을 추가합니다. 그래야 새 VS Code를 병합하는 비용이 낮게 유지됩니다.
- 모든 기능에는 스위치가 있고, 끄면 순정 VS Code입니다.
- 모든 변경에는 테스트를 포함합니다.
- 문서, 주석, 커밋 메시지는 모두 영어로 씁니다.

각 기능이 무엇을 해야 하는지는 [`docs/ide/`](../../ide/)에 있습니다. 동작을 바꾸려면 사양부터 시작하거나, 먼저 issue를 열어 논의해 주세요.

## 라이선스

기여하면 기여한 내용이 프로젝트의 [MIT 라이선스](../../../LICENSE.txt)에 따라 라이선스되는 데 동의하는 것으로 간주됩니다.
