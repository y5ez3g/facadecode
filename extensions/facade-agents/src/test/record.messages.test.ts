/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { messageOf } from '../base/errors';
import { AgentTable, NewAgent } from '../record/agents';
import { FACADE, HUMAN, TEXT_IN_LINE } from '../record/messages';
import { ChatRooms } from '../record/rooms';
import { tempDir } from './util';

const LEDGER = 'ledger.jsonl';

/** An agent the person starts, or the agent `creator` does. */
function newAgent(name: string, creator?: number): NewAgent {
	return { name, creator, cli: 'arg', custom: false, model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', integration: true, worktree: 'main', folder: '/lab' };
}

/** What a call came to: `done`, or the message of what it threw. */
function outcome(call: () => unknown): string {
	try {
		call();
		return 'done';
	} catch (err) {
		return messageOf(err);
	}
}

/** A time as a chat room writes it. */
function stamp(time: number): string {
	const date = new Date(time);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** The ledger's lines, each its type and the fields a test looks at. */
function lines(dir: string): string[] {
	return fs.readFileSync(path.join(dir, LEDGER), 'utf8').split('\n').filter(Boolean).map(line => {
		const { v, type, id, agent, ids, upTo } = JSON.parse(line);
		return [`v${v}`, type, id, agent, ids?.join(','), upTo].filter(each => each !== undefined).join(' ');
	});
}

suite('Record: messages', () => {

	let temp: { dir: string; remove(): void };
	let table: AgentTable;

	setup(() => {
		temp = tempDir('facade-messages-');
		table = AgentTable.open({ dir: temp.dir });
	});

	teardown(() => {
		table.dispose();
		temp.remove();
	});

	test('a message gets the next number, never one given before: numbers count up from 1, past a ledger begun anew, which last-message keeps', () => {
		const lead = table.start(newAgent('lead')).agent;
		const first = table.messages.send({ to: lead.id, text: 'One.' }).id;
		const second = table.messages.send({ from: lead.id, to: HUMAN, text: 'Two.' }).id;
		table.dispose();
		fs.renameSync(path.join(temp.dir, LEDGER), path.join(temp.dir, 'ledger.aside.jsonl'));
		table = AgentTable.open({ dir: temp.dir });
		const again = table.start(newAgent('again')).agent;

		assert.deepStrictEqual({ first, second, afresh: table.messages.send({ to: again.id, text: 'Three.' }).id, file: fs.readFileSync(path.join(temp.dir, 'last-message'), 'utf8') }, {
			first: 1,
			second: 2,
			afresh: 3,
			file: '3'
		});
	});

	test('a text of 8,000 characters or fewer is in its ledger line; a longer one is in a file of its own, readable by the user only, and the line holds its length', () => {
		const lead = table.start(newAgent('lead')).agent;
		const short = table.messages.send({ to: lead.id, text: 'x'.repeat(TEXT_IN_LINE) });
		const long = table.messages.send({ to: lead.id, text: 'y'.repeat(TEXT_IN_LINE + 1) });
		const line = JSON.parse(fs.readFileSync(path.join(temp.dir, LEDGER), 'utf8').split('\n').filter(Boolean).pop() ?? '{}');
		const file = path.join(table.messages.folder, 'm2.txt');

		assert.deepStrictEqual({
			short: [short.text?.length, short.file, table.messages.textOf(short)?.length],
			long: [long.text, long.file, long.length, table.messages.textOf(long)?.length],
			line: [line.text, line.file, line.length],
			mode: process.platform === 'win32' || (fs.statSync(file).mode & 0o777) === 0o600
		}, {
			short: [TEXT_IN_LINE, undefined, TEXT_IN_LINE],
			long: [undefined, 'm2.txt', TEXT_IN_LINE + 1, TEXT_IN_LINE + 1],
			line: [undefined, 'm2.txt', TEXT_IN_LINE + 1],
			mode: true
		});
	});

	test('a message is unread until a result with it is delivered; one whose result did not reach the pipe stays unread; one to the person is delivered as it is recorded; one gone back is returned', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const delivered = table.messages.send({ from: lead.id, to: lint.id, text: 'Lint it.' });
		const lost = table.messages.send({ from: lead.id, to: lint.id, text: 'And the docs.' });
		const back = table.messages.send({ from: lead.id, to: lint.id, text: 'Never read.' });
		const toPerson = table.messages.send({ from: lint.id, to: HUMAN, text: 'Done.' });
		table.messages.delivered(lint.id, [delivered.id]);
		table.messages.returned(back.id, 'it exited');
		const { entries, fetchedAt } = table.state.mail;

		assert.deepStrictEqual({
			states: [delivered, lost, back, toPerson].map(message => entries.get(message.id)?.state),
			fetched: fetchedAt.has(lint.id),
			returns: [...table.state.mail.returns.entries()].map(([id, returned]) => [id, returned.reason, returned.as])
		}, {
			states: ['delivered', 'unread', 'returned', 'delivered'],
			fetched: true,
			returns: [[3, 'it exited', undefined]]
		});
	});

	test('a result with another\'s message, fetched by its number, does not deliver it: it stays unread for its recipient, and the fetcher has fetched none of its own', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const toLead = table.messages.send({ from: lint.id, to: lead.id, text: 'Done.' });
		table.messages.delivered(lint.id, [toLead.id]);
		const { entries, fetchedAt } = table.state.mail;

		assert.deepStrictEqual({ state: entries.get(toLead.id)?.state, fetched: fetchedAt.has(lint.id) }, {
			state: 'unread',
			fetched: false
		});
	});

	test('Facade keeps no history of who was given which message (M4): a ledger whose earlier Facade wrote message.given loads, the line changing nothing, and none is written now', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const one = table.messages.send({ from: lead.id, to: lint.id, text: 'One.' });
		const before = structuredClone(table.state.mail);
		table.dispose();
		// As a Facade before M4 dropped the marks wrote it, as a result went out
		const file = path.join(temp.dir, LEDGER);
		const seq = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop() ?? '{}').seq;
		fs.appendFileSync(file, `${JSON.stringify({ v: 6, seq: seq + 1, time: 1, type: 'message.given', agent: lint.id, ids: [one.id] })}\n`);
		table = AgentTable.open({ dir: temp.dir });
		const read = structuredClone(table.state.mail);
		table.messages.delivered(lint.id, [one.id]);

		assert.deepStrictEqual({
			read,
			written: lines(temp.dir).filter(line => line.includes(' message.'))
		}, {
			read: before,
			written: [`v6 message.sent ${one.id}`, `v6 message.given ${lint.id} ${one.id}`, `v6 message.delivered ${lint.id} ${one.id}`]
		});
	});

	test('what does not fit the messages before it is not recorded: a task from another than the creator, or a second; a doorbell naming another\'s message; a message gone back twice; one taken back by a message that does not take messages back', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const other = table.start(newAgent('other')).agent;
		const docs = table.start(newAgent('docs', lead.id)).agent;
		const task = table.messages.send({ from: lead.id, to: lint.id, text: 'Lint.', task: true });
		const toLead = table.messages.send({ to: lead.id, text: 'Lead.' });
		const refused = (call: () => unknown) => outcome(call).replace(/^Facade did not record (\S+): .*$/, 'refused $1');
		const results = [
			refused(() => table.messages.send({ from: other.id, to: docs.id, text: 'Mine.', task: true })),
			refused(() => table.messages.send({ from: lead.id, to: lint.id, text: 'Again.', task: true })),
			refused(() => table.messages.rang(lint.id, [toLead.id])),
			refused(() => table.messages.returned(task.id, 'it exited', { as: toLead.id }))
		];
		table.messages.returned(task.id, 'it exited');
		results.push(refused(() => table.messages.returned(task.id, 'it exited')));

		assert.deepStrictEqual({ results, task: table.state.mail.tasks.get(lint.id) }, {
			results: ['refused message.sent', 'refused message.sent', 'refused mailbox.rang', 'refused message.returned', 'refused message.returned'],
			task: task.id
		});
	});

	test('a doorbell counts for each message it named, and is the agent\'s last; Facade\'s message that a task was not fetched is remembered, once', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const task = table.messages.send({ from: lead.id, to: lint.id, text: 'Lint.', task: true });
		const more = table.messages.send({ from: lead.id, to: lint.id, text: 'More.' });
		table.messages.rang(lint.id, [task.id]);
		table.messages.rang(lint.id, [task.id, more.id]);
		table.messages.send({ from: FACADE, to: lead.id, text: '@lint #a2 has not fetched its task #m1.', facade: 'taskNotFetched', about: lint.id });

		assert.deepStrictEqual({
			rings: [task.id, more.id].map(id => table.state.mail.entries.get(id)?.rings),
			rung: table.state.mail.rungAt.has(lint.id),
			notFetched: [...table.state.mail.notFetched]
		}, {
			rings: [2, 1],
			rung: true,
			notFetched: [lint.id]
		});
	});

	test('a reload loses nothing of the messages: the mailboxes, what was delivered and when, the doorbells, the returns, the tasks', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const task = table.messages.send({ from: lead.id, to: lint.id, text: 'Lint.', task: true });
		const long = table.messages.send({ from: lint.id, to: lead.id, text: 'z'.repeat(TEXT_IN_LINE + 5), replyTo: task.id });
		table.messages.rang(lint.id, [task.id]);
		table.messages.delivered(lint.id, [task.id]);
		table.messages.returned(long.id, 'stopped by @human');
		const before = structuredClone(table.state.mail);
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual(table.state.mail, before);
	});

	test('the list cleared, as a window starts that is not a reload, empties the person\'s mailbox and those of the agents that ended; one still running keeps its own; numbers go on', () => {
		const lead = table.start(newAgent('lead')).agent;
		const gone = table.start(newAgent('gone', lead.id)).agent;
		const toLead = table.messages.send({ to: lead.id, text: 'Keep.' });
		const toGone = table.messages.send({ from: lead.id, to: gone.id, text: 'Gone.' });
		const toPerson = table.messages.send({ from: lead.id, to: HUMAN, text: 'Hi.' });
		table.end(gone.id, 'stopped', 'the person closed its window');
		table.clearList();
		const { entries, mailboxes, messages } = table.state.mail;

		assert.deepStrictEqual({
			kept: [toLead, toGone, toPerson].map(message => entries.has(message.id)),
			mailboxes: [...mailboxes.keys()],
			stillKnown: messages.size,
			next: table.messages.send({ to: lead.id, text: 'Next.' }).id,
			types: lines(temp.dir).slice(-2)
		}, {
			kept: [true, false, false],
			mailboxes: [lead.id],
			stillKnown: 3,
			next: 4,
			types: ['v6 list.cleared', 'v6 message.sent 4']
		});
	});

	test('the files of fetches too long for a result are numbered by recipient; the files of long texts go but those kept, and leave the fetches\'; the files of fetches go but those of the agents kept, the person\'s too', () => {
		const lead = table.start(newAgent('lead')).agent;
		const keep = table.messages.send({ to: lead.id, text: 'k'.repeat(TEXT_IN_LINE + 1) });
		table.messages.send({ to: lead.id, text: 'd'.repeat(TEXT_IN_LINE + 1) });
		const fetches = [table.messages.writeFetch(lead.id, 'One.'), table.messages.writeFetch(lead.id, 'Two.'), table.messages.writeFetch(HUMAN, 'Three.'), table.messages.writeFetch(5, 'Four.')].map(file => path.basename(file));
		table.messages.deleteTexts(id => id === keep.id);
		const texts = fs.readdirSync(table.messages.folder).sort();
		table.messages.deleteFetches(agent => agent === lead.id);

		assert.deepStrictEqual({ fetches, texts, left: fs.readdirSync(table.messages.folder).sort() }, {
			fetches: ['fetch-a1-1.txt', 'fetch-a1-2.txt', 'fetch-human-1.txt', 'fetch-a5-1.txt'],
			texts: ['fetch-a1-1.txt', 'fetch-a1-2.txt', 'fetch-a5-1.txt', 'fetch-human-1.txt', 'm1.txt'],
			left: ['fetch-a1-1.txt', 'fetch-a1-2.txt', 'm1.txt']
		});
	});

	test('a mailbox is emptied when a result delivered to it leaves nothing of its own unread, another\'s message in it or not; Facade\'s telling that an agent\'s messages wait unfetched is remembered by that agent; both through a reload', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const one = table.messages.send({ from: lead.id, to: lint.id, text: 'One.' });
		const two = table.messages.send({ from: lead.id, to: lint.id, text: 'Two.' });
		const toLead = table.messages.send({ from: lint.id, to: lead.id, text: 'Done.' });
		table.messages.delivered(lint.id, [one.id]);
		const partly = table.state.mail.drainedAt.has(lint.id);
		table.messages.delivered(lint.id, [two.id, toLead.id]);
		const emptied = table.state.mail.drainedAt.get(lint.id);
		table.messages.send({ from: FACADE, to: lead.id, text: '@lint #a2 has not fetched #m1 in 2 minutes.', facade: 'delayed', about: lint.id });
		const delayed = table.state.mail.delayedAt.get(lint.id);
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual({ partly, emptied: emptied !== undefined, lead: table.state.mail.drainedAt.has(lead.id), back: [table.state.mail.drainedAt.get(lint.id), table.state.mail.delayedAt.get(lint.id)] }, {
			partly: false,
			emptied: true,
			lead: false,
			back: [emptied, delayed]
		});
	});
});

