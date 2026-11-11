/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Facade home this window uses (ARCHITECTURE-3.1): Facade: Home where the person set it, else the FACADE_HOME environment
// variable, else ~/.facade. It is decided once, as the window starts, and a change takes a reload, which Facade offers.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isSameFolder, replaceFile } from '../base/files';
import { FACADE_HOME_VARIABLE, isFullyQualified } from '../record/paths';

/** The setting `facade.home`, by its section and key. */
const SECTION = 'facade';
const KEY = 'home';

/**
 * The folder `value` names, where it is a usable Facade home (ARCHITECTURE-3.1): an absolute path - on Windows on a drive or a share -
 * or one in the person's home folder written `~/`, or `~\` on Windows. None for anything else: a relative path is never read as being
 * in some other folder, nor `\folder` on Windows as being on some drive.
 */
export function homePathOf(value: string, userHome: string = os.homedir(), platform: NodeJS.Platform = process.platform): string | undefined {
	const typed = value.trim();
	if (/^~[\\/]/.test(typed)) {
		return (platform === 'win32' ? path.win32 : path.posix).join(userHome, typed.slice(2));
	}
	return isFullyQualified(typed, platform) ? typed : undefined;
}

/**
 * What the person set as Facade: Home, in their user settings or the remote machine's (ARCHITECTURE-3.1): none where they never set it,
 * left it blank or null, whatever its default shows. A value of another JSON type is set all the same, and no usable path: it is
 * given as its JSON. A workspace cannot set it: the setting is the machine's.
 */
export function homeSetting(): string | undefined {
	const set: unknown = vscode.workspace.getConfiguration(SECTION).inspect<unknown>(KEY)?.globalValue;
	if (set === undefined || set === null || (typeof set === 'string' && !set.trim())) {
		return undefined;
	}
	return typeof set === 'string' ? set : JSON.stringify(set);
}

/** The folder FACADE_HOME or ~/.facade names, where Facade: Home names none (ARCHITECTURE-3.1). */
function homeOtherwise(): string {
	return process.env[FACADE_HOME_VARIABLE] || path.join(os.homedir(), '.facade');
}

/**
 * Offers the reload that applies a new Facade home (ARCHITECTURE-3.1), for as long as `context` lasts: chosen after the window let it
 * go, it does nothing.
 */
function reloadOffer(context: vscode.ExtensionContext, reloadText: () => string): () => void {
	let live = true;
	context.subscriptions.push({ dispose: () => { live = false; } });
	return () => {
		const reload = vscode.l10n.t("Reload Window");
		void vscode.window.showInformationMessage(reloadText(), reload).then(choice => {
			if (live && choice === reload) {
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	};
}

/** A Facade: Home that is no usable path, as the person typed it: the window starts no agent rather than use another home. */
export class UnusableHome extends Error {
	constructor(readonly value: string) {
		super(`Facade: Home is not a usable folder: ${value}`);
	}
}

/**
 * Decides this window's Facade home before anything reads it (ARCHITECTURE-3.1). A Facade: Home the person set is written to this
 * extension host's FACADE_HOME, which ptyd, the core and every agent it starts inherit; with `terminals`, the window's own terminals are
 * given it as well, so that `facade` typed there reaches the same agents. Never set, FACADE_HOME is left as it is. A value that is no
 * usable path throws `UnusableHome`. With `offerReload`, a later change of the setting offers the reload that uses it.
 */
export function useFacadeHome(context: vscode.ExtensionContext, options: { readonly terminals: boolean; readonly offerReload: boolean; readonly reloadText: () => string }): void {
	const set = homeSetting();
	// Offered before an unusable value stops the window, so that fixing it offers the reload that uses it too
	if (options.offerReload) {
		// The folder this window uses: one of FACADE_HOME's is known only while no Facade: Home has replaced it here
		const inUse = set === undefined ? homeOtherwise() : homePathOf(set);
		const offer = reloadOffer(context, options.reloadText);
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
			const now = homeSetting();
			if (!event.affectsConfiguration(`${SECTION}.${KEY}`) || now === set) {
				return;
			}
			// Another way of writing the same folder has nothing to reload
			const folder = now !== undefined ? homePathOf(now) : set === undefined ? inUse : undefined;
			if (folder !== undefined && inUse !== undefined && isSameFolder(folder, inUse)) {
				return;
			}
			offer();
		}));
	}
	const home = set === undefined ? undefined : homePathOf(set);
	if (set !== undefined && home === undefined) {
		throw new UnusableHome(set);
	}
	if (home !== undefined) {
		process.env[FACADE_HOME_VARIABLE] = home;
	}
	if (options.terminals) {
		if (home !== undefined) {
			context.environmentVariableCollection.replace(FACADE_HOME_VARIABLE, home);
		} else {
			context.environmentVariableCollection.delete(FACADE_HOME_VARIABLE);
		}
	}
}

