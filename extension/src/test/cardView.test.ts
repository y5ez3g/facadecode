/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BUILT_IN_ADAPTERS } from '../clis/catalog';
import { activityOf, cliTitle } from '../clis/activity';
import { parseStatus } from '../ptyd/status';
import type { RunFacts, WorktreeCreationEffects } from '../core/ports';
import { avatarOf, cardOf, CardWords, statusOf } from '../ui/cardView';
import type * as PresentationModule from '../ui/presentation';
import { withModules } from './withModules';

const WORDS: CardWords = {
	agent: value => `Agent: ${value}`,
	title: value => `Title: ${value}`,
	prompt: value => `Prompt: ${value}`,
	status: value => `Status: ${value}`,
	reason: value => `Reason: ${value}`,
	tools: value => `Tools: ${value}`,
	location: value => `Location: ${value}`,
	path: value => `Path: ${value}`,

	starting: 'Starting',
	startingCli: cli => `Starting ${cli}...`,
	creatingWorktree: 'Creating worktree...',
	working: 'Working',
	notWorking: 'Idle',
	error: reason => `Error: ${reason}`,
	worktreeFailure: reason => reason,
	activityUnavailable: 'Activity unavailable',
	needsAttention: 'Needs attention', toolsConnecting: 'Not connected to other agents yet',
	needsPermission: 'Needs permission',
	needsSignIn: 'Sign-in required',
	hasQuestion: 'Waiting for an answer',
	exitedWithCode: code => `Beendet mit Code ${code}`,
	endedBySignal: signal => `Durch Signal ${signal} beendet`,
	window: label => `Window: ${label}`,
	toolsUnavailable: problem => `Can't work with other agents: ${problem}`,
	startedBy: creator => `Started by: ${creator}`,
	exitUnknown: 'Getrennt; Exit-Ursache unbekannt',
	locale: 'en'
};

function run(more: Partial<RunFacts> = {}): RunFacts {
	return {
		id: 'run-00000000000000000000000000000001', alias: '#a1', name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude',
		location: 'loc-1', cwd: '/app', environment: 'local', yolo: true, createdAt: 1000,
		lifecycle: 'running', phase: 'running', pid: 42, startedAt: 2000, activity: 'working', reporting: true,
		root: 'run-00000000000000000000000000000001', origin: 'human', tools: 'not_injected', ...more
	};
}

const place = { label: 'main', qualified: 'shop · main', folderPrefix: 'shop', context: 'shop · main', path: '/app' };
const menu = { moveUp: false, moveDown: true, filterLocation: false, filterFolder: false, clearFilter: false };

