/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { facadeSkill } from '../contract/prompts';
import { screenAfter, screenText } from '../contract/readScreen';
import { Contract } from '../contract/tools';
import { timeOfDay } from '../contract/words';
import { TerminalScreen } from '../core/ports';
import { ScreenRead } from '../core/screens';
import { Caller, PERSON } from '../record/events';
import { finalScreenFile, finalScreenTextFile, screensDir } from '../record/screens';
import { ToolResult } from '../transport/protocol';
import { settled, sleep, useFakeClock } from './clock';
import { callerOf, fakeWorld } from './fakes';
import { tempDir } from './util';

suite('Contract: agents\' screens, typing and keys', () => {

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
		await world.startUp(PERSON, { cli: 'arg', model: 'm', effort: 'e', task: 'Lead.', folder: lab, name: 'lead' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'm', effort: 'e', task: 'Work.', name: 'worker' });
		lead = callerOf(world.agent(1));
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	function call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
		return settled(contract.call(caller, tool, args, () => undefined, () => undefined));
	}

	/** What the worker's terminal shows from now on. */
	function workerShows(lines: readonly string[], screen: Partial<TerminalScreen> = {}): void {
		world.terminals.screens.set(2, {
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

	test('the three tools are offered as the person\'s ways into a terminal: what each takes, and what it is for', () => {
		const tools = JSON.parse(JSON.stringify(contract.hello(lead).tools)) as { name: string; inputSchema: { required: string[]; properties: { [name: string]: unknown } } }[];
		const shape = (name: string) => {
			const tool = tools.find(each => each.name === name);
			return tool && { required: tool.inputSchema.required, properties: tool.inputSchema.properties };
		};

		assert.deepStrictEqual({ read: shape('read_screen'), type: shape('type_text')?.required, keys: shape('press_keys')?.properties.keys }, {
			read: {
				required: ['agent'],
				properties: {
					agent: { type: 'string', description: 'Run ID (#a7) or unique active @name. Use IDs for ended runs. @human has no run.' },
					lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Number of bottom logical lines; wrapped rows count as one. Default 50, maximum 2000.' }
				}
			},
			type: ['agent', 'text'],
			keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: '1-50 keys: Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up/Down/Left/Right, Home, End, PageUp/PageDown, Space, Ctrl+A..Z, or one printable character. Names ignore case and spaces between components. Aliases: Return, Esc, ArrowUp/Down/Left/Right, ^A..Z. A single key may be a string.' }
		});
	});

	test('the person named as the agent of stop_agent, read_screen, type_text or press_keys is refused alike, one code and one reason, by the resolver every tool shares: they exist, and have no run to stop, read or type into (O2; D2; XS-01)', async () => {
		const results = [
			await call(lead, 'stop_agent', { agent: '@human' }),
			await call(lead, 'read_screen', { agent: '@human' }),
			await call(lead, 'type_text', { agent: 'human', text: 'yes' }),
			await call(lead, 'press_keys', { agent: '@Human', keys: ['Enter'] })
		];
		const refused = { text: '@human is the person and has no agent run to stop, read, or type into. Use send_message to contact them.', isError: true, data: { code: 'REFUSED' } };

		assert.deepStrictEqual({ results, typed: world.terminals.typed }, { results: [refused, refused, refused, refused], typed: [] });
	});

	test('a screen comes as lines saying whose, from where and when, and how many of its lines - then the lines as they are', async () => {
		workerShows(['Thinking...', '[[> Proceed]]', '{{Esc to cancel}}'], { older: true });
		const live = await call(lead, 'read_screen', { agent: '#2', lines: 3 });
		workerShows(['bye'], { trimmed: true, exited: true });
		const exited = await call(lead, 'read_screen', { agent: '#2' });
		await settled(world.facade.stopAgent(lead, '#2'));
		keeps(2, { final: { buffer: 'normal', lines: ['bye', '$'] } });
		const ended = await call(lead, 'read_screen', { agent: '#2' });
		const dir = screensDir(world.table.dir);

		assert.deepStrictEqual({ live: live.text, exited: exited.text.split('\nText (')[0], ended: ended.text.replace(/Ended at \d\d:\d\d:\d\d/, 'Ended at TIME') }, {
			live: 'Screen: @worker #a2 (Arg Code); state=running.\nSource: normal; requested=3 lines; selected=3 lines; older=true.\nCaptured: 01:02:03.\nLast terminal output: 01:02:00.\nText ([[...]] marks inverse video; {{...}} marks dim text):\nThinking...\n[[> Proceed]]\n{{Esc to cancel}}',
			exited: 'Screen: @worker #a2 (Arg Code); state=running.\nSource: normal; requested=50 lines; selected=1 line; older=false.\nThe process has exited; its terminal is still open.\nCaptured: 01:02:03.\nLast terminal output: 01:02:00.\nTerminal history trimmed: true.',
			ended: `Screen: @worker #a2 (Arg Code); state=ended.\nSource: final; requested=50 lines; selected=2 lines; older=false.\nEnded at TIME: stopped by #a1: with stop_agent.\nFinal sections (selected/available lines): final 2/2 lines.\nSaved final screen: ${finalScreenTextFile(dir, 2)}.\nText ([[...]] marks inverse video; {{...}} marks dim text):\nbye\n$`
		});
	});

	test('nothing to read says why: no final screen kept, its file not one, or its screens deleted at a fresh start', async () => {
		await settled(world.facade.stopAgent(lead, '#2'));
		const notKept = await call(lead, 'read_screen', { agent: '#2' });
		keeps(2, 'bye');
		const unreadable = await call(lead, 'read_screen', { agent: '#2' });
		world.facade.screens.discard(new Set([2]));
		const discarded = await call(lead, 'read_screen', { agent: '#2' });
		const why = (result: ToolResult) => result.text.split('\n').at(-1);

		assert.deepStrictEqual({ notKept: why(notKept), unreadable: why(unreadable), discarded: why(discarded) }, {
			notKept: 'No final screen was saved. Facade captures it when a terminal or process ends while the window can observe it. A capture may be unavailable if no terminal existed, the window was absent, or the entire window was shutting down.',
			unreadable: 'Could not read the saved screen: the file is not valid JSON.',
			discarded: 'Saved screens for this ended run were removed when a fresh session started.'
		});
	});

	test('a screen\'s lines say each case as it is: no terminal yet, a last screen\'s file that is none, a full-screen frame whose output came minutes ago, a read not timed, a last screen whose final frame is left out, the end of a line too long; an answer whose screen could not be read says why', () => {
		const at = new Date(2026, 9, 8, 1, 2, 3).getTime();
		const ended = { kind: 'exited' as const, reason: 'its CLI ended, with exit code 1', time: at };
		const read: ScreenRead = { id: 2, name: 'worker', cli: 'arg', state: 'running', source: 'normal', requested: 50, selected: 2, older: false, text: 'a\nb', capturedAt: at };
		const facts = [
			screenText({ ...read, state: 'starting', source: 'none', empty: 'not_created', selected: 0, text: '' }, 'Arg Code'),
			screenText({ ...read, state: 'ended', end: ended, source: 'none', empty: 'unreadable', selected: 0, text: '' }, 'Arg Code'),
			screenText({ ...read, source: 'alternate', lastOutput: at - 5 * 60_000 }, 'Arg Code'),
			screenText({ ...read, capturedAt: undefined }, 'Arg Code'),
			screenText({ ...read, state: 'ended', end: ended, source: 'final', finalScreen: 'a2.txt', parts: [{ kind: 'final', lines: 2, of: 2 }, { kind: 'frame', lines: 0, of: 30 }] }, 'Arg Code'),
			screenText({ ...read, state: 'ended', end: ended, source: 'final', finalScreen: 'a2.txt', lastOutput: at - 20 * 60_000, trimmed: true, parts: [{ kind: 'final', lines: 2, of: 2 }] }, 'Arg Code'),
			screenText({ ...read, state: 'ended', end: ended, source: 'final', finalScreen: 'a2.txt', older: true, cut: true, parts: [{ kind: 'final', lines: 2, of: 2 }] }, 'Arg Code'),
			screenText({ ...read, state: 'ended', end: ended, source: 'final', finalScreen: 'a2.txt', selected: 0, text: '', parts: [{ kind: 'final', lines: 0, of: 0 }] }, 'Arg Code'),
			screenText({ ...read, selected: 50, omitted: { lines: 49, chars: 9_000, partialFirstLine: true }, snapshot: 'a2-1.txt', text: 'the end of it' }, 'Arg Code'),
			screenAfter({ id: 2, name: 'worker', effect: { outcome: 'applied', pasted: true, entered: true }, screenUnavailable: 'its terminal was unavailable' }, 'Arg Code')
		].map(text => text.split('\nText (')[0]);
		const time = timeOfDay(at);
		const header = (state: string, source: string, selected: number, older = false) => `Screen: @worker #a2 (Arg Code); state=${state}.\nSource: ${source}; requested=50 lines; selected=${selected} lines; older=${older}.`;
		const end = `Ended at ${time}: exited: its CLI ended, with exit code 1.`;

		assert.deepStrictEqual(facts, [
			`${header('starting', 'none', 0)}\nCaptured: ${time}.\nNo terminal yet; the agent is still starting.`,
			`${header('ended', 'none', 0)}\n${end}\nCaptured: ${time}.\nCould not read the saved screen: the file is not a valid saved screen.`,
			`${header('running', 'alternate', 2)}\nCaptured: ${time}.\nLast terminal output: ${timeOfDay(at - 5 * 60_000)}.`,
			header('running', 'normal', 2),
			`${header('ended', 'final', 2)}\n${end}\nCaptured: ${time}.\nFinal sections (selected/available lines): final 2/2 lines; frame 0/30 lines.\nSaved final screen: a2.txt.`,
			`${header('ended', 'final', 2)}\n${end}\nCaptured: ${time}.\nLast terminal output: ${timeOfDay(at - 20 * 60_000)}.\nTerminal history trimmed: true.\nFinal sections (selected/available lines): final 2/2 lines.\nSaved final screen: a2.txt.`,
			`${header('ended', 'final', 2, true)}\n${end}\nCaptured: ${time}.\nFinal capture truncated: true; limit=2000 logical lines.\nFinal sections (selected/available lines): final 2/2 lines.\nSaved final screen: a2.txt.`,
			`${header('ended', 'final', 0)}\n${end}\nCaptured: ${time}.\nFinal sections (selected/available lines): final 0/0 lines.\nSaved final screen: a2.txt.\nThe saved final screen was blank.`,
			`${header('running', 'normal', 50)}\nCaptured: ${time}.\nComplete selected text: a2-1.txt.\nInline excerpt limit=8000 characters. Omitted 9000 characters across 49 lines; the first displayed line contains only its ending. Read a2-1.txt for the full selected text.`,
			'Input was written to the terminal. Post-input screen unavailable (requested delay 2000 ms; requested 20 lines): its terminal was unavailable'
		]);
	});

	test('an ended agent\'s read past eight thousand characters gives the file of text its final screen is in, one screen line per line, for the lines it leaves out - not the window\'s own file, one line of JSON (D2, D6; DB-01)', async () => {
		await settled(world.facade.stopAgent(lead, '#2'));
		const long = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')} ${'x'.repeat(95)}`);
		keeps(2, { final: { buffer: 'normal', lines: long } });
		const result = await call(lead, 'read_screen', { agent: '#2', lines: 100 });
		const file = finalScreenTextFile(screensDir(world.table.dir), 2);

		assert.deepStrictEqual({ pointsThere: result.text.includes(`Read ${file} for the full selected text.`), lines: fs.readFileSync(file, 'utf8').split('\n') }, {
			pointsThere: true,
			lines: [...long, '']
		});
	});

	test('type_text answers with what it sent as data too - the line as it went, and its count of characters - as its text says them (D4; DB-08)', async () => {
		const text = ' oui, tr\u00e8s bien \u4e2d\u6587 ';
		const result = await call(lead, 'type_text', { agent: '#2', text, enter: true });
		const data = result.data as { readonly text?: string; readonly chars?: number };

		assert.deepStrictEqual({ text: data.text, chars: data.chars, said: result.text.split('.')[0] }, {
			text,
			chars: 19,
			said: 'Pasted 19 characters into @worker #a2\'s terminal and sent Enter'
		});
	});

	test('the skill teaches a creator to answer the question or menu its child\'s CLI puts up with these tools, never sending the person to its buttons; and that a menu that swallowed a doorbell is answered, the message neither sent again nor its task started again (AGENT-DEBUGGING.md, D7; DB-09)', () => {
		const screens = facadeSkill().body.split('## Inspect and answer a CLI')[1].split('\n## ')[0].replace(/\s+/g, ' ');

		assert.deepStrictEqual({
			answers: screens.includes('Answer your child\'s CLI menus and approval prompts from the task context rather than asking the person to click its buttons.'),
			doorbell: screens.includes('If a menu consumed a doorbell, answer the menu: the original message remains unread and the doorbell will retry. Do not resend the task or start another child.')
		}, { answers: true, doorbell: true });
	});

	test('an answer to typing or to keys has the bottom 20 lines of the screen two seconds on', async () => {
		workerShows(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
		const typed = await call(lead, 'type_text', { agent: '#2', text: 'go' });
		const pressed = await call(lead, 'press_keys', { agent: '#2', keys: ['Enter'] });
		const bottom = (result: ToolResult) => result.text.split('\n').filter(line => line.startsWith('line '));
		const last20 = Array.from({ length: 20 }, (_, i) => `line ${i + 11}`);

		assert.deepStrictEqual({ typed: bottom(typed), pressed: bottom(pressed) }, { typed: last20, pressed: last20 });
	});

	test('lines is a whole number from 1 to 2000: anything else is refused, and nothing is read', async () => {
		workerShows(['one', 'two']);
		const texts = await Promise.all([0, 2001, 1.5, '50', -1].map(async lines => (await call(lead, 'read_screen', { agent: '#2', lines })).text));
		const bounds = await Promise.all([1, 2000].map(async lines => (await call(lead, 'read_screen', { agent: '#2', lines })).data as { requested: number; selected: number }));

		assert.deepStrictEqual({ texts, bounds: bounds.map(read => [read.requested, read.selected]) }, {
			texts: Array(5).fill('Argument \'lines\' must be an integer between 1 and 2000.'),
			bounds: [[1, 1], [2000, 2]]
		});
	});

	test('text typed is one line of plain text, up to two thousand characters, kept as it is: anything else is refused whole, and nothing is typed', async () => {
		const refusals = await Promise.all([
			{ agent: '#2', text: 'two\nlines' },
			{ agent: '#2', text: 'tab\there' },
			{ agent: '#2', text: '\x1b[A' },
			{ agent: '#2', text: `line${String.fromCharCode(0x2028)}separator` },
			{ agent: '#2', text: 'x'.repeat(2_001) },
			{ agent: '#2', text: '' },
			{ agent: '#2' },
			{ agent: '#2', text: 5 },
			{ agent: '#2', text: 'ok', enter: 'yes' },
			{ agent: '#2', text: 'ok', lines: 3 }
		].map(async args => (await call(lead, 'type_text', args)).text));
		const typed = await call(lead, 'type_text', { agent: '#2', text: `  ${String.fromCharCode(0x4e2d)} kept as is  `, enter: true });

		assert.deepStrictEqual({ refusals, typed: typed.text.replace(/Captured: \d\d:\d\d:\d\d/, 'Captured: TIME'), terminal: world.terminals.typed.filter(line => line.startsWith('@worker')) }, {
			refusals: [
				...Array(4).fill('Argument \'text\' must be one line with no control characters. Use press_keys for Enter, Escape, Tab, or other keys. No text was pasted.'),
				'Argument \'text\' contains 2001 Unicode code points; the limit is 2000. Put longer content in a file and type its path. No text was pasted.',
				'Argument \'text\' must not be empty.',
				'Argument \'text\' is required.',
				'Argument \'text\' must be a string.',
				'Argument \'enter\' must be a boolean.',
				'Unknown arguments for type_text: lines. Accepted arguments (? = optional): agent, text, enter?.'
			],
			typed: 'Pasted 16 characters into @worker #a2\'s terminal and sent Enter.\nPost-input screen (requested delay 2000 ms; requested 20 lines):\nScreen: @worker #a2 (Arg Code); state=running.\nSource: normal; requested=20 lines; selected=0 lines; older=false.\nCaptured: TIME.\nThe terminal has no text yet.',
			terminal: [`@worker #a2: type ${JSON.stringify(`  ${String.fromCharCode(0x4e2d)} kept as is  `)}, Enter after 300 ms, waiting 120000 ms at most`]
		});
	});

	test('one character typed and one key pressed are said as one, in the answer and in the log', async () => {
		const typed = await call(lead, 'type_text', { agent: '#2', text: 'y' });
		await call(lead, 'press_keys', { agent: '#2', keys: ['Enter'] });

		assert.deepStrictEqual({ typed: typed.text.split('\n')[0], logs: world.logs.filter(line => line.includes('@worker #a2\'s terminal')) }, {
			typed: 'Pasted 1 character into @worker #a2\'s terminal without Enter.',
			logs: [
				'@lead #a1 pasting 1 character, "y" into @worker #a2\'s terminal.',
				'@lead #a1 pasting 1 character, "y" into @worker #a2\'s terminal: the text was pasted without Enter.',
				'@lead #a1 sending keys Enter to @worker #a2\'s terminal.',
				'@lead #a1 sending keys Enter to @worker #a2\'s terminal: the key was sent.'
			]
		});
	});

	test('keys are named as the person knows them, in any case, an alias or one character; one press_keys does not know refuses them all, and nothing is pressed', async () => {
		const pressed = await call(lead, 'press_keys', { agent: '#2', keys: ['down', 'Ctrl + C', '^a', 'Esc', ' ', 'y'] });
		const refused = await call(lead, 'press_keys', { agent: '#2', keys: ['Down', 'F5', 'Ctrl+Alt+Del'] });
		const none = await call(lead, 'press_keys', { agent: '#2', keys: [] });
		const tooMany = await call(lead, 'press_keys', { agent: '#2', keys: Array(51).fill('Down') });

		assert.deepStrictEqual({ pressed: pressed.text.split('\n')[0], data: (pressed.data as { keys: string[] }).keys, refused: refused.text, none: none.text, tooMany: tooMany.text, terminal: world.terminals.typed.filter(line => line.startsWith('@worker')) }, {
			pressed: 'Sent keys Down, Ctrl+C, Ctrl+A, Escape, Space, y to @worker #a2\'s terminal.',
			data: ['Down', 'Ctrl+C', 'Ctrl+A', 'Escape', 'Space', 'y'],
			refused: 'Unknown keys: "F5", "Ctrl+Alt+Del". No keys were sent. Supported keys: Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, Ctrl+A through Ctrl+Z, or one printable character such as y or 1. Key names are case-insensitive and allow spaces between components. Aliases: Return, Esc, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, and ^A through ^Z. Use type_text to paste text.',
			none: 'Argument \'keys\' has 0 entries; provide 1-50 keys. No keys were sent.',
			tooMany: 'Argument \'keys\' has 51 entries; provide 1-50 keys. No keys were sent.',
			terminal: ['@worker #a2: keys Down Ctrl+C Ctrl+A Escape Space y, waiting 120000 ms at most']
		});
	});

	test('keys given as one string, not a list, are a list of one, as every list argument of the tools: that key is pressed; one that names no key presses nothing', async () => {
		const one = await call(lead, 'press_keys', { agent: '#2', keys: 'Enter' });
		const unknown = await call(lead, 'press_keys', { agent: '#2', keys: 'abc' });

		assert.deepStrictEqual({ one: one.text.split('\n')[0], unknown: [unknown.isError, (unknown.data as { code: string }).code], terminal: world.terminals.typed.filter(line => line.startsWith('@worker')) }, {
			one: 'Sent keys Enter to @worker #a2\'s terminal.',
			unknown: [true, 'INVALID'],
			terminal: ['@worker #a2: keys Enter, waiting 120000 ms at most']
		});
	});

	test('a call that waits its turn long - behind the person\'s typing - tells its caller\'s client every 30 seconds that it is still going, so that the client does not take the window as gone and the call as done who knows what (D3)', async () => {
		let typed = () => { };
		world.terminals.typing = new Promise<void>(resolve => typed = resolve);
		const progress: string[] = [];
		const typing = contract.call(lead, 'type_text', { agent: '#2', text: 'go' }, message => progress.push(message), () => undefined);
		await sleep(65_000);
		typed();
		const result = await settled(typing);
		await sleep(65_000);

		assert.deepStrictEqual({ progress, typed: result.isError ?? false }, { progress: ['type_text is still running.', 'type_text is still running.'], typed: false });
	});

	test('a call that failed partway says what went in, beside its code, in its data', async () => {
		world.terminals.nextInput.push({ outcome: 'partial', reason: 'ended', pasted: true, entered: false });
		const result = await call(lead, 'type_text', { agent: '#2', text: 'yes', enter: true });

		assert.deepStrictEqual(result, {
			text: '@worker #a2\'s terminal ended during input: the text was pasted without Enter.',
			isError: true,
			data: { outcome: 'partial', reason: 'ended', pasted: true, entered: false, code: 'FAILED' }
		});
	});
});
