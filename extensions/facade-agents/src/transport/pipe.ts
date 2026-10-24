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
import { isJsonObject, JsonObject } from '../base/json';
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
 * On a remote (`remote`) always in that private folder, never in `XDG_RUNTIME_DIR` nor in the temporary folder
 * itself: the first is a login session's, and goes with it while the agents stay, and the second anyone can
 * list and squat (REMOTE.md R4, R7). Where another user holds that folder, the server falls back to a fresh
 * private folder beside it. Throws naming the limit where neither fits. `privateFolder` is that folder's name:
 * the person's, but a test's own in a test, which may remove it without touching the sockets of the machine's
 * extension hosts.
 */
export function pipePath(id: string, tmpdir: string = os.tmpdir(), remote = false, privateFolder = `facade-${os.userInfo().uid}`): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-agents-${id}`;
	}
	const name = `facade-agents-${id}.sock`;
	const fits = (candidate: string) => Buffer.byteLength(candidate) + BINDING_SUFFIX_MAX <= SOCKET_PATH_MAX;
	if (remote) {
		const folder = path.join(SHORT_PIPE_ROOT, privateFolder, name);
		if (!fits(folder)) {
			throw new Error(`Cannot open a Facade socket: the path under ${path.dirname(folder)} exceeds this platform's ${SOCKET_PATH_MAX}-byte socket path limit.`);
		}
		return folder;
	}
	const dir = process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : tmpdir;
	const preferred = path.join(dir, name);
	if (fits(preferred)) {
		return preferred;
	}
	const fallback = path.join(SHORT_PIPE_ROOT, privateFolder, name);
	if (!fits(fallback)) {
		throw new Error(`Cannot open a Facade socket: paths under both ${dir} and ${path.dirname(fallback)} exceed this platform's ${SOCKET_PATH_MAX}-byte socket path limit.`);
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
	checkPrivateDir(dir);
}

/** `dir` holds Facade's socket only where it is a private directory of this user's. */
function checkPrivateDir(dir: string): void {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.uid !== os.userInfo().uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`Cannot open a Facade socket: ${dir} must be a private directory owned by this user.`);
	}
}

/**
 * Whether `dir` exists held by another user - or not a private directory at all: predictable under
 * `/tmp`, another user may have made it first.
 */
function isSquatted(dir: string): boolean {
	let stat: fs.Stats | undefined;
	try {
		stat = fs.lstatSync(dir);
	} catch {
		return false;
	}
	return !stat.isDirectory() || stat.uid !== os.userInfo().uid || (stat.mode & 0o077) !== 0;
}

/**
 * The folder a pipe under `/tmp` is first bound in: its own, made where missing, where no other user
 * holds it - else a new private folder with an unguessable name, made 0700 and checked like the
 * first: `/tmp/facade-<uid>` is predictable, and another user may have made it first (REMOTE.md R4).
 * Throws naming the limit where the fallback's path is too long for a socket's.
 */
function bindDirFor(pipe: string): string {
	const dir = path.dirname(pipe);
	if (path.dirname(dir) !== SHORT_PIPE_ROOT || !isSquatted(dir)) {
		return dir;
	}
	const fresh = fs.mkdtempSync(`${dir}-`);
	try {
		fs.chmodSync(fresh, 0o700);
		checkPrivateDir(fresh);
		const moved = path.join(fresh, path.basename(pipe));
		if (Buffer.byteLength(moved) + BINDING_SUFFIX_MAX > SOCKET_PATH_MAX) {
			throw new Error(`Cannot open a Facade socket: the path under ${fresh} exceeds this platform's ${SOCKET_PATH_MAX}-byte socket path limit.`);
		}
		return fresh;
	} catch (err) {
		fs.rmSync(fresh, { recursive: true, force: true });
		throw err;
	}
}

/** Told once, after a call's result: whether the window wrote it to the caller's end of the pipe. */
export type ResultListener = (written: boolean) => void;

/** How long a call's result may take to go onto the pipe: then its connection is dropped, and the result counts as not written. */
const RESULT_WRITE_TIMEOUT_MS = 30_000;

