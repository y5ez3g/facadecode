/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { CancelledError } from '../async';
import { hashToken, newToken } from '../ipc';
import { UsageRecord } from '../model';
import { Ledger } from './ledger';
import { Caller, FACADE, KernelState, LedgerEvent, Message, Participant, ParticipantState, WriteMode, YOU } from './model';
import { agentName, formatAddress, groupName, NameError, pagePath, parseAddresses } from './names';
import { hashText, listPageFiles, NOTES_DIR, readPageFile, removePageFile, writePageFile } from './notebook';
import { foldersOf } from './state';

/*
 * The primitives that live in the workspace itself (L2-PLAN, step 26): who is here, the messages
 * between them, and the notebook. Every change is an event in the ledger before anything else sees
 * it. Starting and stopping agents, and the IDE, are the host's; they call in here to record what
 * they did.
 */

export class KernelError extends Error {
	constructor(readonly code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT', message: string) {
		super(message);
		this.name = 'KernelError';
	}
}

export interface KernelOptions {
	/** The workspace's folder under `~/.facade/workspaces`. */
	readonly dir: string;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
	readonly isAlive?: (pid: number) => boolean;
	/** Watch the notebook's files for edits made outside Facade's tools. */
	readonly watch?: boolean;
}

export interface ParticipantView {
	readonly name: string;
	readonly incarnation: number;
	readonly kind: Participant['kind'];
	readonly agent?: string;
	readonly place?: string;
	readonly state: ParticipantState;
	readonly stateDetail?: string;
	readonly since: number;
	readonly startedBy?: string;
	readonly groups: readonly string[];
	readonly lastSaid?: string;
	readonly lastSaidAt?: number;
	readonly unread: number;
	readonly usage?: UsageRecord;
}

export interface WhoAmI extends ParticipantView {
	/** The first message it was given. */
	readonly text?: string;
	readonly cursor: number;
	/** Where the notebook's files are, for reading them directly. */
	readonly notebook: string;
}

export interface SendResult {
	readonly seq: number;
	readonly recipients: readonly string[];
	/** Groups nobody is in yet. */
	readonly emptyGroups: readonly string[];
	/** Recipients that are stopped: they see it when started again under their name. */
	readonly stopped: readonly string[];
}

export interface RecvOptions {
	readonly after?: number;
	readonly waitSec?: number;
	readonly limit?: number;
}

export interface RecvResult {
	readonly messages: readonly Message[];
	readonly cursor: number;
	/** More are waiting than `limit` let through. */
	readonly more: boolean;
	readonly unread: number;
	readonly timedOut: boolean;
}

export interface PageView {
	readonly page: string;
	readonly text: string;
	readonly version: number;
	readonly author?: string;
	readonly ts: number;
}

export type WriteResult =
	| { readonly ok: true; readonly page: string; readonly version: number; readonly deleted: boolean }
	| { readonly ok: false; readonly page: string; readonly reason: 'conflict' | 'exists' | 'missing'; readonly current?: PageView };

export interface ListEntry {
	readonly page: string;
	readonly version: number;
	readonly author?: string;
	readonly ts: number;
	readonly size: number;
}

export interface NewAgent {
	readonly name: string;
	readonly agent: string;
	readonly place?: string;
	readonly startedBy?: string;
	readonly text?: string;
	readonly groups?: readonly string[];
}

const YOU_TOKEN_FILE = 'you.token';
const DEFAULT_RECV_LIMIT = 50;
const MAX_RECV_LIMIT = 200;
/** A wait stays under the hour every launch gives a tool call. */
export const MAX_WAIT_SEC = 3000;
const PROGRESS_MS = 15_000;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_PAGE_CHARS = 1_000_000;
const SCAN_DEBOUNCE_MS = 250;

interface Waiter {
	readonly name: string;
	wake(): void;
}

export class Kernel {

	readonly notesDir: string;
	private readonly waiters = new Set<Waiter>();
	private readonly now: () => number;
	private youTokenValue = '';
	private watcher: fs.FSWatcher | undefined;
	private scanTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	private constructor(private readonly options: KernelOptions, private readonly ledger: Ledger) {
		this.now = options.now ?? Date.now;
		this.notesDir = path.join(options.dir, NOTES_DIR);
	}

