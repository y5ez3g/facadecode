/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { claudeAdapter, codexAdapter } from '../common/agents';
import { keysToAnswer } from '../common/kernel/firstRun';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';

/** What Claude Code 2.x shows in a folder it was never started in, as its terminal read. */
const CLAUDE_TRUST = [
	'────────────────────────────────────────────────────────────────────────────────',
	' Accessing workspace:',
	' C:\\Users\\me\\.facade\\worktrees\\helpers\\p1-clamp',
	' Quick safety check: Is this a project you created or one you trust? (Like your',
	' own code, a well-known open source project, or work from your team). If not,',
	' take a moment to review what\'s in this folder first.',
	' Claude Code\'ll be able to read, edit, and execute files here.',
	' Security guide',
	' ❯ No, exit',
	'   Yes, I trust this folder',
	' Enter to confirm · Esc to cancel'
].join('\n');

/** What Codex shows the first time it is given Facade's three hooks. */
const codexHooks = (count: number) => [
	'  Hooks need review',
	`  ${count} hooks are new or changed.`,
	'  Hooks can run outside the sandbox after you trust them.',
	'› 1. Review hooks',
	'  2. Trust all and continue',
	'  3. Continue without trusting (hooks won\'t run)',
	'  enter confirm · esc skip'
].join('\n');

suite('First-run questions', () => {

	test('Claude Code\'s question about its folder and Codex\'s about Facade\'s hooks are answered with the keys a person would press', () => {
		assert.deepStrictEqual({
			claude: keysToAnswer(CLAUDE_TRUST, claudeAdapter.firstRun!.answers[0]),
			codex: keysToAnswer(codexHooks(3), codexAdapter.firstRun!.answers[0])
		}, {
			claude: [DOWN, ENTER],
			codex: [DOWN, ENTER]
		});
	});

	test('hooks of the person\'s own among those Codex asks about are theirs to trust, and a screen that does not ask is left alone', () => {
		assert.deepStrictEqual({
			ownHooks: keysToAnswer(codexHooks(5), codexAdapter.firstRun!.answers[0]),
			working: keysToAnswer('> Use the work skill.\n  Reading p1/tasks/f2 ...', claudeAdapter.firstRun!.answers[0]),
			noMenu: keysToAnswer(' Quick safety check: Is this a project you created or one you trust?', claudeAdapter.firstRun!.answers[0])
		}, {
			ownHooks: undefined,
			working: undefined,
			noMenu: undefined
		});
	});

	test('the cursor is moved up or down to the option, or not at all when it is on it', () => {
		const answer = { question: /Pick one/, choose: /Yes/ };
		assert.deepStrictEqual({
			on: keysToAnswer('Pick one\n❯ Yes\n  No', answer),
			below: keysToAnswer('Pick one\n  Yes\n  Maybe\n❯ No', answer)
		}, {
			on: [ENTER],
			below: [UP, UP, ENTER]
		});
	});
});
