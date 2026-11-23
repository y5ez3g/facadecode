/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import { timeout } from '../../base/async';
import type { AgentRef, DaemonTopics } from '../../base/frameworkProtocol';
import type { Disposable, PairFacts, RunId } from '../../core/ports';
import type { ScreenBinding } from '../execution/agentPty';
import { AgentTerminals, type AgentTerminal } from '../execution/agentTerminals';
import { encodeTerminalInput, type OrchestratorLink, type ResizeAttach } from './types';

type TerminalOptions = ConstructorParameters<typeof AgentTerminals>[0];
type Options = Pick<TerminalOptions, 'media' | 'icon' | 'log' | 'colours' | 'terminalOwner'> & { readonly viewer: string };
type Target = { readonly ref: AgentRef; readonly address: string };
type Draw = Parameters<ScreenBinding['watchScreen']>[0];
type ScreenSnapshot = DaemonTopics['attach']['snapshot'];
type ScreenChange = DaemonTopics['attach']['change'];
type Size = ScreenSnapshot['size'];

const OPEN_WAIT_MS = 10_000;
const SCREEN_RETRY_MS = 250;

interface Pair {
	readonly facts: PairFacts;
	readonly terminal: AgentTerminal;
	target?: Target;
	reachable: boolean;
	view?: View;
	shown?: boolean;
	failure?: Error;
	attachment?: ReturnType<typeof Promise.withResolvers<void>>;
}

interface View {
	readonly target: Target;
	readonly draw: Draw;
	watch?: { handle?: Disposable };
	retry?: ReturnType<typeof setTimeout>;
	decoder: StringDecoder;
	seq: number;
	resizeAttach?: ResizeAttach;
	ready: boolean;
	ended?: boolean;
	disconnected: boolean;
	dropped: number;
}

/** One editor's Attach views. Each native tab holds its own watch (RULES-6.3, LIFECYCLE-5.3). */
export class OrchestratorTerminals implements vscode.Disposable {
	private readonly terminals: AgentTerminals;
	private readonly pairs = new Map<RunId, Pair>();
	private readonly activations = new vscode.EventEmitter<RunId | undefined>();
	readonly onDidActivate = this.activations.event;
	private readonly colourChanges?: Disposable;

	constructor(private readonly link: OrchestratorLink, private readonly options: Options) {
		this.terminals = new AgentTerminals({
			...options,
			activated: run => this.activations.fire(run),
			closed: run => {
				const pair = this.pairs.get(run);
				if (pair) { this.closeView(pair); }
			}
		});
		void this.terminals.finishRestore();
		this.colourChanges = options.colours?.onDidChange(() => {
			for (const pair of this.pairs.values()) {
				this.resize(pair);
			}
		});
	}

	openPair(facts: PairFacts, options: { readonly reveal: boolean; readonly hidden?: boolean }): void {
		if (this.pairs.has(facts.run)) { return; }
		const terminal = this.terminals.create(facts, options.reveal);
		this.pairs.set(facts.run, { facts, terminal, reachable: false });
		if (!options.hidden && facts.tab !== 'hidden') {
			terminal.open(options.reveal, typeof facts.tab === 'object' ? facts.tab.column : undefined);
		}
	}

	bind(run: RunId, target: Target, reachable: boolean): void {
		const pair = this.pairs.get(run);
		if (!pair) { return; }
		if (pair.target && sameRef(pair.target.ref, target.ref)) {
			this.setReachable(run, reachable);
			return;
		}
		pair.target = target;
		pair.reachable = reachable;
		pair.terminal.pty.bind({
			answersQueries: true,
			watchScreen: draw => this.openView(pair, target, draw),
			input: data => this.input(pair, data),
			resize: () => this.resize(pair)
		});
	}

	setReachable(run: RunId, reachable: boolean): void {
		const pair = this.pairs.get(run);
		if (!pair || pair.reachable === reachable) { return; }
		pair.reachable = reachable;
		const view = pair.view;
		if (!view) { return; }
		if (!reachable) {
			this.stopWatching(view);
			this.suspend(pair, view);
			if (!pair.shown) { this.unreachable(pair, view); }
		} else if (!view.watch && !view.retry) {
			this.watchAttach(pair, view);
		}
	}

