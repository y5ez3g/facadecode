/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { RunFacts, WorktreeCreationEffects } from '../core/ports';
import { avatarOf, cardOf, CardWords, statusOf } from '../ui/cardView';

const WORDS: CardWords = {
	starting: 'Starting',
	startingCli: cli => `Starting ${cli}...`,
	creatingWorktree: 'Creating worktree...',
	working: 'Working',
	notWorking: 'Idle',
	error: reason => `Error: ${reason}`,
	worktreeFailure: reason => reason,
	activityUnavailable: 'Activity unavailable',
	readyForInput: 'Ready for input',
	needsPermission: 'Needs permission',
	needsSignIn: 'Sign-in required',
	hasQuestion: 'Waiting for an answer',
	exitedWithCode: code => `Beendet mit Code ${code}`,
	endedBySignal: signal => `Durch Signal ${signal} beendet`,
	window: label => `Window: ${label}`,
	toolsUnavailable: problem => `Can't work with other agents: ${problem}`,
	startedBy: creator => `Started by ${creator}`
};

function run(more: Partial<RunFacts> = {}): RunFacts {
	return {
		id: 'run-00000000000000000000000000000001', alias: '#a1', name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude',
		location: 'loc-1', cwd: '/app', environment: 'local', yolo: true, createdAt: 1000,
		lifecycle: 'running', phase: 'running', pid: 42, startedAt: 2000, activity: 'working', reporting: true,
		root: 'run-00000000000000000000000000000001', origin: 'human', tools: 'not_injected', ...more
	};
}

const place = { label: 'main', qualified: 'shop · main', folderPrefix: 'shop', full: 'shop · main · /app' };
const menu = { moveUp: false, moveDown: true };

