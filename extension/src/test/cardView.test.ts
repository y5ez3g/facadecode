/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ROBOT_ICONS, ROBOTS } from '../base/robot';
import { BUILT_IN_ADAPTERS } from '../clis/catalog';
import { activityOf } from '../clis/activity';
import { parseStatus } from '../ptyd/status';
import type { RunFacts } from '../core/ports';
import { avatarOf, cardOf, CardPlace, CardWords, statusOf } from '../ui/cardView';
import type * as PresentationModule from '../ui/presentation';
import { withModules } from './withModules';
import { linesOf, placeOf } from './detailLines';
import type { Card } from '../webview/protocol';

const WORDS: CardWords = {
	title: value => `Title: ${value}`,
	location: value => `Location: ${value}`,
	path: value => `Path: ${value}`,
	untitledPending: 'No title yet',
	untitledUnreadable: 'Title unavailable',

	starting: 'Starting',
	startingCli: cli => `Starting ${cli}...`,
	creatingWorktree: 'Creating worktree...',
	started: 'New conversation started',
	resumed: 'Conversation resumed',
	working: 'Working',
	notWorking: 'Idle',
	error: reason => `Error · ${reason}`,
	activityUnavailable: 'Status unavailable · check terminal',
	activityUnknown: why => `Status ${why} · check terminal`,
	needsAttention: 'Attention needed', toolsConnecting: 'Collaboration not connected yet',
	needsPermission: 'Permission needed',
	needsSignIn: 'Sign-in needed',
	hasQuestion: 'Answer needed',
	exitedWithCode: code => `Beendet mit Code ${code}`,
	endedBySignal: signal => `Durch Signal ${signal} beendet`,
	toolsUnavailable: problem => `Collaboration off · ${problem}`,
	saidByAgent: (sender: string, line: string) => `Last message from agent ${sender}: ${line}`, saidByPerson: (line: string) => `Your last input: ${line}`, saidByFacade: (line: string) => `Facade result: ${line}`,
	exitUnknown: 'Getrennt: Exit-Ursache unbekannt',
	startFailed: reason => `Start failed · ${reason}`,
	worktreeFailed: reason => `Worktree failed · ${reason}`
};

function run(more: Partial<RunFacts> = {}): RunFacts {
	return {
		id: 'run-00000000000000000000000000000001', alias: '#a1', name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude',
		location: 'loc-1', cwd: '/app', environment: 'local', yolo: true, createdAt: 1000,
		lifecycle: 'running', phase: 'running', pid: 42, startedAt: 2000, activity: 'working', reporting: true,
		root: 'run-00000000000000000000000000000001', origin: 'human', tools: 'not_injected', ...more
	};
}

const place = { label: 'main', qualified: 'shop · main', folderPrefix: 'shop', context: 'shop · main', path: '/app', kind: 'repo' as const };
const menu = { moveUp: false, moveDown: true };

