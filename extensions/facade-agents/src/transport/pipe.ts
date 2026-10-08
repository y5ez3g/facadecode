/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { CallLine, callLineOf, splitLines } from './protocol';

/** The most a request's body may hold: a call's arguments are at most 1 MB. */
const MAX_BODY_BYTES = 1024 * 1024;
/** How long a request may take to send its headers; its call may take as long as it needs. */
const HEADERS_TIMEOUT_MS = 60_000;

/** The path of the pipe with `id`: a named pipe on Windows, a Unix socket elsewhere. */
export function pipePath(id: string): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-agents-${id}`;
	}
	const dir = process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
	return path.join(dir, `facade-agents-${id}.sock`);
}

/** Told once, after a call's result: whether the window wrote it to the caller's end of the pipe. */
export type ResultListener = (written: boolean) => void;

/** How long a call's result may take to go onto the pipe: then its connection is dropped, and the result counts as not written. */
const RESULT_WRITE_TIMEOUT_MS = 30_000;

/** How the window answers on the pipe. */
export interface PipeHandlers<C> {
	/** The caller a token belongs to, or undefined to refuse it. */
	authenticate(token: string): C | undefined;
	/** What the caller's MCP server offers, as the window says hello to it. */
	hello(caller: C): unknown;
	/**
	 * Runs a tool; `progress` sends the caller word of how it goes. Each listener given to `whenWritten` is
	 * told once whether the call's result went onto the pipe: not when the call failed, or the caller had gone.
	 */
	call(caller: C, tool: string, args: unknown, progress: (message: string) => void, whenWritten: (listener: ResultListener) => void): Promise<unknown>;
	/** Writes what went wrong on the pipe that no caller is told of in full: a request the window failed on, a connection it could not take. */
	log?(message: string): void;
}

/**
 * The window's end of the pipe between each agent's MCP server and the window: HTTP over a named pipe
 * on Windows and a Unix socket elsewhere, as the git extension's IPC does, so that nothing listens on
 * TCP. Every request carries a bearer token that names its caller. `POST /hello` answers with what the
 * caller's MCP server offers; `POST /call` runs a tool and answers in newline-delimited JSON: progress
 * lines while it runs, then one line with its result or why it failed. A request the window fails on
 * before that is answered `500`, with the failure's code and message.
 */
export class PipeServer<C> {

	private readonly server: http.Server;
	private readonly sockets = new Set<net.Socket>();

	private constructor(readonly path: string, private readonly handlers: PipeHandlers<C>) {
		this.server = http.createServer((req, res) => this.onRequest(req, res));
		this.server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		// Only the headers are timed: the rest of a request, and the call it makes, take as long as they take
		this.server.requestTimeout = 0;
		this.server.headersTimeout = HEADERS_TIMEOUT_MS;
	}

	/**
	 * Listens on `pipe`. Elsewhere than Windows it is a socket file, which replaces one a window that
	 * ended left there, and which only its user can open.
	 */
	static async listen<C>(pipe: string, handlers: PipeHandlers<C>): Promise<PipeServer<C>> {
		if (process.platform !== 'win32') {
			fs.rmSync(pipe, { force: true });
		}
		const server = new PipeServer(pipe, handlers);
		await new Promise<void>((resolve, reject) => {
			server.server.once('error', reject);
			server.server.listen(pipe, () => {
				server.server.off('error', reject);
				resolve();
			});
		});
		// Once it listens, a connection it cannot take - out of handles, say - is no reason to stop
		server.server.on('error', err => handlers.log?.(`The pipe ${pipe} could not take a connection: ${stackOf(err)}`));
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(pipe, 0o600);
			} catch (err) {
				server.dispose();
				throw err;
			}
		}
		return server;
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const caller = this.callerOf(req, res);
		if (caller === undefined) {
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				// What is past the limit is read and dropped, so that the caller reads why before the connection closes
				if (!res.writableEnded) {
					chunks.length = 0;
					res.writeHead(413).end();
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (res.writableEnded) {
				return;
			}
			let body: unknown;
			try {
				body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
			} catch {
				res.writeHead(400).end();
				return;
			}
			if (!isJsonObject(body)) {
				res.writeHead(400).end();
				return;
			}
			if (req.url === '/hello') {
				let hello: string;
				try {
					hello = JSON.stringify(this.handlers.hello(caller));
				} catch (err) {
					this.answerFailure(res, 'saying hello', err);
					return;
				}
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(hello);
				return;
			}
			if (req.url === '/call' && typeof body.tool === 'string') {
				void this.onCall(caller, body.tool, body.args, res);
				return;
			}
			res.writeHead(404).end();
		});
	}

	/** The caller a request's bearer token names; undefined once the request is answered: refused, or failed on. */
	private callerOf(req: http.IncomingMessage, res: http.ServerResponse): C | undefined {
		const authorization = req.headers.authorization;
		let caller: C | undefined;
		try {
			caller = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? this.handlers.authenticate(authorization.slice('Bearer '.length)) : undefined;
		} catch (err) {
			this.answerFailure(res, 'telling who called', err);
			return undefined;
		}
		if (caller === undefined) {
			res.writeHead(401).end();
		}
		return caller;
	}

	/** Answers a request the window failed on `doing` with the failure's code and message, for the caller to say why, and logs it. */
	private answerFailure(res: http.ServerResponse, doing: string, err: unknown): void {
		this.handlers.log?.(`The window failed ${doing} on its pipe: ${stackOf(err)}`);
		res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: codeOf(err) ?? 'INTERNAL', message: messageOf(err) }));
	}

	/**
	 * Runs a call to its end, even once its caller has gone: what it started goes on, as the tools say. The
	 * listeners of its result hear once whether the pipe took it; a failure is no result.
	 */
	private async onCall(caller: C, tool: string, args: unknown, res: http.ServerResponse): Promise<void> {
		res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
		const listeners: ResultListener[] = [];
		let writing: ReturnType<typeof setTimeout> | undefined;
		const settle = (written: boolean) => {
			clearTimeout(writing);
			for (const listener of listeners.splice(0)) {
				try {
					listener(written);
				} catch (err) {
					this.handlers.log?.(`A listener to a call's result on the pipe failed: ${stackOf(err)}`);
				}
			}
		};
		// A write onto a connection that broke may never call back: the response closing is the last word
		res.once('close', () => settle(false));
		const write = (line: CallLine, done?: ResultListener) => {
			if (res.writableEnded || res.destroyed) {
				done?.(false);
				return;
			}
			res.write(`${JSON.stringify(line)}\n`, err => done?.(!err));
		};
		try {
			const result = await this.handlers.call(caller, tool, args, message => write({ type: 'progress', message }), listener => listeners.push(listener));
			// A caller that stops reading holds its result up, and what waits on it: its connection goes in time
			writing = setTimeout(() => res.destroy(), RESULT_WRITE_TIMEOUT_MS);
			write({ type: 'result', result }, settle);
		} catch (err) {
			settle(false);
			write({ type: 'error', code: codeOf(err) ?? 'INTERNAL', message: messageOf(err) });
		}
		res.end();
	}

	/** Stops listening and drops every connection; the calls they carried run to their end. Elsewhere than Windows the socket file goes. */
	dispose(): void {
		this.server.close();
		for (const socket of this.sockets) {
			socket.destroy();
		}
		if (process.platform !== 'win32') {
			fs.rmSync(this.path, { force: true });
		}
	}
}

