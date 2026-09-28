/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/*
 * The pipe between each agent's MCP process and the engine: HTTP over a named pipe on Windows and a
 * Unix socket elsewhere, like the git extension's askpass IPC. Nothing listens on TCP, so no
 * firewall ever asks. Every request carries a bearer token that decides its role.
 *
 * `POST /hello` names the caller's role. `POST /call` runs a tool and answers in newline-delimited
 * JSON: progress lines while it works, then one result line. When the caller goes away, the call's
 * signal aborts.
 */

export const MAX_BODY_BYTES = 1024 * 1024;

export function pipePath(id: string): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-agents-${id}`;
	}
	const dir = process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
	return path.join(dir, `facade-agents-${id}.sock`);
}

export function newToken(): string {
	return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

export type StreamLine =
	| { readonly type: 'progress'; readonly message: string }
	| { readonly type: 'result'; readonly result: unknown }
	| { readonly type: 'error'; readonly code: string; readonly message: string };

export interface CallContext {
	readonly signal: AbortSignal;
	progress(message: string): void;
}

export interface IpcHandlers<P> {
	/** The principal a token belongs to, or undefined to refuse it. */
	authenticate(token: string): P | undefined;
	hello(principal: P): unknown;
	call(principal: P, tool: string, args: unknown, cwd: string | undefined, context: CallContext): Promise<unknown>;
}

export class IpcServer<P> {

	private readonly server: http.Server;
	private readonly sockets = new Set<import('net').Socket>();

	private constructor(readonly path: string, private readonly handlers: IpcHandlers<P>) {
		this.server = http.createServer((req, res) => this.onRequest(req, res));
		this.server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		// Long polls: the MCP client decides how long a call may take, not an HTTP timeout.
		this.server.requestTimeout = 0;
		this.server.headersTimeout = 60_000;
	}

	static async listen<P>(pipe: string, handlers: IpcHandlers<P>): Promise<IpcServer<P>> {
		if (process.platform !== 'win32') {
			fs.rmSync(pipe, { force: true });
		}
		const server = new IpcServer(pipe, handlers);
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
		const principal = typeof auth === 'string' && auth.startsWith('Bearer ') ? this.handlers.authenticate(auth.slice('Bearer '.length)) : undefined;
		if (!principal) {
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
			let body: { tool?: unknown; args?: unknown; cwd?: unknown };
			try {
				body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
			} catch {
				res.writeHead(400).end();
				return;
			}
			if (req.url === '/hello') {
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.handlers.hello(principal)));
				return;
			}
			if (req.url === '/call' && typeof body.tool === 'string') {
				this.onCall(principal, body.tool, body.args, typeof body.cwd === 'string' ? body.cwd : undefined, res);
				return;
			}
			res.writeHead(404).end();
		});
	}

	private onCall(principal: P, tool: string, args: unknown, cwd: string | undefined, res: http.ServerResponse): void {
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
		this.handlers.call(principal, tool, args, cwd, { signal: controller.signal, progress: message => write({ type: 'progress', message }) }).then(
			result => {
				write({ type: 'result', result });
				res.end();
			},
			(err: Error & { code?: string }) => {
				write({ type: 'error', code: err.code ?? 'INTERNAL', message: err.message });
				res.end();
			});
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

export class IpcClientError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = 'IpcClientError';
	}
}

export class IpcClient {

	constructor(private readonly pipe: string, private readonly token: string) { }

	hello<T>(): Promise<T> {
		return new Promise((resolve, reject) => {
			const req = http.request({ socketPath: this.pipe, path: '/hello', method: 'POST', headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' } }, res => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					if (res.statusCode !== 200) {
						reject(new IpcClientError(`Facade refused the connection (${res.statusCode}).`, res.statusCode === 401 ? 'UNAUTHORIZED' : 'FAILED'));
						return;
					}
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
					} catch (err) {
						reject(err);
					}
				});
			});
			req.on('error', err => reject(new IpcClientError(err.message, 'NOT_CONNECTED')));
			req.end('{}');
		});
	}

	/** Runs a tool; `onProgress` receives the engine's progress lines. Aborting `signal` cancels it. */
	call(tool: string, args: unknown, cwd: string, onProgress: (message: string) => void, signal?: AbortSignal): Promise<unknown> {
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
					settle(() => reject(new IpcClientError(`Facade refused the call (${res.statusCode}).`, res.statusCode === 401 ? 'UNAUTHORIZED' : 'FAILED')));
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
							settle(() => reject(new IpcClientError(parsed.message, parsed.code)));
						}
					}
				});
				res.on('end', () => settle(() => reject(new IpcClientError('Facade closed the call without a result.', 'NOT_CONNECTED'))));
				res.on('error', err => settle(() => reject(new IpcClientError(err.message, 'NOT_CONNECTED'))));
			});
			req.on('error', err => settle(() => reject(new IpcClientError(err.message, 'NOT_CONNECTED'))));
			signal?.addEventListener('abort', () => {
				req.destroy();
				settle(() => reject(new IpcClientError('Cancelled', 'CANCELLED')));
			}, { once: true });
			req.end(JSON.stringify({ tool, args, cwd }));
		});
	}
}
