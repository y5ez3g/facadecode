# Localization

Facade Code's window speaks eleven languages besides English, and a person who installs it
has nothing else to install to get one.

[IDENTITY.md](IDENTITY.md) owns the product's name. The documents in `locales/` (README,
CONTRIBUTING, SECURITY) are translations of the repository's own, outside this document.

# Part 1: Specification

## LC1. Languages

| Language | Display language id | `locales/` folder |
| --- | --- | --- |
| 简体中文 | `zh-cn` | `zh-CN` |
| 繁體中文 | `zh-tw` | `zh-TW` |
| Português (Brasil) | `pt-br` | `pt-BR` |
| Español | `es` | `es` |
| Русский | `ru` | `ru` |
| Deutsch | `de` | `de` |
| 日本語 | `ja` | `ja` |
| Français | `fr` | `fr` |
| 한국어 | `ko` | `ko` |
| Türkçe | `tr` | `tr` |
| Polski | `pl` | `pl` |

These are the languages Microsoft publishes a VS Code language pack for, less Italian and
Czech, which Facade Code does not ship. Indonesian and Vietnamese, which the README is translated into,
have no VS Code language pack to start from, so the window stays English in them.

## LC2. Built in

Each language is a built-in extension, `vscode.facade-language-pack-<pack>`, inside the
application. **Configure Display Language** lists all eleven from the first start, and
choosing one restarts into it, as with any language pack. Nothing is downloaded, so it works
offline and does not wait on Open VSX.

A pack carries three things: VS Code's own strings, as Microsoft translates them; Facade
Code's strings, in the window and in its built-in extensions; and the corrections LC3 needs.

Being built in, a pack cannot be uninstalled, only left unchosen. Installing Microsoft's pack
for the same language as well does not combine the two: the window takes one pack per
language, so the person gets whichever loaded last. Facade's own strings are only in Facade's.

## LC3. What a pack guarantees

- **Every string a person can see is translated.** The exception is the parts of VS Code
  that Facade Code turns off by default - chat, agent sessions and the Copilot extension
  (README, "Still VS Code") - whose strings stay as far as Microsoft has translated them. In
  the window's modules these are `vs/sessions/` and every module under a `chat`, `chatSessions`,
  `inlineChat`, `sessions`, `agentHost`, `agentsVoice`, `mcp`, `aiStats`, `remoteCodingAgents`
  or `copilot` folder; among the extensions, `github.copilot-chat`. The built-in SSH and
  WSL extensions, `jeanp413.open-remote-ssh` and `jeanp413.open-remote-wsl`, are the other
  exception: their author ships no translations, so their own strings are English in every
  language (REMOTE.md R5).
- **The product is called Facade Code.** No translation names VS Code where the English
  does not. Microsoft's translations write the name into some strings that, in Facade Code,
  take it from the product; those strings are translated again.
- **A string Facade Code changed is translated from Facade Code's English**, not from the
  upstream string it replaced.
- In the window everything is translated, menu names included: unlike the README, the reader
  sees the localized window, not the English one.

## LC4. First start

When no display language has been chosen and the operating system's language has a pack, a
notification asks whether to switch, in that language followed by English, as VS Code's own
suggestion does:

```
Facade Code 也提供简体中文界面。要切换显示语言并重启吗？ (Facade Code is also available in Chinese Simplified. Change the display language and restart?)
[切换并重启 (Change and Restart)]  [不再显示 (Don't Show Again)]
```

- The notification stays on screen until it is answered or closed, as VS Code's question after a
  language pack is installed does; it does not slip into the notification center unseen.
- **Change and Restart** sets the display language, as Configure Display Language does, and
  restarts.
- **Don't Show Again** stops the question for that language on this machine.
- Closing the notification answers nothing; it asks again on the next start.
- A display language already chosen, English included, is never questioned: one in `argv.json`, one
  given with `--locale`, and one picked in Configure Display Language even when it is the language
  the window already speaks, which is written to `argv.json` all the same.

**Until a language is chosen the window speaks English**, whatever the operating system's
language. VS Code itself follows the operating system's language whenever no display language is
chosen and a pack for it is installed; with every pack built in, that would switch the window on its
second start, the question unanswered. Here the choice is the person's: the question, Configure
Display Language or `--locale`. The same holds for a pack someone installs from Open VSX: it shows
once chosen, which VS Code's own install suggestion does on its way.

The operating system's language matches a pack by its language and, for Chinese and
Portuguese, its region: `zh-cn`, `zh-sg` and `zh-hans` take `zh-cn`; `zh-tw`, `zh-hk`,
`zh-mo` and `zh-hant` take `zh-tw`; `pt-br` takes `pt-br`, and `pt-pt` none.

VS Code's suggestion to install a language pack from the gallery still covers the languages
Facade Code does not build in. For the eleven it never fires: a pack is installed.

## LC5. Settings

| Setting | Default | Section |
| --- | --- | --- |
| `facade.localization.suggestDisplayLanguage` | `true` | LC4 |

Off, the window never asks; VS Code's own suggestion is unchanged either way. The packs stay
built in: unchosen, they change nothing.

English until chosen is `facadeDisplayLanguageWhenChosen` in `product.json`, read where the main
process resolves the display language: with no language chosen it takes English instead of the
operating system's. The same flag has the locale service write a choice of the language the window
already speaks, which VS Code skips as changing nothing. Without it, the window follows the operating
system as VS Code does.