/**
 * Why a request on the pipe failed: `UNAUTHORIZED`; `UNREACHABLE` when it never reached the window, as
 * while the window reloads, so it did not run; `NOT_CONNECTED` when the connection broke after it did,
 * so it may have run; `CANCELLED`; `TOO_LARGE` or `REJECTED` when the window would not take it; `FAILED`
 * when the window failed to answer, or answered with what cannot be read; or the code of the window's
 * own failure of a call.
 */
export class PipeClientError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = 'PipeClientError';
	}
}

/** Tells, once a request failed, whether it ever reached the window. */
function failureCodeOf(req: http.ClientRequest): () => string {
	let reached = false;
	req.on('socket', socket => {
		if (socket.connecting) {
			socket.once('connect', () => reached = true);
		} else {
			reached = true;
		}
	});
	return () => reached ? 'NOT_CONNECTED' : 'UNREACHABLE';
}

/** Why the window did not serve a request, by the status it answered with and, for its own failure, what it said. */
function refusalOf(status: number | undefined, body: string, request: 'connection' | 'call'): PipeClientError {
	if (status === 500) {
		return new PipeClientError(windowFailureOf(body) ?? `Facade failed to answer the ${request} (500).`, 'FAILED');
	}
	const code = status === 401 ? 'UNAUTHORIZED' : status === 413 ? 'TOO_LARGE' : 'REJECTED';
	return new PipeClientError(`Facade refused the ${request} (${status}).`, code);
}

