/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import { timeout } from '../../base/async';
import { messageOf } from '../../base/errors';
import type { ScreenChange, ScreenSnapshot, ScreenWatchArgs } from '../../base/coreProtocol';
import type { Disposable, Event, PairFacts, RunId, TabPlace } from '../../core/ports';
import type { RunBinding } from '../execution/agentPty';
import { AgentTerminals, type AgentTerminal } from '../execution/agentTerminals';
import type { RunScreen } from '../execution/hiddenAnswers';
import { agentAddress } from './references';
import { encodeTerminalInput, type DaemonLink, type RustTerminals } from './types';

/** What `AgentTerminals` is made with: the layer gives `media`, `icon`, `log` and `colours` alone; the callbacks are this class's own. */
type TerminalOptions = ConstructorParameters<typeof AgentTerminals>[0];

/** How long a pinned tab's terminal is waited for as it opens in its turn: one that does not open in time keeps its agent (LIFECYCLE-3.5). */
const OPEN_WAIT_MS = 10_000;
const SCREEN_RETRY_MS = 250;

/** Each subscription holds its own generation for the full agent address. */
interface ScreenWatch {
	readonly agent: string;
	handle?: Disposable;
}

/** One agent tab: its terminal, and the screen watch it holds while the tab is open. */
interface Pair {
	readonly run: RunId;
	readonly terminal: AgentTerminal;
	readonly facts: PairFacts;
	/** The core agent whose screen it shows, once bound. */
	agent?: string;
	/** A remote tab suspends input and redraws from a snapshot after a connection is restored. */
	remote?: { reachable: boolean; ready: boolean; noted: boolean };
	/** The watch of that agent's screen: kept only while the tab is open. */
	watch?: ScreenWatch;
	retry?: ReturnType<typeof setTimeout>;
	/** The pending answer to the terminal's request for the screen, until the watch's snapshot comes. */
	pending?: { resolve(screen: RunScreen): void; reject(err: Error): void };
	/** Decodes the bytes of the watch's output, which may cut a character in two. */
	decoder: StringDecoder;
	/** The number of the last screen or output handed to the terminal: it draws each once, in order. */
	seq: number;
}

/** The terminal's text from base64 bytes; `decoder` keeps a character cut between two messages. */
function textOf(data: string, decoder: StringDecoder): string {
	return decoder.write(Buffer.from(data, 'base64'));
}

/**
 * The agents' editor terminals on the Rust engine: today's tabs (`AgentTerminals`, `AgentPty`), each drawing its agent's screen
 * from core's `screen` topic while its tab is open. Core answers the terminal queries of the programs, and core holds the size.
 */
export class DaemonTerminals implements RustTerminals, vscode.Disposable {
	private readonly terminals: AgentTerminals;
	private readonly pairs = new Map<RunId, Pair>();
	private readonly activations = new vscode.EventEmitter<RunId | undefined>();
	private readonly closes = new vscode.EventEmitter<{ readonly run: RunId; readonly marked: boolean }>();
	private readonly renames = new vscode.EventEmitter<{ readonly run: RunId; readonly name: string }>();
	private readonly pins = new vscode.EventEmitter<{ readonly run: RunId; readonly pinned: boolean }>();
	private readonly placements = new vscode.EventEmitter<{ readonly run: RunId; readonly place: TabPlace }>();
	readonly onDidActivate: Event<RunId | undefined> = this.activations.event;
	readonly onDidClosePair: Event<{ readonly run: RunId; readonly marked: boolean }> = this.closes.event;
	readonly onDidRenameTab: Event<{ readonly run: RunId; readonly name: string }> = this.renames.event;
	readonly onDidPinTab: Event<{ readonly run: RunId; readonly pinned: boolean }> = this.pins.event;
	readonly onDidPlaceTab: Event<{ readonly run: RunId; readonly place: TabPlace }> = this.placements.event;

	constructor(private readonly link: DaemonLink, private readonly options: Pick<TerminalOptions, 'media' | 'icon' | 'log' | 'colours' | 'terminalOwner'>) {
		this.terminals = new AgentTerminals({
			...options,
			activated: run => this.activations.fire(run),
			closed: (run, marked) => this.closes.fire({ run, marked }),
			placed: (run, column) => this.placements.fire({ run, place: column === undefined ? 'hidden' : { column } }),
			renamed: (run, name) => this.renames.fire({ run, name }),
			pinned: (run, pinned) => this.pins.fire({ run, pinned })
		});
		// Nothing is reattached on this engine: the marks that wait for a restore's end do not wait
		void this.terminals.finishRestore();
	}

