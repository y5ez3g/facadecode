<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Jedno IDE dla ciebie i twojego zespołu AI.**

Zbudowane na VS Code. Uruchamia natywne CLI twoich agentów, takie jak Claude Code, Codex, Antigravity, Muse Code i Qwen Code.

[Pobierz](https://github.com/y5ez3g/facadecode/releases) ·
[Specyfikacje](../../facade-code-spec/) ·
[Zgłoś błąd](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · **Polski**

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code to fork VS Code, w którym natywni agenci wszystkich dostawców współpracują nad twoimi projektami i funkcjami, a ty w tym samym oknie przeglądasz kod i kierujesz dowolnym agentem.

- 🧑‍💻 **Pełne VS Code, uporządkowane według projektów i funkcji.** Rozwijaj wiele projektów i funkcji w jednym oknie. Każda funkcja to osobny git worktree z własnym zespołem agentów.
- 🤖 **Zespół natywnych CLI agentów od różnych dostawców.** Agenci działają na subskrypcjach, które już masz. W Facade Code agenci uruchamiają się nawzajem, wysyłają sobie wiadomości i pomagają sobie, gdy któryś utknie.
- 👥 **Super Engineer albo Super Team.** Kieruj wieloma agentami samodzielnie albo wyznacz model prowadzący, który równolegle koordynuje specjalistów.

## Instalacja

Pobierz najnowsze wydanie z [Releases](https://github.com/y5ez3g/facadecode/releases): plik `.dmg` dla macOS (Apple silicon), instalator dla Windows (x64) albo pakiet `.deb` dla Ubuntu (x64).

**Wymagania wstępne**: zainstaluj CLI agentów, z których chcesz korzystać, i zaloguj się do nich (dowolne połączenie Claude Code, Codex, Antigravity, Muse Code lub Qwen Code). Facade Code uruchamia je bezpośrednio, z ich natywnym uwierzytelnianiem i subskrypcjami.

Facade Code instaluje się obok VS Code i nie dzieli z nim niczego: ustawienia, rozszerzenia i narzędzie wiersza poleceń `facade` są całkowicie oddzielne.

## Szybki start

1. **Otwórz projekt**:
   ```sh
   facade ~/code/space-shooter
   ```
   Możesz też użyć **File > Open Folder** (Plik > Otwórz folder) albo upuścić folder na pasek obszarów roboczych. Folder musi być repozytorium git (worktree wymagają gita; jeśli zaczynasz od zera, najpierw uruchom `git init`).

2. **Uruchom tech leada**:
   Kliknij ikonę robota na pasku tytułu (menu Agent) albo uruchom **Agents: Start Agent...** (uruchom agenta) w palecie poleceń i wybierz Claude Code lub Codex. Agent uruchomiony z poziomu Facade Code dostaje narzędzia MCP Facade.

3. **Daj mu prompt dla tech leada**:
   ```text
   Jesteś tech leadem. Użyj Facade, żeby zbudować na demo neonową kosmiczną strzelankę
   w przeglądarce (desktop), z PD na GPT Sol 6 (gpt-6-sol, max) przez Codex, który
   odpowiada za wygląd i odczucia z gry, oraz trzema inżynierami Muse 1.3
   (muse-spark-1.3, max) pracującymi równolegle. Niech będzie mała, około pół godziny
   budowania: jeden poziom, trzy typy przeciwników, boss z dwiema fazami, power-upy,
   punkty i combosy. Lepiej skończyć i dopracować grę, niż dodawać kolejne funkcje. Inżynierowie
   sami merge'ują swoją pracę, a ty przeglądasz ją potem. Wyślij mi jedną stronę HTML
   z krótkim planem, diagramem torów (swimlane) i makietą od PD, i poczekaj na moją
   zgodę, zanim zaczniesz.
   ```

4. **Obserwuj, jak zespół współpracuje**:
   Uruchomiony PD i inżynierowie pojawiają się na pasku obszarów roboczych, pod swoim projektem i funkcją. Gdy zatwierdzisz plan w HTML, zaczynają budować. W każdej chwili możesz kliknąć terminal dowolnego agenta, żeby zobaczyć jego wyjście albo porozmawiać z nim bezpośrednio.

*(Uwaga: ten przykładowy prompt uruchamia 5 agentów na najwyższym poziomie rozumowania. Dostosuj CLI, modele, poziomy rozumowania i liczbę inżynierów do subskrypcji, które masz.)*

## Funkcje

### Projekty i funkcje, a nie sesje

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

Większość narzędzi agentowych tworzy osobny worktree dla każdej sesji agenta. Facade Code robi odwrotnie: każdy worktree to funkcja, wymieniona pod swoim repozytorium, a ty przydzielasz do niej agentów.

Funkcja często potrzebuje więcej niż jednego agenta. Ten, który pisze kod, może nie umieć jasno wyjaśnić swojej pracy albo nie mieć oka do designu, więc inni agenci pomagają przy dokumentacji, designie i przeglądzie kodu, wszyscy w tym samym worktree. Agenci przychodzą i odchodzą; funkcja zostaje.

- **Pasek obszarów roboczych**: pokazuje wszystkie repozytoria i funkcje w jednej kolumnie. Kliknięcie przełącza całe okno (eksplorator, edytory, terminale i kontrolę źródła) i przywraca je do stanu, w jakim je zostawiłeś. Projekty nigdy się nie mieszają. Zobacz [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Cykl życia worktree**: **New Worktree** (nowy worktree) tworzy gałąź, synchronizuje lokalne pliki wymienione w `.worktreeinclude` i uruchamia konfigurację. **Delete Worktree** (usuń worktree) przed usunięciem pokazuje szczegółowo, co zostałoby utracone. Zobacz [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Równoległe podzadania**: niezależne zadania mogą trafić do osobnych worktree.

### Zespół od wszystkich dostawców

- **Natywne CLI na twoich własnych subskrypcjach**: Claude Code, Codex, Muse Code, Antigravity i Qwen Code działają we własnych zintegrowanych terminalach, korzystając z subskrypcji, które już masz.
- **Agenci uruchamiają agentów**: agent może uruchamiać innych agentów (z CLI lub modelem dowolnego dostawcy) w bieżącej funkcji albo w nowym worktree i przydzielać im zadania. Zobacz [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) i [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Wiadomości**: agenci wysyłają sobie wiadomości, raportują wyniki temu, kto ich wywołał, i powiadamiają cię, gdy decyzja wymaga zgody człowieka. Zobacz [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Odblokowują się nawzajem**: agent może czytać terminal innego agenta, odpowiadać na jego pytania i wysyłać naciśnięcia klawiszy, żeby pomóc zablokowanemu wykonawcy, nie przeszkadzając tobie. Zobacz [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Możesz włączyć się w pracę każdego agenta**: każdy agent ma własny wiersz terminala pod swoją funkcją. Widzisz, co robi, i w każdej chwili możesz pisać bezpośrednio w nim.
- **Standardowe MCP**: wszystkie narzędzia orkiestracji są udostępniane przez standardowy serwer MCP.

## Dwa sposoby pracy

Wąskim gardłem jest uwaga programisty. Dwa tryby odpowiadają dwóm poziomom delegowania:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Twoja rola** | Inżynier, który sam pracuje przy kodzie | Engineering manager |
| **Z kim masz kontakt** | Bezpośrednio z wieloma agentami | Z agentem tech leadem, 1:1 |
| **Kto koordynuje agentów** | Ty | Tech lead |
| **Najlepsze do** | Funkcji wymagających bliskiego prowadzenia: pracy eksploracyjnej, decyzji projektowych, które chcesz ocenić sam, zmieniających się wymagań | Dużych, dobrze zdefiniowanych funkcji, które da się czysto podzielić |

Oba tryby możesz łączyć w jednym oknie: trzymać ścisłą kontrolę nad wrażliwymi funkcjami i oddawać liderowi pracę o jasno określonym zakresie.

- **Super Engineer**: otwierasz worktree, przydzielasz zadania agentom w różnych repozytoriach i przeglądasz kod, gdy każdy z nich skończy.
- **Super Team**: przekazujesz funkcję agentowi jako tech leadowi. Dzieli on pracę na zadania, ustala kontrakty interfejsów, uruchamia wykonawców i przegląda ich wyniki.
  - Prowadzi mocny model; szybsze i tańsze modele, na subskrypcjach, które już masz, implementują równolegle; a modele różnych dostawców przeglądają nawzajem swoją pracę.
  - Do zbudowania tego wystarczy prompt (zobacz [Szybki start](#szybki-start)); przepływy pracy zespołu, do których wracasz, można zapisać jako skille.

*(Ten README powstał tak samo: jeden agent przeanalizował, drugi napisał szkic, a ostateczną decyzję podjął człowiek.)*

## Dlaczego

Większość narzędzi AI do programowania dzieli się na dwa obozy: IDE w stylu Copilota, w których człowiek musi śledzić kod linijka po linijce, oraz agentowe IDE, w których przegląd kodu i debugowanie przenosi się do zewnętrznego edytora. Żadne z nich nie łączy zespołu natywnych agentów od różnych dostawców w twoim głównym IDE.

Wierzymy, że przyszłość to jeden programista, który z zespołem agentów prowadzi wiele projektów i funkcji. Różne modele są dobre w różnych zadaniach, więc zespół powinien obejmować wielu dostawców. A ponieważ kod, który przeglądasz, piszą agenci, ten zespół powinien być w twoim IDE.

## Wciąż VS Code

Facade Code zmienia tylko to, czego wymaga zarządzanie wieloma projektami i agentami:

- **Pasek obszarów roboczych** zajmuje pierwszą kolumnę; **pasek aktywności** przenosi się w prawy górny róg paska tytułu (można to przywrócić przez `workbench.activityBar.location`).
- Copilot i czat z upstreamu są domyślnie wyłączone (jedno ustawienie włącza je z powrotem).
- Cała reszta to zwykłe VS Code: edytor, ustawienia, skróty klawiszowe, `.vscode/` i pliki `.code-workspace`.
- Rozszerzenia instaluje się z [Open VSX](https://open-vsx.org). Kilka zastrzeżonych rozszerzeń Microsoftu, takich jak Remote Development i C/C++, jest licencjonowanych wyłącznie dla oficjalnych buildów Microsoftu i nie działa w forkach.

## Budowanie ze źródeł

Przekaż [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) swojemu agentowi i pozwól mu zbudować projekt.

Wytyczne dla współtwórców i zasady pracy z gałęziami znajdziesz w [`CONTRIBUTING.md`](CONTRIBUTING.md) i [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md).

## Opinie

- **Błędy i pomysły**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) albo **Help > Report Issue** (Pomoc > Zgłoś problem) w edytorze.
- **Luki bezpieczeństwa**: zgłaszaj je prywatnie, zgodnie z [`SECURITY.md`](SECURITY.md).

## Licencja

MIT, tak jak w upstreamowym VS Code. Informację o prawach autorskich Microsoftu i informacje współtwórców Facade Code znajdziesz w [`LICENSE.txt`](../../LICENSE.txt).
