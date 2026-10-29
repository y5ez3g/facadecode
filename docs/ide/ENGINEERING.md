# Engineering

How work happens on the IDE in this repository.

## Repository layout

The Git repository root contains `ide/`, `extension/` and shared documentation under `docs/ide/` and
`docs/extension/`. The standalone extension directories are reserved for the owner to populate. The IDE's current
built-in agent implementation remains in `ide/extensions/facade-agents/`; this directory reorganization does not replace it.

The repository root holds the product README. Translated README, contribution and security documents live in
`docs/locales/`; only runtime translation JSON belongs in `ide/locales/`.

Run the IDE's npm, build, test and release commands from `ide/`. Paths such as `src/`, `build/`, `scripts/`, `.build/`
and `extensions/` in IDE engineering documents are relative to that directory unless stated otherwise. Open `ide/`
as the editor folder to use its `.vscode/`, `.devcontainer/` and development instructions. GitHub workflows
and shared contribution/security guidance stay at the Git repository root.
The IDE's `.editorconfig` lives in `ide/`. Repository-wide `.gitattributes` stays at the outer root so the shared
license and IDE files retain their line-ending rules. It preserves the imported pipeline configuration's CRLF bytes
without normalization. Shared Git metadata, repository guidance and GitHub configuration remain at the outer root.

The root `.github/` keeps installation-check workflows, issue templates and agent instructions. Upstream triage bots,
reviewer assignments and the old pull request template are removed. Dependency upgrades are initiated by maintainers.

The IDE build keeps its license beside `ide/package.json` for packaging; keep that copy identical to the shared
root `LICENSE.txt`. Build version lookup finds the enclosing checkout's `.git`, including from a linked worktree.
Specification acceptance reads `../docs/ide/` while source/test discovery remains relative to `ide/`.

## History

```
root commit   vendor: import VS Code 1.138.0
              tree byte-identical to upstream tag 1.138.0
              tagged vendor/1.138.0
```

⚠️ **The root commit carries no upstream history behind it**, so `git log` shows only
this fork's own work and the repository stays small (135 MB rather than 422 MB).
Upstream is not configured as a remote by default; add it when you need to diff.

### Moving to a newer upstream

The historical vendor tags describe upstream's original root layout. The live IDE now sits under `ide/`, so do not
merge a fresh upstream root directly into the outer repository: that would recreate `src/`, `build/` and `extensions/`
beside the two products.

Compare the previous vendor snapshot with the new upstream version and apply its IDE-relative changes beneath `ide/`
on an update feature branch. A path-scoped Git patch can be applied from the repository root with
`git apply --3way --directory=ide`; review the patch's paths before applying it. Root GitHub workflows and shared
repository/legal files are reconciled separately because their locations differ from the upstream layout. Preserve
`extension/` and `docs/` at the outer root. Keep the vendor snapshot/tag in the original upstream layout for the next
comparison, record the imported version and land the reviewed update through the normal feature-branch merge.

⚠️ Do this as its own reviewed change, never mixed into a feature. Before starting, list
which upstream files this fork modifies and how many of them the new version touched -
that, not the version distance, is the size of the merge.

⚠️ Preserve source bytes during import. In particular, `ide/.config/1espt/PipelineAutobaseliningConfig.yml` carries
CRLF; line-ending normalization must not silently change an imported vendor snapshot.

## Branch discipline

```
main                       starts at the vendor root commit. Only --no-ff merges, and only after review
feature/<number>-<name>     every change branches from main, gets reviewed, then merges
```

Use the next unused feature number after checking local and remote branches, for example
`feature/63-repository-layout`. The number belongs to the branch sequence, not the pull request number.

⚠️ **Merge, never rebase.** Feature branches land with `--no-ff` so the history shows
where a feature began and ended.

⚠️ **Nothing reaches `main` without review.** Commit on the feature branch, ask, merge.

## Engineering rules

```
✓ vendor nothing; import it ourselves
✓ keep our files together, so merging upstream stays cheap
✓ in upstream files, add optional hooks - do not rewrite their logic
✓ every feature gets a switch, and off means stock VS Code - except the workspace,
  which is the product: its off state is VS Code itself (WORKSPACE.md W18)
✓ every step lands with tests
✓ English everywhere: documents, comments, commit messages

✗ rebase
✗ merging to main without review
✗ building a git command as a shell string (use execFile with an argument array)
✗ any call site for rebase / reset --hard / push --force
```

## Working on it

From the repository root, first run `cd ide`. The commands below use the IDE project as their working directory.

```
node     24 (see .nvmrc); the preinstall check rejects other major versions
install  npm install
build    npm run transpile-client      fast, for iterating on src/
run      ./scripts/code.sh --user-data-dir=<dir> --extensions-dir=<dir>
check    npm run valid-layers-check && npm run stylelint && npm run gulp -- hygiene
test     ./scripts/test.sh --grep <pattern>
release  npm run release-mac           a notarized .dmg; setup in RELEASE.md
         npm run release-win           a signed installer; setup in RELEASE.md
         three gulp tasks              an unsigned .deb; steps and setup in RELEASE.md
```

`stylelint` is the one that is easy to forget and the only one that knows about CSS. It
carries rules that exist because of a measured regression - `build/lib/stylelint/` rejects
root-anchored `:has()`, which made Blink re-evaluate the selector on every DOM mutation in
the workbench (#327052) - so a change that only touches a `.css` file still has to run it.

### ⚠️ Two steps a fresh clone needs that `transpile-client` does not do

Run these once after `npm install`, or the application comes up looking broken in a
way that has nothing to do with the code:

```sh
cp node_modules/@vscode/codicons/dist/codicon.ttf src/vs/base/browser/ui/codicons/codicon/
npm run gulp compile-extensions
```

Without the first, **every icon in the window renders as an empty box**. `codicon.ttf` is
gitignored upstream and is never in any commit; it is copied out of `node_modules` by
`build/lib/compilation.ts` and `build/gulpfile.editor.ts`, which are on the `npm run
compile` path. `transpile-client` skips that path, and `postinstall` does not do it
either.

Without the second, the built-in extensions are not compiled and the window fills with
`Activating extension 'vscode.git-base' failed: Cannot find module ...` notifications.

Both symptoms look like a broken checkout or a bad commit, and neither is. Check these
before diagnosing anything else.

⚠️ Run the fork through `./scripts/code.sh`, never the raw Electron binary. The script
sets `NODE_ENV=development` and `VSCODE_DEV=1`; without them the window comes up blank
with a misleading `nls.messages.json` ENOENT.

⚠️ `transpile-client` clears `out/` on every run. A stale `out/` only shows up on a cold
start, so do not diagnose a startup failure without one.

## Change log

- 2026-10-29: Made the existing numbered feature-branch convention explicit in repository guidance.
- 2026-10-29: Moved translated documentation under `docs/locales/`, removed the duplicate IDE README, obsolete research
  notes and empty report directory, and repaired the root README's paths. Runtime translations and packaging files
  stay with the IDE.
- 2026-10-29: Named the standalone product directories `extension/` and `docs/extension/` in the singular.
- 2026-10-29: Removed upstream GitHub automation, reviewer assignments, the old pull request template and Dependabot
  configuration; retained Facade's installation checks, issue templates and agent instructions.
- 2026-10-29: Moved IDE formatting rules into `ide/`; kept Git attributes at the outer root to preserve shared
  license and upstream source bytes when staging moved files. Restored the original outer README content.
- 2026-10-29: Moved the IDE project into `ide/` and its specifications into `docs/ide/`, reserved the standalone
  extension directories, and adjusted build/Git/spec paths without changing IDE product behavior.
