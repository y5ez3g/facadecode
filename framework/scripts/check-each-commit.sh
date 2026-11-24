#!/bin/sh
# Checks every commit after <base> up to <head>: the whole workspace builds, all targets, and cargo leaves the
# commit's Cargo.lock as it is. Prints one line for each commit and exits 1 if any fails.
# Usage: scripts/check-each-commit.sh <base> [<head>]   (<head> is HEAD by default)
# Uses a temporary worktree with the Rust workspace selected from each commit and the extension sources its
# tests read. The worktree and its target folder are removed at the end.
set -u
base=$1
head=${2:-HEAD}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || exit 2
commits=$(git -C "$repo" rev-list --reverse "$base..$head") || exit 2
w=$(mktemp -d "${TMPDIR:-/tmp}/facade-each-commit.XXXXXX") || exit 2
# Sparse checkout enables worktreeConfig. Put the repository setting back after removing our worktree.
worktree_config=$(git -C "$repo" config --local --get extensions.worktreeConfig)
git -C "$repo" worktree add -q --detach --no-checkout "$w" "$head" || exit 2
cleanup() {
	git -C "$repo" worktree remove --force "$w"
	if [ -n "$worktree_config" ]; then
		git -C "$repo" config --local extensions.worktreeConfig "$worktree_config"
	else
		git -C "$repo" config --local --unset extensions.worktreeConfig
	fi
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM
export CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR="$w/target"
# rustup puts cargo here; a non-interactive shell may not have it on its PATH.
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
newline='
'
failed=0
for c in $commits; do
	line=$(git -C "$w" log -1 --format='%h %s' "$c")
	# Workspace manifests declare [workspace]; crate manifests live below the product folder.
	manifest=$(git -C "$w" grep -l '^\[workspace\][[:space:]]*$' "$c" -- \
		Cargo.toml ':(glob)*/Cargo.toml')
	case "$manifest" in
		''|*"$newline"*)
			echo "FAIL $line: expected one Rust workspace manifest"
			failed=1
			continue
			;;
	esac
	manifest=$(dirname "${manifest#*:}")
	if ! git -C "$w" sparse-checkout set "$manifest" extension/src/base ||
		! git -C "$w" checkout -q -f --detach "$c"; then
		echo "FAIL $line: checkout failed"
		failed=1
		continue
	fi
	if (cd "$w/$manifest" && cargo check -q --workspace --all-targets > "$w/check.log" 2>&1); then
		built=yes
	else
		built=no
	fi
	lock=$(git -C "$w" status --porcelain -- "$manifest/Cargo.lock")
	if [ "$built" = yes ] && [ -z "$lock" ]; then
		echo "ok   $line"
	else
		echo "FAIL $line: builds=$built, Cargo.lock changed=$([ -z "$lock" ] && echo no || echo yes)"
		grep -m 5 -E "^error" "$w/check.log"
		failed=1
	fi
	git -C "$w" checkout -q -- "$manifest/Cargo.lock" 2>/dev/null
done
exit $failed
