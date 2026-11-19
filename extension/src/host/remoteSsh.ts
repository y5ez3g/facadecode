/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import type { ConnectedParams } from '../base/coreProtocol';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { machineBridgeBytes, WORKSPACE_MACHINE_BRIDGE_COMMAND, type MachineBridgeAction, type MachineBridgeHandle, type MachineBridgePipe } from '../base/windowIdentity';
import { executableAt, which } from '../clis/executable';
import { openLocalMachine } from './remoteSshDaemon';
import { withinMachineBridge } from './remoteSshStreams';
import { FACADE_PROGRAM } from './rust/types';

const FIRST_RETRY_MS = 500;
const MOST_RETRY_MS = 10_000;
const COMMAND_WAIT_MS = 12_000;
const CLOSE_WAIT_MS = 1_000;
const WORKSPACE_EXTENSION = 'facade.facadecode';

/** In a remote window the local extension can be installed without being selected to run here. */
function localFacadeProgram(context: vscode.ExtensionContext, build: string): string | undefined {
	const extension = vscode.extensions.getExtension(WORKSPACE_EXTENSION);
	if (extension?.extensionUri.scheme === 'file') {
		const program = executableAt(path.join(extension.extensionPath, FACADE_PROGRAM));
		if (program) {
			return program;
		}
	}
	// The local platform package and its matching window component are installed in the same extensions directory.
	const directory = path.dirname(context.extensionPath);
	const name = `${WORKSPACE_EXTENSION}-${build}`;
	return executableAt(path.join(directory, `${name}-${process.platform}-${process.arch}`, FACADE_PROGRAM))
		?? executableAt(path.join(directory, name, FACADE_PROGRAM))
		?? which(path.basename(FACADE_PROGRAM));
}

/** A window component starts and reconnects only its own temporary Remote-SSH machine link. */
export function startRemoteSshMachine(context: vscode.ExtensionContext, home: string, session: string, token: string) {
	const stop = new AbortController();
	const build = String(context.extension.packageJSON.version);
	const running = runRemoteSsh({
		home, build, session, token,
		program: () => localFacadeProgram(context, build),
		log: line => console.error(line)
	}, stop.signal);
	return {
		dispose: () => stop.abort(),
		async close() {
			stop.abort();
			await running;
		}
	};
}

interface BridgeOptions {
	readonly home: string;
	readonly build: string;
	readonly session: string;
	readonly token: string;
	program(): string | undefined;
	log(line: string): void;
}

async function runRemoteSsh(options: BridgeOptions, signal: AbortSignal): Promise<void> {
	let delay = FIRST_RETRY_MS;
	let warned = false;
	let failure: string | undefined;
	const missing = () => {
		if (!warned) {
			warned = true;
			void vscode.window.showWarningMessage(vscode.l10n.t('Facade Code couldn’t find the Facade core on this computer. Install Facade Code locally to connect this Remote-SSH window to your Facade network.'));
		}
	};
	const connected = ({ machine, first_connection }: ConnectedParams) => {
		delay = FIRST_RETRY_MS;
		failure = undefined;
		if (first_connection) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Connected to {0}. Agents with YOLO enabled on any machine that can reach it, directly or through other machines, can control its agents.', machine.name));
		}
	};
	while (!signal.aborted) {
		try {
			await bridgeRemoteSsh(options, signal, missing, connected);
		} catch (err) {
			if (!signal.aborted && failure !== messageOf(err)) {
				failure = messageOf(err);
				options.log(`Facade Remote-SSH connection failed: ${failure}`);
			}
		}
		await timeout(delay, signal).catch(() => undefined);
		delay = Math.min(delay * 2, MOST_RETRY_MS);
	}
}

async function bridgeRemoteSsh(options: BridgeOptions, stopping: AbortSignal, missing: () => void, connected: (params: ConnectedParams) => void): Promise<void> {
	const handle: MachineBridgeHandle = { session: options.session, token: options.token, stream: randomUUID() };
	const ended = new AbortController();
	const signal = AbortSignal.any([stopping, ended.signal]);
	const execute = (action: MachineBridgeAction) => vscode.commands.executeCommand<unknown>(WORKSPACE_MACHINE_BRIDGE_COMMAND, { ...handle, ...action });
	const call = (action: MachineBridgeAction) => {
		signal.throwIfAborted();
		return withinMachineBridge(execute(action), COMMAND_WAIT_MS, `The Remote-SSH machine bridge did not answer ${action.kind}.`, signal);
	};
	const close = async () => {
		ended.abort();
		try {
			await withinMachineBridge(execute({ kind: 'close' }), CLOSE_WAIT_MS, 'The Remote-SSH machine bridge did not close.');
		} catch {
			// The workspace will release an abandoned stream when its lease expires.
		}
	};
	try {
		if (await call({ kind: 'open' }) !== true) {
			return;
		}
	} catch (err) {
		if (messageOf(err).includes(`'${WORKSPACE_MACHINE_BRIDGE_COMMAND}' not found`)) {
			return; // The workspace engine may still be starting or restarting.
		}
		await close();
		throw err;
	}
	try {
		const local = await openLocalMachine(options, signal);
		if (!local) {
			if (!signal.aborted) {
				missing();
			}
			return;
		}
		const write = async (bytes?: Buffer) => {
			const answer = await call(bytes ? { kind: 'write', data: bytes.toString('base64') } : { kind: 'end' });
			if (answer !== true) {
				throw new Error('The Remote-SSH machine bridge stopped accepting input.');
			}
		};
		const receive = async (pipe: MachineBridgePipe, consume: (bytes: Buffer) => void | Promise<void>) => {
			for (;;) {
				const answer = await call({ kind: 'read', pipe });
				if (!isJsonObject(answer)) {
					throw new Error('The Remote-SSH machine bridge closed.');
				}
				if (answer.data !== undefined) {
					const bytes = machineBridgeBytes(answer.data);
					if (!bytes) {
						throw new Error('The Remote-SSH machine bridge sent an invalid chunk.');
					}
					await consume(bytes);
				}
				if (answer.eof === true) {
					return;
				}
			}
		};
		const decoder = new StringDecoder('utf8');
		const logStderr = (text: string) => {
			if (text) {
				options.log(`Remote Facade machine serve: ${text}`);
			}
		};
		const stderr = receive('stderr', bytes => logStderr(decoder.write(bytes))).then(() => logStderr(decoder.end()));
		try {
			await Promise.all([
				local.sendToWorkspace(write, params => { if (!signal.aborted) { connected(params); } }),
				receive('stdout', bytes => local.write(bytes)).then(() => local.write()),
				stderr
			]);
		} catch (err) {
			// When serve exits with an error, its remaining diagnostics can arrive after stdout EOF.
			await withinMachineBridge(stderr, CLOSE_WAIT_MS, 'Remote Facade diagnostics did not finish.', signal).catch(() => undefined);
			throw err;
		}
	} finally {
		await close();
	}
}