	openPair(facts: PairFacts, options: { readonly reveal: boolean; readonly hidden?: boolean }): void {
		if (this.pairs.has(facts.run)) {
			return;
		}
		const terminal = this.terminals.create(facts, options.reveal);
		const pair: Pair = { run: facts.run, terminal, facts, decoder: new StringDecoder('utf8'), seq: 0 };
		// The terminal's close - the person's, a hide, a move to another group - ends its watch: an open one takes its screen anew
		const close = terminal.pty.close.bind(terminal.pty);
		terminal.pty.close = () => {
			close();
			this.unwatch(pair);
		};
		this.pairs.set(facts.run, pair);
		// A hidden one has its card alone until the person opens it
		if (!(options.hidden === true || facts.tab === 'hidden')) {
			terminal.open(options.reveal, typeof facts.tab === 'object' ? facts.tab.column : undefined);
		}
	}

	note(run: RunId, text: string): void {
		this.pairs.get(run)?.terminal.pty.note(text);
	}

	bind(run: RunId, agent: string, remote?: { readonly reachable: boolean }): void {
		const pair = this.pairs.get(run);
		if (!pair) {
			return;
		}
		pair.agent = agent;
		pair.remote = remote && { reachable: remote.reachable, ready: false, noted: false };
		this.unwatch(pair);
		pair.terminal.pty.bind(this.binding(pair, agent));
	}

	setReachable(run: RunId, reachable: boolean): void {
		const pair = this.pairs.get(run);
		if (!pair?.remote || !pair.agent) { return; }
		pair.remote.reachable = reachable;
		if (!reachable) {
			this.stopWatching(pair);
			this.suspend(pair);
		} else if (!pair.watch && !pair.retry && pair.terminal.pty.isOpen) {
			this.watchScreen(pair, pair.agent);
		}
	}

	exited(run: RunId, text: string): void {
		this.pairs.get(run)?.terminal.pty.exited(text);
	}

	removePair(run: RunId): void {
		const pair = this.pairs.get(run);
		if (pair) {
			this.pairs.delete(run);
			this.unwatch(pair);
			pair.terminal.dispose();
		}
	}

	async reveal(run: RunId, options: { readonly preserveFocus: boolean }): Promise<boolean> {
		return this.pairs.get(run)?.terminal.reveal(options.preserveFocus) ?? false;
	}

	tabOpen(run: RunId): boolean {
		return this.pairs.get(run)?.terminal.isOpen() ?? false;
	}

	reopen(run: RunId): void {
		this.pairs.get(run)?.terminal.open(false);
	}

	rename(run: RunId, name: string): void {
		this.pairs.get(run)?.terminal.rename(name);
	}

	tabLabel(run: RunId, alias: string, shown: boolean): void {
		this.pairs.get(run)?.terminal.label(alias, shown);
	}

	pinTab(run: RunId, pinned: boolean): void {
		this.terminals.pin(run, pinned);
	}

	spin(run: RunId, busy: boolean): void {
		this.pairs.get(run)?.terminal.pty.spin(busy);
	}

	hideTab(run: RunId): boolean {
		return this.pairs.get(run)?.terminal.hide() ?? false;
	}

	/** Opens a pinned agent's tab in its turn and waits for VS Code to open its terminal, as `AgentExecution.openPinned` does. */
	async openPinned(run: RunId): Promise<void> {
		const pair = this.pairs.get(run);
		const place = pair?.facts.tab;
		if (!pair || !pair.terminal.openInTurn(typeof place === 'object' ? place.column : undefined)) {
			return;
		}
		const opened = await Promise.race([pair.terminal.pty.nextOpen(), timeout(OPEN_WAIT_MS).then(() => undefined)]);
		if (opened === undefined) {
			this.options.log(`The terminal of ${run} did not open within ${OPEN_WAIT_MS / 1000} seconds; the pinned tabs after it open meanwhile.`);
		}
		await pair.terminal.markOpened(opened === true && this.pairs.get(run) === pair);
	}

	pinnedOpened(): void {
		this.terminals.turnsOver();
		// A pinned sequence is over: `Agents` says nothing more of it on this engine, so the predecessor's tabs are retired now
		void this.pinnedSequenceOver().catch(err => this.options.log(`Could not retire the tabs of the host before this one: ${messageOf(err)}`));
	}

	/**
	 * The activation's pinned tabs are open: the window component, which outlives an extension host that restarted, may close the tabs the
	 * host before this one left (ARCHITECTURE-2.2). `pinnedOpened` says it; a window with no Pin to open leaves it to its caller.
	 */
	async pinnedSequenceOver(): Promise<void> {
		await this.terminals.retirePredecessor();
	}

	systemMotion(reduced: boolean): void {
		this.terminals.systemMotion(reduced);
	}

	dispose(): void {
		for (const pair of this.pairs.values()) {
			this.unwatch(pair);
		}
		this.pairs.clear();
		this.terminals.dispose();
		for (const emitter of [this.activations, this.closes, this.renames, this.pins, this.placements]) {
			emitter.dispose();
		}
	}

