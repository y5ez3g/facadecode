/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { antigravityAdapter, claudeAdapter, codexAdapter, grokAdapter, museAdapter, WorkerLaunchInput } from '../common/agents';
import { runProcess } from '../common/spawn';
import { antigravityStreamUsage, claudeStreamUsage, claudeTranscriptUsage, codexStreamUsage, genericStreamUsage, jsonLines, priceOf } from '../common/usage';
import { preToolDecision } from '../shim';
import { Harness, InProcessRunner, ScriptedTrust, writesDone } from './harness';
import { fakeAdapter, feature, run, tempDir, waitFor, write } from './util';

const input: WorkerLaunchInput = {
	agent: { id: 'x', model: 'small' },
	worktree: '/w/f1',
	prompt: 'Do the task.',
	mcp: { command: '/app/facade', args: ['/app/shim.js', 'mcp', '--pipe', 'P', '--token-file', '/runs/f1.token'], env: { ELECTRON_RUN_AS_NODE: '1' } },
	runDir: '/runs',
	slug: 'f1-a1',
	acceptance: [['npm', 'test', '--', '--grep', 'x']]
};

const forbidden = ['git push', 'git merge', 'git rebase', 'git reset', 'git checkout', 'git switch', 'git worktree', 'git branch -D', 'git branch -d', 'git tag', 'git update-ref'];

suite('agent adapters', () => {

	test('Claude Code gets its MCP server, hooks, permissions and prompt as arguments and files', () => {
		const spec = claudeAdapter.buildLaunch(input, '/bin/claude');
		const files = Object.fromEntries(spec.files.map(file => [path.basename(file.path), JSON.parse(file.content)]));
		assert.deepStrictEqual({ ...spec, files }, {
			executable: '/bin/claude',
			args: [
				'Do the task.',
				'--mcp-config', path.join('/runs', 'f1-a1.mcp.json'),
				'--strict-mcp-config',
				'--setting-sources', 'project,local',
				'--settings', path.join('/runs', 'f1-a1.settings.json'),
				'--permission-mode', 'acceptEdits',
				'--allowedTools', 'mcp__facade', 'Bash(npm test)', 'Bash(npm test *)',
				'--disallowedTools', ...forbidden.map(command => `Bash(${command} *)`),
				'--model', 'small'
			],
			env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '86400000' },
			cwd: '/w/f1',
			files: {
				'f1-a1.mcp.json': { mcpServers: { facade: { type: 'stdio', command: '/app/facade', args: input.mcp.args, env: { ELECTRON_RUN_AS_NODE: '1' } } } },
				'f1-a1.settings.json': {
					hooks: {
						Stop: [{ hooks: [{ type: 'mcp_tool', server: 'facade', tool: 'worker_hook', input: { event: 'stop', stop_hook_active: '${stop_hook_active}', transcript_path: '${transcript_path}' } }] }],
						Notification: [{ matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: [{ type: 'mcp_tool', server: 'facade', tool: 'worker_hook', input: { event: 'notification', type: '${notification_type}', message: '${message}' } }] }]
					}
				}
			}
		});
		assert.deepStrictEqual(claudeAdapter.buildLaunch({ ...input, headless: true }, '/bin/claude').args.slice(0, 5), ['-p', 'Do the task.', '--output-format', 'stream-json', '--verbose']);
	});

	test('Codex gets its MCP server as -c overrides, in TOML, approved and with room for long tool calls', () => {
		const settings = [
			'-c', 'mcp_servers.facade.command="/app/facade"',
			'-c', 'mcp_servers.facade.args=["/app/shim.js", "mcp", "--pipe", "P", "--token-file", "/runs/f1.token"]',
			'-c', 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1" }',
			'-c', 'mcp_servers.facade.startup_timeout_sec=30',
			'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
			'-c', 'mcp_servers.facade.required=true',
			'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"'
		];
		assert.deepStrictEqual({
			interactive: codexAdapter.buildLaunch(input, '/bin/codex').args,
			headless: codexAdapter.buildLaunch({ ...input, headless: true }, '/bin/codex').args
		}, {
			interactive: [...settings, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--model', 'small', 'Do the task.'],
			headless: ['exec', '--json', ...settings, '--sandbox', 'workspace-write', '--model', 'small', 'Do the task.']
		});
	});

	test('Antigravity reads its MCP server and hooks from files in the worktree', () => {
		const spec = antigravityAdapter.buildLaunch({ ...input, hookCommand: '/h/p-1-f1-a1.cmd' }, '/bin/agy');
		const injected = Object.fromEntries((spec.injected ?? []).map(file => [file.path, JSON.parse(file.content)]));
		assert.deepStrictEqual({ args: spec.args, injected }, {
			args: ['-i', 'Do the task.', '--mode', 'accept-edits', '--model', 'small'],
			injected: {
				'.agents/mcp_config.json': { mcpServers: { facade: { command: '/app/facade', args: input.mcp.args, env: { ELECTRON_RUN_AS_NODE: '1' } } } },
				'.agents/hooks.json': {
					'facade-worker': {
						PreToolUse: [{ matcher: 'call_mcp_tool|run_command', hooks: [{ type: 'command', command: '/h/p-1-f1-a1.cmd agy-pretool', timeout: 15 }] }],
						Stop: [{ type: 'command', command: '/h/p-1-f1-a1.cmd agy-stop', timeout: 30 }]
					}
				}
			}
		});
	});

	test('Muse trusts the worktree for one run only when the person agreed, and has its prompt typed in', () => {
		const untrusted = museAdapter.buildLaunch(input, '/bin/muse');
		const trusted = museAdapter.buildLaunch({ ...input, trusted: true }, '/bin/muse');
		assert.deepStrictEqual({
			untrusted: untrusted.args,
			trusted: trusted.args,
			typed: trusted.initialInput,
			headless: museAdapter.buildLaunch({ ...input, trusted: true, headless: true }, '/bin/muse').args,
			config: JSON.parse(trusted.injected![0].content).mcpServers.facade.tool_timeout_sec
		}, {
			untrusted: ['--model', 'small'],
			trusted: ['--trust-workspace', '--model', 'small'],
			typed: 'Do the task.',
			headless: ['exec', '--json', '--trust-workspace', '--model', 'small', 'Do the task.'],
			config: 3600
		});
	});

	test('Grok gets its MCP server in the project config, its rules as --allow and --deny, and the prompt after --', () => {
		const spec = grokAdapter.buildLaunch({ ...input, trusted: true }, '/bin/grok');
		assert.deepStrictEqual({ args: spec.args, config: spec.injected![0] }, {
			args: ['--trust', '--allow', 'MCPTool(facade__*)', '--allow', 'Bash(npm test *)', ...forbidden.flatMap(command => ['--deny', `Bash(${command} *)`]), '--model', 'small', '--', 'Do the task.'],
			config: {
				path: '.grok/config.toml',
				content: '[mcp_servers.facade]\ncommand = "/app/facade"\nargs = ["/app/shim.js", "mcp", "--pipe", "P", "--token-file", "/runs/f1.token"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 30\ntool_timeout_sec = 3600\n'
			}
		});
	});
});

