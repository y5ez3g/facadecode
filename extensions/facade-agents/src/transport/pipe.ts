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
import { CallLine, callLineOf, Progress, splitLines } from './protocol';

/** The most a request's body may hold: a call's arguments are at most 1 MB. */
const MAX_BODY_BYTES = 1024 * 1024;
/** How long a request may take to send its headers; its call may take as long as it needs. */
const HEADERS_TIMEOUT_MS = 60_000;

/**
 * How long the window has to take a call - to have read it whole and said it runs it - from when the caller
 * sent it. One it reads later it does not run: its caller has stopped waiting, and was told that it did not
 * run. A window that does not read its pipe - stopped in a debugger, its event loop held - is then a window
 * that is away, whose calls are tried again, not one that took them and went silent (N-43).
 */
const CALL_ACCEPT_MS = 750;

/** What the caller waits beyond `CALL_ACCEPT_MS` for the window's word that it took a call, before it takes the call as not taken. */
const CALL_ACCEPT_MARGIN_MS = 250;

/** The header that carries when, by the caller's clock - the machine's - a call has to have been taken. */
const ACCEPT_BY_HEADER = 'x-facade-accept-by';

/** The longest a Unix socket's path can be, in bytes: `sun_path` holds 104 on macOS and 108 on Linux, its end included. */
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

/** What binding adds to a pipe's path for a moment: `.` and the process's id (`PipeServer.listen`). */
const BINDING_SUFFIX_MAX = 11;

/**
 * The path of the pipe with `id`: a named pipe on Windows, a Unix socket elsewhere - in the temporary folder, or,
 * where that folder's path is too long for a socket's, in a folder of the person's own under `/tmp` (C-TR-08; X-70).
 * Throws naming the limit where neither fits.
 */
export function pipePath(id: string, tmpdir: string = os.tmpdir()): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-agents-${id}`;
	}
	const name = `facade-agents-${id}.sock`;
	const fits = (candidate: string) => Buffer.byteLength(candidate) + BINDING_SUFFIX_MAX <= SOCKET_PATH_MAX;
	const dir = process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : tmpdir;
	const preferred = path.join(dir, name);
	if (fits(preferred)) {
		return preferred;
	}
	const fallback = path.join(SHORT_PIPE_ROOT, `facade-${os.userInfo().uid}`, name);
	if (!fits(fallback)) {
		throw new Error(`Facade cannot listen: the temporary folder ${dir} is too long for a socket's path, which holds at most ${SOCKET_PATH_MAX} bytes here, and so is ${path.dirname(fallback)}.`);
	}
	return fallback;
}

/** Where a pipe goes whose temporary folder is too long: short on every Unix. */
const SHORT_PIPE_ROOT = '/tmp';

/**
 * Makes sure the folder of a pipe under `/tmp` is the person's own and nobody else's, making it if need be: anyone
 * can write in `/tmp`, and a folder someone else made there could hand them Facade's socket.
 */
function ensurePrivateFolder(pipe: string): void {
	const dir = path.dirname(pipe);
	if (path.dirname(dir) !== SHORT_PIPE_ROOT) {
		return;
	}
	fs.mkdirSync(dir, { mode: 0o700, recursive: true });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.uid !== os.userInfo().uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`Facade cannot listen: ${dir} is not a folder of this user's alone.`);
	}
}

