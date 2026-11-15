#!/bin/sh
# Runs every test of the workspace in an empty temporary folder of its own, then lists any process the run left behind
# and anything a test wrote to the home folder.
# Usage: scripts/test-all.sh [<log>]
# The tests run with HOME in the temporary folder and no FACADE_HOME, so a test that writes to the person's home
# folder, as to `~/.facade`, writes there instead and is reported; cargo and rustup keep their own folders. The log,
# target/test-all.log by default, gets the commit, cargo's exit code, how many tests passed and failed, the first
# failures, what was written to the home folder, and the leftover check; <log>.full gets cargo's whole output. Exits 1
# when a test failed, a test wrote to the home folder, or a process was left; the temporary folder then stays for a
# look.
set -u
core=$(cd "$(dirname "$0")/.." && pwd -P) || exit 2
log=${1:-$core/target/test-all.log}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/facade-test-all.XXXXXX") || exit 2
unset FACADE_AGENT FACADE_CODE_SESSION_FILE FACADE_HOME
# rustup puts cargo here; a non-interactive shell may not have it on its PATH.
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" CARGO_INCREMENTAL=0
# Git keeps reading the person's own settings, such as the name its commits carry.
[ -z "${GIT_CONFIG_GLOBAL:-}" ] && [ -f "$HOME/.gitconfig" ] && export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
mkdir -p "$tmp/home"
cd "$core" || exit 2
mkdir -p "$(dirname "$log")"
echo "== start $(date '+%Y-%m-%d %H:%M') $(git rev-parse --short HEAD) changed-files=$(git status --porcelain -- . | wc -l | tr -d ' ')" > "$log"
HOME=$tmp/home TMPDIR=$tmp cargo test -q --workspace --no-fail-fast > "$log.full" 2>&1
tests=$?
echo "tests exit $tests" >> "$log"
grep -E "^test result" "$log.full" | awk '{ p += $4; f += $6 } END { print "passed", p, "failed", f }' >> "$log"
grep -E "^---- " "$log.full" | head -20 >> "$log"
written=$(cd "$tmp/home" && find . -mindepth 1 | head -20)
if [ -n "$written" ]; then
	printf 'written to the home folder:\n%s\n' "$written" >> "$log"
else
	echo "nothing written to the home folder" >> "$log"
fi
"$core/scripts/leftovers.sh" "$tmp" "$core" > "$log.left" 2>&1
left=$?
head -20 "$log.left" >> "$log"
rm -f "$log.left"
echo "== end $(date '+%Y-%m-%d %H:%M')" >> "$log"
cat "$log"
if [ "$tests" -eq 0 ] && [ -z "$written" ] && [ "$left" -eq 0 ]; then
	rm -rf "${tmp:?}"
	exit 0
fi
echo "kept $tmp"
exit 1