	/** Opens a workspace's ledger and notebook, making them the first time. */
	static open(options: KernelOptions): Kernel {
		const now = options.now ?? Date.now;
		const ledger = Ledger.open(options.dir, now, options.isAlive);
		const kernel = new Kernel(options, ledger);
		try {
			fs.mkdirSync(kernel.notesDir, { recursive: true });
			kernel.ensureYou();
			// Edits made to the pages while Facade was closed.
			kernel.scanNotebook();
			if (options.watch) {
				kernel.startWatching();
			}
		} catch (err) {
			kernel.dispose();
			throw err;
		}
		return kernel;
	}

	get state(): KernelState {
		return this.ledger.state;
	}

	get dir(): string {
		return this.options.dir;
	}

	/** The person's token, for the views and for scripts that act as @you. */
	get youToken(): string {
		return this.youTokenValue;
	}

	onDidAppend(listener: (event: LedgerEvent) => void): { dispose(): void } {
		return this.ledger.onDidAppend(listener);
	}

	eventsAfter(seq: number): readonly LedgerEvent[] {
		return this.ledger.eventsAfter(seq);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.watcher?.close();
		clearTimeout(this.scanTimer);
		for (const waiter of [...this.waiters]) {
			waiter.wake();
		}
		this.ledger.close();
	}

	/** Who holds a token, if it is still good. */
	authenticate(token: string): Caller | undefined {
		return this.state.tokens.get(hashToken(token));
	}

	/*
	 * Identity
	 */

	whoami(caller: Caller): WhoAmI {
		const participant = this.participant(caller.name);
		return { ...this.view(participant), text: participant.text, cursor: this.cursor(participant.name), notebook: this.notesDir };
	}

	who(group?: string): ParticipantView[] {
		const wanted = group === undefined || group === '' ? undefined : parse(() => groupName(group));
		const all = [...this.state.participants.values()].filter(participant => !wanted || participant.groups.has(wanted));
		all.sort((a, b) => a.name === YOU ? -1 : b.name === YOU ? 1 : a.joinedAt - b.joinedAt || a.name.localeCompare(b.name));
		return all.map(participant => this.view(participant));
	}

	private view(participant: Participant): ParticipantView {
		return {
			name: participant.name,
			incarnation: participant.incarnation,
			kind: participant.kind,
			agent: participant.agent,
			place: participant.place,
			state: participant.state,
			stateDetail: participant.stateDetail,
			since: participant.stateAt,
			startedBy: participant.startedBy,
			groups: [...participant.groups].sort(),
			lastSaid: participant.lastSaid,
			lastSaidAt: participant.lastSaidAt,
			unread: this.unread(participant.name),
			usage: participant.usage
		};
	}

	/*
	 * Messages
	 */

	send(caller: Caller, to: string | readonly string[], text: string, replyTo?: number): SendResult {
		const body = String(text ?? '');
		if (!body.trim()) {
			throw new KernelError('INVALID', 'A message needs text.');
		}
		if (body.length > MAX_MESSAGE_CHARS) {
			throw new KernelError('INVALID', `A message has at most ${MAX_MESSAGE_CHARS} characters; put long content in a page and send its path.`);
		}
		const addresses = parse(() => parseAddresses(to));
		const recipients = new Set<string>();
		const unknown: string[] = [];
		const emptyGroups: string[] = [];
		for (const address of addresses) {
			if (address.kind === 'participant') {
				if (!this.state.participants.has(address.name)) {
					unknown.push(`@${address.name}`);
				} else if (address.name !== caller.name) {
					recipients.add(address.name);
				}
				continue;
			}
			const members = [...this.state.participants.values()].filter(participant => participant.groups.has(address.name));
			if (!members.length) {
				emptyGroups.push(`#${address.name}`);
			}
			for (const member of members) {
				if (member.name !== caller.name) {
					recipients.add(member.name);
				}
			}
		}
		if (unknown.length) {
			throw new KernelError('NOT_FOUND', `Nobody here is called ${unknown.join(', ')}. Call who to see everyone.`);
		}
		if (replyTo !== undefined && !this.messageBySeq(replyTo)) {
			throw new KernelError('NOT_FOUND', `There is no message ${replyTo} to reply to.`);
		}
		const names = [...recipients];
		const event = this.ledger.append({ type: 'message.sent', from: caller.name, to: addresses.map(formatAddress), recipients: names, text: body, replyTo });
		this.wake(names);
		const stopped = names.filter(name => {
			const state = this.state.participants.get(name)?.state;
			return state === 'stopped' || state === 'failed';
		});
		return { seq: event.seq, recipients: names, emptyGroups, stopped };
	}

