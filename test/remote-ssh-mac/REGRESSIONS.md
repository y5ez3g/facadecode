# Regressions found by the real Mac SSH campaign

These are real packaged clients, actual OpenSSH servers, actual vendor CLIs and independently observed host processes. No test double establishes an acceptance result. The live campaign's ignored evidence directory contains the observations, screenshots and process logs. A fix is pending until its packaged build passes the same journey.

## Windows startup deadline

Baseline `0a951f4a` failed its first automatic server start. A warm retry connected. The old resolver gave the server approximately three seconds to announce its port.

For a reproducible timing comparison, `windows-delay-startup.ps1` delays the task-owned real launcher by five seconds and then calls its original bytes with the original arguments. The backend, SSH connection and response protocol remain real. The original client failed; `886be375` connected with the same delay. Restore verifies the original launcher's SHA-256. Repeat normal installation and reconnect separately, with the launcher restored.

## A live Windows agent lost after Reload Window

Candidate `886be375`, Mac arm64 to actual Windows OpenSSH:

1. Open repository A and trust it. Launch Codex from the Agent menu and complete a real file task.
2. Add B through Add Folder to Workspace; wait for automatic reconnection. Confirm A's agent kept its original PID and can exchange real Facade messages.
3. Select B, launch another Codex, skip its vendor update prompt and complete another real file task. Run a real HTTP server in B's terminal.
4. Select A, edit `sentinel.txt` without saving, select B, then Reload Window. Include a run that reloads promptly after the folder's Explorer appears.
5. Return to A and verify the exact hidden dirty contents; inspect both agents through actual MCP and independently check their host PIDs.

Observed failure: A's agent remained running. B's agent was marked lost with `its terminal was missing when Facade restarted`, although its actual Codex process was still alive. The host's `ptyhost.log` recorded a successful attach of persistent terminal 7 followed 53 ms later by another attach refused as another window's process. The client logged `This agent is running in another window`. Both restores belonged to the same test window. The task-owned process required separate cleanup; an ended record must not be mistaken for proof the process exited.

The fix reuses this window's already restored instance when an agent editor working set names the same persistent process. Background and panel layout restore also skip an instance already restored in this window. Matching includes the backend authority, record and agent number. The existing guard against attaching another window's agent remains in effect.

Qualification requires repeated stable and rapid folder-switch/reload journeys on both hosts, one tab per agent, the same real process IDs, working messages and terminal input, and retained hidden unsaved contents. A second window must continue to keep its own agents. Compilation alone is not qualification.

Packaged `576ddeea` completed twenty full A/B switch-and-reload rounds on each actual host. Every round checked exact hidden dirty text, one editor tab per agent, both real MCP connections, original native agent and HTTP process identity (including start ticks/time), and real forwarded HTTP recovery within thirty seconds. Four actual model replies after the first reload also verified each folder and file's bytes. Evidence is `reload-20-576-f1/results.json` in the campaign directory. The driver checks real host state before reloading; this is steady operation evidence. Faster overlapping focus changes and second-window ownership remain separate qualification work.

## Worktree deletion ordering still under observation

On Ubuntu, a real agent, a real HTTP server and a dirty editor were named in one Delete Worktree confirmation. Cancel retained them; confirming stopped the agent, deleted the directory and preserved its branch. One 20 ms process observation sampled the HTTP child as alive at the directory-removal boundary; a later independent check found it exited. That sample read process status before directory status and does not establish an atomic ordering. Repeat with directory status read first and observation continuing after deletion before claiming that terminal shutdown finishes before removal.

## Windows worktree deletion blocked by existing workspace records

Packaged `576ddeea` created a real Windows worktree, an actual Node terminal program and Codex agent 50, whose real file task was independently verified. The actual Delete Worktree operation refused before confirmation because existing user records `53c33dd1` and `d7d3fae8` did not answer. The first record's PID belonged to an unrelated OpenConsole process; the second belonged to the user's existing installed Facade. Neither process was a campaign process. No record was edited and no existing user process was closed to bypass this gate. Deletion and Cancel are uncompleted on this host. Actual `stop_agent` separately ended native agent 50, and later MCP-started agent 51, without ending the other terminal or removing the worktree.

## Input and driver observations

Agent 50's first real `type_text` reported pasted text and Enter, but its terminal remained at the unsubmitted task. An independent file check found no output. One explicit Enter after inspecting that screen submitted it and the real model task completed. This timing observation needs repetition; a later successful MCP initial-task journey does not clear it.

Upstream menu items deliberately enable mouse-up activation after 100 ms. The UI driver must allow that guard or use actual keyboard activation. Windows can replace a terminal's accessible name with an environment notice; identify its selected editor tab before using its textbox. Selecting an already selected Explorer activity tab can hide the sidebar. These are driver constraints, not acceptance passes or proof that an underlying operation failed. Settings inputs save after a debounce; independently confirm the actual remote file before closing the modal when a case requires persistence.

Opening a terminal in an untrusted folder can expose its textbox before the trust prompt appears. In the real ProxyJump Windows run, input sent at that point did not execute before trust. After Trust Folder & Continue, the queued command executed in the newly started PowerShell process; it was not resent. Check the real dialog and filesystem before classifying a missing result or sending input again.

## Repository checks

The real runners use native Node 24 TypeScript and a strict standalone type check. The changed files pass ESLint and staged hygiene; the required layer and CSS checks pass. Full-repository hygiene still reports formatting in `extensions/facade-agents/src/core/mail.ts` and `src/vs/workbench/contrib/facadeCommands/test/browser/facadeCommands.test.ts`. Both files are unchanged from the pulled `0a951f4a` baseline. This is a separate validation limit, not evidence that the full check passed.