suite('usage', () => {

	test('reads what each agent reports and prices the Claude models Facade knows', () => {
		const claude = jsonLines([
			'{"type":"system","subtype":"init","model":"claude-sonnet-5"}',
			'not json',
			'{"type":"result","total_cost_usd":0.42,"usage":{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":5000,"cache_creation_input_tokens":300}}'
		].join('\n'));
		const codex = jsonLines([
			'{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50,"reasoning_output_tokens":10}}',
			'{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":100,"output_tokens":20}}'
		].join('\n'));
		const agy = jsonLines('{"event":"result","result":{"usage":{"input_tokens":10,"output_tokens":4,"thinking_tokens":6,"cache_read_tokens":30}}}');
		const transcript = [
			'{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0}}}',
			// The same message again as it streams: counted once.
			'{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0}}}',
			'{"type":"user","message":{"content":"hi"}}'
		].join('\n');
		assert.deepStrictEqual({
			claude: claudeStreamUsage(claude),
			codex: codexStreamUsage(codex),
			agy: antigravityStreamUsage(agy),
			generic: genericStreamUsage(jsonLines('{"x":{"usage":{"prompt_tokens":7,"completion_tokens":3}}}')),
			transcript: claudeTranscriptUsage(transcript),
			haiku: priceOf({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-haiku-4-5-20251001' }),
			unknown: priceOf({ inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'gpt-something' })
		}, {
			claude: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300, costUsd: 0.42, model: 'claude-sonnet-5' },
			codex: { inputTokens: 800, outputTokens: 70, cacheReadTokens: 700, cacheWriteTokens: 0 },
			agy: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0 },
			generic: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
			transcript: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: (100 * 4 + 20 * 20 + 1000 * 0.2) / 1e6, model: 'claude-opus-5-5' },
			haiku: 6,
			unknown: undefined
		});
	});
});

