# Integrated Browser

The Integrated Browser is upstream's browser in an editor tab. This document describes
what Facade adds to it: which links open there rather than in the system browser.
Everything else about it is upstream's, `workbench.browser.openLocalhostLinks`
included.

# Part 1: Specification

## BR1. Links a setting names

`facade.browser.openInIntegratedBrowser` lists URL patterns. A link matching one of
them opens in the Integrated Browser instead of the system browser. That holds
wherever a link would go to the system browser: the terminal (detected links and OSC 8
hyperlinks alike), chat, an editor and the Markdown preview. The setting is meant for
sites a person reads beside their work, such as Claude artifacts (`claude.ai`) or a
team's docs.

- The patterns are trusted domains' patterns:
  - `example.com` matches the pages of that domain, not its subdomains.
  - `*.example.com` matches the domain and its subdomains.
  - A path matches the pages under it.
  - A scheme matches that scheme only. Without one, a pattern matches http and https.
  - `:*` matches any port. Without it, a pattern matches no port, or only the port it
    gives.
- Only http and https links are matched. Any other link goes where it went before.
- The setting is independent of `workbench.browser.openLocalhostLinks`. A named link
  opens in the Integrated Browser with that setting off, and localhost links follow
  that setting whatever this one lists.
- A named link opens where a localhost link opens (`workbench.browser.newTabPlacement`),
  pinned. It never shows the hint that a link was opened there by default, since the
  person named it.
- The default is an empty list, so nothing changes until a person names a link.
- A value that is not a list, such as a mistyped settings.json, names nothing. Every
  link then goes as before, so a typo never stops links opening.
- The Integrated Browser keeps its own cookies. In a trusted local workspace its storage
  is global and persists (`workbench.browser.dataStorage`), so a person signs in to a
  named site once. An untrusted workspace gets an ephemeral session, and a sign-in
  there does not last.

## BR2. Settings

| Setting | Default | Section |
| --- | --- | --- |
| `facade.browser.openInIntegratedBrowser` | `[]`, new | BR1 |

Settings shows it under Workbench › Browser, beside
`workbench.browser.openLocalhostLinks`.

# Part 2: Technical Design

## BR3. The opener

Upstream's `LocalhostLinkOpenerContribution` (`browserTabManagementFeatures.ts`) is the
external opener that the opener service asks before the system browser. It checks the
named patterns as well as localhost, so one opener decides for both. Its remote rule
applies to both too: in a remote session it opens the source URI, not the forwarded
address. Patterns are matched by `testUrlMatchesGlob`, the matcher behind trusted
domains. A named link is logged with the telemetry source `namedLinkOpener`. The
Settings layout's Browser section includes `facade.browser.*`.

# Part 3: Acceptance

## BR4. Acceptance matrix

Levels follow [WORKSPACE.md W15](WORKSPACE.md#w15-test-levels-and-evidence).

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| BR-01 | U | The opener is given http, https, mailto, localhost and subdomain links three times: with patterns and the localhost setting off, with both set, and with a string where the list goes | Exactly the named http and https links open, with no hint; localhost links open only with the localhost setting on; nothing opens for the string |
| BR-02 | I | A development window with `["claude.ai"]` and the localhost setting off; Cmd+click (Ctrl+click on Windows and Linux) a `https://claude.ai/` link in a terminal editor, as plain text and as an OSC 8 hyperlink | Each click opens an Integrated Browser tab on that URL, and the system browser opens nothing |
