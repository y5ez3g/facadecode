/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The focus probe's input (focusProbe.ts, focusProbeDriver.ts): CDP-injected keyboard events into an isolated editor's own workbench
// page, at the DevTools endpoint its `--remote-debugging-port` opens on this computer's loopback. Its renderer takes them as it takes a
// keyboard's - wherever its own DOM focus is, whatever window the system has in front - and the page says where its focus is and what
// each key event reached. They are not OS-level keyboard or IME input, which never passes through here and which this does not cover.

import * as crypto from 'crypto';
import * as http from 'http';

/** One DevTools target, as `/json/list` gives it. */
export interface CdpTarget {
	readonly id: string;
	readonly type: string;
	readonly title: string;
	readonly url: string;
	readonly webSocketDebuggerUrl?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The targets of the DevTools endpoint at `port`, on this computer's loopback alone. */
export function listTargets(port: number): Promise<CdpTarget[]> {
	return new Promise((resolve, reject) => {
		const request = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3_000 }, response => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { body += chunk; });
			response.on('end', () => {
				try {
					resolve(JSON.parse(body) as CdpTarget[]);
				} catch (err) {
					reject(err);
				}
			});
		});
		request.on('timeout', () => request.destroy(new Error('timed out')));
		request.on('error', reject);
	});
}

interface Socket {
	readonly kind: string;
	send(text: string): void;
	close(): void;
}

/** A WebSocket to `url`: the runtime's own where it has one, else a minimal RFC 6455 client - text frames, masked, no extensions. */
function openSocket(url: string, onMessage: (text: string) => void, onClose: () => void): Promise<Socket> {
	type Native = { onopen: () => void; onerror: (event: unknown) => void; onmessage: (event: { data: unknown }) => void; onclose: () => void; send(text: string): void; close(): void };
	const Runtime = (globalThis as unknown as { WebSocket?: new (url: string) => Native }).WebSocket;
	if (typeof Runtime === 'function') {
		return new Promise((resolve, reject) => {
			const socket = new Runtime(url);
			socket.onopen = () => resolve({ kind: 'the runtime\'s WebSocket', send: text => socket.send(text), close: () => socket.close() });
			socket.onerror = event => reject(new Error(`WebSocket error: ${String((event as { message?: string } | undefined)?.message ?? event)}`));
			socket.onmessage = event => onMessage(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8'));
			socket.onclose = () => onClose();
		});
	}
	const target = new URL(url);
	const key = crypto.randomBytes(16).toString('base64');
	return new Promise((resolve, reject) => {
		const request = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
		request.on('error', reject);
		request.on('response', response => reject(new Error(`No WebSocket upgrade: HTTP ${response.statusCode}`)));
		request.on('upgrade', (_response, socket, head) => {
			let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
			let parts: Buffer[] = [];
			const frame = (opcode: number, payload: Buffer) => {
				const mask = crypto.randomBytes(4);
				const length = payload.length;
				let header: Buffer;
				if (length < 126) {
					header = Buffer.from([0x80 | opcode, 0x80 | length]);
				} else if (length < 65_536) {
					header = Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255]);
				} else {
					header = Buffer.alloc(10);
					header[0] = 0x80 | opcode;
					header[1] = 0x80 | 127;
					header.writeBigUInt64BE(BigInt(length), 2);
				}
				const masked = Buffer.alloc(length);
				for (let at = 0; at < length; at++) {
					masked[at] = payload[at] ^ mask[at & 3];
				}
				socket.write(Buffer.concat([header, mask, masked]));
			};
			socket.on('data', (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				for (;;) {
					if (buffer.length < 2) {
						return;
					}
					const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0;
					let length = buffer[1] & 0x7f, offset = 2;
					if (length === 126) {
						if (buffer.length < 4) { return; }
						length = buffer.readUInt16BE(2);
						offset = 4;
					} else if (length === 127) {
						if (buffer.length < 10) { return; }
						length = Number(buffer.readBigUInt64BE(2));
						offset = 10;
					}
					const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
					offset += masked ? 4 : 0;
					if (buffer.length < offset + length) {
						return;
					}
					let payload = Buffer.from(buffer.subarray(offset, offset + length));
					if (maskKey) {
						payload = Buffer.from(payload.map((byte, at) => byte ^ maskKey[at & 3]));
					}
					buffer = buffer.subarray(offset + length);
					if (opcode === 8) {
						socket.end();
						return;
					}
					if (opcode === 9) {
						frame(10, payload);
						continue;
					}
					if (opcode === 10) {
						continue;
					}
					parts.push(payload);
					if (fin) {
						const text = Buffer.concat(parts).toString('utf8');
						parts = [];
						onMessage(text);
					}
				}
			});
			socket.on('close', onClose);
			socket.on('error', () => undefined);
			resolve({
				kind: 'a minimal RFC 6455 client',
				send: text => frame(1, Buffer.from(text, 'utf8')),
				close: () => {
					try {
						frame(8, Buffer.alloc(0));
					} catch {
						// Gone already
					}
					socket.end();
				}
			});
		});
		request.end();
	});
}

