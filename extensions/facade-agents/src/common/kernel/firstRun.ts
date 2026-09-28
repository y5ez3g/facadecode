/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FirstRunAnswer } from '../agents';

/*
 * The questions an agent's own UI asks as it starts, before it can work - whether to trust its
 * folder, or the hooks Facade gave it (L2-PLAN, step 28). Read off its terminal's screen, and answered
 * with the keys the person would press: the arrows to the option, then Enter.
 */

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';

/** The option a menu's cursor is on: its line starts with the marker - Claude's U+276F, Codex's U+203A. */
// allow-any-unicode-next-line
const CURSOR = /^\s*[❯›>]\s/;

/**
 * The keys that answer `answer` on `screen`, a terminal's last lines, one key to send at a time.
 * Undefined when the screen does not ask it, asks it about more than Facade may answer for, or shows
 * no option to pick.
 */
export function keysToAnswer(screen: string, answer: FirstRunAnswer): string[] | undefined {
	const lines = screen.split(/\r?\n/);
	const asked = lines.findIndex(line => answer.question.test(line));
	if (asked < 0 || (answer.onlyIf && !answer.onlyIf.test(screen))) {
		return undefined;
	}
	const options = lines.slice(asked + 1);
	const cursor = options.findIndex(line => CURSOR.test(line));
	const pick = options.findIndex(line => answer.choose.test(line));
	if (cursor < 0 || pick < 0) {
		return undefined;
	}
	return [...new Array<string>(Math.abs(pick - cursor)).fill(pick > cursor ? DOWN : UP), ENTER];
}