	async reveal(run: RunId, options: { readonly preserveFocus: boolean }): Promise<boolean> {
		const pair = this.pairs.get(run);
		if (!pair) { return false; }
		this.prepareOpen(pair);
		return pair.terminal.reveal(options.preserveFocus);
	}

	/** Resolves once the current tab's initial screen has been written to its renderer. */
	async attached(run: RunId): Promise<void> {
		const pair = this.pairs.get(run);
		if (!pair) { throw this.closedError(); }
		if (pair.failure) { throw pair.failure; }
		if (pair.shown) { return; }
		pair.attachment ??= Promise.withResolvers<void>();
		return pair.attachment.promise;
	}

	rename(run: RunId, name: string): void {
		this.pairs.get(run)?.terminal.rename(name);
	}

	exited(run: RunId, text: string): void {
		this.pairs.get(run)?.terminal.pty.exited(text);
	}

	removePair(run: RunId): void {
		const pair = this.pairs.get(run);
		if (!pair) { return; }
		this.pairs.delete(run);
		this.closeView(pair);
		pair.terminal.dispose();
	}

	async openPinned(run: RunId): Promise<void> {
		const pair = this.pairs.get(run);
		if (!pair) { return; }
		this.prepareOpen(pair);
		const place = pair.facts.tab;
		if (!pair.terminal.openInTurn(typeof place === 'object' ? place.column : undefined)) { return; }
		const opened = await Promise.race([pair.terminal.pty.nextOpen(), timeout(OPEN_WAIT_MS).then(() => undefined)]);
		await pair.terminal.markOpened(opened === true && this.pairs.get(run) === pair);
		if (!opened) {
			throw new Error(vscode.l10n.t('Could not open the terminal for {0}.', pair.target?.address ?? pair.facts.name));
		}
	}

	pinnedOpened(): void {
		this.terminals.turnsOver();
	}

	async pinnedSequenceOver(knownRuns?: readonly RunId[]): Promise<void> {
		await this.terminals.retirePredecessor(knownRuns);
	}

	systemMotion(reduced: boolean): void {
		this.terminals.systemMotion(reduced);
	}

	dispose(): void {
		this.colourChanges?.dispose();
		for (const pair of this.pairs.values()) { this.closeView(pair); }
		this.pairs.clear();
		this.terminals.dispose();
		this.activations.dispose();
	}

	private prepareOpen(pair: Pair): void {
		if (!pair.terminal.isOpen()) { pair.failure = undefined; }
	}

	private openView(pair: Pair, target: Target, draw: Draw): Disposable {
		pair.shown = false;
		pair.failure = undefined;
		const view: View = {
			target, draw, decoder: new StringDecoder('utf8'), seq: 0, ready: false, disconnected: false, dropped: 0
		};
		pair.view = view;
		if (!pair.reachable || !this.link.connected) { this.suspend(pair, view); }
		if (pair.reachable) {
			this.watchAttach(pair, view);
		} else {
			this.unreachable(pair, view);
		}
		return { dispose: () => { if (pair.view === view) { this.closeView(pair); } } };
	}

	private watchAttach(pair: Pair, view: View): void {
		const watch: NonNullable<View['watch']> = {};
		view.watch = watch;
		const current = () => pair.view === view && view.watch === watch;
		const handle = this.link.watchAttach(() => ({
			target: view.target.ref,
			viewer: this.options.viewer,
			keep_scrollback: true,
			size: screenSize(pair.terminal.pty.dimensions)
		}), {
			snapshot: (screen, resize) => { if (current()) { this.snapshot(pair, view, screen, resize); } },
			change: change => { if (current()) { this.change(pair, view, change); } },
			disconnected: () => { if (current()) { this.suspend(pair, view); } },
			ended: error => {
				if (!current()) { return; }
				this.stopWatching(view);
				view.ready = false;
				this.failAttach(pair, error);
				if (error.reason === 'unavailable') {
					this.suspend(pair, view);
					// A remote Attach can end after the roster's last reachable update.
					const retry = setTimeout(() => {
						if (pair.view !== view || view.retry !== retry) { return; }
						view.retry = undefined;
						if (pair.reachable) { this.watchAttach(pair, view); }
					}, SCREEN_RETRY_MS);
					view.retry = retry.unref();
				}
			}
		});
		if (current()) { watch.handle = handle; } else { handle.dispose(); }
	}