/** The message the window answered a request it failed on with; undefined when there is none to read. */
function windowFailureOf(body: string): string | undefined {
	try {
		const value: unknown = JSON.parse(body);
		return isJsonObject(value) && typeof value.message === 'string' ? value.message : undefined;
	} catch {
		return undefined;
	}
}

/**
 * An agent's MCP server's end of the pipe, calling as the holder of `token`. Each request opens a
 * connection of its own: one kept open from before may be one the window closed as it reloaded.
 */
export class PipeClient {

	constructor(private readonly pipe: string, private readonly token: string) { }

	/** The window's hello, as it sent it; the caller checks it. Aborting `signal` stops waiting for it, as for a window that does not answer. */
	hello(signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const req = http.request({ socketPath: this.pipe, path: '/hello', method: 'POST', agent: false, headers: this.headers(), signal }, res => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				// Closed once it is read whole, or once the connection broke on the way
				res.on('close', () => {
					const body = Buffer.concat(chunks).toString('utf8');
					if (!res.complete) {
						reject(new PipeClientError('Facade closed the connection before it said hello.', 'NOT_CONNECTED'));
					} else if (res.statusCode !== 200) {
						reject(refusalOf(res.statusCode, body, 'connection'));
					} else {
						try {
							resolve(JSON.parse(body));
						} catch (err) {
							reject(new PipeClientError(messageOf(err), 'FAILED'));
						}
					}
				});
			});
			const failureCode = failureCodeOf(req);
			req.on('error', err => reject(signal?.aborted ? new PipeClientError('Facade did not say hello in time.', failureCode()) : new PipeClientError(err.message, failureCode())));
			req.end('{}');
		});
	}

	/** Runs a tool; `onProgress` gets the window's progress messages. Aborting `signal` cancels the call. */
	call(tool: string, args: unknown, onProgress: (message: string) => void, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new PipeClientError('Cancelled', 'CANCELLED'));
				return;
			}
			// One the window would refuse is not sent: past the limit, a refusal could not be told from a connection that broke
			const body = JSON.stringify({ tool, args });
			if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
				reject(new PipeClientError(`The call is over the ${MAX_BODY_BYTES} bytes a call may carry.`, 'TOO_LARGE'));
				return;
			}
			let settled = false;
			const settle = (action: () => void) => {
				if (!settled) {
					settled = true;
					signal?.removeEventListener('abort', cancel);
					action();
				}
			};
			const cancel = () => {
				req.destroy();
				settle(() => reject(new PipeClientError('Cancelled', 'CANCELLED')));
			};
			const req = http.request({ socketPath: this.pipe, path: '/call', method: 'POST', agent: false, headers: this.headers() }, res => {
				if (res.statusCode !== 200) {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('close', () => settle(() => reject(refusalOf(res.statusCode, Buffer.concat(chunks).toString('utf8'), 'call'))));
					return;
				}
				let buffer = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					const { lines, rest } = splitLines(buffer + chunk);
					buffer = rest;
					for (const text of lines) {
						if (!text.trim()) {
							continue;
						}
						const line = callLineOf(text);
						if (!line) {
							settle(() => reject(new PipeClientError('Facade answered the call with a line that could not be read.', 'FAILED')));
							res.destroy();
							return;
						}
						if (line.type === 'progress') {
							onProgress(line.message);
						} else if (line.type === 'result') {
							settle(() => resolve(line.result));
						} else {
							settle(() => reject(new PipeClientError(line.message, line.code)));
						}
					}
				});
				res.on('end', () => settle(() => reject(new PipeClientError('Facade closed the call without a result.', 'NOT_CONNECTED'))));
				res.on('error', err => settle(() => reject(new PipeClientError(err.message, 'NOT_CONNECTED'))));
			});
			const failureCode = failureCodeOf(req);
			req.on('error', err => settle(() => reject(new PipeClientError(err.message, failureCode()))));
			signal?.addEventListener('abort', cancel, { once: true });
			req.end(body);
		});
	}

	private headers(): http.OutgoingHttpHeaders {
		return { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' };
	}
}