/** How the window answers on the pipe. */
export interface PipeHandlers<C> {
	/** The caller a token belongs to, or undefined to refuse it. */
	authenticate(token: string): C | undefined;
	/** What the caller's MCP server offers, as the window says hello to it - the server saying which process it is. */
	hello(caller: C, server: { readonly pid?: number }): unknown;
	/**
	 * Runs a tool; `progress` sends the caller word of how it goes - with the run it made, once it has made one.
	 * Each listener given to `whenWritten` is told once whether the call's result went onto the pipe: not when the
	 * call failed, or the caller had gone (AGENT-MESSAGES.md, M11).
	 */
	call(caller: C, tool: string, args: unknown, progress: Progress, whenWritten: (listener: ResultListener) => void): Promise<unknown>;
	/** Writes what went wrong on the pipe that no caller is told of in full: a request the window failed on, a connection it could not take. */
	log?(message: string): void;
	/**
	 * Lets go of the record and the pipe for this window's new extension host, which asked through
	 * `/release`: called once the answer is on its way, so it may close and dispose everything. One that
	 * fails is logged, and the takeover ends that process instead. No `/release` where none is given.
	 */
	release?(): void;
}

/** What `PipeServer.listen` serves else, and how it watches its socket. */
export interface PipeListenOptions {
	/**
	 * What another extension host of this window says to ask with `/release` that this one lets go -
	 * the secret, and when that host started, in milliseconds, for only a newer one to be let go for;
	 * no `/release` where none is given (L5).
	 */
	release?: { readonly secret: string; readonly startedAt: number };
	/** How often the socket is looked at while it listens, and bound again where it is gone: 30 seconds, unless told otherwise; never on Windows. */
	rebindMs?: number;
}

/** How often a pipe looks at whether its socket is still where it was bound. */
const REBIND_CHECK_MS = 30_000;

/**
 * The window's end of the pipe between each agent's MCP server and the window: HTTP over a named pipe
 * on Windows and a Unix socket elsewhere, as the git extension's IPC does, so that nothing listens on
 * TCP. Every request carries a bearer token that names its caller. `POST /hello` answers with what the
 * caller's MCP server offers; `POST /call` runs a tool and answers in newline-delimited JSON: progress
 * lines while it runs, then one line with its result or why it failed. A request the window fails on
 * before that is answered `500`, with the failure's code and message. `POST /release`, with the secret
 * another extension host of this window says, asks this one to let go for a takeover (REMOTE.md R4).
 */
export class PipeServer<C> {

	private server: http.Server;
	private readonly sockets = new Set<net.Socket>();
	/** The socket file's inode once it is in place: only that file is this server's to remove. */
	private inode: number | undefined;
	/** Whether another extension host of this window asked this one to let go: nothing new is taken. */
	private releasing = false;
	/** How often the socket is looked at while it listens; none on Windows, or once disposed. */
	private rebindCheck: ReturnType<typeof setInterval> | undefined;
	/** Whether the socket is being bound again: looked at no more meanwhile. */
	private rebinding = false;
	private disposed = false;

	private constructor(readonly path: string, private readonly handlers: PipeHandlers<C>, private readonly release?: { readonly secret: string; readonly startedAt: number }) {
		this.server = this.serving();
	}

	/** An HTTP server that hands each request to the handlers and tracks its connections with the rest. */
	private serving(): http.Server {
		const server = http.createServer((req, res) => this.onRequest(req, res));
		server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		// Only the headers are timed: the rest of a request, and the call it makes, take as long as they take
		server.requestTimeout = 0;
		server.headersTimeout = HEADERS_TIMEOUT_MS;
		return server;
	}