suite('hooks', function () {

	this.timeout(60_000);

	let harness: Harness;

	setup(() => {
		harness = new Harness();
	});

	teardown(async () => {
		await harness.dispose();
	});

	test('the command hook allows Facade\'s tools and plain acceptance commands, refuses the engine\'s git commands, and leaves the rest to the agent', () => {
		const temp = tempDir('facade-policy-');
		try {
			const policy = path.join(temp.dir, 'policy.json');
			fs.writeFileSync(policy, JSON.stringify({ server: 'facade', allowCommands: ['npm test'], denyCommands: ['git push', 'git reset'] }));
			const decide = (name: string, commandLine?: string) => preToolDecision({ toolCall: { name, args: { CommandLine: commandLine } } }, policy).decision;
			// What Antigravity sends for an MCP tool, as seen in a live run.
			const mcp = (server: string) => preToolDecision({ toolCall: { name: 'call_mcp_tool', args: { Arguments: {}, ServerName: server, ToolName: 'get_contract' } } }, policy).decision;
			assert.deepStrictEqual([
				mcp('facade'),
				mcp('someone-else'),
				decide('run_command', 'npm test -- --grep x'),
				decide('run_command', 'npm test; curl evil'),
				decide('run_command', 'git push origin main'),
				decide('run_command', 'ls'),
				decide('view_file'),
				preToolDecision({}, path.join(temp.dir, 'missing.json')).decision
			], ['allow', 'ask', 'allow', 'ask', 'deny', 'ask', 'ask', 'ask']);
		} finally {
			temp.remove();
		}
	});

	test('a Stop hook sends a worker that has not submitted back to work twice, then tells the lead; a notification says it waits', async () => {
		const replies: string[] = [];
		const runner = new InProcessRunner(featureId => async (call, worktree, attempt) => {
			if (featureId === 'f1') {
				await call('get_contract');
				await call('worker_hook', { event: 'notification', type: 'permission_prompt', message: 'Allow Bash?' });
				for (let stop = 0; stop < 3; stop++) {
					replies.push((await call('worker_hook', { event: 'stop', stop_hook_active: stop > 0 })).text);
				}
				return;
			}
			await writesDone(call, worktree, attempt);
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => replies.length === 3, 20_000, 'three stops');
		const events = await lead('await_events', { program_id: id, cursor: 0, timeout_sec: 1 });
		const heard = (events.data as { events: { type: string; text: string }[] }).events.filter(event => event.type === 'feature.waiting' || event.type === 'feature.turn_ended').map(event => event.text);
		assert.deepStrictEqual({ replies: replies.map(reply => JSON.parse(reply).decision ?? 'stop'), heard }, {
			replies: ['block', 'block', 'stop'],
			heard: [
				'f1\'s agent is waiting in its terminal (a permission prompt). Tell the user to look at it.',
				'f1\'s agent stopped without submitting. Tell the user, or feature_update retry.'
			]
		});
	});

	test('an agent that must be trusted asks the person first; without their agreement the feature goes to the next agent', async () => {
		const trust = new ScriptedTrust(false);
		const runner = new InProcessRunner(() => writesDone);
		const { engine, lead } = harness.createEngine(runner, {
			trust,
			adapters: [fakeAdapter('muse', 'unused', { trust: { detail: 'Muse runs with trust.', flags: ['--trust-workspace'] } }), fakeAdapter('codex', 'unused')]
		});
		const id = await harness.startProgram(engine, lead, [feature('f1', { ladder: ['muse', 'codex', 'lead'] }), feature('f2', { ladder: ['codex'] })]);
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'merged by the next agent');
		assert.deepStrictEqual({ asked: [...new Set(trust.asked)], launches: runner.launches.slice().sort() }, { asked: ['muse'], launches: ['f1:codex', 'f2:codex'] });
	});

	test('files written into the worktree for the agent are neither the feature\'s changes nor committed', async () => {
		// The repository has its own config at the same path: Facade's entries are merged in, never committed.
		write(path.join(harness.repo, '.fake', 'config.json'), '{"keep":true}\n');
		run(harness.repo, 'add', '.');
		run(harness.repo, 'commit', '-q', '-m', 'config');
		let seen = '';
		const runner = new InProcessRunner(() => async (call, worktree, attempt) => {
			seen = fs.readFileSync(path.join(worktree, '.fake', 'config.json'), 'utf8');
			await writesDone(call, worktree, attempt);
		});
		const adapter = fakeAdapter('codex', 'unused', { injected: [{ path: '.fake/config.json', content: '{"facade":{"command":"x"}}' }, { path: '.fake/other.toml', content: 'a = 1\n' }] });
		const { engine, lead } = harness.createEngine(runner, { adapters: [adapter] });
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'merged');
		const program = engine.getProgram(id)!;
		assert.deepStrictEqual({
			seen: JSON.parse(seen),
			committed: run(harness.repo, 'show', `${program.integrationBranch}:.fake/config.json`),
			other: run(harness.repo, 'ls-tree', '--name-only', program.integrationBranch!, '.fake/'),
			injected: program.features.get('f1')!.injected
		}, {
			seen: { keep: true, facade: { command: 'x' } },
			committed: '{"keep":true}',
			other: '.fake/config.json',
			injected: ['.fake/config.json', '.fake/other.toml']
		});
	});

	test('a headless worker runs under the shim, and the usage it reports is recorded when it ends', async () => {
		const runner = new InProcessRunner(() => async (call, worktree, attempt) => {
			// What the shim's run mode would have logged from the agent's stream.
			const request = runner.requests.find(each => each.cwd === worktree)!;
			const log = request.args[request.args.indexOf('--log') + 1];
			fs.writeFileSync(log, '{"type":"system","subtype":"init","model":"claude-haiku-4-5"}\n{"type":"result","usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n');
			await writesDone(call, worktree, attempt);
			// A headless agent exits by itself once it read its verdict.
			runner.stop(request.name);
		});
		const adapter = fakeAdapter('claude', 'unused', { headless: true, usage: claudeStreamUsage });
		const { engine, lead } = harness.createEngine(runner, { adapters: [adapter], settings: { workerMode: 'headless', closeVerifiedWorkers: true } });
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => [...engine.getProgram(id)!.features.values()].every(each => each.usage !== undefined), 30_000, 'usage recorded');
		const request = runner.requests[0];
		assert.deepStrictEqual({
			wrapped: request.args.slice(1, 3),
			agent: request.args.slice(request.args.indexOf('--') + 2),
			usage: engine.getProgram(id)!.features.get('f1')!.usage
		}, {
			wrapped: ['run', '--log'],
			agent: ['unused', '--headless'],
			usage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, model: 'claude-haiku-4-5' }
		});
	});
});

