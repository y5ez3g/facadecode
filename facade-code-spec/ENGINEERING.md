# Engineering

How work happens in this repository.

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

Cut a new root commit at the new tag and merge it in:

```sh
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --no-tags refs/tags/<version>:refs/tags/<version>
TREE=$(git rev-parse refs/tags/<version>^{tree})
COMMIT=$(git commit-tree "$TREE" -m "vendor: import VS Code <version>")
git tag "vendor/<version>" "$COMMIT"
git merge --no-ff "$COMMIT"
```

⚠️ Do this as its own reviewed change, never mixed into a feature. Before starting, list
which upstream files this fork modifies and how many of them the new version touched -
that, not the version distance, is the size of the merge.

⚠️ One upstream file does not survive a naive re-import: `.config/1espt/PipelineAutobaseliningConfig.yml`
carries CRLF that `text=auto` normalises away on `git add`. Write it into the index with
`git hash-object -w --no-filters` so the tree stays byte-identical.

## Branch discipline

```
main              starts at the vendor root commit. Only --no-ff merges, and only after review
feature/<name>    every change branches from main, gets reviewed, then merges
```

⚠️ **Merge, never rebase.** Feature branches land with `--no-ff` so the history shows
where a feature began and ended.

⚠️ **Nothing reaches `main` without review.** Commit on the feature branch, ask, merge.

## Engineering rules

```
✓ vendor nothing; import it ourselves
✓ keep our files together, so merging upstream stays cheap
✓ in upstream files, add optional hooks - do not rewrite their logic
✓ every feature gets a switch, and off means stock VS Code
✓ every step lands with tests
✓ English everywhere: documents, comments, commit messages

✗ rebase
✗ merging to main without review
✗ building a git command as a shell string (use execFile with an argument array)
✗ any call site for rebase / reset --hard / push --force
```

## Working on it

```
node     24 (see .nvmrc); the preinstall check rejects other major versions
install  npm install
build    npm run transpile-client      fast, for iterating
run      ./scripts/code.sh --user-data-dir=<dir> --extensions-dir=<dir>
check    npm run valid-layers-check && npm run gulp -- hygiene
test     ./scripts/test.sh --grep <pattern>
```

⚠️ Run the fork through `./scripts/code.sh`, never the raw Electron binary. The script
sets `NODE_ENV=development` and `VSCODE_DEV=1`; without them the window comes up blank
with a misleading `nls.messages.json` ENOENT.

⚠️ `transpile-client` clears `out/` on every run. A stale `out/` only shows up on a cold
start, so do not diagnose a startup failure without one.
