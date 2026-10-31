/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The shim's one connection to ptyd (MCP-6.1): it says hello as the run's shim, then asks each tool call - concurrent calls
// matched by number - and ptyd carries it to the window that claims the run. A lost connection is made again for the next call.
// Both directions are ptyd's newline JSON within its line bound, which a call larger than that bound is never sent past.

import * as net from 'net';
import { lineReader, MAX_JSON_LINE_BYTES } from '../base/lines';
import { TOOL_PROTOCOL, ToolCall } from '../schema/protocol';
import type { FailureCode } from './failure';

/**
 * The ptyd protocol the shim speaks: ptyd's own `PTYD_PROTOCOL`, which the layers keep this one from importing - a test holds the
 * two equal. A ptyd of another protocol refuses the shim's hello.
 */
export const SHIM_PTYD_PROTOCOL = 9;

/** How long ptyd has to answer the shim's hello: the two seconds of a call's first response (RULES-1.2). */
const HELLO_WAIT_MS = 2_000;

/** Why a call came back with no window's answer, as MCP-1.2 reports it, and whether it may have acted. */
export class CallFailed extends Error {
	constructor(readonly code: FailureCode, readonly reason: string, readonly outcome: 'none' | 'unknown', message: string) {
		super(message);
	}
}

/** ptyd's answer to one request, as its protocol gives it. */
interface Answer {
	readonly id: number;
	readonly result?: unknown;
	readonly error?: string;
	readonly reason?: string;
	readonly effects?: 'none' | 'unknown';
}

/** One connection to ptyd: requests numbered, each answered once by its number. */
class Connection {

	private nextId = 1;
	private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(err: CallFailed): void }>();
	private closed = false;
	/** Why the connection was given up, where the shim gave it up itself. */
	private givenUp: string | undefined;

	constructor(readonly socket: net.Socket, private readonly maxLineBytes: number, onClose: () => void) {
		socket.on('data', lineReader(line => this.heard(line), err => {
			this.givenUp = `the agent runtime (ptyd) sent an answer longer than one line may be (${err.message})`;
			socket.destroy();
		}, { maxBytes: maxLineBytes }));
		socket.on('close', () => {
			this.closed = true;
			const why = this.givenUp ?? 'the connection to the agent runtime (ptyd) closed before the window answered';
			for (const waiting of this.waiting.values()) {
				waiting.reject(new CallFailed('UNAVAILABLE', 'window_unavailable', 'unknown', `${capitalized(why)}: the call may have taken effect.`));
			}
			this.waiting.clear();
			onClose();
		});
		socket.on('error', () => socket.destroy());
	}

	request(method: string, params: object): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(notCarried('the connection to the agent runtime (ptyd) closed'));
		}
		const id = this.nextId++;
		const line = JSON.stringify({ id, method, params });
		const bytes = Buffer.byteLength(line, 'utf8');
		if (bytes > this.maxLineBytes) {
			// ptyd would read no request of it and close the connection, and every call on it with that
			return Promise.reject(new CallFailed('UNAVAILABLE', 'capacity_exceeded', 'none', `The call is ${bytes} bytes as the agent runtime (ptyd) reads it, more than the ${this.maxLineBytes} bytes one call can carry. It had no effect.`));
		}
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
			this.socket.write(`${line}\n`, err => {
				// Its line not written whole, ptyd read no request of it
				if (err && this.waiting.delete(id)) {
					reject(notCarried(`it could not be written to the agent runtime (ptyd): ${err.message}`));
				}
			});
		});
	}

	private heard(line: string): void {
		let answer: Answer;
		try {
			answer = JSON.parse(line);
		} catch {
			return;
		}
		const waiting = this.waiting.get(answer.id);
		if (!waiting) {
			return;
		}
		this.waiting.delete(answer.id);
		if (answer.error === undefined) {
			waiting.resolve(answer.result);
			return;
		}
		const outcome = answer.effects === 'unknown' ? 'unknown' : 'none';
		switch (answer.reason) {
			case 'not_found':
				waiting.reject(new CallFailed('NOT_FOUND', 'not_found', outcome, answer.error));
				break;
			case 'window_unavailable':
			case 'capacity_exceeded':
				waiting.reject(new CallFailed('UNAVAILABLE', answer.reason, outcome, answer.error));
				break;
			default:
				// A shim and a ptyd of one protocol never disagree about a call: one that cannot be read is theirs differing
				waiting.reject(new CallFailed('UNAVAILABLE', 'protocol_incompatible', outcome, answer.error));
		}
	}
}