/** One DevTools session over a WebSocket: commands and their answers, in order. */
export class Cdp {
	private next = 0;
	private readonly waiting = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (err: Error) => void }>();
	private socket: Socket | undefined;
	closed = false;

	static async open(url: string): Promise<Cdp> {
		const cdp = new Cdp();
		cdp.socket = await openSocket(url, text => cdp.message(text), () => cdp.gone());
		return cdp;
	}

	get kind(): string {
		return this.socket?.kind ?? 'none';
	}

	private message(text: string): void {
		const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message: string; code: number } };
		if (message.id === undefined) {
			return;
		}
		const waiting = this.waiting.get(message.id);
		if (waiting) {
			this.waiting.delete(message.id);
			if (message.error) {
				waiting.reject(new Error(`${message.error.message} (${message.error.code})`));
			} else {
				waiting.resolve(message.result);
			}
		}
	}

	private gone(): void {
		this.closed = true;
		for (const waiting of this.waiting.values()) {
			waiting.reject(new Error('The DevTools connection closed.'));
		}
		this.waiting.clear();
	}

	send<T = unknown>(method: string, params: object = {}): Promise<T> {
		if (this.closed || !this.socket) {
			return Promise.reject(new Error('The DevTools connection is closed.'));
		}
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			this.waiting.set(id, { resolve: value => resolve(value as T), reject });
			this.socket!.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate<T>(expression: string): Promise<T> {
		const answer = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true });
		if (answer.exceptionDetails) {
			throw new Error(`Evaluation failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? 'unknown'}`);
		}
		return answer.result.value as T;
	}

	close(): void {
		this.socket?.close();
		this.closed = true;
	}
}

/** Where a DOM element is in the workbench, as the page's `describe` tells it. */
export interface Where {
	/** `code-editor`, `terminal` (an editor tab's), `panel-terminal`, `webview`, `quick-input`, `list`, `other` or `body`. */
	readonly where: string;
	readonly tag?: string;
	readonly part?: string;
	/** Its editor group, by its place among the main window's groups, from 1. */
	readonly group?: number;
	/** The text of its group's active tab. */
	readonly tab?: string;
	readonly uri?: string;
	readonly extension?: string;
	readonly purpose?: string;
	readonly pane?: string;
	readonly view?: string;
	readonly panelTab?: string;
	readonly value?: string;
	readonly cls?: string;
}

/** A key event the page's own document saw in its capture phase, before any handler of the workbench's. */
export interface RendererKey {
	readonly t: number;
	readonly type: string;
	readonly key?: string;
	readonly data?: string | null;
	readonly meta?: boolean;
	readonly ctrl?: boolean;
	readonly target: Where;
}

