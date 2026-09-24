# Worktrees in other products

What ten worktree implementations in eight shipping products do, on Windows, macOS and Linux, and what
that means for [`WORKTREE.md`](./WORKTREE.md). Read from their shipped code on 2026-09-23.

⚠️ **Facts, not code.** Claims below were read from each product's shipped JavaScript (or strings in
its compiled binaries) and are restated here as behaviour, setting names and user-facing strings. No
code from a closed-source product is copied into this repository.

---

## 1 What was read, and how

```
product                 version        what was read
Cursor                  3.21.18        Linux .deb (VS Code 1.128 base): workbench.glass, main, cursor-* extensions
Kiro                    1.1.14         Linux tarball (VS Code 1.131): main, workbench, kiro.kiro-agent
VS Code                 1.138.0        source, this repository: extensions/git, extensions/copilot,
                                       src/vs/platform/agentHost, src/vs/sessions
Claude Code CLI         2.1.281        Windows, Linux and macOS binaries, compared
Claude Desktop          2.2553.1.0     Windows app.asar
OpenAI Codex app        26.917.8451.0  Windows Store package, plus codex.exe 0.156.1 strings
Devin (was Windsurf)    3.10.35        Linux build + Windows zip; logic is in a Go language server
Google Antigravity IDE  2.5.5          Linux build + local agy.exe; logic is in a Go language server
Trae                    3.5.104        Linux build; logic is in workbench JavaScript
```

**Per platform.** VS Code-family products ship one JavaScript bundle to every OS, so the Linux build
contains the Windows and macOS branches (`process.platform === "win32"`, `isWindows`, `"darwin"`).
Each platform claim below was proved by finding the branch. Windows builds were also read directly
for Claude Code, Claude Desktop, Codex, Devin and Antigravity. Nothing was run.

---

## 2 The answer to "is it the same on every platform"

**Yes, almost entirely.** No product puts worktrees in a different place per OS, and no product
changes how it creates or copies per OS, with the exceptions below. The platform differences that
exist:

```
the setup script's shell     Windows: PowerShell (Cursor, Codex, Devin). macOS/Linux: bash or the
                             user's shell, usually with the login environment captured first.
                             Cursor, Codex and Devin each have separate per-OS keys in their config
copy-on-write                macOS only, and only in VS Code: @vscode/fs-copyfile clones with
                             fclonefileat on APFS. Everyone else - and VS Code on Windows and Linux -
                             copies every byte
path comparison              case-insensitive on Windows and macOS, exact on Linux (Cursor, Claude Code)
long paths                   Windows only, and handled by two of ten (§3.2)
links on removal             Windows only: Claude Code strips junctions and directory symlinks before
                             removing a worktree, after earlier versions deleted link targets
finding git                  Windows: `where` (Codex, Trae); others: PATH, or a list of install dirs
Windows device names         Codex rejects worktree names like `con`, `nul`, `com1` on every OS
macOS Spotlight              Codex writes `.metadata_never_index` into its worktrees root
Dev Drive                    Codex's `codex doctor` recommends moving worktrees onto a Windows Dev Drive
WSL                          Codex can run its agent inside WSL; worktrees then live in the distro
```

---

## 3 Product by product, by question

### 3.1 Where worktrees live

```
home directory      Cursor       ~/.cursor/worktrees/<workspace>/<4-char id>
(the majority)      Codex        ~/.codex/worktrees/<4 hex>/<repo>          configurable ("Worktree root")
                    Devin        ~/.windsurf/worktrees/<repo>/<name>-<8 hex>
                    Antigravity  ~/.gemini/antigravity-ide/worktrees/...
                    Trae         ~/.trae/worktrees/<workspace>/<branch>
beside the repo     VS Code      <parent>/<repo>.worktrees/<branch>         git extension and agent host
                    Kiro         <parent>/<branch>                          its New Worktree dialog
inside the repo     Claude Code  <repo>/.claude/worktrees/<name>            CLI: not configurable
                    Claude Desk. <repo>/.claude/worktrees/<name>            configurable
                    Kiro         <repo>/.worktrees/<branch>                 its (off by default) web portal
```

- Five of eight products use the home directory with a **short random id**, which also keeps paths
  short on Windows.
- In-repo placement is Claude Code's. The CLI does not exclude the directory itself - its docs tell
  people to add `.claude/worktrees/` to `.gitignore`. Claude Desktop writes it into
  `<common-dir>/info/exclude`.
