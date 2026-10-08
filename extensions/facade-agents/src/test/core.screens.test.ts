/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { FacadeError } from '../core/errors';
import { TerminalScreen } from '../core/ports';
import { PERSON } from '../record/events';
import { finalScreenFile, screensDir } from '../record/screens';
import { settled, until, useFakeClock } from './clock';
import { callerOf, fakeWorld } from './fakes';
import { outcomeOf, tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

/** What a call failed with: its code, its message, and the facts its data holds. */
async function failureOf(promise: Promise<unknown>): Promise<{ readonly code: string; readonly message: string; readonly data: unknown } | 'fulfilled'> {
	try {
		await promise;
		return 'fulfilled';
	} catch (err) {
		return err instanceof FacadeError ? { code: err.code, message: err.message, data: err.data } : { code: 'none', message: String(err), data: undefined };
	}
}

suite('Core: agents\' screens', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-screens-core-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** The name of the terminal of the agent numbered `id`. */
	function terminalOf(id: number): string {
		const launch = world.terminals.launched.find(each => each.name.includes(` #${id} · `));
		assert.ok(launch, `#${id} was launched`);
		return launch.name;
	}

	/** What the terminal of agent `id` shows from now on. */
	function shows(id: number, lines: readonly string[], screen: Partial<TerminalScreen> = {}): void {
		world.terminals.screens.set(terminalOf(id), { lines, buffer: 'normal', older: false, trimmed: false, capturedAt: 5_000, exited: false, ...screen });
	}

	/** Writes the final screen of agent `id` as the window writes it. */
	function keeps(id: number, screen: object): void {
		const dir = screensDir(world.table.dir);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(finalScreenFile(dir, id), JSON.stringify(screen));
	}

	/** A tree: the person's #1, its child #2 and grandchild #3; and the person's #4, another tree. */
	async function twoTrees(): Promise<void> {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', prompt: 'Lead.', folder: lab, name: 'lead' });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'm', effort: 'e', prompt: 'Work.', name: 'worker' });
		await world.spawnUp(callerOf(world.agent(2)), { cli: 'arg', model: 'm', effort: 'e', prompt: 'Help.', name: 'helper' });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', prompt: 'Other.', folder: lab, name: 'other' });
	}

	test('an agent reads another\'s screen: its bottom lines, fifty unless told, as the window drew them, with when it was read and last showed output, and whether its process ended or the terminal let go of older lines', async () => {
		await twoTrees();
		shows(2, Array.from({ length: 60 }, (_, index) => `line ${index + 1}`), { lastOutput: 4_000 });
		const lead = callerOf(world.agent(1));
		const fifty = await world.facade.screens.read(lead, '#2');
		const three = await world.facade.screens.read(lead, '@worker', 3);
		shows(2, ['bye'], { trimmed: true, exited: true });
		const ending = await world.facade.screens.read(lead, '#2');

		assert.deepStrictEqual({ fifty: { ...fifty, text: fifty.text.split('\n').length }, three, ending }, {
			fifty: { id: 2, name: 'worker', cli: 'arg', state: 'running', requested: 50, source: 'normal', capturedAt: 5_000, lastOutput: 4_000, selected: 50, older: true, text: 50 },
			three: { id: 2, name: 'worker', cli: 'arg', state: 'running', requested: 3, source: 'normal', capturedAt: 5_000, lastOutput: 4_000, selected: 3, older: true, text: 'line 58\nline 59\nline 60' },
			ending: { id: 2, name: 'worker', cli: 'arg', state: 'running', requested: 50, source: 'normal', capturedAt: 5_000, exited: true, selected: 1, older: false, trimmed: true, text: 'bye' }
		});
	});

	test('with YOLO off, as it was launched, an agent reaches its own tree - ancestors, descendants, ended ones too - and no other, whatever the settings say later; one launched with YOLO on, every agent; the person, every agent, and has no screen of its own', async () => {
		await twoTrees();
		await settled(world.facade.kill(callerOf(world.agent(2)), '#3'));
		const worker = callerOf(world.agent(2));
		const outcomes = {
			ancestor: (await world.facade.screens.read(worker, '#1')).id,
			descendantEnded: (await world.facade.screens.read(worker, '#3')).source,
			otherTree: await outcomeOf(world.facade.screens.read(worker, '#4')),
			person: (await world.facade.screens.read(PERSON, '#4')).id,
			personsOwn: await outcomeOf(world.facade.screens.read(worker, '@you'))
		};
		world.settings.arg = { launch: { arguments: { fullAccess: ['--yolo'] } } };
		const stillOff = await outcomeOf(world.facade.screens.read(worker, '#4'));
		await world.spawnUp(worker, { cli: 'arg', model: 'm', effort: 'e', prompt: 'Free.', name: 'free' });
		world.settings.arg = {};
		const yolo = (await world.facade.screens.read(callerOf(world.agent(5)), '#4')).id;
		const outsideYourTree = 'REFUSED: @other #4 is outside your tree: you were started with YOLO off, so you reach only the agents of your own tree - the agent the person started it from and every agent started under it, those that ended too.';

		assert.deepStrictEqual({ ...outcomes, stillOff, recorded: [world.agent(2).yolo, world.agent(5).yolo], yolo }, {
			ancestor: 1,
			descendantEnded: 'none',
			otherTree: outsideYourTree,
			person: 4,
			personsOwn: 'REFUSED: The person, @you, has no terminal of Facade\'s: read_screen reads agents\' terminals.',
			stillOff: outsideYourTree,
			recorded: [false, true],
			yolo: 4
		});
	});

	test('an agent is named as every Facade tool names one: by number, or by a name only one running agent has; a name only ended agents had gives their numbers', async () => {
		await twoTrees();
		await settled(world.facade.kill(callerOf(world.agent(2)), '#3'));

		assert.deepStrictEqual({
			ended: await outcomeOf(world.facade.screens.read(PERSON, '@helper')),
			none: await outcomeOf(world.facade.screens.read(PERSON, '#9')),
			mismatched: await outcomeOf(world.facade.screens.read(PERSON, '@worker #3'))
		}, {
			ended: 'NOT_FOUND: No running agent is called @helper; @helper #3 has exited: name one by its number.',
			none: 'NOT_FOUND: No agent is #9: ps with all lists every agent this workspace has had.',
			mismatched: 'INVALID: #3 is @helper, not @worker: name it by its number alone, or by its name.'
		});
	});

	test('a screen with nothing on it, and one past eight thousand characters - every line in a file of its own, the result its last lines, or the end of the one line too long', async () => {
		await twoTrees();
		const lead = callerOf(world.agent(1));
		const empty = await world.facade.screens.read(lead, '#2');
		const long = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')} ${'x'.repeat(95)}`);
		shows(2, long);
		const past = await world.facade.screens.read(lead, '#2', 100);
		shows(2, ['short', 'y'.repeat(9_000)]);
		const oneLine = await world.facade.screens.read(lead, '#2');
		const snapshot = past.snapshot ? fs.readFileSync(past.snapshot, 'utf8') : undefined;

		assert.deepStrictEqual({
			empty: [empty.source, empty.empty, empty.text],
			past: { omitted: past.omitted, first: past.text.slice(0, 4), length: past.text.length, inScreens: path.dirname(past.snapshot ?? '') === screensDir(world.table.dir), snapshot: snapshot === `${long.join('\n')}\n` },
			oneLine: { omitted: oneLine.omitted, text: oneLine.text === 'y'.repeat(8_000) }
		}, {
			empty: ['normal', 'no_text', ''],
			past: { omitted: { lines: 20, chars: 2_000, partialFirstLine: false }, first: '020 ', length: 7_999, inScreens: true, snapshot: true },
			oneLine: { omitted: { lines: 1, chars: 1_006, partialFirstLine: true }, text: true }
		});
	});

	test('an agent that ended is read by its final screen: the newest lines of the screen as its terminal ended first, then the last full-screen frame while lines are left; with none to read, why', async () => {
		await twoTrees();
		await settled(world.facade.kill(callerOf(world.agent(2)), '#3'));
		keeps(3, { frame: ['Pick one', '[[> keep]]', '  drop'], final: { buffer: 'normal', lines: ['bye', '$'] } });
		const worker = callerOf(world.agent(2));
		const four = await world.facade.screens.read(worker, '#3', 4);
		const two = await world.facade.screens.read(worker, '#3', 2);
		const noScreen = await world.facade.screens.read(PERSON, '#4');
		await settled(world.facade.kill(PERSON, '#4'));
		const notKept = await world.facade.screens.read(PERSON, '#4');
		fs.writeFileSync(finalScreenFile(screensDir(world.table.dir), 4), 'bye');
		const unreadable = await world.facade.screens.read(PERSON, '#4');

		assert.deepStrictEqual({
			four: { source: four.source, selected: four.selected, older: four.older, text: four.text, parts: four.parts, file: four.finalScreen === finalScreenFile(screensDir(world.table.dir), 3) },
			two: { selected: two.selected, older: two.older, text: two.text, parts: two.parts },
			noScreen: noScreen.empty,
			notKept: { source: notKept.source, empty: notKept.empty, exit: notKept.exit?.kind, file: notKept.finalScreen },
			unreadable: { empty: unreadable.empty, problem: unreadable.problem },
			logged: world.logs.filter(line => line.startsWith('The final screen of')).length
		}, {
			four: { source: 'final', selected: 4, older: true, text: '[the last full-screen frame it drew before it left it]\n[[> keep]]\n  drop\n[its screen as its terminal ended]\nbye\n$', parts: [{ kind: 'frame', lines: 2, of: 3 }, { kind: 'final', lines: 2, of: 2 }], file: true },
			two: { selected: 2, older: true, text: 'bye\n$', parts: [{ kind: 'frame', lines: 0, of: 3 }, { kind: 'final', lines: 2, of: 2 }] },
			noScreen: 'no_text',
			notKept: { source: 'none', empty: 'not_kept', exit: 'killed', file: undefined },
			unreadable: { empty: 'unreadable', problem: 'it is not JSON' },
			logged: 1
		});
	});

	test('a final screen past eight thousand characters says how many of its own lines it leaves out: its headings are no lines of it', async () => {
		await twoTrees();
		await settled(world.facade.kill(callerOf(world.agent(2)), '#3'));
		keeps(3, { frame: Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')} ${'x'.repeat(95)}`), final: { buffer: 'normal', lines: ['bye', '$'] } });
		const read = await world.facade.screens.read(PERSON, '#3', 102);

		assert.deepStrictEqual({ selected: read.selected, omitted: read.omitted, first: read.text.slice(0, 4), last: read.text.split('\n').slice(-3) }, {
			selected: 102,
			omitted: { lines: 21, chars: 2_155, partialFirstLine: false },
			first: '021 ',
			last: ['[its screen as its terminal ended]', 'bye', '$']
		});
	});

	test('an agent still starting has no terminal to read yet; one the window has not given back after a reload is not there now', async () => {
		await twoTrees();
		const lead = callerOf(world.agent(1));
		const spawning = world.facade.spawn(PERSON, { cli: 'arg', model: 'm', effort: 'e', prompt: 'New.', folder: lab, name: 'new' });
		await until(() => world.terminals.launched.length === 5);
		world.terminals.running.delete(terminalOf(5));
		const starting = (await world.facade.screens.read(PERSON, '#5')).empty;
		world.terminals.running.delete(terminalOf(2));
		const notBack = await outcomeOf(world.facade.screens.read(lead, '#2'));
		world.terminals.running.add(terminalOf(5));
		world.hello(5);
		await settled(spawning);

		assert.deepStrictEqual({ starting, notBack }, {
			starting: 'not_created',
			notBack: 'UNAVAILABLE: @worker #2\'s terminal is not there now: the window may still be giving its terminals back after a reload. Try again in a moment.'
		});
	});

	test('a start that failed says so with the last lines of the screen its CLI left, and the person hears of an agent of theirs that ended with where its last screen is', async () => {
		const spawning = world.facade.spawn(PERSON, { cli: 'arg', model: 'nope', effort: 'e', prompt: 'Work.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		keeps(1, { final: { buffer: 'normal', lines: ['Error: unknown model nope', 'exiting'] } });
		world.terminals.end(terminalOf(1), { exitCode: 1, byThePerson: false });
		const failed = await failureOf(settled(spawning));
		await world.spawnUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', prompt: 'Lead.', folder: lab });
		world.terminals.end(terminalOf(2), { exitCode: 3, byThePerson: false });
		const dir = screensDir(world.table.dir);

		assert.deepStrictEqual({ failed, ended: world.person.ended }, {
			failed: {
				code: 'FAILED',
				message: 'Arg Code did not start as @main #1: its CLI ended with exit code 1\nThe last lines of its screen, as they were (read_screen #1 gives up to 2000 of them):\nError: unknown model nope\nexiting',
				data: { agent: 1, finalScreen: finalScreenFile(dir, 1) }
			},
			ended: [{ id: 2, name: 'main', terminal: '@main #2 · Arg Code', finalScreen: finalScreenFile(dir, 2), ending: 'exited: its CLI ended with exit code 3' }]
		});
	});

	test('the terminals the window gives back after a reload are told again whose they are, and where their final screens go; a fresh start lets go of the screens of agents that ended before it, and says so, a reload keeps them', async () => {
		await twoTrees();
		await settled(world.facade.kill(callerOf(world.agent(2)), '#3'));
		keeps(3, { final: { buffer: 'normal', lines: ['bye'] } });
		const dir = screensDir(world.table.dir);
		await world.facade.recover(true);
		const registered = [...world.terminals.registered];
		const afterReload = fs.existsSync(finalScreenFile(dir, 3));
		world.dispose();
		// The app started again: another load of the window, the one before closed
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
		await world.facade.recover(false);
		const read = await world.facade.screens.read(PERSON, '#3');

		assert.deepStrictEqual({ registered, afterReload, afterRestart: fs.existsSync(finalScreenFile(dir, 3)), read: read.empty }, {
			registered: [1, 2, 4].map(id => `${['', '@lead #1', '@worker #2', '', '@other #4'][id]} · Arg Code as #${id}: ${finalScreenFile(dir, id)}`),
			afterReload: true,
			afterRestart: false,
			read: 'discarded'
		});
	});
});
