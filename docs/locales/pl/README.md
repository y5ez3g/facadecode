<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Uruchamiaj agentów AI do programowania na swoich maszynach.**

Facade Code uruchamia wiele CLI do programowania z AI na Twoich maszynach. Agenci mogą się odnajdywać, wymieniać wiadomości, odczytywać ekrany i wpisywać tekst w terminalach. Steruj nimi z powłoki, VS Code lub aplikacji obsługującej MCP. Każda maszyna uruchamia własny Orchestrator i łączy się z innymi przez SSH.

[![Witryna: facadecode.com](https://img.shields.io/badge/Witryna-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: zainstaluj](https://img.shields.io/badge/VS%20Code%20Marketplace-zainstaluj-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: zainstaluj](https://img.shields.io/badge/Open%20VSX-zainstaluj-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Zgłoszenia: zgłoś błąd](https://img.shields.io/badge/Zg%C5%82oszenia-zg%C5%82o%C5%9B%20b%C5%82%C4%85d-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · **Polski**

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Obejrzyj 2-minutowe demo na facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalacja

### Shell

Instalatory uruchamiane w jednym wierszu są dostępne od pierwszego wydania zawierającego samodzielne pakiety.
Pakiety Shell obejmują macOS, Linux i Windows na x64 oraz arm64.

Uruchom to polecenie w systemie macOS lub Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

W systemie Windows uruchom to polecenie w PowerShell.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

Instalator dodaje `facade` i `facade-mcp` do PATH. Otwórz nowy terminal, aby użyć zaktualizowanej zmiennej PATH. Aktualizuj poleceniem `facade upgrade`. Zainstaluj potrzebne CLI na każdej maszynie i zaloguj się w nich. Wbudowane opcje to Claude Code, Codex, Antigravity, Muse Code, OpenCode i Pi.

Jej program uruchamiający także nazywa się `facade`. Jeśli zainstalowano oba, powłoka wybiera pierwszy program w PATH. Po wycofaniu IDE nazwa polecenia przypadnie Orchestratorowi. Uruchom `facade --version`. Wiersz w formacie `facade <version>` potwierdza, że używasz polecenia Shell.

### VS Code

```sh
code --install-extension facade.facadecode
```

Rozszerzenie zawiera Orchestrator. Otwórz **Facade Code** na pasku aktywności i wybierz **Nowy agent**, **Go to Agent** lub **Resume Agent**. Pakiety na macOS, Linux i Windows są budowane dla x64 i arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Dodaj `facade-mcp` jako serwer MCP używający stdio. Przykład używa obiektu `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Połączenie zewnętrzne dołącza jako Guest przy pierwszym wywołaniu narzędzia. Po wysłaniu wiadomości poczekaj na odpowiedź, wywołując `read_messages` zgodnie z wynikiem `send_message`.

## Praca na wielu maszynach

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Użyj adresu wyświetlanego przez `facade list`. Rejestrując inną maszynę, podaj zwykły cel i opcje SSH. Aby połączyć się z WSL lub Dev Containerem z zewnątrz, skonfiguruj SSH w tym środowisku i zarejestruj je w ten sam sposób. Facade można też uruchomić bezpośrednio w tym środowisku.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

W razie potrzeby Facade instaluje odpowiednią wersję na zdalnej maszynie. Facade używa stałej ścieżki instalacji na zdalnej maszynie. Przy ręcznej instalacji użyj tej samej wersji co lokalny Orchestrator. W VS Code **Go to Agent** otwiera terminal działającego agenta. Obszar roboczy pamięta otwartych agentów, ich pomocników i Piny. Zamknięcie karty terminala pozostawia agenta uruchomionego. **Resume Agent** i `facade resume` pokazują zapisaną pracę.

> **YOLO jest domyślnie włączone.** Agent z YOLO może uzyskiwać dostęp do innych agentów na połączonych maszynach. Ustaw `"yolo": false` w pliku `facade.json` danej maszyny, aby zachować zatwierdzenia i piaskownicę CLI oraz ograniczyć MCP do drzewa tworzenia wywołującego. Zmiana obowiązuje przy następnym uruchomieniu lub resume. `facade status` pokazuje ścieżkę pliku.

[Dokumentacja produktu (po chińsku)](../../facade-code.md) · [Słownik](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Wiele projektów. Jedno okno.**

Organizuj projekty, drzewa robocze funkcji i zespoły agentów na dedykowanym pasku obszaru roboczego. Przełączaj się między projektami z odpowiednimi plikami i terminalami, podczas gdy agenci kontynuują pracę w tle.

Pobierz wersję zapoznawczą IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Wszystkie wydania](https://github.com/y5ez3g/facadecode/releases)

Wersja zapoznawcza IDE działa obok edytora i ma własne ustawienia oraz rozszerzenia. Rozszerzenia pochodzą z [Open VSX](https://open-vsx.org); niektóre własnościowe rozszerzenia firmy Microsoft, takie jak Remote Development czy C/C++, działają wyłącznie w oficjalnych kompilacjach Microsoft. Architektura i specyfikacje znajdują się w [`docs/ide/`](../../ide/).

## Kompilacja ze źródeł

- **Rozszerzenie:** Przekaż [`extension/AGENTS.md`](../../../extension/AGENTS.md) swojemu agentowi kodującemu, aby zbudować pakiet.
- **Orchestrator / Shell.** [Instrukcja kompilacji](../../../core/README.md).
- **IDE:** Przekaż [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) swojemu agentowi kodującemu, aby zbudować aplikację.

Wytyczne dotyczące wnoszenia wkładu i dyscypliny gałęzi znajdują się w [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) oraz [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Opinie i wsparcie

- **Błędy i pomysły:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) lub **Pomoc > Zgłoś problem** w IDE.
- **Luki bezpieczeństwa:** Prosimy zgłaszać poufnie zgodnie z wytycznymi w [`SECURITY.md`](../../../SECURITY.md).

## Licencja

MIT, zgodna z nadrzędnym VS Code. Zobacz [`LICENSE.txt`](../../../LICENSE.txt), aby zapoznać się z informacją o prawach autorskich firmy Microsoft i współtwórców Facade Code.

<sub>Facade Code jest niezależnym produktem i nie jest powiązany, wspierany ani sponsorowany przez dostawców prezentowanych narzędzi innych firm. Wszystkie znaki towarowe i logo innych firm należą do ich odpowiednich właścicieli.</sub>