/** The page's DOM focus from `t`: the element it is on, and whether the page has the focus. */
export interface FocusEntry {
	readonly t: number;
	readonly d: Where;
	readonly hasFocus: boolean;
}

function fileOf(where: Where): string {
	if (where.uri) {
		try {
			return decodeURIComponent(where.uri.split('/').pop() ?? where.uri);
		} catch {
			return where.uri;
		}
	}
	return `"${where.tab ?? '?'}"`;
}

/** `where` in a few words: what places are compared by, and what the evidence says. */
export function whereName(where: Where | undefined): string {
	if (!where) {
		return 'unknown';
	}
	switch (where.where) {
		case 'code-editor':
			return `editor g${where.group ?? '?'} ${fileOf(where)}`;
		case 'terminal':
			return `terminal g${where.group ?? '?'} "${where.tab ?? '?'}"`;
		case 'panel-terminal':
			return `panel terminal "${where.panelTab ?? '?'}"`;
		case 'webview':
			return `webview ${where.extension ?? '?'}${where.purpose ? ` (${where.purpose})` : ''}${where.group ? ` g${where.group}` : ''}`;
		case 'quick-input':
			return 'quick input';
		case 'list':
			return `list ${where.part ?? ''} ${where.pane ?? where.view ?? ''}`.replace(/\s+/g, ' ').trim();
		case 'body':
			return 'nothing (document body)';
		default:
			return `${where.where} ${where.part ?? ''} ${where.group ? `g${where.group}` : ''} ${where.tab ? `"${where.tab}"` : ''} ${where.cls ?? ''}`.replace(/\s+/g, ' ').trim();
	}
}

/**
 * Installed once in the page: where each element is, the key events its document sees in their capture phase and its DOM focus as
 * it changes - polled every 10 ms as well, since a focus going into a webview's frame fires nothing in this document. It only looks.
 */
const INSTRUMENT = String.raw`(() => {
	if (window.__fprobe) { return 'kept'; }
	const probe = { keys: [], focus: [], last: '' };
	window.__fprobe = probe;
	const text = el => el ? String(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : undefined;
	const describe = el => {
		if (!el || el === document.body || el === document.documentElement || !el.closest) { return { where: 'body' }; }
		const d = { tag: String(el.tagName || '').toLowerCase() };
		const part = el.closest('.part');
		if (part) { d.part = ['editor', 'panel', 'sidebar', 'auxiliarybar', 'titlebar', 'statusbar', 'activitybar'].find(name => part.classList.contains(name)) || part.id || 'part'; }
		const quick = el.closest('.quick-input-widget');
		if (quick) { d.where = 'quick-input'; const input = quick.querySelector('input'); d.value = input ? input.value : undefined; return d; }
		const group = el.closest('.editor-group-container');
		if (group) {
			const groups = Array.from(document.querySelectorAll('.part.editor .editor-group-container'));
			d.group = groups.indexOf(group) + 1;
			d.tab = text(group.querySelector('.tab.active'));
		}
		if (el.tagName === 'IFRAME' || el.closest('.webview')) {
			d.where = 'webview';
			const src = String(el.getAttribute('src') || '');
			const id = /[?&]extensionId=([^&]+)/.exec(src);
			if (id) { d.extension = decodeURIComponent(id[1]); }
			const purpose = /[?&]purpose=([^&]+)/.exec(src);
			if (purpose) { d.purpose = decodeURIComponent(purpose[1]); }
			return d;
		}
		if (el.closest('.xterm, .terminal-wrapper, .terminal-instance, .terminal-editor')) { d.where = d.part === 'panel' ? 'panel-terminal' : 'terminal'; }
		else if (el.closest('.monaco-editor')) { d.where = 'code-editor'; d.uri = el.closest('.monaco-editor').getAttribute('data-uri') || undefined; }
		else if (el.closest('.monaco-list, .monaco-tree, .monaco-tl-row')) { d.where = 'list'; }
		else { d.where = 'other'; d.cls = String(el.className || '').split(' ').slice(0, 3).join('.'); }
		if (d.part === 'panel') { d.panelTab = text(document.querySelector('.part.panel .terminal-tabs-entry.is-active')) || text(document.querySelector('.part.panel .terminal-tabs-entry')); }
		if (d.part === 'sidebar' || d.part === 'auxiliarybar') {
			const pane = el.closest('.pane');
			d.pane = pane ? text(pane.querySelector('.pane-header .title')) : undefined;
			const composite = el.closest('.composite');
			d.view = composite ? composite.id : undefined;
		}
		return d;
	};
	probe.describe = describe;
	const poll = () => {
		const d = describe(document.activeElement);
		const focused = document.hasFocus();
		const key = JSON.stringify(Object.assign({}, d, { value: undefined })) + focused;
		if (key !== probe.last) { probe.last = key; probe.focus.push({ t: Date.now(), d, hasFocus: focused }); }
	};
	window.addEventListener('keydown', e => probe.keys.push({ t: Date.now(), type: 'keydown', key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, target: describe(e.target) }), true);
	window.addEventListener('beforeinput', e => probe.keys.push({ t: Date.now(), type: 'beforeinput', data: e.data, target: describe(e.target) }), true);
	document.addEventListener('focusin', poll, true);
	document.addEventListener('focusout', () => setTimeout(poll, 0), true);
	setInterval(poll, 10);
	poll();
	return 'installed';
})()`;

