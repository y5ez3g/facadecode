/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Contract } from '../contract/tools';
import { TerminalScreen } from '../core/ports';
import { Caller, PERSON } from '../record/events';
import { finalScreenFile, screensDir } from '../record/screens';
import { ToolResult } from '../transport/protocol';
import { settled, useFakeClock } from './clock';
import { callerOf, fakeWorld } from './fakes';
import { tempDir } from './util';

suite('Contract: agents\' screens', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: ReturnType<typeof fakeWorld>;
	let contract: Contract;
	let lead: Caller;

	setup(async () => {
		temp = tempDir('facade-screens-contract-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
		contract = new Contract(world.facade);
		await world.spawnUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', prompt: 'Lead.', folder: lab, name: 'lead' });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'm', effort: 'e', prompt: 'Work.', name: 'worker' });
		lead = callerOf(world.agent(1));
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	function call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
		return settled(contract.call(caller, tool, args, () => undefined));
	}

	/** What the worker's terminal shows from now on. */
	function workerShows(lines: readonly string[], screen: Partial<TerminalScreen> = {}): void {
		world.terminals.screens.set('@worker #2 · Arg Code', {
			lines,
			buffer: 'normal',
			older: false,
			trimmed: false,
			capturedAt: new Date(2026, 9, 8, 1, 2, 3).getTime(),
			lastOutput: new Date(2026, 9, 8, 1, 2, 0).getTime(),
			exited: false,
			...screen
		});
	}

	/** Writes the final screen of agent `id` as the window writes it, or `text` in its place. */
	function keeps(id: number, screen: object | string): void {
		const dir = screensDir(world.table.dir);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(finalScreenFile(dir, id), typeof screen === 'string' ? screen : JSON.stringify(screen));
	}

	test('read_screen is offered as the person\'s way of looking at a terminal: what it takes', () => {
		const tools = JSON.parse(JSON.stringify(contract.hello(lead).tools)) as { name: string; inputSchema: { required: string[]; properties: { [name: string]: unknown } } }[];
		const read = tools.find(each => each.name === 'read_screen');

		assert.deepStrictEqual(read && { required: read.inputSchema.required, properties: read.inputSchema.properties }, {
			required: ['agent'],
			properties: {
				agent: { type: 'string', description: 'The agent: its number, as #7, or its @name, where only one running agent has it. One that ended, by its number.' },
				lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'How many of its bottom lines: 50 unless given, 2000 at most. A line the terminal wraps over several rows counts as one.' }
			}
		});
	});

	test('a screen comes as a line saying whose, from where and when, and how many of its lines - then the lines as they are', async () => {
		workerShows(['Thinking...', '[[> Proceed]]', '{{Esc to cancel}}'], { older: true });
		const live = await call(lead, 'read_screen', { agent: '#2', lines: 3 });
		workerShows(['bye'], { trimmed: true, exited: true });
		const exited = await call(lead, 'read_screen', { agent: '#2' });
		await settled(world.facade.kill(lead, '#2'));
		keeps(2, { final: { buffer: 'normal', lines: ['bye', '$'] } });
		const ended = await call(lead, 'read_screen', { agent: '#2' });
		const dir = screensDir(world.table.dir);

		assert.deepStrictEqual({ live: live.text, exited: exited.text.split(' The lines')[0], ended: ended.text.replace(/ended at \d\d:\d\d:\d\d/, 'ended at TIME') }, {
			live: '@worker #2 (Arg Code), running. Its screen at 01:02:03, which last showed new output 3 seconds ago: its bottom 3 lines, with older lines above them. The lines, as they are - [[...]] marks inverse video, {{...}} dim text:\nThinking...\n[[> Proceed]]\n{{Esc to cancel}}',
			exited: '@worker #2 (Arg Code), running, its process ended - its terminal still open. Its screen at 01:02:03, which last showed new output 3 seconds ago: all 1 line it has - its terminal let go of older lines past what it keeps.',
			ended: `@worker #2 (Arg Code), ended at TIME (killed: killed by @lead #1). Its last screen, kept as its terminal ended: all 2 lines of it. All of it is in ${finalScreenFile(dir, 2)}. The lines, as they are - [[...]] marks inverse video, {{...}} dim text:\nbye\n$`
		});
	});

	test('nothing to read says why: no final screen kept, its file not one, or its screens deleted at a fresh start', async () => {
		await settled(world.facade.kill(lead, '#2'));
		const notKept = await call(lead, 'read_screen', { agent: '#2' });
		keeps(2, 'bye');
		const unreadable = await call(lead, 'read_screen', { agent: '#2' });
		world.facade.screens.discard(new Set([2]));
		const discarded = await call(lead, 'read_screen', { agent: '#2' });
		const why = (result: ToolResult) => result.text.split('Nothing to read: ')[1];

		assert.deepStrictEqual({ notKept: why(notKept), unreadable: why(unreadable), discarded: why(discarded) }, {
			notKept: 'no final screen was kept of it. The window keeps one as an agent\'s terminal closes or its process ends - not of an agent that ended before its terminal was made, nor while no window was there, nor as the whole window closed.',
			unreadable: 'the file of its last screen could not be read: it is not JSON.',
			discarded: 'its screens were deleted when Facade started afresh, with those of every agent that had ended before.'
		});
	});

	test('lines is a whole number from 1 to 2000: anything else is refused, and nothing is read', async () => {
		workerShows(['one', 'two']);
		const texts = await Promise.all([0, 2001, 1.5, '50', -1].map(async lines => (await call(lead, 'read_screen', { agent: '#2', lines })).text));
		const bounds = await Promise.all([1, 2000].map(async lines => (await call(lead, 'read_screen', { agent: '#2', lines })).data as { requested: number; selected: number }));

		assert.deepStrictEqual({ texts, bounds: bounds.map(read => [read.requested, read.selected]) }, {
			texts: Array(5).fill('lines must be a whole number from 1 to 2000.'),
			bounds: [[1, 1], [2000, 2]]
		});
	});
});
