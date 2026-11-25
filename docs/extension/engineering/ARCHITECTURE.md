# Architecture and engineering

Group 6 describes the Orchestrator-backed editor. Sections on legacy implementation execution, window lifetime and storage
apply to the transition. Groups 4 and 5 also specify shared packaging and engineering safeguards.

Layer 4. The product and shared rules decide behavior; this document chooses the implementation structure and
engineering safeguards. A platform behavior that only native evidence can prove, such as how the editor's windows
reload, restart and close, is a proof obligation here (2.2); [Verification](VERIFICATION.md) owns the gates and their
evidence.

| Group | Decides |
| --- | --- |
| 1 Components | Workspace runtime, window components, PTY supervisor and public APIs |
| 2 Ownership and recovery | Lifetimes, bounded records and actual effects |
| 3 Data and safety | Storage, paths, rendering, secrets and logs |
| 4 Repository and delivery | Source layout, builds, compatibility, packaging and translations |
| 5 Working safely | Tests, isolated editor/CLI runs and Git boundaries |
| [6 Orchestrator-backed editor](#6-connecting-the-editor-to-the-orchestrator) | Host connection, workspace state, Attach and packages |

## 1 Components

### 1.1 Separate client routing from workspace execution

**Use the Framework execution host and a local editor component.**

The workspace extension connects to Framework for its resolved execution home. Framework owns agent records, execution,
machine routing, input delivery and terminal streams. The local Window Component supplies identity and native terminal
registration. The workspace extension owns the roster, Pins, launch selection and editor projections. A remote workspace selects
its execution host's Facade home, and the local component uses its own editor storage.

The editor sends exact machine-qualified references to Framework. Its machine routes and MCP tools use the same engine and
identities as Shell. The published 0.1.5 client and supervisor records are inputs to the cutover in 1.4.

### 1.2 Public editor APIs and explicit dependencies

**Use public extension APIs for editor interaction and an owned, versioned PTY backend for process/terminal behavior.**

No proposed APIs, internal workbench commands, guessed terminal `$mid`, patched editor files or dependence on private
vendor editor commands for core functionality. Where no extension API exists, documented user-bindable workbench
commands are used, such as pinning or unpinning the active editor for a terminal tab's Pin and focusing an editor group
by its number to make a tab's group the active one (LIFECYCLE-2.2, 3.4); the editor's
internal or underscore-prefixed commands and guessed `$mid` contexts are prohibited. Terminal icons follow CONFIGURATION-2.4: built-in logos use contributed `facade-cli-<id>` glyphs in the theme's
text color; robots use `facade-robot-<color>` from `media/robots.woff`, a COLR v1 font at U+E200–U+E20F.
`scripts/robot-icons.py` uses fontTools 4.60.1 for asset maintenance only, producing the font, picker images and
card faces and eyes. Packaging and runtime do not need Python. Use the public terminal icon API and keep icons
correct after theme changes and restoration (LIFECYCLE-2.2).
A workspace extension runs where its workspace is; extensionKind is placement preference, not two
simultaneous instances.
[Official remote extension guidance](https://code.visualstudio.com/api/advanced-topics/remote-extensions).

The execution component packages its own `node-pty` backend (4.3) with third-party notices and never locates
undocumented editor-bundled native modules by guessed appRoot paths. ptyd and each run's shim run on the extension
host's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), ptyd detached so that it outlives the window. Execution
packages are platform-specific, so that remote hosts and compatible editors are supported honestly. Nothing is
downloaded or compiled during ordinary activation. A backend that cannot load on its host fails that capability clearly
and keeps usable existing records.

### 1.3 Boundaries and code structure

**Use plain ports and explicit island interfaces.**

[ISLANDS](ISLANDS.md) defines the owners and the [source map](../../../extension/islands.json) names each file, public
export and permitted consumer. The activation root composes the islands. The workspace host supplies editor and operating
system effects. The panel owns its projections, commands and pickers, and the webview uses the plain host/page contract.
The local Window Component talks to the workspace host through session-validated native commands.

| Source layer | Other source layers it may import |
| --- | --- |
| extension.ts | host |
| host | ui, core, record, base |
| ui | core, webview/protocol, base |
| core, record | base |
| base, webview | None |

The source graph resolves type and runtime dependencies, directory entry points and re-exports. It rejects cycles, private
imports and unowned files. The window and page entry points cannot reach the legacy supervisor. Package tests inspect all
three bundle graphs and both VSIX contents. Only the entry points, host and UI import the editor API.

### 1.4 Framework activation and legacy cutover

**Framework owns execution. Retire the published TypeScript implementation one verified workspace at a time.**

A compatible Framework activation reconnects to existing agents. To upgrade a legacy workspace, resolve its
execution home and predecessor identity. When its legacy agents still run, show the existing confirmation with
the counts of affected runs and saved Pins. Approval covers those exact runs. Freeze the saved Pins before asking
the supervisor to stop a run, and wait for confirmed exit before restoring its Pin.

An independent old workspace retains ownership of its agents and can upgrade later. Its processes do not hold
the current workspace at the cutover screen. Successors of the same workspace share the durable approval,
stop outcome and Pin recovery result. The first approved claimant that can legitimately obtain custody stops the
exact run and publishes the confirmed Framework reference after recovery. An old window still holding custody
can finish or stop its own agents. A successor that cannot obtain custody can activate Framework and defer
the affected recovery. Defer recovery while the exact old session may still be in use. Keep uncertain outcomes
fenced. A window waiting for its authorized stops reloads when they are confirmed. When there is no such stop to
wait for, it activates Framework immediately. Framework activation failure reports the error and offers a reload.
Group 6 owns Framework connection and workspace recovery.

For a local successor, the Window Component supplies its predecessor's retired workspace claim. The released
component records the owner generation even when it has already disposed of all terminal views. The migration
adapter obtains process identities from the verified supervisor. It reuses the retired claim only while its
generation and token still match the persisted owner and no live row of that owner on the supervisor is attached
elsewhere. Claim validation and dispatch share the generation lock. Each stop names an approved, unambiguous run
and its confirmed process identity.

## 2 Ownership and recovery

### 2.1 Routes without shared-remote-home assumptions

**Use Framework's machine routes and the exact execution environment of each agent.**

Framework discovers and routes agents independently of the editors that view them. The workspace hosts send machine-qualified
references to their execution connection. The Window Component owns native identity and retirement of terminal handles.

### 2.2 Window lifetime is a proof obligation

**Verify the native window identity and keep it separate from Framework process lifetime.**

The editor window obtains its existing token from the Window Component's native log directory. The component checks the
current editor session before returning it. A workspace may recover its exact prior URI binding from the published ledger
and handover records. A remembered workspace key by itself grants no custody.

A reload reconciles the existing roster with Framework records. Hosts sharing a workspace share its locked roster and
recovery round. Closing a view releases its stream. An explicit Stop targets the selected managed process. The local
terminal registry retires only verified predecessor handles (6.3). VERIFICATION-5 covers native window lifetime evidence.

### 2.3 Execution ownership and input deadlines

**Framework owns process, input and deadline effects.**

The workspace host uses the typed daemon protocol for exact starts, stops, resumes, subscriptions and terminal input.
The owner of each operation projects an unavailable answer separately from a confirmed end. Terminal closure updates
the view and the roster manages membership, Pins and hiding. Published supervisor stops use the process and custody
evidence in 1.4.

### 2.4 Journals, pressure and upgrades

**Reconnect to compatible running agents and read the published legacy state for cutover.**

Framework negotiates the editor connection and owns process lifetime, backpressure and reconnect across a compatible
replacement. A compatible replacement preserves the process, exact session and terminal stream. An incompatible reply
leaves its outcome uncertain and reports the connection failure (6.1).

The migration adapter observes the published legacy supervisor registry and workspace records. It persists scoped
consent and stop intent before asking for retirement, verifies ownership and process identity, and defers a Pin while
its session may still be held. After confirmed exit, Pin recovery uses Framework (1.4, 6.2).

## 3 Data and safety

### 3.1 Storage owners

**Data remains in its owning environment and belongs to the user; Facade uploads nothing and adds no telemetry.**

| Store | Contents |
| --- | --- |
| Execution settings file, `<Facade home>/facade.json` | User configuration, owned by CONFIGURATION; shared by windows in that execution environment |
| Window Component global storage on the client computer, `home.json` | The resolved local Facade: Home, written by local windows and read by remote windows' local components; absent when no local setting is set |
| Framework state | Process, session, machine, and delivery records under the Framework home. See [Framework architecture](../../framework/ARCHITECTURE.md). |
| Released TypeScript state | Supervisor registry and exact run inventory, URI ledger, native handover, old ownership generations and saved Pins under the execution home's extension directory. The old release owns its active records. |
| Framework workspace roster | Roster and Pins owns v1 membership, Pins, hidden agents and import markers in orchestrator-workspace.json. All writes use the roster lock. |
| Legacy cutover record, `<Facade home>/extension/legacy-cutover.json` | The cutover owner records consent for the exact affected runs and keeps the Pin snapshots until the earlier workspaces can import them. Confirmed exits leave the active inventory. The migration adapter holds scoped notice and custody locks and keeps shared recovery attempts and confirmed references. Retain the snapshots for the legacy compatibility period. |
| Workspace legacy Pin recovery, `<Facade home>/extension/workspaces/<key>/orchestrator-legacy-pins.json` | Roster and Pins owns the record. It holds unresolved saved sessions and preserves unrecognized input. Accept the confirmed Pin in the roster before consuming the corresponding recovery entry. Retain the import marker for the legacy compatibility period. |
| Editor workspace storage | Workspace key (2.2), Panel preferences and launch location history. Earlier versions mirrored legacy workspace state here. |
| Vendor CLI store | Its own conversations, credentials and settings |
| Beside the main checkout | New worktrees under WORKTREES-2.2 |

The legacy implementation's workspace claim guards its state writes. A superseded claim cannot commit.

The Facade home is chosen as the window starts. An explicitly set **Facade: Home** (`facade.home`, machine scope)
wins, then `FACADE_HOME`, then `~/.facade`. Blank strings and `null` count as unset. The setting's box shows
`~/.facade`; that default does not override the environment variable. A setting value must be absolute or start with `~/` (`~\` on Windows). An unusable setting
stops every start with an error and an Open Settings button at `facade.home`, on the Remote tab in a remote window
or the User tab locally (`workbench.action.openRemoteSettings` or `workbench.action.openSettings`, with the same query).
`FACADE_HOME` itself must be absolute. On Windows, an absolute home must name a drive (`C:\`) or a share
(`\\server\share`). This applies to the setting, `FACADE_HOME` and the home saved in `home.json`. A path such as
`\folder` names no drive and is refused like a relative path: the setting gets the usual unusable-value error,
`FACADE_HOME` gets its existing absolute-folder error, and a saved home supplies no home, like an unreadable record.
A number, list, object or boolean is set but unusable: it stops every start
and leaves `home.json` unchanged. The error shows its JSON, for example
`Facade: Home "42" must start with ~/ or be absolute. No agent can start until it is fixed.` Tests use temporary homes.

A change to the setting offers **The new Facade home applies only after the window reloads.** with **Reload Window**.
Another spelling of the folder already in use offers nothing. This includes paths through links; comparisons
ignore case on Windows and macOS. The same comparison applies to a local setting and a remote component's recorded
home. When no setting was set, setting it to the folder already supplied by `FACADE_HOME` or `~/.facade` also offers
nothing.
This reload offer also applies after an unusable value stopped the window: the listener is registered before
validation, so correcting the value offers the reload. A running window keeps its chosen home until then. When set,
the resolved setting goes into the extension host's `FACADE_HOME`, used by the Framework connection and its agents, and into the window's terminals. Only windows with the same Facade home
reach each other's agents. Choosing Reload Window after the component has been disposed does nothing.

A local window's Window Component writes its Facade: Home to `home.json` in its own global storage on this computer,
at start and whenever the setting changes. A set, usable value is written as the resolved absolute folder. With no
setting, the file is removed. An unusable value leaves the record unchanged; a write failure is logged.

In a remote window, VS Code exposes only the remote machine's machine-scoped value. The local Window Component
therefore reads this computer's `home.json` instead: its recorded home wins, otherwise `FACADE_HOME`, then `~/.facade`.
An unreadable or invalid record supplies no home. The component watches the record and reads it again once the
watch starts. A different home written between the first reading and the watch's start is therefore seen and offers
the same reload notice. Later changes to a different folder do the same; the current home stays in use until reload.
A record naming the folder already in use offers nothing; removing it also offers nothing when its `FACADE_HOME` or `~/.facade` fallback is that
folder. A watch that fails later, such as when its folder is deleted, stops. With no watch, whether it failed to
start or stopped later, the new home applies at the next reload. The remote execution component continues to use the remote machine's Facade: Home.

The home is shared with the Facade Code IDE. Extension runtime data uses its `extension/` subfolder;
configuration uses `facade.json` at the home level (CONFIGURATION-1.1). This does not integrate the IDE's old extension.
The adapter reads old private POSIX supervisor sockets in the published temporary directory and the old named pipes
on Windows. Preserve user histories. A missing or unreachable endpoint requires the evidence in 1.4 before it can
authorize recovery.

### 3.2 Files, Git and untrusted text

**Preserve user files and exact paths; treat outside text as data rather than executable interface content.**

Preserve URI authority and compare paths in the owning environment. No shell interpolation or blanket recursive
deletion. Native Git owns worktree creation/preparation; Facade provides no discard/initialization subsystem; its one
deletion of the person's work is WORKTREES-3.2's `git worktree remove` without `--force`. Otherwise Facade deletes only
content it injected into a folder (CLIS-2.2) and its own records.
Webview rendering uses text nodes and the editor's normal resource constraints; messages do not execute command links.
Validate protocol shape and bound each line read; a call beyond the bound is refused explicitly (2.1), never cut or
silently dropped. Native editor trust and CLI sandbox/approval controls remain native; Facade adds no separate security
product or prompts.

### 3.3 Diagnostics

**Show Agents Log presents operation and lifecycle facts without secrets or task-policy judgments.**

Use a read-only editor log with UTC time, safe name/reference, operation ID, phase, effects, route status and actual
failure. Apply CONFIGURATION-4.2: hide the person's environment values, including values nested in generated
configuration, and redact sensitive arguments before rendering them. Facade's constants are shown; generated per-run
values keep their placeholders. Full message text belongs to deliberate message
history, not routine transport logs. Correlation IDs connect UI/MCP/supervisor observations. The agents log,
`workspaces/<key>/agents.log`, keeps 30 days, pruned as the window activates, with no size cap; ptyd's own log stays
within 2 MiB, keeping its newest 512 KiB of whole lines. Each tool call is logged with its tool, its caller's alias,
its status and error code and how long it took, never complete argument objects. Explicit requested CLI, model, effort
and destination are launch facts; prompts, terminal bodies, full argv and the person's environment values are excluded. Existing
call/request IDs and short agent/message references connect dispatch, route, answer, accepted work and final receipt.
Start/stop receipts preserve their operation and execution window across routing and persistence. Message log entries
record identity and meaningful delivery/effect transitions, not repeated unchanged attempts or message bodies. The
diagnostics report labels its window/environment scope: a local log is not a complete distributed trace. There is no
second operation ID, telemetry service or background history scan.

Structured history uses `events.jsonl` beside the workspace's agents log. Records carry UTC `at`, event name,
window/environment and existing agent/call/request IDs where applicable. Window attach/detach is distinguished from
proven closure. Location catalogs and changed CLI scans are recorded at activation and existing location/configuration
notifications, with unchanged scan results coalesced. Queries and startup still read current facts. Agent launch requests,
process starts, failed starts, exits and cleanup outcomes retain requested settings without claiming native model
acceptance. MCP results cover requests rejected before an agent exists. No prompts or complete argument objects enter
these records. History is read with ordinary file tools; it is not an MCP query or an aggregate model/effort catalog.
The private launch context and each window snapshot supply the absolute path and execution environment. A remote path
is never advertised as a local file. On activation, prune entries older than 30 days; writes stay bounded to three 4 MiB
files (current, `.1`, `.2`). An oversized event becomes an explicit omission record. Diagnostic write failure cannot
fail a business operation; lock contention does not wait.

An empty agents log opens with `No agent events yet`, with no information toast.

The diagnostics report, which only the integration suite's test-mode `facade.diagnostics` command produces (UX-3.2),
holds in English, as the log is, what a report of a problem needs, and sends nothing anywhere: the extension's, its
window component's and the editor's versions, the platform and the remote kind; each CLI of
the window's first location, custom ones included - its version as its installation says it and its input reader, or
why it cannot start - and settings-file or entry errors under CONFIGURATION-4.1; this window's agents - CLI and version, lifecycle,
activity and since when, tools, and what their input reader reads now - with each live one's last twelve screen rows;
and the agents log's last two hundred lines. The home folder is written `~`, whatever the case or separators a path
spells it with, as VS Code lowercases a Windows drive letter.

## 4 Repository and delivery

### 4.1 Source layout and build

**Source, specifications, generated output and temporary probes have separate locations.**

`extension/` is the extension's root: README, CHANGELOG, AGENTS, licenses/notices, package manifest, lock, tsconfig and
.nvmrc; the paths below are relative to it. The repository ignores `.agents/` and tracks nothing in it outside the IDE's
`ide/` folder: the product injects `.agents/skills/facade` into project folders for Codex and Muse Code and
`.agents/plugins/facade` for Antigravity, so a committed `facade` skill or plugin would conflict under CLIS-2.2;
repository-owned skills never use the `facade` name. The extension has no shared `.vscode/` configuration. Build, test
and packaging run through repository scripts; optional developer-local editor settings are not prerequisites and never
replace the isolated test profiles in group 5. `docs/extension/` at the repository root: the complete maintained
documentation, including normative rules and audit data. `src/`: code/tests by layers; `l10n/`: all translations;
`media/`: shipped assets; `scripts/`: build/audit tooling; `window/`: the window component's manifest and README.
Generated code/package/test output goes under `build/`, never source folders. Component packaging uses
`build/extension/` for the workspace host and Framework programs. The local Window Component stages in build/window/. Native artifacts have explicit platform ownership. The window component has no native backend and
ships as a separate universal VSIX.

Use Node 24 from `.nvmrc`. Clean checkout/CI dependency installation uses `npm ci` with the committed lockfile;
`npm install` is for deliberate dependency changes, with their lockfile changes reviewed together. Build/check commands:
`npm run compile` (type checks and the unit-test build), `npm run bundle`, `npm test`, `npm run package` (both VSIXs,
into `build/vsix/`), `npm run test:package` (package-content checks; they require `build/vsix` from `npm run package`)
and `VSCODE_EXECUTABLE=<isolated editor executable> npm run test:integration`, which on macOS uses the standard VS Code
installation when the variable is unset; `FACADE_IT_ONLY` runs one part of it (`journeys`, `cross`, `conversion`,
`reopen` or `expiry`) and `FACADE_IT_KEEP=1` keeps what a run left. On Linux the integration suite runs under a virtual
display (`xvfb-run -a`); on Windows it runs in the signed-in desktop session, as an SSH session has no desktop, and its
fake CLIs are `.cmd` launchers of a Node script, as npm and Pi's installer write them. `npm run test:remote` runs the
journeys over Remote-SSH from this computer to the hosts of a given SSH configuration (`FACADE_IT_SSH_CONFIG`;
`FACADE_IT_SSH_HOST` and `FACADE_IT_REMOTE_EXTENSION`, the extension built on each host, comma-separated): one SSH
window, two SSH windows, local to SSH, SSH to local and, given two hosts, between them, each with Remote-SSH and the
editor's server in folders of the run's own, under `/tmp` unless `FACADE_IT_REMOTE_ROOT` names another folder.
`FACADE_IT_CONTAINER`, an image with Node, Git and a user `node`, runs the same scenarios on Linux in a container of the
local Docker, its windows attached as Dev Containers attaches. `FACADE_IT_ONLY=real-lifecycle` runs an isolated real CLI lifecycle. Its account and state are separate
from the owner's daily environment. Published cutover journeys install both prior and candidate VSIX pairs. Document changes to these commands before using a different build layout. Lock dependency versions, preserve
licenses/notices, and keep generated/runtime files ignored. Do not repurpose HOME/CODEX_HOME as script scratch
variables.

The integration fixture build is staged separately in `build/extension-it/`; `npm run test:integration` assembles it
from the bundled extension `npm run bundle` made, before launching the isolated test editor. Test-only adapters/commands
are absent from production bundles/manifests under UX-3.2. A fixture passing does not verify its corresponding real CLI.

The root README includes repository development instructions when useful. A single optional block marked
`<!-- repository-only:start -->` and `<!-- repository-only:end -->` is omitted from the staged README; all other content
is preserved. No markers means no omission; unmatched, nested or repeated markers fail the build. The source README is
never rewritten by staging. This keeps repository setup instructions out of the installer-facing product description.

### 4.2 Released settings and development state

**Read the released state through its declared compatibility contract.**

The released settings file and vendor CLI state stay in their execution home. Framework reads its documented settings
schema and the cutover reads the released supervisor and saved Pin records described in 1.4. Ambiguous prior identities
and unrecognized input stay pending. Development state and old IDE settings have no migration path.

### 4.3 Packaging and version support

**Ship the runtime component with tested platform artifacts and an honest minimum-editor capability matrix.**

The minimum editor is VS Code 1.105 (`engines.vscode` is `^1.105.0` in both components); a newer public API is
feature-detected or raises the declared minimum, never called unguarded. Facade Code is published to the Marketplace and
Open VSX only when the owner asks. Both components and the Framework carry one release version, 0.1.6, which the changelog's
heading names; the build refuses a window component of another version, packaging refuses a Framework build of another version or a
protocol copy (`src/base/frameworkProtocol.ts`) that differs from the Framework source, and `scripts/release.mjs version` raises all three.
The darwin-x64, darwin-arm64, linux-x64 and linux-arm64 packages carry the Framework's release programs, `bin/facade` and
`bin/facade-mcp`, Linux's built with musl and static. The win32-x64 and win32-arm64 packages carry the Framework's release
programs, `bin/facade.exe` and `bin/facade-mcp.exe`, built for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`
respectively, and ConPTY for the same architecture, `bin/conpty/conpty.dll` and `bin/conpty/OpenConsole.exe`. Packaging
refuses a package where any of these four is missing or a binary is of another target; executable-mode and static-musl
checks apply only to Unix. A release signs the Windows packages' programs with the publisher's certificate, the IDE's
(Azure Artifact Signing, IDENTITY I6), each signature timestamped: packaging with `--sign` signs every program and library
in `bin/` that has no trusted signature - ConPTY's come signed by Microsoft - and packages none that still has none.
Unsigned, the 0.1.6 `facade.exe` was quarantined by Microsoft Defender as `Trojan:Win32/Bearfoos.A!ml`, which ended the
running Framework and every agent with it, and Smart App Control refuses an unsigned program outright. Pull request checks
package them unsigned. Third-party notices name the Framework's ConPTY, Microsoft.Windows.Console.ConPTY 1.25.260303002, as
required by Framework. Release candidates target darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64 and
win32-arm64, together with the window component. Publication requires each platform's build and verification evidence
from the release run. The version advances when preparing a release; already published versions retain their original
artifacts. [Official manifest reference](https://code.visualstudio.com/api/references/extension-manifest).

The native Cargo build uses the source commit time and hash. The main executable reports
`<version>+<commit time>.<commit hash>`. Its build ID travels with the paired programs in the VSIX and standalone
archive, and the release marker carries the same ID. Release tags and mirror directories use the numeric version.

The extension checks workflow builds candidate packages for darwin-x64, darwin-arm64, linux-x64, linux-arm64,
win32-x64 and win32-arm64. It uses `macos-15-intel` for Intel Macs, `ubuntu-24.04-arm` for Linux ARM64 and
`windows-11-arm` for Windows ARM64. Each job verifies its requested target against its native host before
installation, passes that target to packaging, and runs the same unit, package-content and isolated editor suites,
with the Framework built by its pinned toolchain on every target and the editor journeys use Framework. Linux x64 also tests the published 0.1.5 to 0.1.6 cutover with both VSIX pairs (1.4).
Artifacts and editor logs name the target. A configured CI target does not establish verified or published support;
that requires the corresponding results and release evidence under VERIFICATION-2.1.

Release candidates use the GitHub Pre-release of their `extension/<version>` tag. A pushed tag must name the manifest's
version. Preparation builds, checks package contents and installs the Shell archive on every native runner.
When a successful full Extension checks run from this repository recorded the exact checked-out Git tree,
preparation records that run and reuses its source test results. Otherwise preparation also runs the full checks.
The two Windows packaging jobs sign in `extension-signing`, the only environment whose OIDC sign-in Azure
accepts for the signing identity. Its variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` name the identity. A manual
run of the extension checks workflow with `sign` signs the same way without releasing.
The prepare action accepts the native packages only when every target's digest record matches the tag's commit and
tree, the workflow run and native package attempt, and the downloaded files. A retry of the GitHub Pre-release job
keeps the successful build job's attempt and original package files. The Windows jobs verify the embedded,
timestamped signatures in the packaged programs before recording their digests. Prepare puts all platform VSIX files,
the window component, installers, native archives, version marker, `release-candidate.json` and `SHA256SUMS` on the
tagged draft. The candidate record names the source, targets, file digests and Windows signature checks. Prepare
checks the set of attached files, downloads them and checks their hashes and VSIX manifests. It then opens the
candidate as a Pre-release with instructions for installing that exact version.

The `mirror` mode stages the Pre-release on the website for exact-version installs during dogfood. The mirror job
copies the verified files to `/releases/<version>/<asset>` in the website's R2 bucket and reads every file back to
compare its hash. The stable version marker advances only in `publish` mode. After dogfood, the owner runs the release
workflow with the candidate tag and `publish`. The stores job waits for approval in the `extension-stores` environment,
downloads the Release's files and checks them against `SHA256SUMS`. It checks the bytes already listed by each store
before uploading any missing package. It publishes the window component before the platform packages to VS Code
Marketplace and Open VSX, and passes only once both stores serve every file byte for byte. Mirror, stores and promotion
require a candidate record that matches the tag and attached release
bytes. Stores and promotion also require the `SHA256SUMS` digest verified by the mirror job. Promotion verifies that
every staged file is still available with its accepted digest before updating the website's stable marker. It reads
back the marker and the pinned installers before marking the same GitHub Release Latest. The website serves
`/install.sh` and `/install.ps1` for the new stable version as UTF-8 text directly from R2.
If the marker write succeeds and read-back fails, the workflow reports a failed promotion before changing GitHub
Latest. A retry with the same manifest digest and the candidate already selected verifies the website without
rewriting the marker. Use `promote --resume` for an explicit recovery that requires the website to still select
that exact candidate. It stops if the marker or an installer differs during read-back.
After promotion it retains the ten most recent formal releases in the mirror. GitHub retains the exact-version releases.
The CI run, Release, mirror and stores use the same bytes. A same-named asset with different bytes stops the release.
A rerun with the complete candidate verifies the existing files. The publish action uses them without rebuilding.

The mirror uses the private `facadecode-releases` R2 bucket and the routes in
[`wrangler.jsonc`](../../../.github/release-mirror/wrangler.jsonc). The Cloudflare account owner creates the bucket and
deploys that config with Wrangler. The `extension-mirror` Actions environment supplies `CLOUDFLARE_ACCOUNT_ID` as a
variable and the R2 upload API token as the `CLOUDFLARE_API_TOKEN` secret.

Versions first published to the stores, before this order, are listed in `extension/archive/`'s catalog with their
source, evidence and original Marketplace files and hashes. Catalog validation requires the historical three-platform
set before 0.1.1 and the complete six-platform set from 0.1.1, each with one universal window component; missing or
duplicate targets fail. `node scripts/release.mjs github --backfill` puts each of them on its own Release from those
original files, hash-checked, and creates a missing tag at the recorded source commit. Historical backfills retain the
published files and explicitly record source or release-metadata differences.

Bundle runtime dependencies and third-party notices, test commands excluded; package both components from build output
with vsce pinned at 4.1.0. The workspace manifest installs its local window component through `extensionPack`, not
`extensionDependencies`: in a remote window the editor installs the remote extension and activates it before it installs
a local dependency, and an unmet dependency then blocks activation with no reload offered. The window component's
manifest names the workspace extension in its own `extensionPack`, so installing either one installs both; alone, the
window component shows nothing. When activating the legacy implementation, the workspace component waits up to 60 seconds for `facade.window.identity` and continues as soon as it appears, including when the
editor reports the component installed later. If it does not appear, the window cannot read its own identity (2.2),
which the component reads, so it cannot tell which agents are its own and shows and starts none (RULES-4.1): the panel
and one notification explain in plain words that the Facade Code Window Component must be installed and enabled on this
computer, with an action that shows it in the Extensions view, Facade's commands repeat that explanation, and a reload
is offered once the component is installed. The running agents go on for RULES-4.1's grace. A remote window's grace leaves time to install the component and reload, which shows the
agents again. A local window has less time. A window component without the client network, too old to carry requests,
leaves its window's agents shown and usable: they reach
this window's agents alone, list_agents and name resolution report the other windows unavailable (`complete: false`,
MCP-3.1), and a new start or send is refused, saying to update the Facade Code Window Component on this computer and
reload the window (1.1). Unpublished installation tests install that component locally as well as the platform-specific
execution VSIX in its execution host.

The execution stage includes its owned backend, node-pty 1.2.0-beta.15 pinned exactly - node-pty 1.1.0's Windows exit
watchers change a shared console list without a lock, which corrupts ptyd when several consoles end together - with its
required runtime dependencies/resources and their license notices under `build/extension/node_modules/`. Each execution
package targets one VS Code platform - its OS and architecture, musl Linux as `alpine` - read from the binaries' own
headers; its addons are Node-API, never bound to one runtime's ABI, so one artifact serves the local extension host and
a remote server alike. The loader resolves this packaged backend, not an editor-internal module. A build verifies only
its own host's platform; another platform needs its own build there and the verification below. Verify actual VSIX
contents and install in clean profiles for each supported editor/OS/remote host. Compatible editor marketing follows
measured support, not a promise that arbitrary forks work. Version mismatch must leave user work intact.

### 4.4 Localization

**Every human-facing implementation string reaches all supported locales in the same change.**

UX-2.4 owns languages/terminology. Keep manifest and runtime translations under `l10n/`; build places manifest strings
beside each shipped manifest. `scripts/l10n.mjs` exports the bundle with exactly the texts the code uses and checks
every language's keys, placeholders and manifest strings with the repository's pinned TypeScript; the unit suite runs
that check. Do not depend on a developer's temporary language-pack files for release checks.

## 5 Working safely

### 5.1 Required checks

**Implementation acceptance requires type checks, relevant unit tests, build, integration and affected runtime scenarios.**

Required commands: `npx tsc -p ./`, `npx tsc -p ./src/webview` (both run by `npm run compile`), `npm test`, `node
scripts/l10n.mjs check`, `node --test scripts/release.test.mjs` where the release tooling changed, the specification
audit (`python3 -I -B ../docs/extension/audit/check_spec.py`), `npm run bundle`, `npm run package`, `npm run
test:package`, and integration against the editor version actually used. Record version and result. Add meaningful
regression tests for behavioral fixes and check sibling CLIs/platforms/entrypoints for the same defect. For UI-only
reversible iteration do not run every suite each small edit; run complete gates at milestones. Docs-only changes need
the specification audit, not a fake code-test pass. VERIFICATION defines additional release scenarios and distinguishes
unrun from passed.

### 5.2 Editor isolation

**Every editor launched for work/testing uses its own short temporary user-data and extensions directories.**

Never run the installed editor, even `Code --version`, against the owner's profile; read installed version metadata
instead. Prefer integration/headless checks. Never drive, reload, close or inspect the owner's existing windows/agents
as test subjects. An explicitly requested new implementation agent is a collaborator, not permission to manipulate the
owner's unrelated sessions. Temporary test windows can take focus; minimize them and record isolated paths. An isolated
editor is the official VS Code build, installed or downloaded under `build/`, never a derived product such as the Facade
Code IDE that loads its own built-in agent extension or shares a data folder with the owner's live state; the runners
read the editor's `product.json` and refuse any other. Test editors start with a sanitized environment, without
inherited editor IPC, Git askpass or CLI credential variables, and use short temporary roots that respect the platform
socket-path limit. Product code never invokes the editor CLI, for example `code --status`, against a default profile.

### 5.3 CLI isolation

**Real CLI probes use isolated temporary state and never mutate the owner's conversations, memories or configuration.**

Use CLI-supported state-directory overrides for the probe process only, never repurpose HOME/CODEX_HOME as scratch
variables. No probe when the CLI cannot be isolated; use recorded evidence and report the gap. **Never run a real Qwen
probe** under this repository's standing safety rule. Keep real model probes short. Collaborator assignments and model
choices follow current user instructions; authorization to start one does not authorize additional collaborators or
credential/global-configuration changes.
The real integration runner refuses a personal-home override and state directories outside temporary storage before
opening an editor. Its default Claude and XDG state is isolated too; opting into a real CLI never opts into global state.
Recorded screens are published with the repository: `scripts/capture-inputs.mjs` masks email addresses and the recording
user's name character for character before a screen becomes a recorded case, and a unit test refuses a fixture showing
an email address outside the domains reserved for examples.

### 5.4 Working tree and commits

**Preserve unrelated working-tree changes and never stage, commit, push, publish or release without an owner request.**

Inspect the current working-tree baseline before edits. Work in the authorized workspace or explicitly tracked
isolated worktree; uncommitted content does not follow a new Git worktree automatically. Never reset/clean to simplify a
refactor. Remove only generated artifacts owned by this task. Logs and completion reports identify what was changed,
what was tested and what remains. Task assignments, pauses and discussion authority follow current user instructions.


## 6 Connecting the editor to the Orchestrator

### 6.1 One local Orchestrator connection per extension host

**Connect to the Orchestrator in the host's Facade home using daemon API v1.**

Use RULES-6.6 for home selection and RULES-6.7 for remote-host ownership. The editor sends operations through
the same Orchestrator as Shell and MCP. Running agent records, session enumeration, process state, agent state and
titles come from that Orchestrator. The workspace has no Orchestrator registration or routing role.

Send `hello` with `kind:"ide"` and `api_versions:[1]`. Check the selected API version and machine identity before
using that connection's advertised operations and topics. Send one `agent.start` after the editor's selection flow.
The Orchestrator validates the request before creating a worktree or process. Stop uses one exact target and reports
the result of that item. Resume passes the returned exact target from a local, folder-scoped query.

The workspace host's [activation](../../../extension/src/extension.ts#L11) selects the implementation and starts the
[Orchestrator connection](../../../extension/src/host/framework/index.ts#L77) for the resolved home. On activation
or a home switch, the extension offers its bundled program set for selection. The home keeps an equal or higher
selection. A higher bundled build installs from the extension files and can take over after normal admission.
Commands use the selected home launcher. After hello,
it opens the workspace state, installs the machine and agent watches and connects them to the Panel. The
[agent view](../../../extension/src/host/framework/agents.ts#L76) projects observed running Managed Agents and
reconciles confirmed records with workspace members and Pins. Opening a terminal uses Attach (6.3). [Deactivation](../../../extension/src/host/framework/index.ts#L215)
releases the editor's subscriptions, terminal views and connection while the Orchestrator retains the agents.

An incompatible hello makes Framework activation fail with a version error. During a compatible takeover the daemon
sends `closing {build}`. The editor acknowledges on that connection and verifies a fresh hello.

### 6.2 Workspace state and upgrade

**Keep workspace agent addresses, Pins and terminal presentation on the editor side.**

Windows of the same workspace consume and update the same normalized roster under RULES-6.1. Use the canonical
workspace URI ledger and read the saved members, Pins and earlier hidden entries from `orchestrator-workspace.json`.
An unrelated live card from the agent watch does not add a roster entry. Earlier hidden entries apply to legacy reconciliation.
Preserve the saved import marker when legacy membership is still pending. Reconcile stored references with
confirmed agent records and retain entries when a remote machine has yet to supply its snapshot.
Roster and Pins owns the optional startup settings and outstanding start request on a Pin in roster version 1.
Older Pins can omit both. Resolve a successful start by replacing the reference and consuming the request in one
roster write. Follow a known session and name as Framework reports them. Use the current CLI environment when
starting from a Pin.

Read local `facade.pins` from a verified legacy workspace file or from the snapshot saved before an approved cutover.
For a folderless window, the persisted native
window token can identify its original workspace key in `extension/windows/`. That key locates the local Pins even
when the workspace sidecar is absent. Merge the confirmed Pins under the roster lock, retaining a person's current
Pins and hidden entries. A new empty window stores its roster key in VS Code workspace state. Share the existing
Pin restore round across windows and use the full persisted agent or session identity for recovery. Keep unfinished
session recovery in its workspace record and fence a resume with an uncertain reply.

### 6.3 Terminals and the Window Component

**An open terminal is an Attach to the agent's terminal session.**

Use RULES-6.3 for input on reconnect, size and colors. Each view chooses `watch attach` when the current connection's
hello advertises both the `attach` topic and `attach.resize`. The initial watch includes any known pane capacity.
Later capacity and color reports use `attach.resize` with the watch ID issued on that connection. Accept a reply,
event or closing notification only from the installed connection. Watch effects and captured callbacks also check the
live registration and watch ID. Reconnecting verifies the new hello and takes a fresh snapshot before drawing.

The editor reads pane capacity from `Pseudoterminal.setDimensions`. Before drawing a snapshot or full redraw, it
sets the renderer grid to the frame's dimensions through `Pseudoterminal.onDidOverrideDimensions`. Terminal
creation and display remain workspace presentation. The Window Component can clean up stale terminal tabs under
RULES-6.8. A missing component leaves the Orchestrator-backed editor usable and skips that cleanup.

### 6.4 Distribution

**The extension packages an Orchestrator for the target on which its workspace host runs.**

The editor package carries the corresponding Framework programs and, on Windows, their required ConPTY files.
The extension selects the packaged build for the resolved home and connects through that home's launcher. The standalone archives reuse the same programs from the
VSIX. The archives are `facade-framework-darwin-<arch>.tar.gz`, `facade-framework-linux-<arch>.tar.gz` and
`facade-framework-win32-<arch>.zip`, with `x64` and `arm64` as architecture values. The release publishes these with
`install.sh`, `install.ps1`, `facade-framework-version.txt` and `SHA256SUMS`. The stores serve the VSIX packages.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.4 | Local and remote installation, window components and registry, public API audit, layer rules, native backend package, compatible reconnect and installed legacy cutover |
| 2.1–2.4 | G1 routes between local and remote windows; G2 actual close/reload traces; folder-to-workspace handover; shim routing and input deadlines; color scheme reports with current and earlier supervisors (VERIFICATION E07); pressure/upgrades from every released build with agents running |
| 3.1–3.3 | Home precedence, User/Remote Settings tabs, reload after invalid-home correction, local home record writes/removal and remote use, reload on record changes, invalid paths and wrong JSON types preserving the record, Windows homes naming a drive or share, null/blank unset, same-folder reload suppression locally/remotely including links and fallback, a record written before the watch starts, disposal and failed watches, storage ownership/retention, preserved user files, correct paths and safe text rendering without an authentication subsystem |
| 4.1–4.4 | Build/package checks and native platform matrix, extension-pack installation in local and remote windows, development-build state ignored without migration, locale completeness |
| 5.1–5.4 | Evidence and command logs, isolated profile/config paths, dirty-tree preservation, no unrequested Git publication |

See [Verification](VERIFICATION.md) for the gates and their status.
