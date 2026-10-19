# Identity

Who Facade Code is: its name, its pictures, the ids the operating system keeps for it,
who publishes it and where its links go, its version, its packages, the services it
uses, its words and the AI it fronts. It is decided from the top down: a principle
(I1), one test that separates identity from compatibility (I2), and each kind of
identity in turn.

[ACTIVITY-BAR.md](ACTIVITY-BAR.md) owns view-icon placement and interaction.
[WORKSPACE.md](WORKSPACE.md) owns the workspace bar, the rest of the window layout
and its defaults, and defines the test levels (W15) that Part 3 uses. L1 includes
this document, ACTIVITY-BAR.md, WORKSPACE.md and [WORKTREE.md](WORKTREE.md).

Acceptance cases are requirements to verify, not claims that the implementation
already passes them.

# Part 1: Specification

## I1. The principle

Facade Code is its own product, built on VS Code, and everything that identifies it is
its own.

Three parties tell which product they are dealing with, and a borrowed identity
misleads each of them:

| Who | Reads the identity from | Misled into |
| --- | --- | --- |
| the person | the name, the icon, About, the links | asking Microsoft for help, or trusting it as Microsoft's |
| the operating system | bundle id, installer ids, protocol, data folders | treating two applications as one: installing one upgrades, overwrites or removes the other |
| other software and services | the name and protocol the API reports, the gallery, the services it calls | serving it what is meant for Microsoft's products |

The MIT license covers upstream's code, not Microsoft's names or marks. Upstream names
its own build "Code - OSS" so that a product made from it supplies its own identity.

## I2. Identity and contracts

Changing everything that identifies the product must not break what VS Code users rely
on. One test separates the two: **does anything outside Facade Code depend on this
value to work?** If it does, the value is a contract and stays upstream's: that is VS
Code consistency. If nothing does, it only says which product this is, and it is
Facade's own.

| Identity: Facade's own | Contract: upstream's, and what changing it would break |
| --- | --- |
| the name, its short form, the description | the `vscode` extension API, and the engine version extensions are checked against: extensions would not install |
| the icons, and every picture of the product | `.vscode/` in a project, and the files in it: every repository's settings, launch and tasks |
| the command line, the URL protocol, the data folders | `.code-workspace` files and their format: stock VS Code could not open them |
| bundle id, app user model id, installer ids, mutexes, file-association ids, macOS profile ids | setting, command, view and keybinding ids: people's `settings.json` and `keybindings.json` |
| the publisher, the home, license and issue links, the signing identity | built-in extensions' ids (`vscode.git`) and the `.vsix` format: other extensions rely on them |
| the product's own release version | the command line's flags (`--new-window`, `--add`, `--diff`): scripts and habits |
| the AI it fronts and the services it uses | internal URI schemes (`vscode-file`, `vscode-webview`): extensions and webview content |

`vscode.env.appName` and `vscode.env.uriScheme` are read by extensions at run time
from the product's own configuration, so reporting Facade's name and protocol breaks
nobody through those API fields: they are identity. Preserve the formats and API
identifiers listed above. Intentional changes to workspace navigation and extension
activation are documented separately in WORKSPACE.md W8.

## I3. Names

The product is `Facade Code`, as its long and its short name alike. The short name is
what the macOS menu bar shows and what names the folder of settings and window state
in the operating system's application data, `Facade Code`. "Facade" alone is too common
a word. VS Code's are `Visual Studio Code` and `Code`.

The description says what it is: a fork of Visual Studio Code that shows one folder of
a workspace at a time. Naming what it is built on is a fact, and says VS Code (I10).

Every name a machine reads is one word, `facade`, as every editor of this family has
one (`code`, `cursor`, `windsurf`, `codium`). It is short to type, and it is the word
Facade already uses for its home folder and for `.facade/` in a project.

| What | Name |
| --- | --- |
| the command line (`applicationName`) | `facade` |
| the URL protocol (`urlProtocol`) | `facade://` |
| the server (`serverApplicationName`) | `facade-server` |
| the tunnel (`tunnelApplicationName`) | `facade-tunnel` |
| the Linux icon (`linuxIconName`) | `facade` |

The product has one home folder, `~/.facade`, as VS Code has one `~/.vscode`:

| What | Where |
| --- | --- |
| extensions and `argv.json` (`dataFolderName`) | `~/.facade` |
| shared data (`sharedDataFolderName`) | `~/.facade-shared` |
| the server's data (`serverDataFolderName`) | `~/.facade-server` |
| worktrees (WORKTREE.md WT-2.1), agent records, `injected.json`, `kept/` | `~/.facade`, as before |

