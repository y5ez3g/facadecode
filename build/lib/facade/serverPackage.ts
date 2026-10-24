/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * The remote server as the SSH extension downloads it (REMOTE.md R6): one
 * `facade-server-<release>-<os>-<arch>.tar.gz` per desktop platform, built on its own OS from the
 * same tagged commit, holding a single top-level folder with `bin/facade-server` inside - the
 * layout open-remote-ssh's server setup unpacks and starts.
 */

/** The server package's file name, the release version first as in the desktop assets, where a person reads one (IDENTITY.md I7). */
export function serverPackageName(release: string, os: string, arch: string): string {
	return `${serverTopFolderName(release, os, arch)}.tar.gz`;
}

/** The tar's single top-level folder, which the extension strips on unpacking. */
export function serverTopFolderName(release: string, os: string, arch: string): string {
	return `facade-server-${release}-${os}-${arch}`;
}

/**
 * What is wrong with the layout of `serverDir`, a built server about to be packaged for `platform`:
 * the launcher the extension starts - `bin/<serverApplicationName>`, a `.cmd` on Windows - what that
 * launcher runs, the server's own Node and `out/server-main.js`, and the workspace-side built-ins,
 * `facade-agents` among them, which the server build selects. Nothing where the layout is what the
 * extension expects.
 */
export function serverLayoutProblems(serverDir: string, serverApplicationName: string, platform: string): string[] {
	const problems: string[] = [];
	const launcher = platform === 'win32' ? `${serverApplicationName}.cmd` : serverApplicationName;
	if (!fs.existsSync(path.join(serverDir, 'bin', launcher))) {
		problems.push(`bin/${launcher} is missing: the extension starts the server through it`);
	}
	const node = platform === 'win32' ? 'node.exe' : 'node';
	if (!fs.existsSync(path.join(serverDir, node))) {
		problems.push(`${node} is missing: the launcher runs the server with it`);
	}
	if (!fs.existsSync(path.join(serverDir, 'out', 'server-main.js'))) {
		problems.push('out/server-main.js is missing: the launcher starts the server with it');
	}
	if (!fs.existsSync(path.join(serverDir, 'extensions', 'facade-agents', 'package.json'))) {
		problems.push('extensions/facade-agents is missing: the server carries the workspace-side built-ins');
	}
	return problems;
}

/**
 * The `tar` the server packages are made and read with: on Windows its own, bsdtar, which takes a
 * path with a drive letter where the GNU tar of Git's shell reads `C:` as a remote host; elsewhere
 * the system's.
 */
export function systemTar(): string {
	return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
}

/**
 * Packs `serverDir`, a built server, into `tarballPath` under the single top-level folder
 * `topFolder`: the folder renamed, archived with {@link systemTar}, and named back, so a failed
 * run leaves the build as it found it. Throws naming what went wrong.
 */
export function createServerTarball(serverDir: string, tarballPath: string, topFolder: string): void {
	const parent = path.dirname(serverDir);
	const staged = path.join(parent, topFolder);
	if (fs.existsSync(staged) && staged !== serverDir) {
		throw new Error(`Cannot stage the server package: ${staged} is already there`);
	}
	fs.renameSync(serverDir, staged);
	try {
		// COPYFILE_DISABLE keeps macOS's tar from adding `._` files for extended attributes, which
		// would bring a quarantine flag of the build machine's back on the remote
		const archived = spawnSync(systemTar(), ['-czf', tarballPath, '-C', parent, topFolder], { stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } });
		if (archived.status !== 0) {
			throw new Error(`tar failed: ${String(archived.stderr ?? archived.stdout ?? '').trim() || `exit ${archived.status}`}`);
		}
	} finally {
		fs.renameSync(staged, serverDir);
	}
}

/**
 * The files of a Windows server whose signature Windows checks: executables, native modules and PowerShell
 * scripts, as upstream signs its own (REMOTE.md R6).
 */
export function serverSignedFiles(serverDir: string): string[] {
	return (fs.readdirSync(serverDir, { recursive: true, encoding: 'utf8' }) as string[])
		.filter(file => /\.(exe|dll|node|ps1|psm1|psd1|ps1xml)$/i.test(file))
		.map(file => path.join(serverDir, file));
}

/** What a server must pass before it is packaged: each check answers what it found wrong, or throws (REMOTE.md R6). */
export interface ServerPackageChecks {
	/** What is wrong with its layout (`serverLayoutProblems`). */
	readonly layout: () => readonly string[];
	/** Throws where a version field is not the release's (I7). */
	readonly versions: () => void;
	/** For Linux: what is above the glibc baseline, a check that cannot run included. */
	readonly glibc?: () => readonly string[];
	/** For Windows: the files without a valid signature (`serverSignedFiles`). */
	readonly unsigned?: () => readonly string[];
}

