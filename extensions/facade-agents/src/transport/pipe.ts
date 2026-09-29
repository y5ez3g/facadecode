/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const MAX_BODY_BYTES = 1024 * 1024;

/** The pipe's name for an id: a named pipe on Windows, a Unix socket elsewhere. */
export function pipePath(id: string): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-agents-${id}`;
	}
	const dir = process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
	return path.join(dir, `facade-agents-${id}.sock`);
}

/** One line of a `/call` answer. */
type StreamLine =
	| { readonly type: 'progress'; readonly message: string }
	| { readonly type: 'result'; readonly result: unknown }
	| { readonly type: 'error'; readonly code: string; readonly message: string };

export interface CallContext {
	readonly signal: AbortSignal;
	progress(message: string): void;
}

/** What the window answers on the pipe with. */
export interface PipeHandlers<P> {
	/** The caller a token belongs to, or undefined to refuse it. */
	authenticate(token: string): P | undefined;
	hello(caller: P): unknown;
	call(caller: P, tool: string, args: unknown, context: CallContext): Promise<unknown>;
	/** What a hook of the caller's CLI prints, for `event` and what the CLI gave the hook. */
	hook(caller: P, event: string, payload: unknown): string | Promise<string>;
}

/**
 * The pipe between each agent's CLI and the window: HTTP over a named pipe on Windows and a Unix
 * socket elsewhere, like the git extension's askpass IPC. Nothing listens on TCP, so no firewall ever
 * asks. Every request carries a bearer token that names its caller.
 *
 * `POST /hello` answers with what the caller's MCP server offers. `POST /call` runs a tool and
 * answers in newline-delimited JSON: progress lines while it works, then one result line. When the
 * caller goes away, the call's signal aborts. `POST /hook` answers with what one of the caller's
 * hooks prints. The pipe carries names and arguments as they are: which tools and hooks there are is
 * for the handlers to know (WORKTREE-AGENTS.md, section 18).
 */
export class PipeServer<P> {

	private readonly server: http.Server;
	private readonly sockets = new Set<net.Socket>();

	private constructor(readonly path: string, private readonly handlers: PipeHandlers<P>) {
		this.server = http.createServer((req, res) => this.onRequest(req, res));
		this.server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		// Long calls: the MCP client decides how long a call may take, not an HTTP timeout.
		this.server.requestTimeout = 0;
		this.server.headersTimeout = 60_000;
	}

	static async listen<P>(pipe: string, handlers: PipeHandlers<P>): Promise<PipeServer<P>> {
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
		if (process.platform !== 'win32') {
			fs.chmodSync(pipe, 0o600);
		}
		return server;
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const auth = req.headers.authorization;
		const caller = typeof auth === 'string' && auth.startsWith('Bearer ') ? this.handlers.authenticate(auth.slice('Bearer '.length)) : undefined;
		if (!caller) {
			res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				res.writeHead(413).end();
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (res.writableEnded) {
				return;
			}
			let body: { tool?: unknown; args?: unknown; event?: unknown; payload?: unknown };
			try {
				body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
			} catch {
				res.writeHead(400).end();
				return;
			}
			if (req.url === '/hello') {
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.handlers.hello(caller)));
				return;
			}
			if (req.url === '/call' && typeof body.tool === 'string') {
				void this.onCall(caller, body.tool, body.args, res);
				return;
			}
			if (req.url === '/hook' && typeof body.event === 'string') {
				void this.onHook(caller, body.event, body.payload, res);
				return;
			}
			res.writeHead(404).end();
		});
	}

	private async onCall(caller: P, tool: string, args: unknown, res: http.ServerResponse): Promise<void> {
		const controller = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) {
				controller.abort();
			}
		});
		res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
		const write = (line: StreamLine) => {
			if (!res.writableEnded && !res.destroyed) {
				res.write(`${JSON.stringify(line)}\n`);
			}
		};
		try {
			const result = await this.handlers.call(caller, tool, args, { signal: controller.signal, progress: message => write({ type: 'progress', message }) });
			write({ type: 'result', result });
		} catch (err) {
			const failure = err as Error & { code?: string };
			write({ type: 'error', code: failure.code ?? 'INTERNAL', message: failure.message });
		}
		res.end();
	}

	private async onHook(caller: P, event: string, payload: unknown, res: http.ServerResponse): Promise<void> {
		let answer: string;
		try {
			answer = await this.handlers.hook(caller, event, payload);
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ answer }));
	}

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

export class PipeClientError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = 'PipeClientError';
	}
}

/**
 * Why a request failed on the pipe: `UNREACHABLE` when it never reached the window - nothing listens,
 * as while the window reloads - so that it did not run; `NOT_CONNECTED` when the connection broke
 * once it had, so that it may have run.
 */
function failureOf(req: http.ClientRequest): () => string {
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

/** An agent's end of the pipe - its MCP server, or one of its hooks - calling as the holder of `token`. */
export class PipeClient {

	constructor(private readonly pipe: string, private readonly token: string) { }

	hello<T>(): Promise<T> {
		return this.post<T>('/hello', {});
	}

	/** What the window has the hook print for `event`. */
	async hook(event: string, payload: unknown): Promise<string> {
		const { answer } = await this.post<{ answer?: unknown }>('/hook', { event, payload });
		return typeof answer === 'string' ? answer : '';
	}

	private post<T>(path: string, body: object): Promise<T> {
		return new Promise((resolve, reject) => {
			const req = http.request({ socketPath: this.pipe, path, method: 'POST', headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' } }, res => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					if (res.statusCode !== 200) {
						reject(new PipeClientError(`Facade refused the connection (${res.statusCode}).`, res.statusCode === 401 ? 'UNAUTHORIZED' : 'FAILED'));
						return;
					}
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
					} catch (err) {
						reject(err);
					}
				});
			});
			const failure = failureOf(req);
			req.on('error', err => reject(new PipeClientError(err.message, failure())));
			req.end(JSON.stringify(body));
		});
	}

	/** Runs a tool; `onProgress` receives the window's progress lines. Aborting `signal` cancels it. */
	call(tool: string, args: unknown, onProgress: (message: string) => void, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const settle = (action: () => void) => {
				if (!settled) {
					settled = true;
					action();
				}
			};
			const req = http.request({ socketPath: this.pipe, path: '/call', method: 'POST', headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' } }, res => {
				if (res.statusCode !== 200) {
					res.resume();
					settle(() => reject(new PipeClientError(`Facade refused the call (${res.statusCode}).`, res.statusCode === 401 ? 'UNAUTHORIZED' : 'FAILED')));
					return;
				}
				let buffer = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk;
					let newline: number;
					while ((newline = buffer.indexOf('\n')) >= 0) {
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						if (!line.trim()) {
							continue;
						}
						const parsed = JSON.parse(line) as StreamLine;
						if (parsed.type === 'progress') {
							onProgress(parsed.message);
						} else if (parsed.type === 'result') {
							settle(() => resolve(parsed.result));
						} else {
							settle(() => reject(new PipeClientError(parsed.message, parsed.code)));
						}
					}
				});
				res.on('end', () => settle(() => reject(new PipeClientError('Facade closed the call without a result.', 'NOT_CONNECTED'))));
				res.on('error', err => settle(() => reject(new PipeClientError(err.message, 'NOT_CONNECTED'))));
			});
			const failure = failureOf(req);
			req.on('error', err => settle(() => reject(new PipeClientError(err.message, failure()))));
			signal?.addEventListener('abort', () => {
				req.destroy();
				settle(() => reject(new PipeClientError('Cancelled', 'CANCELLED')));
			}, { once: true });
			req.end(JSON.stringify({ tool, args }));
		});
	}
}