/**
 * Where this computer's local windows write down the Facade: Home they use (ARCHITECTURE-3.1): in the window component's own storage on
 * this computer, which VS Code keeps for it whatever window runs it. A remote window's component reads it there, as VS Code gives it
 * only the remote machine's Facade: Home.
 */
export function homeRecordOf(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, 'home.json');
}

/**
 * Writes down this computer's Facade: Home as a local window uses it: the folder where one is set and usable; nothing where none is,
 * so that a remote window's component goes by FACADE_HOME or ~/.facade as the local windows do. An unusable value changes nothing:
 * the local windows start no agent until it is fixed, and remote windows keep the home they have. A record that cannot be written
 * leaves remote windows as they were, and is said in the log.
 */
export function rememberHome(file: string, log: (line: string) => void): void {
	const set = homeSetting();
	const home = set === undefined ? undefined : homePathOf(set);
	if (set !== undefined && home === undefined) {
		return;
	}
	try {
		if (home === undefined) {
			fs.rmSync(file, { force: true });
		} else if (rememberedHome(file) !== home) {
			// Replaced whole, never rewritten as it was: a remote window watching it reads only a change, never half of one
			fs.mkdirSync(path.dirname(file), { recursive: true });
			replaceFile(file, `${JSON.stringify({ home })}\n`);
		}
	} catch (err) {
		log(`Could not write down this computer's Facade home for remote windows: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * The Facade home this computer's local windows wrote down; none where they wrote none, or it cannot be read, or names no folder
 * whatever drive a process is in.
 */
export function rememberedHome(file: string, platform: NodeJS.Platform = process.platform): string | undefined {
	try {
		const { home } = JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly home?: unknown };
		return typeof home === 'string' && isFullyQualified(home, platform) ? home : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A remote window's component on this computer (ARCHITECTURE-3.1): the Facade home this computer's local windows wrote down, else
 * FACADE_HOME or ~/.facade as they have it; and, once they write down another, the reload that uses it - as a local window offers.
 */
export function useRememberedHome(context: vscode.ExtensionContext, reloadText: () => string): void {
	const file = homeRecordOf(context);
	// Where nothing is written down, FACADE_HOME or ~/.facade, as the local windows have it
	const otherwise = homeOtherwise();
	const remembered = rememberedHome(file);
	if (remembered !== undefined) {
		process.env[FACADE_HOME_VARIABLE] = remembered;
	}
	const inUse = remembered ?? otherwise;
	const offer = reloadOffer(context, reloadText);
	let seen = inUse;
	const changed = () => {
		const now = rememberedHome(file) ?? otherwise;
		// One change, however many events tell it; one to the folder this window uses has nothing to reload
		if (isSameFolder(now, seen)) {
			return;
		}
		seen = now;
		if (!isSameFolder(now, inUse)) {
			offer();
		}
	};
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, name) => {
			if (name === undefined || name === null || String(name) === path.basename(file)) {
				changed();
			}
		});
		// One that fails later - its folder gone - stops: the change applies at the next reload all the same
		watcher.on('error', () => watcher.close());
		context.subscriptions.push({ dispose: () => watcher.close() });
		// One written between the first reading and the watch's start is seen all the same
		changed();
	} catch {
		// No watch here: the change applies at the next reload all the same
	}
}

/** Facade: Home changed: the window keeps the Facade home it started with until it reloads (ARCHITECTURE-3.1). */
export function homeReloadText(): string {
	return vscode.l10n.t("The new Facade home applies only after the window reloads.");
}

/**
 * Facade: Home is no usable path, so this window starts no agent rather than use another home (ARCHITECTURE-3.1).
 * {0} is the value as the person typed it.
 */
export function unusableHomeText(value: string): string {
	return vscode.l10n.t("Facade: Home \"{0}\" must start with ~/ or be absolute. No agent can start until it is fixed.", value);
}