suite('Cards: dot, second line, hover and label (RULES-3.2, PANEL-1.3-1.5)', () => {

	test('a retained worktree failure renders its stored effects in the current language', () => {
		const effects = { branch: 'fix', folder: '/app.worktrees/fix' };
		const facts = run({ lifecycle: 'ended', error: { reason: 'spawn refused', source: 'launch', at: 3, worktree: effects } });
		const received: unknown[] = [];
		const words = { ...WORDS, worktreeFailure: (reason: string, actual: WorktreeCreationEffects) => {
			received.push([reason, actual]); return 'Lokalisierter Fehler mit erhaltenem Worktree';
		} };
		const shown = statusOf(facts, words);
		assert.strictEqual(shown.line, 'Lokalisierter Fehler mit erhaltenem Worktree');
		assert.deepStrictEqual(received, [['spawn refused', effects]]);
	});

	test('J05: an unresolved error is red with its reason first, whatever else is known; unknown activity is red too, its reason on the second line', () => {
		const cases: [Partial<RunFacts>, string, string, string][] = [
			[{ lifecycle: 'ended', end: { kind: 'failed', at: 3 }, error: { reason: 'claude was not found', source: 'launch', at: 3 }, title: 'T', blocker: { kind: 'question' } }, 'error', 'Error: claude was not found', 'claude was not found'],
			[{ lifecycle: 'ended', end: { kind: 'abnormal', code: 2, at: 3 }, error: { reason: 'Exited with code 2', source: 'exit', at: 3 } }, 'error', 'Error: Beendet mit Code 2', 'Beendet mit Code 2'],
			[{ activity: 'working', error: { reason: 'Rate limited', source: 'cli', at: 3 }, title: 'Fix login' }, 'error', 'Error: Rate limited', 'Rate limited'],
			[{ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, error: { reason: 'Spawn failed', source: 'launch', at: 3 } }, 'error', 'Error: Spawn failed', 'Spawn failed'],
			[{ activity: 'unknown', reporting: false }, 'error', 'Activity unavailable', 'Activity unavailable'],
			[{ activity: 'unknown', reporting: false, activityReason: 'This CLI reports no activity', title: 'Fix login' }, 'error', 'Activity unavailable', 'This CLI reports no activity'],
			[{ activity: 'working', reporting: false, title: 'Fix login' }, 'error', 'Activity unavailable', 'Activity unavailable']
		];
		for (const [facts, dot, stateText, line] of cases) {
			assert.deepStrictEqual(statusOf(run(facts), WORDS), { dot, stateText, line, ...(line !== stateText && dot === 'error' && stateText === 'Activity unavailable' ? { reason: line } : {}) }, JSON.stringify(facts));
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
			{ dot: 'idle', stateText: 'Idle', line: 'Allow Bash(npm test)?', reason: 'Allow Bash(npm test)?' },
			'Needs permission',
			'Sign-in required',
			'Waiting for an answer',
			{ dot: 'working', stateText: 'Starting', line: 'Starting Claude Code...' },
			'Creating worktree...'
		]);
	});

	test('a known native blocker leads the second line over unavailable activity, which keeps the dot red and its explanation (PANEL-1.4, RULES-3.2)', () => {
		assert.deepStrictEqual([
			statusOf(run({ activity: 'unknown', reporting: false, blocker: { kind: 'auth' } }), WORDS),
			statusOf(run({ activity: 'unknown', reporting: false, activityReason: 'No activity report since 10:02', blocker: { kind: 'permission', text: 'Allow Bash?' } }), WORDS).line
		], [
			{ dot: 'error', stateText: 'Activity unavailable', line: 'Sign-in required · Activity unavailable', reason: 'Sign-in required' },
			'Allow Bash? · No activity report since 10:02'
		]);
	});

	test('reliable activity is green or yellow over the CLI title, else Working or Ready for input - never a completion claim (PANEL-1.4)', () => {
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
			{ dot: 'idle', stateText: 'Idle', line: 'Ready for input' }
		]);
		assert.ok(lines.every(each => !/done/i.test(JSON.stringify(each))));
	});

	test('U06: the hover names the agent with its short run ID and CLI, then the full title, the state and an unsaid reason; the label says name, short ID, state, location, CLI and second line', () => {
		const working = cardOf(run({ title: 'Fix the login flow' }), { place, selected: true, menu, words: WORDS });
		const blocked = cardOf(run({ activity: 'not_working', blocker: { kind: 'question' }, title: 'Fix the login flow' }), { place, selected: false, menu, words: WORDS });
		const unknown = cardOf(run({ activity: 'unknown', reporting: false }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([working.tooltip, working.label, working.selected, working.startedAt, working.location, working.menu], [
			['Ada · #a1 · Claude Code', 'Fix the login flow', 'Working'],
			'Ada, #a1, Working, shop · main, Claude Code, Fix the login flow',
			true, 2000, { label: 'main', folderPrefix: 'shop', full: 'shop · main · /app' }, menu
		]);
		assert.deepStrictEqual([blocked.tooltip, blocked.label], [['Ada · #a1 · Claude Code', 'Fix the login flow', 'Idle', 'Waiting for an answer'], 'Ada, #a1, Idle, shop · main, Claude Code, Waiting for an answer']);
		// The second line saying no more than the state is not said twice
		assert.deepStrictEqual([unknown.tooltip, unknown.label, unknown.dot], [['Ada · #a1 · Claude Code', 'Activity unavailable'], 'Ada, #a1, Activity unavailable, shop · main, Claude Code', 'error']);
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
		], ['Beendet mit Code 137', 'Durch Signal SIGKILL beendet', 'Exited with code unknown', 'claude was not found']);
	});

	test('PANEL-1.5: the hover names the window with the agent\'s qualified location, where the window has a name', () => {
		const card = cardOf(run({ title: 'Fix login' }), { place, selected: false, menu, words: WORDS, window: 'shop' });
		assert.deepStrictEqual([card.tooltip, card.location.full], [['Ada · #a1 · Claude Code', 'Fix login', 'Working'], 'shop · main · /app · Window: shop']);
		const own = cardOf(run({ title: 'Fix login' }), { place, selected: false, menu, words: WORDS });
		assert.deepStrictEqual([own.tooltip, own.location.full], [['Ada · #a1 · Claude Code', 'Fix login', 'Working'], 'shop · main · /app']);
	});

	test('avatars: Claude Code\'s maker avatar; none for a CLI this build has no avatar of, which the card then leaves out (PANEL-1.3, UX-2.1)', () => {
		assert.deepStrictEqual([avatarOf('claude'), avatarOf('other')], [{ file: 'avatar-claude.png' }, undefined]);
		assert.deepStrictEqual([cardOf(run(), { place, selected: false, menu, words: WORDS }).avatar, 'avatar' in cardOf(run({ cli: 'other' }), { place, selected: false, menu, words: WORDS })], [{ file: 'avatar-claude.png' }, false]);
	});
});
