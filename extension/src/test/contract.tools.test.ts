/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { FacadeError } from '../core/errors';
import { TOOL_PROTOCOL, ToolAnswer } from '../schema/protocol';
import { MESSAGE_LIMIT } from '../schema/tools';
import { assertSameFacts, FACTS, resultOf, runFacts, runId, Setup, setUp, WORKTREE } from './contractFakes';
import { waitFor } from './util';

/** The headline of an answer: what its text says before the facts. */
const headlineOf = (answer: ToolAnswer) => answer.text.split('\n')[0];

/** A root the person started, YOLO off, with a child, a grandchild, and an unrelated YOLO root. */
function team(s: Setup) {
	const lead = runFacts(1, { name: 'lead' });
	const worker = runFacts(2, { name: 'worker', root: lead.id, creator: lead.id, origin: 'agent' });
	const helper = runFacts(3, { name: 'helper', root: lead.id, creator: worker.id, origin: 'agent' });
	const stranger = runFacts(4, { name: 'stranger', yolo: true });
	s.agents.add(lead, worker, helper, stranger);
	return { lead, worker, helper, stranger };
}

const START = { name: 'backend review', window_id: 'win-1', location_id: 'loc-1', cli: 'claude' };

suite('Contract: the nine tools of one window (MCP-2 to 5)', () => {

	let s: Setup;
	setup(() => s = setUp());
	teardown(() => s.dispose());

	suite('every call', () => {

		test('an unknown tool, an unknown caller and invalid arguments fail before any effect, to the caller alone', async () => {
			const { lead } = team(s);
			const unknown = resultOf(await s.call(lead, 'get_operation', {}));
			assert.deepStrictEqual([unknown.error?.code, unknown.error?.reason], ['INVALID', 'unsupported']);
			const stranger = resultOf(await s.call(runId(99), 'list_agents', {}));
			assert.deepStrictEqual([stranger.error?.code, stranger.error?.reason, stranger.effects.outcome], ['NOT_FOUND', 'not_found', 'none']);
			const invalid = resultOf(await s.call(lead, 'start_agent', { name: 'x', cli: 3 }));
			assert.deepStrictEqual([invalid.error?.code, invalid.error?.reason], ['INVALID', 'missing_argument']);
			assert.deepStrictEqual(invalid.data.missing, ['window_id', 'location_id']);
			assert.deepStrictEqual(invalid.data.invalid.map((each: { field: string }) => each.field), ['cli']);
			assert.deepStrictEqual(s.agents.launched, []);
		});

		test('the check of text against structure catches a field the text leaves out or misstates', () => {
			const structured = { status: 'success', data: { agent_id: 'run-1', count: 2 }, effects: { outcome: 'confirmed' } };
			assertSameFacts({ text: 'Done.\n\nstatus: success\ndata:\n  agent_id: run-1\n  count: 2\neffects:\n  outcome: confirmed', structured, isError: false });
			assert.throws(() => assertSameFacts({ text: 'Done.\n\nstatus: success\ndata:\n  agent_id: run-1\neffects:\n  outcome: confirmed', structured, isError: false }));
			assert.throws(() => assertSameFacts({ text: 'Done.\n\nstatus: success\ndata:\n  agent_id: run-1\n  count: 2\neffects:\n  outcome: confirmed', structured, isError: true }));
		});

		test('a call of another tool protocol, or of none, is refused protocol_incompatible before anything is looked at or done', async () => {
			const { lead } = team(s);
			for (const protocol of [TOOL_PROTOCOL - 1, undefined]) {
				const answer = await s.service({ caller: lead.id, tool: 'start_agent', arguments: START, protocol });
				const result = resultOf(answer);
				assert.deepStrictEqual([result.error?.code, result.error?.reason, result.effects], ['UNAVAILABLE', 'protocol_incompatible', { outcome: 'none' }]);
				assert.match(result.error!.message, new RegExp(`window tool protocol ${TOOL_PROTOCOL}: the call had no effect`));
			}
			assert.deepStrictEqual(s.agents.launched, []);
		});

		test('a caller not known yet waits for the window to find its runs again, within its first two seconds; then it is not found', async () => {
			let restored!: () => void;
			s.deps.ready = new Promise<void>(resolve => restored = resolve);
			const lead = runFacts(1, { name: 'lead' });
			const waiting = s.service({ caller: lead.id, tool: 'list_agents', arguments: {} });
			await new Promise(resolve => setTimeout(resolve, 20));
			// Reattached: the caller is there once the restore is done
			s.agents.add(lead);
			restored();
			assert.strictEqual(resultOf(await waiting).status, 'success');
			// Restored already, a caller still unknown is not found at once
			const began = Date.now();
			assert.strictEqual(resultOf(await s.service({ caller: runId(98), tool: 'list_agents', arguments: {} })).error?.reason, 'not_found');
			assert.ok(Date.now() - began < 500);
			// A restore that does not finish is waited for only while the call's two seconds last
			s.deps.ready = new Promise(() => undefined);
			const late = Date.now();
			assert.strictEqual(resultOf(await s.service({ caller: runId(97), tool: 'list_agents', arguments: {}, elapsedMs: 1_800 })).error?.reason, 'not_found');
			assert.ok(Date.now() - late >= 150 && Date.now() - late < 1_000, String(Date.now() - late));
		});

		test('a window_id other than this window\'s is not found where no other window is known', async () => {
			const { lead } = team(s);
			for (const [tool, args] of [['list_start_options', { window_id: 'win-2' }], ['list_agents', { window_id: 'win-2' }], ['start_agent', { ...START, window_id: 'win-2' }]] as const) {
				const result = resultOf(await s.call(lead, tool, args));
				assert.deepStrictEqual([result.error?.code, result.error?.reason], ['NOT_FOUND', 'not_found'], tool);
			}
			assert.deepStrictEqual(s.agents.launched, []);
		});
	});

	suite('list_start_options', () => {

		test('without window_id: the open window, its locations and availability, complete with no unavailable windows', async () => {
			const { lead } = team(s);
			const result = resultOf(await s.call(lead, 'list_start_options'));
			assert.strictEqual(result.status, 'success');
			assert.deepStrictEqual(result.data, {
				windows: [{
					window_id: 'win-1', label: 'Design', environment: 'local', available: true,
					locations: [{ location_id: 'loc-1', label: 'app', path: '/work/app' }, { location_id: 'loc-wt', label: 'fix', path: '/work/app.worktrees/fix' }]
				}],
				complete: true,
				unavailable_windows: []
			});
			assert.deepStrictEqual(result.effects, { outcome: 'none' });
		});

		test('a window with no folder is listed with no location and cannot start an agent', async () => {
			const { lead } = team(s);
			s.locations = [];
			const result = resultOf(await s.call(lead, 'list_start_options'));
			assert.strictEqual(result.data.windows[0].available, false);
			assert.match(result.data.windows[0].reason, /No folder is open/);
			assert.deepStrictEqual(result.data.windows[0].locations, []);
		});

		test('with window_id the location catalog; with location_id its CLIs; with cli its choices and capabilities', async () => {
			const { lead } = team(s);
			const locations = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1' }));
			assert.deepStrictEqual(locations.data.locations[0], { location_id: 'loc-1', label: 'app', path: '/work/app', environment: 'local', kind: 'checkout', folder: 'app', opened: true, branch: 'main', main: true, git: 'ok' });
			assert.strictEqual(locations.data.complete, true);
			const clis = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1' }));
			assert.deepStrictEqual(clis.data.clis.map((each: { cli: string; available: boolean }) => [each.cli, each.available]), [['claude', true], ['codex', true], ['qwen', false]]);
			assert.strictEqual(clis.data.clis[2].problem, 'qwen was not found on PATH.');
			s.choices.remember('local', 'claude', { model: 'sonnet' });
			s.choices.remember('local', 'claude', { model: 'opus', effort: 'high' });
			const cli = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'claude' }));
			assert.deepStrictEqual(cli.data.model.values, ['opus', 'sonnet']);
			assert.deepStrictEqual([cli.data.model.source, cli.data.model.status, cli.data.model.takes], ['previous_starts', 'partial', true]);
			assert.deepStrictEqual(cli.data.effort.values, ['high']);
			assert.deepStrictEqual([cli.data.cli.version, cli.data.cli.version_source], ['2.1.314', undefined]);
			const capabilities = cli.data.capabilities;
			// No exact sessions in this product: Resume and Pin come in a later step
			assert.deepStrictEqual(Object.keys(capabilities), ['activity', 'message_input', 'screen', 'direct_input', 'initial_prompt']);
			assert.strictEqual(capabilities.activity.state, 'supported');
			assert.deepStrictEqual(capabilities.message_input, { state: 'supported', reason: 'claude-frame reads its input by its layout.', adapter: 'claude-frame' });
			assert.deepStrictEqual([capabilities.screen.state, capabilities.direct_input.state], ['supported', 'supported']);
			assert.deepStrictEqual(capabilities.initial_prompt, { state: 'unverified', reason: 'A positional prompt argument, not yet verified.', path: 'native' });
			for (const each of Object.values(capabilities) as { reason: string }[]) {
				assert.ok(each.reason.length > 0);
			}
		});

		test('a CLI that takes no effort says so; one without adapter facts is unverified, never assumed', async () => {
			const { lead } = team(s);
			const codex = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'codex' }));
			assert.deepStrictEqual(codex.data.effort, { takes: false, values: [], source: 'adapter', status: 'complete', reason: 'Codex takes no explicit effort.' });
			assert.strictEqual(codex.data.capabilities.activity.state, 'unverified');
			assert.deepStrictEqual(codex.data.capabilities.initial_prompt, { state: 'unavailable', reason: 'It maps no prompt argument.', path: 'post_start' });
			const qwen = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'qwen' }));
			assert.deepStrictEqual([qwen.data.capabilities.activity.state, qwen.data.capabilities.initial_prompt.state, qwen.data.model.takes], ['unverified', 'unverified', undefined]);
		});

		test('message input is what the CLI\'s reader states, whatever its version (D83): supported with its reader; without one, unavailable and messages fail with unsupported', async () => {
			const { lead } = team(s);
			const read = { state: 'supported' as const, reason: 'claude-frame reads Claude Code\'s input by its layout.' };
			s.deps.clis = {
				list: s.deps.clis.list,
				describe: () => ({ launches: [{ ...FACTS[0], version: { version: '9.9.9', source: 'a version never recorded' }, input: { adapter: 'claude-frame', capability: read } }, { ...FACTS[1], input: undefined }, FACTS[2]] })
			};
			const claude = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'claude' }));
			assert.deepStrictEqual(claude.data.capabilities.message_input, { ...read, adapter: 'claude-frame' });
			const codex = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'codex' }));
			assert.strictEqual(codex.data.capabilities.message_input.state, 'unavailable');
			assert.match(codex.data.capabilities.message_input.reason, /fails with unsupported; type_text still works/);
		});

		test('where the adapter\'s facts cannot be read, its capabilities are unverified with that reason', async () => {
			const { lead } = team(s);
			s.deps.clis = { list: s.deps.clis.list, describe: () => { throw new Error('PATH unreadable'); } };
			const result = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'claude' }));
			assert.strictEqual(result.data.capabilities.activity.state, 'unverified');
			assert.match(result.data.capabilities.activity.reason, /PATH unreadable/);
			assert.strictEqual(result.data.capabilities.session, undefined);
			assert.strictEqual(result.data.model.takes, undefined);
		});

		test('a subordinate selection names its parent, and an unknown location or CLI is not found', async () => {
			const { lead } = team(s);
			const noWindow = resultOf(await s.call(lead, 'list_start_options', { location_id: 'loc-1' }));
			assert.deepStrictEqual([noWindow.error?.reason, noWindow.data.missing], ['missing_argument', ['window_id']]);
			const noLocation = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', cli: 'claude' }));
			assert.deepStrictEqual(noLocation.data.missing, ['location_id']);
			assert.strictEqual(resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-9' })).error?.reason, 'not_found');
			assert.strictEqual(resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-1', location_id: 'loc-1', cli: 'kimi' })).error?.reason, 'not_found');
		});
	});

	suite('start_agent', () => {

		test('starts a background agent start in the caller\'s tree and reports its identity, place and process (MCP-2.3)', async () => {
			const { worker } = team(s);
			const answer = await s.call(worker, 'start_agent', { ...START, model: 'opus', effort: 'high' });
			const result = resultOf(answer);
			// In the background, the caller's tree joined from its own facts: its run and its root (RULES-4.3, LIFECYCLE-2.2)
			assert.deepStrictEqual(s.agents.launched, [{ name: 'backend review', location: 'loc-1', cli: 'claude', model: 'opus', effort: 'high', origin: 'agent', creator: { run: worker.id, root: runId(1), label: 'worker #a2' } }]);
			const id = runId(100);
			assert.strictEqual(result.status, 'success');
			assert.deepStrictEqual(result.data, {
				agent_id: id, reference: '@backend review #a100', alias: '#a100', name: 'backend review', window_id: 'win-1', window: 'Design', environment: 'local',
				location_id: 'loc-1', cwd: '/work/app', cli: 'claude', creator: worker.id, root: runId(1), yolo: true,
				process_state: 'running', tools_state: 'connecting', requested_model: 'opus', requested_effort: 'high'
			});
			assert.deepStrictEqual(result.effects, { outcome: 'confirmed', agent_id: id });
			assert.strictEqual(answer.isError, false);
			assert.match(answer.text, /^Started @backend review #a100 \(run-0+64\) with claude in \/work\/app: its process is running\./);
			// The explicit choices of a start that reached running are offered later
			assert.deepStrictEqual(s.choices.list('local', 'claude'), { model: ['opus'], effort: ['high'] });
		});

		test('a native prompt is the caller\'s headed message, its ID taken before the launch; used unverified, its outcome is unknown, never invented', async () => {
			const { lead } = team(s);
			s.agents.startWith = { state: 'running', prompt: { path: 'native', capability: { state: 'unverified', reason: 'Not yet verified.' } } };
			const answer = await s.call(lead, 'start_agent', { ...START, prompt: 'Review the changes.\nThen the tests.' });
			const result = resultOf(answer);
			// The CLI is given the message as any message goes: header, whole text, footer - the sender and window named, not the recipient
			assert.strictEqual(s.agents.launched[0].prompt, '[Facade message #m1 | from @lead #a1 | window Design]\nReview the changes.\nThen the tests.\n[/Facade message #m1]');
			assert.strictEqual(s.agents.launched[0].promptLine, 'Review the changes.');
			assert.deepStrictEqual(s.messages.prompts, [{
				request: { id: 'm-1', from: lead.id, to: runId(100), text: 'Review the changes.\nThen the tests.', callId: 'call-1' },
				// Its launch delivered it: one state, so it is no message waiting in the child's inbox (COLLABORATION-3.1)
				delivery: { status: 'success', effects: { outcome: 'unknown' }, attempts: 0, via: 'launch', deliveredAt: Date.UTC(2026, 9, 28, 22, 0, 0) }
			}]);
			assert.deepStrictEqual(s.messages.sent, []);
			assert.deepStrictEqual(result.data.prompt, { message_id: 'm-1', alias: '#m1', path: 'native', capability: { state: 'unverified', reason: 'Not yet verified.' }, status: 'success', effects: { outcome: 'unknown' } });
			assert.strictEqual(result.status, 'success');
			assert.match(headlineOf(answer), /that mapping is unverified, so whether the CLI accepted the prompt is not known/);
		});

		test('a native prompt whose mapping is supported is confirmed accepted', async () => {
			const { lead } = team(s);
			s.agents.startWith = { state: 'running', prompt: { path: 'native', capability: { state: 'supported', reason: 'Verified with this version.' } } };
			const result = resultOf(await s.call(lead, 'start_agent', { ...START, prompt: 'Go.' }));
			assert.deepStrictEqual([result.data.prompt.status, result.data.prompt.effects], ['success', { outcome: 'confirmed' }]);
			assert.deepStrictEqual(s.messages.prompts[0].delivery.effects, { outcome: 'confirmed' });
		});

		test('a native prompt that cannot be recorded fails alone: the start keeps its result and agent_id', async () => {
			const { lead } = team(s);
			s.agents.startWith = { state: 'running', prompt: { path: 'native', capability: { state: 'unverified', reason: 'Not yet verified.' } } };
			s.messages.recordError = new Error('EACCES: permission denied');
			const answer = await s.call(lead, 'start_agent', { ...START, prompt: 'Go.' });
			const result = resultOf(answer);
			assert.deepStrictEqual([result.status, result.effects], ['success', { outcome: 'confirmed', agent_id: runId(100) }]);
			assert.deepStrictEqual(result.data.prompt, {
				message_id: 'm-1', alias: '#m1', path: 'native', capability: { state: 'unverified', reason: 'Not yet verified.' },
				status: 'failure', reason: 'unexpected_error', message: 'EACCES: permission denied', effects: { outcome: 'unknown' }
			});
			assert.match(headlineOf(answer), /could not be recorded: EACCES: permission denied The agent keeps running\./);
		});

		test('without a native mapping the prompt goes after startup as the caller\'s ordinary message, reported as its first response', async () => {
			const { lead } = team(s);
			s.messages.respond = () => ({ status: 'accepted', obstacle: 'input_unknown' });
			const answer = await s.call(lead, 'start_agent', { ...START, prompt: 'Review the changes.' });
			const result = resultOf(answer);
			// The ID taken before the launch is the one it is sent with
			assert.deepStrictEqual(s.messages.allocated, ['m-1']);
			assert.deepStrictEqual(s.messages.sent, [{ id: 'm-1', from: lead.id, to: runId(100), text: 'Review the changes.', elapsedMs: 0, callId: 'call-1' }]);
			assert.strictEqual(result.status, 'success');
			assert.deepStrictEqual(result.data.prompt, {
				message_id: 'm-1', alias: '#m1', path: 'post_start',
				capability: { state: 'unavailable', reason: 'The launch has no native prompt argument, so the prompt goes as the first message after startup.' },
				status: 'pending', obstacle: 'input_unknown', deadline: '2026-10-28T23:00:15.000Z', effects: { outcome: 'pending', text_written: 'none', enter_written: false }
			});
			assert.match(headlineOf(answer), /prompt #m1 is still being delivered after startup; its outcome is recorded later as a Facade result in your inbox/);
		});

		test('a failed prompt leaves the started agent running and its start a success', async () => {
			const { lead } = team(s);
			s.agents.startWith = { state: 'running', prompt: { path: 'post_start', capability: { state: 'unavailable', reason: 'No mapping.' } } };
			s.messages.respond = () => ({ status: 'failure', reason: 'unsupported' });
			const result = resultOf(await s.call(lead, 'start_agent', { ...START, prompt: 'Go.' }));
			assert.strictEqual(result.status, 'success');
			assert.deepStrictEqual([result.data.prompt.status, result.data.prompt.reason], ['failure', 'unsupported']);
			assert.strictEqual(s.agents.get(runId(100))?.lifecycle, 'running');
			assert.deepStrictEqual(s.agents.closed, []);
		});

		test('a new worktree is asked of the launch, and the one created is reported as an effect', async () => {
			const { lead } = team(s);
			s.agents.startWith = undefined;
			const answering = s.call(lead, 'start_agent', { ...START, worktree: { branch: 'review-api', base_ref: 'HEAD' } });
			await waitFor(() => s.agents.launched.length === 1);
			assert.deepStrictEqual(s.agents.launched[0].worktree, { branch: 'review-api', baseRef: 'HEAD' });
			s.agents.settle(runId(100), { state: 'running' }, { location: WORKTREE.id, cwd: WORKTREE.path });
			const result = resultOf(await answering);
			assert.deepStrictEqual(result.effects, { outcome: 'confirmed', agent_id: runId(100), worktree_created: WORKTREE.path });
			assert.deepStrictEqual([result.data.requested_worktree, result.data.cwd], [undefined, WORKTREE.path]);
		});

		test('still starting at the timeout: accepted with the agent ID, then the final outcome reported under the same call', async () => {
			const { lead } = team(s);
			s.agents.startWith = undefined;
			s.timeout = 0.02;
			s.messages.respond = () => ({ status: 'success' });
			const answer = await s.call(lead, 'start_agent', { ...START, prompt: 'Go.' });
			const result = resultOf(answer);
			assert.strictEqual(result.status, 'accepted');
			assert.strictEqual(answer.isError, false);
			assert.deepStrictEqual(result.effects, { outcome: 'pending', agent_id: runId(100) });
			assert.deepStrictEqual([result.data.process_state, result.data.phase], ['starting', undefined]);
			assert.match(headlineOf(answer), /The start's outcome is recorded later as a Facade result in your inbox, and typed into your terminal where your CLI's message input allows\./);
			assert.strictEqual(s.messages.reports.length, 0);
			s.agents.settle(runId(100), { state: 'running' });
			await waitFor(() => s.messages.reports.length === 1);
			const [report] = s.messages.reports;
			assert.deepStrictEqual([report.to, report.callId, report.agent], [lead.id, 'call-1', runId(100)]);
			assert.match(report.text, /^Started @backend review #a100 .*: its process is running\. Its prompt #m1 was submitted to its CLI after startup\./);
			assert.match(report.text, /\nstatus: success\n/);
			// The prompt's budget began once the process started, after the accepted answer
			assert.deepStrictEqual(s.messages.sent.map(each => each.callId), ['call-1']);
		});

		test('a launch that fails after acceptance keeps its pair and is a failure with the actual reason', async () => {
			const { lead } = team(s);
			s.agents.startWith = { state: 'failed', error: 'claude was not found on PATH.' };
			const answer = await s.call(lead, 'start_agent', START);
			const result = resultOf(answer);
			assert.deepStrictEqual([result.status, result.error?.code, result.error?.reason], ['failure', 'FAILED', 'launch_failed']);
			assert.match(result.error!.message, /claude was not found on PATH\./);
			assert.deepStrictEqual(result.effects, { outcome: 'partial', agent_id: runId(100) });
			assert.strictEqual(result.data.process_state, 'failed');
			assert.strictEqual(answer.isError, true);
			assert.deepStrictEqual(s.choices.list('local', 'claude'), { model: [], effort: [] });
		});

		test('nothing is accepted where the location, CLI, name or a requested choice cannot be used', async () => {
			const { lead } = team(s);
			const cases: [unknown, string, string][] = [
				[{ ...START, location_id: 'loc-9' }, 'NOT_FOUND', 'not_found'],
				[{ ...START, cli: 'kimi' }, 'NOT_FOUND', 'not_found'],
				[{ ...START, cli: 'qwen' }, 'UNAVAILABLE', 'unavailable'],
				[{ ...START, name: 3 }, 'INVALID', 'invalid_argument'],
				[{ ...START, cli: 'codex', effort: 'high' }, 'INVALID', 'unsupported'],
				[{ ...START, prompt: 'stop\x1b' }, 'INVALID', 'invalid_argument']
			];
			for (const [args, code, reason] of cases) {
				const result = resultOf(await s.call(lead, 'start_agent', args));
				assert.deepStrictEqual([result.error?.code, result.error?.reason, result.effects.outcome], [code, reason, 'none'], JSON.stringify(args));
			}
			assert.deepStrictEqual(s.agents.launched, []);
		});

		test('a name is a label (O22): empty, repeated or "human" are all accepted; the ID tells agents apart', async () => {
			const { lead } = team(s);
			for (const name of ['', 'human', 'lead']) {
				assert.strictEqual(resultOf(await s.call(lead, 'start_agent', { ...START, name })).status, 'success', JSON.stringify(name));
			}
			assert.deepStrictEqual(s.agents.launched.map(each => each.name), ['', 'human', 'lead']);
		});

		test('a refusal of the launch service itself is returned with no effect', async () => {
			const { lead } = team(s);
			s.agents.launchError = new FacadeError('INVALID', 'invalid_argument', 'A new worktree needs a branch.');
			const result = resultOf(await s.call(lead, 'start_agent', START));
			assert.deepStrictEqual([result.error?.reason, result.error?.message, result.effects], ['invalid_argument', 'A new worktree needs a branch.', { outcome: 'none' }]);
		});
	});

	suite('list_agents', () => {

		test('lists the caller\'s whole creation tree without YOLO, and every agent with it', async () => {
			const { lead, helper, stranger } = team(s);
			const tree = resultOf(await s.call(helper, 'list_agents'));
			assert.deepStrictEqual(tree.data.agents.map((each: { alias: string }) => each.alias), ['#a1', '#a2', '#a3']);
			assert.deepStrictEqual([tree.data.complete, tree.data.unavailable_windows, tree.data.next_cursor], [true, [], undefined]);
			const all = resultOf(await s.call(stranger, 'list_agents'));
			assert.deepStrictEqual(all.data.agents.map((each: { alias: string }) => each.alias), ['#a1', '#a2', '#a3', '#a4']);
			assert.deepStrictEqual(all.data.agents[0], {
				agent_id: lead.id, alias: '#a1', reference: '@lead #a1', name: 'lead', window_id: 'win-1', window: 'Design', environment: 'local',
				location_id: 'loc-1', cwd: '/work/app', cli: 'claude', creator: '#human', root: lead.id, yolo: false, created_at: '1970-01-01T00:00:01.001Z',
				process: 'running', activity: 'not_working', tools: 'available', observed_at: '2026-10-28T22:00:00.000Z', stale: false
			});
			for (const each of all.data.agents) {
				assert.ok(!Object.keys(each).some(key => /task|operation|credential/.test(key)));
			}
		});

		test('each agent\'s message input as its own launch found it: supported where its CLI has a reader, else unavailable with why', async () => {
			const { lead, helper } = team(s);
			s.deps.input = {
				capability: run => run === lead.id
					? { state: 'supported', reason: 'claude-frame reads Claude Code\'s input by its layout.' }
					: { state: 'unavailable', reason: 'Facade cannot read the message input of Example CLI.' }
			};
			const agents = resultOf(await s.call(lead, 'list_agents')).data.agents as { agent_id: string; message_input: unknown }[];
			assert.deepStrictEqual(agents.filter(each => [lead.id, helper.id].includes(each.agent_id)).map(each => each.message_input), [
				{ state: 'supported', reason: 'claude-frame reads Claude Code\'s input by its layout.' },
				{ state: 'unavailable', reason: 'Facade cannot read the message input of Example CLI.' }
			]);
		});

		test('ended agents only with include_ended, with their retained error and exit, never as live', async () => {
			const { lead } = team(s);
			s.agents.add(runFacts(5, { name: 'crashed', root: lead.id, lifecycle: 'ended', end: { kind: 'abnormal', code: 1, at: Date.UTC(2026, 9, 28, 21) }, error: { reason: 'Exited with code 1', source: 'exit', at: Date.UTC(2026, 9, 28, 21) } }));
			const live = resultOf(await s.call(lead, 'list_agents'));
			assert.ok(!live.data.agents.some((each: { alias: string }) => each.alias === '#a5'));
			const ended = resultOf(await s.call(lead, 'list_agents', { include_ended: true }));
			const crashed = ended.data.agents.find((each: { alias: string }) => each.alias === '#a5');
			assert.deepStrictEqual([crashed.process, crashed.pid, crashed.exit, crashed.error.reason], ['ended', undefined, { kind: 'abnormal', code: 1, at: '2026-10-28T21:00:00.000Z' }, 'Exited with code 1']);
		});

		test('pages with next_cursor until the last page, and refuses a cursor it did not give', async () => {
			const { stranger } = team(s);
			for (let n = 10; n < 15; n++) {
				s.agents.add(runFacts(n));
			}
			const seen: string[] = [];
			let cursor: string | undefined;
			do {
				const page = resultOf(await s.call(stranger, 'list_agents', { limit: 3, ...cursor ? { cursor } : {} }));
				seen.push(...page.data.agents.map((each: { alias: string }) => each.alias));
				cursor = page.data.next_cursor;
			} while (cursor);
			assert.deepStrictEqual(seen, ['#a1', '#a2', '#a3', '#a4', '#a10', '#a11', '#a12', '#a13', '#a14']);
			const bad = resultOf(await s.call(stranger, 'list_agents', { cursor: 'nonsense' }));
			assert.deepStrictEqual([bad.error?.reason, bad.data.invalid[0].field], ['invalid_argument', 'cursor']);
		});
	});

	suite('stop_agent', () => {

		test('stops one agent in reach and reports its cleanup; its children are not stopped', async () => {
			const { lead, worker } = team(s);
			const answer = await s.call(lead, 'stop_agent', { agent: '@worker' });
			const result = resultOf(answer);
			assert.deepStrictEqual(s.agents.closed, [worker.id]);
			assert.deepStrictEqual(result.data, { agent_id: worker.id, reference: '@worker #a2', process_state: 'ended', cleanup: 'terminated' });
			assert.deepStrictEqual(result.effects, { outcome: 'confirmed', agent_id: worker.id });
			assert.ok(s.agents.get(runId(3)), 'the child keeps running');
		});

		test('already ended, unconfirmed and failed cleanups are reported as they are', async () => {
			const { lead } = team(s);
			s.agents.closeWith = 'already_ended';
			const ended = resultOf(await s.call(lead, 'stop_agent', { agent: '#a2' }));
			assert.deepStrictEqual([ended.status, ended.data.already_ended, ended.data.cleanup], ['success', true, 'already_ended']);
			s.agents.closeWith = 'unconfirmed';
			const unconfirmed = resultOf(await s.call(lead, 'stop_agent', { agent: '#a3' }));
			assert.deepStrictEqual([unconfirmed.status, unconfirmed.data.process_state, unconfirmed.effects.outcome], ['success', 'unknown', 'partial']);
			s.agents.closeWith = 'failed';
			const failed = resultOf(await s.call(lead, 'stop_agent', { agent: lead.id }));
			assert.deepStrictEqual([failed.status, failed.error?.reason, failed.effects.outcome], ['failure', 'cleanup_failed', 'partial']);
		});

		test('outside the caller\'s tree an ID is refused and a name is not found; a missing ID never guesses', async () => {
			const { lead, stranger } = team(s);
			const byId = resultOf(await s.call(lead, 'stop_agent', { agent: stranger.id }));
			assert.deepStrictEqual([byId.error?.code, byId.error?.reason], ['REFUSED', 'out_of_tree']);
			const byName = resultOf(await s.call(lead, 'stop_agent', { agent: 'stranger' }));
			assert.deepStrictEqual([byName.error?.code, byName.error?.reason], ['NOT_FOUND', 'not_found']);
			assert.strictEqual(resultOf(await s.call(lead, 'stop_agent', { agent: '#a77' })).error?.reason, 'not_found');
			assert.deepStrictEqual(s.agents.closed, []);
		});

		test('a process still ending at the timeout is accepted, and its cleanup reported later under the same call', async () => {
			const { lead, worker } = team(s);
			let finish!: (result: 'terminated') => void;
			s.agents.closeWith = new Promise(resolve => finish = resolve);
			s.timeout = 0.02;
			const answer = await s.call(lead, 'stop_agent', { agent: worker.id });
			const result = resultOf(answer);
			assert.deepStrictEqual([result.status, result.data.cleanup, result.effects], ['accepted', 'pending', { outcome: 'pending', agent_id: worker.id }]);
			assert.match(headlineOf(answer), /that outcome is recorded later as a Facade result in your inbox/);
			finish('terminated');
			await waitFor(() => s.messages.reports.length === 1);
			assert.deepStrictEqual([s.messages.reports[0].to, s.messages.reports[0].callId, s.messages.reports[0].agent], [lead.id, 'call-1', worker.id]);
			assert.match(s.messages.reports[0].text, /^Stopped @worker #a2/);
		});
	});

	suite('send_message', () => {

		test('sends one message to one resolved agent with the call\'s elapsed time and ID, and maps success', async () => {
			const { lead, worker } = team(s);
			const answer = await s.call(lead, 'send_message', { to: '@worker', text: 'Please review.' });
			const result = resultOf(answer);
			assert.deepStrictEqual(s.messages.sent, [{ from: lead.id, to: worker.id, text: 'Please review.', elapsedMs: 7, callId: 'call-1' }]);
			assert.deepStrictEqual(result.data, { message_id: 'm-1', alias: '#m1', target: worker.id, target_reference: '@worker #a2', length: 14, disposition: 'submitted_to_cli' });
			assert.deepStrictEqual(result.effects, { outcome: 'confirmed', text_written: 'full', enter_written: true });
		});

		test('the window\'s own time before the send comes off its budget with the hops before it (RULES-1.2)', async () => {
			const { lead, worker } = team(s);
			let now = 1_000;
			s.deps.monotonic = () => now;
			const answering = s.service({ caller: lead.id, tool: 'send_message', arguments: { to: worker.id, text: 'x' }, elapsedMs: 300 }, 400);
			now = 1_250;
			await answering;
			// Read at 400, sent at 1,250: 300 ms before the window and 850 in it
			assert.strictEqual(s.messages.sent[0].elapsedMs, 1_150);
		});

		test('an accepted message has its deadline and obstacle; a failure its reason and actual effects', async () => {
			const { lead, worker } = team(s);
			s.messages.respond = () => ({ status: 'accepted', obstacle: 'input_draft' });
			const answer = await s.call(lead, 'send_message', { to: worker.id, text: 'x' });
			const pending = resultOf(answer);
			assert.deepStrictEqual([pending.status, pending.data.deadline, pending.data.obstacle, pending.effects.outcome], ['accepted', '2026-10-28T23:00:15.000Z', 'input_draft', 'pending']);
			assert.match(headlineOf(answer), /its outcome is recorded later as a Facade result in your inbox/);
			s.messages.respond = () => ({ status: 'failure', reason: 'unsupported' });
			const failed = resultOf(await s.call(lead, 'send_message', { to: worker.id, text: 'x' }));
			assert.deepStrictEqual([failed.error?.code, failed.error?.reason, failed.data.message_id, failed.effects.outcome], ['UNAVAILABLE', 'unsupported', 'm-2', 'none']);
			assert.match(failed.error!.message, /Facade cannot type messages into the recipient's CLI; type_text still reaches its terminal/);
		});

		test('#human is the person in the caller\'s window; so is @human while no agent in reach is named human (RULES-2.3, O22, D85)', async () => {
			const { lead, worker } = team(s);
			for (const to of ['#human', '@human', 'human']) {
				const result = resultOf(await s.call(worker, 'send_message', { to, text: 'Done.' }));
				assert.deepStrictEqual([result.data.target, result.data.target_reference, result.data.disposition], ['#human', '#human', 'notified'], to);
			}
			assert.deepStrictEqual(s.messages.sent.map(each => each.to), ['@human', '@human', '@human']);
			// An agent named human in reach makes @human ambiguous; #human and its ID still decide
			const named = runFacts(9, { name: 'human', root: lead.id, creator: lead.id, origin: 'agent' });
			s.agents.add(named);
			const ambiguous = resultOf(await s.call(worker, 'send_message', { to: '@human', text: 'Which?' }));
			assert.deepStrictEqual([ambiguous.error?.code, ambiguous.error?.reason], ['INVALID', 'ambiguous_reference']);
			assert.match(ambiguous.error!.message, /Use #human for the person, or the agent's ID/);
			assert.strictEqual(resultOf(await s.call(worker, 'send_message', { to: '#human', text: 'You.' })).data.target, '#human');
			assert.strictEqual(resultOf(await s.call(worker, 'send_message', { to: '#a9', text: 'It.' })).data.target, named.id);
			// Outside the caller's reach the agent named human makes no ambiguity
			const outsider = runFacts(10, { name: 'outsider' });
			s.agents.add(outsider);
			assert.strictEqual(resultOf(await s.call(outsider, 'send_message', { to: '@human', text: 'Me.' })).data.target, '#human');
		});

		test('a shared name needs an ID, an ended agent takes no message, and reply_to must be in the caller\'s own inbox', async () => {
			const { lead, worker, helper } = team(s);
			s.agents.add(runFacts(6, { name: 'worker', root: lead.id }));
			assert.strictEqual(resultOf(await s.call(lead, 'send_message', { to: 'worker', text: 'x' })).error?.reason, 'ambiguous_reference');
			s.agents.add(runFacts(7, { name: 'gone', root: lead.id, lifecycle: 'ended' }));
			assert.strictEqual(resultOf(await s.call(lead, 'send_message', { to: '@gone', text: 'x' })).error?.reason, 'ended');
			const theirs = s.messages.deliver(lead, helper, 'for the helper');
			assert.strictEqual(resultOf(await s.call(lead, 'send_message', { to: '#a2', text: 'x', reply_to: theirs.id })).error?.reason, 'not_found');
			assert.strictEqual(s.messages.sent.length, 0);
			const mine = s.messages.deliver(worker, lead, 'question');
			const reply = resultOf(await s.call(lead, 'send_message', { to: '#a2', text: 'answer', reply_to: mine.alias }));
			assert.strictEqual(s.messages.sent[0].replyTo, mine.id);
			assert.strictEqual(reply.data.reply_to, mine.id);
		});
	});

	suite('read_messages', () => {

		test('returns only the caller\'s own messages that have not reached it - failed or still pending - oldest first as they were, then delivers them (COLLABORATION-3.1)', async () => {
			const { lead, worker, helper } = team(s);
			const first = s.messages.undelivered(worker, lead, 'one');
			const seen = s.messages.deliver(worker, lead, 'typed into its terminal');
			s.messages.undelivered(lead, worker, 'not mine');
			const second = s.messages.undelivered(helper, lead, 'two\nlines', 'pending');
			const answer = await s.call(lead, 'read_messages');
			const result = resultOf(answer);
			assert.deepStrictEqual(result.data.messages.map((each: { message_id: string; delivery: { status: string } }) => [each.message_id, each.delivery.status]), [[first.id, 'failure'], [second.id, 'pending']]);
			assert.deepStrictEqual(result.data.messages[0], {
				message_id: first.id, alias: first.alias, kind: 'message', from: worker.id, from_reference: '@worker #a2', to: lead.id, to_reference: '@lead #a1',
				at: new Date(first.at).toISOString(), window: 'win-1', environment: 'local', length: 3, text: 'one',
				delivery: { status: 'failure', reason: 'input_draft', effects: { outcome: 'none', text_written: 'none', enter_written: false }, attempts: 5 }
			});
			assert.strictEqual(result.data.messages[1].delivery.deadline, '2026-10-28T23:00:15.000Z');
			assert.match(answer.text, /\n {6}text: \|-\n {8}two\n {8}lines\n/);
			assert.deepStrictEqual(s.messages.delivered, [{ run: lead.id, ids: [first.id, second.id] }]);
			const again = resultOf(await s.call(lead, 'read_messages'));
			assert.deepStrictEqual([again.data.messages, headlineOf(await s.call(lead, 'read_messages'))], [[], 'Nothing is waiting for you: every message sent to you was delivered.']);
			const all = resultOf(await s.call(lead, 'read_messages', { all: true }));
			assert.deepStrictEqual(all.data.messages.map((each: { message_id: string; delivery: { delivered_via: string } }) => [each.message_id, each.delivery.delivered_via]),
				[[first.id, 'read'], [seen.id, 'terminal'], [second.id, 'read']]);
		});

		test('records are delivered once the answer was handed back, never before; one not handed back is read again', async () => {
			const { lead, worker } = team(s);
			const record = s.messages.undelivered(worker, lead, 'one');
			const served = await s.serve({ caller: lead.id, tool: 'read_messages', arguments: {} });
			assert.deepStrictEqual([resultOf(served.answer).data.messages.length, s.messages.delivered], [1, []]);
			// That answer did not reach the shim: the same record comes again, still not delivered
			const again = await s.serve({ caller: lead.id, tool: 'read_messages', arguments: {} });
			assert.deepStrictEqual(resultOf(again.answer).data.messages.map((each: { message_id: string; delivery: { status: string } }) => [each.message_id, each.delivery.status]), [[record.id, 'failure']]);
			again.delivered!();
			assert.deepStrictEqual(s.messages.delivered, [{ run: lead.id, ids: [record.id] }]);
			// Nothing read, nothing to deliver
			assert.strictEqual((await s.serve({ caller: lead.id, tool: 'read_messages', arguments: {} })).delivered, undefined);
		});

		test('reading by ID or all:true delivers what it returns that had not reached the caller, and only that', async () => {
			const { lead, worker } = team(s);
			const seen = s.messages.deliver(worker, lead, 'seen');
			const waiting = s.messages.undelivered(worker, lead, 'waiting');
			resultOf(await s.call(lead, 'read_messages', { ids: [seen.alias, waiting.alias] }));
			assert.deepStrictEqual(s.messages.delivered, [{ run: lead.id, ids: [seen.id, waiting.id] }]);
			assert.deepStrictEqual(s.messages.records.filter(each => each.to.run === lead.id).map(each => each.delivery.via), ['terminal', 'read']);
		});

		test('a Facade result names the call it completes and the agent it was on', async () => {
			const { lead, worker } = team(s);
			s.messages.report({ to: lead.id, callId: 'call-41', agent: worker.id, text: 'Started @worker #a2.' });
			const [result] = resultOf(await s.call(lead, 'read_messages')).data.messages;
			assert.deepStrictEqual([result.kind, result.from, result.call_id, result.agent, result.agent_reference], ['result', 'facade', 'call-41', worker.id, '@worker #a2']);
		});

		test('IDs are looked up in the caller\'s inbox only, even with YOLO', async () => {
			const { lead, worker, stranger } = team(s);
			const theirs = s.messages.deliver(lead, worker, 'for the worker');
			const mine = s.messages.deliver(lead, stranger, 'for the stranger');
			const none = resultOf(await s.call(stranger, 'read_messages', { ids: theirs.id }));
			assert.deepStrictEqual([none.error?.code, none.data.not_found], ['NOT_FOUND', [theirs.id]]);
			assert.doesNotMatch(JSON.stringify(none), /for the worker/);
			const some = resultOf(await s.call(stranger, 'read_messages', { ids: [mine.alias, theirs.alias] }));
			assert.deepStrictEqual([some.data.messages.map((each: { text: string }) => each.text), some.data.not_found], [['for the stranger'], [theirs.alias]]);
		});

		test('pages all retained messages with next_cursor', async () => {
			const { lead, worker } = team(s);
			for (let i = 0; i < 5; i++) {
				s.messages.deliver(worker, lead, `message ${i}`);
			}
			const first = resultOf(await s.call(lead, 'read_messages', { all: true, limit: 2 }));
			assert.deepStrictEqual([first.data.messages.length, first.data.next_cursor], [2, '2']);
			const second = resultOf(await s.call(lead, 'read_messages', { all: true, limit: 2, cursor: first.data.next_cursor }));
			assert.deepStrictEqual(second.data.messages.map((each: { text: string }) => each.text), ['message 2', 'message 3']);
		});

		test('above 8,000 combined code points the complete content goes in a file, with path, size and each message\'s details', async () => {
			const { lead, worker } = team(s);
			const a = s.messages.undelivered(worker, lead, 'a'.repeat(5000));
			const b = s.messages.undelivered(worker, lead, 'b'.repeat(3001));
			const answer = await s.call(lead, 'read_messages');
			const result = resultOf(answer);
			assert.strictEqual(s.written.length, 1);
			const [file] = s.written;
			assert.deepStrictEqual([file.kind, file.ids, file.home], ['messages', [a.id, b.id], s.deps.home]);
			assert.ok(file.text.includes(`[Facade message ${a.alias} | from @worker #a2 | to @lead #a1 | ${new Date(a.at).toISOString()} | 5000 code points]\n${a.text}\n[/Facade message ${a.alias}]`));
			assert.ok(file.text.includes(b.text));
			assert.deepStrictEqual(result.data.file, { path: `${s.deps.home}/results/messages-1.txt`, size: Buffer.byteLength(file.text), code_points: 8001 });
			assert.deepStrictEqual(result.data.messages.map((each: { message_id: string; text?: string; length: number }) => [each.message_id, each.text, each.length]), [[a.id, undefined, 5000], [b.id, undefined, 3001]]);
			assert.ok(answer.text.length < 4000);
			assert.deepStrictEqual(s.messages.delivered, [{ run: lead.id, ids: [a.id, b.id] }]);
		});

		test('at exactly 8,000 code points the messages are inline', async () => {
			const { lead, worker } = team(s);
			s.messages.undelivered(worker, lead, '\u{1F600}'.repeat(MESSAGE_LIMIT));
			const result = resultOf(await s.call(lead, 'read_messages'));
			assert.strictEqual(s.written.length, 0);
			assert.strictEqual(result.data.messages[0].length, MESSAGE_LIMIT);
		});

		test('a file that cannot be written fails the read, which changed nothing, and delivers nothing', async () => {
			const { lead, worker } = team(s);
			s.messages.undelivered(worker, lead, 'z'.repeat(9000));
			s.deps.writeResult = () => { throw new Error('ENOSPC: no space left on device'); };
			const result = resultOf(await s.call(lead, 'read_messages'));
			assert.deepStrictEqual([result.error?.code, result.error?.message, result.effects], ['UNAVAILABLE', 'ENOSPC: no space left on device', { outcome: 'none' }]);
			assert.deepStrictEqual(s.messages.delivered, []);
		});
	});

	suite('read_screen', () => {

		const screen = { lines: ['❯ [[hello]]', '  {{working}}'], text: ['❯ hello', '  working'], buffer: 'normal' as const, older: true, trimmed: false, capturedAt: Date.UTC(2026, 9, 28, 22), exited: false };

		test('returns the logical lines of a reachable agent, observed when, with annotations alongside', async () => {
			const { lead, helper } = team(s);
			s.terminal.screen = screen;
			const answer = await s.call(lead, 'read_screen', { agent: '@helper', lines: 20 });
			const result = resultOf(answer);
			assert.deepStrictEqual(s.terminal.reads, [{ run: helper.id, lines: 20 }]);
			assert.deepStrictEqual(result.data, {
				agent_id: helper.id, reference: '@helper #a3', window_id: 'win-1', observed_at: '2026-10-28T22:00:00.000Z', process_state: 'running', stale: false,
				buffer: 'normal', line_count: 2, older_lines: true, trimmed: false,
				text: '❯ hello\n  working', annotated: '❯ [[hello]]\n  {{working}}'
			});
			assert.match(answer.text, /\n {2}text: \|-\n {4}❯ hello\n {6}working\n/);
		});

		test('a retained ended screen is dated and stale, never live; one never captured is unavailable', async () => {
			const { lead } = team(s);
			s.agents.add(runFacts(5, { name: 'crashed', root: lead.id, lifecycle: 'ended' }));
			s.terminal.screen = { ...screen, exited: true };
			const answer = await s.call(lead, 'read_screen', { agent: '#a5' });
			const result = resultOf(answer);
			assert.deepStrictEqual([result.data.process_state, result.data.stale], ['ended', true]);
			assert.match(answer.text, /^The retained final screen of @crashed #a5 .* captured 2026-10-28T22:00:00\.000Z: its process has ended, so this is not live output\./);
			s.terminal.screen = undefined;
			assert.strictEqual(resultOf(await s.call(lead, 'read_screen', { agent: '#a5' })).error?.reason, 'ended');
		});

		test('the last alternate-screen frame comes apart from the final normal output, inline or in a file of its own', async () => {
			const { lead } = team(s);
			s.agents.add(runFacts(5, { name: 'tui', root: lead.id, lifecycle: 'ended' }));
			const frame = { lines: ['[[> menu]]', 'item'], text: ['> menu', 'item'], capturedAt: Date.UTC(2026, 9, 28, 21, 58) };
			s.terminal.screen = { ...screen, lines: ['$ exited'], text: ['$ exited'], exited: true, frame };
			const answer = await s.call(lead, 'read_screen', { agent: '#a5' });
			const result = resultOf(answer);
			assert.deepStrictEqual([result.data.text, result.data.last_alternate_frame], ['$ exited', { captured_at: '2026-10-28T21:58:00.000Z', line_count: 2, text: '> menu\nitem', annotated: '[[> menu]]\nitem' }]);
			assert.match(headlineOf(answer), /`last_alternate_frame` is apart from it: the last frame its full-screen program drew, as it left the alternate screen or ended on it at 2026-10-28T21:58:00\.000Z\./);
			const long = Array.from({ length: 150 }, (_, i) => `${i} ${'y'.repeat(60)}`);
			s.terminal.screen = { ...screen, frame: { lines: long, text: long, capturedAt: frame.capturedAt } };
			const filed = resultOf(await s.call(lead, 'read_screen', { agent: '#a2' }));
			assert.deepStrictEqual(s.written.map(each => [each.kind, each.text]), [['screen', '❯ hello\n  working\n'], ['screen', `${long.join('\n')}\n`]]);
			assert.deepStrictEqual([filed.data.text, filed.data.last_alternate_frame.text, filed.data.last_alternate_frame.file.path], [undefined, undefined, `${s.deps.home}/results/screen-2.txt`]);
		});

		test('empty live output is a successful empty read', async () => {
			const { lead } = team(s);
			s.terminal.screen = { ...screen, lines: [], text: [], older: false };
			const result = resultOf(await s.call(lead, 'read_screen', { agent: '#a2' }));
			assert.deepStrictEqual([result.status, result.data.text, result.data.line_count], ['success', '', 0]);
		});

		test('above 8,000 code points the complete screen goes in a file', async () => {
			const { lead } = team(s);
			const lines = Array.from({ length: 200 }, (_, i) => `${i} ${'x'.repeat(60)}`);
			s.terminal.screen = { ...screen, lines, text: lines };
			const result = resultOf(await s.call(lead, 'read_screen', { agent: '#a2', lines: 200 }));
			assert.deepStrictEqual([s.written[0].kind, s.written[0].text], ['screen', `${lines.join('\n')}\n`]);
			assert.strictEqual(result.data.text, undefined);
			assert.deepStrictEqual(result.data.file.path, `${s.deps.home}/results/screen-1.txt`);
		});

		test('a read that fails is unavailable and changed nothing', async () => {
			const { lead } = team(s);
			s.terminal.readScreen = async () => { throw new Error('ptyd closed the connection.'); };
			const result = resultOf(await s.call(lead, 'read_screen', { agent: '#a2' }));
			assert.deepStrictEqual([result.error?.code, result.error?.reason, result.effects], ['UNAVAILABLE', 'unavailable', { outcome: 'none' }]);
		});

		test('reach applies: another tree\'s agent is refused by ID', async () => {
			const { lead, stranger } = team(s);
			s.terminal.screen = screen;
			assert.strictEqual(resultOf(await s.call(lead, 'read_screen', { agent: stranger.alias })).error?.reason, 'out_of_tree');
			assert.deepStrictEqual(s.terminal.reads, []);
		});
	});

	suite('type_text and press_keys', () => {

		test('type_text writes exactly the text and Enter, and reports what went in', async () => {
			const { lead, worker } = team(s);
			const text = 'first line\n\tsecond line   ';
			const answer = await s.call(lead, 'type_text', { agent: '@worker', text, enter: true });
			const result = resultOf(answer);
			assert.deepStrictEqual(s.terminal.typed, [{ run: worker.id, text, enter: true }]);
			assert.deepStrictEqual(result.effects, { outcome: 'confirmed', text_written: 'full', enter_written: true });
			assert.deepStrictEqual(result.data, { agent_id: worker.id, reference: '@worker #a2', length: 26, enter: true });
			const plain = resultOf(await s.call(lead, 'type_text', { agent: '@worker', text: 'y' }));
			assert.deepStrictEqual(plain.effects, { outcome: 'confirmed', text_written: 'full', enter_written: false });
			const enter = resultOf(await s.call(lead, 'type_text', { agent: '@worker', text: '', enter: true }));
			assert.deepStrictEqual(enter.effects, { outcome: 'confirmed', text_written: 'none', enter_written: true });
		});

		test('type_text reports partial, nothing and unknown honestly, and never retries', async () => {
			const { lead } = team(s);
			s.terminal.typeWith = { outcome: 'partial', reason: 'ended', pasted: true, entered: false };
			const partial = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: 'x', enter: true }));
			assert.deepStrictEqual([partial.error?.reason, partial.effects], ['partial_input', { outcome: 'partial', text_written: 'full', enter_written: false }]);
			s.terminal.typeWith = { outcome: 'not_applied', reason: 'ended' };
			const none = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: 'x' }));
			assert.deepStrictEqual([none.error?.reason, none.effects], ['ended', { outcome: 'none', text_written: 'none', enter_written: false }]);
			s.terminal.typeWith = new Error('ptyd connection lost');
			const unknown = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: 'x' }));
			assert.deepStrictEqual([unknown.error?.code, unknown.error?.message, unknown.effects], ['FAILED', 'ptyd connection lost', { outcome: 'unknown', text_written: 'unknown', enter_written: null }]);
			// Never sent to the runtime: nothing went in
			s.terminal.typeWith = Object.assign(new Error('The agent runtime (ptyd) cannot be reached.'), { code: 'UNAVAILABLE', reason: 'unavailable' });
			const unsent = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: 'x' }));
			assert.deepStrictEqual([unsent.error?.code, unsent.error?.reason, unsent.effects], ['UNAVAILABLE', 'unavailable', { outcome: 'none', text_written: 'none', enter_written: false }]);
			assert.strictEqual(s.terminal.typed.length, 4);
		});

		test('control characters are refused toward press_keys before anything is typed', async () => {
			const { lead } = team(s);
			const result = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: 'quit\x1b' }));
			assert.deepStrictEqual([result.error?.code, result.error?.reason], ['INVALID', 'invalid_argument']);
			assert.match(result.error!.message, /press_keys/);
			assert.deepStrictEqual(s.terminal.typed, []);
		});

		test('direct input needs a live process: an ended or still starting agent takes none', async () => {
			const { lead } = team(s);
			s.agents.add(runFacts(5, { name: 'gone', root: lead.id, lifecycle: 'ended' }), runFacts(6, { name: 'new', root: lead.id, lifecycle: 'starting', pid: undefined }));
			assert.strictEqual(resultOf(await s.call(lead, 'type_text', { agent: '@gone', text: 'x' })).error?.reason, 'ended');
			assert.strictEqual(resultOf(await s.call(lead, 'press_keys', { agent: '@new', keys: 'Enter' })).error?.reason, 'not_started');
			assert.deepStrictEqual([s.terminal.typed, s.terminal.pressed], [[], []]);
		});

		test('press_keys sends the normalized keys and reports how many went in', async () => {
			const { lead, worker } = team(s);
			const result = resultOf(await s.call(lead, 'press_keys', { agent: worker.id, keys: ['Esc', 'ArrowUp', 'Return', 'ctrl+c'] }));
			assert.deepStrictEqual(s.terminal.pressed, [{ run: worker.id, keys: ['Escape', 'Up', 'Enter', 'Ctrl+C'] }]);
			assert.deepStrictEqual(result.effects, { outcome: 'confirmed', keys_sent: 4 });
			s.terminal.keysWith = { outcome: 'partial', reason: 'ended', keysSent: 1 };
			const partial = resultOf(await s.call(lead, 'press_keys', { agent: worker.id, keys: ['Down', 'Down'] }));
			assert.deepStrictEqual([partial.error?.reason, partial.effects], ['partial_input', { outcome: 'partial', keys_sent: 1 }]);
			s.terminal.keysWith = new Error('lost');
			assert.deepStrictEqual(resultOf(await s.call(lead, 'press_keys', { agent: worker.id, keys: 'Tab' })).effects, { outcome: 'unknown' });
			s.terminal.keysWith = Object.assign(new Error('The agent runtime (ptyd) cannot be reached.'), { code: 'UNAVAILABLE', reason: 'unavailable' });
			assert.deepStrictEqual(resultOf(await s.call(lead, 'press_keys', { agent: worker.id, keys: 'Tab' })).effects, { outcome: 'none', keys_sent: 0 });
			const unknownKey = resultOf(await s.call(lead, 'press_keys', { agent: worker.id, keys: ['Enter', 'F13'] }));
			assert.strictEqual(unknownKey.error?.reason, 'invalid_argument');
			assert.strictEqual(s.terminal.pressed.length, 4);
		});
	});
});