- Kiro has three different defaults in three places, and on Windows its dialog pre-fills a path its
  own validation then rejects.
- Codex has an unreleased flag that moves the root to `%LOCALAPPDATA%\OpenAI\Codex\workspaces` on
  Windows - the only per-OS location seen anywhere.

### 3.2 Creating one

```
long paths (Windows)   Claude Desktop   -c core.longpaths=true on create, then enables
                                        extensions.worktreeConfig and sets `git config --worktree
                                        core.longpaths true`, so every later git call in it has it
                       Trae             on "Filename too long": `git config --local core.longpaths
                                        true` in the main repository, then retries
                       everyone else    nothing. (Cursor's -c core.longpaths=true is only for cloning
                                        plugin repositories, not worktrees)
Git LFS                Codex            filters disabled while creating: pointer files, no download
                       Claude Code      repository-local filter drivers neutralised
                       Claude Desk.     LFS filters disabled only when git-lfs is not on PATH
                       everyone else    whatever the person's git config does
git hooks              disabled         Cursor, Codex (hooksPath to the null device)
                       run              Claude Code, Claude Desktop (runs post-checkout itself), VS Code
starting point         HEAD             VS Code, Kiro, Antigravity, Trae (requires a clean tree)
                       origin/default   Claude Code ("fresh", the default; "head" is an option)
                       with your work   Cursor copies uncommitted and untracked files in; Devin creates
                                        the worktree from a snapshot commit of the working tree; Codex
                                        optionally applies the uncommitted diff
large repositories     Claude Code      worktree.sparsePaths: --no-checkout + sparse-checkout (cone)
                       Claude Desk.     checks out config files first, the rest in the background
```

### 3.3 Ignored files and dependencies

**Nobody copies, links or installs `node_modules` by default.** Three mechanisms exist instead.

**A. `.worktreeinclude` - becoming a shared convention.**

```
Claude Code    repo-root file, gitignore syntax: a file is copied only if it is BOTH ignored and
               matched. Found with `git ls-files --others --ignored --exclude-standard --directory`.
               Symlinks skipped. Plain copy
Codex          the same file name and meaning
Trae           the same file name; without one, copies .trae and .trae-cn
VS Code        not the file - a setting, git.worktreeIncludeFiles (globs):
                 git extension   ⚠️ bug: a pattern whose fixed base is the root (**/..., apps/*/...,
                                 even apps/web/.env) copies the tracked parent directory whole,
                                 carrying main's uncommitted edits in. No tests
                 agent host      correct: asks git which files are ignored, never overwrites a
                                 tracked path, has tests (agentHostGitService.ts)
               both copy with @vscode/fs-copyfile: APFS clone on macOS, plain copy elsewhere
```

**B. A setup script per repository, with per-OS variants.**

```
Cursor    .cursor/worktrees.json: setup-worktree | setup-worktree-unix | setup-worktree-windows
          (commands or a script path). Shell follows the person's default terminal: pwsh, then
          powershell, on Windows; zsh/bash with the login environment on macOS/Linux. Env
          ROOT_WORKTREE_PATH. 300 s. Failure does not block. Output: last 2 KB in the chat header
Codex     .codex/environments/environment.toml: setup.script, plus setup.win32 / .darwin / .linux,
          and a matching cleanup script. pwsh / powershell -File, falling back to cmd.exe, on
          Windows; bash with the login environment on macOS/Linux. Env CODEX_SOURCE_TREE_PATH and
          CODEX_WORKTREE_PATH. No timeout. Variables the script sets are kept for the agent's later
          shells. On failure: "Auto-fix" / "Continue anyway" / "Don't use worktree"
Devin     .devin/hooks.json (or .windsurf/hooks.json): post_setup_worktree. powershell -Command on
          Windows, bash -c elsewhere. Env ROOT_WORKSPACE_PATH. 10 minutes
VS Code   tasks with runOn: worktreeCreated. The main checkout's path is not given to them. The
          agent host flattens a task into one POSIX-quoted line, which PowerShell on Windows is
          unlikely to accept
none      Claude Code (docs: ask Claude to install), Kiro, Antigravity, Trae
```

**C. Linking, opt-in, one product.** Claude Code's `worktree.symlinkDirectories` (empty by default),
e.g. `["node_modules"]`, makes directory symlinks. On Windows that needs Developer Mode or admin; there
is no junction fallback, and a failure is only logged.

### 3.4 Removing and cleaning up

