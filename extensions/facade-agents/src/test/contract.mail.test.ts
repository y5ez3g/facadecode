/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { clockOf } from '../core/mail';
import { Contract } from '../contract/tools';
import { Caller, PERSON } from '../record/events';
import { TEXT_IN_LINE } from '../record/messages';
import { ResultListener } from '../transport/pipe';
import { ToolResult } from '../transport/protocol';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld } from './fakes';
import { tempDir } from './util';

/** What every result of read_messages ends with. */
const PRINT = 'Print the new ones before you act on them, for the person, who watches your screen: one of 500 characters or fewer as it is, with its number and its sender; a longer one as its number, its sender and a sentence or two of what it says.';

suite('Contract: messages', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: ReturnType<typeof fakeWorld>;
	let contract: Contract;
	let lead: Caller;
	let lint: Caller;

	setup(async () => {
		temp = tempDir('facade-contract-mail-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
		contract = new Contract(world.facade);
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'lead', folder: lab });
		lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'lint', task: 'Lint.' });
		lint = callerOf(world.agent(2));
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** A tool call, its result written to its caller's client, or not. */
	async function call(caller: Caller, tool: string, args: unknown, written = true): Promise<ToolResult> {
		const listeners: ResultListener[] = [];
		const result = await contract.call(caller, tool, args, () => undefined, listener => listeners.push(listener));
		for (const listener of listeners) {
			listener(written);
		}
		return result;
	}

	test('the model is given send_message and read_messages, each saying what it does: to whom a message goes, that a reply rings, that nothing is to be waited for; how messages are fetched, and marked', () => {
		const tools = JSON.parse(JSON.stringify(contract.hello(lint).tools)).filter((tool: { name: string }) => tool.name.includes('message'));

		assert.deepStrictEqual(tools.map((tool: { name: string; inputSchema: { properties: object; required?: string[] } }) => [tool.name, Object.keys(tool.inputSchema.properties), tool.inputSchema.required ?? []]), [
			['send_message', ['to', 'text', 'reply_to'], ['to', 'text']],
			['read_messages', ['ids', 'all'], []]
		]);
	});

	test('send_message answers as soon as the messages are recorded, each with its number and recipient - in words that say none is fetched yet and that a reply comes to the mailbox, and as data - a recipient alone in a string too; to the person, that they have a notification, and answer in the caller\'s terminal; one still starting, or one that cannot reply, is said', async () => {
		const one = await call(lead, 'send_message', { to: '@lint', text: 'Lint the docs.' });
		const two = await call(lint, 'send_message', { to: ['@lead #a1', '@human'], text: 'Done.', reply_to: '#m2' });
		// Started with its YOLO off, an agent keeps it so; the next tree the person starts has it on (O1)
		world.switches.yolo = false;
		await world.startUp(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'quiet', task: 'Wait.', folder: lab });
		world.switches.yolo = true;
		const other = callerOf(world.agent((await world.startUp(PERSON, { cli: 'told', model: 'small', effort: 'high', name: 'other', folder: lab })).id));
		const starting = world.facade.startAgent(lead, { cli: 'told', model: 'small', effort: 'high', name: 'slow' });
		await until(() => world.terminals.launched.length === 5);
		const three = await call(other, 'send_message', { to: ['@quiet', '@slow'], text: 'Hello.' });
		world.hello(5);
		await settled(starting);

		assert.deepStrictEqual({ one, two, three }, {
			one: { text: 'Sent #m2 to @lint #a2. It has not been fetched yet.\nA reply will notify you through your mailbox.', data: { messages: [{ id: 2, to: '@lint #a2' }] } },
			two: {
				text: 'Sent #m3 to @lead #a1, #m4 to @human. #m3 has not been fetched yet.\nThe person is told of #m4, and the chat room keeps it: whether they read it, Facade cannot tell. They answer by typing in your terminal.\nA reply will notify you through your mailbox.',
				data: { messages: [{ id: 3, to: '@lead #a1' }, { id: 4, to: '@human' }] }
			},
			three: {
				text: 'Sent #m6 to @quiet #a3, #m7 to @slow #a5. They have not been fetched yet.\n@quiet #a3 has its YOLO off, and you are not in its tree: it can reply to the person only, not to you.\n@slow #a5 is still starting: its doorbell rings once it runs.\nA reply will notify you through your mailbox.',
				data: { messages: [{ id: 6, to: '@quiet #a3', cannotReply: true }, { id: 7, to: '@slow #a5', starting: true }] }
			}
		});
	});

	test('read_messages gives the messages in one result: how many and how many new, then each one\'s heading - number, mark, sender and recipient, time, what it answers, length, whether it was delivered - and its text; it ends asking for the new ones printed, and, where one was given before, for the work to be looked at first', async () => {
		await call(lead, 'send_message', { to: '@lint', text: 'Lint the docs.' });
		await call(lead, 'send_message', { to: '@lint', text: 'And the tests.' });
		const fetched = await call(lint, 'read_messages', {});
		const time = (id: number) => clockOf(world.table.state.mail.messages.get(id)?.time ?? 0);
		const again = await call(lint, 'read_messages', { ids: ['#m2'] });
		const given = world.table.state.mail.entries.get(2)?.given[0] ?? 0;

		assert.deepStrictEqual({ text: fetched.text.split('\n'), again: again.text.split('\n'), none: (await call(lint, 'read_messages', {})).text }, {
			text: [
				'3 messages, 3 new.',
				'',
				`#m1 · new · from @lead #a1 to you · ${time(1)} · task · 5 characters · unread`,
				'Lint.',
				'',
				`#m2 · new · from @lead #a1 to you · ${time(2)} · 14 characters · unread`,
				'Lint the docs.',
				'',
				`#m3 · new · from @lead #a1 to you · ${time(3)} · 14 characters · unread`,
				'And the tests.',
				'',
				PRINT
			],
			again: [
				'1 message, 0 new.',
				'',
				`#m2 · given before (${clockOf(given)}) · from @lead #a1 to you · ${time(2)} · 14 characters · delivered`,
				'Lint the docs.',
				'',
				'A message given before may have been acted on already: look at the work as it is before you do it again.',
				PRINT
			],
			none: 'No unread messages.'
		});
	});

	test('messages that come to more than 8,000 characters are all in one file, whose path the result gives, with each one\'s heading; the whole file is to be read before acting on any of it', async () => {
		await call(lint, 'read_messages', {});
		await call(lead, 'send_message', { to: '@lint', text: 'x'.repeat(TEXT_IN_LINE) });
		await call(lead, 'send_message', { to: '@lint', text: 'Short.' });
		const fetched = await call(lint, 'read_messages', {});
		const file = path.join(temp.dir, 'workspace', 'messages', 'fetch-a2-1.txt');

		assert.deepStrictEqual({ head: fetched.text.split('\n').slice(0, 5), data: JSON.parse(JSON.stringify(fetched.data)).file, file: fs.readFileSync(file, 'utf8').endsWith('\nShort.\n') }, {
			head: [
				`2 messages, 2 new: 8,006 characters, in the file ${file}. All of it is in the file: read the whole file before you act on any of it.`,
				'',
				`#m2 · new · from @lead #a1 to you · ${clockOf(world.table.state.mail.messages.get(2)?.time ?? 0)} · 8,000 characters · unread`,
				`#m3 · new · from @lead #a1 to you · ${clockOf(world.table.state.mail.messages.get(3)?.time ?? 0)} · 6 characters · unread`,
				''
			],
			data: file,
			file: true
		});
	});

	test('a result that did not reach the caller delivers nothing: the next gives the same messages, marked; with all, every message sent to the caller', async () => {
		const lost = await call(lint, 'read_messages', {}, false);
		const again = await call(lint, 'read_messages', {});
		await sleep(10);

		assert.deepStrictEqual({ lost: lost.text.split('\n')[0], again: again.text.split('\n').slice(0, 3).map(line => line.replace(/\d\d:\d\d/g, 'hh:mm')), all: (await call(lint, 'read_messages', { all: true })).text.split('\n')[0] }, {
			lost: '1 message, 1 new.',
			again: ['1 message, 0 new.', '', '#m1 · given before (hh:mm) · from @lead #a1 to you · hh:mm · task · 5 characters · unread'],
			all: '1 message, 0 new.'
		});
	});

	test('what the tools refuse they say, with what would be right: ids and all together, a message\'s number of the wrong kind, a recipient missing or of the wrong kind', async () => {
		const results = [
			await call(lint, 'read_messages', { ids: ['#m1'], all: true }),
			await call(lint, 'read_messages', { ids: ['#a1'] }),
			await call(lint, 'read_messages', { ids: 'nothing' }),
			await call(lint, 'read_messages', { ids: [7] }),
			await call(lint, 'read_messages', { ids: [] }),
			await call(lint, 'read_messages', { unread: true }),
			await call(lead, 'send_message', { text: 'To whom?' }),
			await call(lead, 'send_message', { to: [1], text: 'Hm.' }),
			await call(lead, 'send_message', { to: '@lint', text: 3 })
		].map(result => [result.isError, (result.data as { code: string }).code, result.text]);

		assert.deepStrictEqual({ results, unread: world.table.state.mail.entries.get(1)?.state }, {
			results: [
				[true, 'INVALID', 'Give ids or all, not both: ids fetches messages by number, all every message sent to you.'],
				[true, 'INVALID', '#a1 is an agent, not a message: ids takes a message\'s number, as #m42.'],
				[true, 'INVALID', 'nothing is not a message\'s number: ids takes one as #m42.'],
				[true, 'INVALID', 'ids must be a list of strings.'],
				[true, 'INVALID', 'ids must have one at least, or be left out.'],
				[true, 'INVALID', 'read_messages takes ids?, all?; not unread.'],
				[true, 'INVALID', 'to is required.'],
				[true, 'INVALID', 'to must be a list of strings.'],
				[true, 'INVALID', 'text must be a string.']
			],
			// Nothing was fetched: lint's task is unread still
			unread: 'unread'
		});
	});

	test('with its YOLO off, an agent sees in list_agents its own tree only, every agent with all too', async () => {
		world.switches.yolo = false;
		await world.startUp(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'quiet', folder: lab });
		await world.startUp(callerOf(world.agent(3)), { cli: 'told', model: 'small', effort: 'high', name: 'helper', task: 'Help.' });
		const rows = async (caller: Caller) => (JSON.parse(JSON.stringify((await call(caller, 'list_agents', { all: true })).data)).agents as { id: number }[]).map(row => row.id);

		assert.deepStrictEqual({ quiet: await rows(callerOf(world.agent(3))), lead: await rows(lead) }, {
			quiet: [3, 4],
			lead: [1, 2, 3, 4]
		});
	});
});
