/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Semaphore } from './async';
import { normalizePath } from './glob';
import { CheckRun, CheckSummary, Cmd } from './model';
import { Environment, OutputTail, runProcess } from './spawn';

/*
 * Acceptance checks: Facade runs them itself, in the worktree, and what counts is their exit code,
 * not what a worker says about them. They share a small pool of slots apart from the agents',
 * because four parallel builds of a large repository would stall the machine.
 */

const DEFAULT_TIMEOUT_SEC = 600;
const TAIL_LINES = 120;

/** Variables no check may inherit: Facade's tokens, and the extension host's own settings. */
export function checkEnvironment(base: Environment): Environment {
	return Object.fromEntries(Object.entries(base).filter(([name]) => !/^(FACADE_AGENTS_|VSCODE_|ELECTRON_RUN_AS_NODE$|ELECTRON_NO_ATTACH_CONSOLE$)/i.test(name)));
}

export interface ChecksRunnerOptions {
	readonly slots: number;
	readonly env: Environment;
}

export interface RunChecksRequest {
	readonly commands: readonly Cmd[];
	readonly worktree: string;
	/** The tree the worktree is at: runs are cached by it. */
	readonly tree: string;
	readonly logDir: string;
	readonly cached: (cmd: Cmd) => CheckRun | undefined;
	readonly signal?: AbortSignal;
	readonly onProgress?: (message: string) => void;
}

export class ChecksRunner {

	private readonly slots: Semaphore;

	constructor(private readonly options: ChecksRunnerOptions) {
		this.slots = new Semaphore(options.slots);
	}

	setSlots(slots: number): void {
		this.slots.setLimit(slots);
	}

	/** Runs the commands in order and stops at the first that does not pass. */
	async run(request: RunChecksRequest): Promise<CheckSummary> {
		const runs: CheckRun[] = [];
		for (const [index, cmd] of request.commands.entries()) {
			const hit = request.cached(cmd);
			if (hit) {
				runs.push({ ...hit, cached: true });
				if (hit.status !== 'pass') {
					break;
				}
				continue;
			}
			request.onProgress?.(`Waiting for a check slot (${index + 1}/${request.commands.length})`);
			const run = await this.slots.run(() => {
				request.onProgress?.(`Running ${cmd.argv.join(' ')} (${index + 1}/${request.commands.length})`);
				return this.runOne(cmd, request, index);
			});
			runs.push(run);
			if (run.status !== 'pass') {
				break;
			}
		}
		return { passed: runs.length === request.commands.length && runs.every(run => run.status === 'pass'), tree: request.tree, runs };
	}

	private async runOne(cmd: Cmd, request: RunChecksRequest, index: number): Promise<CheckRun> {
		const relative = normalizePath(cmd.cwd ?? '.');
		const cwd = path.resolve(request.worktree, relative);
		if (!isInside(request.worktree, cwd)) {
			return { argv: cmd.argv, cwd: relative, status: 'error', ms: 0, tail: `The folder ${relative} is outside the worktree.` };
		}
		fs.mkdirSync(request.logDir, { recursive: true });
		const logPath = path.join(request.logDir, `${request.tree.slice(0, 12)}-${index + 1}.log`);
		const log = fs.createWriteStream(logPath);
		const tail = new OutputTail(TAIL_LINES);
		log.write(`$ ${cmd.argv.join(' ')}\n# in ${cwd}\n\n`);
		const result = await runProcess(cmd.argv, {
			cwd,
			env: checkEnvironment(this.options.env),
			timeoutMs: (cmd.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
			signal: request.signal,
			onOutput: chunk => {
				log.write(chunk);
				tail.push(chunk);
			}
		});
		await new Promise<void>(resolve => log.end(resolve));
		if (result.spawnError) {
			return { argv: cmd.argv, cwd: relative, status: 'error', ms: result.ms, tail: `Could not start ${cmd.argv[0]}: ${result.spawnError}`, logPath };
		}
		const status = result.timedOut ? 'timeout' : result.cancelled ? 'error' : result.exitCode === 0 ? 'pass' : 'fail';
		return { argv: cmd.argv, cwd: relative, status, exitCode: result.exitCode ?? undefined, ms: result.ms, tail: tail.toString(), logPath };
	}
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