# Part 2: Technical Design

## LC6. Building a pack

```
microsoft/vscode-loc @ <pinned commit>        Microsoft's translations, MIT
  + locales/<folder>/facade.i18n.json          Facade Code's, in this repository
  = .build/extensions/facade-language-pack-<pack>/
```

`build/lib/facade/languagePacks.ts` builds the packs in the packaging tasks, before the
application is packaged, so every platform's package carries them and `packageTask` reads
them from `.build/extensions` like any built-in extension.

- **Source.** Microsoft's packs are taken from `microsoft/vscode-loc` at a pinned commit, not
  from Open VSX: the repository's strings are a month ahead of the packs on Open VSX and cover
  about 2,600 more of VS Code 1.138's. Each pack's `package.json` lists its translation files;
  they are downloaded one by one at the commit and cached under `.build/facade/vscode-loc/`.
  The repository holds none of them ("vendor nothing", ENGINEERING.md).
- **Merge.** Facade's file has the shape of a pack's translations, keyed the same way:
  `vscode` for the window's strings by module and key, and an extension id for an extension's,
  with `package` for its `package.nls.json` and `bundle` for its `vscode.l10n.t` strings, keyed
  by message as the extension host looks them up. Facade's entries win over Microsoft's. An
  extension Microsoft has no file for, such as `vscode.facade-agents`, gets one, and the pack's
  `localizations` contribution lists it.
- **Manifest.** The pack keeps Microsoft's language names and license, lists its translation
  files, and takes the built-in extensions' publisher, `vscode`, with Facade Code's version and
  engine. Its name is `facade-language-pack-<pack>`, `zh-hans` for example.
- **Built in from the first start.** The shared process rebuilds `languagepacks.json` from every
  installed extension, built-in ones included, each time it starts, so a built-in pack is listed
  without ever being installed. The very first start of a new profile picks its display language
  before the shared process has written the file, so a `--locale` given on that start takes effect
  from the next one; LC4's question restarts, and is unaffected.

## LC7. Checks

The pack build fails, and names the strings, when:

- **A visible string is untranslated.** The window's English is the build's own
  `nls.keys.json` and `nls.messages.json`; each built-in extension's is its
  `package.nls.json`, and Facade's extensions' code strings are read from their sources with
  `@vscode/l10n-dev`. A string counts as visible unless its module or extension is one LC3
  excepts.
- **A translation names VS Code** (`VS Code`, `VS code`, `Visual Studio Code`) where the English
  does not.
- **A Facade translation lost something it must keep**: a `{0}` or `${name}` placeholder, a code
  span, a link target or a menu's `&&` mnemonic. `node build/lib/facade/checkTranslations.ts`
  runs this check and the next two without a build.
- **Facade's English moved.** `locales/facade.i18n.en.json` holds the English every Facade
  entry was translated from. An entry whose English is no longer the build's has to be
  translated again; an entry no longer in the build is dropped.
- **The languages disagree.** Every `locales/<folder>/facade.i18n.json` has exactly the
  entries of `facade.i18n.en.json`.

## LC8. Moving to a newer VS Code or vscode-loc

Moving the pinned commit, or importing a newer VS Code, is followed by a pack build. Its
failures are the work: strings to translate, strings Microsoft now covers whose Facade entry
can go, and strings whose English moved. The new translations are reviewed the way the first
ones were, by two models from other vendors.

## LC9. Terms

A term the window already uses keeps Microsoft's word for it, so one window does not call a thing
two names: worktree is what the Git extension's commands call it, Integrated Browser what the
browser's do. A term only Facade Code has takes the word the README's translation in `locales/`
uses. **Facade Code**, **CLI**, **MCP** and **YOLO** are never translated.

| | worktree | agent | workspace bar | feature | tech lead |
| --- | --- | --- | --- | --- | --- |
| `zh-cn` | 工作树 | agent | 工作区栏 | 功能 | 技术负责人 |
| `zh-tw` | 工作樹 | agent | 工作區列 | 功能 | tech lead |
| `pt-br` | árvore de trabalho | agente | barra de workspaces | funcionalidade | tech lead |
| `es` | árbol de trabajo | agente | barra de espacios de trabajo | funcionalidad | tech lead |
| `ru` | рабочее дерево | агент | панель рабочих пространств | фича | техлид |
| `de` | Worktree | Agent | Workspace-Leiste | Feature | Tech Lead |
| `ja` | 作業ツリー | エージェント | ワークスペース バー | 機能 | テックリード |
| `fr` | arborescence de travail | agent | barre des espaces de travail | fonctionnalité | tech lead |
| `ko` | 작업 트리 | 에이전트 | 워크스페이스 바 | 기능 | 테크 리드 |
| `tr` | çalışma ağacı | ajan | çalışma alanı çubuğu | özellik | teknik lider |
| `pl` | drzewo robocze | agent | pasek obszarów roboczych | funkcja | tech lead |

## LC10. First start

`src/vs/workbench/contrib/facadeLocalization/` holds the notification of LC4. It reads the
operating system's language as VS Code's suggestion does, finds a built-in pack through the
language pack service, and takes the notification's own words from that pack's translations,
so they appear in the language they offer.
