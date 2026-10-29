# Zu Facade Code beitragen

Danke für deine Hilfe. Facade Code wird offen auf [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode) entwickelt.

## Fehler und Ideen

Eröffne ein [Issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue (Hilfe > Problem melden) legt ein neues an, in dem deine Version schon eingetragen ist. Durchsuche bitte zuerst die vorhandenen Issues und gib bei einem Fehler an:

- was du getan hast, was du erwartet hast und was stattdessen passiert ist;
- die Version aus Help > About (Hilfe > Info) und dein Betriebssystem;
- bei einem Problem mit einem Agenten: welche Agenten-CLI in welcher Version.

Sicherheitslücken werden nicht in Issues gemeldet; siehe [`SECURITY.md`](SECURITY.md).

## Code

Wie dieses Repository funktioniert, steht in [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md): wie du einen Build einrichtest, mit welchen Befehlen du eine Änderung prüfst, und die folgenden Regeln in voller Länge.

- Zweige von `main` als `feature/<number>-<name>` ab.
- Mergen, nie rebasen: Ein Feature landet nach dem Review mit `--no-ff` auf `main`.
- Halte die Dateien von Facade Code beisammen und füge in den Dateien von VS Code optionale Hooks hinzu, statt ihre Logik umzuschreiben, damit das Mergen neuerer VS-Code-Versionen wenig Aufwand macht.
- Jedes Feature hat einen Schalter; ist er aus, verhält sich alles wie im unveränderten VS Code.
- Jede Änderung muss Tests enthalten.
- Schreib Dokumente, Kommentare und Commit-Nachrichten auf Englisch.

Was ein Feature leisten soll, steht in [`docs/ide/`](../../ide/). Willst du ein Verhalten ändern, fang bei der Spezifikation an oder eröffne zuerst ein Issue, um es zu besprechen.

## Lizenz

Mit deinem Beitrag stimmst du zu, dass er unter der [MIT-Lizenz](../../../LICENSE.txt) des Projekts lizenziert wird.