suite('Cards: dot, second line, hover and label (RULES-3.2, PANEL-1.3-1.5)', () => {

	test('all CLIs retain a blocker without a recognized kind, including its full reason in the hover', () => {
		const message = `Please review ${'a long explanation '.repeat(30)}👨‍👩‍👧‍👦`;
		for (const cli of [...BUILT_IN_ADAPTERS.map(adapter => adapter.id), 'custom']) {
			for (const kind of ['', ':kind=future']) {
				const report = parseStatus(`state=blocked${kind}:msg=${Buffer.from(message).toString('base64')}`);
				assert.ok(report && report !== 'query' && report.state === 'blocked');
				const { activity, reporting, blocker } = activityOf({ ...report, state: 'blocked' });
				const facts = run({ cli, activity, reporting, blocker });
				const card = cardOf(facts, { place, selected: false, menu, words: WORDS });
				assert.deepStrictEqual([card.dot, card.stateText, card.line], ['blocked', 'Needs attention', `Needs attention · ${message}`], cli);
				assert.ok(card.tooltip.includes(WORDS.reason(message)), cli);
			}
		}
	});

	test('connecting tools are visible without implying a failure or changing the activity dot, and actual connection removes the notice', () => {
		for (const activity of ['working', 'not_working'] as const) {
			const facts = run({ activity, title: '✳ Checking tests', tools: 'connecting' });
			const card = cardOf(facts, { place, selected: false, menu, words: WORDS });
			assert.strictEqual(card.dot, activity === 'working' ? 'working' : 'idle');
			assert.strictEqual(card.line, WORDS.toolsConnecting);
			assert.ok(card.tooltip.includes(WORDS.tools(WORDS.toolsConnecting)));
			assert.ok(card.tooltip.includes(WORDS.title(facts.title!)));
			assert.strictEqual(statusOf({ ...facts, tools: 'available' }, WORDS).line, facts.title);
			assert.strictEqual(statusOf({ ...facts, blocker: { kind: 'unknown' } }, WORDS).line, WORDS.needsAttention);
			assert.strictEqual(statusOf({ ...facts, error: { source: 'cli', reason: 'Failed', at: 1 } }, WORDS).line, 'Error: Failed');
			const ended = cardOf({ ...facts, lifecycle: 'ended', end: { kind: 'abnormal', at: 3, code: 1 } }, { place, selected: false, menu, words: WORDS });
			assert.ok(!ended.tooltip.includes(WORDS.tools(WORDS.toolsConnecting)));
		}
		const starting = cardOf(run({ lifecycle: 'starting', phase: 'launching_cli', tools: 'connecting' }), { place, selected: false, menu, words: WORDS });
		assert.strictEqual(starting.line, 'Starting Claude Code...');
		assert.ok(starting.tooltip.includes(WORDS.tools(WORDS.toolsConnecting)));
	});

	test('the second line and hover retain the complete bounded CLI title, including decorations and multi-code-point emoji', () => {
		const title = `✳ ${'a'.repeat(298)}👨‍👩‍👧‍👦 | workspace`;
		const card = cardOf(run({ title: cliTitle({ terminal: title }) }), { place, selected: false, menu, words: WORDS });
		assert.strictEqual(card.line, title);
		assert.ok(card.tooltip.includes(WORDS.title(title)));
	});

	test('a working card carries when its CLI reported that work, for its hover to say how long ago; any other card does not (RULES-3.2)', () => {
		const working = cardOf(run({ activity: 'working', reporting: true, activitySince: 1_234 }), { place, selected: false, menu, words: WORDS });
		const idle = cardOf(run({ activity: 'not_working', reporting: true, activitySince: 1_234 }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([working.workingSince, idle.workingSince], [1_234, undefined]);
	});

	test('tools that went as the process ended are no problem of the ended card; tools a live run lost, or an ended one never had, are said', () => {
		const lost = { tools: 'unavailable', toolsProblem: 'disconnected' } as const;
		const ended = cardOf(run({ ...lost, lifecycle: 'ended', end: { kind: 'abnormal', at: 3, code: 1 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } }), { place, selected: false, menu, words: WORDS });
		const live = cardOf(run({ ...lost, activity: 'not_working', reporting: true }), { place, selected: false, menu, words: WORDS });
		const never = cardOf(run({ tools: 'unavailable', toolsProblem: 'conflict', lifecycle: 'ended', end: { kind: 'abnormal', at: 3, code: 1 }, error: { reason: 'Exited with code 1', source: 'exit', at: 3 } }), { place, selected: false, menu, words: WORDS });
		const said = (card: { readonly tooltip: readonly string[] }) => card.tooltip.some(line => line.startsWith('Tools: Can\'t work with other agents'));
		assert.deepStrictEqual([said(ended), said(live), said(never)], [false, true, true]);
	});

	test('a retained worktree failure renders its stored effects in the current language', () => {
		const effects = { branch: 'fix', folder: '/app.worktrees/fix' };
		const facts = run({ lifecycle: 'ended', error: { reason: 'spawn refused', source: 'launch', at: 3, worktree: effects } });
		const received: unknown[] = [];
		const words = { ...WORDS, worktreeFailure: (reason: string, actual: WorktreeCreationEffects) => {
			received.push([reason, actual]); return 'Lokalisierter Fehler mit erhaltenem Worktree';
		} };
		const shown = statusOf(facts, words);
		assert.strictEqual(shown.line, 'Error: Lokalisierter Fehler mit erhaltenem Worktree');
		assert.deepStrictEqual(received, [['spawn refused', effects]]);
	});

	test('J05: an unresolved error is red with its reason first, whatever else is known; unknown activity is red too, its reason on the second line', () => {
		const cases: [Partial<RunFacts>, string, string, string][] = [
			[{ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason: 'claude was not found', source: 'launch', at: 3 }, title: 'T', blocker: { kind: 'question' } }, 'error', 'Error: claude was not found', 'Error: claude was not found'],
			[{ lifecycle: 'ended', end: { kind: 'abnormal', code: 2, at: 3 }, error: { reason: 'Exited with code 2', source: 'exit', at: 3 } }, 'error', 'Error: Beendet mit Code 2', 'Error: Beendet mit Code 2'],
			[{ activity: 'working', error: { reason: 'Rate limited', source: 'cli', at: 3 }, title: 'Fix login' }, 'error', 'Error: Rate limited', 'Error: Rate limited'],
			[{ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, error: { reason: 'Spawn failed', source: 'launch', at: 3 } }, 'error', 'Error: Spawn failed', 'Error: Spawn failed'],
			[{ activity: 'unknown', reporting: false }, 'error', 'Activity unavailable', 'Activity unavailable'],
			[{ activity: 'unknown', reporting: false, activityReason: 'This CLI reports no activity', title: 'Fix login' }, 'error', 'Activity unavailable', 'Activity unavailable · This CLI reports no activity'],
			[{ activity: 'working', reporting: false, title: 'Fix login' }, 'error', 'Activity unavailable', 'Activity unavailable']
		];
		for (const [facts, dot, stateText, line] of cases) {
			assert.deepStrictEqual(statusOf(run(facts), WORDS), { dot, stateText, line, ...(line !== stateText && dot === 'error' && stateText === 'Activity unavailable' ? { reason: facts.activityReason } : {}) }, JSON.stringify(facts));
		}
	});

	test('a native blocker is yellow in the CLI\'s own words, else Needs permission, Sign-in required or Waiting for an answer; startup is green with its stage', () => {
		assert.deepStrictEqual([
			statusOf(run({ activity: 'not_working', blocker: { kind: 'permission', text: 'Allow Bash(npm test)?' } }), WORDS),
			statusOf(run({ activity: 'not_working', blocker: { kind: 'permission' } }), WORDS).line,
			statusOf(run({ activity: 'not_working', blocker: { kind: 'auth' } }), WORDS).line,
			statusOf(run({ activity: 'not_working', blocker: { kind: 'question', text: '  ' } }), WORDS).line,
			statusOf(run({ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, title: 'T' }), WORDS),
			statusOf(run({ lifecycle: 'starting', phase: 'creating_worktree', activity: 'unknown', reporting: false }), WORDS).line
		], [
			{ dot: 'blocked', stateText: 'Needs permission', line: 'Needs permission · Allow Bash(npm test)?', reason: 'Allow Bash(npm test)?' },
			'Needs permission',
			'Sign-in required',
			'Waiting for an answer',
			{ dot: 'working', stateText: 'Starting', line: 'Starting Claude Code...' },
			'Creating worktree...'
		]);
	});

	test('a run whose CLI has shown no activity yet is still starting, green with its stage, over its title; an error still comes first (CLIS-2.3, D81)', () => {
		const connection = { reason: "Connection to agent process lost; reconnecting", source: 'connection', at: 3 };
		assert.deepStrictEqual([
			statusOf(run({ activity: 'unknown', reporting: false, awaitingActivity: true, title: 'Fix login' }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: true, awaitingActivity: true }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: false, awaitingActivity: true, error: connection }), WORDS).dot,
			statusOf(run({ activity: 'unknown', reporting: false, activityReason: "CLI has not reported activity" }), WORDS).dot
		], [
			{ dot: 'working', stateText: 'Starting', line: 'Starting Claude Code...' },
			{ dot: 'working', stateText: 'Starting', line: 'Starting Claude Code...' },
			'error',
			'error'
		]);
	});

	test('a known native blocker leads the second line over unavailable activity, which keeps the dot red and its explanation (PANEL-1.4, RULES-3.2)', () => {
		assert.deepStrictEqual([
			statusOf(run({ activity: 'unknown', reporting: false, blocker: { kind: 'auth' } }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: true, blocker: { kind: 'question' } }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: false, activityReason: 'No activity report since 10:02', blocker: { kind: 'permission', text: 'Allow Bash?' } }), WORDS).line
		], [
			{ dot: 'error', stateText: 'Activity unavailable', line: 'Sign-in required · Activity unavailable', reason: 'Sign-in required' },
			{ dot: 'error', stateText: 'Activity unavailable', line: 'Waiting for an answer · Activity unavailable', reason: 'Waiting for an answer' },
			'Needs permission · Allow Bash? · No activity report since 10:02'
		]);
	});

	test('reliable activity is green or grey over the CLI title, else Working or Idle - never a completion or input-readiness claim (PANEL-1.4)', () => {
		const lines = [
			statusOf(run({ activity: 'working', title: 'Fix login' }), WORDS),
			statusOf(run({ activity: 'working' }), WORDS),
			statusOf(run({ activity: 'not_working', title: 'Fix login' }), WORDS),
			statusOf(run({ activity: 'not_working' }), WORDS)
		];
		assert.deepStrictEqual(lines, [
			{ dot: 'working', stateText: 'Working', line: 'Fix login' },
			{ dot: 'working', stateText: 'Working', line: 'Working' },
			{ dot: 'idle', stateText: 'Idle', line: 'Fix login' },
			{ dot: 'idle', stateText: 'Idle', line: 'Idle' }
		]);
		assert.ok(lines.every(each => !/done/i.test(JSON.stringify(each))));
		assert.deepStrictEqual([
			statusOf(run({ title: undefined, promptLine: 'Implement the parser' }), WORDS).line,
			statusOf(run({ activity: 'not_working', title: undefined, promptLine: 'Implement the parser' }), WORDS).line
		], ['Implement the parser', 'Implement the parser'], 'the creation prompt is direct too, with no normal-state prefix');
	});

	test('U06: the hover names the agent with its short run ID and CLI, then the full title, the state and an unsaid reason; the label says name, short ID, state, location, CLI and second line', () => {
		const working = cardOf(run({ title: 'Fix the login flow' }), { place, selected: true, menu, words: WORDS });
		const blocked = cardOf(run({ activity: 'not_working', blocker: { kind: 'question' }, title: 'Fix the login flow' }), { place, selected: false, menu, words: WORDS });
		const unknown = cardOf(run({ activity: 'unknown', reporting: false }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([working.tooltip, working.label, working.selected, working.startedAt, working.location, working.menu], [
			['Agent: Ada · #a1 · Claude Code', 'Title: Fix the login flow', 'Status: Working'],
			'Ada, #a1, Working, shop · main, Claude Code, Fix the login flow',
			true, 2000, { label: 'main', folderPrefix: 'shop', full: 'Location: shop · main\nPath: /app' }, menu
		]);
		assert.deepStrictEqual([blocked.tooltip, blocked.label], [['Agent: Ada · #a1 · Claude Code', 'Title: Fix the login flow', 'Status: Waiting for an answer'], 'Ada, #a1, Waiting for an answer, shop · main, Claude Code']);
		// The second line saying no more than the state is not said twice
		assert.deepStrictEqual([unknown.tooltip, unknown.label, unknown.dot], [['Agent: Ada · #a1 · Claude Code', 'Status: Activity unavailable'], 'Ada, #a1, Activity unavailable, shop · main, Claude Code', 'error']);
		// An empty name is left out of both, never said as an empty part; the card carries its #aN for what the page says of it
		const unnamed = cardOf(run({ name: '' }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([unnamed.tooltip[0], unnamed.label, unnamed.alias], ['Agent: #a1 · Claude Code', '#a1, Working, shop · main, Claude Code', '#a1']);
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
		], ['Error: Beendet mit Code 137', 'Error: Durch Signal SIGKILL beendet', 'Error: Getrennt; Exit-Ursache unbekannt', 'Error: claude was not found']);
	});

	test('PANEL-1.5: the hover names the window with the agent\'s qualified location, where the window has a name', () => {
		const card = cardOf(run({ title: 'Fix login' }), { place, selected: false, menu, words: WORDS, window: 'shop' });
		assert.deepStrictEqual([card.tooltip, card.location.full], [['Agent: Ada · #a1 · Claude Code', 'Title: Fix login', 'Status: Working'], 'Location: shop · main\nPath: /app\nWindow: shop']);
		const own = cardOf(run({ title: 'Fix login' }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([own.tooltip, own.location.full], [['Agent: Ada · #a1 · Claude Code', 'Title: Fix login', 'Status: Working'], 'Location: shop · main\nPath: /app']);
	});

	test('hover labels preserve multiline values, source context, creator and title priority without empty or duplicate fields', () => {
		const title = 'Line one\nLine two';
		const facts = run({ name: '', title, promptLine: 'Initial task', origin: 'agent', creatorLabel: 'Maker #a7',
			activity: 'unknown', reporting: false, activityReason: title });
		const remote = { ...place, context: 'shop · main · SSH: remote', path: '/Case/one\nTwo' };
		const card = cardOf(facts, { place: remote, selected: false, menu, words: WORDS, window: 'Remote' });
		assert.deepStrictEqual(card.tooltip, ['Agent: #a1 · Claude Code', `Title: ${title}`, 'Status: Activity unavailable', 'Started by: Maker #a7']);
		assert.strictEqual(card.location.full, 'Location: shop · main · SSH: remote\nPath: /Case/one\nTwo\nWindow: Remote');
		const prompt = cardOf({ ...facts, title: undefined, activityReason: 'No status' }, { place: remote, selected: false, menu, words: WORDS });
		assert.deepStrictEqual(prompt.tooltip, ['Agent: #a1 · Claude Code', 'Prompt: Initial task', 'Status: Activity unavailable', 'Reason: No status', 'Started by: Maker #a7']);
	});

	test('avatars: each built-in\'s maker avatar, a file of media/agents; a custom CLI\'s initial on the colour its name picks (PANEL-1.3, UX-2.1)', () => {
		const builtIns = ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'];
		assert.deepStrictEqual(builtIns.map(cli => avatarOf(cli, 'Any', 'en')), [
			{ file: 'avatar-claude.png' }, { file: 'avatar-codex.png' }, { file: 'avatar-antigravity.png' }, { file: 'avatar-muse.png' }, { file: 'avatar-opencode.png' }, { file: 'avatar-pi.png' }
		]);
		assert.deepStrictEqual(BUILT_IN_ADAPTERS.map(adapter => adapter.id), builtIns);
		const media = path.join(__dirname, '..', '..', '..', 'media');
		assert.deepStrictEqual(builtIns.filter(cli => !fs.existsSync(path.join(media, 'agents', (avatarOf(cli, cli, 'en') as { file: string }).file))), []);
		// The first grapheme - a whole emoji or accented letter - uppercased in the person's language; the colour the same for the same
		// name however it is cased or spaced, and one of the three
		const custom = (name: string, locale = 'en') => avatarOf(name, name, locale) as { initial: string; color: string };
		assert.deepStrictEqual([custom('my-cli').initial, custom('île').initial, custom('👩‍💻 bot').initial, custom('istanbul', 'tr').initial, custom('istanbul').initial], ['M', 'Î', '👩‍💻', 'İ', 'I']);
		assert.deepStrictEqual([custom(' My-CLI ').color === custom('my-cli').color, ['blue', 'orange', 'purple'].includes(custom('my-cli').color)], [true, true]);
		assert.deepStrictEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(name => custom(name).color)).size, 3);
		// A name with nothing to show has no avatar: the card leaves it out
		assert.deepStrictEqual([avatarOf('', '', 'en'), avatarOf(' ', ' ', 'en')], [undefined, undefined]);
		// Image logos for pickers, and registered native glyphs for terminal tabs in every theme
		const vscode = {
			ThemeIcon: class { constructor(readonly id: string) { } },
			ThemeColor: class { constructor(readonly id: string) { } },
			Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
		};
		const { cliIcon, cliTerminalIcon } = withModules({ vscode })<typeof PresentationModule>(require.resolve('../ui/presentation'));
		const logos = builtIns.map(cli => cliIcon({ fsPath: media } as never, cli) as unknown as { readonly light: { readonly fsPath: string }; readonly dark: { readonly fsPath: string } });
		assert.deepStrictEqual(logos.flatMap(logo => [logo.light?.fsPath, logo.dark?.fsPath]).filter(file => !file || !fs.existsSync(file)), []);
		assert.deepStrictEqual((cliIcon({ fsPath: media } as never, 'other') as unknown as { readonly id: string }).id, 'terminal');
		const manifest = JSON.parse(fs.readFileSync(path.join(media, '..', 'package.json'), 'utf8'));
		for (const cli of builtIns) {
			const icon = cliTerminalIcon(cli);
			assert.strictEqual(icon.id, `facade-cli-${cli}`);
			assert.ok(manifest.contributes.icons[icon.id], `${cli}'s terminal icon is registered`);
		}
		assert.strictEqual(cliTerminalIcon('other').id, 'terminal');
		const cardFor = (more: Partial<RunFacts>) => cardOf(run(more), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([cardFor({}).avatar, cardFor({ cli: 'my-cli', displayName: 'my-cli' }).avatar, 'avatar' in cardFor({ cli: 'my-cli', displayName: ' ' })],
			[{ file: 'avatar-claude.png' }, avatarOf('my-cli', 'my-cli', 'en'), false]);
	});
});
