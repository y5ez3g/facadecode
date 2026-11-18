/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Socket } from 'net';
import { timeout } from '../base/async';
import { monotonic } from '../base/clock';
import type { HelloParams, MachineConnectArgs, ConnectedParams, ConnectFailedParams } from '../base/coreProtocol';
import { isJsonObject, type JsonObject } from '../base/json';
import { MAX_JSON_LINE_BYTES } from '../base/lines';
import { MACHINE_BRIDGE_CHUNK_BYTES } from '../base/windowIdentity';
import { MachineBridgeReader, withinMachineBridge, writeMachineBridgeBytes } from './remoteSshStreams';
import { connectDaemonSocket, startDaemon } from './rust/connection';

const DAEMON_PROTOCOL = 2;
const SOCKET_WAIT_MS = 2_000;
const DAEMON_START_WAIT_MS = 10_000;
const RPC_WAIT_MS = 12_000;
const MACHINE_HELLO_WAIT_MS = 24_000;
const RETRY_SOCKET_MS = 500;

interface LocalDaemonOptions {
	readonly home: string;
	readonly build: string;
	program(): string | undefined;
	log(line: string): void;
}

/** Find this home even if only an already-running daemon is available. Start an installed core if needed. */
async function localDaemonSocket(options: LocalDaemonOptions, signal: AbortSignal): Promise<Socket | undefined> {
	let deadline = monotonic() + DAEMON_START_WAIT_MS;
	let started = false;
	for (;;) {
		signal.throwIfAborted();
		const reached = await connectDaemonSocket(options.home, Math.min(SOCKET_WAIT_MS, Math.max(0, deadline - monotonic())));
		if (signal.aborted) {
			reached.socket?.destroy();
			signal.throwIfAborted();
		}
		if (reached.socket) {
			return reached.socket;
		}
		if (reached.absent && !started) {
			const program = options.program();
			if (!program) {
				return undefined;
			}
			await withinMachineBridge(startDaemon({ home: options.home, program, log: options.log }), RPC_WAIT_MS, 'The local Facade launcher did not answer.', signal);
			started = true;
			deadline = monotonic() + DAEMON_START_WAIT_MS;
		}
		const left = deadline - monotonic();
		if (left <= 0) {
			throw new Error(`Could not reach the local Facade core: ${reached.reason}`);
		}
		await timeout(Math.min(RETRY_SOCKET_MS, left), signal);
	}
}

/** The dedicated local human session. Its lifetime is separate from the workspace's ordinary IDE link. */
export async function openLocalMachine(options: LocalDaemonOptions, signal: AbortSignal): Promise<LocalMachine | undefined> {
	const socket = await localDaemonSocket(options, signal);
	if (!socket) {
		return undefined;
	}
	const local = new LocalMachine(socket, signal);
	try {
		await local.authorize(options.build);
		return local;
	} catch (err) {
		socket.destroy();
		throw err;
	}
}

class LocalMachine {
	private readonly input: MachineBridgeReader;
	private remaining: Buffer | undefined;

	constructor(private readonly socket: Socket, private readonly signal: AbortSignal) {
		this.input = new MachineBridgeReader(socket, signal);
		socket.allowHalfOpen = true;
		const close = () => socket.destroy();
		socket.once('close', () => signal.removeEventListener('abort', close));
		signal.addEventListener('abort', close, { once: true });
		if (signal.aborted) {
			close();
		}
	}

	async authorize(build: string): Promise<void> {
		const hello: HelloParams = { kind: 'terminal', protocol: [DAEMON_PROTOCOL, DAEMON_PROTOCOL], build };
		const response = await this.ask(1, 'hello', hello);
		if (response.protocol !== DAEMON_PROTOCOL) {
			throw new Error(`The local Facade core did not select protocol ${DAEMON_PROTOCOL}.`);
		}
		const args: MachineConnectArgs = { kind: 'temporary', transport: { kind: 'bridge' } };
		await this.ask(2, 'call', { op: 'machine.connect', args });
	}

	/** Core's local status notifications stop here. Machine traffic keeps its original bytes. */
	async sendToWorkspace(write: (bytes?: Buffer) => Promise<void>, connected: (params: ConnectedParams) => void): Promise<void> {
		const deadline = monotonic() + MACHINE_HELLO_WAIT_MS;
		for (;;) {
			const { frame, raw } = await withinMachineBridge(this.frame(), Math.max(0, deadline - monotonic()), 'The Facade machine handshake did not finish.', this.signal);
			if (frame.id === undefined && frame.method === 'connect_failed') {
				const failed = frame.params as ConnectFailedParams | undefined;
				throw new Error(failed?.error?.message ?? 'Facade core could not connect to the remote machine.');
			}
			if (frame.id === undefined && frame.method === 'connected') {
				const params = frame.params as ConnectedParams | undefined;
				if (!params?.machine || typeof params.machine.name !== 'string' || typeof params.first_connection !== 'boolean') {
					throw new Error('The local Facade core sent an invalid `connected` notification.');
				}
				connected(params);
				break;
			}
			for (let offset = 0; offset < raw.length; offset += MACHINE_BRIDGE_CHUNK_BYTES) {
				await write(raw.subarray(offset, offset + MACHINE_BRIDGE_CHUNK_BYTES));
			}
		}
		for (let bytes = await this.read(); bytes; bytes = await this.read()) {
			await write(bytes);
		}
		await write();
	}

	write(bytes?: Buffer): Promise<void> {
		return withinMachineBridge(writeMachineBridgeBytes(this.socket, bytes), RPC_WAIT_MS, 'The local Facade connection stopped reading.', this.signal);
	}

	private async ask(id: number, method: string, params: object): Promise<JsonObject> {
		await this.write(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, 'utf8'));
		const { frame } = await withinMachineBridge(this.frame(), RPC_WAIT_MS, `The local Facade core did not answer ${method}.`, this.signal);
		if (frame.id !== id || frame.method !== undefined) {
			throw new Error(`The local Facade core did not send the expected response to ${method}.`);
		}
		if (isJsonObject(frame.error) && typeof frame.error.message === 'string') {
			throw new Error(frame.error.message);
		}
		if (!isJsonObject(frame.result)) {
			throw new Error(`The local Facade core sent an invalid response to ${method}.`);
		}
		return frame.result;
	}

	private async read(): Promise<Buffer | null> {
		const carried = this.remaining;
		this.remaining = undefined;
		return carried ?? (await this.input.read()) ?? null;
	}

	/** Read just one line, leaving a coalesced machine frame in the same byte stream. */
	private async frame(): Promise<{ frame: JsonObject; raw: Buffer }> {
		const parts: Buffer[] = [];
		let length = 0;
		for (let bytes = await this.read(); bytes; bytes = await this.read()) {
			const newline = bytes.indexOf(10);
			const part = newline < 0 ? bytes : bytes.subarray(0, newline + 1);
			length += part.length;
			if (length > MAX_JSON_LINE_BYTES + 1) {
				throw new Error('A Facade machine handshake frame is too long.');
			}
			parts.push(part);
			if (newline >= 0) {
				if (newline + 1 < bytes.length) {
					this.remaining = bytes.subarray(newline + 1);
				}
				const raw = Buffer.concat(parts, length);
				const frame: unknown = JSON.parse(raw.toString('utf8'));
				if (!isJsonObject(frame) || frame.jsonrpc !== '2.0') {
					throw new Error('The local Facade core sent an invalid JSON-RPC handshake frame.');
				}
				return { frame, raw };
			}
		}
		throw new Error('The local Facade connection closed during the machine handshake.');
	}
}
