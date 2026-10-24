# 24-hour Remote SSH validation: Mac to Windows and Linux

Status: the real campaign is running. Baseline and rebuilt candidate results, including failures, are recorded under `.build/logs/remote-ssh-mac/campaign-20261023/`. This file defines the ordered targets; only completed observations in `results.json` and the associated artifacts establish coverage. The campaign is timeboxed, with measured coverage and explicit blockers.

## Objective and scope

Validate `feature/62-remote-ssh` from a real macOS arm64 client connected to Windows x64 and Linux x64 hosts, using the packaged application, real OpenSSH servers, real files and Git repositories, and authenticated supported agent CLIs. Ordinary SSH development and Facade's workspace, worktree and agent behavior are equally required. A passing shell SSH command alone does not establish that the application works.

The initial candidate is `0a951f4a1c7bfa9a8db9078ed3666802f2ff4c81`; the comparison base is `67f2a77e`. Pin the candidate for a run. After a product fix, record the new commit, rebuild the affected artifacts, and rerun affected cases and the continuous journey.

Normative references: [REMOTE.md](../../facade-code-spec/REMOTE.md), [WORKSPACE.md W19](../../facade-code-spec/WORKSPACE.md#w19-shared-test-plan), [AGENT-LAUNCHER.md L14](../../facade-code-spec/AGENT-LAUNCHER.md#l14-evidence-and-release-gate), and [RELEASE.md](../../facade-code-spec/RELEASE.md#remote-servers). This plan does not change their requirements.

The user's clarified primary matrix is Mac to Linux x64 and Mac to Windows x64 with OpenSSH Server. A macOS SSH host, Windows-client WSL and the Windows/Ubuntu client portions of RM-25 are deferred to separate campaigns. Do not spend this campaign's main-path budget on Mac-to-Mac coverage. A scope boundary is not evidence that a deferred case passed.

## 24-hour schedule

Campaign start: 2026-10-23 21:26 America/Los_Angeles (2026-10-24 04:26 UTC). Target finish: 2026-10-24 21:26 America/Los_Angeles. Hours below are elapsed from the campaign start, including environment preparation. Missing hosts do not silently restart that clock.

The order is risk driven. Run a small complete journey on each target before expanding either one. Fix a broken prerequisite before deeper cases that depend on it, while continuing useful work on the other available target. Record a blocker immediately; do not spend the night repeating the same unavailable connection.

| Elapsed | Priority | Work on both Windows and Linux | Required checkpoint |
| --- | --- | --- | --- |
| 0-2 h | P0 | Establish actual host access, inspect tools/authentication, prepare the Mac app and matching platform servers, configure a reachable archive mirror and disposable fixtures | Actual OS/architecture and artifact commits/hashes recorded; build/install blockers named; first real application connection attempted on each available host |
| 2-4 h | P0 | On each target: connect through the UI, install the server, open a folder, edit/save, run a terminal command and Git action, forward a web port, add a second workspace folder, start one authenticated real agent, reload and continue | One complete ordinary-work/Facade journey per OS; remote file effects and surviving PID/start time checked; failures reproducible |
| 4-7 h | P0 | Common daily SSH use: alias/custom port/key/agent/password/cancellation, remote files/search/upload/download, terminal PATH, remote CLI, SCM pull/push, remote extension, F5 and automatic/manual/configured forwarding | Daily-use matrix for each OS; no Mac-local operation mistaken for a remote one |
| 7-10 h | P0 | Facade workspace/worktree: folder-to-workspace conversion, add/switch/remove/trust, hidden editors/terminals, unsaved changes, reload/save/reopen, UI and agent worktree creation/deletion, Cancel and other-window ownership | Workspace contents, Git refs, process identity and records agree after every preservation boundary |
| 10-14 h | P0/P1 | Real agent CLI matrix, each advertised built-in on each remote OS; eight tools, parent/child and mixed-vendor work, human input, background focus, approvals, final screens and stopping | Actual model task/report and remote coding effect; missing login/quota recorded per vendor; no fake CLI evidence |
| 14-17 h | P0/P1 | Network cuts, twenty-second call timeouts, queued versus claimed input, pending/cancelled starts, reconnect/takeover, away close and shortened real server expiry | No duplicate commands/agents or late expired input; correct surviving and ended processes, truthful outcomes and one ledger writer |
| 17-21 h | P1 | Windows PowerShell/cmd and paths/signing, Linux shells/signals/glibc, ProxyJump/ProxyCommand, proxy/offline install, authentication variants, host-key errors, multi-window isolation, actual client sleep/wake where available | Platform-specific results and actual fault mechanism; unsupported/missing fixtures remain explicit |
| 21-24 h | P0 | Finish high-priority fixes, rebuild matching artifacts, rerun affected cases plus the complete journey on both OSes, review soak evidence, clean only test-owned resources, write final report | Final-commit results per target; no unresolved failure hidden by an earlier build's PASS; artifacts and reproduction steps retained |

Start a separate soak lane as soon as an OS's first complete journey passes, aiming for at least 12 hours of observation within the 24-hour window. Run it with separate fixtures and accounts/server instances so that it neither contaminates destructive tests nor keeps an expiry-test server alive. Every cycle performs real UI/SSH work and records its effects; an idle timer is not a soak test. A product-changing fix ends the old artifact's soak and starts a separately identified final-build interval. Do not combine their durations into a final-build stability claim.

The soak cycle alternates folder navigation, remote sentinel edit/save/readback, shell output and PID checks, actual forwarded HTTP response, agent message/task round trips and reload/reconnect. Use bounded workloads and per-operation IDs; inspect counts for duplicate/missing submissions and sample process/memory growth over time. Mix in real network cuts only on the soak's own SSH path. End soak processes and verify cleanup after evidence is retained.

### Priority and measurable coverage

- P0 means daily use, data preservation, correct machine/target, workspace/agent ownership, successful stop and recovery without replay. A P0 failure prevents a healthy verdict for that target.
- P1 means common configuration and platform variants, full advertised vendor coverage, degraded networks and installation limits. An untested P1 prevents a comprehensive verdict; it does not invalidate independent recorded passes.
- P2 means additional client/remote platforms, rare combinations and exhaustive pairing. Mac-to-Mac, WSL, another client OS and exhaustive vendor pairing are outside this 24-hour target matrix.

Target these repetitions on each OS, increasing them when failures justify it: three fresh isolated server installs; ten warm reconnects; ten concurrent two-window connection rounds; ten folder-to-workspace transitions; one hundred A/B folder switches; twenty reloads with foreground and background work; ten worktree create/delete rounds including Cancel and dirty data; twenty ten-second network cuts and five one-minute cuts. Complete at least one real coding/message/child lifecycle journey for each advertised CLI, then repeat affected vendor cases after fixes. These are test targets, not pre-recorded results. Logs must contain actual completed counts and outcomes; counts alone never replace assertions.

Use short triage loops: capture the first failure, minimize its reproduction, classify environment versus product, fix within the authorized feature branch when appropriate, and rerun the reproducer. If a repair consumes the available budget, preserve the defect and continue independent high-priority coverage rather than repeatedly running an unchanged known failure. Rebuild and retest before clearing a defect. Do not merge, publish or retag as part of this campaign.

Keep durable checkpoints at hours 2, 4, 8, 12, 18 and 24, plus immediately on a new blocker, critical defect or artifact change. Each records Windows/Linux separately: build, completed/failed/blocked/not-run counts, reproductions, evidence, soak duration on that exact build, and the next highest-priority action. During active work, give concise progress updates as well; checkpoints do not substitute for communication.

Prepare a morning report by approximately 07:00 America/Los_Angeles on 2026-10-24, even if the 24-hour campaign is still active. It must describe actual results available then and remaining work; it must not imply that later scheduled coverage or a full-day soak already completed.

### First complete journey on each remote

1. From the actual Mac application's remote indicator or Remote Explorer, connect to a real host using a fresh isolated profile. Install the matching server through the SSH extension, not a preinstalled different build.
2. Open repository A, create and save a unique sentinel from the editor, and confirm its exact content through an independent SSH connection.
3. Open a remote terminal, verify hostname/OS/cwd/PID, run a Git action and a long command, and view a forwarded remote HTTP application with a host-specific response.
4. Launch an authenticated real agent from the menu and have its model make a small real change in A. Record its process, identity, tools and log.
5. Add repository B through File > Add Folder to Workspace. Require automatic connection recovery, unchanged agent identity/process and the same long-running shell process.
6. Switch A/B, keep an unsaved editor and a background terminal, create a remote worktree, and exchange a real agent message/task. Verify actual remote Git and files.
7. Reload and reconnect. Require preserved unsaved content, terminals and the same surviving agent; send another task to prove it works after recovery.
8. Cancel deletion/close once and verify no effect; then stop/delete/close with confirmation. Confirm only intended processes and test worktrees ended and their branches/data follow the specified contract.

Both targets must complete this journey before broad configuration coverage receives priority. If one target is unavailable, keep it BLOCKED and advance the available target while requesting the missing host; never report the pair as tested.

## Preflight findings, 2026-10-23

- The worktree was clean before preparation. The target branch was fetched, checked out with its upstream, and pulled with `--ff-only`.
- Client: macOS 27.0.1, build 26A434, arm64. Default Node is 26.0.0; Homebrew provides Node 24.21.0. The repository pins 24.18.0 and requires major 24. Record the exact version used.
- At initial preflight this worktree had no `node_modules`, client output, Electron download, or compiled Facade agent extension. During campaign preparation, dependency installation completed using Node 24.21.0; this is environment preparation, not an application test.
- Docker is not running. Colima's existing default profile is stopped and is aarch64. No running test host has been established. A default arm64 Linux VM does not substitute for the supported Linux x64 host.
- SSH configuration contains a Colima configuration include; no independently supplied test host has been selected.
- The current `facade/0.1.2` release contains three desktop installers and no server archives. Real HTTP HEAD requests to the default server URLs for `darwin-arm64`, `linux-x64`, and `win32-x64` each returned 404. This blocks first-install testing with the default download URL; it does not establish a failure of a running SSH window.
- The existing Facade smoke suite explicitly registers a fake `smokeping` CLI. It and the test resolver cannot supply the real SSH/vendor acceptance evidence requested here.

## Required environment

| Environment | Purpose | Evidence limit |
| --- | --- | --- |
| Current Apple Silicon Mac | Client UI, packaged application and automation | Establishes only this OS/build combination; older advertised macOS versions need their own runs |
| Dedicated Linux x64 host or x64 VM/container with real sshd | Main remote development journey, Linux paths/signals, jump host and authentication cases | Record virtualization/emulation; Linux arm64 cannot receive the Linux x64 success label |
| Windows x64 host with OpenSSH Server | Windows remote behavior from the Mac, signed server modules, PowerShell/cmd and forwarding refusal | Missing host or signed archive leaves these cases BLOCKED |
| Second physical computer, if available | Additional ownership/recovery check of the same remote folder | An extended case; two profiles/windows on one Mac do not prove RM-20 |
| Additional Linux fixtures | Debian 10/glibc 2.28, sshd container, Alpine/arm64 negative cases, jump host | State which fixture actually ran |

Use disposable remote accounts and a dedicated fixture root. Isolate client user data, extensions, shared data, debug ports and Playwright session names. Use `FACADE_HOME` for Facade records where appropriate; do not overwrite `HOME` or `CODEX_HOME`. `FACADE_HOME` does not isolate `~/.facade/injected.json` or vendor login/configuration files, so a separate test account is still needed for complete isolation.

Record client/server commits, artifact SHA-256 hashes, OS/architecture, Node/Git/OpenSSH versions, SSH extension version and effective configuration. Every server must match the client commit; do not use the installed old application or a different release's server.

Build dependencies in this worktree without symlinking another worktree's `node_modules`. Use Node 24. For source-level diagnosis, prepare the client, codicon font and built-in extensions as ENGINEERING.md requires, and use the repository launch skill. Final acceptance uses the packaged `.app` and matching Linux/Windows server packages:

```sh
npm run gulp vscode-darwin-arm64-min
```

Linux and Windows servers must be built on their own OS as RELEASE.md specifies; Linux uses its glibc baseline and Windows its signing checks. A locally built unsigned Mac application supplies functional evidence, not distribution signing/notarization evidence.

Serve the actual matching archives from a private test mirror reachable by the hosts and set `remote.SSH.serverDownloadUrlTemplate` only in the isolated client profile. Keep these distinct:

1. Empty server directory, archive downloaded and installed by the real SSH extension: first-install evidence through the mirror.
2. Matching archive unpacked by hand: recovery/offline evidence only.
3. Default public URL: retain the current 404 finding until a compatible release actually exists. A mirror pass does not turn that finding into a default-URL pass.

Do not publish or modify a GitHub release as part of environment preparation. The existing release must not be retagged to the feature commit.

## Automation and independent observation

- Drive the actual Electron window over CDP with Playwright. Take a fresh accessibility snapshot, click the visible control or use the normal shortcut, wait for the requested observable state, and capture the result. Cover the remote indicator, Remote Explorer, Explorer, workspace rows, menus, dialogs, terminal, Ports, Source Control and agent controls.
- Use actual UI input to exercise product actions. DOM inspection and a normally loaded observation extension may collect state, PID, workspace and configuration facts; they must not replace a service, return success for an operation, or manufacture terminal/agent state. Do not use an extension test host as the only evidence of normal-window reload behavior.
- Keep workspace trust enabled for trust and ordinary acceptance cases. The launch skill's simple file-dialog option can automate paths; also exercise native macOS dialogs and permission prompts on the actual desktop where the case depends on them. CDP alone does not verify TCC or VoiceOver.
- Independently inspect each host through a control SSH connection: files and hashes, Git refs/worktrees, server/extension-host/terminal/agent PID and start time, and the run's ledger/logs. Record hostname, remote OS, cwd and a unique host sentinel from the UI terminal. An identical path on two hosts must not make their results interchangeable.
- An authenticated product MCP client may act as `@human` to exercise tools against real agents. Vendor acceptance additionally requires the actual CLI/model to fetch the task, respond and perform the requested operation. An echo program, fake CLI or text merely appearing in an input field is insufficient.
- Inject network faults in the test SSH path, with a separate controllable connection per window. A TCP proxy can cut/stall/delay that connection. Actual packet-loss claims require an actual packet-level network emulator; dropping arbitrary SSH bytes is not a substitute. Do not stop the server to simulate a network cut, or alter the user's global network.
- Use a separate control route to observe remote processes during a cut. Do not accidentally carry the tested application through that route. Control connections must not keep a Facade window/server artificially alive during expiry cases.

The runner should separate preflight, fixture preparation, UI journeys, host assertions, fault control and reporting. `remote.mjs` executes actual scripts over the isolated control SSH connections; it is infrastructure, not an application acceptance test. UI journeys are being driven against the packaged app with Playwright. Existing `npm run smoketest -- --remote` uses the test resolver; it must not be presented as this real-SSH runner.

## Execution order and observable outcomes

### C1. Connect and install

From a fresh profile, click the remote indicator and connect with `user@host`; repeat through Remote Explorer using a config alias with a custom user, port and key. Begin with an empty server directory. Observe the actual download, matching commit, built-in extension activation, remote indicator and remote folder listing. Reconnect, restart the application, and start two windows concurrently; record whether one matching server is reused.

Exercise public key, encrypted key, SSH agent, password and keyboard-interactive authentication where supported; cancellation, invalid credentials, changed host key, an unreachable host, a bad port, a missing archive and a corrupt archive. Require an actionable result and bounded failure without a false connected state. Verify ProxyJump and ProxyCommand using actual SSH servers. Compare native SSH and ssh2 paths where the pinned extension exposes both.

### C2. Everyday remote development

In Explorer, create, rename, move, edit, save and delete sentinel files/folders. Search remote text. Upload a local file using the actual drop action and download a remote file; compare hashes on both machines. Open a remote symlink and paths with spaces, Unicode and case variants.

Start real terminals, inspect hostname/OS/cwd/PID, run a command found only on the login shell PATH, and use the host's `facade <file>` CLI. Use zsh on macOS, zsh/fish on Linux, and PowerShell/cmd on Windows where installed. Use Source Control to stage, commit, branch, pull and push against a disposable real bare Git repository, including real SSH authentication and agent forwarding. Install a language extension on the host and verify its language behavior. Run a Node program under F5, stop at a breakpoint and inspect remote variables.

Start an HTTP application on the host that returns a unique remote sentinel. Check automatic forwarding, the Ports view, `LocalForward`, reconnect cleanup/rebind, a local port collision and an invalid forward. Open the actual forwarded application and verify its response. Check the Integrated Browser's remote-source URL behavior where applicable.

### C3. Remote settings and CLI discovery

Start with no CLIs on the remote while real CLIs exist on the Mac. The agent menu must name the remote in its empty state; Open Terminal must run there. Install/configure actual CLIs only in the test account's login-shell PATH and reopen the menu. Verify remote detection without per-file network probing. Configure Agents must open remote settings. A local-only machine setting must not affect the remote, and one host's settings must not leak to another.

### C4. Workspace and worktree journey

Create real repositories A and B, an untrusted folder C, a bare Git remote, at least two commits and a second branch. Include an ignored `.env`, untracked data, an unsaved editor, hidden editors, a long-running panel shell and background terminals. Give long processes a run-specific marker and an output log that can be checked independently.

Open A, start a real agent and the long command, then use File > Add Folder to Workspace to add B. This folder-to-workspace transition may migrate/reload the remote workbench; it must reconnect automatically and preserve the agent's identity and process and the shell's process. Then add C through the bar's `+`, exercising Cancel and Trust and Add. Later membership changes and folder switches must not restart the extension host.

Navigate with clicks, keyboard, Open Folder, Show Local and the remote CLI. Match the row, Explorer, SCM, editor ownership, title, branch and actual workspace file at every settled step. Create a worktree through the row menu and through a real agent; check the host's `git worktree list`. Delete with running work and unsaved data: Cancel must preserve it; Delete must stop the correct processes first, remove only the test worktree and retain its branch. Check a second window's ownership refusal.

Reload with the active and hidden folders populated. Check exact unsaved sentinel content, customization, process identity and record identity. Save a remote workspace, close with Cancel and then confirmation, reopen through Recent and Remote Explorer, open another workspace, and open Default Workspace into a local window. Removing a folder must not delete its directory. Remote context menus must omit local Reveal actions.

### C5. Real vendor agents

Use the registry's actual built-ins: Claude Code, Codex, Antigravity, Muse Code and Qwen Code, for every advertised remote OS/vendor combination. Record versions, authentication, model, launch configuration, approval/sandbox behavior and connection timing. Missing credentials or quota are BLOCKED with a reason; a supported CLI's failure is FAIL, not a skip.

For each CLI, click its launcher, complete a small real coding task in the disposable repository, and run L16's journey. Cover creator and child roles, representative mixed-vendor cooperation, three generations, two repositories and two workspaces. Exercise the actual eight tools: list/start/stop, send/fetch messages, read screen, type text and press keys. Verify correction/report content, actual model submission, human input guard, background focus preservation, final screens and remote filesystem effects. Check reload, stop, failed login, invalid model and the framework switch. Reuse these runs for the orchestration, messaging and debugging gates; do not infer all vendors from Codex alone.

### C6. Mac client, Windows remote and concurrent windows

On the Windows and Linux hosts, launch two fresh connections together and repeat the race at least ten times. Compare PID and start time across reconnects so a new server with a familiar PID file is not mistaken for recovery. Check kernel release of the actual platform install lock after a stopped installer; an empty old lock file must not block the next setup. Do not run macOS-host `lockf` cases in place of these target-host cases.

On Windows, exercise PowerShell then cmd as the SSH login shell, `.cmd` executable resolution, case-insensitive environment variables and Windows paths, spaces/Unicode, named pipes, console stop, real signed native modules and applicable application-control policy. With `ForwardAgent yes`, verify the connection succeeds despite Windows OpenSSH's agent-forwarding refusal. Check long installer-script execution under cmd, explicit proxy downloads and actionable setup failure results. On Linux, exercise login PATH, zsh/fish, POSIX signals and socket lifetime after other logins end. Use three Mac windows across both hosts and verify closing one leaves the others alive. Never log out the user's active desktop as a fixture action; use a dedicated host/account for the logout case. On the Mac client, test actual shortcuts, native dialogs, host-key/key passphrase prompts and sleep/wake without conflating them with remote-OS behavior.

### C7. Connection loss, recovery and truthful outcomes

First cut the real SSH path for ten seconds and then one minute while the shell and agents work. Restore it and require the same surviving processes, complete output and no repeated commands. Run the five-minute client sleep case on a dedicated machine or in an agreed test window; a paused process is not evidence of actual sleep/wake behavior.

Repeat with the product timeout at twenty seconds. Send text, keys, messages, starts with/without worktrees, a cancelled start, a stop and a deletion during the cut. Record each returned phase and effect. Expired queued input must never appear later; an accepted uncertain start must finish the same run once; a stopped pending start must create no later terminal. Messages must be recorded promptly and their doorbells delivered once after recovery.

Use the actual server's shortened reconnection-grace argument as REMOTE.md prescribes for long expiry cases: two minutes for RM-08, more than five minutes for RM-09. Record the extension-host, agent and server lifetimes independently. Cover reconnect before expiry, extension-host expiry while the server survives, server expiry, away-window Cancel/Close, and reopening before server exit. Check takeover of an old responsive and unresponsive extension host, one ledger writer, no lost/duplicate event and no replayed input. A bounded debugger pause of an actual process may expose a race; do not replace the ledger or transport with fakes.

The Windows startup regression uses `windows-delay-startup.ps1` to add a five-second real delay before the real installed launcher runs. It retains the original launcher, changes no server binary or protocol response, and restores the original bytes with a SHA-256 check. Identify this controlled fault separately from unmodified first-install runs. Restore the launcher before ordinary cases; an observation controller that misses the intended process supplies no passing evidence.

Run the twenty doorbells and twenty typed lines at 200 ms RTT, 50 ms jitter and 1% actual packet loss. Require exactly one submission each and the agent menu within one second. Each fault case records its actual mechanism; unavailable packet-level control is BLOCKED, not a timing pass.

### C8. Installation limits and local regression

Test the mirror and manual-offline install paths independently, a proxy download, a server of another commit, coexistence with another build, a real sshd container, the glibc 2.28 fixture, and unsupported Linux arm64/Alpine errors. Leave other versions' servers untouched.

Repeat local folder/terminal/agent/worktree journeys with the SSH extension enabled and disabled, using the same candidate. Check English and Simplified Chinese, light/dark and high-contrast themes, keyboard focus and macOS dialog button behavior. The SSH extension's own untranslated English is allowed by the specification. A screen-reader result requires actual VoiceOver interaction. Remote performance needs a matched remote baseline; local timing results cannot establish it.

## Traceability to every remote case

Every row below needs its own result, even when several rows share a journey. "Live equivalent" adds real evidence for the requested run; it does not claim to have run the specification's unit/test-resolver case.

| Case | Procedure | macOS-client disposition |
| --- | --- | --- |
| RM-01 | C2/C6: backend, cwd and OS effects | Live equivalent; unit routing evidence separate |
| RM-02 | C5/C7: all tools, reload, stop over SSH | Live equivalent; test-resolver run separate |
| RM-03 | C1: empty-host installation | Adapt Windows-client wording to Mac; retain archive source |
| RM-04 | C5: L16 for every advertised built-in | Required per supported remote OS |
| RM-05 | C3: no CLI, then login-PATH-only real CLI | Required |
| RM-06 | C7: one-minute cut and recovery | Required on SSH hosts |
| RM-07 | C7: timeout, tickets and late effects | Required on SSH hosts |
| RM-08 | C7: one-window grace/server expiry | Required |
| RM-09 | C7: two-window grace and takeover | Required |
| RM-10 | C4/C7: connected close, Cancel, confirm | Required |
| RM-11 | C7: away close and reopen | Required |
| RM-12 | C7: responsive/unresponsive earlier host | Required |
| RM-13 | C6/C7: other sessions logged out | Dedicated host required |
| RM-14 | C4/C5: worktree deletion stops agents first | Required |
| RM-15 | C5/C6: stop Linux process from Mac | Adapt Windows-client wording; assert remote OS signals |
| RM-16 | C7: real impaired network, twenty submissions | Packet-level control required |
| RM-17 | C1/C8: mirror, then manual archive | Required; distinct from default URL |
| RM-18 | C8: glibc 2.28 host | Dedicated Linux fixture required |
| RM-19 | C5/C2: real sign-ins and callback forwarding | Accounts and each supported sign-in mode required |
| RM-20 | C6/C7: same folder from a second computer | Extended check; second computer required, otherwise explicitly deferred |
| RM-21 | Windows-client WSL | Outside macOS-client scope |
| RM-22 | C8: actual container with sshd | Linux fixture required |
| RM-23 | macOS arm64 SSH host | Outside the clarified Windows/Linux remote scope |
| RM-24 | C1/C4/C5/C6/C7 on Windows x64 host | Host, signed server and application-control check required |
| RM-25 | C1..C8 from macOS client | Mac portion only; other clients outside scope |
| RM-26 | C8: local window regression | Required; no fake CLI as vendor evidence |
| RM-27 | C3/C4: remote settings and no Reveal | Required |
| RM-28 | C7: real queued/claimed/unknown effects | Live equivalent; deterministic unit evidence separate |
| RM-29 | C8: wrong commit and coexistence | Required |
| RM-30 | C7: actual earlier-host takeover and ledger | Live equivalent; deterministic unit evidence separate |
| RM-31 | C4: add second and third folder | Required; record first transition separately |
| RM-32 | C4: remote Open Folder and Show Local | Required |
| RM-33 | C4: click/keyboard folder navigation | Required |
| RM-34 | C4/C5: UI and agent worktree creation | Required |
| RM-35 | C4: deletion with dirty work and Cancel | Required |
| RM-36 | C4: remove empty and occupied folder | Required |
| RM-37 | C4: trust Cancel/Add/new restricted window | Required; trust enabled |
| RM-38 | C4: reload including hidden terminals/editors | Required |
| RM-39 | C4: close/save/terminate/reopen workspace | Required |
| RM-40 | C4: Default Workspace opens locally | Required |
| RM-41 | C4/C6: other window owns agent in worktree | Required |
| RM-42 | C4/C8: menu and customization persistence | Required |
| RM-43 | C1: user@host/config/indicator/Explorer | Required on each supported SSH host |
| RM-44 | C2: files, search, actual upload/download | Required |
| RM-45 | C2: terminal shells/PATH/remote facade CLI | Required |
| RM-46 | C2: real Git and forwarded/host keys | Required; Windows agent-forwarding exception recorded |
| RM-47 | C2: remote language extension and local install action | Required |
| RM-48 | C4: Close Remote Connection and reopen | Required |
| RM-49 | C7: cuts and actual sleep/wake | Required; actual sleep needs a suitable test window |
| RM-50 | C2: auto/manual/configured forwarding | Required, including reconnect and collision |
| RM-51 | C2: remote Node breakpoint/variables | Required |
| RM-52 | C1: real authentication modes | Host authentication fixtures required |
| RM-53 | C1: ProxyJump and ProxyCommand | Real jump host required |
| RM-54 | C6: concurrent windows/hosts | Required |
| RM-55 | C3: remote and connection/install settings | Required |
| RM-56 | C2/C3/C6: actual login shells and detection | Required per remote OS |
| RM-57 | C8: offline host and proxy download | Controlled download route required |
| RM-58 | C8: sshd container | Shares RM-22 evidence where identical |
| RM-59 | C8: unsupported arm64 and Alpine | Negative fixture required; must not hang |

## Results and exit criteria

Store each run under `.build/logs/remote-ssh-mac/<run-id>/`, inside the workspace. Keep the reviewed plan tracked; keep generated logs and screenshots out of commits. Preserve evidence after the run while cleaning disposable processes, accounts/VM fixtures and worktrees that the run created.

Each result records: case/subcase, candidate and artifact hashes, host and fixture identity, exact action/command, expected and observed outcomes, timestamps, screenshot/trace/log paths, relevant file hashes/Git refs, process PID plus start time, and status. Use PASS, FAIL, BLOCKED or NOT RUN; record out-of-scope cases separately. An accepted deviation requires the person's explicit words. Mask passwords, private keys and tokens in retained evidence.

Produce a machine-readable summary and a short report listing working paths, reproducible defects, blocked cases and cleanup verification. Keep installation findings separate from application execution. Never label environment preflight as feature acceptance.

Before reporting that Remote SSH works on Mac:

1. Pass C1/C2 on the packaged candidate with a matching real server, including automatic first install through a documented actual archive source.
2. Pass the workspace/worktree continuous journey and verify files, unsaved content, process identity and records after every preservation boundary.
3. Pass real vendor journeys for the advertised combinations, plus disconnect/reload/takeover/stop and no duplicate or late input.
4. Complete both Windows-host and Linux-host regressions from the Mac and report the actual two-target matrix. Missing required hosts, vendor authentication, sleep or network fixtures prevent a claim of comprehensive coverage. Deferred other-platform and second-computer checks remain explicit and cannot be called passed.
5. Retain the default public-download blocker until it is tested successfully with matching published assets; a manual install or mirror does not clear it.
6. Rerun failures after fixes, rerun the continuous journey on the final commit, and verify that cleanup leaves no test-owned processes or worktrees.

This macOS-client report is not the full cross-platform release gate in REMOTE.md, W19 or L14.

## Continuous observation helpers

`health.mjs` collects actual forwarded HTTP identities, real Facade MCP agent state, independent host process/heartbeat observations and read-only workbench state every minute. This is continuous monitoring, not completion of the full alternating UI/model soak cycle above. `reload-stress.mjs` separately drives real A/B folder switches, exact hidden dirty text, one tab per agent and Reload Window, checking original native process identity and actual HTTP recovery before and after every round. Its bounded30-second HTTP recovery window records transient attempts rather than mistaking the first request during reconnection for permanent failure. Failures in a driver require diagnosis; a nonzero driver exit is not automatically a product defect. Both scripts retain real evidence without replacing any product service or vendor CLI.

`network-batch.mjs` repeats real ten-second and one-minute socket cuts. Each round checks actual MCP, original native process/start identity and heartbeats before, during and after the interruption, actual forwarded HTTP recovery, and visible workspace rows. It does not replace model-task or full dirty-editor journeys. Requested repetitions become completed results only after their assertions finish. Create `network-batch.pause` and wait for `PAUSED-BETWEEN-CASES` before further GUI cases requiring stable SSH; remove the file when those cases finish.

The continuous helpers read actual target metadata from the campaign's private `soak-targets.json`. Optional self-checkpoint delivery uses private `notification.json` (`enabled`, installed `shim`, own `record`, and `argsFile` naming the actual MCP request). Tokens stay in the product's token files. Do not put credentials in either file or use a checkpoint to contact unrelated agents. Preserve the exact running worker source when editing a helper during an observation interval.