	async recv(caller: Caller, options: RecvOptions, signal?: AbortSignal, progress?: (message: string) => void): Promise<RecvResult> {
		const name = caller.name;
		const cursor = this.cursor(name);
		const after = Math.max(0, wholeNumber(options.after, cursor));
		const limit = Math.min(MAX_RECV_LIMIT, Math.max(1, wholeNumber(options.limit, DEFAULT_RECV_LIMIT)));
		const waitMs = Math.min(MAX_WAIT_SEC, Math.max(0, wholeNumber(options.waitSec, 0))) * 1000;
		let batch = this.messagesAfter(name, after, limit);
		let timedOut = false;
		if (!batch.length && waitMs > 0) {
			timedOut = !await this.waitForMessage(name, after, waitMs, signal, progress);
			batch = this.messagesAfter(name, after, limit);
		}
		const last = batch.length ? batch[batch.length - 1].seq : after;
		if (last > cursor) {
			this.ledger.append({ type: 'cursor.moved', name, cursor: last });
		}
		return { messages: batch, cursor: this.cursor(name), more: this.messagesAfter(name, last, 1).length > 0, unread: this.unread(name), timedOut };
	}

	join(caller: Caller, group: string): string[] {
		const name = parse(() => groupName(group));
		const participant = this.participant(caller.name);
		if (!participant.groups.has(name)) {
			this.ledger.append({ type: 'group.joined', name: caller.name, group: name });
		}
		return this.members(name);
	}

	leave(caller: Caller, group: string): string[] {
		const name = parse(() => groupName(group));
		const participant = this.participant(caller.name);
		if (participant.groups.has(name)) {
			this.ledger.append({ type: 'group.left', name: caller.name, group: name });
		}
		return this.members(name);
	}

	members(group: string): string[] {
		const name = parse(() => groupName(group));
		return [...this.state.participants.values()].filter(participant => participant.groups.has(name)).map(participant => participant.name);
	}

	unread(name: string): number {
		const inbox = this.state.inboxes.get(name);
		if (!inbox?.length) {
			return 0;
		}
		return inbox.length - firstAfter(inbox, this.cursor(name));
	}

	cursor(name: string): number {
		return this.state.cursors.get(name) ?? 0;
	}

	/** Takes `name`'s messages up to `seq` as read, as a `recv` that returned them would. */
	markRead(name: string, seq: number): void {
		if (seq > this.cursor(name)) {
			this.ledger.append({ type: 'cursor.moved', name, cursor: seq });
		}
	}

	/** A participant's messages after `seq`, oldest first, at most `limit`. */
	messagesAfter(name: string, seq: number, limit: number): Message[] {
		const inbox = this.state.inboxes.get(name) ?? [];
		const start = firstAfter(inbox, seq);
		return inbox.slice(start, start + limit);
	}

