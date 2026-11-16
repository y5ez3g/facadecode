/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which engine a window runs its agents on: the Rust engine, or the old one (ARCHITECTURE-1.1). It is chosen once, as the window
// opens or reloads; an old-engine window that has no old run left says to reload and starts nothing new until it does.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { FacadeError } from '../core/errors';
import type { Agents, LogPort } from '../core/ports';
import { otherPtyds, PtydClient } from './execution/ptydClient';
import { type Engine, FACADE_PROGRAM } from './rust/types';

/** How long one ptyd has to list its runs. */
const LIST_WAIT_MS = 2_000;
/** How often an old-engine window asks whether old runs still run, while they do. */
const CHECK_MS = 10_000;

/** The setting `facade.rustEngine`, by its section and key. */
const SECTION = 'facade';
const KEY = 'rustEngine';

/** `facade.rustEngine`: `auto` where it is anything but `off`. */
export function rustEngineSetting(): 'auto' | 'off' {
	return vscode.workspace.getConfiguration(SECTION).get<string>(KEY) === 'off' ? 'off' : 'auto';
}

/**
 * Whether a ptyd of this environment's `home` lists a run that has not exited, of any owner. A ptyd that does not respond holds none
 * that can be asked about; none is started to ask.
 */
export async function oldRunsRunning(home: string): Promise<boolean> {
	const asked = await Promise.all(otherPtyds(home, '').map(async ({ socket, protocol }) => {
		let client: PtydClient | undefined;
		try {
			client = await PtydClient.join(socket, protocol);
			if (!client) {
				return false;
			}
			const runs = await Promise.race([client.request('list', {}), timeout(LIST_WAIT_MS).then(() => { throw new Error('ptyd did not list its runs in time.'); })]);
			return runs.some(run => run.exited === undefined);
		} catch {
			return false;
		} finally {
			client?.dispose();
		}
	}));
	return asked.some(running => running);
}

/**
 * The engine this window runs on: `old` for `off`, for old runs still running, and for a package without core's program; else
 * `rust`. Sets the context key `facade.engine` to it, which hides Show Agent Launch on `rust`.
 */
export async function chooseEngine(context: vscode.ExtensionContext, home: string): Promise<Engine> {
	let engine: Engine = 'old';
	if (rustEngineSetting() === 'auto' && fs.existsSync(path.join(context.extensionPath, FACADE_PROGRAM)) && !await oldRunsRunning(home)) {
		engine = 'rust';
	}
	await vscode.commands.executeCommand('setContext', 'facade.engine', engine);
	return engine;
}

/** Offers the reload that applies a changed Facade: Rust Engine, as `facade.home` does (`host/home.ts`). */
export function watchRustEngineSetting(): vscode.Disposable {
	let seen = rustEngineSetting();
	return vscode.workspace.onDidChangeConfiguration(event => {
		const now = rustEngineSetting();
		if (!event.affectsConfiguration(`${SECTION}.${KEY}`) || now === seen) {
			return;
		}
		seen = now;
		offerReload(vscode.l10n.t("The engine changes only after you reload the window."));
	});
}

/**
 * The one place that tells the person this window can switch to the Rust engine: a notification with Reload Window, nothing on the
 * panel.
 */
export function sayReloadToSwitch(): void {
	offerReload(reloadToSwitchText());
}

function reloadToSwitchText(): string {
	return vscode.l10n.t("All agents on the old engine have ended. Reload this window to switch.");
}

function offerReload(text: string): void {
	const reload = vscode.l10n.t("Reload Window");
	void vscode.window.showInformationMessage(text, reload).then(choice => {
		if (choice === reload) {
			void vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

/**
 * `agents` of an old-engine window under `auto`, which starts nothing once no old run runs on this machine (`running()`, one ptyd
 * `list`, is asked after each `removed` or `lifecycle` change, every ten seconds while it is true, and before each `restorePins`):
 * it says so once, and from then on `launch`, `resume` and `restorePins` refuse with the same sentence. `launch` and `resume`
 * return at once, so they go by the last answer. Every other method passes through.
 */
export function retireWhenDone(agents: Agents, running: () => Promise<boolean>, log: LogPort): { readonly agents: Agents; dispose(): void } {
	let retired = false;
	let disposed = false;
	let asking: Promise<void> | undefined;
	let again = false;

	const ask = (): Promise<void> => {
		if (asking) {
			again = true;
			return asking;
		}
		asking = (async () => {
			do {
				again = false;
				let still = true;
				try {
					still = await running();
				} catch (err) {
					log.event(`Could not ask whether the old engine still has runs: ${messageOf(err)}`);
				}
				if (!still && !retired && !disposed) {
					retired = true;
					clearInterval(timer);
					log.event('Every agent of the old engine has ended: this window starts none until it reloads.');
					sayReloadToSwitch();
				}
			} while (again && !retired && !disposed);
		})().finally(() => { asking = undefined; });
		return asking;
	};
	// The caller shows the thrown sentence; the one with Reload Window was shown when the old engine's last run ended.
	const refuse = (): never => {
		throw new FacadeError('REFUSED', 'reload_to_switch', reloadToSwitchText());
	};

	const timer = setInterval(() => void ask(), CHECK_MS);
	timer.unref?.();
	const changes = agents.onDidChange(change => {
		if (change.kind === 'removed' || change.kind === 'lifecycle') {
			void ask();
		}
	});

	const guarded: Partial<Agents> = {
		launch: request => retired ? refuse() : agents.launch(request),
		resume: (entry, options) => retired ? refuse() : agents.resume(entry, options),
		restorePins: async () => {
			await ask();
			return retired ? refuse() : agents.restorePins();
		}
	};
	const through = new Proxy(agents, {
		get(target, name) {
			if (name in guarded) {
				return guarded[name as keyof Agents];
			}
			const value: unknown = Reflect.get(target, name, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return {
		agents: through,
		dispose() {
			disposed = true;
			clearInterval(timer);
			changes.dispose();
		}
	};
}
