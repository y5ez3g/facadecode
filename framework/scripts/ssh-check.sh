#!/bin/sh
# Checks that agents outlive the SSH login that started them, over real ssh to this machine, with the test CLI:
#   1. a login starts an agent, sees its screen, detaches with Ctrl-], and ends normally;
#   2. a second login starts another agent and types into it, then drops: its ssh client is killed while attached;
#   3. a new login finds both running, attaches to the second, sees its screen as it was, and types into it;
#   4. once both are stopped, the daemon and the keeper exit by themselves.
# Usage: scripts/ssh-check.sh [<ssh destination>]   (localhost by default)
# Run it on a Linux machine whose sshd lets this user in by key, without a prompt. The local side needs no terminal:
# `ssh -tt` gives each login one. It builds the programs with debug assertions, which have the test CLI's rule.
# An isolated SSH lab can set FACADE_SSH_CHECK_BIN to the absolute path of these prebuilt programs.
# It uses a new Facade home in a temporary folder. Prints one line for each step and exits 1 if one fails; the temporary
# folder, with each login's output, then stays for a look.
set -u
# A login that ends early makes a write to its keys fail, not end this script.
trap '' PIPE
dest=${1:-localhost}
framework=$(cd "$(dirname "$0")/.." && pwd -P) || exit 2
unset FACADE_AGENT FACADE_CODE_SESSION_FILE FACADE_HOME
if [ -n "${FACADE_SSH_CHECK_BIN:-}" ]; then
	case "$FACADE_SSH_CHECK_BIN" in /*) bin=$FACADE_SSH_CHECK_BIN ;; *) exit 2 ;; esac
	for program in facade facade-mcp facade-fakecli; do
		[ -x "$bin/$program" ] || { echo "no test program $bin/$program" >&2; exit 2; }
	done
else
	# rustup puts cargo here; a non-interactive shell may not have it on its PATH.
	[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
	cd "$framework" || exit 2
	cargo build --quiet -p facade -p facade-relay -p facade-scenarios \
		--bin facade --bin facade-mcp --bin facade-fakecli || exit 2
	bin=${CARGO_TARGET_DIR:-$framework/target}/debug
fi
if ! out=$(ssh -o BatchMode=yes "$dest" true 2>&1); then
	echo "cannot log in to $dest by key without a prompt: $out" >&2
	exit 2
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/facade-ssh-check.XXXXXX") || exit 2
home=$tmp/home
socket=/tmp/facade-framework-$(id -u)/daemon-$(printf %s "$home" | sha256sum | cut -c1-10).sock
# What every login runs first: this home and these programs, in a terminal of 24 rows and 80 columns.
login="cd '$tmp' && export FACADE_HOME='$home' PATH='$bin':\"\$PATH\" && unset FACADE_AGENT &&
	{ stty rows 24 cols 80 2>/dev/null; true; } &&"
export TERM=xterm-256color
failed=0
ok() { echo "ok   $1"; }
fail() {
	echo "FAIL $1"
	failed=1
}

# Facade as this script runs it here; only the logins start its services.
facade() { FACADE_HOME=$home "$bin/facade" "$@"; }

# Waits up to 20 seconds for <agent>'s screen to show <text>, once the login has started the daemon.
shows() {
	i=0
	while [ "$i" -lt 100 ]; do
		[ -S "$socket" ] && facade screen "$1" --lines 30 2>/dev/null | grep -qF "$2" && return 0
		sleep 0.2
		i=$((i + 1))
	done
	return 1
}

# Opens a login that runs <command>. Its keys are what this script writes to descriptor 3, and its output goes to
# $tmp/<name>.out.
open_login() {
	rm -f "$tmp/keys" && mkfifo "$tmp/keys" || exit 2
	ssh -tt -o BatchMode=yes "$dest" "$login $2" < "$tmp/keys" > "$tmp/$1.out" 2>&1 &
	ssh_pid=$!
	exec 3> "$tmp/keys"
}

# Waits for the login's own terminal to render the text, which can arrive after the daemon has it.
login_shows() {
	i=0
	while :; do
		[ -f "$tmp/$1.out" ] && grep -qF "$2" "$tmp/$1.out" && return 0
		[ "$i" -lt 100 ] && kill -0 "$ssh_pid" 2>/dev/null || return 1
		sleep 0.2
		i=$((i + 1))
	done
}

# Waits up to 10 seconds for the login's ssh client to end, and returns its exit code.
login_ends() {
	(sleep 10 && kill "$ssh_pid" 2>/dev/null) &
	timer=$!
	wait "$ssh_pid" 2>/dev/null
	code=$?
	kill "$timer" 2>/dev/null
	exec 3>&-
	return "$code"
}

# 1. Start an agent, see its screen, detach.
open_login one "facade start --name one fake"
if shows one "❯" && login_shows one "❯"; then
	printf '\035' >&3
	if login_ends && grep -qF "Detached from one (" "$tmp/one.out"; then
		ok "1 a login started one, showed its screen, detached with Ctrl-] and ended"
	else
		fail "1 the login of one did not detach and end normally after Ctrl-]: see $tmp/one.out"
	fi
else
	fail "1 the daemon or the SSH terminal did not show one's input box: see $tmp/one.out"
	kill "$ssh_pid" 2>/dev/null
	login_ends
fi

# 2. Another agent, typed into; then the login drops.
open_login two "facade start --name two fake"
if shows two "❯" && printf 'typed before the drop' >&3 && shows two "typed before the drop"; then
	kill -9 "$ssh_pid"
	login_ends
	ok "2 a login started two, typed into it, and was killed while attached"
else
	fail "2 two never showed what was typed: see $tmp/two.out"
	kill "$ssh_pid" 2>/dev/null
	login_ends
fi

# 3. Log in again: both run; two's screen is as it was, and typing reaches it.
if ssh -o BatchMode=yes "$dest" "$login facade list" > "$tmp/list.out" 2> "$tmp/list.err" &&
	awk '
		NR == 1 && $1 == "NAME" && $2 == "REFERENCE" { header = 1 }
		$1 == "one" && $2 ~ /^a[0-9]+@[^[:space:]]+$/ { one = $2 }
		$1 == "two" && $2 ~ /^a[0-9]+@[^[:space:]]+$/ { two = $2 }
		END { exit !(header && NR == 3 && one && two && one != two) }
	' "$tmp/list.out"; then
	ok "3 a new login lists one and two running"
else
	fail "3 a new login does not list one and two running: see $tmp/list.out and $tmp/list.err"
fi
open_login three "facade attach two"
if login_shows three "typed before the drop" && printf ', and after' >&3 && shows two "typed before the drop, and after"; then
	printf '\035' >&3
	if login_ends; then
		ok "3 attaching to two showed its screen as it was, and typing reached it"
	else
		fail "3 the login attached to two did not end after Ctrl-]: see $tmp/three.out"
	fi
else
	fail "3 attaching to two did not show its old screen, or typing did not reach it: see $tmp/three.out"
	kill "$ssh_pid" 2>/dev/null
	login_ends
fi

# 4. Stop both; the daemon exits 30 seconds after its last agent and client, and the keeper with it.
ssh -o BatchMode=yes "$dest" "$login facade stop one && facade stop two" > "$tmp/stop.out" 2>&1 ||
	fail "4 stopping one and two failed: see $tmp/stop.out"
i=0
while [ "$i" -lt 225 ]; do
	[ ! -e "$socket" ] && "$framework/scripts/leftovers.sh" "$tmp" > "$tmp/left.out" 2>&1 && break
	sleep 0.2
	i=$((i + 1))
done
if [ ! -e "$socket" ] && "$framework/scripts/leftovers.sh" "$tmp" > "$tmp/left.out" 2>&1; then
	ok "4 after the stops, the daemon and the keeper exited within 45 seconds"
else
	fail "4 the daemon or the keeper still runs 45 seconds after the stops: see $tmp/left.out"
fi

if [ "$failed" -eq 0 ]; then
	rm -rf "${tmp:?}"
	exit 0
fi
echo "kept $tmp"
exit 1