suite('Cards: dot, second line, details and label (RULES-3.2, PANEL-1.3-1.5)', () => {

	test('all CLIs retain a blocker without a recognized kind, its full reason on its second line and in its label', () => {
		const message = `Please review ${'a long explanation '.repeat(30)}👨‍👩‍👧‍👦`;
		for (const cli of [...BUILT_IN_ADAPTERS.map(adapter => adapter.id), 'custom']) {
			for (const kind of ['', ':kind=future']) {
				const report = parseStatus(`state=blocked${kind}:msg=${Buffer.from(message).toString('base64')}`);
				assert.ok(report && report !== 'query' && report.state === 'blocked');
				const { activity, reporting, blocker } = activityOf({ ...report, state: 'blocked' });
				const facts = run({ cli, activity, reporting, blocker });
				const card = cardOf(facts, { place, selected: false, menu, words: WORDS });
				assert.deepStrictEqual([card.dot, card.stateText, card.line], ['none', 'Attention needed', `Attention needed · ${message}`], cli);
				assert.ok(card.label.endsWith(`Claude Code, Attention needed · ${message}`), cli);
			}
		}
	});

	test('RULES-3.2: green while it starts or works; red for an error, Facade tools it cannot use or a start not ready by its bound; none otherwise, its state in its label', () => {
		const shown = (facts: RunFacts) => {
			const card = cardOf(facts, { place, selected: false, menu, words: WORDS });
			return [card.dot, card.stateText, card.line, card.label.split(', ').includes(card.stateText)];
		};
		assert.deepStrictEqual([
			shown(run({ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, tools: 'connecting' })),
			shown(run({ activity: 'not_working', awaitingActivity: true, tools: 'connecting' })),
			shown(run({ activity: 'working', said: 'fix the login bug' })),
			shown(run({ activity: 'not_working', said: 'fix the login bug' })),
			shown(run({ activity: 'unknown', reporting: false, activityReason: 'The terminal was reset', said: 'fix the login bug' })),
			shown(run({ activity: 'not_working', blocker: { kind: 'permission', text: 'Run npm test?' }, notReady: true, tools: 'connecting' })),
			shown(run({ activity: 'not_working', notReady: true, tools: 'connecting', said: 'fix the login bug' })),
			shown(run({ activity: 'unknown', reporting: false, notReady: true, activityReason: 'CLI has not reported activity' })),
			shown(run({ activity: 'working', tools: 'unavailable', toolsProblem: 'conflict', toolsFile: 'SKILL.md' })),
			shown(run({ activity: 'working', error: { reason: 'Failed', source: 'cli', at: 1 } }))
		], [
			['working', 'Starting', 'Starting Claude Code...', true],
			['working', 'Starting', 'Starting Claude Code...', true],
			['working', 'Working', '🧑‍💻 fix the login bug', true],
			['none', 'Idle', '🧑‍💻 fix the login bug', true],
			['none', 'Status unavailable · check terminal', '🧑‍💻 fix the login bug', true],
			['none', 'Permission needed', 'Permission needed · Run npm test?', true],
			['error', 'Collaboration not connected yet', 'Collaboration not connected yet', true],
			['error', 'CLI has not reported activity', 'CLI has not reported activity', true],
			['error', 'Collaboration off · conflict', 'Collaboration off · conflict', true],
			['error', 'Error · Failed', 'Failed', true]
		]);
	});

	test('PANEL-1.4: the second line says the last message sent to it - the task it was started with being the first - and before any, how its run began: never its title', () => {
		const line = (facts: Partial<RunFacts>) => statusOf(run({ activity: 'not_working', ...facts }), WORDS).line;
		assert.deepStrictEqual([
			line({ title: 'Fixing the login bug' }),
			line({ title: 'Fixing the login bug', said: '/clear' }),
			line({ title: 'Fixing the login bug', promptLine: 'Implement the parser' }),
			line({ title: 'Fixing the login bug', promptLine: 'Implement the parser', said: 'and the tests' }),
			line({ title: 'Fixing the login bug', resumed: true }),
			line({ resumed: true, said: 'go on' }),
			line({})
		], ['New conversation started', '🧑‍💻 /clear', '📨 Implement the parser', '🧑‍💻 and the tests', 'Conversation resumed', '🧑‍💻 go on', 'New conversation started']);
	});

	test('PANEL-1.4: the second line is one of three kinds - the person\'s input after 🧑‍💻 and a space, another agent\'s message after 📨 and a space, Facade\'s own with no mark: a result without the 🔔 it is typed to its agent with, a notable state while it lasts and then the last message again, or how its run began - never a title, Working, Idle or Status unavailable · check terminal', () => {
		const typed = { said: 'fix the login bug' };
		const sent = { said: 'Review the parser', saidSource: { kind: 'agent', name: 'Lead', alias: '#a2' } } as const;
		const task = { promptLine: 'Implement the parser', origin: 'agent', creatorLabel: 'Lead #a2' } as const;
		const red = { reporting: false, notReady: true, activityReason: 'CLI has not reported activity' } as const;
		const cases: [Partial<RunFacts>, string][] = [
			[typed, '🧑‍💻 fix the login bug'],
			[sent, '📨 Review the parser'],
			[task, '📨 Implement the parser'],
			[{ said: '🔔 Your message #m4 has been passed on.', saidSource: { kind: 'facade' } }, 'Your message #m4 has been passed on.'],
			// Its start, over an earlier message: its stage, while it lasts
			[{ ...typed, lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false }, 'Starting Claude Code...'],
			[{ ...task, lifecycle: 'starting', phase: 'creating_worktree', activity: 'unknown', reporting: false }, 'Creating worktree...'],
			[{ ...sent, activity: 'unknown', awaitingActivity: true }, 'Starting Claude Code...'],
			// What its CLI waits for
			[{ ...typed, blocker: { kind: 'permission', text: 'Allow Bash?' } }, 'Permission needed · Allow Bash?'],
			[{ ...typed, blocker: { kind: 'auth' } }, 'Sign-in needed'],
			[{ ...typed, blocker: { kind: 'question' } }, 'Answer needed'],
			[{ ...typed, blocker: { kind: 'unknown', text: 'Check the terminal' } }, 'Attention needed · Check the terminal'],
			// Why it is red, without `Error · `: the red dot says that
			[{ ...typed, error: { reason: 'Rate limited', source: 'cli', at: 1 } }, 'Rate limited'],
			[{ ...typed, tools: 'unavailable', toolsProblem: 'conflict', toolsFile: 'SKILL.md' }, 'Collaboration off · conflict'],
			[{ ...typed, tools: 'connecting', notReady: true }, 'Collaboration not connected yet'],
			[{ ...typed, ...red, activity: 'unknown' }, 'CLI has not reported activity'],
			// None any more: its last message again; before any, how its run began
			[{ ...typed, activity: 'working' }, '🧑‍💻 fix the login bug'],
			[{ activity: 'working' }, 'New conversation started'],
			[{ activity: 'unknown', reporting: false }, 'New conversation started'],
			[{ activity: 'not_working', resumed: true }, 'Conversation resumed']
		];
		const lines = cases.map(([facts]) => statusOf(run({ activity: 'not_working', title: 'Secret title', ...facts }), WORDS).line);
		assert.deepStrictEqual(lines, cases.map(([, line]) => line));
		assert.deepStrictEqual(lines.filter(line => /^\u{1F514}/u.test(line) || /Secret title|Working|Idle|Status unavailable · check terminal/.test(line)), []);
	});

	test('PANEL-1.4, 1.5: another agent\'s message is marked 📨 by who its record says sent it - never by its text - its sender and source in words for a screen reader; the person\'s input and a Facade result name none', () => {
		const cardWith = (facts: Partial<RunFacts>) => cardOf(run({ activity: 'not_working', ...facts }), { place, selected: false, menu, words: WORDS });
		const agent = cardWith({ said: 'Fix the login', saidSource: { kind: 'agent', name: 'Time-pi-3', alias: '#a65' } });
		assert.strictEqual(agent.line, '📨 Fix the login');
		assert.ok(agent.label.endsWith('Last message from agent Time-pi-3 (#a65): Fix the login'), agent.label);
		const away = cardWith({ said: 'Fix it', saidSource: { kind: 'agent', alias: '#a7', window: 'Design' } });
		assert.ok(away.label.endsWith('Last message from agent #a7, Design: Fix it'), away.label);
		const person = cardWith({ said: '📨 a person typed this' });
		assert.deepStrictEqual([person.line, person.label.endsWith('Your last input: 📨 a person typed this')], ['🧑‍💻 📨 a person typed this', true]);
		const result = cardWith({ said: '🔔 Your message #m42 has been passed on.', saidSource: { kind: 'facade' } });
		assert.deepStrictEqual([result.line, result.label.endsWith('Facade result: Your message #m42 has been passed on.')], ['Your message #m42 has been passed on.', true]);
		// A creation prompt is its creator's message, on either path; the details say who started it (PANEL-1.5)
		const task = cardWith({ promptLine: 'Implement the parser', origin: 'agent', creatorLabel: 'Maker #a7' });
		assert.deepStrictEqual([task.line, task.label.endsWith('Last message from agent Maker (#a7): Implement the parser'), task.details.startedBy], ['📨 Implement the parser', true, 'Maker #a7']);
		// A question takes the line, its state saying it
		const asked = cardWith({ said: 'Fix it', saidSource: { kind: 'agent', name: 'A', alias: '#a2' }, blocker: { kind: 'question' } });
		assert.deepStrictEqual([asked.line, asked.label.endsWith('Answer needed, shop · main, Claude Code')], ['Answer needed', true]);
	});

	test('a start not ready by its bound says its connecting tools on its red second line (RULES-3.2), and actual connection removes them; the details say its conversation\'s title', () => {
		for (const activity of ['working', 'not_working'] as const) {
			const facts = run({ activity, title: 'Checking tests', tools: 'connecting' });
			const card = cardOf(facts, { place, selected: false, menu, words: WORDS });
			assert.strictEqual(card.dot, activity === 'working' ? 'working' : 'none');
			assert.strictEqual(card.line, 'New conversation started');
			const late = statusOf({ ...facts, notReady: true }, WORDS);
			assert.deepStrictEqual([late.dot, late.line], ['error', `${WORDS.toolsConnecting}`]);
			assert.ok(linesOf(card).includes(WORDS.title('Checking tests')));
			assert.strictEqual(statusOf({ ...facts, tools: 'available' }, WORDS).line, 'New conversation started');
			assert.strictEqual(statusOf({ ...facts, blocker: { kind: 'unknown' } }, WORDS).line, `${WORDS.needsAttention}`);
			assert.strictEqual(statusOf({ ...facts, error: { source: 'cli', reason: 'Failed', at: 1 } }, WORDS).line, 'Failed');
			const ended = cardOf({ ...facts, lifecycle: 'ended', end: { kind: 'abnormal', at: 3, code: 1 } }, { place, selected: false, menu, words: WORDS });
			assert.ok(!ended.line.includes(WORDS.toolsConnecting));
		}
		const starting = cardOf(run({ lifecycle: 'starting', phase: 'launching_cli', tools: 'connecting' }), { place, selected: false, menu, words: WORDS });
		assert.strictEqual(starting.line, 'Starting Claude Code...');
	});

	test('the details keep its conversation\'s title whole, as Resume Agent lists it - its symbols and multi-code-point emoji included - and never on its second line (CLIS-2.4, PANEL-1.4, 1.5)', () => {
		const title = `✳ ${'a'.repeat(100)}👨‍👩‍👧‍👦 | workspace`;
		const card = cardOf(run({ title }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([card.line, card.details.summary, card.label.includes(title)], ['New conversation started', { id: 'title', label: 'Title: ', value: title }, false]);
	});

	test('PANEL-1.4: a native blocker leads the second line over another red condition - unusable tools, a start not ready - though not over an error', () => {
		const line = (more: Partial<RunFacts>) => statusOf(run({ activity: 'not_working', blocker: { kind: 'question', text: 'Proceed?' }, ...more }), WORDS);
		const blocked = [line({ tools: 'unavailable', toolsProblem: 'conflict', toolsFile: 'SKILL.md' }), line({ reporting: false, notReady: true, tools: 'connecting' })];
		const erred = line({ error: { reason: 'Rate limited', source: 'cli', at: 1 } });
		assert.deepStrictEqual([...blocked.map(each => [each.dot, each.line]), [erred.dot, erred.line]], [['none', 'Answer needed · Proceed?'], ['none', 'Answer needed · Proceed?'], ['error', 'Rate limited']]);
	});

	test('PANEL-1.5: the accessible description does not say a title the second line says already', () => {
		const card = cardOf(run({ title: 'Fix the login', said: 'Fix the login' }), { place, selected: false, menu, words: WORDS });
		const other = cardOf(run({ title: 'Fix the login', said: 'Something else' }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([card.details.description.title, other.details.description.title], ['', 'Title: Fix the login']);
	});

	test('PANEL-1.4, 1.5: the label says once what the state and second line leave unsaid - why activity is unknown, tools still connecting before and after the bound - and nothing once they connect or the run ended; five details rows stay', () => {
		const label = (more: Partial<RunFacts>) => cardOf(run(more), { place, selected: false, menu, words: WORDS }).label;
		const reset = { activity: 'unknown', reporting: true, activityReason: 'The terminal was reset; waiting for activity', activityUnknown: 'screen_reset' } as const;
		const waiting = { activity: 'unknown', reporting: true, activityReason: 'Waiting for first CLI activity report', activityUnknown: 'waiting' } as const;
		const labels = [
			label(reset),
			label(waiting),
			label({ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, tools: 'connecting' }),
			label({ activity: 'working', tools: 'connecting' }),
			label({ activity: 'not_working', tools: 'connecting', notReady: true }),
			label({ activity: 'working', tools: 'available' }),
			label({ ...reset, tools: 'connecting' }),
			label({ tools: 'connecting', lifecycle: 'ended', end: { kind: 'abnormal', code: 1, at: 3 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } })
		];
		assert.deepStrictEqual(labels, [
			'Ada, #a1, Status unavailable · check terminal, shop · main, Claude Code, New conversation started, Status screen_reset · check terminal',
			'Ada, #a1, Status unavailable · check terminal, shop · main, Claude Code, New conversation started, Status waiting · check terminal',
			'Ada, #a1, Starting, shop · main, Claude Code, Starting Claude Code..., Collaboration not connected yet',
			'Ada, #a1, Working, shop · main, Claude Code, New conversation started, Collaboration not connected yet',
			'Ada, #a1, Collaboration not connected yet, shop · main, Claude Code',
			'Ada, #a1, Working, shop · main, Claude Code, New conversation started',
			'Ada, #a1, Status unavailable · check terminal, shop · main, Claude Code, New conversation started, Status screen_reset · check terminal, Collaboration not connected yet',
			'Ada, #a1, Error · Beendet mit Code 1, shop · main, Claude Code'
		]);
		assert.ok(labels.every(each => each.split(', ').length === new Set(each.split(', ')).size), 'no part twice');
		assert.strictEqual(Object.keys(cardOf(run(reset), { place, selected: false, menu, words: WORDS }).details).filter(key => ['summary', 'untitled', 'startedBy', 'location', 'path'].includes(key)).length, 3);
	});

	test('PANEL-1.5, CLIS-2.4: an absent or blank title keeps its Title: label - No title yet while its CLI has not saved one, Title unavailable where Facade has no history reader for its CLI - and the description says the same first fact', () => {
		const details = (more: Partial<RunFacts>, readsTitles?: boolean) => cardOf(run(more), { place, selected: false, menu, words: WORDS, ...readsTitles === undefined ? {} : { readsTitles } }).details;
		const shown = (each: Card['details']) => [each.summary?.value, each.untitled, each.titleLabel, each.description.title];
		assert.deepStrictEqual([details({}), details({ title: '  ' }), details({}, true), details({ cli: 'my-cli', displayName: 'my-cli' }, false), details({ title: 'Fix login' }, false)].map(shown), [
			[undefined, 'No title yet', 'Title: ', 'Title: No title yet'],
			[undefined, 'No title yet', 'Title: ', 'Title: No title yet'],
			[undefined, 'No title yet', 'Title: ', 'Title: No title yet'],
			[undefined, 'Title unavailable', 'Title: ', 'Title: Title unavailable'],
			['Fix login', undefined, 'Title: ', 'Title: Fix login']
		]);
	});

	test('PANEL-1.5: the details\' title is its conversation\'s as it is - its CLI\'s name or its own among them - else none, for the page\'s untitled words: never its creation prompt', () => {
		const summary = (more: Partial<RunFacts>) => cardOf(run(more), { place, selected: false, menu, words: WORDS }).details.summary;
		assert.deepStrictEqual([
			summary({ title: 'Claude Code' }),
			summary({ title: 'Ada', promptLine: 'Implement the parser' }),
			summary({ promptLine: 'Implement the parser', origin: 'agent', creatorLabel: 'Maker #a7' }),
			summary({ title: '  ' }),
			summary({})
		], [{ id: 'title', label: 'Title: ', value: 'Claude Code' }, { id: 'title', label: 'Title: ', value: 'Ada' }, undefined, undefined, undefined]);
	});

	test('tools that went as the process ended are no problem of the ended card, which says how it ended; tools a live run lost are said on its red second line', () => {
		const lost = { tools: 'unavailable', toolsProblem: 'disconnected' } as const;
		const ended = cardOf(run({ ...lost, lifecycle: 'ended', end: { kind: 'abnormal', at: 3, code: 1 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } }), { place, selected: false, menu, words: WORDS });
		const live = cardOf(run({ ...lost, activity: 'not_working', reporting: true }), { place, selected: false, menu, words: WORDS });
		const never = cardOf(run({ tools: 'unavailable', toolsProblem: 'conflict', lifecycle: 'ended', end: { kind: 'abnormal', at: 3, code: 1 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } }), { place, selected: false, menu, words: WORDS });
		const said = (card: Pick<Card, 'line' | 'label'>) => card.line.startsWith('Collaboration off') && card.label.includes(card.line);
		assert.deepStrictEqual([said(ended), said(live), said(never), ended.line, never.line], [false, true, false, 'Beendet mit Code 1', 'Beendet mit Code 1']);
	});

	test('PANEL-1.4, WORKTREES-2.2: a failed worktree says Worktree failed and its reason without its period - its notification keeps its own sentence and what was kept; a start that failed after it was made says Start failed', () => {
		const effects = { branch: 'fix', folder: '/app.worktrees/fix' };
		const worktree = cardOf(run({ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason: 'Git reported: fatal: disk full.', source: 'worktree', at: 3, worktree: effects } }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([worktree.dot, worktree.line, worktree.stateText], ['error', 'Worktree failed · Git reported: fatal: disk full', 'Error · Worktree failed · Git reported: fatal: disk full']);
		const launched = statusOf(run({ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason: 'spawn refused。', source: 'launch', at: 3, worktree: effects } }), WORDS);
		assert.strictEqual(launched.line, 'Start failed · spawn refused');
		// The notifications say what they did, unchanged: their own sentence, and what was created and kept
		const vscode = { l10n: { t: (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(values[Number(i)])) } };
		const { launchFailureText, worktreeFailureText } = withModules({ vscode })<typeof PresentationModule>(require.resolve('../ui/presentation'));
		assert.deepStrictEqual([worktreeFailureText('Git reported: fatal: disk full.', effects), launchFailureText('Ada', 'Git reported: fatal: disk full.', effects)], [
			'Could not create worktree: Git reported: fatal: disk full. Branch fix and folder /app.worktrees/fix were created and kept.',
			'Could not start Ada: Git reported: fatal: disk full. Branch fix and folder /app.worktrees/fix were created and kept.'
		]);
	});

	test('PANEL-1.4: a start that failed says Start failed and the failure\'s own sentence without its closing period - "." or "。" - its notification keeping `Could not start {0}: {1}.`; exits and other errors say no Start failed', () => {
		const failed = (reason: string, source = 'launch') => cardOf(run({ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason, source, at: 3 } }), { place, selected: false, menu, words: WORDS });
		const card = failed('claude was not found on PATH.');
		assert.deepStrictEqual([card.dot, card.line, card.stateText, card.label], ['error', 'Start failed · claude was not found on PATH', 'Error · Start failed · claude was not found on PATH',
			'Ada, #a1, Error · Start failed · claude was not found on PATH, shop · main, Claude Code']);
		assert.deepStrictEqual([failed('找不到 claude。').line, failed('The working location /app is no longer available.', 'location').line, failed('Rate limited', 'cli').line, failed('Could not remove the Pin', 'pin').line], [
			'Start failed · 找不到 claude', 'Start failed · The working location /app is no longer available', 'Rate limited', 'Could not remove the Pin'
		]);
		const exited = statusOf(run({ lifecycle: 'ended', end: { kind: 'abnormal', code: 1, at: 3 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } }), WORDS);
		assert.strictEqual(exited.line, 'Beendet mit Code 1');
		const vscode = { l10n: { t: (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(values[Number(i)])) } };
		const { launchFailureText } = withModules({ vscode })<typeof PresentationModule>(require.resolve('../ui/presentation'));
		assert.strictEqual(launchFailureText('Ada', 'claude was not found on PATH.'), 'Could not start Ada: claude was not found on PATH.');
	});

	test('PANEL-1.4, MCP-3.1: why its activity is unknown is said in the person\'s words where its report names the reason; the English it keeps for agents is not shown', () => {
		const facts = run({ activity: 'unknown', reporting: false, notReady: true, activityReason: 'CLI has not reported activity', activityUnknown: 'not_reporting' });
		const words: CardWords = { ...WORDS, activityUnknown: why => why === 'not_reporting' ? 'CLI 未返回状态 · 请查看终端' : 'other' };
		const card = cardOf(facts, { place, selected: false, menu, words });
		assert.deepStrictEqual([card.line, card.stateText, card.label.includes('CLI has not reported activity')], ['CLI 未返回状态 · 请查看终端', 'CLI 未返回状态 · 请查看终端', false]);
		const quiet = statusOf(run({ activity: 'unknown', reporting: false, activityReason: 'The terminal was reset; waiting for activity', activityUnknown: 'screen_reset' }), WORDS);
		assert.strictEqual(quiet.reason, 'Status screen_reset · check terminal');
	});

	test('J05: an unresolved error is red with its reason first, whatever else is known - its state `Error · {reason}`, its second line the reason alone; unknown activity has no dot, its second line saying how its run began where it has nothing else to say (RULES-3.2, PANEL-1.4)', () => {
		const cases: [Partial<RunFacts>, string, string, string][] = [
			[{ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason: 'claude was not found', source: 'launch', at: 3 }, title: 'T', blocker: { kind: 'question' } }, 'error', 'Error · Start failed · claude was not found', 'Start failed · claude was not found'],
			[{ lifecycle: 'ended', end: { kind: 'abnormal', code: 2, at: 3 }, error: { reason: 'Exited with code 2', source: 'exit', at: 3 } }, 'error', 'Error · Beendet mit Code 2', 'Beendet mit Code 2'],
			[{ activity: 'working', error: { reason: 'Rate limited', source: 'cli', at: 3 }, title: 'Fix login' }, 'error', 'Error · Rate limited', 'Rate limited'],
			[{ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, error: { reason: 'Spawn failed', source: 'launch', at: 3 } }, 'error', 'Error · Start failed · Spawn failed', 'Start failed · Spawn failed'],
			[{ activity: 'unknown', reporting: false }, 'none', 'Status unavailable · check terminal', 'New conversation started'],
			[{ activity: 'unknown', reporting: false, activityReason: 'This CLI reports no activity' }, 'none', 'Status unavailable · check terminal', 'New conversation started'],
			[{ activity: 'unknown', reporting: false, activityReason: 'This CLI reports no activity', title: 'Fix login' }, 'none', 'Status unavailable · check terminal', 'New conversation started'],
			[{ activity: 'working', reporting: false, title: 'Fix login', resumed: true }, 'none', 'Status unavailable · check terminal', 'Conversation resumed']
		];
		for (const [facts, dot, stateText, notice] of cases) {
			assert.deepStrictEqual(statusOf(run(facts), WORDS), { dot, stateText, line: `${notice}`, notice, ...(facts.activityReason && !facts.error ? { reason: facts.activityReason } : {}) }, JSON.stringify(facts));
		}
	});

	test('a native blocker has no dot and says the CLI\'s own words, else Permission needed, Sign-in needed or Answer needed; startup is green (RULES-3.2)', () => {
		assert.deepStrictEqual([
			statusOf(run({ activity: 'not_working', blocker: { kind: 'permission', text: 'Allow Bash(npm test)?' } }), WORDS),
			statusOf(run({ activity: 'not_working', blocker: { kind: 'permission' } }), WORDS).line,
			statusOf(run({ activity: 'not_working', blocker: { kind: 'auth' } }), WORDS).line,
			statusOf(run({ activity: 'not_working', blocker: { kind: 'question', text: '  ' } }), WORDS).line,
			statusOf(run({ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, title: 'T' }), WORDS),
			statusOf(run({ lifecycle: 'starting', phase: 'creating_worktree', activity: 'unknown', reporting: false }), WORDS).line
		], [
			{ dot: 'none', stateText: 'Permission needed', line: 'Permission needed · Allow Bash(npm test)?', notice: 'Permission needed · Allow Bash(npm test)?', reason: 'Allow Bash(npm test)?' },
			'Permission needed',
			'Sign-in needed',
			'Answer needed',
			{ dot: 'working', stateText: 'Starting', line: 'Starting Claude Code...', notice: 'Starting Claude Code...' },
			'Creating worktree...'
		]);
	});

	test('a run whose CLI has shown no activity yet is still starting, green, its stage on the second line over any message or title; an error still comes first, red (CLIS-2.3, PANEL-1.4)', () => {
		const connection = { reason: "Connection to agent process lost; reconnecting", source: 'connection', at: 3 };
		const stage = { dot: 'working', stateText: 'Starting', line: 'Starting Claude Code...', notice: 'Starting Claude Code...' };
		assert.deepStrictEqual([
			statusOf(run({ activity: 'unknown', reporting: false, awaitingActivity: true, title: 'Fix login' }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: true, awaitingActivity: true }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: true, awaitingActivity: true, said: 'fix the login', resumed: true }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: false, awaitingActivity: true, error: connection }), WORDS).dot,
			statusOf(run({ activity: 'unknown', reporting: false, activityReason: "CLI has not reported activity" }), WORDS).dot
		], [stage, stage, stage, 'error', 'none']);
	});

	test('a known native blocker leads the second line in its own words whatever the activity, without a dot (PANEL-1.4, RULES-3.2)', () => {
		assert.deepStrictEqual([
			statusOf(run({ activity: 'unknown', reporting: false, blocker: { kind: 'auth' } }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: true, blocker: { kind: 'question' } }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: false, activityReason: 'No activity report since 10:02', blocker: { kind: 'permission', text: 'Allow Bash?' } }), WORDS).line
		], [
			{ dot: 'none', stateText: 'Sign-in needed', line: 'Sign-in needed', notice: 'Sign-in needed' },
			{ dot: 'none', stateText: 'Answer needed', line: 'Answer needed', notice: 'Answer needed' },
			'Permission needed · Allow Bash?'
		]);
	});

	test('reliable work is green and idle has no dot; the second line never says Working, Idle or a title - before any message, how its run began - nor claims completion or input readiness (PANEL-1.4)', () => {
		const lines = [
			statusOf(run({ activity: 'working', title: 'Fix login' }), WORDS),
			statusOf(run({ activity: 'working' }), WORDS),
			statusOf(run({ activity: 'not_working', title: 'Fix login' }), WORDS),
			statusOf(run({ activity: 'not_working', resumed: true }), WORDS)
		];
		assert.deepStrictEqual(lines, [
			{ dot: 'working', stateText: 'Working', line: 'New conversation started', notice: 'New conversation started' },
			{ dot: 'working', stateText: 'Working', line: 'New conversation started', notice: 'New conversation started' },
			{ dot: 'none', stateText: 'Idle', line: 'New conversation started', notice: 'New conversation started' },
			{ dot: 'none', stateText: 'Idle', line: 'Conversation resumed', notice: 'Conversation resumed' }
		]);
		assert.ok(lines.every(each => !/done/i.test(JSON.stringify(each))));
		assert.deepStrictEqual([
			statusOf(run({ title: undefined, promptLine: 'Implement the parser' }), WORDS).line,
			statusOf(run({ activity: 'not_working', title: undefined, promptLine: 'Implement the parser' }), WORDS).line
		], ['📨 Implement the parser', '📨 Implement the parser'], 'the creation prompt is direct too, with no normal-state prefix');
	});

	test('U06: the details say its title, else none, and where it works - its kind with it; the label says name, short ID, state, location, CLI and second line', () => {
		const working = cardOf(run({ title: 'Fix the login flow' }), { place, selected: true, menu, words: WORDS });
		const blocked = cardOf(run({ activity: 'not_working', blocker: { kind: 'question' }, title: 'Fix the login flow' }), { place, selected: false, menu, words: WORDS });
		const unknown = cardOf(run({ activity: 'unknown', reporting: false }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([linesOf(working), working.label, working.selected, working.startedAt, placeOf(working), working.details.location.kind, working.menu], [
			['Agent: Ada · #a1', 'Title: Fix the login flow'],
			'Ada, #a1, Working, shop · main, Claude Code, New conversation started',
			true, 2000, 'Location: shop · main\nPath: /app', 'repo', menu
		]);
		// The second line saying no more than the state is not said twice
		assert.deepStrictEqual([linesOf(blocked), blocked.label], [['Agent: Ada · #a1', 'Title: Fix the login flow'], 'Ada, #a1, Answer needed, shop · main, Claude Code']);
		// With no title, the details have none
		assert.deepStrictEqual([linesOf(unknown), unknown.label, unknown.dot], [['Agent: Ada · #a1'], 'Ada, #a1, Status unavailable · check terminal, shop · main, Claude Code, New conversation started', 'none']);
		// An empty name is left out of both, never said as an empty part; the card carries its #aN for what the page says of it
		const unnamed = cardOf(run({ name: '' }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([linesOf(unnamed)[0], unnamed.label, unnamed.alias], ['Agent: #a1', '#a1, Working, shop · main, Claude Code, New conversation started', '#a1']);
		// The details' screen-reader words, in their order: what the label does not say - here its title, then its path; the page puts when
		// it started between them
		assert.deepStrictEqual([working.details.description, unknown.details.description], [{ title: 'Title: Fix the login flow', place: 'Path: /app' }, { title: 'Title: No title yet', place: 'Path: /app' }]);
		// Nothing the page never draws is sent
		assert.deepStrictEqual(Object.keys(working).filter(key => ['cliName', 'pinId'].includes(key)), []);
		// A launch that never started says when it was accepted
		assert.strictEqual(cardOf(run({ lifecycle: 'starting', phase: 'launching_cli', startedAt: undefined, pid: undefined }), { place, selected: false, menu, words: WORDS }).startedAt, 1000);
	});

	test('Facade\'s own exit words come from how the process ended, in the person\'s language; another error\'s reason as it was given (UX-2.4, RULES-3.3)', () => {
		const ended = (end: RunFacts['end'], reason: string, source = 'exit') => statusOf(run({ lifecycle: 'ended', end, error: { reason, source, at: 3 } }), WORDS).line;
		assert.deepStrictEqual([
			ended({ kind: 'abnormal', code: 137, at: 3 }, 'Exited with code 137'),
			ended({ kind: 'abnormal', signal: 'SIGKILL', at: 3 }, 'Ended by signal SIGKILL'),
			ended({ kind: 'abnormal', at: 3 }, 'Exited with code unknown'),
			ended({ kind: 'failed', at: 3 }, 'claude was not found', 'launch')
		], ['Beendet mit Code 137', 'Durch Signal SIGKILL beendet', 'Getrennt: Exit-Ursache unbekannt', 'Start failed · claude was not found']);
	});

	test('PANEL-1.4, 1.5: a red card\'s second line says why, unmarked, without `Error · `, which its red dot says; its state and its accessible label say `Error · {reason}`, once, the reason never twice', () => {
		const words: CardWords = { ...WORDS, exitedWithCode: code => `Process exited · code ${code}`, exitUnknown: 'Process lost · reason unknown' };
		const cases: [Partial<RunFacts>, string][] = [
			[{ lifecycle: 'ended', end: { kind: 'abnormal', code: 1, at: 3 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } }, 'Process exited · code 1'],
			[{ lifecycle: 'ended', end: { kind: 'abnormal', at: 3 }, error: { reason: 'Exited with code unknown', source: 'exit', at: 3 } }, 'Process lost · reason unknown'],
			// A failed start's reason after Start failed, its period gone
			[{ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason: 'claude was not found on PATH.', source: 'launch', at: 3 } }, 'Start failed · claude was not found on PATH'],
			// Over the last message sent to it, which a screen reader then does not hear either
			[{ said: 'fix the login bug', error: { reason: 'Rate limited', source: 'cli', at: 3 } }, 'Rate limited']
		];
		for (const [facts, reason] of cases) {
			const card = cardOf(run(facts), { place, selected: false, menu, words });
			const times = (text: string) => card.label.split(text).length - 1;
			assert.deepStrictEqual([card.dot, card.line, card.stateText, times('Error · '), times(reason), card.label],
				['error', reason, `Error · ${reason}`, 1, 1, `Ada, #a1, Error · ${reason}, shop · main, Claude Code`], JSON.stringify(facts));
		}
	});

	test('PANEL-1.5: the details always say where it works - its main checkout, worktree or folder, its kind with it, whatever it is called - and its path', () => {
		const at = (where: Pick<CardPlace, 'label' | 'qualified' | 'context' | 'path' | 'kind'>) => {
			const card = cardOf(run(), { place: where, selected: false, menu, words: WORDS });
			return [card.details.location.kind, placeOf(card)];
		};
		assert.deepStrictEqual([
			at({ label: 'main', qualified: 'main', context: 'main', path: '~/apps/shop', kind: 'repo' }),
			// A worktree named as its folder is still a worktree
			at({ label: 'rrr', qualified: 'rrr', context: 'rrr', path: '~/shop.worktrees/rrr', kind: 'worktree' }),
			// A plain folder too, named as the path's last folder
			at({ label: 'shop', qualified: 'shop', context: 'shop', path: '~/shop', kind: 'folder' })
		], [
			['repo', 'Location: main\nPath: ~/apps/shop'],
			['worktree', 'Location: rrr\nPath: ~/shop.worktrees/rrr'],
			['folder', 'Location: shop\nPath: ~/shop']
		]);
	});

	test('the details preserve multiline values, source context and creator without empty or duplicate fields, and never take the creation prompt for a title', () => {
		const title = 'Line one\nLine two';
		const facts = run({ name: '', title, promptLine: 'Initial task', origin: 'agent', creatorLabel: 'Maker #a7',
			activity: 'unknown', reporting: false, activityReason: title });
		const remote = { ...place, context: 'shop · main · SSH: remote', path: '/Case/one\nTwo' };
		const card = cardOf(facts, { place: remote, selected: false, menu, words: WORDS });
		// Its title; who started it
		assert.deepStrictEqual(linesOf(card), ['Agent: #a1', `Title: ${title}`, 'Started by: Maker #a7']);
		assert.strictEqual(placeOf(card), 'Location: shop · main · SSH: remote\nPath: /Case/one\nTwo');
		// The screen reader hears the title, then the environment the label does not name, and the path
		assert.deepStrictEqual(card.details.description, { title: `Title: ${title}`, place: 'Location: shop · main · SSH: remote, Path: /Case/one\nTwo' });
		// No title: none, its creation prompt the second line's alone
		const prompt = cardOf({ ...facts, title: undefined, activityReason: 'No status' }, { place: remote, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([linesOf(prompt), prompt.line, prompt.details.description.title], [['Agent: #a1', 'Started by: Maker #a7'], '📨 Initial task', 'Title: No title yet']);
	});

	test('avatars: each built-in\'s maker avatar and each robot, files of media/agents; a name with no icon known shows a program\'s (PANEL-1.3, CONFIGURATION-2.4)', () => {
		const builtIns = ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'];
		assert.deepStrictEqual(builtIns.map(icon => avatarOf(icon)), [
			{ file: 'avatar-claude.png' }, { file: 'avatar-codex.png' }, { file: 'avatar-antigravity.png' }, { file: 'avatar-muse.png' }, { file: 'avatar-opencode.png' }, { file: 'avatar-pi.png' }
		]);
		assert.deepStrictEqual(BUILT_IN_ADAPTERS.map(adapter => adapter.id), builtIns);
		// A robot: its face, and its eyes over it, which look toward the pointer
		assert.deepStrictEqual(ROBOT_ICONS.map(icon => avatarOf(icon)), ROBOTS.map(robot => ({ file: `robot-${robot}-face.svg`, eyes: 'robot-eyes.svg' })));
		const media = path.join(__dirname, '..', '..', '..', 'media');
		assert.deepStrictEqual([...builtIns, ...ROBOT_ICONS].flatMap(icon => { const { file, eyes } = avatarOf(icon); return [file, ...eyes ? [eyes] : []]; })
			.filter(file => !fs.existsSync(path.join(media, 'agents', file))), []);
		// A name where no icon is known: a built-in's own, else a program's, the whitest robot
		assert.deepStrictEqual([avatarOf('codex'), avatarOf('my-cli')], [{ file: 'avatar-codex.png' }, { file: 'robot-pearl-face.svg', eyes: 'robot-eyes.svg' }]);
		// Pickers: the same images, a built-in's in each theme's variant
		const vscode = {
			ThemeIcon: class { constructor(readonly id: string) { } },
			ThemeColor: class { constructor(readonly id: string) { } },
			Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
			env: { language: 'en' }
		};
		const { cliIcon, cliTerminalIcon } = withModules({ vscode })<typeof PresentationModule>(require.resolve('../ui/presentation'));
		type Images = { readonly light: { readonly fsPath: string }; readonly dark: { readonly fsPath: string } };
		const images = [...builtIns, ...ROBOT_ICONS].map(icon => cliIcon({ fsPath: media } as never, icon) as unknown as Images);
		assert.deepStrictEqual(images.flatMap(image => [image.light?.fsPath, image.dark?.fsPath]).filter(file => !file || !fs.existsSync(file)), []);
		assert.deepStrictEqual((cliIcon({ fsPath: media } as never, 'facade-sky') as unknown as Images).dark.fsPath, path.join(media, 'agents', 'robot-sky.svg'));
		assert.deepStrictEqual(cliIcon({ fsPath: media } as never, 'qwen codex'), cliIcon({ fsPath: media } as never, 'facade-pearl'));
		// Tabs: a registered glyph for each - a built-in's logo, or a robot at its code point in Facade's robot font, which
		// scripts/robot-icons.py draws in ROBOTS' order - and no letter font left
		const manifest = JSON.parse(fs.readFileSync(path.join(media, '..', 'package.json'), 'utf8'));
		for (const cli of builtIns) {
			const icon = cliTerminalIcon(cli);
			assert.strictEqual(icon.id, `facade-cli-${cli}`);
			assert.ok(manifest.contributes.icons[icon.id], `${cli}'s terminal icon is registered`);
		}
		const robots = ROBOTS.map((robot, index) => [`facade-robot-${robot}`,
			{ description: '%icon.robot%', default: { fontPath: './media/robots.woff', fontCharacter: `\\${(0xE200 + index).toString(16).toUpperCase()}` } }]);
		assert.deepStrictEqual(Object.entries(manifest.contributes.icons).filter(([id]) => id.startsWith('facade-robot-')), robots);
		assert.deepStrictEqual(Object.keys(manifest.contributes.icons).filter(id => id.startsWith('facade-letter-')), []);
		assert.deepStrictEqual(ROBOT_ICONS.map(icon => cliTerminalIcon(icon).id), ROBOTS.map(robot => `facade-robot-${robot}`));
		assert.strictEqual(cliTerminalIcon('qwen codex').id, 'facade-robot-pearl');
		const script = fs.readFileSync(path.join(media, '..', 'scripts', 'robot-icons.py'), 'utf8');
		assert.deepStrictEqual([...script.matchAll(/\("(\w+)", "#[0-9A-F]{6}", "#[0-9A-F]{6}"\)/g)].map(match => match[1]), ROBOTS);
		assert.ok(fs.statSync(path.join(media, 'robots.woff')).isFile());
		// A card: its entry's icon where the panel is told it, else its name's default
		const cardFor = (more: Partial<RunFacts>, icon?: string) => cardOf(run(more), { place, selected: false, menu, words: WORDS, ...icon ? { icon } : {} });
		assert.deepStrictEqual([cardFor({}).avatar, cardFor({ cli: 'my-cli', displayName: 'my-cli' }).avatar, cardFor({ cli: 'my-cli', displayName: 'my-cli' }, 'facade-pearl').avatar, cardFor({}, 'facade-red').avatar],
			[{ file: 'avatar-claude.png' }, ...['pearl', 'pearl', 'red'].map(robot => ({ file: `robot-${robot}-face.svg`, eyes: 'robot-eyes.svg' }))]);
	});
});