	/** How `pair`'s terminal shows `agent`: its screen is watched from the moment the terminal asks for it, and no longer than it is open. */
	private binding(pair: Pair, agent: string): RunBinding {
		return {
			answersQueries: true,
			snapshot: () => new Promise<RunScreen>((resolve, reject) => {
				this.unwatch(pair);
				pair.pending = { resolve, reject };
				if (pair.remote && !pair.remote.reachable) { this.suspend(pair); }
				else { this.watchScreen(pair, agent); }
			}),
			input: data => { if (!pair.remote || pair.remote.ready) { this.link.notify('agent.type', { agent, raw: encodeTerminalInput(data) }); } },
			resize: (cols, rows) => { if (!pair.remote || pair.remote.ready) { this.link.notify('agent.resize', { agent, cols, rows }); } }
		};
	}

	private watchScreen(pair: Pair, agent: string): void {
		const args: ScreenWatchArgs = { agent, keep_scrollback: true };
		const watch: ScreenWatch = { agent };
		pair.watch = watch;
		const current = () => pair.watch === watch && pair.agent === watch.agent;
		const handle = this.link.watch<ScreenSnapshot, ScreenChange>('screen', args, {
			snapshot: snapshot => { if (current()) { this.snapshot(pair, snapshot); } },
			change: change => { if (current()) { this.change(pair, change); } },
			...pair.remote ? {
				disconnected: () => { if (current()) { this.suspend(pair); } },
				ended: error => {
					if (!current()) { return; }
					this.stopWatching(pair);
					this.suspend(pair);
					if (error.reason === 'unavailable') { this.retryScreen(pair, agent); }
				}
			} : {}
		});
		if (current()) { watch.handle = handle; } else { handle.dispose(); }
	}

	private retryScreen(pair: Pair, agent: string): void {
		const retry = setTimeout(() => {
			if (pair.retry !== retry) { return; }
			pair.retry = undefined;
			if (pair.agent === agent && pair.remote?.reachable && this.link.connected && pair.terminal.pty.isOpen) {
				this.watchScreen(pair, agent);
			}
		}, SCREEN_RETRY_MS);
		pair.retry = retry;
		retry.unref();
	}

	private suspend(pair: Pair): void {
		if (!pair.remote) { return; }
		pair.remote.ready = false;
		if (!pair.remote.noted && pair.terminal.pty.isOpen) {
			pair.remote.noted = true;
			pair.terminal.pty.note(vscode.l10n.t('Connection lost · reconnecting'));
		}
	}

	/** The watch's snapshot: the screen the terminal asked for, or, after a reconnection, a screen that replaces what it shows. */
	private snapshot(pair: Pair, snapshot: ScreenSnapshot): void {
		if (pair.remote && (!pair.remote.reachable || pair.agent !== agentAddress(snapshot))) { return; }
		pair.decoder = new StringDecoder('utf8');
		const screen = textOf(snapshot.redraw, pair.decoder);
		const seq = ++pair.seq;
		const pending = pair.pending;
		if (pending) {
			pair.pending = undefined;
			pending.resolve({ screen, seq, cols: snapshot.cols, rows: snapshot.rows });
		} else {
			pair.terminal.pty.output(seq, `\x1bc${screen}`);
		}
		if (pair.remote && pair.agent) {
			pair.remote.ready = true;
			pair.remote.noted = false;
			const dimensions = pair.terminal.pty.dimensions;
			if (dimensions && (dimensions.columns !== snapshot.cols || dimensions.rows !== snapshot.rows)) {
				this.link.notify('agent.resize', { agent: pair.agent, cols: dimensions.columns, rows: dimensions.rows });
			}
		}
	}

	private change(pair: Pair, change: ScreenChange): void {
		if (pair.remote && !pair.remote.ready) { return; }
		if (change.kind === 'output') {
			pair.terminal.pty.output(++pair.seq, textOf(change.data, pair.decoder));
		} else if (change.kind === 'redraw') {
			// It replaces the visible screen at the size it carries, which is the terminal's own: this window sets the size
			pair.decoder = new StringDecoder('utf8');
			pair.terminal.pty.output(++pair.seq, textOf(change.data, pair.decoder));
		}
		// `exit` and `removed` are the agents' to tell (`exited`, `removePair`)
	}

	private stopWatching(pair: Pair): void {
		const watch = pair.watch;
		pair.watch = undefined;
		clearTimeout(pair.retry);
		pair.retry = undefined;
		watch?.handle?.dispose();
	}

	private unwatch(pair: Pair): void {
		this.stopWatching(pair);
		if (pair.remote) { pair.remote.ready = false; pair.remote.noted = false; }
		const pending = pair.pending;
		pair.pending = undefined;
		pending?.reject(new Error('The screen was not watched to its end.'));
	}
}