```
limits             Cursor 25 worktrees · 50 GB · every 6 h, least recently used first
                   Codex keeps 15 · Devin 20 per repository · Claude Code 30 days (background only)
                   Kiro, Antigravity, Trae, VS Code: none
before deleting    Codex saves a snapshot commit to refs/codex/snapshots/<id> - a deleted worktree
                   can be restored. Trae auto-commits dirty changes and closes terminals in it
Windows            Claude Code   removes junctions and directory symlinks first, without following
                                 them (its older versions deleted what the links pointed at)
                   Trae          on failure, renames to .deleting-<timestamp>, deletes in the
                                 background, runs prune
                   VS Code agent host   up to 5 attempts with back-off, prune, then confirms git no
                                        longer lists it
                   Cursor        `worktree remove --force`, then the workbench's own delete (moves
                                 to temp, 3 retries)
                   others        nothing
the branch         deleted     Claude Code, Devin, Antigravity, Trae (by default)
                   if merged   Cursor (only when it has no commits of its own; never main/master)
                   kept        VS Code, Codex, Kiro
```

### 3.5 How a worktree is shown

```
same window, agent surface   Cursor (Agent Window, its own workspace; language servers OFF for
                             worktrees by default), Antigravity, Trae, Codex (the app)
replaces workspace folder 0  VS Code Agents window - the same move Kumite made
a new window                 Kiro (hidden by default), Devin ("Open worktree", with its own
                             language server)
trust                        Cursor: trusted automatically. VS Code: inherited only inside
                             <repo>.worktrees. Kiro: never trusted
```

---

## 4 What this changes in WORKTREE.md

✅ **Decided 2026-09-24: not the best plan, the mainstream one - what most products do, least likely
to go wrong.** WORKTREE.md §2 is the result. Of the proposals below: ① location, ② `.worktreeinclude`
(implemented with two `git ls-files` calls rather than upstream's agent-host code), ③ setup (Cursor's
format, run in a visible terminal rather than upstream's tasks) and ⑤ LFS are in; the directory check
of ⑥ is in; ④ long paths and ⑦ limits are out. The proposals as they were written:

```
① location           WORKTREE.md §3 chose <repo>/.facade/worktrees. The majority - and every product
                     that, like this one, keeps worktrees as first-class rows - uses the home directory
                     with a short id. Proposal: ~/.facade/worktrees/<repo>/<name>. It removes the nested-
                     root problem (§3.1 of WORKTREE.md), leaves an existing repository's own tools
                     blind to it without writing to .git/info/exclude, and shortens Windows paths.
                     Cost: deleting a repository does not take its worktrees (limits, §3.4, answer that),
                     and trust has to be given - Cursor gives it automatically
② ignored files      Adopt .worktreeinclude - the same file Claude Code, Codex and Trae read, so one file
                     serves all of them. Implement it the way upstream's agent host does (git decides
                     what is ignored; nothing tracked is overwritten), not through the git extension's
                     git.worktreeIncludeFiles. Copy with @vscode/fs-copyfile: free on macOS
③ dependencies       Not the product's job - no product does it. A per-repository setup step with per-OS
                     variants, run in the worktree, given the main checkout's path, with a timeout,
                     non-blocking on failure, output visible. Upstream already has the vehicle: tasks
                     with runOn: worktreeCreated, and tasks.json already has per-OS overrides
                     ("windows" / "osx" / "linux"). Missing: the main checkout's path, and the Windows
                     quoting problem
④ long paths         Claude Desktop's way: create with -c core.longpaths=true on Windows, and set it
                     per worktree (git config --worktree), so every later git call in that worktree has
                     it - without touching the main repository's config beyond enabling
                     extensions.worktreeConfig
⑤ LFS                Codex's way: disable filters while creating, so LFS files arrive as pointers - which
                     is what this repository's own main checkout holds (WORKTREE.md §16.1)
⑥ removal on Windows Remove links first without following them (Claude Code), retry with back-off and
                     prune (VS Code agent host), then check the directory is gone (WORKTREE.md §16.6b)
⑦ limits             A count and a size cap with least-recently-used removal (Cursor, Codex, Devin), and
                     a snapshot ref before deleting (Codex)
```

What `node_modules` on this repository's own worktrees does then: it is this repository's setup step,
not product code. WORKTREE.md §16.5 already measured the candidate for it - a junction per directory,
made without Developer Mode, safe to delete, replaced by npm on the first install.
