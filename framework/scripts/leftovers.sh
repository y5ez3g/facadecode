#!/bin/sh
# Lists the processes a test run left behind, and exits 1 if there are any.
# Usage: leftovers.sh <the run's TMPDIR> [<framework folder>]
# - A process working inside the TMPDIR, or whose environment names a home, scratch or portable directory inside it,
#   belongs to the run. macOS shows no environment for its own programs (/bin/sh, sleep); the working folder finds a script.
# - A process working inside <framework folder> whose parent is process 1 outlived the test program that started it: unit
#   tests run in their crate's folder.
# Works on macOS (lsof) and Linux (/proc).
cd / || exit 2
tmp=$1
real=$(cd "$tmp" 2>/dev/null && pwd -P) || { echo "no folder $tmp" >&2; exit 2; }
tree=""
[ -n "${2:-}" ] && { tree=$(cd "$2" 2>/dev/null && pwd -P) || { echo "no folder $2" >&2; exit 2; }; }

fail() { printf '%s\n' "$1" >&2; exit 2; }

# Prints "pid folder" for every process of this user whose working folder can be read.
folders() {
	if [ -d /proc/self ]; then
		for p in /proc/[0-9]*; do
			f=$(readlink "$p/cwd" 2>/dev/null) && echo "${p#/proc/} $f"
		done
		return 0
	else
		listing=$(lsof -a -d cwd -u "$(id -u)" -Fpn 2>/dev/null) || return 2
		printf '%s\n' "$listing" | awk '/^p/ { p = substr($0, 2) } /^n/ { print p, substr($0, 2) }'
	fi
}

within() { awk -v d="$1" '{ f = substr($0, index($0, " ") + 1); if (f == d || index(f, d "/") == 1) print $1 }'; }

snapshot=$(folders) || fail 'could not inspect process folders'
processes=$(ps axeww -o pid=,ppid=,command=) || fail 'could not read the process table'
[ -n "$processes" ] || fail 'the process table was empty'
folder_pids=$(printf '%s\n' "$snapshot" | within "$real") || fail 'could not match process folders'
environment_pids=$(printf '%s\n' "$processes" | awk -v tmp="$tmp" -v real="$real" '
	function inside(value, dir) { return value == dir || index(value, dir "/") == 1 }
	NF == 0 { next }
	$1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ { exit 2 }
	{
		for (i = 3; i <= NF; i++) {
			if ($i !~ /^(CI_ACCEPTANCE_ROOT|FACADE_HOME|HOME|TMPDIR|VSCODE_PORTABLE|XDG_RUNTIME_DIR)=/) continue
			value = substr($i, index($i, "=") + 1)
			if (inside(value, tmp) || inside(value, real)) { print $1; break }
		}
	}') || fail 'could not decode the process table'
orphans=""
if [ -n "$tree" ]; then
	tree_pids=$(printf '%s\n' "$snapshot" | within "$tree") || fail 'could not match the Facade Code Framework checkout'
	tree_pids=$(printf '%s' "$tree_pids" | tr '\n' ' ') || fail 'could not prepare the Facade Code Framework process IDs'
	orphans=$(printf '%s\n' "$processes" | awk -v pids="$tree_pids" '
		BEGIN {
			count = split(pids, list, " ")
			for (i = 1; i <= count; i++) in_checkout[list[i]] = 1
		}
		$2 == 1 && ($1 in in_checkout) { print $1 }
	') || fail 'could not match Facade Code Framework processes by parent'
fi
pids=$(printf '%s\n' "$folder_pids" "$environment_pids" "$orphans" | sort -un) ||
	fail 'could not collect the remaining process IDs'
[ -z "$pids" ] && { echo "no processes left"; exit 0; }
printf 'processes left:\n'
for p in $pids; do
	details=$(ps -o pid=,ppid=,etime=,command= -p "$p" 2>/dev/null) || details="$p (exited or details unavailable)"
	printf '%s\n' "$details" | cut -c1-200
done
exit 1
