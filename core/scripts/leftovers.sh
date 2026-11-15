#!/bin/sh
# Lists the processes a test run left behind, and exits 1 if there are any.
# Usage: leftovers.sh <the run's TMPDIR> [<core folder>]
# - A process working inside the TMPDIR, or whose environment names a Facade home or a home folder inside it, is the
#   run's: every scenario home and project, and every unit test's folder, is there. macOS shows no environment for its
#   own programs (/bin/sh, sleep), so the working folder is what finds a script.
# - A process working inside <core folder> whose parent is process 1 outlived the test program that started it: unit
#   tests run in their crate's folder.
# Works on macOS (lsof) and Linux (/proc).
cd / || exit 2
tmp=$1
real=$(cd "$tmp" 2>/dev/null && pwd -P) || { echo "no folder $tmp" >&2; exit 2; }
tree=""
[ -n "${2:-}" ] && { tree=$(cd "$2" 2>/dev/null && pwd -P) || { echo "no folder $2" >&2; exit 2; }; }

# Prints "pid folder" for every process of this user whose working folder can be read.
folders() {
	if [ -d /proc/self ]; then
		for p in /proc/[0-9]*; do
			f=$(readlink "$p/cwd" 2>/dev/null) && echo "${p#/proc/} $f"
		done
	else
		lsof -a -d cwd -u "$(id -u)" -Fpn 2>/dev/null | awk '/^p/ { p = substr($0, 2) } /^n/ { print p, substr($0, 2) }'
	fi
}

within() { awk -v d="$1" '{ f = substr($0, index($0, " ") + 1); if (f == d || index(f, d "/") == 1) print $1 }'; }

pids=$(
	{
		folders | within "$real"
		ps axeww -o pid=,command= | awk -v a="FACADE_HOME=$tmp" -v b="FACADE_HOME=$real" -v c="HOME=$tmp" -v d="HOME=$real" \
			'{ for (i = 2; i <= NF; i++) if (index($i, a) == 1 || index($i, b) == 1 || index($i, c) == 1 || index($i, d) == 1) { print $1; break } }'
		if [ -n "$tree" ]; then
			for p in $(folders | within "$tree"); do
				[ "$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" = 1 ] && echo "$p"
			done
		fi
	} | sort -un
)
left=$(for p in $pids; do ps -o pid=,ppid=,etime=,command= -p "$p" 2>/dev/null | cut -c1-200; done)
[ -z "$left" ] && { echo "no processes left"; exit 0; }
printf 'processes left:\n%s\n' "$left"
exit 1
