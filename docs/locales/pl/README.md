<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Orkiestrator wielu agentów dla VS Code.**

Uruchamiaj natywne CLI agentów, edytuj kod i przeglądaj zmiany w tym samym oknie IDE. Korzystaj z własnych kont i planów subskrypcji oraz pozwól agentom współpracować między oknami i maszynami.

[![Witryna: facadecode.com](https://img.shields.io/badge/Witryna-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: zainstaluj](https://img.shields.io/badge/VS%20Code%20Marketplace-zainstaluj-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: zainstaluj](https://img.shields.io/badge/Open%20VSX-zainstaluj-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Wydania: pobierz IDE](https://img.shields.io/badge/Wydania-pobierz%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Zgłoszenia: zgłoś błąd](https://img.shields.io/badge/Zg%C5%82oszenia-zg%C5%82o%C5%9B%20b%C5%82%C4%85d-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · **Polski**

</div>

[![Obejrzyj 2-minutowe demo na facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalacja

```sh
code --install-extension facade.facadecode
```

Możesz też zainstalować **Facade Code** z [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) lub [Open VSX](https://open-vsx.org/extension/facade/facadecode). Działa na macOS (Apple silicon), Linux (x64) i Windows (x64).

Następnie zainstaluj i zaloguj się do obsługiwanych CLI agentów, których zamierzasz używać: Claude Code, Codex, Antigravity, Muse Code, OpenCode lub Pi. Facade Code uruchamia każde CLI, korzystając z jego własnego logowania i subskrypcji.

> **Domyślnie agenci działają bez monitów o zatwierdzenie.** Przy włączonej domyślnie opcji `facade.yolo` agenci mogą wykonywać polecenia i modyfikować pliki bez pytania. Wyłącz ją, aby przywrócić standardowe monity o zatwierdzenie każdego CLI. Zobacz [README rozszerzenia](../../../extension/README.md#install).

## Agent Panel

**Twoi agenci i Twoje IDE w jednym oknie.**

Facade Code uruchamia natywne CLI agentów (Claude Code, Codex, Antigravity, Muse Code, OpenCode i Pi) na kartach terminala edytora obok Twoich plików, korzystając z własnych poleceń, narzędzi, kont i subskrypcji każdego CLI. Karta w panelu śledzi stan każdego agenta.

- **Pracuj obok swojego kodu.** Każdy agent działa na własnej karcie terminala w obszarze edytora. Zamknięcie karty ukrywa ją, podczas gdy agent nadal działa; kliknięcie jego karty w panelu otwiera ją ponownie.
- **Śledź stan wszystkich agentów.** Karty pokazują, kto uruchomił danego agenta, co robi oraz czy jest gotowy na dane wejściowe, wymaga uprawnień czy napotkał błąd. Agenci działają nieprzerwanie podczas przeładowań okna i restartów rozszerzenia.
- **Foldery i drzewa robocze.** Uruchamiaj agentów w dowolnym folderze obszaru roboczego lub twórz drzewo robocze Git (worktree) w locie, aby odseparować zmiany w kodzie. Przypnij konwersację (Pin), aby przywrócić ją po ponownym otwarciu obszaru roboczego, lub wznawiaj wcześniejsze sesje z historii.

## Agent Use

**Pozwól agentom zarządzać innymi agentami tak samo jak Ty.**

Dzięki MCP i protokołowi terminala agenci mogą uruchamiać, zatrzymywać, wyszukiwać i przesyłać wiadomości do innych agentów, czytać ekrany ich terminali, wpisywać tekst i naciskać klawisze.

- **Uruchamiaj i zatrzymuj agentów.** Agent może uruchamiać innych agentów za pomocą dowolnego z sześciu CLI, w dowolnym folderze lub nowym drzewie roboczym Twoich okien Facade na tym komputerze, i zlecać im pierwsze zadanie. Ponowione żądanie o tym samym identyfikatorze (request ID) nigdy nie uruchomi drugiego agenta.
- **Wysyłaj wiadomości.** Agenci wymieniają wiadomości między sobą i mogą pisać do Ciebie. Facade wkleja całą wiadomość na raz i ją wysyła. Jeśli niewysłany tekst lub monit z pytaniem blokuje wprowadzanie, dostarczenie czeka, aż pole będzie wolne.
- **Kontrola terminala.** Agent może czytać ekran innego agenta, wpisywać polecenia i naciskać klawisze, aby odpowiadać na pytania lub pomagać zablokowanemu współpracownikowi. Gdy agent podrzędny czeka 20 sekund na dane wejściowe lub uprawnienia, agent, który go uruchomił, otrzymuje powiadomienie.

## Agent Mesh

**Łącz agentów między oknami, maszynami i lokalizacjami.**

Facade Code łączy agentów w oknach Facade na tym komputerze w jedną sieć. Otwórz okno [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh), aby rozszerzyć tę współpracę na inną maszynę.

- **Między oknami.** Przy włączonym `facade.yolo` agent ma dostęp do każdego agenta w Twoich oknach Facade na tym komputerze — zarówno lokalnych, jak i Remote - SSH. Przy wyłączonym — tylko do swojej grupy: agenta uruchomionego przez Ciebie i tych uruchomionych przez niego.
- **Rozszerzenie przez SSH.** W oknie [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) agenci działają bezpośrednio na maszynie zdalnej z dostępnymi tam narzędziami, plikami i kontami. Agenci lokalni mogą bezpośrednio uruchamiać agentów w oknach Remote - SSH i wysyłać do nich wiadomości.
- **Koordynacja z telefonu.** Połącz aplikację mobilną Claude z sesją Claude Code na komputerze za pomocą [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). Ta sesja może koordynować innych agentów przez Facade i przekazywać raporty z postępów na Twój telefon.

<sub>Remote Control wymaga obsługiwanej wersji Claude Code, odpowiedniej subskrypcji i logowania z pełnymi uprawnieniami. Zobacz [wymagania konfiguracyjne](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Wiele projektów. Jedno okno.**

Organizuj projekty, drzewa robocze funkcji i zespoły agentów na dedykowanym pasku obszaru roboczego. Przełączaj się między projektami z odpowiednimi plikami i terminalami, podczas gdy agenci kontynuują pracę w tle.

Pobierz wersję zapoznawczą IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Wszystkie wydania](https://github.com/y5ez3g/facadecode/releases)

IDE to fork programu VS Code, który instaluje się obok Twojego obecnego edytora i niczego z nim nie współdzieli: ustawienia, rozszerzenia i polecenie `facade` są całkowicie niezależne. Rozszerzenia pochodzą z [Open VSX](https://open-vsx.org); niektóre własnościowe rozszerzenia firmy Microsoft, takie jak Remote Development czy C/C++, działają wyłącznie w oficjalnych kompilacjach Microsoft. Architektura i specyfikacje znajdują się w [`docs/ide/`](../../ide/).

## Kompilacja ze źródeł

- **Rozszerzenie:** Przekaż [`extension/AGENTS.md`](../../../extension/AGENTS.md) swojemu agentowi kodującemu, aby zbudować pakiet.
- **IDE:** Przekaż [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) swojemu agentowi kodującemu, aby zbudować aplikację.

Wytyczne dotyczące wnoszenia wkładu i dyscypliny gałęzi znajdują się w [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) oraz [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Opinie i wsparcie

- **Błędy i pomysły:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) lub **Pomoc > Zgłoś problem** w IDE.
- **Luki bezpieczeństwa:** Prosimy zgłaszać poufnie zgodnie z wytycznymi w [`SECURITY.md`](../../../SECURITY.md).

## Licencja

MIT, zgodna z nadrzędnym VS Code. Zobacz [`LICENSE.txt`](../../../LICENSE.txt), aby zapoznać się z informacją o prawach autorskich firmy Microsoft i współtwórców Facade Code.

<sub>Facade Code jest niezależnym produktem i nie jest powiązany, wspierany ani sponsorowany przez dostawców prezentowanych narzędzi innych firm. Wszystkie znaki towarowe i logo innych firm należą do ich odpowiednich właścicieli.</sub>
