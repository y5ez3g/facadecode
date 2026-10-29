/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { keyOf } from '../core/keys';
import { TerminalScreen } from '../core/ports';
import { ScreenRead } from '../core/screens';
import { PERSON } from '../record/events';
import { finalScreenFile, finalScreenTextFile, SCREEN_LANGUAGE, screensDir } from '../record/screens';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { failureOf, outcomeOf, tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

suite('Core: agents\' screens', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	/** A worktree Facade made of `lab`, where the person starts agents that start agents of their own (O3). */
	let work: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-screens-core-');
		lab = path.join(temp.dir, 'lab');
		work = worktreeFolder(lab, 'work');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['work'] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** The title of the terminal of the agent numbered `id`. */
	function terminalOf(id: number): string {
		const launch = world.terminals.launched.find(each => each.id === id);
		assert.ok(launch, `#a${id} was launched`);
		return launch.name;
	}

	/** What the terminal of agent `id` shows from now on. */
	function shows(id: number, lines: readonly string[], screen: Partial<TerminalScreen> = {}): void {
		world.terminals.screens.set(id, { lines, buffer: 'normal', older: false, trimmed: false, capturedAt: 5_000, exited: false, ...screen });
	}

	/** Writes the final screen of agent `id` as the window writes it, or `text` in its place. */
	function keeps(id: number, screen: object | string): void {
		const dir = screensDir(world.table.dir);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(finalScreenFile(dir, id), typeof screen === 'string' ? screen : JSON.stringify(screen));
	}

	/** A tree: the person's #1, its child #2 and grandchild #3; and the person's #4, another tree. */
	async function twoTrees(): Promise<void> {
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Lead.', folder: work, name: 'lead' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'm', effort: 'e', task: 'Work.', name: 'worker' });
		await world.startUp(callerOf(world.agent(2)), { cli: 'arg', model: 'm', effort: 'e', task: 'Help.', name: 'helper' });
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Other.', folder: work, name: 'other' });
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

	test('with YOLO off, as it was launched, an agent reaches its own tree - ancestors, descendants, ended ones too - and no other, whatever the switch says later; one launched with YOLO on, every agent; the person, every agent, and has no screen of its own (O1)', async () => {
		// The person's agents started with YOLO off, and so the agents they start
		world.switches.yolo = false;
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		const worker = callerOf(world.agent(2));
		const outcomes = {
			ancestor: (await world.facade.screens.read(worker, '#1')).id,
			descendantEnded: (await settled(world.facade.screens.read(worker, '#3'))).source,
			otherTree: await outcomeOf(world.facade.screens.read(worker, '#4')),
			person: (await world.facade.screens.read(PERSON, '#4')).id,
			personsOwn: await outcomeOf(world.facade.screens.read(worker, '@human')),
			typeOtherTree: await outcomeOf(world.facade.screens.type(worker, '#4', 'hi', false))
		};
		world.switches.yolo = true;
		const stillOff = await outcomeOf(world.facade.screens.read(worker, '#4'));
		// One the person starts now, with YOLO on
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Free.', folder: work, name: 'free' });
		const yolo = (await world.facade.screens.read(callerOf(world.agent(5)), '#4')).id;
		const outsideYourTree = 'REFUSED: #a4 is outside your tree. With YOLO off, you can reach only your tree: your human-started root and all its descendants.';

		assert.deepStrictEqual({ ...outcomes, stillOff, recorded: [world.agent(2).yolo, world.agent(5).yolo], yolo }, {
			ancestor: 1,
			descendantEnded: 'none',
			otherTree: outsideYourTree,
			person: 4,
			personsOwn: 'REFUSED: @human is the person and has no agent run to stop, read, or type into. Use send_message to contact them.',
			typeOtherTree: outsideYourTree,
			stillOff: outsideYourTree,
			recorded: [false, true],
			yolo: 4
		});
	});

	test('with YOLO off, a name two trees have is the one of the caller\'s own tree, as send_message takes it; a name only another tree has is out of the caller\'s reach', async () => {
		world.switches.yolo = false;
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Lead.', folder: work, name: 'lead' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'm', effort: 'e', task: 'Twin.', name: 'twin' });
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Other.', folder: work, name: 'other' });
		await world.startUp(callerOf(world.agent(3)), { cli: 'arg', model: 'm', effort: 'e', task: 'Twin.', name: 'twin' });
		await world.startUp(callerOf(world.agent(3)), { cli: 'arg', model: 'm', effort: 'e', task: 'Far.', name: 'far' });
		shows(2, ['the lead\'s twin']);
		shows(4, ['the other\'s twin']);
		const lead = callerOf(world.agent(1));

		assert.deepStrictEqual({
			read: (await world.facade.screens.read(lead, '@twin')).id,
			typed: (await settled(world.facade.screens.type(lead, '@twin', 'hi', false))).id,
			pressed: (await settled(world.facade.screens.press(lead, '@twin', ['Enter']))).id,
			sent: world.facade.mail.send(lead, ['@twin'], 'Hi.', undefined).map(each => each.to),
			far: await outcomeOf(world.facade.screens.read(lead, '@far'))
		}, {
			read: 2,
			typed: 2,
			pressed: 2,
			sent: ['@twin #a2'],
			// By its name, one out of reach is no agent the caller knows of (O2)
			far: 'NOT_FOUND: No reachable agent is named @far. Call list_agents with all:true to see reachable runs.'
		});
	});

	test('an agent is named as every Facade tool names one: by number, or by a name only one running agent has; a name only ended agents had gives their numbers', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));

		assert.deepStrictEqual({
			ended: await outcomeOf(world.facade.screens.read(PERSON, '@helper')),
			none: await outcomeOf(world.facade.screens.read(PERSON, '#9')),
			mismatched: await outcomeOf(world.facade.screens.read(PERSON, '@worker #a3'))
		}, {
			ended: 'NOT_FOUND: All runs named @helper have ended: @helper #a3. Select one by its agent ID.',
			none: 'NOT_FOUND: No agent has ID #a9. Call list_agents with all:true to see every reachable run.',
			mismatched: 'NOT_FOUND: Name and ID do not match: @worker is not #a3; #a3 is @helper. Use the ID alone or the correct name.'
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

	test('a line too long to give whole, with lines below it - the blank row the cursor is on, a prompt: its end fills what they leave, said to be partial; a line that could fit whole is left out whole', async () => {
		await twoTrees();
		const lead = callerOf(world.agent(1));
		shows(2, ['short', 'y'.repeat(9_000), '']);
		const cursorBelow = await world.facade.screens.read(lead, '#2');
		shows(2, ['short', 'y'.repeat(9_000), 'tail']);
		const promptBelow = await world.facade.screens.read(lead, '#2');
		shows(2, ['short', 'y'.repeat(7_000), 'z'.repeat(1_500)]);
		const fitsWhole = await world.facade.screens.read(lead, '#2');

		assert.deepStrictEqual({
			cursorBelow: { omitted: cursorBelow.omitted, text: cursorBelow.text === `${'y'.repeat(7_999)}\n` },
			promptBelow: { omitted: promptBelow.omitted, text: promptBelow.text === `${'y'.repeat(7_995)}\ntail` },
			fitsWhole: { omitted: fitsWhole.omitted, text: fitsWhole.text === 'z'.repeat(1_500) }
		}, {
			cursorBelow: { omitted: { lines: 1, chars: 1_007, partialFirstLine: true }, text: true },
			promptBelow: { omitted: { lines: 1, chars: 1_011, partialFirstLine: true }, text: true },
			fitsWhole: { omitted: { lines: 2, chars: 7_007, partialFirstLine: false }, text: true }
		});
	});

	test('an agent that ended is read by its final screen: the newest lines of the screen as its terminal ended first, then the last full-screen frame while lines are left; with none to read, why', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		keeps(3, { frame: ['Pick one', '[[> keep]]', '  drop'], final: { buffer: 'normal', lines: ['bye', '$'] } });
		const worker = callerOf(world.agent(2));
		const four = await world.facade.screens.read(worker, '#3', 4);
		const two = await world.facade.screens.read(worker, '#3', 2);
		const noScreen = await world.facade.screens.read(PERSON, '#4');
		await settled(world.facade.stopAgent(PERSON, '#4'));
		const notKept = await world.facade.screens.read(PERSON, '#4');
		fs.writeFileSync(finalScreenFile(screensDir(world.table.dir), 4), 'bye');
		const unreadable = await world.facade.screens.read(PERSON, '#4');

		assert.deepStrictEqual({
			four: { source: four.source, selected: four.selected, older: four.older, text: four.text, parts: four.parts, file: four.finalScreen === finalScreenTextFile(screensDir(world.table.dir), 3) },
			two: { selected: two.selected, older: two.older, text: two.text, parts: two.parts },
			noScreen: noScreen.empty,
			notKept: { source: notKept.source, empty: notKept.empty, end: notKept.end?.kind, file: notKept.finalScreen },
			unreadable: { empty: unreadable.empty, problem: unreadable.problem },
			logged: world.logs.filter(line => line.startsWith('Could not ') && line.includes('final screen')).length
		}, {
			four: { source: 'final', selected: 4, older: true, text: '[last full-screen frame before the CLI left full-screen mode]\n[[> keep]]\n  drop\n[screen at terminal end]\nbye\n$', parts: [{ kind: 'frame', lines: 2, of: 3 }, { kind: 'final', lines: 2, of: 2 }], file: true },
			two: { selected: 2, older: true, text: 'bye\n$', parts: [{ kind: 'frame', lines: 0, of: 3 }, { kind: 'final', lines: 2, of: 2 }] },
			noScreen: 'no_text',
			notKept: { source: 'none', empty: 'not_kept', end: 'stopped', file: undefined },
			unreadable: { empty: 'unreadable', problem: 'the file is not valid JSON' },
			logged: 1
		});
	});

	test('a final screen past eight thousand characters says how many of its own lines it leaves out: its headings are no lines of it', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		keeps(3, { frame: Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')} ${'x'.repeat(95)}`), final: { buffer: 'normal', lines: ['bye', '$'] } });
		const read = await world.facade.screens.read(PERSON, '#3', 102);

		assert.deepStrictEqual({ selected: read.selected, omitted: read.omitted, first: read.text.slice(0, 4), last: read.text.split('\n').slice(-3) }, {
			selected: 102,
			omitted: { lines: 21, chars: 2_162, partialFirstLine: false },
			first: '021 ',
			last: ['[screen at terminal end]', 'bye', '$']
		});
	});

	test('an agent that ended has its final screen in a file of text, which an agent\'s file reader takes whole - one screen line per line, its parts labeled - written as it is first read, and never again: that is the file a read gives, past eight thousand characters too (D2, D6; DB-01)', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		const long = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')} ${'x'.repeat(95)}`);
		keeps(3, { frame: ['Pick one', '[[> keep]]'], final: { buffer: 'normal', lines: long } });
		const read = await world.facade.screens.read(PERSON, '#3', 102);
		const file = finalScreenTextFile(screensDir(world.table.dir), 3);
		const text = fs.readFileSync(file, 'utf8');
		keeps(3, { final: { buffer: 'normal', lines: ['written again'] } });
		const again = await world.facade.screens.read(PERSON, '#3');

		assert.deepStrictEqual({ finalScreen: read.finalScreen, cut: !!read.omitted, text, again: [again.finalScreen, fs.readFileSync(file, 'utf8') === text] }, {
			finalScreen: file,
			cut: true,
			text: ['[last full-screen frame before the CLI left full-screen mode]', 'Pick one', '[[> keep]]', '[screen at terminal end]', ...long, ''].join('\n'),
			again: [file, true]
		});
	});

	test('a final screen whose screen as its terminal ended was blank: the frame given is labeled, and the blank screen said to be so; with no frame it is a screen kept all the same - its creator is told it was blank, not that none was kept (D6; DB-03)', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		keeps(3, { frame: ['Pick one', '[[> keep]]'], final: { buffer: 'normal', lines: [] } });
		const menu = await world.facade.screens.read(PERSON, '#3');
		// @lead's child @worker clears its screen as it exits
		keeps(2, { final: { buffer: 'normal', lines: [] } });
		world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
		await sleep(1_000);
		const ends = world.facadeMessagesTo(1).filter(text => text.startsWith('@worker #a2 ended'));
		const notices = ends.map(text => text.split('\n').slice(1));

		assert.deepStrictEqual({ menu: [menu.text, menu.parts], notices }, {
			menu: ['[last full-screen frame before the CLI left full-screen mode]\nPick one\n[[> keep]]\n[screen at terminal end: blank]', [{ kind: 'frame', lines: 2, of: 2 }, { kind: 'final', lines: 0, of: 0 }]],
			notices: [['The final screen was blank.']]
		});
	});

	test('a final screen read as the window writes it - its file half written - is read again until it is whole, within the moment the window has to write it; one not whole by then cannot be read, and says why (D8; DB-04)', async () => {
		world.timing.finalScreenWaitMs = 2_000;
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		keeps(3, '{"final":{"buffer":"nor');
		const reading = world.facade.screens.read(PERSON, '#3');
		await sleep(300);
		keeps(3, { final: { buffer: 'normal', lines: ['bye'] } });
		const whole = await settled(reading);
		await settled(world.facade.stopAgent(PERSON, '#4'));
		keeps(4, '');
		const half = await settled(world.facade.screens.read(PERSON, '#4'));

		assert.deepStrictEqual({ whole: [whole.source, whole.text], half: [half.empty, half.problem] }, {
			whole: ['final', 'bye'],
			half: ['unreadable', 'the file is not valid JSON']
		});
	});

	test('a final screen read says when it was taken and when its terminal last showed new output, and what the terminal no longer held - lines its scrollback had let go of, or lines past those a final screen keeps - as a read while it ran says them (D2; DB-06)', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		keeps(3, { capturedAt: 9_000, lastOutput: 4_000, final: { buffer: 'normal', lines: ['bye', '$'], older: false, trimmed: true } });
		const trimmed = await world.facade.screens.read(PERSON, '#3');
		await settled(world.facade.stopAgent(PERSON, '#4'));
		keeps(4, { capturedAt: 9_000, final: { buffer: 'normal', lines: ['$'], older: true, trimmed: true } });
		const cut = await world.facade.screens.read(PERSON, '#4');
		const facts = (read: ScreenRead) => ({ capturedAt: read.capturedAt, lastOutput: read.lastOutput, older: read.older, trimmed: read.trimmed, cut: read.cut });

		assert.deepStrictEqual({ trimmed: facts(trimmed), cut: facts(cut) }, {
			trimmed: { capturedAt: 9_000, lastOutput: 4_000, older: false, trimmed: true, cut: undefined },
			cut: { capturedAt: 9_000, lastOutput: undefined, older: true, trimmed: true, cut: true }
		});
	});

	test('text typed goes in as one paste, Enter after the delay the CLI was launched with, waiting for its turn at most the timeout; the log says what was about to go in and what did; the answer has the screen two seconds on', async () => {
		await twoTrees();
		shows(2, ['> yes']);
		// Launched with 300 ms: what the settings say later does not change it
		world.settings.arg = { launch: { enterDelay: 50 } };
		const text = ' yes, keep the tests as they are and fix only the docs ';
		const result = await settled(world.facade.screens.type(callerOf(world.agent(1)), '#2', text, true));
		const pressed = await settled(world.facade.screens.press(callerOf(world.agent(1)), '#2', ['Down', 'Enter']));
		const shown = JSON.stringify(`${text.slice(0, 40)}...`);

		assert.deepStrictEqual({ result: { ...result, screen: result.screen?.text }, pressed: pressed.effect, typed: world.terminals.typed.slice(-2), logs: world.logs.filter(line => line.includes('@worker #a2\'s terminal')) }, {
			result: { id: 2, name: 'worker', effect: { outcome: 'applied', pasted: true, entered: true }, screen: '> yes' },
			pressed: { outcome: 'applied', keysSent: 2 },
			typed: [
				`@worker #a2: type ${JSON.stringify(text)}, Enter after 300 ms, waiting 120000 ms at most`,
				'@worker #a2: keys Down Enter, waiting 120000 ms at most'
			],
			logs: [
				`@lead #a1 pasting ${text.length} characters, ${shown}, then sending Enter, into @worker #a2's terminal.`,
				`@lead #a1 pasting ${text.length} characters, ${shown}, then sending Enter, into @worker #a2's terminal: the text was pasted and Enter was sent.`,
				'@lead #a1 sending keys Down, Enter to @worker #a2\'s terminal.',
				'@lead #a1 sending keys Down, Enter to @worker #a2\'s terminal: all 2 keys were sent.'
			]
		});
	});

	test('what did not go in all is said with what did: nothing while it waited its turn, nothing into a terminal that ended first, a part before it ended, and unknown where the window could not say', async () => {
		await twoTrees();
		const lead = callerOf(world.agent(1));
		world.terminals.nextInput.push(
			{ outcome: 'not_applied', reason: 'timeout', pasted: false, entered: false },
			{ outcome: 'not_applied', reason: 'ended', keysSent: 0 },
			{ outcome: 'partial', reason: 'ended', keysSent: 1 },
			new Error('the extension host restarted')
		);

		assert.deepStrictEqual([
			await failureOf(settled(world.facade.screens.type(lead, '#2', 'yes', true))),
			await failureOf(settled(world.facade.screens.press(lead, '#2', ['Enter']))),
			await failureOf(settled(world.facade.screens.press(lead, '#2', ['Down', 'Enter']))),
			await failureOf(settled(world.facade.screens.type(lead, '#2', 'yes', false)))
		], [
			{ code: 'UNAVAILABLE', message: 'No input was written to @worker #a2\'s terminal. It waited 120 seconds behind human typing or earlier Facade input. Call read_screen before retrying.', data: { outcome: 'not_applied', reason: 'timeout', pasted: false, entered: false } },
			{ code: 'REFUSED', message: 'No input was written to @worker #a2\'s terminal because it ended first. Use read_screen to inspect its final screen.', data: { outcome: 'not_applied', reason: 'ended', keysSent: 0 } },
			{ code: 'FAILED', message: '@worker #a2\'s terminal ended during input: sent 1 of the requested keys.', data: { outcome: 'partial', reason: 'ended', keysSent: 1 } },
			{ code: 'UNAVAILABLE', message: 'Terminal input outcome is unknown for @worker #a2. Call read_screen before sending any more text or keys. Reason: the extension host restarted', data: { outcome: 'unknown' } }
		]);
	});

	test('input that went in partway, its terminal gone before Facade knows, answers with the last lines of the final screen the window kept', async () => {
		await twoTrees();
		keeps(2, { final: { buffer: 'normal', lines: ['Bye!'] } });
		world.terminals.nextInput.push({ outcome: 'partial', reason: 'ended', pasted: true, entered: false });

		assert.deepStrictEqual(await failureOf(settled(world.facade.screens.type(callerOf(world.agent(1)), '#2', 'yes', true))), {
			code: 'FAILED',
			message: '@worker #a2\'s terminal ended during input: the text was pasted without Enter. Final screen excerpt:\nBye!',
			data: { outcome: 'partial', reason: 'ended', pasted: true, entered: false, finalScreen: finalScreenTextFile(screensDir(world.table.dir), 2) }
		});
	});

	test('an agent still starting has no terminal to read or type into yet; one the window has not given back after a reload is not there now; input that went in whose screen could not be read after says so', async () => {
		await twoTrees();
		const lead = callerOf(world.agent(1));
		// Its terminal not made yet: the window slow to make one
		let opened = () => { };
		world.terminals.hold = new Promise<void>(resolve => opened = resolve);
		const spawning = world.facade.startAgent(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'New.', folder: work, name: 'new' });
		await until(() => world.table.get(5) !== undefined);
		const read = await world.facade.screens.read(PERSON, '#5');
		const starting = { read: [read.empty, read.phase], type: await failureOf(world.facade.screens.type(PERSON, '#5', 'hi', true)) };
		world.terminals.hold = undefined;
		opened();
		await until(() => world.terminals.launched.length === 5);
		world.terminals.running.delete(terminalOf(2));
		const notBack = { read: await outcomeOf(world.facade.screens.read(lead, '#2')), keys: await failureOf(world.facade.screens.press(lead, '#2', ['Enter'])) };
		world.terminals.running.add(terminalOf(2));
		const typed = world.terminals.typed.length;
		const typing = world.facade.screens.type(lead, '#2', 'yes', true);
		await until(() => world.terminals.typed.length > typed);
		world.terminals.running.delete(terminalOf(2));
		const unread = await settled(typing);
		world.terminals.running.add(terminalOf(5));
		world.hello(5);
		await settled(spawning);

		assert.deepStrictEqual({ starting, notBack, unread }, {
			starting: {
				read: ['not_created', 'launching_cli'],
				type: { code: 'REFUSED', message: '@new #a5 is still starting and has no terminal yet. No input was written.', data: { outcome: 'not_applied' } }
			},
			notBack: {
				read: 'UNAVAILABLE: @worker #a2\'s terminal is temporarily unavailable; the window may still be restoring terminals after a reload. Retry once the terminal is available.',
				keys: { code: 'UNAVAILABLE', message: '@worker #a2\'s terminal is temporarily unavailable; the window may still be restoring terminals after a reload. No input was written. Retry once the terminal is available.', data: { outcome: 'not_applied' } }
			},
			unread: { id: 2, name: 'worker', effect: { outcome: 'applied', pasted: true, entered: true }, screenUnavailable: '@worker #a2\'s terminal is temporarily unavailable; the window may still be restoring terminals after a reload. Retry once the terminal is available.' }
		});
	});

	test('an agent that ended takes no input, and the log says who was refused what; an agent may type into its own terminal', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		const worker = callerOf(world.agent(2));
		const own = await settled(world.facade.screens.press(worker, '#2', ['Escape']));

		assert.deepStrictEqual({
			ended: await failureOf(world.facade.screens.type(worker, '#3', 'hi', true)),
			logged: world.logs.filter(line => line.startsWith('Refused input from')),
			own: own.effect
		}, {
			ended: { code: 'REFUSED', message: '@helper #a3 has ended (stopped: with stop_agent) and cannot receive terminal input. Use read_screen to inspect its final screen.', data: { outcome: 'not_applied', reason: 'ended' } },
			logged: ['Refused input from @worker #a2: pasting 2 characters, "hi", then sending Enter, into "#3"\'s terminal. Reason: @helper #a3 has ended (stopped: with stop_agent) and cannot receive terminal input. Use read_screen to inspect its final screen.'],
			own: { outcome: 'applied', keysSent: 1 }
		});
	});

	test('a start that failed says so with the last lines of the screen its CLI left; the notification of an agent of the person\'s that ended shows its last screen', async () => {
		const spawning = world.facade.startAgent(PERSON, { cli: 'arg', model: 'nope', effort: 'e', task: 'Work.', folder: work, name: 'nope' });
		await until(() => world.terminals.launched.length === 1);
		keeps(1, { final: { buffer: 'normal', lines: ['Error: unknown model nope', 'exiting'] } });
		world.terminals.end(terminalOf(1), { exitCode: 1, byThePerson: false });
		const failed = await failureOf(settled(spawning));
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Lead.', folder: work, name: 'lead' });
		world.terminals.end(terminalOf(2), { exitCode: 3, byThePerson: false });
		await sleep(1_000);
		const dir = screensDir(world.table.dir);

		// The person's notice of their agent's end (L6) - their script's start that failed too (L5) - its Show the
		// window's, which opens what endedAgent says (D6)
		assert.deepStrictEqual({ failed, told: world.person.told, ended: world.facade.endedAgent(2) }, {
			failed: {
				code: 'FAILED',
				message: 'Arg Code did not start as @nope #a1: its CLI ended with exit code 1\nScreen excerpt for #a1. Use read_screen for up to 2000 lines:\nError: unknown model nope\nexiting',
				data: { outcome: 'failed', agent: 1, phase: 'connecting', finalScreen: finalScreenTextFile(dir, 1) }
			},
			told: ['error: @nope #a1 failed to start: its CLI ended with exit code 1. (#a1\'s terminal)', 'error: @lead #a2 exited: its CLI ended with exit code 3. (#a2\'s terminal)'],
			ended: { id: 2, name: 'lead', finalScreen: finalScreenFile(dir, 2), ending: 'exited: its CLI ended with exit code 3' }
		});
	});

	test('the terminals the window gives back after a reload are told again whose they are, and where their final screens go; a fresh start lets go of the screens of agents that ended before it, and says so, a reload keeps them', async () => {
		await twoTrees();
		await settled(world.facade.stopAgent(callerOf(world.agent(2)), '#3'));
		keeps(3, { final: { buffer: 'normal', lines: ['bye'] } });
		const dir = screensDir(world.table.dir);
		await world.facade.recover(true);
		const registered = [...world.terminals.registered];
		const afterReload = fs.existsSync(finalScreenFile(dir, 3));
		world.dispose();
		// The app started again: another load of the window, the one before closed
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['work'] } });
		await world.facade.recover(false);
		// The agents that ended left the list with the window going (L12)
		const read = await outcomeOf(world.facade.screens.read(PERSON, '#3'));

		assert.deepStrictEqual({ registered, afterReload, afterRestart: fs.existsSync(finalScreenFile(dir, 3)), read }, {
			registered: [1, 2, 4].map(id => `#a${id} ${finalScreenFile(dir, id)}`),
			afterReload: true,
			afterRestart: false,
			read: 'NOT_FOUND: No agent has ID #a3. Call list_agents with all:true to see every reachable run.'
		});
	});

	test('typing or keys into an agent being stopped are refused, nothing typed; what goes into an agent\'s terminal is written into the person\'s history, agents.log, before and after - who, what, where, and what went in - a refusal not (D9)', async () => {
		await twoTrees();
		const lead = callerOf(world.agent(1));
		await settled(world.facade.screens.type(lead, '#2', 'yes', true));
		world.terminals.stubborn = true;
		const stopping = world.facade.stopAgent(PERSON, '#4');
		await sleep(10);
		const refused = await failureOf(world.facade.screens.press(lead, '#4', ['Enter']));
		world.terminals.stubborn = false;
		await settled(stopping);
		const history = fs.readFileSync(world.table.logFile, 'utf8').split('\n').filter(line => line.includes('  input  ')).map(line => line.replace(/^\S+ \S+ {2}/, ''));

		assert.deepStrictEqual({ refused, history }, {
			refused: { code: 'REFUSED', message: '@other #a4 is stopping and cannot receive terminal input.', data: { outcome: 'not_applied', reason: 'ended' } },
			history: [
				'input    @lead #a1 pasting 3 characters, "yes", then sending Enter, into @worker #a2\'s terminal',
				'input    @lead #a1 pasting 3 characters, "yes", then sending Enter, into @worker #a2\'s terminal: the text was pasted and Enter was sent'
			]
		});
	});

	test('a start not confirmed in time answers with the last lines its CLI shows then, which say why as often as not (AGENT-ORCHESTRATION.md, O3)', async () => {
		world.timing.startTimeoutMs = 5_000;
		const starting = world.facade.startAgent(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Slow.', folder: work, name: 'slow' });
		await until(() => world.terminals.launched.length === 1);
		shows(1, ['Do you trust this folder?', '> Yes', '  No']);
		await sleep(5_000);
		const started = await settled(starting);

		assert.deepStrictEqual({ status: started.status, screen: started.screen?.text, source: started.screen?.source }, {
			status: 'unconfirmed',
			screen: 'Do you trust this folder?\n> Yes\n  No',
			source: 'normal'
		});
	});

	test('an exit code 130 just after an agent pressed Ctrl+C in a terminal is that agent\'s doing: the person hears of their agent that ended so, and who pressed it; one with no agent\'s Ctrl+C before it is the person\'s own, and nothing is said (L6)', async () => {
		await twoTrees();
		// Its CLI exits as the key goes in, before the call has its answer
		const pressing = settled(world.facade.screens.press(callerOf(world.agent(1)), '@other', ['Ctrl+C']).catch(() => undefined));
		world.terminals.end(terminalOf(4), { exitCode: 130, byThePerson: false });
		await pressing;
		world.terminals.end(terminalOf(3), { exitCode: 130, byThePerson: false });
		await settled(Promise.resolve());

		assert.deepStrictEqual({ told: world.person.told, ends: [3, 4].map(id => world.table.get(id)?.end?.reason) }, {
			told: ['error: @other #a4 exited: its CLI ended with exit code 130, after @lead #a1 sent Ctrl+C to its terminal. (#a4\'s terminal)'],
			ends: ['its CLI ended with exit code 130', 'its CLI ended with exit code 130, after @lead #a1 sent Ctrl+C to its terminal']
		});
	});

	test('the creator of a child that ended is told how it ended as its record says it - after which agent\'s Ctrl+C it exited, and the exit code the window saw of a tab the person closed - and a message it had not fetched goes back saying so (M6, M8; MS-04)', async () => {
		await twoTrees();
		const worker = callerOf(world.agent(2));
		await world.startUp(worker, { cli: 'arg', model: 'm', effort: 'e', task: 'Docs.', name: 'docs' });
		await world.fetched(3);
		await world.fetched(5);
		world.facade.mail.send(worker, ['@helper'], 'Check it.', undefined);
		const pressing = settled(world.facade.screens.press(callerOf(world.agent(4)), '@helper', ['Ctrl+C']).catch(() => undefined));
		world.terminals.end(terminalOf(3), { exitCode: 130, byThePerson: false });
		await pressing;
		world.terminals.end(terminalOf(5), { exitCode: 129, byThePerson: true });
		await sleep(1_000);
		const notices = world.facadeMessagesTo(2).map(text => text.split('\n')[0]);

		assert.deepStrictEqual({ notices, docs: world.table.get(5)?.end?.exitCode }, {
			notices: [
				'#m6 was returned because @helper #a3 ended without fetching it (it exited: its CLI ended with exit code 130, after @other #a4 sent Ctrl+C to its terminal).',
				'@helper #a3 ended: it exited: its CLI ended with exit code 130, after @other #a4 sent Ctrl+C to its terminal. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a3 to find out why.',
				'@docs #a5 ended: stopped by @human: its terminal tab was closed, with CLI exit code 129. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a5 to find out why.'
			],
			docs: 129
		});
	});

	test('the person\'s agents that end unexpectedly together are told in one notification, ended:<batch>, each end as it comes; one that ends later, in one of its own (M11)', async () => {
		await twoTrees();
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Third.', folder: work, name: 'third' });
		world.terminals.end(terminalOf(1), { exitCode: 1, byThePerson: false });
		await sleep(500);
		world.terminals.end(terminalOf(4), { exitCode: 2, byThePerson: false });
		await sleep(3_000);
		world.terminals.end(terminalOf(5), { exitCode: 3, byThePerson: false });
		await settled(Promise.resolve());

		assert.deepStrictEqual([...world.person.endsTold.values()].map(ends => ends.map(end => `#a${end.agent} ${end.severity}`)), [['#a1 error', '#a4 error'], ['#a5 error']]);
	});

	test('a key is named as press_keys takes it: a name in any case, spaced or not, an alias, or one printable character', () => {
		assert.deepStrictEqual(
			['enter', 'ESC', 'ctrl + c', '^z', 'Shift+Tab', 'page up', 'ArrowDown', 'return', ' ', 'y', 'Y', '1', '?', String.fromCharCode(0x4e2d), 'F1', 'ctrl+1', 'yes', '', '\t', '\x1b', String.fromCharCode(0x200b)].map(keyOf),
			['Enter', 'Escape', 'Ctrl+C', 'Ctrl+Z', 'Shift+Tab', 'PageUp', 'Down', 'Enter', 'Space', 'y', 'Y', '1', '?', String.fromCharCode(0x4e2d), undefined, undefined, undefined, undefined, undefined, undefined, undefined]
		);
	});
});

suite('Screens: a last screen in the editor', () => {

	test('a last screen opens in a language of its own, whose color decorators are off: an agent\'s number, as #a27, is drawn as it is, not as a color', () => {
		const { contributes } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

		assert.deepStrictEqual({
			language: (contributes.languages ?? []).some((language: { id: string }) => language.id === SCREEN_LANGUAGE),
			colorDecorators: contributes.configurationDefaults?.[`[${SCREEN_LANGUAGE}]`]?.['editor.colorDecorators']
		}, { language: true, colorDecorators: false });
	});
});