The name is also spelled out by files that do not read `product.json`:
`resources/server/manifest.json`, `resources/win32/VisualElementsManifest.xml`, the Linux
desktop entries, and AppData and package templates. A person reads it in the title bar,
About, the dock, the taskbar and the Start menu, the installer, the Explorer context menu
on Windows 10 and Finder's, `facade --version`, and the package manager.

## I4. Pictures

Every picture of the product is Facade's: the app icon on every OS, the document icons
file associations show, the installer's images and the tiles, the server's favicon and
the empty editor's watermark. A picture of something else - a theme's preview, a
language's icon - stays upstream's.

```text
app          opaque square, generous margin   -> resources/darwin/code.icon -> Assets.car
                                              -> resources/darwin/code.icns, rounded body
web-icon     transparent outside and in gaps  -> linux, server, win32, favicon
web-inline   silhouette only                  -> the empty editor's watermark
```

Each target keeps its existing set of sizes. The watermark keeps its depth: each layer's
ink against white, normalised to the frontmost, as `fill-opacity`; 0.15 in light themes
and 0.45 in dark ones; fixed colours in high contrast. An app icon is checked as the
system renders it: macOS 26 and later draw it from `Assets.car` and clip the square to a
rounded superellipse, while macOS 15 and earlier draw the rounded pictures `actool`
renders into the same catalog; so judge colour and geometry on both, and after a change
`touch` the bundle, register it again with `lsregister -f` and restart the Dock. An app
whose bundle has only an `.icns` is put on a grey plate by macOS 26 when that `.icns` has
a shape of its own. How `Assets.car` is compiled is in `build/lib/facade/assetsCar.ts`;
how the `.icns` is built, and why its 16px and 32px slots hold no PNG of their own, is in
`build/lib/facade/icns.ts`.

## I5. What the operating system keeps

Every id the operating system keeps for the application is Facade's own, so that it
never takes Facade Code and another build of VS Code for one application.

| Id | Value |
| --- | --- |
| macOS bundle id | `com.facadecode.FacadeCode`, under the product's own domain |
| Windows app user model id | `FacadeCode.FacadeCode`, publisher's brand and product as Windows asks |
| Windows installer ids (`win32x64AppId`, `win32arm64AppId`, `win32x64UserAppId`, `win32arm64UserAppId`) | GUIDs of Facade's own |
| macOS profile UUIDs (`darwinProfileUUID`, `darwinProfilePayloadUUID`) | UUIDs of Facade's own |
| mutexes (`facadecode`, `facadecode-tunnelservice`, `facadecode-tunnel`), registry value (`FacadeCode`), install folder (`Facade Code`), shell menu entry (`F&acade Code`) | as given |
| Windows 11's context menu | none. Windows 11's menu takes entries only from a packaged app with a COM handler of its own, which Facade does not build, and Facade adds no classic entry under Show more options either: the installer offers its two context menu tasks on Windows 10 only, where they write "Open with Facade Code" |
| Linux enterprise policy | `/etc/facade/policy.json`. Upstream hard-codes `/etc/vscode/policy.json`, which would make VS Code's policy Facade's too |
| the workspace file's MIME type on Linux | `application/x-facade-workspace`, upstream's pattern of one type per product |

An id the operating system has stored costs something to change: a new bundle id makes
macOS treat the product as a new application, and new installer ids leave an earlier
install behind as a second application. They are settled before the first release.

## I6. Who publishes it

Two names, each with its own job. The **product and brand** is Facade Code, at
`https://facadecode.com/`. The **legal publisher** is Yuanzhe Zhang: a signing
certificate is issued only to a person or an organization, so wherever a field means
"publisher", it names him.