/** How the window answers on the pipe. */
export interface PipeHandlers<C> {
	/** The caller a token belongs to, or undefined to refuse it. */
	authenticate(token: string): C | undefined;
	/** What the caller's MCP server offers, as the window says hello to it - the server saying which process it is. */
	hello(caller: C, server: { readonly pid?: number }): unknown;
	/** Runs a tool; `progress` sends the caller word of how it goes - with the run it made, once it has made one. */
	call(caller: C, tool: string, args: unknown, progress: Progress): Promise<unknown>;
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
	/** The socket file's inode once it is in place: only that file is this server's to remove. */
	private inode: number | undefined;

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
	 * ended left there, and which only its user can open. ⚠️ It is bound under a name of its own and then
	 * moved to `pipe`: a server that closes removes the file it was bound to, and so would remove the socket
	 * another server - the next extension host of the window - has put at `pipe` meanwhile.
	 */
	static async listen<C>(pipe: string, handlers: PipeHandlers<C>): Promise<PipeServer<C>> {
		const bound = process.platform === 'win32' ? pipe : `${pipe}.${process.pid}`;
		if (process.platform !== 'win32') {
			ensurePrivateFolder(pipe);
			fs.rmSync(bound, { force: true });
		}
		const server = new PipeServer(pipe, handlers);
		await new Promise<void>((resolve, reject) => {
			server.server.once('error', reject);
			server.server.listen(bound, () => {
				server.server.off('error', reject);
				resolve();
			});
		});
		// Once it listens, a connection it cannot take - out of handles, say - is no reason to stop
		server.server.on('error', err => handlers.log?.(`The pipe ${pipe} could not take a connection: ${stackOf(err)}`));
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(bound, 0o600);
				fs.renameSync(bound, pipe);
				server.inode = fs.statSync(pipe).ino;
			} catch (err) {
				server.dispose();
				throw err;
			}
		}
		return server;
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const acceptBy = Number(req.headers[ACCEPT_BY_HEADER]);
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
					const pid = typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : undefined;
					hello = JSON.stringify(this.handlers.hello(caller, pid !== undefined ? { pid } : {}));
				} catch (err) {
					this.answerFailure(res, 'saying hello', err);
					return;
				}
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(hello);
				return;
			}
			if (req.url === '/call' && typeof body.tool === 'string') {
				// Read after its caller stopped waiting for it - this window held, and the call left in its pipe: not
				// run, as its caller was told; it is sent again, or said not to have run (N-43)
				if (Number.isFinite(acceptBy) && Date.now() > acceptBy) {
					res.writeHead(408).end();
					return;
				}
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

	/** Runs a call to its end, even once its caller has gone: what it started goes on, as the tools say. */
	private async onCall(caller: C, tool: string, args: unknown, res: http.ServerResponse): Promise<void> {
		res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
		// Sent at once: the caller's word that the call was taken, and runs
		res.flushHeaders();
		const write = (line: CallLine) => {
			if (!res.writableEnded && !res.destroyed) {
				res.write(`${JSON.stringify(line)}\n`);
			}
		};
		try {
			const result = await this.handlers.call(caller, tool, args, (message, agent) => write({ type: 'progress', message, ...(agent !== undefined ? { agent } : {}) }));
			write({ type: 'result', result });
		} catch (err) {
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
		if (process.platform !== 'win32' && this.inode !== undefined) {
			try {
				if (fs.statSync(this.path).ino === this.inode) {
					fs.rmSync(this.path, { force: true });
				}
			} catch {
				// gone already
			}
		}
	}
}

/**
 * Why a request on the pipe failed: `UNAUTHORIZED`; `UNREACHABLE` when it never reached the window, as
 * while the window reloads, or the window did not take it in time, so it did not run; `NOT_CONNECTED` when the connection broke after it did,
 * so it may have run; `CANCELLED`; `TOO_LARGE` or `REJECTED` when the window would not take it; `FAILED`
 * when the window failed to answer, answered with what cannot be read, or failed the call itself - the
 * code of its own failure kept apart, `windowCode`: whatever it is, it is never taken for one of these, and a
 * call the window failed is never sent again for it (C-TR-07; X-70).
 */
export class PipeClientError extends Error {
	constructor(message: string, readonly code: string, readonly windowCode?: string) {
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
	if (status === 408) {
		return new PipeClientError(`Facade's window did not take the ${request} in time, so it did not run.`, 'UNREACHABLE');
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
			// Which process it is: the window knows from it whether the agent's server still runs (O6)
			req.end(JSON.stringify({ pid: process.pid }));
		});
	}

	/**
	 * Runs a tool; `onProgress` gets the window's progress messages. Aborting `signal` cancels the call. One
	 * the window does not take in time - `CALL_ACCEPT_MS` - fails `UNREACHABLE`: the window does not run it
	 * once it reads it, and it can be sent again (N-43).
	 */
	call(tool: string, args: unknown, onProgress: Progress, signal?: AbortSignal): Promise<unknown> {
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
					clearTimeout(notTaken);
					signal?.removeEventListener('abort', cancel);
					action();
				}
			};
			const notTaken = setTimeout(() => {
				req.destroy();
				settle(() => reject(new PipeClientError(`Facade's window did not take the call within ${(CALL_ACCEPT_MS + CALL_ACCEPT_MARGIN_MS) / 1000} s, so it did not run.`, 'UNREACHABLE')));
			}, CALL_ACCEPT_MS + CALL_ACCEPT_MARGIN_MS);
			const cancel = () => {
				req.destroy();
				settle(() => reject(new PipeClientError('Cancelled', 'CANCELLED')));
			};
			const req = http.request({ socketPath: this.pipe, path: '/call', method: 'POST', agent: false, headers: { ...this.headers(), [ACCEPT_BY_HEADER]: String(Date.now() + CALL_ACCEPT_MS) } }, res => {
				clearTimeout(notTaken);
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
							onProgress(line.message, line.agent);
						} else if (line.type === 'result') {
							settle(() => resolve(line.result));
						} else {
							settle(() => reject(new PipeClientError(line.message, 'FAILED', line.code)));
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