suite('shim run', function () {

	this.timeout(30_000);

	test('runs the agent, appends its JSON output to the log and keeps its exit code, without Electron\'s switch', async () => {
		const temp = tempDir('facade-run-');
		try {
			const log = path.join(temp.dir, 'out.jsonl');
			const agent = 'console.log(JSON.stringify({type:"result",env:process.env.ELECTRON_RUN_AS_NODE??null,result:"done"}));process.exit(3)';
			let shown = '';
			const result = await runProcess([process.execPath, path.join(__dirname, '..', 'shim.js'), 'run', '--log', log, '--', process.execPath, '-e', agent], {
				cwd: temp.dir,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				timeoutMs: 20_000,
				onOutput: chunk => shown += chunk.toString()
			});
			assert.deepStrictEqual({
				exit: result.exitCode,
				logged: JSON.parse(fs.readFileSync(log, 'utf8')),
				shown: shown.includes('[result] done')
			}, { exit: 3, logged: { type: 'result', env: null, result: 'done' }, shown: true });
		} finally {
			temp.remove();
		}
	});
});

suite('git discipline', () => {

	test('the engine never rebases, resets, amends, force-pushes or deletes a branch without checking it', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'common', 'git.ts'), 'utf8');
		const calls = [...source.matchAll(/this\.exec\([^,]+,\s*\[([^\]]*)\]/g)].map(match => match[1]);
		const words = calls.map(args => [...args.matchAll(/'([^']*)'/g)].map(each => each[1]));
		const subcommands = [...new Set(words.map(args => args[0]))].sort();
		const flags = new Set(words.flat());
		const others = fs.readdirSync(path.join(__dirname, '..', '..', 'src', 'common')).filter(file => file !== 'git.ts' && file.endsWith('.ts')).filter(file => /execFile\(['"]git|spawn\(['"]git/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'common', file), 'utf8')));
		assert.deepStrictEqual({
			subcommands,
			forbidden: ['rebase', 'reset', '--hard', '--amend', '--force-with-lease', 'filter-branch', '-D'].filter(flag => flags.has(flag)),
			forcedOnlyInCheckout: words.filter(args => args.includes('--force')).map(args => args[0]),
			pushes: words.filter(args => args[0] === 'push').map(args => args.filter(arg => arg.startsWith('-'))),
			others
		}, {
			subcommands: ['add', 'branch', 'cat-file', 'check-ref-format', 'checkout', 'commit', 'commit-tree', 'config', 'diff', 'grep', 'log', 'ls-files', 'ls-tree', 'merge', 'merge-base', 'merge-tree', 'push', 'remote', 'restore', 'rev-list', 'rev-parse', 'status', 'update-ref', 'worktree'],
			forbidden: [],
			forcedOnlyInCheckout: ['checkout'],
			pushes: [['--set-upstream']],
			others: []
		});
	});
});
