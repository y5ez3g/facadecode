/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentAdapter, AgentCatalog, antigravityAdapter, claudeAdapter, codexAdapter, FirstRunQuestions, grokAdapter, WorkerLaunchInput } from '../common/agents';
import { Git } from '../common/git';
import { Delivery, NUDGE } from '../common/kernel/delivery';
import { pipePath } from '../common/ipc';
import { Kernel, KernelError } from '../common/kernel/kernel';
import { Caller, YOU } from '../common/kernel/model';
import { WorkspaceServer } from '../common/kernel/server';
import { AgentLaunchRequest, AgentRunner, Spawner } from '../common/kernel/spawner';
import { callKernelTool } from '../common/kernel/tools';
import { gitEnvironment, makeRepo, run, tempDir, waitFor } from './util';

/*
 * spawn and stop (L2-PLAN, step 28), with agents that are real processes: a fake agent CLI that
 * starts Facade's real MCP shim and follows a script, launched through an adapter the way Claude or
 * Codex would be.
 */

const FAKE_AGENT = path.join(__dirname, 'fakeParticipant.js');

/** Runs each agent as a plain process, and tells the spawner when one ends. */
class ProcessRunner implements AgentRunner {

	readonly children = new Map<string, ChildProcess>();
	readonly requests: AgentLaunchRequest[] = [];
	onExit: (handle: string, code: number | undefined) => void = () => { };

	async launch(request: AgentLaunchRequest): Promise<void> {
		this.requests.push(request);
		const child = spawn(request.executable, [...request.args], { cwd: request.cwd, env: { ...process.env, ...request.env }, stdio: ['pipe', 'pipe', 'pipe'] });
		child.stdout!.resume();
		child.stderr!.resume();
		this.children.set(request.name, child);
		child.on('exit', code => this.onExit(request.name, code ?? undefined));
	}

	stop(handle: string): void {
		const child = this.children.get(handle);
		if (child && child.exitCode === null) {
			child.kill();
		}
	}

	async isAlive(handle: string): Promise<boolean> {
		const child = this.children.get(handle);
		return !!child && child.exitCode === null && child.signalCode === null;
	}

	/** A line into its standard input, as into its terminal. */
	async type(handle: string, text: string): Promise<boolean> {
		const child = this.children.get(handle);
		if (!child || child.exitCode !== null) {
			return false;
		}
		child.stdin!.write(`${text}\n`);
		return true;
	}

	killAll(): void {
		for (const child of this.children.values()) {
			if (child.exitCode === null) {
				child.kill();
			}
		}
	}
}

/** Scripts by `name-incarnation`. */
function fakeAdapter(scripts: Map<string, object[]>, outDir: string, firstRun?: FirstRunQuestions): AgentAdapter {
	return {
		id: 'fake',
		displayName: 'Fake',
		command: 'fake',
		sharesLeadQuota: false,
		headless: false,
		firstRun,
		buildLaunch(input: WorkerLaunchInput) {
			const script = scripts.get(input.slug) ?? [];
			return {
				executable: process.execPath,
				args: [FAKE_AGENT],
				env: {
					FACADE_FAKE_MCP: JSON.stringify(input.mcp),
					FACADE_FAKE_SCRIPT: JSON.stringify(script),
					FACADE_FAKE_PROMPT: input.prompt,
					FACADE_FAKE_OUT: path.join(outDir, `${input.slug}.out.jsonl`)
				},
				cwd: input.worktree,
				files: [],
				injected: [{ path: '.fake/config.json', content: JSON.stringify({ facade: true }) }]
			};
		}
	};
}

