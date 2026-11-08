<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Der Multi-Agent-Orchestrator für VS Code.**

Führen Sie native Agenten-CLIs aus, bearbeiten Sie Code und überprüfen Sie Änderungen im selben IDE-Fenster. Nutzen Sie Ihre eigenen Konten und Abonnements, und lassen Sie Agenten über Fenster und Rechner hinweg zusammenarbeiten.

[![Website: facadecode.com](https://img.shields.io/badge/Website-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: installieren](https://img.shields.io/badge/VS%20Code%20Marketplace-installieren-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: installieren](https://img.shields.io/badge/Open%20VSX-installieren-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: IDE herunterladen](https://img.shields.io/badge/Releases-IDE%20herunterladen-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: Fehler melden](https://img.shields.io/badge/Issues-Fehler%20melden-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · **Deutsch** · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![Sehen Sie sich die 2-minütige Demo auf facadecode.com an](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Installation

```sh
code --install-extension facade.facadecode
```

Oder installieren Sie **Facade Code** über den [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) oder [Open VSX](https://open-vsx.org/extension/facade/facadecode). Es läuft unter macOS (Apple Silicon), Linux (x64) und Windows (x64).

Installieren Sie als Nächstes die unterstützten Agenten-CLIs, die Sie verwenden möchten, und melden Sie sich dort an: Claude Code, Codex, Antigravity, Muse Code, OpenCode oder Pi. Facade Code startet jede CLI mit deren eigener Anmeldung und eigenen Abonnements.

> **Agenten laufen standardmäßig ohne Bestätigungsabfragen.** Wenn `facade.yolo` standardmäßig aktiviert ist, können Agenten Befehle ausführen und Dateien ändern, ohne zuvor nachzufragen. Deaktivieren Sie diese Option, um die gewohnten Bestätigungsabfragen der jeweiligen CLI wiederherzustellen. Siehe [extension README](../../../extension/README.md#install).

## Agent Panel

**Ihre Agenten und Ihre IDE im selben Fenster.**

Facade Code führt native Agenten-CLIs (Claude Code, Codex, Antigravity, Muse Code, OpenCode und Pi) in Editor-Terminal-Tabs neben Ihren Dateien aus – mit den eigenen Befehlen, Werkzeugen, Konten und Abonnements der jeweiligen CLI. Eine Karte im Panel zeigt den Status jedes Agenten an.

- **Arbeiten Sie direkt neben Ihrem Code.** Jeder Agent läuft in einem eigenen Terminal-Tab im Editorbereich. Das Schließen eines Tabs blendet diesen lediglich aus, während der Agent weiterläuft; ein Klick auf die Karte öffnet ihn wieder.
- **Status aller Agenten im Blick behalten.** Die Karten zeigen, was zuletzt an den jeweiligen Agenten gesendet wurde und ob er arbeitet, eine Berechtigung benötigt oder auf einen Fehler gestoßen ist, während die Details seinen Titel, seinen Ordner und wer ihn gestartet hat zeigen. Agenten laufen bei Fenster-Reloads und Neustarts der Erweiterung unterbrechungsfrei weiter.
- **Ordner und Worktrees.** Führen Sie Agenten in beliebigen Ordnern des Arbeitsbereichs aus oder erstellen Sie spontan einen Git-Worktree, um Codeänderungen voneinander getrennt zu halten. Heften Sie eine Unterhaltung an, um sie beim erneuten Öffnen des Arbeitsbereichs wiederherzustellen, oder setzen Sie frühere Sitzungen aus dem Verlauf fort.

## Agent Use

**Lassen Sie Agenten andere Agenten steuern – genau wie Sie.**

Über MCP und ein Terminalprotokoll können Agenten andere Agenten starten, stoppen, finden und ihnen Nachrichten senden, deren Terminalbildschirme lesen, Text eingeben und Tasten drücken.

- **Agenten starten und stoppen.** Ein Agent kann andere Agenten mit jeder der sechs CLIs in jedem beliebigen Ordner oder neuen Worktree Ihrer Facade-Fenster auf diesem Computer starten und ihnen die erste Aufgabe zuweisen. Eine wiederholte Anfrage mit derselben Anfrage-ID startet niemals einen zweiten Agenten.
- **Nachrichten senden.** Agenten tauschen untereinander Nachrichten aus und können auch Ihnen Nachrichten schicken. Facade fügt die vollständige Nachricht auf einmal ein und sendet sie ab. Befindet sich noch ungesendeter Text oder eine Eingabeaufforderung im Eingabefeld, wartet die Zustellung, bis das Feld frei ist.
- **Terminalsteuerung.** Ein Agent kann den Bildschirm eines anderen Agenten lesen, Befehle eingeben und Tasten drücken, um Eingabeaufforderungen zu beantworten oder einem feststeckenden Kollegen zu helfen. Wenn ein Kind-Agent 20 Sekunden lang auf eine Berechtigung, eine Antwort oder eine Anmeldung wartet, wird der Agent benachrichtigt, der ihn gestartet hat.

## Agent Mesh

**Verbinden Sie Agenten über Fenster, Rechner und Standorte hinweg.**

Facade Code verbindet die Agenten aller Ihrer Facade-Fenster auf diesem Computer zu einem gemeinsamen Netzwerk. Öffnen Sie ein [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh)-Fenster, um diese Zusammenarbeit auf einen weiteren Rechner auszuweiten.

- **Über Fenster hinweg.** Wenn `facade.yolo` aktiviert ist, erreicht ein Agent jeden Agenten in allen Ihren Facade-Fenstern auf diesem Computer – gleichermaßen lokal wie über Remote - SSH. Ist es deaktiviert, erreicht ein Agent nur seine eigene Gruppe: den von Ihnen gestarteten Agenten und alle daraus hervorgegangenen.
- **Über SSH erweitern.** In einem [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh)-Fenster laufen Agenten direkt auf dem Remote-Rechner mit den dortigen Werkzeugen, Dateien und Konten. Lokale Agenten können Agenten in Remote - SSH-Fenstern direkt starten und ihnen Nachrichten senden.
- **Vom Smartphone aus koordinieren.** Verbinden Sie die mobile Claude-App über [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) mit einer Claude Code-Sitzung auf Ihrem Computer. Diese Sitzung kann andere Agenten über Facade koordinieren und den Fortschritt direkt an Ihr Telefon melden.

<sub>Remote Control erfordert eine unterstützte Version von Claude Code, ein geeignetes Abonnement und eine Anmeldung mit vollem Berechtigungsumfang. Siehe [Einrichtungsvoraussetzungen](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Mehrere Projekte. Ein einziges Fenster.**

Organisieren Sie Projekte, Feature-Worktrees und Agententeams in einer speziellen Workspace-Leiste. Wechseln Sie zwischen Projekten mit den jeweils zugehörigen Dateien und Terminals, während die Agenten im Hintergrund weiterarbeiten.

Laden Sie die Vorschau-Version der IDE herunter: [macOS (Apple Silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Alle Versionen](https://github.com/y5ez3g/facadecode/releases)

Die IDE ist ein Fork von VS Code, der neben Ihrem vorhandenen Editor installiert wird und nichts mit ihm teilt: Einstellungen, Erweiterungen und der Befehl `facade` sind vollständig voneinander getrennt. Die Erweiterungen stammen von [Open VSX](https://open-vsx.org); einige proprietäre Microsoft-Erweiterungen wie Remote Development und C/C++ laufen ausschließlich in offiziellen Microsoft-Builds. Architektur und Spezifikationen finden sich unter [`docs/ide/`](../../ide/).

## Aus dem Quellcode kompilieren

- **Erweiterung:** Übergeben Sie [`extension/AGENTS.md`](../../../extension/AGENTS.md) an Ihren Coding-Agenten, um das Paket zu kompilieren.
- **IDE:** Übergeben Sie [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) an Ihren Coding-Agenten, um die Anwendung zu kompilieren.

Informationen zu Beitragsrichtlinien und Branch-Disziplin finden Sie unter [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) und [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Feedback

- **Fehler und Ideen**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) oder **Hilfe > Problem melden** in der IDE.
- **Sicherheitslücken**: Bitte vertraulich gemäß [`SECURITY.md`](../../../SECURITY.md) melden.

## Lizenz

MIT, entsprechend dem Upstream-VS Code. Siehe [`LICENSE.txt`](../../../LICENSE.txt) für den Urheberrechtshinweis von Microsoft sowie die Hinweise der Facade Code-Mitwirkenden.

<sub>Facade Code ist ein unabhängiges Produkt und steht in keiner Verbindung zu den Anbietern der dargestellten Drittanbieter-Tools, wird von diesen nicht unterstützt oder gesponsert. Alle Marken und Logos Dritter gehören ihren jeweiligen Eigentümern.</sub>