	messageBySeq(seq: number): Message | undefined {
		const messages = this.state.messages;
		let low = 0;
		let high = messages.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const found = messages[middle].seq;
			if (found === seq) {
				return messages[middle];
			}
			if (found < seq) {
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		return undefined;
	}

	/** Resolves true when a message after `seq` is there for `name`, false at the timeout. */
	private waitForMessage(name: string, seq: number, ms: number, signal?: AbortSignal, progress?: (message: string) => void): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new CancelledError());
				return;
			}
			const started = this.now();
			const finish = (result: boolean | Error) => {
				this.waiters.delete(waiter);
				clearTimeout(timer);
				clearInterval(ticker);
				signal?.removeEventListener('abort', onAbort);
				if (result instanceof Error) {
					reject(result);
				} else {
					resolve(result);
				}
			};
			const waiter: Waiter = {
				name,
				wake: () => finish(this.disposed ? false : this.messagesAfter(name, seq, 1).length > 0)
			};
			const onAbort = () => finish(new CancelledError());
			const timer = setTimeout(() => finish(false), ms);
			const ticker = setInterval(() => progress?.(`Waiting for messages (${Math.round((this.now() - started) / 1000)}s)`), PROGRESS_MS);
			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiters.add(waiter);
		});
	}

	private wake(names: readonly string[]): void {
		const wanted = new Set(names);
		for (const waiter of [...this.waiters]) {
			if (wanted.has(waiter.name)) {
				waiter.wake();
			}
		}
	}

	/** Facade's own message to some participants: a page changed, an agent stopped. */
	notice(names: readonly string[], text: string): void {
		const recipients = [...new Set(names)].filter(name => this.state.participants.has(name));
		if (!recipients.length) {
			return;
		}
		this.ledger.append({ type: 'message.sent', from: FACADE, to: recipients.map(name => `@${name}`), recipients, text, notice: true });
		this.wake(recipients);
	}

	/*
	 * The notebook
	 */

	read(caller: Caller, page: string): PageView {
		const name = parse(() => pagePath(page));
		this.syncPage(name);
		const info = this.state.pages.get(name);
		const text = info && !info.deleted ? readPageFile(this.notesDir, name) : undefined;
		if (!info || info.deleted || text === undefined) {
			const siblings = this.pagesUnder(name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '').slice(0, 10).map(entry => entry.page);
			throw new KernelError('NOT_FOUND', `There is no page ${name}.${siblings.length ? ` Pages near it: ${siblings.join(', ')}.` : ''}`);
		}
		this.ledger.append({ type: 'page.read', name: caller.name, page: name, version: info.version });
		return { page: name, text, version: info.version, author: info.author, ts: info.ts };
	}

	write(caller: Caller, page: string, text: string, mode: WriteMode = 'replace', ifVersion?: number): WriteResult {
		const name = parse(() => pagePath(page));
		const body = String(text ?? '');
		if (body.length > MAX_PAGE_CHARS) {
			throw new KernelError('INVALID', `A page has at most ${MAX_PAGE_CHARS} characters.`);
		}
		if (mode !== 'replace' && mode !== 'append' && mode !== 'create') {
			throw new KernelError('INVALID', `mode is replace, append or create, not ${mode}.`);
		}
		this.syncPage(name);
		const info = this.state.pages.get(name);
		const exists = !!info && !info.deleted;
		const currentText = exists ? readPageFile(this.notesDir, name) ?? '' : undefined;
		const current = (): PageView | undefined => exists ? { page: name, text: currentText!, version: info!.version, author: info!.author, ts: info!.ts } : undefined;
		if (mode === 'create' && exists) {
			return { ok: false, page: name, reason: 'exists', current: current() };
		}
		if (typeof ifVersion === 'number' && Number.isFinite(ifVersion)) {
			const version = exists ? info!.version : 0;
			if (Math.floor(ifVersion) !== version) {
				return { ok: false, page: name, reason: 'conflict', current: current() };
			}
		}
		const version = (info?.version ?? 0) + 1;
		if (mode === 'replace' && body === '') {
			if (!exists) {
				return { ok: false, page: name, reason: 'missing' };
			}
			const readers = this.readersToTell(name, caller.name);
			const watchers = this.folderWatchersToTell(name, caller.name);
			removePageFile(this.notesDir, name);
			this.ledger.append({ type: 'page.written', page: name, version, author: caller.name, mode: 'delete', hash: '', size: 0, deleted: true });
			this.notice(readers, `${name} was deleted by @${caller.name}.`);
			this.notice(watchers, `${name} was deleted by @${caller.name}.`);
			return { ok: true, page: name, version, deleted: true };
		}
		const next = mode === 'append' && currentText !== undefined ? appendText(currentText, body) : mode === 'append' ? appendText('', body) : body;
		const readers = this.readersToTell(name, caller.name);
		const watchers = exists ? [] : this.folderWatchersToTell(name, caller.name);
		writePageFile(this.notesDir, name, next);
		this.ledger.append({ type: 'page.written', page: name, version, author: caller.name, mode, hash: hashText(next), size: Buffer.byteLength(next, 'utf8') });
		this.notice(readers, `${name} changed: version ${version}, by @${caller.name}.`);
		this.notice(watchers, `New page ${name}, by @${caller.name}.`);
		return { ok: true, page: name, version, deleted: false };
	}

	list(caller: Caller, folder: string): ListEntry[] {
		const name = parse(() => pagePath(folder, true));
		this.scanNotebook();
		const entries = this.pagesUnder(name);
		this.ledger.append({ type: 'folder.listed', name: caller.name, folder: name });
		return entries;
	}

	private pagesUnder(folder: string): ListEntry[] {
		const prefix = folder ? `${folder}/` : '';
		return [...this.state.pages.values()]
			.filter(info => !info.deleted && info.page.startsWith(prefix))
			.sort((a, b) => a.page.localeCompare(b.page))
			.map(info => ({ page: info.page, version: info.version, author: info.author, ts: info.ts, size: info.size }));
	}

	/** Who read `page` and has not heard of a change since, other than `except`. */
	private readersToTell(page: string, except: string | undefined): string[] {
		return [...(this.state.readers.get(page)?.keys() ?? [])].filter(name => name !== except);
	}

	/** Who listed a folder `page` is in, other than `except`: they hear when it comes or goes. */
	private folderWatchersToTell(page: string, except: string | undefined): string[] {
		const names = new Set<string>();
		for (const folder of foldersOf(page)) {
			for (const name of this.state.folderWatchers.get(folder) ?? []) {
				if (name !== except) {
					names.add(name);
				}
			}
		}
		return [...names];
	}

	/**
	 * Brings the ledger level with a page's file: a file changed, made or removed outside Facade's
	 * tools is a version without an author. `author` names who did it, when the host knows.
	 */
	syncPage(page: string, author?: string): void {
		const text = readPageFile(this.notesDir, page);
		const info = this.state.pages.get(page);
		const exists = !!info && !info.deleted;
		if (text === undefined) {
			if (exists) {
				const readers = this.readersToTell(page, author);
				const watchers = this.folderWatchersToTell(page, author);
				this.ledger.append({ type: 'page.written', page, version: info!.version + 1, author, mode: 'direct', hash: '', size: 0, deleted: true });
				const by = author ? `by @${author}` : 'directly, outside Facade';
				this.notice(readers, `${page} was deleted ${by}.`);
				this.notice(watchers, `${page} was deleted ${by}.`);
			}
			return;
		}
		const hash = hashText(text);
		if (exists && info!.hash === hash) {
			return;
		}
		const version = (info?.version ?? 0) + 1;
		const readers = this.readersToTell(page, author);
		const watchers = exists ? [] : this.folderWatchersToTell(page, author);
		this.ledger.append({ type: 'page.written', page, version, author, mode: 'direct', hash, size: Buffer.byteLength(text, 'utf8') });
		const by = author ? `by @${author}` : 'edited directly, outside Facade';
		this.notice(readers, `${page} changed: version ${version}, ${by}.`);
		this.notice(watchers, `New page ${page}, ${by}.`);
	}

	/** Brings the ledger level with every page file. */
	scanNotebook(): void {
		if (this.disposed) {
			return;
		}
		const onDisk = new Set<string>();
		for (const file of listPageFiles(this.notesDir).sort()) {
			let page: string;
			try {
				page = pagePath(file);
			} catch {
				continue;
			}
			if (page !== file) {
				// Upper case or an odd name: not a page Facade can address, so not one it tracks.
				continue;
			}
			onDisk.add(page);
			this.syncPage(page);
		}
		for (const [page, info] of this.state.pages) {
			if (!info.deleted && !onDisk.has(page)) {
				this.syncPage(page);
			}
		}
	}

	private startWatching(): void {
		try {
			this.watcher = fs.watch(this.notesDir, { recursive: true }, () => {
				clearTimeout(this.scanTimer);
				this.scanTimer = setTimeout(() => {
					try {
						this.scanNotebook();
					} catch (err) {
						this.options.log?.(`[kernel] scanning the notebook failed: ${(err as Error).message}`);
					}
				}, SCAN_DEBOUNCE_MS);
			});
			this.watcher.on('error', err => this.options.log?.(`[kernel] watching the notebook failed: ${err.message}`));
		} catch (err) {
			this.options.log?.(`[kernel] the notebook is not watched: ${(err as Error).message}`);
		}
	}

	/*
	 * Participants, for the host that starts and stops agents
	 */

	/** Adds an agent, or a new incarnation of one; returns the token its MCP server calls with. */
	addAgent(agent: NewAgent): { readonly name: string; readonly incarnation: number; readonly token: string } {
		const name = agentName(agent.name);
		const previous = this.state.participants.get(name);
		const incarnation = (previous?.incarnation ?? 0) + 1;
		const token = newToken();
		const groups = [...new Set((agent.groups ?? []).map(group => groupName(group)))];
		this.ledger.append({
			type: 'participant.joined',
			name,
			incarnation,
			kind: 'agent',
			agent: agent.agent,
			place: agent.place,
			startedBy: agent.startedBy,
			text: agent.text,
			groups,
			tokenHash: hashToken(token)
		});
		return { name, incarnation, token };
	}

	/** A name like `codex-3` that nobody has. */
	freeName(prefix: string): string {
		const base = agentName(prefix.replace(/[^a-z0-9._-]/gi, '-').replace(/^-+/, '') || 'agent');
		for (let i = 1; ; i++) {
			const name = `${base}-${i}`;
			if (!this.state.participants.has(name)) {
				return name;
			}
		}
	}

	/** Records an agent's state, and tells whoever started it about the changes that matter. */
	setState(name: string, incarnation: number, state: ParticipantState, detail?: string): void {
		const participant = this.state.participants.get(name);
		if (!participant || participant.incarnation !== incarnation) {
			return;
		}
		const before = participant.state;
		if (before === state && participant.stateDetail === detail) {
			return;
		}
		if ((before === 'stopped' || before === 'failed') && state !== 'stopped' && state !== 'failed') {
			// A stopped incarnation does not come back; a new one does.
			return;
		}
		this.ledger.append({ type: 'participant.state', name, incarnation, state, detail });
		const told = participant.startedBy;
		if (!told || told === name) {
			return;
		}
		const suffix = detail ? `: ${detail}` : '.';
		if (state === 'working' && before === 'starting') {
			this.notice([told], `@${name} started working.`);
		} else if (state === 'waiting') {
			this.notice([told], `@${name} is waiting in its terminal${suffix}`);
		} else if (state === 'idle' && before !== 'idle') {
			this.notice([told], `@${name} finished its turn.`);
		} else if (state === 'stopped' && before !== 'stopped') {
			this.notice([told], `@${name} stopped${suffix}`);
		} else if (state === 'failed' && before !== 'failed') {
			this.notice([told], `@${name} failed${suffix}`);
		}
	}

	setUsage(name: string, incarnation: number, usage: UsageRecord): void {
		const participant = this.state.participants.get(name);
		if (participant && participant.incarnation === incarnation) {
			this.ledger.append({ type: 'participant.usage', name, incarnation, usage });
		}
	}

	participant(name: string): Participant {
		const participant = this.state.participants.get(name);
		if (!participant) {
			throw new KernelError('NOT_FOUND', `Nobody here is called @${name}.`);
		}
		return participant;
	}

	/** Makes sure the person is a participant, with a token in a file only the user can read. */
	private ensureYou(): void {
		const file = path.join(this.options.dir, YOU_TOKEN_FILE);
		let token: string | undefined;
		try {
			token = fs.readFileSync(file, 'utf8').trim() || undefined;
		} catch {
			token = undefined;
		}
		const you = this.state.participants.get(YOU);
		if (token && you && you.tokenHash === hashToken(token)) {
			this.youTokenValue = token;
			return;
		}
		token = newToken();
		fs.writeFileSync(file, token, { mode: 0o600 });
		this.ledger.append({ type: 'participant.joined', name: YOU, incarnation: (you?.incarnation ?? 0) + 1, kind: 'person', groups: [...(you?.groups ?? [])], tokenHash: hashToken(token) });
		this.youTokenValue = token;
	}
}

function parse<T>(action: () => T): T {
	try {
		return action();
	} catch (err) {
		if (err instanceof NameError) {
			throw new KernelError('INVALID', err.message);
		}
		throw err;
	}
}

/** The index of the first message after `seq` in a list ordered by seq. */
function firstAfter(messages: readonly Message[], seq: number): number {
	let low = 0;
	let high = messages.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (messages[middle].seq <= seq) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

/** `text` added as its own lines at the end of `current`. */
function appendText(current: string, text: string): string {
	const separator = current === '' || current.endsWith('\n') ? '' : '\n';
	const addition = text.endsWith('\n') ? text : `${text}\n`;
	return `${current}${separator}${addition}`;
}

/** A whole number from a tool argument, or `fallback` when it is not one. */
function wholeNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}