function results(outDir: string, slug: string): { call: string; text: string; isError: boolean }[] {
	const file = path.join(outDir, `${slug}.out.jsonl`);
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

suite('spawn and stop', function () {

	this.timeout(60_000);

	const you: Caller = { name: YOU, incarnation: 1 };
	let temp: { dir: string; remove(): void };
	let kernel: Kernel;
	let server: WorkspaceServer;
	let runner: ProcessRunner;
	let spawner: Spawner;
	let scripts: Map<string, object[]>;
	let repo: string;
	let outDir: string;

	function newSpawner(agentRunner: AgentRunner, firstRun?: FirstRunQuestions, trusted = true): Spawner {
		const adapter = fakeAdapter(scripts, outDir, firstRun);
		const catalog: AgentCatalog = { known: new Set(['fake']), installed: new Map([['fake', { adapter, executable: 'fake' }]]), defaultLadder: [] };
		const git = new Git('git', gitEnvironment);
		return new Spawner({
			kernel,
			git,
			worktrees: { create: (root, worktree, branch, startPoint) => git.addWorktree(root, worktree, branch, startPoint) },
			runner: agentRunner,
			trust: { decide: async () => trusted },
			shim: { command: process.execPath, args: [path.join(__dirname, '..', 'shim.js')], env: {} },
			pipe: () => server.pipe,
			env: process.env,
			catalog: () => catalog,
			worktreesRoot: path.join(temp.dir, 'worktrees'),
			hooksDir: path.join(temp.dir, 'hooks'),
			log: () => { }
		});
	}

	function spawnAs(caller: Caller, args: object) {
		return callKernelTool(kernel, { agents: spawner, hooks: spawner }, caller, 'spawn', args, new AbortController().signal, () => { });
	}

	function state(name: string): string | undefined {
		return kernel.state.participants.get(name)?.state;
	}

	function texts(name: string): string[] {
		return kernel.messagesAfter(name, 0, 1000).map(message => message.text);
	}

	setup(async () => {
		temp = tempDir('facade-spawn-');
		repo = makeRepo(temp.dir, { 'README.md': 'hello\n' });
		outDir = path.join(temp.dir, 'out');
		fs.mkdirSync(outDir);
		scripts = new Map();
		kernel = Kernel.open({ dir: path.join(temp.dir, 'workspace') });
		runner = new ProcessRunner();
		server = await WorkspaceServer.start({ kernel, pipe: pipePath(`spawn-${crypto.randomBytes(6).toString('hex')}`), agents: { spawn: (...args) => spawner.spawn(...args), stop: (...args) => spawner.stop(...args), agents: () => spawner.agents() }, hooks: { hook: (...args) => spawner.hook(...args) } });
		spawner = newSpawner(runner);
		runner.onExit = (handle, code) => spawner.exited(handle, code);
	});

	teardown(async () => {
		runner.killAll();
		await new Promise(resolve => setTimeout(resolve, 300));
		server.dispose();
		kernel.dispose();
		temp.remove();
	});

	test('an agent in a new worktree reads its task, works, reports, and a message after its turn reaches it through its terminal', async () => {
		kernel.write(you, 'p1/tasks/w1', 'Write hello.txt.');
		scripts.set('w1-1', [
			{ call: 'whoami' },
			{ call: 'read', args: { page: 'p1/tasks/w1' } },
			{ file: 'hello.txt', content: 'hello\n' },
			{ call: 'write', args: { page: 'p1/results/w1', text: 'Wrote hello.txt.' } },
			{ call: 'send', args: { to: ['@you'], text: 'Done: p1/results/w1' } },
			// At its prompt, until something is typed in its terminal
			{ line: true },
			{ call: 'recv' },
			{ call: 'send', args: { to: ['@you'], text: 'Read it.' } },
			{ wait: true }
		]);
		const delivery = new Delivery({ kernel, type: (name, text) => spawner.type(name, text), log: () => { } });
		try {
			const started = await spawnAs(you, { agent: 'fake', where: { repo, branch: 'w1' }, text: 'Use the work skill. Your task is in p1/tasks/w1.', name: 'w1' });
			assert.strictEqual(started.isError, undefined, started.text);
			assert.match(started.text, /^Started @w1: fake, in .+ on the new branch w1\./);
			await waitFor(() => texts(YOU).includes('Done: p1/results/w1'), 30_000, 'w1 to report');
			const place = kernel.state.participants.get('w1')!.place!;
			assert.strictEqual(fs.readFileSync(path.join(place, 'hello.txt'), 'utf8'), 'hello\n');
			assert.strictEqual(run(place, 'rev-parse', '--abbrev-ref', 'HEAD'), 'w1');
			assert.ok(fs.existsSync(path.join(place, '.fake', 'config.json')), 'the injected file is there while the agent runs');
			const calls = results(outDir, 'w1-1');
			assert.match(calls[0].text, /^You are @w1, an agent \(fake\), working in /);
			assert.match(calls[0].text, /Your first message:\n> Use the work skill\. Your task is in p1\/tasks\/w1\./);
			assert.match(calls[1].text, /Write hello\.txt\.$/);

			// Its turn ends, as its Stop hook says; a message then is typed into its terminal as a nudge.
			await spawner.hook({ name: 'w1', incarnation: 1 }, 'stop', {});
			kernel.send(you, '@w1', 'One more thing.');
			await waitFor(() => texts(YOU).includes('Read it.'), 30_000, 'w1 to read its message');
			const after = results(outDir, 'w1-1');
			assert.deepStrictEqual(after.find(result => result.call === 'line')?.text, NUDGE);
			assert.match(after.find(result => result.call === 'recv')!.text, /@you → @w1: One more thing\./);
			assert.deepStrictEqual(texts(YOU).slice(0, 3), ['@w1 started working.', 'Done: p1/results/w1', '@w1 finished its turn.']);

			assert.strictEqual(await spawner.stop(you, '@w1'), 'Stopped @w1.');
			assert.ok(!fs.existsSync(path.join(place, '.fake')), 'the injected file goes with the agent');
			assert.strictEqual(state('w1'), 'stopped');
			assert.strictEqual(await spawner.stop(you, 'w1'), '@w1 is already stopped.');
		} finally {
			delivery.dispose();
		}
	});

	test('an interactive agent whose process exits is stopped, and its token ends with it', async () => {
		scripts.set('w2-1', [{ call: 'whoami' }, { exit: 3 }]);
		const started = await spawnAs(you, { agent: 'fake', where: { folder: repo }, text: 'Say hello.', name: 'w2' });
		assert.match(started.text, /^Started @w2: fake, in /);
		await waitFor(() => state('w2') === 'stopped', 30_000, 'w2 to stop');
		assert.deepStrictEqual(texts(YOU), ['@w2 started working.', '@w2 stopped: its process exited with code 3']);
		assert.ok(!fs.existsSync(path.join(repo, '.fake')), 'the injected file is put back in the person\'s own folder');
		assert.deepStrictEqual(run(repo, 'status', '--porcelain'), '');
	});

	test('spawning under a name that is running replaces it', async () => {
		scripts.set('w3-1', [{ call: 'whoami' }, { wait: true }]);
		await spawnAs(you, { agent: 'fake', where: { folder: repo }, text: 'Wait.', name: 'w3' });
		await waitFor(() => state('w3') === 'working', 30_000, 'the first w3 to work');
		const first = runner.children.get('@w3 · Fake')!;
		scripts.set('w3-2', [{ call: 'whoami' }, { exit: 0 }]);
		const again = await spawnAs(you, { agent: 'fake', where: { folder: repo }, text: 'Go again.', name: 'w3' });
		assert.match(again.text, /^Started @w3 \(incarnation 2\)/);
		await waitFor(() => first.exitCode !== null || first.signalCode !== null, 10_000, 'the first w3 to end');
		await waitFor(() => results(outDir, 'w3-2').length === 1, 30_000, 'the second w3 to call');
		assert.match(results(outDir, 'w3-2')[0].text, /^You are @w3 \(incarnation 2\)/);
		assert.ok(texts(YOU).includes('@w3 stopped: replaced by a new @w3, started by @you'), texts(YOU).join('\n'));
	});

	test('spawn and stop refuse what they cannot do', async () => {
		const missing = await spawnAs(you, { agent: 'codex', where: { folder: repo }, text: 'x' });
		assert.match(missing.text, /^codex is not installed here\. Installed: fake\./);
		const noPlace = await spawnAs(you, { agent: 'fake', where: { branch: 'x' }, text: 'x' });
		assert.match(noPlace.text, /Say which repository: where\.repo\. You are not working in one\./);
		const taken = await spawnAs(you, { agent: 'fake', where: { repo, branch: 'main' }, text: 'x' });
		assert.match(taken.text, /The branch main exists already/);
		await assert.rejects(spawner.stop(you, '@ghost'), (err: KernelError) => err.code === 'NOT_FOUND');
		await assert.rejects(spawner.stop(you, '@you'), (err: KernelError) => err.code === 'INVALID');
	});

	test('a worker spawned by an agent starts from where that agent stands', async () => {
		run(repo, 'checkout', '-q', '-b', 'p1');
		fs.writeFileSync(path.join(repo, 'plan.md'), 'the plan\n');
		run(repo, 'add', '.');
		run(repo, 'commit', '-q', '-m', 'plan');
		const lead = kernel.addAgent({ name: 'lead', agent: 'fake', place: repo });
		scripts.set('f2-1', [{ exit: 0 }]);
		const started = await callKernelTool(kernel, { agents: spawner }, { name: 'lead', incarnation: lead.incarnation }, 'spawn', { agent: 'fake', where: { branch: 'f2' }, text: 'Work on f2.', name: 'f2' }, new AbortController().signal, () => { });
		assert.match(started.text, /on the new branch f2/, started.text);
		const place = kernel.state.participants.get('f2')!.place!;
		assert.strictEqual(fs.readFileSync(path.join(place, 'plan.md'), 'utf8'), 'the plan\n');
		assert.strictEqual(kernel.state.participants.get('f2')!.startedBy, 'lead');
	});

	test('a window that makes worktrees itself is asked to, with the commit to start from, and the agent works in the folder it answers', async () => {
		const asked: string[] = [];
		const git = new Git('git', gitEnvironment);
		const made = path.join(temp.dir, 'made-by-the-window');
		spawner = new Spawner({
			kernel,
			git,
			worktrees: { create: async () => { throw new Error('not this way'); } },
			makeWorktree: async (repoRoot, branch, startPoint) => {
				asked.push(`${path.basename(repoRoot)} ${branch} ${startPoint}`);
				await git.addWorktree(repoRoot, made, branch, startPoint);
				return made;
			},
			runner,
			trust: { decide: async () => true },
			shim: { command: process.execPath, args: [path.join(__dirname, '..', 'shim.js')], env: {} },
			pipe: () => server.pipe,
			env: process.env,
			catalog: () => ({ known: new Set(['fake']), installed: new Map([['fake', { adapter: fakeAdapter(scripts, outDir), executable: 'fake' }]]), defaultLadder: [] }),
			worktreesRoot: path.join(temp.dir, 'worktrees'),
			hooksDir: path.join(temp.dir, 'hooks'),
			log: () => { }
		});
		scripts.set('w5-1', [{ exit: 0 }]);
		const started = await spawnAs(you, { agent: 'fake', where: { repo, branch: 'w5' }, text: 'Go.', name: 'w5' });
		assert.match(started.text, /on the new branch w5/, started.text);
		assert.deepStrictEqual(asked, [`repo w5 ${run(repo, 'rev-parse', 'HEAD')}`]);
		assert.strictEqual(kernel.state.participants.get('w5')!.place, fs.realpathSync.native(made));
	});

	test('after a restart, agents whose process is gone are stopped, and those still running keep working', async () => {
		scripts.set('gone-1', [{ call: 'whoami' }, { wait: true }]);
		scripts.set('alive-1', [{ call: 'whoami' }, { wait: true }]);
		await spawnAs(you, { agent: 'fake', where: { folder: repo }, text: 'Wait.', name: 'gone' });
		await spawnAs(you, { agent: 'fake', where: { folder: repo }, text: 'Wait.', name: 'alive' });
		await waitFor(() => state('gone') === 'working' && state('alive') === 'working', 30_000, 'both to work');
		const restarted = newSpawner({ launch: async () => { }, stop: () => { }, isAlive: async handle => handle === '@alive · Fake' });
		await restarted.recover();
		assert.strictEqual(state('gone'), 'stopped');
		assert.strictEqual(kernel.state.participants.get('gone')!.stateDetail, 'its process is gone: Facade restarted');
		assert.strictEqual(state('alive'), 'working');
	});

	test('the questions an agent asks as it starts are answered for the person once they let Facade - the folder\'s only in a worktree Facade made', async () => {
		const firstRun: FirstRunQuestions = {
			detail: 'It asks about its folder and its hooks.',
			answers: [
				{ question: /trust this folder/, choose: /Yes/, aboutTheFolder: true },
				{ question: /Hooks need review/, choose: /Trust all/ }
			]
		};
		scripts.set('made-1', [{ exit: 0 }]);
		scripts.set('own-1', [{ exit: 0 }]);
		spawner = newSpawner(runner, firstRun);
		await spawnAs(you, { agent: 'fake', where: { repo, branch: 'made' }, text: 'Go.', name: 'made' });
		await spawnAs(you, { agent: 'fake', where: { folder: repo }, text: 'Go.', name: 'own' });
		const asked = (name: string) => runner.requests.find(request => request.name === `@${name} · Fake`)?.answers?.map(answer => answer.question.source);

		spawner = newSpawner(runner, firstRun, false);
		const refused = await spawnAs(you, { agent: 'fake', where: { repo, branch: 'refused' }, text: 'Go.', name: 'refused' });

		assert.deepStrictEqual({ made: asked('made'), own: asked('own'), refused: refused.text }, {
			made: ['trust this folder', 'Hooks need review'],
			own: ['Hooks need review'],
			refused: 'The person did not let Facade start Fake trusting the folders it makes for it.',
		});
	});

	test('an agent\'s hooks say when its turn starts and ends and when it waits at a prompt', async () => {
		const added = kernel.addAgent({ name: 'h', agent: 'claude', startedBy: YOU });
		const h: Caller = { name: 'h', incarnation: added.incarnation };
		await spawner.hook(h, 'prompt', {});
		assert.strictEqual(state('h'), 'working');
		await spawner.hook(h, 'notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
		assert.strictEqual(state('h'), 'waiting');
		await spawner.hook(h, 'stop', { stop_hook_active: false });
		assert.strictEqual(state('h'), 'idle');
		assert.strictEqual(await spawner.hook(h, 'agy-stop', {}), '{"decision":"stop"}');
		assert.ok(texts(YOU).includes('@h is waiting in its terminal: Claude needs your permission to use Bash'));
	});
});

suite('Launching agents as participants', () => {

	const input: WorkerLaunchInput = {
		agent: { id: 'x', model: 'm' },
		worktree: '/w',
		prompt: 'Use the work skill.',
		mcp: { command: '/app/facade', args: ['shim.js', 'mcp', '--pipe', 'P', '--token-file', 'T'], env: { ELECTRON_RUN_AS_NODE: '1' } },
		runDir: '/runs',
		slug: 'f2-1',
		acceptance: [],
		hookCommand: '/h/f2-1.cmd',
		participant: { pluginDir: '/plugin' }
	};

	test('Claude: its own UI, with Facade\'s server and skills only, hooks that report, and edits and commands without asking', () => {
		const launch = claudeAdapter.buildLaunch(input, '/bin/claude');
		assert.deepStrictEqual(launch.args.slice(0, 1), ['Use the work skill.']);
		assert.ok(!launch.args.includes('-p'), 'its own interactive UI');
		assert.ok(launch.args.includes('--plugin-dir') && launch.args.includes('/plugin'));
		assert.ok(!launch.args.includes('--disallowedTools'), 'no command is refused');
		assert.ok(launch.args.join(' ').includes('--permission-mode acceptEdits --allowedTools mcp__facade Bash'));
		const settings = JSON.parse(launch.files.find(file => file.path.endsWith('.settings.json'))!.content);
		assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, '/h/f2-1.cmd event:stop');
		assert.strictEqual(settings.hooks.UserPromptSubmit[0].hooks[0].command, '/h/f2-1.cmd event:prompt');
	});

	test('Codex: its own UI in its workspace-write sandbox, never stopping to ask', () => {
		const launch = codexAdapter.buildLaunch(input, '/bin/codex');
		assert.ok(!launch.args.includes('exec'), 'its own interactive UI');
		assert.ok(launch.args.join(' ').includes('--sandbox workspace-write --ask-for-approval never --model m Use the work skill.'));
	});

	test('Antigravity and Grok: nothing refused; Antigravity\'s stop is news', () => {
		const agy = antigravityAdapter.buildLaunch(input, '/bin/agy');
		const hooks = JSON.parse(agy.injected!.find(file => file.path === '.agents/hooks.json')!.content);
		assert.strictEqual(hooks['facade-worker'].Stop[0].command, '/h/f2-1.cmd event:agy-stop');
		const grok = grokAdapter.buildLaunch(input, '/bin/grok');
		assert.ok(!grok.args.includes('--deny'));
		assert.ok(grok.args.join(' ').includes('--allow MCPTool(facade__*)'));
	});
});