/** A printable key: its code and virtual key code; a capital is typed with Shift. */
function keyOf(char: string): { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; modifiers: number } {
	const upper = char >= 'A' && char <= 'Z', digit = char >= '0' && char <= '9';
	const code = digit ? `Digit${char}` : `Key${char.toUpperCase()}`;
	const vk = char.toUpperCase().charCodeAt(0);
	return { key: char, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: upper ? 8 : 0 };
}

/** The modifier keys a chord holds: their event fields and their bit in CDP's `modifiers`. */
const MODIFIERS = {
	meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91, bit: 4 },
	ctrl: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, bit: 2 }
} as const;

/**
 * How a printable key is injected: `keyDown+text` - a keyDown carrying its text, then keyUp, Chromium making its keypress and input
 * events itself and leaving them out where the keydown was cancelled, as it does for a keyboard - or `keyDown+char`, a keyDown, a
 * separate char event and a keyUp, whose char Chromium delivers even after a cancelled keydown: an xterm.js terminal then takes the key
 * twice.
 */
export type KeyForm = 'keyDown+text' | 'keyDown+char';

/** The isolated editor's workbench page, driven by CDP-injected keyboard events and watched where its DOM focus goes. */
export class Workbench {
	form: KeyForm = 'keyDown+text';

	private constructor(readonly cdp: Cdp, readonly target: CdpTarget, readonly title: string) { }

	/**
	 * A page at `port` that `accept` takes, by its target, its title and whether it is a main window's workbench - one with a side bar,
	 * which a floating editor window has not. Only the isolated editor's own pages are there: `--remote-debugging-port` binds this
	 * computer's loopback, and the port is that editor's own.
	 */
	static async find(port: number, accept: (page: { readonly target: CdpTarget; readonly title: string; readonly main: boolean }) => boolean, ms = 60_000): Promise<Workbench> {
		const end = Date.now() + ms;
		let last = 'nothing listed';
		for (;;) {
			try {
				const pages = (await listTargets(port)).filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
				last = pages.length ? last : 'no page listed';
				for (const page of pages) {
					const cdp = await Cdp.open(page.webSocketDebuggerUrl!);
					const seen = JSON.parse(await cdp.evaluate<string>('JSON.stringify({ title: document.title, main: !!document.querySelector(".part.sidebar") })').catch(() => '{"title":"","main":false}')) as { title: string; main: boolean };
					if (accept({ target: page, ...seen })) {
						return new Workbench(cdp, page, seen.title);
					}
					last = `a page titled ${JSON.stringify(seen.title)}${seen.main ? '' : ' (no side bar)'}`;
					cdp.close();
				}
			} catch (err) {
				last = err instanceof Error ? err.message : String(err);
			}
			if (Date.now() > end) {
				throw new Error(`No such page at DevTools port ${port}: ${last}`);
			}
			await sleep(250);
		}
	}

