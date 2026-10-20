<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Eine IDE für dich und dein KI-Team.**

Basiert auf VS Code. Führt die nativen CLIs deiner Agenten aus, etwa Claude Code, Codex, Antigravity, Muse Code und Qwen Code.

[Download](https://github.com/y5ez3g/facadecode/releases) ·
[Spezifikationen](../../facade-code-spec/) ·
[Fehler melden](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · **Deutsch** · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code ist ein Fork von VS Code, in dem native Agenten aller Anbieter gemeinsam an deinen Projekten und Features arbeiten, während du im selben Fenster den Code reviewst und jeden einzelnen Agenten steuerst.

- 🧑‍💻 **VS Code mit vollem Funktionsumfang, organisiert nach Projekten und Features.** Entwickle mehrere Projekte und Features in einem Fenster. Jedes Feature ist ein Git-Worktree mit einem eigenen Team von Agenten.
- 🤖 **Ein anbieterübergreifendes Team nativer Agenten-CLIs.** Die Agenten laufen mit deinen eigenen Coding-Abos. In Facade Code starten Agenten einander, schreiben sich Nachrichten und helfen sich gegenseitig weiter, wenn einer feststeckt.
- 👥 **Super Engineer oder Super Team.** Steuere mehrere Agenten selbst oder bestimme ein führendes Modell, das Spezialisten parallel koordiniert.

## Installation

Lade die neueste Version unter [Releases](https://github.com/y5ez3g/facadecode/releases) herunter: eine `.dmg` für macOS (Apple Silicon), ein Installer für Windows (x64) oder ein `.deb` für Ubuntu (x64).

**Voraussetzungen**: Installiere die Agenten-CLIs, die du nutzen möchtest, und melde dich bei ihnen an (beliebige Kombination aus Claude Code, Codex, Antigravity, Muse Code und Qwen Code). Facade Code führt sie direkt aus, mit ihrer eigenen Anmeldung und ihren eigenen Abos.

Facade Code wird neben VS Code installiert und teilt nichts damit: Einstellungen, Erweiterungen und das Kommandozeilenwerkzeug `facade` sind vollständig getrennt.

## Schnellstart

1. **Öffne ein Projekt**:
   ```sh
   facade ~/code/space-shooter
   ```
   Oder nutze **File > Open Folder** (Datei > Ordner öffnen) oder zieh einen Ordner auf die Workspace-Leiste. Der Ordner muss ein Git-Repository sein (Worktrees brauchen Git; führe bei einem neuen Projekt zuerst `git init` aus).

2. **Starte einen Tech Lead**:
   Klick auf das Roboter-Symbol in der Titelleiste (Agent-Menü) oder führe in der Befehlspalette **Agents: Start Agent...** (Agent starten) aus und wähle Claude Code oder Codex. Ein Agent, der aus Facade Code heraus gestartet wird, bekommt die MCP-Tools von Facade mit.

3. **Gib ihm den Tech-Lead-Prompt**:
   ```text
   Du bist der Tech Lead. Baue mit Facade für eine Demo einen Neon-Weltraum-Shooter
   für den Browser (Desktop), mit einem PD auf GPT Sol 6 (gpt-6-sol, max) über Codex,
   der für Look and Feel verantwortlich ist, und drei Muse-1.3-Engineers
   (muse-spark-1.3, max), die parallel arbeiten. Halte es klein, etwa eine halbe Stunde
   Bauzeit: ein Level, drei Gegnertypen, ein Boss mit zwei Phasen, Power-ups, Punkte
   und Combos. Lieber fertig und ausgefeilt als mit mehr Features. Die Engineers mergen
   ihre eigene Arbeit, und du reviewst danach. Schick mir eine HTML-Seite mit einem
   kurzen Plan, einem Swimlane-Diagramm und dem Mockup des PD, und warte auf mein Okay,
   bevor du anfängst.
   ```

4. **Sieh dem Team bei der Zusammenarbeit zu**:
   Der gestartete PD und die Engineers erscheinen in der Workspace-Leiste unter ihrem Projekt und Feature. Sobald du den HTML-Plan freigibst, legen sie los. Du kannst jederzeit in das Terminal jedes Agenten klicken, um die Ausgabe anzusehen oder direkt mit ihm zu sprechen.

*(Hinweis: Dieser Beispiel-Prompt startet 5 Agenten auf der höchsten Reasoning-Stufe. Passe CLIs, Modelle, Reasoning-Stufen und die Zahl der Engineers an deine Abos an.)*

## Funktionen

### Projekte und Features statt Sessions

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

Die meisten Agenten-Tools legen für jede Agenten-Session einen Worktree an. Facade Code macht es umgekehrt: Jeder Worktree ist ein Feature, aufgelistet unter seinem Repository, und du teilst ihm Agenten zu.

Ein Feature braucht oft mehr als einen Agenten. Der Agent, der den Code schreibt, erklärt seine Arbeit vielleicht nicht gut oder hat kein Auge für Design. Deshalb helfen andere Agenten bei Dokumentation, Design und Review, alle im selben Worktree. Agenten kommen und gehen; das Feature bleibt.

- **Workspace-Leiste**: Zeigt alle Repositories und Features in einer Spalte. Ein Klick schaltet das ganze Fenster um (Explorer, Editoren, Terminals und Quellcodeverwaltung) und stellt es so wieder her, wie du es verlassen hast. Projekte vermischen sich nie. Siehe [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Lebenszyklus eines Worktrees**: **New Worktree** (neuer Worktree) legt den Branch an, synchronisiert die lokalen Dateien aus `.worktreeinclude` und führt das Setup aus. **Delete Worktree** (Worktree löschen) zeigt vor dem Entfernen genau, was verloren ginge. Siehe [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Parallele Teilaufgaben**: Unabhängige Aufgaben können in eigene Worktrees abzweigen.

### Ein Team von allen Anbietern

- **Native CLIs mit deinen eigenen Abos**: Claude Code, Codex, Muse Code, Antigravity und Qwen Code laufen in ihren eigenen integrierten Terminals und nutzen deine bestehenden Abos.
- **Agenten starten Agenten**: Ein Agent kann im aktuellen Feature oder in einem neuen Worktree weitere Agenten starten (mit der CLI oder dem Modell eines beliebigen Anbieters) und ihnen Aufgaben zuweisen. Siehe [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) und [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Nachrichten**: Agenten schreiben einander, melden Ergebnisse an ihren Auftraggeber zurück und benachrichtigen dich, wenn eine Entscheidung menschliche Freigabe braucht. Siehe [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Gegenseitig weiterhelfen**: Ein Agent kann das Terminal eines anderen Agenten lesen, auf Eingabeaufforderungen antworten und Tastendrücke senden, um einem feststeckenden Engineer zu helfen, ohne dich zu unterbrechen. Siehe [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Du kannst bei jedem eingreifen**: Jeder Agent hat unter seinem Feature eine eigene Terminalzeile. Du siehst, was er tut, und kannst jederzeit direkt hineintippen.
- **Standard-MCP**: Alle Orchestrierungswerkzeuge werden über einen Standard-MCP-Server bereitgestellt.

## Zwei Arbeitsweisen

Die Aufmerksamkeit des Entwicklers ist der Engpass. Die beiden Modi stehen für zwei Stufen der Delegation:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Deine Rolle** | Engineer, der selbst Hand anlegt | Engineering Manager |
| **Mit wem du zu tun hast** | Direkt mit mehreren Agenten | Mit einem Tech-Lead-Agenten, 1:1 |
| **Wer die Agenten koordiniert** | Du | Der Tech Lead |
| **Am besten für** | Features, die enge Führung brauchen: explorative Arbeit, Designentscheidungen, die du selbst beurteilen willst, sich ändernde Anforderungen | Große, klar definierte Features, die sich sauber aufteilen lassen |

Du kannst beides im selben Fenster kombinieren: heikle Features eng begleiten und klar umrissene Arbeit an einen Lead abgeben.

- **Super Engineer**: Du öffnest Worktrees, verteilst Aufgaben an Agenten in verschiedenen Repositories und reviewst den Code, sobald jeder fertig ist.
- **Super Team**: Du übergibst ein Feature an einen Agenten als Tech Lead. Er zerlegt die Aufgaben, legt Schnittstellenverträge fest, startet Worker und reviewt ihre Ergebnisse.
  - Ein starkes Modell führt; schnellere, günstigere Modelle auf deinen bestehenden Abos implementieren parallel; und Modelle verschiedener Anbieter reviewen gegenseitig ihre Arbeit.
  - Ein Prompt reicht, um das aufzusetzen (siehe [Schnellstart](#schnellstart)); Team-Workflows, die du wiederverwendest, lassen sich als Skills festhalten.

*(Diese README ist genauso entstanden: Ein Agent hat analysiert, einer hat entworfen, und ein Mensch hat die letzte Entscheidung getroffen.)*

## Warum

Die meisten KI-Coding-Tools fallen in zwei Lager: IDEs im Copilot-Stil, bei denen ein Mensch Zeile für Zeile mitlesen muss, und Agenten-IDEs, bei denen Code-Review und Debugging an einen externen Editor ausgelagert werden. Keines der beiden bringt ein anbieterübergreifendes Team nativer Agenten in deiner Haupt-IDE zusammen.

Wir glauben, dass die Zukunft einem Entwickler gehört, der mit einem Team von Agenten mehrere Projekte und Features vorantreibt. Verschiedene Modelle sind in verschiedenen Aufgaben stark, also sollte das Team anbieterübergreifend sein. Und weil Agenten den Code schreiben, den du reviewst, gehört dieses Team in deine IDE.

## Immer noch VS Code

Facade Code ändert nur, was die Verwaltung mehrerer Projekte und Agenten erfordert:

- Die **Workspace-Leiste** belegt die erste Spalte; die **Aktivitätsleiste** wandert nach rechts oben in die Titelleiste (wiederherstellbar mit `workbench.activityBar.location`).
- Copilot und Chat aus dem Upstream sind standardmäßig deaktiviert (eine einzige Einstellung schaltet sie wieder ein).
- Alles andere ist unverändertes VS Code: Editor, Einstellungen, Tastenkombinationen, `.vscode/` und `.code-workspace`-Dateien.
- Erweiterungen werden aus [Open VSX](https://open-vsx.org) installiert. Einige proprietäre Microsoft-Erweiterungen wie Remote Development und C/C++ sind nur für offizielle Microsoft-Builds lizenziert und laufen nicht in Forks.

## Aus dem Quellcode bauen

Gib [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) deinem Agenten und lass ihn bauen.

Richtlinien für Beiträge und die Branch-Regeln findest du in [`CONTRIBUTING.md`](CONTRIBUTING.md) und [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md).

## Feedback

- **Fehler und Ideen**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) oder **Help > Report Issue** (Hilfe > Problem melden) im Editor.
- **Sicherheitslücken**: Bitte melde sie vertraulich wie in [`SECURITY.md`](SECURITY.md) beschrieben.

## Lizenz

MIT, wie VS Code selbst. Den Copyright-Hinweis von Microsoft und die Hinweise der Facade-Code-Mitwirkenden findest du in [`LICENSE.txt`](../../LICENSE.txt).
