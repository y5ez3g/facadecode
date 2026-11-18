#!/bin/sh
# Checks every commit after <base> up to <head>: the whole workspace builds, all targets, and cargo leaves the
# commit's Cargo.lock as it is. Prints one line for each commit and exits 1 if any fails.
# Usage: scripts/check-each-commit.sh <base> [<head>]   (<head> is HEAD by default)
# Works in a temporary worktree, which checks out only core/ and the file its tests read from extension/, with a
# target folder of its own, and removes it at the end.
set -u
base=$1
head=${2:-HEAD}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || exit 2
commits=$(git -C "$repo" rev-list --reverse "$base..$head") || exit 2
w=$(mktemp -d "${TMPDIR:-/tmp}/facade-each-commit.XXXXXX") || exit 2
# git sparse-checkout sets extensions.worktreeConfig in the repository's own config, which other programs may refuse;
# the end puts it back as it was.
worktree_config=$(git -C "$repo" config --local --get extensions.worktreeConfig)
git -C "$repo" worktree add -q --detach --no-checkout "$w" "$head" || exit 2
git -C "$w" sparse-checkout set core extension/src/base || exit 2
export CARGO_INCREMENTAL=0
# rustup puts cargo here; a non-interactive shell may not have it on its PATH.
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
failed=0
for c in $commits; do
	line=$(git -C "$w" log -1 --format='%h %s' "$c")
	if ! git -C "$w" checkout -q -f --detach "$c"; then
		echo "FAIL $line: checkout failed"
		failed=1
		continue
	fi
	if (cd "$w/core" && cargo check -q --workspace --all-targets > "$w/check.log" 2>&1); then
		built=yes
	else
		built=no
	fi
	lock=$(git -C "$w" status --porcelain -- core/Cargo.lock | wc -l | tr -d ' ')
	if [ "$built" = yes ] && [ "$lock" = 0 ]; then
		echo "ok   $line"
	else
		echo "FAIL $line: builds=$built, Cargo.lock changed=$([ "$lock" = 0 ] && echo no || echo yes)"
		grep -m 5 -E "^error" "$w/check.log"
		failed=1
	fi
	git -C "$w" checkout -q -- core/Cargo.lock 2>/dev/null
done
git -C "$repo" worktree remove --force "$w"
if [ -n "$worktree_config" ]; then
	git -C "$repo" config --local extensions.worktreeConfig "$worktree_config"
else
	git -C "$repo" config --local --unset extensions.worktreeConfig
fi
exit $failed
