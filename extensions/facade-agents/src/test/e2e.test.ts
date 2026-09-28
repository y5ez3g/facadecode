/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import { CommandApprovals, Engine, Principal, WorkerLaunchRequest, WorkerRunner } from '../common/engine';
import { Git } from '../common/git';
import { IpcServer, pipePath } from '../common/ipc';
import { McpToolResult } from '../common/mcp';
import { RecordingUi, ScriptedTrust } from './harness';
import { catalogOf, fakeAdapter, feature, gitEnvironment, makeRepo, plan, run, settings, tempDir, waitFor, write } from './util';

/*
 * The whole path, with real processes: the engine and its pipe; per feature, a fake agent that
 * starts the real MCP shim and speaks MCP to it; the shim forwarding over the pipe. Step 21's exit
 * criterion: five features built in parallel.
 */

/** Runs each worker as a real process, the way Facade's terminals would. */
class ProcessRunner implements WorkerRunner {

	readonly children = new Map<string, ChildProcess>();
	readonly stderr: string[] = [];
	mostAtOnce = 0;

	constructor(private readonly behaviors: Record<string, object>, private readonly exited: (name: string, code: number | undefined) => void) { }

	async launch(request: WorkerLaunchRequest): Promise<void> {
		const featureId = /(\S+) a\d+$/.exec(request.name)![1];
		const child = spawn(request.executable, [...request.args], {
			cwd: request.cwd,
			env: { ...process.env, ...request.env, FACADE_FAKE_BEHAVIOR: JSON.stringify(this.behaviors[featureId]) },
			stdio: ['ignore', 'ignore', 'pipe']
		});
		child.stderr!.on('data', chunk => this.stderr.push(`${request.name}: ${chunk}`));
		child.on('exit', code => this.exited(request.name, code ?? undefined));
		this.children.set(request.name, child);
		this.mostAtOnce = Math.max(this.mostAtOnce, [...this.children.values()].filter(each => each.exitCode === null).length);
	}

	stop(name: string): void {
		this.children.get(name)?.kill();
	}

	async isAlive(name: string): Promise<boolean> {
		const child = this.children.get(name);
		return !!child && child.exitCode === null;
	}
}

suite('end to end', function () {

	this.timeout(120_000);

	test('five features are built in parallel by agents that speak MCP to the real shim', async () => {
		const temp = tempDir('facade-e2e-');
		let engine: Engine | undefined;
		let server: IpcServer<Principal> | undefined;
		try {
			const repo = makeRepo(temp.dir, { 'src/shared.txt': 'shared\n' });
			const ids = ['f1', 'f2', 'f3', 'f4', 'f5'];
			const behaviors: Record<string, object> = Object.fromEntries(ids.map(id => [id, { rounds: [{ write: { [`src/${id}.txt`]: 'done\n' } }] }]));
			// One feature needs a second round, and one asks the lead first.
			behaviors.f4 = { rounds: [{ write: { 'src/f4.txt': 'almost\n' } }, { write: { 'src/f4.txt': 'done\n' } }] };
			behaviors.f5 = { ask: 'Shall I also add a newline?', rounds: [{ write: { 'src/f5.txt': 'done\n' } }] };

			const git = new Git('git', gitEnvironment);
			const pipe = pipePath(`e2e-${crypto.randomBytes(4).toString('hex')}`);
			const runner = new ProcessRunner(behaviors, (name, code) => engine?.workerExited(name, code));
			const ui = new RecordingUi();
			const approvals: CommandApprovals = { approved: () => new Set(), approve: () => { } };
			engine = new Engine({
				storageDir: path.join(temp.dir, 'storage'),
				worktreesRoot: path.join(temp.dir, 'worktrees'),
				git,
				worktrees: { create: (root, worktree, branch, startPoint) => git.addWorktree(root, worktree, branch, startPoint) },
				runner,
				ui,
				commandApprovals: approvals,
				trust: new ScriptedTrust(),
				shim: { command: process.execPath, args: [path.join(__dirname, '..', 'shim.js')], env: {} },
				pipe,
				env: process.env,
				settings: () => ({ ...settings, maxParallel: 5, checkSlots: 2 }),
				catalog: () => catalogOf([fakeAdapter('codex', path.join(__dirname, 'fakeAgent.js'))]),
				log: () => { }
			});
			const running = engine;
			await running.start();
			server = await IpcServer.listen<Principal>(pipe, {
				authenticate: token => running.authenticate(token),
				hello: principal => running.hello(principal),
				call: (principal, tool, args, cwd, context) => running.call(principal, tool, args, cwd, context.signal, context.progress)
			});
			const leadPrincipal = running.authenticate(running.issueLeadToken('e2e'))!;
			const lead = (tool: string, args: object = {}): Promise<McpToolResult> => running.call(leadPrincipal, tool, args, repo, new AbortController().signal, () => { });

			const saved = await lead('plan_save', { plan: plan(ids.map(id => feature(id))) });
			const id = (saved.data as { program: string }).program;
			await lead('plan_submit', { program_id: id });
			running.approvePlan(id);
			await waitFor(() => running.getProgram(id)!.integrationTip !== undefined);
			const workspace = (await lead('lead_workspace', { program_id: id })).data as { path: string };
			write(path.join(workspace.path, 'src', 'shared.txt'), 'shared, scaffolded\n');
			await lead('lead_submit', { program_id: id, kind: 'scaffold', message: 'Add the scaffold' });
			await lead('program_start', { program_id: id });

			// The lead waits; it answers the question when it comes.
			let cursor = 0;
			const heard: string[] = [];
			while (![...running.getProgram(id)!.features.values()].every(each => each.status === 'merged') || running.getProgram(id)!.queue.length) {
				const result = await lead('await_events', { program_id: id, cursor, timeout_sec: 30 });
				const data = result.data as { cursor: number; events: { type: string; text: string }[] };
				cursor = data.cursor;
				for (const event of data.events) {
					heard.push(event.type);
					if (event.type === 'feature.question') {
						await lead('answer', { program_id: id, question_id: 'q-1', text: 'Yes.' });
					}
				}
				if (heard.length > 50) {
					throw new Error(`Too many events: ${heard.join(', ')}\n${runner.stderr.join('')}`);
				}
			}

			const program = running.getProgram(id)!;
			assert.deepStrictEqual({
				merged: ids.map(each => program.features.get(each)!.status),
				files: ids.map(each => run(repo, 'show', `${program.integrationBranch}:src/${each}.txt`)),
				f4Checked: program.features.get('f4')!.lastChecks!.passed,
				questionAnswered: program.questions.get('q-1')!.answeredBy,
				parallel: runner.mostAtOnce >= 3,
				heardQuestion: heard.includes('feature.question')
			}, {
				merged: ['merged', 'merged', 'merged', 'merged', 'merged'],
				files: ['done', 'done', 'done', 'done', 'done'],
				f4Checked: true,
				questionAnswered: 'lead',
				parallel: true,
				heardQuestion: true
			}, runner.stderr.join(''));
		} finally {
			server?.dispose();
			engine?.dispose();
			await new Promise(resolve => setTimeout(resolve, 500));
			temp.remove();
		}
	});
});