/**
 * Runs the checks a server of `platform` must pass before it is packaged, and throws naming the first that
 * fails: one its platform needs and none was given for fails too, so an unchecked server is never packaged.
 */
export function checkServerPackage(serverDir: string, platform: string, checks: ServerPackageChecks): void {
	const layout = checks.layout();
	if (layout.length) {
		throw new Error(`The server at ${serverDir} is not what the extension expects:\n  ${layout.join('\n  ')}`);
	}
	checks.versions();
	if (platform === 'linux' || platform === 'alpine') {
		const above = checks.glibc?.() ?? ['the glibc check was not run'];
		if (above.length) {
			throw new Error(`The Linux server is not within the glibc ${SERVER_GLIBC_VERSION} baseline:\n  ${above.join('\n  ')}`);
		}
	}
	if (platform === 'win32') {
		const unsigned = checks.unsigned?.() ?? ['the signature check was not run'];
		if (unsigned.length) {
			throw new Error(`The server has unsigned files; sign them first with the -server-sign task:\n  ${unsigned.join('\n  ')}`);
		}
	}
}

/** The glibc baseline a Linux server must not ask more than, as upstream's server is checked. */
export const SERVER_GLIBC_VERSION = '2.28';
export const SERVER_GLIBCXX_VERSION = '3.4.25';

/**
 * The objdump of upstream's sysroot that its glibc check reads the binaries with. Without it the check reads
 * nothing and passes: its absence is a failure of the check (REMOTE.md R6).
 */
export function sysrootObjdump(repoRoot: string, arch: string): string {
	const triple = arch === 'arm64' ? 'aarch64-linux-gnu' : arch === 'armhf' ? 'arm-rpi-linux-gnueabihf' : 'x86_64-linux-gnu';
	return path.join(sysrootDir(repoRoot), triple, triple, 'bin', 'objdump');
}

/** Upstream's glibc 2.28 sysroot, which a Linux server's native modules are built against. */
function sysrootDir(repoRoot: string): string {
	return path.join(repoRoot, '.build', 'sysroots', 'glibc-2.28-gcc-8.5.0');
}

/**
 * The files upstream's glibc check reads, selected as its `find` selects them: the server's native modules -
 * those under `prebuilds` and @parcel/watcher's left out, as upstream leaves them - and every executable regular
 * file named `node`, links aside (`-type f -executable`). Of those, the ELF files, which are all Linux loads:
 * another OS's module that an extension carries for every platform, as js-debug carries Windows ones, asks
 * nothing of glibc, and upstream's check, reading nothing from it, passes it too. Each ELF file must be one
 * objdump can read, or it went unchecked. `isExecutable` reads a file's mode unless told.
 */
export function glibcCheckedFiles(serverDir: string, isExecutable: (file: string) => boolean = file => (fs.lstatSync(file).mode & 0o111) !== 0): string[] {
	return (fs.readdirSync(serverDir, { recursive: true, encoding: 'utf8' }) as string[])
		.filter(file => {
			const spelled = file.split(path.sep).join('/');
			if (spelled.endsWith('.node')) {
				return !spelled.includes('prebuilds') && !spelled.includes('extensions/node_modules/@parcel/watcher');
			}
			const full = path.join(serverDir, file);
			return path.posix.basename(spelled) === 'node' && fs.lstatSync(full).isFile() && isExecutable(full);
		})
		.map(file => path.join(serverDir, file))
		.filter(isElf);
}

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Whether `file` starts as an ELF file does. */
function isElf(file: string): boolean {
	const fd = fs.openSync(file, 'r');
	try {
		const start = Buffer.alloc(ELF_MAGIC.length);
		return fs.readSync(fd, start, 0, start.length, 0) === start.length && start.equals(ELF_MAGIC);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * What upstream's glibc check found above the baseline, by the `Error:` lines it prints: a GLIBCXX one is only
 * printed, its exit status unchanged, and counts all the same - Debian 10's libstdc++ is no newer (RM-18).
 */
export function glibcProblems(output: string): string[] {
	return output.split(/\r?\n/).filter(line => line.startsWith('Error:'));
}

/**
 * The environment upstream's glibc check runs in over `serverDir`: the 2.28 sysroot the server's
 * native modules were built against, and the versions its binaries must stay within.
 */
export function glibcCheckEnv(repoRoot: string, serverDir: string, arch: string): NodeJS.ProcessEnv {
	return {
		SEARCH_PATH: serverDir,
		VSCODE_ARCH: arch,
		EXPECTED_GLIBC_VERSION: SERVER_GLIBC_VERSION,
		EXPECTED_GLIBCXX_VERSION: SERVER_GLIBCXX_VERSION,
		VSCODE_SYSROOT_DIR: sysrootDir(repoRoot),
	};
}
