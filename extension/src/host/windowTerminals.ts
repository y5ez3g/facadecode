/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import type { OwnerClaim } from '../base/ownership';
import { isTerminalRegistration, TERMINAL_REGISTRATION_MS } from '../base/windowIdentity';
import { beginWindowTerminals, retireWindowTerminals, type RetiredTerminals } from '../record/windowIdentity';

interface Registration {
	claim: OwnerClaim;
	readonly runs: Map<string, vscode.Terminal>;
	retiring?: RetiredTerminals;
}

interface Capture {
	readonly owner: Registration;
	readonly run: string;
	readonly ticket: string;
	/** Closed objects remain counted: two opens followed by one close are still ambiguous. */
	readonly opened: Set<vscode.Terminal>;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** Local public Terminal references survive a remote workspace-host restart (ARCHITECTURE-2.2). */
export class WindowTerminals implements vscode.Disposable {
	private readonly owners = new Map<string, Registration>();
	private capture?: Capture;
	private disposed = false;
	private readonly subscriptions: vscode.Disposable[];
	private readonly snapshot: readonly vscode.Terminal[];
	private readonly retired = new Map<string, RetiredTerminals>();
	private epoch?: string;

	constructor(private readonly storage?: { readonly directory: string; readonly log: (line: string) => void }) {
		this.snapshot = [...vscode.window.terminals];
		if (storage) {
			try {
				const previous = beginWindowTerminals(storage.directory);
				this.epoch = previous.epoch;
				for (const owner of previous.retired) { this.retired.set(owner.claim.owner, owner); }
			} catch (error) { storage.log(`Could not read retired terminal resources: ${messageOf(error)}`); }
		}
		this.subscriptions = [
			vscode.window.onDidOpenTerminal(terminal => this.capture?.opened.add(terminal)),
			vscode.window.onDidCloseTerminal(terminal => {
				for (const owner of this.owners.values()) {
					for (const [run, bound] of owner.runs) {
						if (bound === terminal) { owner.runs.delete(run); }
					}
				}
			})
		];
	}

	/** A same-host caller may supply its real reference; a cross-host caller sends only the plain request. */
	request(value: unknown, actual?: unknown): boolean | string | Promise<boolean> {
		if (this.disposed || !isTerminalRegistration(value) || value.session !== vscode.env.sessionId) {
			return false;
		}
		let owner = this.owners.get(value.claim.owner);
		if (value.kind === 'activate') {
			if (owner && (value.claim.generation < owner.claim.generation
				|| (value.claim.generation === owner.claim.generation && value.claim.token !== owner.claim.token))) {
				return false;
			}
			if (!owner) {
				const previous = this.retired.get(value.claim.owner);
				this.retired.delete(value.claim.owner);
				owner = { claim: { ...value.claim }, runs: new Map(),
					retiring: value.handedOver && previous && value.claim.generation > previous.claim.generation ? previous : undefined };
				this.owners.set(value.claim.owner, owner);
			} else if (value.claim.generation > owner.claim.generation) {
				if (this.capture?.owner === owner) { this.clearCapture(); }
				owner.claim = { ...value.claim };
				owner.retiring = undefined;
			}
			return true;
		}
		if (!owner || owner.claim.generation !== value.claim.generation || owner.claim.token !== value.claim.token) {
			return false;
		}
		if (value.kind === 'retire') { return this.retire(owner, value.runs); }
		if (value.kind === 'begin') {
			if (this.capture) { return false; }
			const ticket = randomUUID();
			this.capture = { owner, run: value.run, ticket, opened: new Set(),
				timer: setTimeout(() => this.clearCapture(), TERMINAL_REGISTRATION_MS) };
			return ticket;
		}
		const capture = this.capture;
		if (!capture || capture.owner !== owner || capture.run !== value.run || capture.ticket !== value.ticket) {
			return false;
		}
		this.clearCapture();
		if (value.kind === 'cancel' || capture.opened.size !== 1) { return false; }
		const terminal = capture.opened.values().next().value!;
		if (!vscode.window.terminals.includes(terminal) || (actual !== undefined && actual !== terminal)) {
			return false;
		}
		const old = owner.runs.get(value.run);
		// Publish the new identity first: the old object's late close cannot clear it.
		owner.runs.set(value.run, terminal);
		if (old && old !== terminal) { old.dispose(); }
		return true;
	}

	/** This retires a whole old resource group; it never associates an old candidate with an individual run. */
	private async retire(owner: Registration, restored: readonly string[]): Promise<boolean> {
		const previous = owner.retiring;
		owner.retiring = undefined;
		if (!previous) { return false; }
		const claim = owner.claim;
		const current = () => !this.disposed && owner.claim === claim;
		const runs = new Set(restored);
		const groups = new Map<string, string[]>();
		for (const { run, title } of previous.runs) {
			const group = groups.get(title) ?? [];
			group.push(run); groups.set(title, group);
		}
		const eligible = (terminal: vscode.Terminal) => {
			const options = terminal.creationOptions;
			// The editor retains the creation name even after a CLI changes the displayed title.
			return !('pty' in options) && options.shellPath === undefined && options.shellArgs === undefined
				&& options.cwd === undefined && options.env === undefined && typeof options.name === 'string';
		};
		const candidates = this.snapshot.filter(eligible);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), TERMINAL_REGISTRATION_MS); });
			// Each terminal's own answer by the deadline: one that never answers, or fails to, leaves its own group alone, not all
			const found = await Promise.all(candidates.map(async terminal => ({ terminal, name: terminal.name,
				pid: await Promise.race([Promise.resolve(terminal.processId).catch(() => undefined), deadline]) })));
			if (!current()) { return false; }
			let retired = false;
			for (const [title, group] of groups) {
				if (!group.every(run => runs.has(run) && owner.runs.has(run))) { continue; }
				const old = found.filter(each => each.name === title && each.terminal.name === title && eligible(each.terminal)
					&& vscode.window.terminals.includes(each.terminal) && !(each.pid !== undefined && each.pid > 0));
				// Unknown PIDs do not shrink an ambiguous group into an apparently exact one.
				if (old.length !== group.length || old.some(each => each.pid === undefined || !Number.isFinite(each.pid) || each.pid > 0)) { continue; }
				for (const { terminal } of old) { terminal.dispose(); }
				retired = true;
			}
			return retired;
		} catch (error) {
			this.storage?.log(`Could not retire old terminal resources: ${messageOf(error)}`);
			return false;
		} finally { clearTimeout(timer); }
	}

	private clearCapture(): void {
		if (this.capture) { clearTimeout(this.capture.timer); this.capture = undefined; }
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.clearCapture();
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		if (this.storage && this.epoch) {
			try {
				retireWindowTerminals(this.storage.directory, this.epoch, [...this.owners.values()].map(owner => ({ claim: owner.claim,
					runs: [...owner.runs].map(([run, terminal]) => ({ run, title: terminal.name })) })));
			} catch (error) { this.storage.log(`Could not record retired terminal resources: ${messageOf(error)}`); }
		}
		this.owners.clear();
	}
}