	private snapshot(pair: Pair, view: View, snapshot: ScreenSnapshot, resize: ResizeAttach): void {
		if (!sameRef(view.target.ref, snapshot.reference)) { return; }
		view.resizeAttach = resize;
		this.redraw(pair, view, snapshot.size, snapshot.redraw);
		view.ended = snapshot.process === 'ended';
		if (view.ended) {
			this.failAttach(pair, new Error(vscode.l10n.t('{0} has ended. Use Resume Agent to continue it.', view.target.address)));
			return;
		}
		view.ready = true;
		view.disconnected = false;
		if (view.dropped) {
			pair.terminal.pty.screenNote(vscode.l10n.t('Keys not sent: {0} bytes.', view.dropped));
			view.dropped = 0;
		}
		this.resize(pair);
		pair.shown = true;
		pair.failure = undefined;
		pair.attachment?.resolve();
		pair.attachment = undefined;
	}

	private change(pair: Pair, view: View, change: ScreenChange): void {
		if (change.kind === 'removed') {
			this.stopWatching(view);
			view.ready = false;
			this.failAttach(pair, new Error(vscode.l10n.t('{0} is no longer available.', view.target.address)));
			return;
		}
		if (!view.ready) { return; }
		if (change.kind === 'redraw') {
			this.redraw(pair, view, change.size, change.data);
		} else if (change.kind === 'output') {
			pair.terminal.pty.output(++view.seq, decode(change.data, view.decoder));
		} else if (change.kind === 'exit') {
			view.ended = true;
		}
	}

	private redraw(pair: Pair, view: View, { cols, rows }: Size, data: string): void {
		view.decoder = new StringDecoder('utf8');
		pair.terminal.pty.setGrid({ columns: cols, rows });
		view.draw({ screen: decode(data, view.decoder), seq: ++view.seq });
	}

	private input(pair: Pair, data: string): void {
		const view = pair.view;
		if (!view || view.ended) { return; }
		if (view.ready && this.link.notify('agent.type', { target: view.target.ref, input: { kind: 'raw', raw: encodeTerminalInput(data) } })) { return; }
		if (view.ready) { this.suspend(pair, view); }
		view.dropped += Buffer.byteLength(data, 'utf8');
	}

	private resize(pair: Pair): void {
		const view = pair.view;
		if (!view?.ready || !view.resizeAttach || view.ended) { return; }
		const size = screenSize(pair.terminal.pty.dimensions);
		if (!size) { return; }
		const colors = this.options.colours?.currentHex();
		view.resizeAttach({ size, colors });
	}

	private suspend(pair: Pair, view: View): void {
		view.ready = false;
		view.resizeAttach = undefined;
		if (!view.disconnected) {
			view.disconnected = true;
			pair.terminal.pty.screenNote(vscode.l10n.t('Connection lost. Reconnecting. Keys typed while disconnected are not sent.'));
		}
	}

	private stopWatching(view: View): void {
		const watch = view.watch;
		view.watch = undefined;
		view.resizeAttach = undefined;
		clearTimeout(view.retry);
		view.retry = undefined;
		watch?.handle?.dispose();
	}

	private closedError(): Error {
		return new Error(vscode.l10n.t('The terminal closed before Attach completed.'));
	}

	private closeView(pair: Pair): void {
		const view = pair.view;
		pair.view = undefined;
		if (view) { this.stopWatching(view); }
		pair.shown = false;
		this.failAttach(pair, this.closedError());
	}

	private failAttach(pair: Pair, error: Error): void {
		pair.failure = error;
		pair.attachment?.reject(error);
		pair.attachment = undefined;
	}

	private unreachable(pair: Pair, view: View): void {
		this.failAttach(pair, new Error(vscode.l10n.t('Could not reach {0}.', view.target.address)));
	}
}

function sameRef(left: AgentRef, right: AgentRef): boolean {
	return left.machine_id === right.machine_id && left.agent_id === right.agent_id;
}

function screenSize(dimensions: vscode.TerminalDimensions | undefined): Size | undefined {
	if (dimensions && dimensions.columns >= 2 && dimensions.rows >= 1) {
		return { cols: dimensions.columns, rows: dimensions.rows };
	}
	return undefined;
}

function decode(data: string, decoder: StringDecoder): string {
	return decoder.write(Buffer.from(data, 'base64'));
}
