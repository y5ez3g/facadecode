/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FirstRunQuestion } from '../clis/cli';
import { Terminals } from './ports';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';

/** How long a new agent's screen is watched for its first-run question (WA-8.3). */
export const FIRST_RUN_MS = 90_000;
const POLL_MS = 500;
/** How long an answer is given to take before it is given again. */
const ANSWER_AGAIN_MS = 3_000;
/** Between two keys: sent together, a terminal UI can take them for a paste. */
const KEY_GAP_MS = 150;

/**
 * The keys that answer `question` on `screen`: the cursor moved from where it is to the answer, then
 * Enter. Undefined when the question, its menu's cursor or the answer is not on screen.
 */
export function keysToAnswer(screen: string, question: FirstRunQuestion): string[] | undefined {
	const lines = screen.split('\n');
	const asked = lines.findIndex(line => question.question.test(line));
	if (asked < 0) {
		return undefined;
	}
	const menu = lines.slice(asked + 1);
	const cursor = menu.findIndex(line => question.cursor.test(line));
	const answer = menu.findIndex(line => question.answer.test(line));
	if (cursor < 0 || answer < 0) {
		return undefined;
	}
	return [...new Array<string>(Math.abs(answer - cursor)).fill(answer > cursor ? DOWN : UP), ENTER];
}

export interface FirstRunWatch {
	readonly terminals: Terminals;
	/** The agent's terminal. */
	readonly terminal: string;
	readonly question: FirstRunQuestion;
	/** Whether to go on watching: false once the agent is past its first run, or gone. */
	readonly watching: () => boolean;
	readonly log: (message: string) => void;
	readonly now?: () => number;
}

/**
 * Answers a CLI's first-run question in its terminal, as the person would, pressing the keys the
 * person would press (section 8): for up to {@link FIRST_RUN_MS}, until the question has been
 * answered and is gone, or the agent is past its first run.
 */
export async function answerFirstRun(watch: FirstRunWatch): Promise<void> {
	const now = watch.now ?? Date.now;
	const deadline = now() + FIRST_RUN_MS;
	let answeredAt: number | undefined;
	while (now() < deadline && watch.watching()) {
		const screen = await watch.terminals.read(watch.terminal, 40);
		const keys = screen === undefined ? undefined : keysToAnswer(screen, watch.question);
		if (!keys) {
			if (answeredAt !== undefined) {
				return;
			}
		} else if (answeredAt === undefined || now() - answeredAt >= ANSWER_AGAIN_MS) {
			for (const [index, key] of keys.entries()) {
				if (index) {
					await delay(KEY_GAP_MS);
				}
				await watch.terminals.type(watch.terminal, key);
			}
			answeredAt = now();
			watch.log(`${watch.terminal} asked ${watch.question.question.source}: answered ${watch.question.answer.source}`);
		}
		await delay(POLL_MS);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
