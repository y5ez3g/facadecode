<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**KI-Programmieragenten auf eigenen Rechnern ausführen.**

Facade Code führt KI-Programmier-CLIs auf Ihren Rechnern aus. Agenten finden einander, tauschen Nachrichten aus, lesen Bildschirme und bedienen Terminals. Sie steuern sie in der Shell, in VS Code oder einer MCP-fähigen Anwendung. Auf jedem Rechner läuft ein eigener Orchestrator. Die Rechner verbinden sich über SSH.

[![Website: facadecode.com](https://img.shields.io/badge/Website-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: installieren](https://img.shields.io/badge/VS%20Code%20Marketplace-installieren-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: installieren](https://img.shields.io/badge/Open%20VSX-installieren-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: Fehler melden](https://img.shields.io/badge/Issues-Fehler%20melden-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · **Deutsch** · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Sehen Sie sich die 2-minütige Demo auf facadecode.com an](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Installation

### Shell

Die einzeiligen Installationsbefehle sind ab der ersten Veröffentlichung mit eigenständigen Paketen verfügbar.
Shell-Pakete gibt es für macOS, Linux und Windows auf x64 und arm64.

Führen Sie diesen Befehl unter macOS oder Linux aus.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

Führen Sie diesen Befehl unter Windows in PowerShell aus.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

Das Installationsprogramm fügt `facade` und `facade-mcp` zum PATH hinzu. Öffnen Sie ein neues Terminal, damit der neue PATH geladen wird. Aktualisieren Sie mit `facade upgrade`. Installieren Sie die benötigten CLIs auf jedem Rechner und melden Sie sich dort an. Integriert sind Claude Code, Codex, Antigravity, Muse Code, OpenCode und Pi.

Ihr Startprogramm heißt ebenfalls `facade`. Sind beide installiert, verwendet die Shell den ersten Treffer im PATH. Nach Einstellung der IDE-Vorschau gehört der Befehlsname dem Orchestrator. Führen Sie `facade --version` aus. Eine Zeile im Format `facade <version>` bestätigt den Shell-Befehl.

### VS Code

```sh
code --install-extension facade.facadecode
```

Die Erweiterung bringt ihren Orchestrator mit. Öffnen Sie **Facade Code** in der Aktivitätsleiste und wählen Sie **Neuer Agent**, **Go to Agent** oder **Resume Agent**. Pakete für macOS, Linux und Windows gibt es für x64 und arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Fügen Sie `facade-mcp` als stdio-MCP-Server hinzu. Das Beispiel verwendet ein `mcpServers`-Objekt.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Eine externe Verbindung tritt beim ersten Tool-Aufruf als Guest bei. Warten Sie nach dem Senden mit dem von `send_message` zurückgegebenen `read_messages`-Aufruf auf die Antwort.

## Auf mehreren Rechnern arbeiten

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Verwenden Sie die von `facade list` ausgegebene Adresse. Registrieren Sie weitere Rechner mit dem gewohnten SSH-Ziel und den üblichen Optionen. Um WSL oder einen Dev Container von außen zu erreichen, richten Sie SSH in der jeweiligen Umgebung ein und registrieren sie auf dieselbe Weise. Sie können Facade auch direkt darin ausführen.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade installiert bei Bedarf die passende Version auf dem entfernten Rechner. Facade verwendet auf dem entfernten Rechner den festen Installationspfad. Installieren Sie bei Bedarf manuell dieselbe Version wie auf Ihrem lokalen Orchestrator. **Go to Agent** öffnet in VS Code das Terminal eines laufenden Agenten. Der Arbeitsbereich merkt sich geöffnete Agenten, deren Helfer und Ihre Pins. Beim Schließen des Terminal-Tabs läuft der Agent weiter. **Resume Agent** und `facade resume` zeigen gespeicherte Arbeit.

> **YOLO ist standardmäßig aktiv.** Ein Agent mit YOLO kann andere Agenten auf verbundenen Rechnern erreichen. Setzen Sie `"yolo": false` in der `facade.json` seines Rechners, um Freigaben und Sandbox der CLI beizubehalten und den MCP-Zugriff auf den Erstellungsbaum des Aufrufers zu begrenzen. Die Einstellung gilt ab dem nächsten Start oder Resume. `facade status` zeigt den Dateipfad.

[Produktdokumentation (中文)](../../facade-code.md) · [Glossar](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Mehrere Projekte. Ein einziges Fenster.**

Organisieren Sie Projekte, Feature-Worktrees und Agententeams in einer speziellen Workspace-Leiste. Wechseln Sie zwischen Projekten mit den jeweils zugehörigen Dateien und Terminals, während die Agenten im Hintergrund weiterarbeiten.

Laden Sie die Vorschau-Version der IDE herunter: [macOS (Apple Silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Alle Versionen](https://github.com/y5ez3g/facadecode/releases)

Die IDE-Vorschau läuft neben Ihrem Editor und verwendet eigene Einstellungen und Erweiterungen. Die Erweiterungen stammen von [Open VSX](https://open-vsx.org); einige proprietäre Microsoft-Erweiterungen wie Remote Development und C/C++ laufen ausschließlich in offiziellen Microsoft-Builds. Architektur und Spezifikationen finden sich unter [`docs/ide/`](../../ide/).

## Aus dem Quellcode kompilieren

- **Erweiterung:** Übergeben Sie [`extension/AGENTS.md`](../../../extension/AGENTS.md) an Ihren Coding-Agenten, um das Paket zu kompilieren.
- **Orchestrator / Shell.** [Build-Anleitung](../../../core/README.md).
- **IDE:** Übergeben Sie [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) an Ihren Coding-Agenten, um die Anwendung zu kompilieren.

Informationen zu Beitragsrichtlinien und Branch-Disziplin finden Sie unter [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) und [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Feedback

- **Fehler und Ideen**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) oder **Hilfe > Problem melden** in der IDE.
- **Sicherheitslücken**: Bitte vertraulich gemäß [`SECURITY.md`](../../../SECURITY.md) melden.

## Lizenz

MIT, entsprechend dem Upstream-VS Code. Siehe [`LICENSE.txt`](../../../LICENSE.txt) für den Urheberrechtshinweis von Microsoft sowie die Hinweise der Facade Code-Mitwirkenden.

<sub>Facade Code ist ein unabhängiges Produkt und steht in keiner Verbindung zu den Anbietern der dargestellten Drittanbieter-Tools, wird von diesen nicht unterstützt oder gesponsert. Alle Marken und Logos Dritter gehören ihren jeweiligen Eigentümern.</sub>