	/** The main window's workbench page at `port`, whose title names `folder`: no other page is driven. */
	static connect(port: number, folder: string, ms = 60_000): Promise<Workbench> {
		return Workbench.find(port, page => /workbench/.test(page.target.url) && page.main && page.title.includes(folder), ms);
	}

	/**
	 * The watch of its DOM focus and its key events; `emulate`, its focus emulated as well - the page takes itself to have the system's
	 * focus, as a window a person types in has. A floating window's is watched as it is, unemulated: whether it has the system's focus.
	 */
	async install(emulate = true): Promise<string> {
		if (emulate) {
			await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
		}
		return await this.cdp.evaluate<string>(INSTRUMENT);
	}

	/** The key events and focus changes the page saw since the last drain. */
	async drain(): Promise<{ keys: RendererKey[]; focus: FocusEntry[] }> {
		const text = await this.cdp.evaluate<string>('JSON.stringify(window.__fprobe ? { keys: window.__fprobe.keys.splice(0), focus: window.__fprobe.focus.splice(0) } : { keys: [], focus: [] })');
		return JSON.parse(text) as { keys: RendererKey[]; focus: FocusEntry[] };
	}

	/** Where the page's DOM focus is now. */
	async active(): Promise<FocusEntry> {
		const text = await this.cdp.evaluate<string>('JSON.stringify({ t: Date.now(), d: window.__fprobe ? window.__fprobe.describe(document.activeElement) : { where: "unknown" }, hasFocus: document.hasFocus() })');
		return JSON.parse(text) as FocusEntry;
	}

	/** The editor group the page draws as its active one, by its place among the main window's groups from 1; 0 for none. */
	async activeGroup(): Promise<number> {
		return await this.cdp.evaluate<number>('Array.from(document.querySelectorAll(".part.editor .editor-group-container")).findIndex(group => group.classList.contains("active")) + 1');
	}

	/** One printable character as a key, in this page's `form`: the renderer delivers it to its focused element. */
	async key(char: string): Promise<void> {
		const key = keyOf(char);
		if (this.form === 'keyDown+char') {
			await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
			await this.cdp.send('Input.dispatchKeyEvent', { type: 'char', ...key, text: char, unmodifiedText: char });
		} else {
			await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: char, unmodifiedText: char });
		}
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
	}

	/** Text committed as an input method commits it: Input.insertText, with no key events. */
	async insertText(text: string): Promise<void> {
		await this.cdp.send('Input.insertText', { text });
	}

	/**
	 * A shortcut, its modifier held through it: Cmd with a digit or a letter, or Ctrl+Tab. Ctrl+Tab's picker accepts its selection as
	 * Control is let go, a moment later, as a person's hand does.
	 */
	async chord(name: `cmd+${string}` | 'ctrl+tab'): Promise<void> {
		const modifier = name === 'ctrl+tab' ? MODIFIERS.ctrl : MODIFIERS.meta;
		const { bit, ...held } = modifier;
		const last = name.slice(-1);
		const main = name === 'ctrl+tab' ? { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
			: { key: last, code: last >= '0' && last <= '9' ? `Digit${last}` : `Key${last.toUpperCase()}`, windowsVirtualKeyCode: last.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: last.toUpperCase().charCodeAt(0) };
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...held, modifiers: bit });
		await sleep(20);
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...main, modifiers: bit });
		await sleep(name === 'ctrl+tab' ? 150 : 20);
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...main, modifiers: bit });
		await sleep(name === 'ctrl+tab' ? 80 : 20);
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...held, modifiers: 0 });
	}

	close(): void {
		this.cdp.close();
	}
}
