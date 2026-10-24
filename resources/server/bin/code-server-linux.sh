#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
#

# Facade Code: in a session of its own, its input nothing, so that what started it can end without taking it along - the
# WSL extension's wsl.exe ends with the window's extension host, and its terminals and agents with it. Started in the
# background of a script, this is no process group leader: setsid does not fork, and the extensions, which find a running
# server by this process's id and command, still do (REMOTE.md R6)
if [ -z "$FACADE_SERVER_SESSION" ] && command -v setsid > /dev/null 2>&1; then
	FACADE_SERVER_SESSION=1 exec setsid "$0" "$@" < /dev/null
fi
unset FACADE_SERVER_SESSION

case "$1" in
	--inspect*) INSPECT="$1"; shift;;
esac

ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"

# Set rpath before changing the interpreter path
# Refs https://github.com/NixOS/patchelf/issues/524
if [ -n "$VSCODE_SERVER_CUSTOM_GLIBC_LINKER" ] && [ -n "$VSCODE_SERVER_CUSTOM_GLIBC_PATH" ] && [ -n "$VSCODE_SERVER_PATCHELF_PATH" ]; then
	echo "Patching glibc from $VSCODE_SERVER_CUSTOM_GLIBC_PATH with $VSCODE_SERVER_PATCHELF_PATH..."
	"$VSCODE_SERVER_PATCHELF_PATH" --set-rpath "$VSCODE_SERVER_CUSTOM_GLIBC_PATH" "$ROOT/node"
	echo "Patching linker from $VSCODE_SERVER_CUSTOM_GLIBC_LINKER with $VSCODE_SERVER_PATCHELF_PATH..."
	"$VSCODE_SERVER_PATCHELF_PATH" --set-interpreter "$VSCODE_SERVER_CUSTOM_GLIBC_LINKER" "$ROOT/node"
	echo "Patching complete."
fi

"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" "$@"
