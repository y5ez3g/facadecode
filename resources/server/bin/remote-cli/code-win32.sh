#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
#
ROOT="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"

# Git Bash and MSYS2 have cygpath; a shell without it, WSL's through the host's PATH among them, cannot reach the window
if ! command -v cygpath > /dev/null 2>&1; then
	echo "@@APPNAME@@: this shell cannot open files in the window; run @@APPNAME@@ in PowerShell, cmd or Git Bash" >&2
	exit 1
fi

APP_NAME="@@APPNAME@@"
VERSION="@@VERSION@@"
COMMIT="@@COMMIT@@"
EXEC_NAME="@@APPNAME@@"
CLI_SCRIPT="$(cygpath -m "$ROOT/out/server-cli.js")"
"$ROOT/node.exe" "$CLI_SCRIPT" "$APP_NAME" "$VERSION" "$COMMIT" "$EXEC_NAME" "$@"