function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A call that never reached ptyd: it had no effect. */
function notCarried(why: string): CallFailed {
	return new CallFailed('UNAVAILABLE', 'window_unavailable', 'none', `The call was not carried to a Facade Code window: ${why}. It had no effect.`);
}

/**
 * The shim's connection to the ptyd at `socketPath`, as the shim of `run`, in lines of at most `maxLineBytes` - ptyd's own bound,
 * which a test may make smaller.
 */
export class PtydLink {

	private connection: Promise<Connection> | undefined;

	constructor(private readonly socketPath: string, private readonly run: string, private readonly maxLineBytes = MAX_JSON_LINE_BYTES) { }

	/** Connects and says hello where not connected already: the window that claims the run learns its tools are there. */
	async connect(): Promise<void> {
		await this.connected();
	}

	/**
	 * Carries a call of the run's CLI to its window, in this shim's tool protocol, and resolves that window's answer, or rejects a
	 * {@link CallFailed}. How long the call has been under way counts from `readAt`, when its request line was read, on this
	 * process's monotonic clock (RULES-1.2).
	 */
	async call(call: Omit<ToolCall, 'elapsedMs' | 'caller' | 'protocol'>, readAt: number): Promise<unknown> {
		const connection = await this.connected();
		return connection.request('call', { protocol: TOOL_PROTOCOL, caller: this.run, ...call, elapsedMs: Math.ceil(performance.now() - readAt) });
	}

	dispose(): void {
		void this.connection?.then(connection => connection.socket.destroy(), () => undefined);
	}

	private connected(): Promise<Connection> {
		if (!this.run || !this.socketPath) {
			return Promise.reject(new CallFailed('UNAVAILABLE', 'configuration_invalid', 'none', 'This Facade MCP server was started without its agent run or agent runtime (ptyd): no call can be carried, and it had no effect.'));
		}
		if (!this.connection) {
			// Gone, it is made again for the next call
			const forget = () => {
				if (this.connection === connection) {
					this.connection = undefined;
				}
			};
			const connection = this.connection = this.open(forget);
			connection.catch(forget);
		}
		return this.connection;
	}

	/** Connects, and says hello as the run's shim: resolves once ptyd took it. */
	private open(onClose: () => void): Promise<Connection> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(this.socketPath);
			let connected = false;
			const fail = (err: CallFailed) => {
				clearTimeout(timer);
				socket.destroy();
				reject(err);
			};
			const timer = setTimeout(() => fail(notCarried(`the agent runtime (ptyd) at ${this.socketPath} did not answer within ${HELLO_WAIT_MS} ms`)), HELLO_WAIT_MS);
			socket.once('error', err => {
				if (!connected) {
					fail(notCarried(`the agent runtime (ptyd) cannot be reached at ${this.socketPath} (${err.message})`));
				}
			});
			socket.once('connect', () => {
				connected = true;
				const connection = new Connection(socket, this.maxLineBytes, onClose);
				connection.request('hello', { protocol: SHIM_PTYD_PROTOCOL, role: 'shim', run: this.run }).then(hello => {
					const protocol = (hello as { protocol?: unknown } | undefined)?.protocol;
					if (protocol !== SHIM_PTYD_PROTOCOL) {
						fail(incompatible(`its agent runtime (ptyd) protocol ${String(protocol)}`));
						return;
					}
					clearTimeout(timer);
					resolve(connection);
				}, err => fail(err instanceof CallFailed && err.reason === 'protocol_incompatible' ? err : notCarried(`the agent runtime (ptyd) at ${this.socketPath} closed the connection`)));
			});
		});
	}
}

/** The shim and the ptyd it reached do not speak one protocol. */
function incompatible(theirs: string): CallFailed {
	return new CallFailed('UNAVAILABLE', 'protocol_incompatible', 'none', `This agent's Facade MCP server speaks protocol ${SHIM_PTYD_PROTOCOL}, and ${theirs}: no tool call can be carried, and this one had no effect.`);
}