suite('Record: chat rooms', () => {

	let temp: { dir: string; remove(): void };
	let table: AgentTable;
	let rooms: ChatRooms;

	setup(() => {
		temp = tempDir('facade-rooms-');
		table = AgentTable.open({ dir: temp.dir });
		rooms = new ChatRooms(temp.dir, () => table.state, table.messages);
	});

	teardown(() => {
		table.dispose();
		temp.remove();
	});

	/** Sends a message, and puts it into its rooms as the core does. */
	function send(message: Parameters<AgentTable['messages']['send']>[0]): number {
		const sent = table.messages.send(message);
		rooms.append(sent.id);
		return sent.id;
	}

	/** A room's text, by the file name of its tree's agent. */
	function room(name: string): string {
		return fs.readFileSync(path.join(rooms.folder, name), 'utf8');
	}

	/** A message's heading and text, as its room writes it. */
	function entry(id: number, who: string, text: string): string {
		return `## #m${id} · ${stamp(table.state.mail.messages.get(id)?.time ?? 0)} · ${who}\n${text}\n\n`;
	}

	test('one room for each agent the person started: every message to or from its tree, whole, under a heading - number, time, sender and recipient, what it answers, a task; a message between two trees is in both; Facade\'s about an agent is in that agent\'s tree too', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const docs = table.start(newAgent('docs')).agent;
		const task = send({ from: lead.id, to: lint.id, text: 'Lint the docs.', task: true });
		const long = send({ from: lint.id, to: lead.id, text: 'w'.repeat(TEXT_IN_LINE + 2), replyTo: task });
		const across = send({ from: lint.id, to: docs.id, text: 'Which file?' });
		const toPerson = send({ from: docs.id, to: HUMAN, text: 'Done:\nsee docs/.' });
		const ended = send({ from: FACADE, to: lead.id, text: '@docs #a3 ended: it exited, with exit code 1.', facade: 'ended', about: docs.id });
		const heading = (root: string) => `# Chat room of ${root}\n\nEvery message to or from ${root} and the agents started from it, in order.\n\n`;

		assert.deepStrictEqual({ lead: room('lead-a1.md'), docs: room('docs-a3.md'), files: fs.readdirSync(rooms.folder).sort() }, {
			lead: heading('@lead #a1')
				+ entry(task, '@lead #a1 → @lint #a2 · task', 'Lint the docs.')
				+ entry(long, '@lint #a2 → @lead #a1 · re #m1', 'w'.repeat(TEXT_IN_LINE + 2))
				+ entry(across, '@lint #a2 → @docs #a3', 'Which file?')
				+ entry(ended, 'Facade → @lead #a1', '@docs #a3 ended: it exited, with exit code 1.'),
			docs: heading('@docs #a3')
				+ entry(across, '@lint #a2 → @docs #a3', 'Which file?')
				+ entry(toPerson, '@docs #a3 → @human', 'Done:\nsee docs/.')
				+ entry(ended, 'Facade → @lead #a1', '@docs #a3 ended: it exited, with exit code 1.'),
			files: ['docs-a3.md', 'lead-a1.md']
		});
	});

	test('a message that could not go back gets a line in its rooms: its sender had ended, or it was Facade\'s own', () => {
		const lead = table.start(newAgent('lead')).agent;
		const lint = table.start(newAgent('lint', lead.id)).agent;
		const lost = send({ from: lead.id, to: lint.id, text: 'Lint.' });
		const own = send({ from: FACADE, to: lint.id, text: 'Facade says.', facade: 'ended', about: lead.id });
		table.end(lead.id, 'exited', 'its CLI ended');
		table.end(lint.id, 'stopped', 'killed by the person');
		for (const id of [lost, own]) {
			table.messages.returned(id, 'stopped by @human');
			rooms.noteUnreturned(id);
		}
		const text = room('lead-a1.md');

		assert.deepStrictEqual(text.split('\n').filter(line => line.startsWith('>')), [
			'> #m1 was not fetched by @lint #a2 before it ended (stopped by @human). It could not be returned: @lead #a1, its sender, had ended.',
			'> #m2 was not fetched by @lint #a2 before it ended (stopped by @human). It could not be returned: Facade\'s own messages are not returned.'
		]);
	});

	test('a room missing, or shorter than the ledger says, is written again from it as the window loads; one longer - the person wrote in it - is left as it is', () => {
		const lead = table.start(newAgent('lead')).agent;
		const docs = table.start(newAgent('docs')).agent;
		send({ to: lead.id, text: 'Lead.' });
		send({ to: docs.id, text: 'Docs.' });
		const tests = table.start(newAgent('tests')).agent;
		send({ to: tests.id, text: 'Tests.' });
		const whole = room('lead-a1.md');
		const wholeTests = room('tests-a3.md');
		fs.rmSync(path.join(rooms.folder, 'lead-a1.md'));
		fs.writeFileSync(path.join(rooms.folder, 'tests-a3.md'), wholeTests.slice(0, -5));
		fs.appendFileSync(path.join(rooms.folder, 'docs-a2.md'), 'A note of the person\'s.\n');
		const longer = room('docs-a2.md');
		rooms.restore();

		assert.deepStrictEqual({ lead: room('lead-a1.md') === whole, tests: room('tests-a3.md') === wholeTests, docs: room('docs-a2.md') === longer }, { lead: true, tests: true, docs: true });
	});

	test('rooms deleted are gone for good: none is written again from the ledger for a message up to then; later messages begin them anew', () => {
		const lead = table.start(newAgent('lead')).agent;
		send({ to: lead.id, text: 'Before.' });
		table.messages.roomsDeleted();
		rooms.delete();
		rooms.restore();
		const afterDelete = fs.existsSync(rooms.folder);
		const later = send({ to: lead.id, text: 'After.' });
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });
		fs.rmSync(rooms.folder, { recursive: true });
		rooms.restore();

		assert.deepStrictEqual({ afterDelete, rebuilt: room('lead-a1.md').split('\n').filter(line => line.startsWith('## ')).map(line => line.split(' · ')[0]), later }, {
			afterDelete: false,
			rebuilt: ['## #m2'],
			later: 2
		});
	});

	test('Open Chat Room lists the rooms, the one with the latest message first, with how many messages each has; a message is shown in the room of its recipient\'s tree, one to the person in its sender\'s', () => {
		const lead = table.start(newAgent('lead')).agent;
		const docs = table.start(newAgent('docs')).agent;
		send({ to: lead.id, text: 'One.' });
		send({ to: lead.id, text: 'Two.' });
		const across = send({ from: lead.id, to: docs.id, text: 'Three.' });
		const toPerson = send({ from: lead.id, to: HUMAN, text: 'Four.' });
		const shown = (id: number) => path.basename(rooms.roomOf(table.state.mail.messages.get(id) ?? { id, to: HUMAN, length: 1, time: 0 }) ?? '');

		assert.deepStrictEqual({ list: rooms.list().map(each => `${path.basename(each.file)} ${each.messages}`), shown: [shown(across), shown(toPerson)] }, {
			list: ['lead-a1.md 4', 'docs-a2.md 1'],
			shown: ['docs-a2.md', 'lead-a1.md']
		});
	});
});