	/**
	 * Listens on `pipe` - or, where its folder under `/tmp` is another user's, in a fresh private folder
	 * beside it, which `path` names. Elsewhere than Windows it is a socket file, which replaces one a
	 * window that ended left there, and which only its user can open. ⚠️ It is bound under a name of its
	 * own and then moved to its path: a server that closes removes the file it was bound to, and so would
	 * remove the socket another server - the next extension host of the window - has put there meanwhile.
	 */
	static async listen<C>(pipe: string, handlers: PipeHandlers<C>, options?: PipeListenOptions): Promise<PipeServer<C>> {
		const actual = process.platform === 'win32' ? pipe : path.join(bindDirFor(pipe), path.basename(pipe));
		const bound = process.platform === 'win32' ? actual : `${actual}.${process.pid}`;
		if (process.platform !== 'win32') {
			ensurePrivateFolder(actual);
			fs.rmSync(bound, { force: true });
		}
		const server = new PipeServer(actual, handlers, options?.release);
		await new Promise<void>((resolve, reject) => {
			server.server.once('error', reject);
			server.server.listen(bound, () => {
				server.server.off('error', reject);
				resolve();
			});
		});
		// Once it listens, a connection it cannot take - out of handles, say - is no reason to stop
		server.server.on('error', err => handlers.log?.(`Could not accept a connection on pipe ${actual}: ${stackOf(err)}`));
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(bound, 0o600);
				fs.renameSync(bound, actual);
				server.inode = fs.statSync(actual).ino;
			} catch (err) {
				server.dispose();
				throw err;
			}
			server.watch(options?.rebindMs);
		}
		return server;
	}

	/** Looks at the socket every `rebindMs`, and binds it again where it is gone - a cleaner of /tmp took it, say. */
	private watch(rebindMs?: number): void {
		this.rebindCheck = setInterval(() => {
			try {
				this.checkBound();
			} catch (err) {
				this.handlers.log?.(`Could not look at whether the Facade socket ${this.path} is still bound: ${stackOf(err)}`);
			}
		}, rebindMs ?? REBIND_CHECK_MS);
		this.rebindCheck.unref?.();
	}

	/**
	 * Whether this server's socket is still where it was bound: one gone is made again - its folder too,
	 * where that is gone - and bound again; one another server's by now ends the watch, and is left alone.
	 */
	private checkBound(): void {
		if (this.disposed || this.releasing || this.rebinding) {
			return;
		}
		let found: fs.Stats | undefined;
		try {
			found = fs.statSync(this.path);
		} catch {
			found = undefined;
		}
		if (found === undefined) {
			ensurePrivateFolder(this.path);
			this.rebind();
		} else if (this.inode !== undefined && found.ino !== this.inode) {
			clearInterval(this.rebindCheck);
			this.rebindCheck = undefined;
		}
	}

	/**
	 * Binds the socket again where it was: bound under a name of its own and moved over, as at first, by
	 * a server that takes over from this one, whose connections run to their end with it. One that cannot
	 * be bound is logged, and looked at again.
	 */
	private rebind(): void {
		const bound = `${this.path}.${process.pid}`;
		fs.rmSync(bound, { force: true });
		const running = this.server;
		const server = this.serving();
		this.rebinding = true;
		const failed = (err: Error) => {
			this.rebinding = false;
			server.close();
			this.handlers.log?.(`Could not bind the Facade socket ${this.path} again: ${stackOf(err)}`);
		};
		server.once('error', failed);
		server.listen(bound, () => {
			server.off('error', failed);
			if (this.disposed) {
				// Disposed while it bound: nothing of it is put at the pipe - another server's by now -
				// and it listens no more.
				this.rebinding = false;
				server.close();
				fs.rmSync(bound, { force: true });
				return;
			}
			server.on('error', err => this.handlers.log?.(`Could not accept a connection on pipe ${this.path}: ${stackOf(err)}`));
			try {
				fs.chmodSync(bound, 0o600);
				fs.renameSync(bound, this.path);
				this.inode = fs.statSync(this.path).ino;
				this.server = server;
				// Nothing new arrives on the old one; its connections run to their end
				running.close();
			} catch (err) {
				server.close();
				this.handlers.log?.(`Could not bind the Facade socket ${this.path} again: ${stackOf(err)}`);
			} finally {
				this.rebinding = false;
			}
		});
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.url === '/release' && this.release !== undefined && this.handlers.release) {
			const authorization = req.headers.authorization;
			if (authorization !== `Bearer ${this.release.secret}`) {
				req.resume();
				res.writeHead(401).end();
				return;
			}
			const startedAt = this.release.startedAt;
			this.readBody(req, res, 409, body => this.onRelease(body, res, startedAt));
			return;
		}
		const acceptBy = Number(req.headers[ACCEPT_BY_HEADER]);
		const caller = this.callerOf(req, res);
		if (caller === undefined) {
			req.resume();
			return;
		}
		this.readBody(req, res, 400, body => {
			if (req.url === '/hello') {
				let hello: string;
				try {
					const pid = typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : undefined;
					hello = JSON.stringify(this.handlers.hello(caller, pid !== undefined ? { pid } : {}));
				} catch (err) {
					this.answerFailure(res, 'completing the handshake', err);
					return;
				}
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(hello);
				return;
			}
			if (req.url === '/call' && typeof body.tool === 'string') {
				// Letting go for this window's new extension host: not run, as its caller is told; it is sent
				// again, to the window that takes over (REMOTE.md R4)
				if (this.releasing) {
					res.writeHead(408).end();
					return;
				}
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

	/** Reads one bounded JSON object, answering with `invalidStatus` when it is malformed. */
	private readBody(req: http.IncomingMessage, res: http.ServerResponse, invalidStatus: number, onBody: (body: JsonObject) => void): void {
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
				res.writeHead(invalidStatus).end();
				return;
			}
			if (!isJsonObject(body)) {
				res.writeHead(invalidStatus).end();
				return;
			}
			onBody(body);
		});
	}

	/**
	 * Whether this window's new extension host may take over: it says when it started, and only one
	 * that started later than this one, `startedAt`, is let go for - a stale host asking a newer
	 * holder is refused. One that says none, or none later, is refused too: it cannot prove it is
	 * newer (L5).
	 */
	private onRelease(body: JsonObject, res: http.ServerResponse, startedAt: number): void {
		if (typeof body.startedAt !== 'number' || body.startedAt <= startedAt) {
			res.writeHead(409).end();
			return;
		}
		// Nothing new is taken from now on; the answer goes out before anything closes, so it is read
		this.releasing = true;
		res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"released":true}', () => {
			try {
				this.handlers.release?.();
			} catch (err) {
				this.handlers.log?.(`Letting go for this window's new extension host failed: ${stackOf(err)}`);
			}
		});
	}

	/** The caller a request's bearer token names; undefined once the request is answered: refused, or failed on. */
	private callerOf(req: http.IncomingMessage, res: http.ServerResponse): C | undefined {
		const authorization = req.headers.authorization;
		let caller: C | undefined;
		try {
			caller = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? this.handlers.authenticate(authorization.slice('Bearer '.length)) : undefined;
		} catch (err) {
			this.answerFailure(res, 'identifying the caller', err);
			return undefined;
		}
		if (caller === undefined) {
			res.writeHead(401).end();
		}
		return caller;
	}

	/** Answers a request the window failed on `doing` with the failure's code and message, for the caller to say why, and logs it. */
	private answerFailure(res: http.ServerResponse, doing: string, err: unknown): void {
		this.handlers.log?.(`IPC failure while ${doing}: ${stackOf(err)}`);
		res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: codeOf(err) ?? 'INTERNAL', message: messageOf(err) }));
	}

	/**
	 * Runs a call to its end, even once its caller has gone: what it started goes on, as the tools say. The
	 * listeners of its result hear once whether the pipe took it; a failure is no result.
	 */
	private async onCall(caller: C, tool: string, args: unknown, res: http.ServerResponse): Promise<void> {
		res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
		// Sent at once: the caller's word that the call was taken, and runs
		res.flushHeaders();
		const listeners: ResultListener[] = [];
		let writing: ReturnType<typeof setTimeout> | undefined;
		const settle = (written: boolean) => {
			clearTimeout(writing);
			for (const listener of listeners.splice(0)) {
				try {
					listener(written);
				} catch (err) {
					this.handlers.log?.(`A pipe result-delivery listener failed: ${stackOf(err)}`);
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
			const result = await this.handlers.call(caller, tool, args, (message, agent) => write({ type: 'progress', message, ...(agent !== undefined ? { agent } : {}) }), listener => listeners.push(listener));
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
		this.disposed = true;
		clearInterval(this.rebindCheck);
		this.rebindCheck = undefined;
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
function refusalOf(status: number | undefined, body: string, request: 'connection' | 'call' | 'release'): PipeClientError {
	if (status === 500) {
		return new PipeClientError(windowFailureOf(body) ?? `Facade IPC request '${request}' failed with status 500.`, 'FAILED');
	}
	if (status === 408) {
		return new PipeClientError(`The Facade window did not accept request '${request}' before its deadline. The request did not run.`, 'UNREACHABLE');
	}
	const code = status === 401 ? 'UNAUTHORIZED' : status === 413 ? 'TOO_LARGE' : 'REJECTED';
	return new PipeClientError(`Facade IPC request '${request}' was rejected (status ${status}).`, code);
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
 * An agent's MCP server's end of the pipe, calling as the holder of `token` - or this window's new
 * extension host, asking with its release secret. Each request opens a connection of its own: one kept
 * open from before may be one the window closed as it reloaded.
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
						reject(new PipeClientError('Facade closed the connection before the handshake completed.', 'NOT_CONNECTED'));
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
			req.on('error', err => reject(signal?.aborted ? new PipeClientError('The Facade handshake timed out.', failureCode()) : new PipeClientError(err.message, failureCode())));
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
				reject(new PipeClientError(`Request payload exceeds the IPC limit of ${MAX_BODY_BYTES} bytes.`, 'TOO_LARGE'));
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
				settle(() => reject(new PipeClientError(`The Facade window did not accept the call within ${(CALL_ACCEPT_MS + CALL_ACCEPT_MARGIN_MS) / 1000} seconds. The call did not run.`, 'UNREACHABLE')));
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
							settle(() => reject(new PipeClientError('Facade IPC returned a malformed response.', 'FAILED')));
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
				res.on('end', () => settle(() => reject(new PipeClientError('Facade closed the connection without returning a result.', 'NOT_CONNECTED'))));
				res.on('error', err => settle(() => reject(new PipeClientError(err.message, 'NOT_CONNECTED'))));
			});
			const failureCode = failureCodeOf(req);
			req.on('error', err => settle(() => reject(new PipeClientError(err.message, failureCode()))));
			signal?.addEventListener('abort', cancel, { once: true });
			req.end(body);
		});
	}

	/**
	 * Asks the window to let go for this window's new extension host, saying the release secret its window
	 * record names as this client's token, and when that host started, in milliseconds - only a newer
	 * one is let go for (L5). True once it is letting go: its calls from now on are not taken, and sent
	 * again. Aborting `signal` stops waiting for it, as for a window that does not answer.
	 */
	release(startedAt: number, signal?: AbortSignal): Promise<true> {
		return new Promise((resolve, reject) => {
			const req = http.request({ socketPath: this.pipe, path: '/release', method: 'POST', agent: false, headers: this.headers(), signal }, res => {
				res.resume();
				res.on('close', () => {
					if (!res.complete) {
						reject(new PipeClientError('Facade closed the connection before it answered letting go.', 'NOT_CONNECTED'));
					} else if (res.statusCode !== 200) {
						reject(refusalOf(res.statusCode, '', 'release'));
					} else {
						resolve(true);
					}
				});
			});
			const failureCode = failureCodeOf(req);
			req.on('error', err => reject(signal?.aborted ? new PipeClientError('The Facade window did not answer letting go in time.', failureCode()) : new PipeClientError(err.message, failureCode())));
			req.end(JSON.stringify({ startedAt }));
		});
	}

	private headers(): http.OutgoingHttpHeaders {
		return { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' };
	}
}