| What | Value |
| --- | --- |
| home page (`productHomeUrl`; the installer's publisher, support and updates links) | `https://facadecode.com/` |
| contact | GitHub: the repository's issues, and its Discussions when they are opened. No email address appears in the product, as VS Code's public channel is its issues |
| license link (`licenseUrl`, `serverLicenseUrl`) | `https://github.com/y5ez3g/facadecode/blob/main/LICENSE.txt` |
| issue link (`reportIssueUrl`) | `https://github.com/y5ez3g/facadecode/issues/new` |
| the Linux package's maintainer (`packageMaintainer`) | `Yuanzhe Zhang <y5ez3g@gmail.com>`: Debian's format requires a name and an address, and this is the only place one is written |
| Windows code signing | a certificate in Yuanzhe Zhang's name: Windows shows "Verified publisher: Yuanzhe Zhang" |
| Apple code signing | `Developer ID Application: Yuanzhe Zhang`, from his own account |
| Windows Apps & features publisher (`AppPublisher`), the executables' company (`CompanyName`) | `Yuanzhe Zhang` |
| copyright, in `LICENSE.txt` and in the executables' and installer's version info | two lines: Microsoft Corporation's, and `Facade Code contributors` |
| `ThirdPartyNotices.txt` | upstream's, and code this fork copies from elsewhere, only code actually copied |
| the repository's `SECURITY.md`, `README.md` and issue templates | Facade's, pointing to the repository; none names Microsoft as a contact or VS Code as the product |

The license is MIT with both copyright lines. The links resolve once the repository is
public, and it is public before the first release.

## I7. Version

Two versions, each with its own job. The **engine version** stays upstream's, 1.138.0
today, because extensions are checked against it (`vscode.version`,
`engines.vscode`); `package.json`'s version is that one. The **release version** is
the product's own, because a person, a bug report and a release note need to say which
Facade Code it is: semantic versioning, `0.1.0` at the first release, kept in
`product.json` as `facadeVersion`. Other forks show their own version beside the VS
Code version they are built on. VSCodium uses VS Code's version because it builds VS
Code unchanged; Facade Code does not.

| Where a version shows | Which |
| --- | --- |
| About | both: `Facade Code 0.1.0 (based on VS Code 1.138.0)` |
| `facade --version`, `facade --help` | the release version, the engine version beside it |
| Windows Apps & features, the executables' file version | the release version |
| macOS `Info.plist`, what Finder shows | the release version |
| the Ubuntu package's version, what `apt show` shows | the release version |
| the issue reporter, the first line of each log | both |
| `vscode.version`, `engines.vscode`, the gallery's compatibility check, the remote server's handshake | the engine version |

One source and one check keep this true as packages are added:

- `facadeVersion` in `product.json` is the only place the release version is written.
  The build stamps it onto every package's metadata in one place; at run time it is read
  only through `productService`.
- After a build, a check reads every version field of every artifact against the table
  above and fails the build on a mismatch. A new package or platform is one new row.
- A package's version only ever increases, so an installer and `apt` always see an
  upgrade.

## I8. Packages

| Package | Signed as | Notes |
| --- | --- | --- |
| macOS disk image | `Developer ID Application: Yuanzhe Zhang`, notarized | RELEASE.md |
| Windows installer | Yuanzhe Zhang's code signing certificate | |
| Ubuntu `.deb` | not signed: apt checks the signatures of repositories, and there is none | `.rpm` and Snap are not part of L1 |

The Ubuntu package is named `facade`; no package of that name exists in Ubuntu's
archive. It installs `/usr/bin/facade`, gives `Yuanzhe Zhang <y5ez3g@gmail.com>` as its
maintainer and `https://facadecode.com/` as its home, and registers `facade://`.

It neither adds nor removes anything of Microsoft's apt repository or signing key:
installing it asks nothing about Microsoft's repository and writes no source or key,
and removing or purging it leaves `vscode.sources` and `microsoft.gpg` alone, so VS Code
installed beside it goes on updating. It adds no apt source of its own: a new version is
a new `.deb` from the repository's GitHub Releases.

## I9. Services

Facade Code uses no service reserved for Microsoft's products, and calls no service as
VS Code but one: GitHub sign-in, for now, below.

| Service | What Facade Code uses |
| --- | --- |
| extension gallery | Open VSX. Microsoft's Marketplace is for Microsoft's products; an extension published only there, Microsoft's Remote Development extensions included, is not offered |
| extension signatures | not verified: `extensions.verifySignature` is off by default. The verifier, `@vscode/vsce-sign`, is Microsoft's, under its own licence, and not in the product; on without it, every install fails with "Signature verification was not executed" |
| AI | upstream's chat and Copilot are not fronted (I11) |
| voice | none: `product.json` names no voice service |
| settings sync, tunnels | none |
| GitHub sign-in | for now, VS Code's GitHub OAuth app, which upstream's built-in extension names: GitHub's authorization page and the person's authorized apps say Visual Studio Code, and one authorization is shared with VS Code. Facade's own app is not set up (I12). Sign-in is GitHub's device-code flow - Facade shows a code to enter at github.com - since `facade://` is no callback the extension accepts and no client secret ships, so nothing passes through `vscode.dev/redirect` |
| Microsoft sign-in | none: the built-in `microsoft-authentication` extension, which signs in as VS Code's app, is not shipped; nothing in Facade needs a Microsoft account |
| telemetry | none |
| updates | none: a new version is a new download |
| built-in extensions | fetched at build time from their public repositories |
| webview content | on the desktop, the local `vscode-webview://`; a web build's host is decided with the web build |

Built-in extensions reach the network as they do upstream - TypeScript's automatic type
acquisition asks the npm registry, for example. Nothing else a window does on its own
reaches a service this table does not name.

## I10. Words

A string that names the running product says Facade Code, through
`productService.nameLong`. A string about VS Code the project - its documentation, its
Marketplace, "based on VS Code" in About - says VS Code.

The rule covers what Facade Code shows by default. A string only something off by
default shows stays upstream's: nobody reads it until that thing is turned on. That is
upstream's AI - chat, Copilot, agent sessions, MCP, voice - which I11 keeps off, and
which is also the part of upstream that changes most, so about 150 edits there would
come back as conflicts with every merge. It is also a language pack: upstream's
translations, none installed by default, each showing its own wording.

Upstream's localized strings are audited against this rule: about 300 name VS Code
literally, and each one that still says VS Code is listed with its reason.

## I11. AI

Facade's AI is its agents, which run in terminals (AGENT-LAUNCHER.md). Upstream's chat
and Copilot are not registered by default: `chat.disableAIFeatures` defaults to `true`
where upstream's is `false`, and `false` restores stock in one step, without a rebuild.
They are hidden, not deleted: the Copilot extension stays in the tree and the build,
and `product.json` keeps `defaultChatAgent`, which 129 call sites read. No visible
control may lead to something hidden: no chat view, no Copilot status, no "ask" hint in
an empty editor, no sparkle in Source Control, no setup prompt. With AI features off,
the command palette has no "Use AI Features with Copilot for free...", and the command
line's `chat` subcommand and `--agents` are hidden; used anyway, they answer that AI
features are off (`chat.disableAIFeatures`).

## I12. Not included

```text
importing from VS Code      settings, keybindings and extensions are a feature, not identity
an updater                  a new version is a new download
telemetry of its own        none
.rpm and Snap packages      Ubuntu's .deb only
a web build                 and with it the webview content host
its own GitHub OAuth app    GitHub sign-in borrows VS Code's app for now (I9)
```

# Part 2: Technical Design

## I13. Where it lives

| Piece | Holds |
| --- | --- |
| `product.json` | I3's names, I5's ids, I6's links and maintainer, `facadeVersion`, the gallery, `defaultChatAgent`; no `voiceWsUrl` |
| `resources/` | the manifests, the Linux desktop entries, AppData and package templates, the Debian scripts (`postinst`, `postrm`, `templates`), every icon, the installer's images |
| `build/lib/electron.ts`, `build/gulpfile.vscode.ts` | the executables' version info: company and copyright |
| `build/win32/code.iss`, `build/gulpfile.vscode.win32.ts` | the installer's publisher, links and copyright |
| `build/gulpfile.vscode.linux.ts` | the Linux packages' maintainer, home and description |
| `build/lib/facade/icns.ts`, `ico.ts`, `brandIcons.ts` | the icon builds |
| `contrib/chat/browser/chat.shared.contribution.ts` | `chat.disableAIFeatures`' default; the AI entrances I11 hides |
| `extensions/github-authentication/src/config.ts` | the GitHub OAuth app's client id: upstream's, VS Code's, for now (I9) |
| `build/lib/extensions.ts`' excluded extensions | `microsoft-authentication` left out |
| `src/vs/base/common/policy.ts` | the Linux policy file's path, named after the product |
| `build/win32/code.iss` | the classic context menu's two tasks, offered on Windows 10 only |
| `build/lib/facade/` | stamping `facadeVersion` onto every package, and the check of every artifact's version fields |
| the About dialog (`platform/dialogs/electron-browser/dialog.ts`, `workbench/browser/parts/dialogs/dialog.ts`) | the release version beside the engine version |
| `build/lib/facade/words.ts` | I10's audit: each string that still says VS Code, with its reason |
| `build/lib/test/facadeBranding.test.ts` | the U-level checks of the installer, the Linux packages, sign-in, the AI default and the license |

The name is read through `productService` everywhere else.

# Part 3: Acceptance

## I14. Acceptance matrix

Levels are WORKSPACE.md's W15.

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| ID-01 | U | Read `product.json` and every file that spells the name: the server manifest, `VisualElementsManifest.xml`, the Linux desktop entries, AppData and package templates, the AppX manifest | Every value of I3, I5 and I6; no identity value equal to Code - OSS's or VS Code's |
| ID-02 | I, H | Read the name where a person sees it: the title bar, About, the dock, the taskbar, the Start menu, the installer, the Explorer context menu on Windows 10 and Finder's, `facade --version`, the Linux desktop entry | Facade Code everywhere; "Code - OSS" nowhere; About shows both versions (I7) |
| ID-03 | I | On Windows and macOS with VS Code and a Code - OSS build installed and running, install and run Facade Code; open each product's URL; run each command line; uninstall each in turn | All three run at once with separate settings, extensions and windows; `code` and `facade`, `vscode://` and `facade://` each reach their own product; uninstalling one leaves the others working |
| ID-04 | H | The app icon in the dock, the taskbar, the Start menu and the app switcher; an associated file's icon; the installer; the server's favicon; on each OS | Facade's art, every size of each set, as the system renders it |
| ID-05 | H | The empty editor's watermark in Dark Modern, Light Modern, HC Dark and HC Light | Depth kept; 0.15 light, 0.45 dark; fixed colours in high contrast |
| ID-06 | U, I | A fresh profile; then `chat.disableAIFeatures: false` | No AI control in the title bar, command center, status bar, empty editor, Source Control or views, and no upstream chat view registered; with the setting off, stock chat returns without a rebuild; Facade's agent launchers are there either way |
| ID-07 | I | Install an extension that declares `engines.vscode: ^1.90.0`; search for, install and update another | Both install, against the engine version; everything comes from Open VSX; no request reaches Microsoft's Marketplace |
| ID-08 | I | Record the network of a fresh profile left idle for ten minutes, and through WORKSPACE.md's W17 gate | No telemetry and no update check; every host contacted is one I9 names, or a built-in extension's upstream behavior, listed with the extension that made the request |
| ID-09 | I, H | Help > About, View License, Report Issue | About shows `Facade Code 0.1.0 (based on VS Code 1.138.0)`; View License opens the repository's `LICENSE.txt`, MIT with both copyright lines; Report Issue opens the repository's new issue page |
| ID-10 | I | A project with `.vscode/settings.json`, `launch.json`, `tasks.json` and `extensions.json`; a `.code-workspace` file; a `keybindings.json` copied from VS Code | Each is read as VS Code reads it (I2's contracts) |
| ID-11 | I | The macOS disk image, the Windows installer and the Ubuntu package | Each carries I5's ids. macOS is signed as `Developer ID Application: Yuanzhe Zhang` and notarized. Windows shows "Verified publisher: Yuanzhe Zhang" and Apps & features names him. The Ubuntu package's maintainer is `Yuanzhe Zhang <y5ez3g@gmail.com>` |
| ID-12 | I | A fresh profile; install an extension; look in the home folder | The extension is in `~/.facade/extensions` and `argv.json` in `~/.facade`, beside worktrees and agent records; there is no `~/.facade-code` |
| ID-13 | U | Scan the user-visible strings against I10's audit | Every string shown by default that names the running product says Facade Code; each remaining "VS Code" is listed with its reason |
| ID-14 | U, I | On Ubuntu with VS Code installed from Microsoft's apt repository, install Facade Code's `.deb`, use it, remove it, then purge it | Installing asks nothing and writes no Microsoft source or key; after removing and purging, VS Code's `vscode.sources` and `microsoft.gpg` are still there and `apt update` still updates VS Code; `apt show facade` names Facade Code, its maintainer and its home; `facade` is on the PATH; a `facade://` link opens Facade Code |
| ID-15 | U, I | Sign in to GitHub from Facade Code, as Clone from GitHub does; open the Accounts menu | The device code is entered at github.com, for VS Code's app as I9 says for now; no request reaches `vscode.dev`; no Microsoft account is offered |
| ID-16 | U, I, H | Install on Windows 10 with the two context menu tasks ticked, and on Windows 11; right-click a file, a folder and a folder's background in Explorer | Windows 10: "Open with Facade Code" on each. Windows 11: the installer offers neither task, and no entry appears, in the menu or under Show more options |
| ID-17 | U, I | On Linux, put one policy in `/etc/facade/policy.json` and a conflicting one in `/etc/vscode/policy.json` | Facade Code obeys its own file only |
| ID-18 | U | Build the three packages and read every version field of every artifact | Each carries the version I7's table gives it; the check fails the build when one does not |
| ID-19 | I | With AI features off, search the command palette for Copilot; run `facade chat` and `facade --agents` | No Copilot setup command; each command line answers that AI features are off |
| ID-20 | U | Read the repository's `SECURITY.md`, `README.md` and issue templates | Facade's, pointing to the repository; no Microsoft contact, no VS Code as the product |
