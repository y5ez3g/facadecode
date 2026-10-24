/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredPromise } from '../base/async';
import { messageOf } from '../base/errors';
import { ErrorOutcome, FacadeError } from '../core/errors';
import { Fetched, headingOf } from '../core/mail';
import { Caller, PERSON } from '../record/events';
import { HUMAN, TEXT_IN_LINE } from '../record/messages';
import { finalScreenFile, screensDir } from '../record/screens';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, endFakeProcess, fakeWorld, startFakeProcess, worktreeFolder } from './fakes';
import { outcomeOf, tempDir } from './util';

/** Enter, as a terminal takes it in. */
const ENTER = String.fromCharCode(13);

type World = ReturnType<typeof fakeWorld>;

/** What a call came to: what it answered, or the code of what it threw and its message. */
function outcome(call: () => unknown): unknown {
	try {
		return call();
	} catch (err) {
		return `${err instanceof FacadeError ? err.code : 'ERROR'}: ${messageOf(err)}`;
	}
}

/** A fetch, each message as its number, its delivery state as the fetch took it, its sender - and recipient, for another's - and its text or length, and the file where there is one. */
function shown(fetched: Fetched): string[] {
	return [
		...fetched.messages.map(message => `#m${message.id} ${message.state} from ${message.from}${message.own ? '' : ` to ${message.to}`}: ${message.text ?? `${message.length} characters`}`),
		...(fetched.file ? [`file ${path.basename(fetched.file)}`] : [])
	];
}

/** The texts of the messages a fetch gives. */
function texts(fetched: Fetched): string[] {
	return fetched.messages.map(message => message.text ?? '');
}

suite('Core: messages', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	/** A worktree Facade made of `lab`, where the person starts agents that start agents of their own (O3). */
	let work: string;
	let dir: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-mail-');
		lab = path.join(temp.dir, 'lab');
		work = worktreeFolder(lab, 'work');
		dir = path.join(temp.dir, 'workspace');
		fs.mkdirSync(lab);
		world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** The title of the terminal agent `id` runs in. */
	function terminalOf(id: number, of: World = world): string {
		const agent = of.agent(id);
		return `@${agent.name} #a${agent.id}`;
	}

	/** What was typed into agent `id`'s terminal, piece by piece: each text, and its Enter where it had one. */
	function typedInto(id: number, of: World = world): string[] {
		return of.terminals.texts.filter(each => each.id === id).flatMap(each => each.enter ? [each.text, ENTER] : [each.text]);
	}

	/** The doorbells typed into agent `id`'s terminal. */
	function ringsOf(id: number, of: World = world): string[] {
		return typedInto(id, of).filter(text => text.startsWith('[facade]'));
	}

	/** Turns YOLO off for the agents the person starts from now on, and so for the agents they start (O1). */
	function yoloOff(): void {
		world.switches.yolo = false;
	}

	/**
	 * A lead the person started with no task - so that no doorbell rang yet - and, where `children` says,
	 * its children, each started with a task it has fetched, a minute ago.
	 */
	async function team(...children: string[]): Promise<{ readonly lead: Caller; readonly children: readonly Caller[] }> {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'lead', folder: work });
		const lead = callerOf(world.agent(1));
		const made: Caller[] = [];
		for (const name of children) {
			const spawned = await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: `Be ${name}.`, name });
			await world.fetched(spawned.id);
			made.push(callerOf(world.agent(spawned.id)));
		}
		if (made.length) {
			await sleep(60_000);
		}
		return { lead, children: made };
	}

	suite('sending', () => {

		test('a message is recorded and numbered at once, and answers with its number; its recipient is rung 2 seconds on - Enter after its CLI\'s pause - fetches it, and has it fetched; the chat room has it', async () => {
			const { lead, children: [lint] } = await team('lint');
			const sent = world.facade.mail.send(lead, ['@lint'], 'Lint the docs.', undefined);
			const before = world.facade.mail.mailboxOf(lint.id ?? 0, lead);
			await sleep(1_999);
			const early = ringsOf(2);
			await sleep(1);
			const line = world.terminals.typed.slice(-1);
			await sleep(300);
			const fetched = await world.fetched(2);
			const after = world.facade.mail.mailboxOf(2, lead);

			assert.deepStrictEqual({
				sent,
				before: [before?.unread.map(message => message.id), before?.fetched, before?.task],
				early,
				line,
				fetched: shown(fetched),
				after: [after?.unread.length, after?.fetched],
				room: fs.readFileSync(path.join(dir, 'rooms', 'lead-a1.md'), 'utf8').includes('@lead #a1 → @lint #a2\nLint the docs.\n')
			}, {
				sent: [{ id: 2, to: '@lint #a2', toPerson: false }],
				before: [[2], 1, { id: 1, state: 'delivered' }],
				early: [],
				line: ['@lint #a2: type "[facade] 1 unread message: #m2 from @lead #a1. Call read_messages.", Enter after 300 ms'],
				fetched: ['#m2 unread from @lead #a1: Lint the docs.'],
				after: [0, 2],
				room: true
			});
		});

		test('a message to several recipients is a message of its own to each, under its own number; one of them ended refuses the whole send, and nothing is recorded', async () => {
			const { lead } = await team('lint', 'docs', 'gone');
			world.terminals.end(terminalOf(4), { exitCode: 0, byThePerson: false });
			const sent = world.facade.mail.send(lead, ['#a2', '@docs #a3', '@human', '@lint'], 'Status?', undefined);
			const last = world.table.state.mail.lastMessage;
			const refused = outcome(() => world.facade.mail.send(lead, ['@lint', '#a4'], 'Again?', undefined));

			assert.deepStrictEqual({ sent, refused, unchanged: world.table.state.mail.lastMessage === last }, {
				// The lead is told that @gone ended a moment later, its last screen waited for
				sent: [{ id: 4, to: '@lint #a2', toPerson: false }, { id: 5, to: '@docs #a3', toPerson: false }, { id: 6, to: '@human', toPerson: true }],
				refused: 'REFUSED: @gone #a4 has ended (exited: its CLI ended with exit code 0). Nothing was sent.',
				unchanged: true
			});
		});

		test('a send to several that Facade fails to record partway says which went - sent again, those would come twice - and an empty recipient refuses the whole send', async () => {
			const { children: [lint] } = await team('lint', 'docs');
			world.recording.fails = message => message.to === 3 ? new Error('EPERM: operation not permitted') : undefined;
			const partway = outcome(() => world.facade.mail.send(lint, ['@lead', '@docs'], 'Done.', undefined));
			const empty = outcome(() => world.facade.mail.send(lint, ['@lead', ' '], 'Done?', undefined));
			// What went, as the error's outcome declares it for every reader (XS-02)
			let sent: ErrorOutcome['sent'];
			try {
				world.facade.mail.send(lint, ['@lead', '@docs'], 'Again.', undefined);
			} catch (err) {
				sent = err instanceof FacadeError ? err.outcome?.sent : undefined;
			}

			assert.deepStrictEqual({ partway, empty, sent, recorded: [...world.table.state.mail.messages.values()].filter(message => message.text?.startsWith('Done')).map(message => message.to) }, {
				partway: 'FAILED: Recorded messages: #m3 to @lead #a1. Failed to record a message to @docs #a3: EPERM: operation not permitted\nFurther effects are unknown. Do not resend the messages listed above; inspect the recorded state before sending again.',
				empty: 'INVALID: Argument \'to\' contains an empty recipient. Provide an agent (#a7, @name, or @name #a7), @human, or a nonempty list of recipients.',
				sent: [{ id: 4, to: '@lead #a1' }],
				recorded: [1]
			});
		});

		test('a name several running agents have names the one in the caller\'s reach, its YOLO off; for one whose YOLO is on, it names them all, and is refused', async () => {
			yoloOff();
			const { lead } = await team('lint');
			world.switches.yolo = true;
			await world.startUp(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'lint', folder: work });
			const mine = world.facade.mail.send(lead, ['@lint'], 'Yours.', undefined);
			const theirs = outcome(() => world.facade.mail.send(callerOf(world.agent(3)), ['@lint'], 'Whose?', undefined));

			assert.deepStrictEqual({ mine, theirs }, {
				mine: [{ id: 2, to: '@lint #a2', toPerson: false }],
				theirs: 'INVALID: 2 active runs are named @lint: @lint #a2, @lint #a3. Select one by its agent ID.'
			});
		});

		test('a message to an agent still starting is taken, says so, and rings once it is running; an agent messages itself, and is rung', async () => {
			const { lead } = await team();
			const starting = world.facade.startAgent(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'slow', task: 'Be slow.' });
			await until(() => world.terminals.launched.length === 2);
			const taken = world.facade.mail.send(lead, ['@slow'], 'When you are up.', undefined);
			await sleep(5_000);
			const whileStarting = ringsOf(2);
			world.hello(2);
			await settled(starting);
			world.facade.mail.send(lead, ['@lead'], 'Note to self.', undefined);
			await sleep(60_000);

			assert.deepStrictEqual({ taken, whileStarting, rung: ringsOf(2), self: ringsOf(1) }, {
				taken: [{ id: 2, to: '@slow #a2', toPerson: false, starting: true }],
				whileStarting: [],
				// Its first line, its launch argument, rang for its task as it started: a minute on, both are named
				rung: ['[facade] 2 unread messages: #m1 from @lead #a1, #m2 from @lead #a1. Call read_messages.'],
				self: ['[facade] 1 unread message: #m3 from @lead #a1. Call read_messages.']
			});
		});

		test('what is refused is said: an empty text, a recipient that is none or ended, a message\'s number for an agent, a reply to a message sent to another, an agent\'s number or a bare one for one, the person writing to themselves', async () => {
			const { lead, children: [lint] } = await team('lint');
			const toLint = world.facade.mail.send(lead, ['@lint'], 'Mine.', undefined)[0].id;
			world.facade.mail.send(PERSON, ['@lead'], 'Yours.', undefined);
			world.terminals.end(terminalOf(2), { byThePerson: true });
			const send = (caller: Caller, to: readonly string[], text = 'Hi.', replyTo?: string) => outcome(() => world.facade.mail.send(caller, to, text, replyTo));

			assert.deepStrictEqual([
				send(lead, ['@nobody']),
				send(lead, []),
				send(lead, ['@lint']),
				send(lead, ['#a2']),
				send(lead, ['#m2']),
				send(lead, ['@human'], ' \n '),
				send(lead, ['@human'], 'Re.', `#m${toLint}`),
				send(lead, ['@human'], 'Re.', '#a2'),
				send(lead, ['@human'], 'Re.', '3'),
				send(lead, ['@human'], 'Re.', '#m99'),
				send(PERSON, ['@human']),
				send(PERSON, ['@human']),
				lint.id
			], [
				'NOT_FOUND: No reachable agent is named @nobody. Call list_agents with all:true to see reachable runs.',
				'INVALID: Argument \'to\' has no recipients. Provide an agent (#a7, @name, or @name #a7), @human, or a nonempty list of recipients.',
				'NOT_FOUND: All runs named @lint have ended: @lint #a2. Select one by its agent ID.',
				'REFUSED: @lint #a2 has ended (stopped: its terminal tab was closed). Nothing was sent.',
				'INVALID: \'#m2\' is not an agent ID; it is a message ID. Use an agent ID such as #a1 or #a2.',
				'INVALID: Argument \'text\' must contain a message; it cannot be empty.',
				'INVALID: Message #m2 was addressed to @lint #a2, not to you. reply_to must identify a message addressed to you.',
				'INVALID: \'#a2\' is an agent ID. Argument \'reply_to\' requires a message ID such as #m42.',
				'INVALID: 3 is not a message ID. Argument \'reply_to\' requires a message ID such as #m42.',
				'NOT_FOUND: Message #m99 was not found. reply_to must identify a message addressed to you.',
				'INVALID: You are @human. Send messages to agents, not to yourself.',
				'INVALID: You are @human. Send messages to agents, not to yourself.',
				2
			]);
		});

		test('a child\'s end is told of to its creator by a message from Facade - an exit code, 0 too, or a stop by the person - but a stop its creator asked for; an agent the person started is told of to them as L6 has it: an exit code other than 0, never 0', async () => {
			const { lead } = await team('crash', 'closed', 'done', 'stopped');
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			world.terminals.end(terminalOf(3), { byThePerson: true });
			world.terminals.end(terminalOf(4), { exitCode: 0, byThePerson: false });
			await world.facade.stopAgent(lead, '@stopped');
			await sleep(1_000);
			const fetched = await world.fetched(1);
			await world.startUp(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'solo', folder: work });
			await world.startUp(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'boom', folder: work });
			world.terminals.end(terminalOf(6), { exitCode: 0, byThePerson: false });
			world.terminals.end(terminalOf(7), { exitCode: 2, byThePerson: false });
			await sleep(1_000);

			assert.deepStrictEqual({ told: shown(fetched), person: world.person.told }, {
				told: [
					'#m5 unread from Facade: @crash #a2 ended: it exited with code 1. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a2 to find out why.',
					'#m6 unread from Facade: @closed #a3 ended: stopped by @human: its terminal tab was closed. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a3 to find out why.',
					'#m7 unread from Facade: @done #a4 ended: it exited with code 0. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a4 to find out why.'
				],
				person: ['error: @boom #a7 exited: its CLI ended with exit code 2. (#a7\'s terminal)']
			});
		});

		test('a child\'s end told of to its creator brings the last lines of the screen its terminal left - the window keeps it a moment after the end - and how to read more of it; with none kept, it says so', async () => {
			world.timing.finalScreenWaitMs = 2_000;
			await team('crash', 'quiet');
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			world.terminals.end(terminalOf(3), { exitCode: 0, byThePerson: false });
			// The window writes the final screen as the terminal goes, a moment after Facade hears of its end
			await sleep(500);
			const early = world.facadeMessagesTo(1, 'unread').length;
			fs.mkdirSync(screensDir(world.table.dir), { recursive: true });
			fs.writeFileSync(finalScreenFile(screensDir(world.table.dir), 2), JSON.stringify({ final: { buffer: 'normal', lines: ['Working on it', 'Error: out of memory'] } }));
			await sleep(3_000);
			const fetched = await world.fetched(1);

			assert.deepStrictEqual({ early, told: texts(fetched) }, {
				early: 0,
				told: [
					'@crash #a2 ended: it exited with code 1. It can no longer receive messages.\nScreen excerpt for #a2. Use read_screen for up to 2000 lines:\nWorking on it\nError: out of memory',
					'@quiet #a3 ended: it exited with code 0. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a3 to find out why.'
				]
			});
		});

		test('a child that ends as Facade is turned off, before its last screen is kept, is told of to its creator all the same, without the screen', async () => {
			world.timing.finalScreenWaitMs = 2_000;
			const { lead } = await team('late');
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			world.dispose('facade');
			const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

			assert.deepStrictEqual(ledger.filter(event => event.type === 'message.sent' && event.facade === 'ended').map(event => ({ to: event.to, about: event.about, text: event.text })), [
				{ to: lead.id, about: 2, text: '@late #a2 ended: it exited with code 1. It can no longer receive messages. Facade shut down before reading the final screen. After Facade reconnects, call read_screen with agent #a2.' }
			]);
		});

		test('with no wait set, as the window sets none, a child\'s last screen is waited for 2 seconds after its end, no more', async () => {
			delete (world.timing as { finalScreenWaitMs?: number }).finalScreenWaitMs;
			await team('soon', 'late');
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			world.terminals.end(terminalOf(3), { exitCode: 1, byThePerson: false });
			fs.mkdirSync(screensDir(world.table.dir), { recursive: true });
			await sleep(1_500);
			fs.writeFileSync(finalScreenFile(screensDir(world.table.dir), 2), JSON.stringify({ final: { buffer: 'normal', lines: ['in time'] } }));
			await sleep(1_000);
			fs.writeFileSync(finalScreenFile(screensDir(world.table.dir), 3), JSON.stringify({ final: { buffer: 'normal', lines: ['too late'] } }));
			await sleep(2_000);
			const fetched = await world.fetched(1);

			assert.deepStrictEqual(texts(fetched).map(text => text.split('\n').pop()), [
				'in time',
				'@late #a3 ended: it exited with code 1. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a3 to find out why.'
			]);
		});

		test('a child\'s end whose last screen could not be read is told of to its creator all the same, saying where to read why', async () => {
			await team('crash');
			const screens = (world.facade as unknown as { readonly screens: { excerptOf(agent: unknown): Promise<unknown> } }).screens;
			screens.excerptOf = () => Promise.reject(new Error('EIO: i/o error, read'));
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			await sleep(1_000);

			assert.deepStrictEqual({ told: world.facadeMessagesTo(1, 'unread'), logged: world.logs.filter(line => line.includes('screen excerpt for its creator')) }, {
				told: ['@crash #a2 ended: it exited with code 1. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a2 to find out why.'],
				logged: ['Could not read @crash #a2\'s screen excerpt for its creator: EIO: i/o error, read']
			});
		});

		test('a message is plain text, taken as it is: its spaces and its lines; a long one, 20,000 characters, is kept in a file, and given in one', async () => {
			const { lead } = await team('lint');
			const text = `  ${'a'.repeat(19_996)}\n\n`;
			world.facade.mail.send(lead, ['@lint'], text, undefined);
			const fetched = await world.fetched(2);

			assert.deepStrictEqual({ shown: shown(fetched), file: fs.readFileSync(fetched.file ?? '', 'utf8').endsWith(`${text}\n`), stored: world.table.state.mail.messages.get(2)?.file }, {
				shown: ['#m2 unread from @lead #a1: 20000 characters', 'file fetch-a2-1.txt'],
				file: true,
				stored: 'm2.txt'
			});
		});
	});

	suite('recipients that cannot take a message', () => {

		test('a recipient launched without Facade\'s tools, or being stopped, is refused with why, and nothing is sent (M2)', async () => {
			const { lead } = await team('lint');
			world.switches.framework = false;
			await world.facade.startForPerson('arg', lab);
			world.switches.framework = true;
			world.terminals.stubborn = true;
			const stopping = world.facade.stopAgent(lead, '@lint');
			await sleep(10);
			const last = world.table.state.mail.lastMessage;
			const plain = outcome(() => world.facade.mail.send(lead, ['#a3'], 'Hi.', undefined));
			const beingStopped = outcome(() => world.facade.mail.send(lead, ['@lint'], 'Hi.', undefined));
			const unchanged = world.table.state.mail.lastMessage === last;
			world.terminals.stubborn = false;
			await settled(stopping);

			assert.deepStrictEqual({ plain, beingStopped, unchanged }, {
				plain: 'REFUSED: @arg #a3 cannot fetch messages because it was started without Facade tools: its launch has no connect group, or the agent framework was disabled. Nothing was sent.',
				beingStopped: 'REFUSED: @lint #a2 is stopping. Nothing was sent.',
				unchanged: true
			});
		});
	});

	suite('reach', () => {

		test('with its YOLO off, an agent sends to its own tree and to the person only, and fetches by number only what its tree\'s chat room has; one whose YOLO is on sends into that tree, told that the recipient cannot reply; the person reaches every agent', async () => {
			// An agent keeps the YOLO it started with
			yoloOff();
			const { children: [lint] } = await team('lint');
			world.switches.yolo = true;
			const other = callerOf(world.agent((await world.startUp(PERSON, { cli: 'told', model: 'small', effort: 'high', name: 'other', folder: work })).id));
			const out = outcome(() => world.facade.mail.send(lint, ['@lead', '@other'], 'Hi.', undefined));
			const within = world.facade.mail.send(lint, ['@lead', '@human'], 'Up.', undefined);
			const fromOther = world.facade.mail.send(other, ['@lint'], 'From the other tree.', undefined);
			world.facade.mail.send(other, ['@human'], 'Mine.', undefined);
			const own = await world.fetched(2, { ids: ['#m4'] });
			const outside = await world.fetched(2, { ids: ['#m4', '#m5'] }).then(() => 'fetched', err => messageOf(err));
			const intoTree = await world.fetched(3, { ids: ['#m2'] });
			const person = await world.facade.mail.fetch(PERSON, { ids: ['#m2', '#m5'] }, () => undefined);

			assert.deepStrictEqual({
				out,
				within,
				fromOther,
				own: shown(own),
				outside,
				intoTree: shown(intoTree),
				person: person.messages.map(message => message.id),
				mailboxes: [!!world.facade.mail.mailboxOf(1, lint), world.facade.mail.mailboxOf(3, lint), !!world.facade.mail.mailboxOf(2, other)]
			}, {
				out: 'NOT_FOUND: No reachable agent is named @other. Call list_agents with all:true to see reachable runs.',
				within: [{ id: 2, to: '@lead #a1', toPerson: false }, { id: 3, to: '@human', toPerson: true }],
				fromOther: [{ id: 4, to: '@lint #a2', toPerson: false, cannotReply: true }],
				own: ['#m4 unread from @other #a3: From the other tree.'],
				outside: 'Cannot fetch #m5: it is outside your reach. With YOLO off, an ID lookup can read only messages to or from your tree, rooted at @lead #a1. Nothing was fetched.',
				intoTree: ['#m2 unread from @lint #a2 to @lead #a1: Up.'],
				person: [2, 5],
				mailboxes: [true, undefined, true]
			});
		});
	});

	suite('fetching', () => {

		test('three ways: the caller\'s unread messages; any message by its number, which stays unread for its recipient; all sent to the caller, its task among them - each with its delivery state, and no mark of who was given it before (M4)', async () => {
			const { lead, children: [lint, docs] } = await team('lint', 'docs');
			world.facade.mail.send(lead, ['@lint'], 'Lint.', undefined);
			world.facade.mail.send(lint, ['@docs'], 'Docs?', undefined);
			const unread = await world.fetched(2);
			const another = await world.fetched(2, { ids: ['#m4', 'm2'] });
			const again = await world.fetched(2, { ids: ['M4'] });
			const all = await world.fetched(2, { all: true });
			const bare = await world.fetched(2, { ids: ['4'] }).then(() => 'fetched', err => messageOf(err));

			assert.deepStrictEqual({
				unread: shown(unread),
				another: shown(another),
				states: another.messages.map(message => message.state),
				again: shown(again),
				all: shown(all),
				bare,
				docs: world.facade.mail.mailboxOf(docs.id ?? 0, lead)?.unread.map(message => message.id)
			}, {
				unread: ['#m3 unread from @lead #a1: Lint.'],
				another: ['#m2 delivered from @lead #a1 to @docs #a3: Be docs.', '#m4 unread from @lint #a2 to @docs #a3: Docs?'],
				states: ['delivered', 'unread'],
				again: ['#m4 unread from @lint #a2 to @docs #a3: Docs?'],
				all: ['#m1 delivered from @lead #a1: Be lint.', '#m3 delivered from @lead #a1: Lint.'],
				bare: '4 is not a message ID. Argument \'ids\' requires a message ID such as #m42.',
				docs: [4]
			});
		});

		test('a message named more than once among the ids - #m2, m2 and #m2 again - is given once (M4)', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Once.', undefined);

			assert.deepStrictEqual(shown(await world.fetched(2, { ids: ['#m2', 'm2', '#m2'] })), ['#m2 unread from @lead #a1: Once.']);
		});

		test('texts that come to 8,000 characters or fewer are in the result; more, and all are in one file, under their numbers, the result giving each one\'s heading', async () => {
			const { lead } = await team('lint');
			for (let i = 0; i < 2; i++) {
				world.facade.mail.send(lead, ['@lint'], 'b'.repeat(3_000), undefined);
			}
			const two = await world.fetched(2);
			for (let i = 0; i < 5; i++) {
				world.facade.mail.send(lead, ['@lint'], 'c'.repeat(3_000), undefined);
			}
			const five = await world.fetched(2);
			const file = fs.readFileSync(five.file ?? '', 'utf8');

			assert.deepStrictEqual({ two: [two.file, two.messages.map(message => message.text?.length)], five: [five.messages.map(message => message.text), path.basename(five.file ?? '')], file: file.split('\n').filter(line => line.startsWith('#m')).map(line => line.split(' · ')[0]) }, {
				two: [undefined, [3_000, 3_000]],
				five: [[undefined, undefined, undefined, undefined, undefined], 'fetch-a2-1.txt'],
				file: ['#m4', '#m5', '#m6', '#m7', '#m8']
			});
		});

		test('a result that did not reach the pipe delivers nothing: its messages come again, unread, under their numbers; two fetches of one agent at once go one after the other, the second getting what the first left', async () => {
			const { lead, children: [lint] } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'One.', undefined);
			const lost = await world.facade.mail.fetch(lint, {}, listener => listener(false));
			let answer: ((written: boolean) => void) | undefined;
			const first = world.facade.mail.fetch(lint, {}, listener => answer = listener);
			const second = world.facade.mail.fetch(lint, {}, listener => listener(true));
			const firstFetched = await first;
			let secondDone = false;
			void second.then(() => secondDone = true);
			await sleep(1_000);
			const waited = !secondDone;
			answer?.(true);

			assert.deepStrictEqual({ lost: shown(lost), first: shown(firstFetched), waited, second: shown(await second) }, {
				lost: ['#m2 unread from @lead #a1: One.'],
				first: ['#m2 unread from @lead #a1: One.'],
				waited: true,
				second: []
			});
		});

		test('a fetch whose delivery Facade fails to record gives its messages all the same, and again next time, unread still: none is lost', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'One.', undefined);
			// The first delivery alone fails to be recorded
			let deliveries = 0;
			world.recording.deliveryFails = () => ++deliveries === 1 ? new Error('EPERM: operation not permitted') : undefined;
			const first = await world.fetched(2);
			const again = await world.fetched(2);
			const after = await world.fetched(2);

			assert.deepStrictEqual({ first: shown(first), again: shown(again), after: shown(after), logged: world.logs.filter(line => line.startsWith('Could not record message delivery')) }, {
				first: ['#m2 unread from @lead #a1: One.'],
				again: ['#m2 unread from @lead #a1: One.'],
				after: [],
				logged: ['Could not record message delivery to #a2. The messages remain unread and will appear again with the same IDs. Reason: EPERM: operation not permitted']
			});
		});

		test('a message from before the window last started is in the chat rooms only: fetched by its number, it is refused, saying which room has it', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Old.', undefined);
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			await world.facade.recover();
			await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'next', folder: work });
			const refused = await world.fetched(3, { ids: ['#m2'] }).then(() => 'fetched', err => messageOf(err));
			const none = await world.fetched(3, { ids: ['#m9'] }).then(() => 'fetched', err => messageOf(err));

			assert.deepStrictEqual({ refused, none }, {
				refused: `Message #m2 predates this window's current session. Its only copy is in chat room ${path.join(dir, 'rooms', 'lead-a1.md')}.`,
				none: 'Message #m9 was not found. The latest message ID is #m2.'
			});
		});

		test('a number before any message was sent is refused, saying so; one from before the window last started whose chat rooms were deleted is gone', async () => {
			await team();
			const none = await world.fetched(1, { ids: ['#m1'] }).then(() => 'fetched', err => messageOf(err));
			world.facade.mail.send(callerOf(world.agent(1)), ['@human'], 'Old.', undefined);
			world.facade.mail.deleteRooms();
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			await world.facade.recover();
			await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'next', folder: work });
			const gone = await world.fetched(2, { ids: ['#m1'] }).then(() => 'fetched', err => messageOf(err));

			assert.deepStrictEqual({ none, gone }, {
				none: 'Message #m1 was not found. No messages have been sent.',
				gone: 'Message #m1 predates this window\'s current session, and its chat rooms were deleted. The message is no longer available.'
			});
		});

		test('a reply is fetched under a heading naming the message it answers; the person replies only to a message sent to them', async () => {
			const { lead, children: [lint] } = await team('lint');
			const [ask] = world.facade.mail.send(lead, ['@lint'], 'Report?', undefined);
			world.facade.mail.send(lint, ['@lead'], 'Done.', `#m${ask.id}`);
			const [toYou] = world.facade.mail.send(lint, ['@human'], 'All done.', undefined);
			const fetched = await world.fetched(1);
			const notYours = outcome(() => world.facade.mail.send(PERSON, ['@lint'], 'Thanks.', `#m${ask.id}`));
			const yours = outcome(() => world.facade.mail.send(PERSON, ['@lint'], 'Thanks.', `#m${toYou.id}`).map(message => message.id));

			assert.deepStrictEqual({ answers: fetched.messages.map(message => [message.id, message.replyTo, headingOf(message).split(' · ').filter(part => part.startsWith('reply to '))]), notYours, yours }, {
				answers: [[3, 2, ['reply to #m2']]],
				notYours: 'INVALID: Message #m2 was addressed to @lint #a2, not to you. reply_to must identify a message addressed to you.',
				yours: [5]
			});
		});
	});

	suite('the doorbell', () => {

		test('messages that come within 2 seconds of the first ring together, each named; more than five are counted', async () => {
			const { lead } = await team('lint');
			for (let i = 0; i < 7; i++) {
				world.facade.mail.send(lead, ['@lint'], `Item ${i}.`, undefined);
				await sleep(200);
			}
			await sleep(2_000);

			assert.deepStrictEqual(ringsOf(2), ['[facade] 7 unread messages: #m2 from @lead #a1, #m3 from @lead #a1, #m4 from @lead #a1, #m5 from @lead #a1, #m6 from @lead #a1, and 2 more. Call read_messages.']);
		});

		test('a doorbell waits while Facade\'s own input goes into its terminal, then names what is unread as it goes in; Facade turned off while it waits, it is never typed', async () => {
			const { lead } = await team('lint');
			world.terminals.inputs.set(2, { pending: false, busy: true });
			world.facade.mail.send(lead, ['@lint'], 'First.', undefined);
			await sleep(3_000);
			const whileBusy = ringsOf(2).length;
			world.facade.mail.send(lead, ['@lint'], 'Second.', undefined);
			await world.fetched(2, { ids: ['#m2'] });
			world.terminals.inputs.set(2, { pending: false, busy: false });
			await sleep(2_000);
			const rung = ringsOf(2);
			const mailbox = world.facade.mail.mailboxOf(2, lead);
			world.terminals.inputs.set(2, { pending: false, busy: true });
			await world.fetched(2);
			await sleep(61_000);
			world.facade.mail.send(lead, ['@lint'], 'Third.', undefined);
			await sleep(3_000);
			world.dispose('facade');
			world.terminals.inputs.set(2, { pending: false, busy: false });
			await sleep(5_000);

			assert.deepStrictEqual({ whileBusy, rung, unread: mailbox?.unread.map(message => message.id), after: ringsOf(2).length }, {
				whileBusy: 0,
				rung: ['[facade] 1 unread message: #m3 from @lead #a1. Call read_messages.'],
				unread: [3],
				after: 1
			});
		});

		test('a message not fetched rings again a minute after, then 2, 4 and 8 minutes after the ring before, then every 15; it is never returned while its recipient runs', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Busy?', undefined);
			const times: number[] = [];
			const start = Date.now();
			for (let minute = 0; minute < 47; minute++) {
				const before = ringsOf(2).length;
				await sleep(60_000);
				if (ringsOf(2).length > before) {
					times.push(Math.round((Date.now() - start) / 60_000));
				}
			}

			assert.deepStrictEqual({ minutes: times, unread: world.facade.mail.mailboxOf(2, lead)?.unread.map(message => message.id), returned: world.table.state.mail.returns.size }, {
				// Rung at 2 seconds, in the first minute; then 1, 2, 4, 8 and 15 minutes after each ring before
				minutes: [1, 2, 4, 8, 16, 31, 46],
				unread: [2],
				returned: 0
			});
		});

		test('a new message rings within a minute, not at the next ring of an old one still unread; a burst rings once a minute at most', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Old.', undefined);
			await sleep(10 * 60_000);
			const old = ringsOf(2).length;
			world.facade.mail.send(lead, ['@lint'], 'New.', undefined);
			await sleep(60_000);
			const afterNew = ringsOf(2).length;
			for (let i = 0; i < 6; i++) {
				world.facade.mail.send(lead, ['@lint'], `Burst ${i}.`, undefined);
				await sleep(20_000);
			}

			assert.deepStrictEqual({ old, afterNew: afterNew - old, burst: ringsOf(2).length - afterNew }, {
				// At 2 seconds, 1, 3 and 7 minutes; the old one's next would be at 15
				old: 4,
				afterNew: 1,
				// Two minutes of messages: two rings at most
				burst: 2
			});
		});

		test('a mailbox emptied starts afresh: the next message rings 2 seconds on, however soon after the last doorbell; one that comes while another is unread waits for the minute', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'First?', undefined);
			// Its line, and its Enter after the CLI's pause
			await sleep(2_500);
			const first = ringsOf(2).length;
			await world.fetched(2);
			await sleep(5_000);
			world.facade.mail.send(lead, ['@lint'], 'Second?', undefined);
			await sleep(2_500);
			const second = ringsOf(2).length;
			world.facade.mail.send(lead, ['@lint'], 'Third?', undefined);
			await sleep(10_000);
			const held = ringsOf(2).length;
			await sleep(50_000);

			assert.deepStrictEqual({ first, second, held, minute: ringsOf(2).slice(2) }, {
				first: 1,
				second: 2,
				held: 2,
				minute: ['[facade] 2 unread messages: #m3 from @lead #a1, #m4 from @lead #a1. Call read_messages.']
			});
		});

		test('while the person types in that terminal the doorbell waits: until they press Enter, or until they have typed nothing for 10 seconds - then it is typed after their draft', async () => {
			const { lead } = await team('lint', 'docs');
			const now = () => Date.now();
			world.terminals.inputs.set(2, { pending: true, lastKey: now() });
			world.terminals.inputs.set(3, { pending: true, lastKey: now() });
			world.facade.mail.send(lead, ['@lint', '@docs'], 'Report.', undefined);
			await sleep(5_000);
			const waiting = [ringsOf(2).length, ringsOf(3).length];
			world.terminals.inputs.set(2, { pending: false, lastKey: now() });
			await sleep(1_400);
			const afterEnter = [ringsOf(2).length, ringsOf(3).length];
			await sleep(5_000);

			assert.deepStrictEqual({ waiting, afterEnter, afterIdle: [ringsOf(2).length, ringsOf(3).length] }, {
				waiting: [0, 0],
				afterEnter: [1, 0],
				afterIdle: [1, 1]
			});
		});

		test('with YOLO off the doorbell is typed as with it on, and the person is shown nothing', async () => {
			const { lead } = await team('lint');
			yoloOff();
			world.facade.mail.send(lead, ['@lint'], 'One.', undefined);
			await sleep(3_000);

			assert.deepStrictEqual({ rung: ringsOf(2), notified: world.person.notified.map(each => each.key) }, {
				rung: ['[facade] 1 unread message: #m2 from @lead #a1. Call read_messages.'],
				notified: []
			});
		});

		test('a window that cannot tell what the person typed does not hold the doorbell back: it rings, and the log says why it did not wait', async () => {
			const { lead } = await team('lint');
			world.terminals.input = () => Promise.reject(new Error('the window did not answer'));
			world.facade.mail.send(lead, ['@lint'], 'Hello?', undefined);
			await sleep(3_000);

			assert.deepStrictEqual({ rung: ringsOf(2), logged: world.logs.filter(line => line.startsWith('Could not determine the human-input state')) }, {
				rung: ['[facade] 1 unread message: #m2 from @lead #a1. Call read_messages.'],
				logged: ['Could not determine the human-input state of @lint #a2\'s terminal: the window did not answer']
			});
		});

		test('a doorbell that could not be typed - its terminal away for a moment - is tried again a minute on', async () => {
			const { lead } = await team('lint');
			world.terminals.running.delete(terminalOf(2));
			world.facade.mail.send(lead, ['@lint'], 'Hello?', undefined);
			await sleep(3_000);
			const failed = ringsOf(2).length;
			world.terminals.running.add(terminalOf(2));
			await sleep(55_000);
			const early = ringsOf(2).length;
			await sleep(5_000);

			assert.deepStrictEqual({ failed, early, rung: ringsOf(2).length, logged: world.logs.some(line => line.includes('Retrying in one minute. Reason: its terminal was unavailable')) }, {
				failed: 0,
				early: 0,
				rung: 1,
				logged: true
			});
		});

		test('a doorbell that could not be typed is tried again no more once the mailbox is emptied: the next message rings 2 seconds on', async () => {
			const { lead } = await team('lint');
			world.terminals.running.delete(terminalOf(2));
			world.facade.mail.send(lead, ['@lint'], 'Hello?', undefined);
			await sleep(3_000);
			world.terminals.running.add(terminalOf(2));
			await world.fetched(2);
			world.facade.mail.send(lead, ['@lint'], 'Again.', undefined);
			await sleep(3_000);

			assert.deepStrictEqual(ringsOf(2), ['[facade] 1 unread message: #m3 from @lead #a1. Call read_messages.']);
		});

		test('a doorbell due while its agent fetches waits for the fetch to be done: what it took is not rung for', async () => {
			const { lead, children: [lint] } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Taken as it rings.', undefined);
			await sleep(1_500);
			let write: ((written: boolean) => void) | undefined;
			await world.facade.mail.fetch(lint, {}, listener => write = listener);
			await sleep(2_000);
			const whileFetching = ringsOf(2).length;
			write?.(true);
			await sleep(2_000);

			assert.deepStrictEqual({ whileFetching, after: ringsOf(2).length, delivered: world.table.state.mail.entries.get(2)?.state }, { whileFetching: 0, after: 0, delivered: 'delivered' });
		});

		test('a doorbell due while its agent\'s MCP server is gone waits for its next hello, and the log says so (M5)', async () => {
			const { lead, children: [lint] } = await team('lint');
			const server = startFakeProcess();
			world.facade.connected(lint, server);
			endFakeProcess(server);
			world.facade.mail.send(lead, ['@lint'], 'Are you there?', undefined);
			await sleep(3_000);
			const whileGone = ringsOf(2).length;
			const logged = world.logs.filter(line => line.includes('is waiting for its MCP server to connect')).length;
			world.facade.connected(lint, startFakeProcess());
			await sleep(1_000);

			assert.deepStrictEqual({ whileGone, logged, after: ringsOf(2) }, {
				whileGone: 0,
				logged: 1,
				after: ['[facade] 1 unread message: #m2 from @lead #a1. Call read_messages.']
			});
		});

		test('a message to an agent whose MCP server is gone is sent all the same, the send saying that its doorbell waits for it to connect again (M2)', async () => {
			const { lead, children: [lint] } = await team('lint');
			const server = startFakeProcess();
			world.facade.connected(lint, server);
			endFakeProcess(server);
			const sent = world.facade.mail.send(lead, ['@lint'], 'Are you there?', undefined);

			assert.deepStrictEqual(sent, [{ id: 2, to: '@lint #a2', toPerson: false, reconnecting: true }]);
		});

		test('a launch\'s task delay holds back the line that types an agent\'s task alone: one given its task as its argument is rung for a message 2 seconds after it came, however long that delay; one told of its task in its terminal is typed it once the delay is over (M5, M7)', async () => {
			world.settings.arg = { launch: { taskDelay: 30_000 } };
			world.settings.told = { launch: { taskDelay: 30_000 } };
			await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'lead', folder: work });
			const lead = callerOf(world.agent(1));
			await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'lint', task: 'Lint.' });
			await world.fetched(2);
			world.facade.mail.send(lead, ['@lint'], 'And the docs.', undefined);
			await world.startUp(lead, { cli: 'told', model: 'small', effort: 'high', name: 'typed', task: 'Type.' });
			await sleep(2_500);
			const soon = { lint: ringsOf(2), typed: ringsOf(3) };
			await sleep(30_000);

			assert.deepStrictEqual({ soon, typed: ringsOf(3) }, {
				soon: { lint: ['[facade] 1 unread message: #m2 from @lead #a1. Call read_messages.'], typed: [] },
				typed: ['[facade] You are @typed #a3, created by @lead #a1. Your task is #m3.']
			});
		});

		test('a message fetched while its doorbell is typed is not counted as rung for', async () => {
			const { lead } = await team('lint');
			// The window takes the line and its Enter a moment on
			let typed = () => { };
			world.terminals.typing = new Promise<void>(resolve => typed = resolve);
			world.facade.mail.send(lead, ['@lint'], 'Quick.', undefined);
			await sleep(2_100);
			await world.fetched(2);
			typed();
			await sleep(1_000);

			assert.deepStrictEqual({ typed: ringsOf(2).length, rings: world.table.state.mail.entries.get(2)?.rings }, { typed: 1, rings: 0 });
		});
	});

	suite('messages waiting', () => {

		test('a task not fetched within the timeout from its agent running is told of to its creator, once - an agent by a message from Facade, the person by a notification - and stays where it is; nothing else is told of meanwhile', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team();
			const child = await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'stuck', task: 'Stuck.' });
			const own = await world.startUp(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'mine', task: 'Mine.', folder: work });
			await sleep(31_000);
			const told = await world.fetched(1);
			await sleep(5 * 60_000);

			assert.deepStrictEqual({
				told: shown(told),
				again: world.facade.mail.mailboxOf(1, lead)?.unread.length,
				person: world.person.notified.map(each => each.text),
				still: [world.facade.mail.mailboxOf(child.id, lead)?.unread.map(message => message.id), world.facade.mail.mailboxOf(own.id, PERSON)?.unread.map(message => message.id)]
			}, {
				told: ['#m3 unread from Facade: @stuck #a2 has not fetched task #m1 since starting. The task is still queued; Facade retries the doorbell automatically. Call read_screen with agent #a2. A CLI menu may have consumed the doorbell; answer it with type_text or press_keys. Do not resend the task or start a replacement agent for it.'],
				again: 0,
				person: ['Facade: @mine #a3 has not fetched task #m2 since starting. The task is still queued; Facade retries the doorbell automatically. Facade cannot determine what the CLI is doing. Inspect its terminal.'],
				still: [[1], [2]]
			});
		});

		test('messages unfetched for the timeout from their first doorbell are told of once to the sender of the oldest - an agent, or the person - with what holds them up where Facade knows; told again only once the mailbox was emptied', async () => {
			world.timing.startTimeoutMs = 30_000;
			// An agent told of it reads the screen with read_screen; the person sees the terminal
			const tail = 'The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. Call read_screen with agent #a2. A CLI menu may have consumed the doorbell; answer it with type_text or press_keys. Do not resend the messages.';
			const personsTail = 'The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. Facade cannot determine what the CLI is doing. Inspect its terminal.';
			const { lead } = await team('lint', 'docs');
			world.facade.mail.send(lead, ['@lint'], 'Report?', undefined);
			await sleep(31_000);
			const early = world.facadeMessagesTo(1, 'unread').length;
			await sleep(2_000);
			const told = world.facadeMessagesTo(1, 'unread');
			world.facade.mail.send(lead, ['@lint'], 'And?', undefined);
			await sleep(5 * 60_000);
			const once = world.facadeMessagesTo(1, 'unread').length;
			await world.fetched(2);
			// The person types on in @docs's terminal
			world.terminals.inputs.set(3, { pending: true, lastKey: Date.now() + 10 * 60_000 });
			world.facade.mail.send(PERSON, ['@docs'], 'From you.', undefined);
			world.facade.mail.send(lead, ['@lint'], 'Again?', undefined);
			await sleep(35_000);

			assert.deepStrictEqual({
				early,
				told,
				once,
				again: world.facadeMessagesTo(1, 'unread').slice(1),
				person: world.person.notified.filter(each => each.key === 'message:facade:3').map(each => each.text)
			}, {
				early: 0,
				told: [`@lint #a2 has not fetched #m3 after 32 seconds. ${tail}`],
				once: 1,
				again: [`@lint #a2 has not fetched #m7 after 32 seconds. ${tail}`],
				person: [`Facade: ${`@docs #a3 has not fetched #m6 after 32 seconds: the doorbell is waiting for the person to submit or cancel terminal input, or leave the keyboard idle for 10 seconds. ${personsTail}`.slice(0, 200)}...`]
			});
		});

		test('what holds a doorbell up is said too: Facade\'s own input going into the terminal, which it waits behind, or a terminal away for a moment, tried again each minute', async () => {
			world.timing.startTimeoutMs = 30_000;
			const tail = (id: number) => `The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. Call read_screen with agent #a${id}. A CLI menu may have consumed the doorbell; answer it with type_text or press_keys. Do not resend the messages.`;
			const { lead } = await team('lint', 'docs');
			// Facade types into @lint's terminal all along; @docs's terminal is away
			world.terminals.inputs.set(2, { pending: false, busy: true });
			world.terminals.running.delete(terminalOf(3));
			world.facade.mail.send(lead, ['@lint'], 'Report?', undefined);
			world.facade.mail.send(lead, ['@docs'], 'Report?', undefined);
			await sleep(33_000);

			assert.deepStrictEqual(world.facadeMessagesTo(1, 'unread').sort(), [
				`@docs #a3 has not fetched #m4 after 32 seconds: the terminal could not receive the doorbell; Facade retries every minute. ${tail(3)}`,
				`@lint #a2 has not fetched #m3 after 32 seconds: the doorbell is queued behind earlier Facade input. ${tail(2)}`
			]);
		});

		test('a doorbell the window does not answer - away - is said to wait for the window, which rings it once it is back, never a CLI menu: an agent told of it reads the screen once the window answers again (REMOTE.md R4; M6)', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			// The window away: who types in @lint's terminal is never answered
			world.terminals.holdInput = new Promise(() => { });
			world.facade.mail.send(lead, ['@lint'], 'Report?', undefined);
			await sleep(33_000);

			assert.deepStrictEqual(world.facadeMessagesTo(1, 'unread'), [
				'@lint #a2 has not fetched #m2 after 32 seconds: the window has not answered its doorbell; it rings once the window is back. The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. Call read_screen with agent #a2 once the window answers again. Do not resend the messages.'
			]);
		});

		test('a doorbell that waited for the window - away - and rang a moment before its messages\' time was over is said to have: the agent may still be at what came, and no CLI menu is guessed at (REMOTE.md R4; M6)', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			// The window away for most of the wait, back a few seconds before it is over
			const back = new DeferredPromise<void>();
			world.terminals.holdInput = back.p;
			world.facade.mail.send(lead, ['@lint'], 'Report?', undefined);
			await sleep(28_000);
			world.terminals.holdInput = undefined;
			back.complete();
			await sleep(5_000);

			assert.deepStrictEqual({ rang: world.table.state.mail.rungAt.has(2), told: world.facadeMessagesTo(1, 'unread') }, {
				rang: true,
				told: ['@lint #a2 has not fetched #m2 after 32 seconds: its doorbell waited for the window, which was away, and rang 4 seconds ago. The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. Call read_screen with agent #a2 to see whether it is still at what came meanwhile. Do not resend the messages.']
			});
		});

		test('a mailbox is summed up by its ten oldest unread messages and a count of the rest: in ps, and when they wait unfetched', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			for (let i = 1; i <= 12; i++) {
				world.facade.mail.send(lead, ['@lint'], `Message ${i}.`, undefined);
			}
			await sleep(33_000);
			const mailbox = world.facade.mail.mailboxOf(2, lead);

			assert.deepStrictEqual({ listed: mailbox?.unread.map(message => message.id), more: mailbox?.more, told: world.facadeMessagesTo(1, 'unread').map(text => text.split(' after ')[0]) }, {
				listed: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
				more: 2,
				told: ['@lint #a2 has not fetched #m2, #m3, #m4, #m5, #m6, #m7, #m8, #m9, #m10, #m11, and 2 more']
			});
		});

		test('an agent whose own message to itself waits is not told of it, nor is anyone else', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { children: [lint] } = await team('lint');
			world.facade.mail.send(lint, ['@lint'], 'Note to self.', undefined);
			await sleep(5 * 60_000);

			assert.deepStrictEqual({ lint: world.facadeMessagesTo(2, 'unread'), lead: world.facadeMessagesTo(1, 'unread'), person: world.person.notified.length }, { lint: [], lead: [], person: 0 });
		});

		test('the clock of messages waiting starts at their first doorbell: one that waits for the minute since the doorbell before is told of a timeout after that minute', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'First.', undefined);
			await sleep(3_000);
			world.facade.mail.send(lead, ['@lint'], 'Second.', undefined);
			// The first fetched by its number, the second waits for the doorbell a minute after the first's
			await world.fetched(2, { ids: ['#m2'] });
			await sleep(40_000);
			const early = world.facadeMessagesTo(1, 'unread').length;
			await sleep(60_000);

			assert.deepStrictEqual({ early, told: world.facadeMessagesTo(1, 'unread').map(text => text.split(' after ')[0]) }, {
				early: 0,
				told: ['@lint #a2 has not fetched #m3']
			});
		});
	});

	suite('returning', () => {

		test('a recipient that ends gives back each unread message to its sender, as a message from Facade with its text, saying how it ended; the message, fetched by number, is returned', async () => {
			const { lead, children: [lint] } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'First.', undefined);
			world.facade.mail.send(lead, ['@lint'], 'Second.', undefined);
			world.terminals.end(terminalOf(2), { byThePerson: true });
			// The notice of its end waits a moment for its last screen; what it did not fetch goes back at once
			await sleep(1_000);
			const back = await world.fetched(1);
			const original = await world.fetched(1, { ids: ['#m2'] });

			assert.deepStrictEqual({ back: texts(back), original: shown(original), lint: lint.name }, {
				back: [
					'#m2 was returned because @lint #a2 ended without fetching it (stopped by @human: its terminal tab was closed).\nOriginal message:\nFirst.',
					'#m3 was returned because @lint #a2 ended without fetching it (stopped by @human: its terminal tab was closed).\nOriginal message:\nSecond.',
					'@lint #a2 ended: stopped by @human: its terminal tab was closed. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a2 to find out why.'
				],
				original: ['#m2 returned from @lead #a1 to @lint #a2: First.'],
				lint: 'lint'
			});
		});

		test('a child another agent stopped is told of to its creator with how it ended, by whom, and its CLI\'s exit code where the window saw one (M8); a message it had not fetched goes back saying how it ended, without the code (M6)', async () => {
			const { lead, children: [, docs] } = await team('lint', 'docs');
			world.facade.mail.send(lead, ['@lint'], 'Check it.', undefined);
			world.terminals.exitCodes.set(2, 143);
			await world.facade.stopAgent(docs, '@lint');
			await sleep(1_000);

			assert.deepStrictEqual(world.facadeMessagesTo(lead.id ?? 0, 'unread').map(text => text.split('.')[0]), ['#m3 was returned because @lint #a2 ended without fetching it (stopped by @docs #a3 with stop_agent)', '@lint #a2 ended: stopped by @docs #a3 with stop_agent, with CLI exit code 143']);
		});

		test('one whose sender ended goes back to nobody, and nobody is told: its chat room notes it; neither does one of Facade\'s; one the person sent goes back to them', async () => {
			const { lead, children: [lint] } = await team('lint', 'docs');
			world.facade.mail.send(lint, ['@docs'], 'From lint.', undefined);
			world.facade.mail.send(PERSON, ['@docs'], 'From you.', undefined);
			world.terminals.end(terminalOf(2), { exitCode: 0, byThePerson: false });
			world.terminals.end(terminalOf(3), { exitCode: 0, byThePerson: false });
			await sleep(1_000);
			const room = fs.readFileSync(path.join(dir, 'rooms', 'lead-a1.md'), 'utf8');

			assert.deepStrictEqual({
				notes: room.split('\n').filter(line => line.startsWith('>')),
				person: world.person.notified.map(each => each.text),
				// Told of both ends, and nothing more
				lead: world.facadeMessagesTo(lead.id ?? 0, 'unread').map(text => text.split(':')[0])
			}, {
				notes: ['> #m3 was not fetched by @docs #a3 before the recipient ended (it exited with code 0). It could not be returned: its sender, @lint #a2, has already ended.'],
				person: ['Facade: #m4 was returned because @docs #a3 ended without fetching it (it exited with code 0).'],
				lead: ['@lint #a2 ended', '@docs #a3 ended']
			});
		});
	});

	suite('a start that fails', () => {

		test('a start that fails as its start waits is said by the start: its creator gets no notice of the end (M8) - nor of a child starting that the person closed - but its task, unfetched, goes back to it as any unread message does, the person\'s to them (M6)', async () => {
			const { lead } = await team();
			const failing = world.facade.startAgent(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Fail.', name: 'fails' });
			await until(() => world.terminals.launched.length === 2);
			const rootFailing = world.facade.startAgent(PERSON, { cli: 'arg', model: 'small', effort: 'high', task: 'Fail too.', name: 'alone', folder: work });
			await until(() => world.terminals.launched.length === 3);
			const closing = world.facade.startAgent(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Closed.', name: 'closed' });
			await until(() => world.terminals.launched.length === 4);
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			world.terminals.end(terminalOf(3), { exitCode: 1, byThePerson: false });
			world.terminals.end(terminalOf(4), { byThePerson: true });
			const [failed, rootFailed, closed] = [await outcomeOf(failing), await outcomeOf(rootFailing), await outcomeOf(closing)];
			await sleep(2_000);
			const mail = world.table.state.mail;

			assert.deepStrictEqual({
				failed,
				rootFailed,
				closed,
				lead: (mail.mailboxes.get(1) ?? []).filter(id => mail.entries.get(id)?.state === 'unread').map(id => `#m${id} ${mail.messages.get(id)?.facade}`),
				returns: [...mail.returns.values()].map(returned => `${returned.known ? 'noted' : returned.as === undefined ? 'unreturned' : 'returned'}: ${returned.reason}`),
				person: world.person.notified.map(notification => notification.text)
			}, {
				failed: 'FAILED: Arg Code did not start as @fails #a2: its CLI ended with exit code 1',
				rootFailed: 'FAILED: Arg Code did not start as @alone #a3: its CLI ended with exit code 1',
				closed: 'FAILED: Arg Code did not start as @closed #a4: its terminal tab was closed',
				// Its tasks back, and no notice of the ends
				lead: ['#m4 returned', '#m6 returned'],
				returns: ['returned: it did not start: its CLI ended with exit code 1', 'returned: it did not start: its CLI ended with exit code 1', 'returned: stopped by @human: its terminal tab was closed'],
				person: ['Facade: #m2 was returned because @alone #a3 ended without fetching it (it did not start: its CLI ended with exit code 1).']
			});
		});
	});

	suite('the person', () => {

		test('a message to the person is a notification - its sender has something for them, its first line, and Show - quiet while that agent\'s terminal has their focus, updated by the next from the same agent; Show puts its terminal in front, or, the agent ended, opens it in its chat room; it rings no doorbell and is never returned', async () => {
			const { children: [lint] } = await team('lint');
			world.facade.mail.send(lint, ['@human'], '\nThe tests pass.\nDetails: none.', undefined);
			const first = world.person.shown.get('message:2');
			world.facade.mail.send(lint, ['@human'], 'And the docs build.', undefined);
			const second = world.person.shown.get('message:2');
			world.person.press('message:2', 'Show');
			await sleep(10);
			world.facade.mail.send(lint, ['@human'], 'Bye.', undefined);
			world.terminals.end(terminalOf(2), { exitCode: 0, byThePerson: false });
			world.person.press('message:2', 'Show');
			await sleep(10);

			assert.deepStrictEqual({ first, second: second?.text, revealed: world.terminals.revealed, opened: world.person.opened, unread: world.table.state.mail.entries.get(4)?.state, returns: world.table.state.mail.returns.size }, {
				first: { key: 'message:2', text: '@lint #a2 sent you a message: The tests pass.', buttons: ['Show'], quietIn: 2 },
				second: '@lint #a2 sent you a message: And the docs build.',
				revealed: [2],
				opened: ['lead-a1.md #m4'],
				unread: 'delivered',
				returns: 0
			});
		});

		test('Show on a message of an agent that ended, its chat room deleted since, says it is in no chat room any more', async () => {
			const { children: [lint] } = await team('lint');
			world.facade.mail.send(lint, ['@human'], 'Done.', undefined);
			world.terminals.end(terminalOf(2), { exitCode: 0, byThePerson: false });
			world.facade.mail.deleteRooms();
			world.person.press('message:2', 'Show');
			await sleep(10);

			assert.deepStrictEqual({ opened: world.person.opened, told: world.person.told }, {
				opened: [],
				told: ['information: Message #m2 is no longer available because the chat rooms were deleted.']
			});
		});
	});

	suite('reload, closing, Facade off', () => {

		test('an agent that has not fetched its task, whose creator ended, holds up the messages of others too: their senders are told, with no task notice to stand for it (M6)', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead, children: [docs] } = await team('docs');
			await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'stuck', task: 'Stuck.' });
			// Sent while its creator runs - the warning held back for the task's notice - and its creator ending then
			world.facade.mail.send(docs, ['@stuck'], 'Docs are done.', undefined);
			await sleep(5_000);
			world.terminals.end(terminalOf(1), { exitCode: 0, byThePerson: false });
			await sleep(5 * 60_000);

			assert.deepStrictEqual(world.facadeMessagesTo(docs.id ?? 0, 'unread').map(text => text.split(' after ')[0]), ['@stuck #a3 has not fetched #m2, #m3']);
		});

		test('a child still starting as the window reloads, which then fails, is told of to its creator - its end, and its task back - as any child: the call that waited for it went with the window (M6, M8)', async () => {
			world.timing.startTimeoutMs = 60_000;
			await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'lead', folder: work });
			const lead = callerOf(world.agent(1));
			const starting = world.facade.startAgent(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Lint.', name: 'lint' });
			starting.catch(() => undefined);
			await until(() => world.terminals.launched.length === 2);
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			world.timing.startTimeoutMs = 60_000;
			world.terminals.running.add(terminalOf(1));
			world.terminals.running.add(terminalOf(2));
			await world.facade.recover(true);
			world.terminals.end(terminalOf(2), { exitCode: 1, byThePerson: false });
			await sleep(1_000);

			assert.deepStrictEqual(world.facadeMessagesTo(1, 'unread').map(text => text.split('\n')[0]), [
				'#m1 was returned because @lint #a2 ended without fetching it (it did not start: its CLI ended with exit code 1).',
				'@lint #a2 ended: it did not start: its CLI ended with exit code 1. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a2 to find out why.'
			]);
		});

		test('what waits unfetched is told of on the clock the ledger has, which a reload does not start again; told of, it is not told of again after another', async () => {
			const reload = async () => {
				world.dispose();
				world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
				world.timing.startTimeoutMs = 30_000;
				for (const id of [1, 2, 3]) {
					world.terminals.running.add(terminalOf(id));
				}
				await world.facade.recover(true);
			};
			const notices = () => world.facadeMessagesTo(1, 'unread').map(text => text.split(/ since | after /)[0]);
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'stuck', task: 'Stuck.' });
			world.facade.mail.send(lead, ['@lint'], 'Report?', undefined);
			await sleep(20_000);
			await reload();
			await sleep(14_000);
			const onTime = notices();
			await reload();
			await sleep(5 * 60_000);

			assert.deepStrictEqual({ onTime, after: notices() }, {
				onTime: ['@stuck #a3 has not fetched task #m2', '@lint #a2 has not fetched #m3'],
				after: ['@stuck #a3 has not fetched task #m2', '@lint #a2 has not fetched #m3']
			});
		});

		test('a reload changes nothing: what is unread, a fetch whose result was on its way given again, unread still, and the doorbells\' times, as the ledger has them', async () => {
			const { lead, children: [lint] } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'One.', undefined);
			await sleep(3_000);
			const firstRing = ringsOf(2).length;
			await world.facade.mail.fetch(lint, {}, () => undefined);
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			world.terminals.running.add(terminalOf(1));
			world.terminals.running.add(terminalOf(2));
			await world.facade.recover(true);
			await sleep(50_000);
			const before = ringsOf(2).length;
			await sleep(10_000);
			const again = await world.fetched(2);

			assert.deepStrictEqual({ firstRing, before, at: ringsOf(2).length, again: shown(again) }, {
				firstRing: 1,
				before: 0,
				at: 1,
				again: ['#m2 unread from @lead #a1: One.']
			});
		});

		test('closing the window ends the agents together, whose unread messages go nowhere - their senders ended too - and the chat rooms say so; opened again, the mailboxes are empty, numbers go on, the rooms are there', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Unread.', undefined);
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			await world.facade.recover();
			await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'next', folder: work, task: 'Next.' });
			const room = fs.readFileSync(path.join(dir, 'rooms', 'lead-a1.md'), 'utf8');

			assert.deepStrictEqual({ mailboxes: [...world.table.state.mail.mailboxes.keys()], next: world.table.state.mail.lastMessage, notes: room.split('\n').filter(line => line.startsWith('>')) }, {
				mailboxes: [3],
				next: 3,
				notes: ['> #m2 was not fetched by @lint #a2 before the recipient ended (stopped: its window closed). It could not be returned: its sender, @lead #a1, has already ended.']
			});
		});

		test('Facade off: no doorbell rings; on again, they go on, and an agent that ended meanwhile is told of to its creator, its unread messages returned', async () => {
			// The same load of the window: Facade turned off and on in it
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] }, session: 'this-window' });
			const { lead } = await team('lint', 'docs');
			world.facade.mail.send(lead, ['@lint', '@docs'], 'While off.', undefined);
			world.dispose('facade');
			await sleep(5 * 60_000);
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] }, session: 'this-window' });
			world.terminals.running.add(terminalOf(1));
			world.terminals.running.add(terminalOf(2));
			await world.facade.recover();
			await sleep(3_000);
			const back = await world.fetched(1);

			assert.deepStrictEqual({ lint: ringsOf(2).length, back: texts(back).map(text => text.split('\n')[0]) }, {
				lint: 1,
				back: [
					'#m4 was returned because @docs #a3 ended without fetching it (it was lost: its terminal was missing when Facade restarted).',
					'@docs #a3 ended: it was lost: its terminal was missing when Facade restarted. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a3 to find out why.'
				]
			});
		});
	});

	suite('the agent framework switched in the window', () => {

		test('turned off - the window and its core staying - no doorbell rings and nothing is told of as unfetched; turned on again, the doorbells go on, and what waits is timed from then (M10)', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			world.switches.framework = false;
			world.facade.frameworkChanged();
			world.facade.mail.send(lead, ['@lint'], 'While off.', undefined);
			await sleep(5 * 60_000);
			const whileOff = { rings: ringsOf(2).length, told: world.facadeMessagesTo(1, 'unread').length };
			world.switches.framework = true;
			world.facade.frameworkChanged();
			await sleep(3_000);
			const rung = ringsOf(2);
			await sleep(20_000);
			const early = world.facadeMessagesTo(1, 'unread').length;
			await sleep(15_000);

			assert.deepStrictEqual({ whileOff, rung, early, told: world.facadeMessagesTo(1, 'unread').map(text => text.split(' after ')[0]) }, {
				whileOff: { rings: 0, told: 0 },
				rung: ['[facade] 1 unread message: #m2 from @lead #a1. Call read_messages.'],
				early: 0,
				told: ['@lint #a2 has not fetched #m2']
			});
		});

		test('a doorbell goes to the window as input the agent framework makes, and one whose turn comes with the framework off is dropped there: nothing rang, nothing is tried again while it is off, and it rings as soon as it is on again (M10; L13)', async () => {
			const { lead } = await team('lint');
			// Its line waits its turn behind other input of the window's, and the person turns the framework off meanwhile
			let turn = () => { };
			world.terminals.typing = new Promise<void>(resolve => turn = resolve);
			world.facade.mail.send(lead, ['@lint'], 'As it turns off.', undefined);
			await sleep(2_100);
			world.switches.framework = false;
			world.facade.frameworkChanged();
			world.terminals.nextInput.push({ outcome: 'not_applied', reason: 'frameworkOff', pasted: false, entered: false });
			turn();
			await sleep(10_000);
			const whileOff = { rings: world.table.state.mail.entries.get(2)?.rings, tries: world.terminals.typeOptions.length };
			world.switches.framework = true;
			world.facade.frameworkChanged();
			await sleep(1_000);

			assert.deepStrictEqual({
				asked: world.terminals.typeOptions.map(options => options.requiresFramework),
				whileOff,
				rings: world.table.state.mail.entries.get(2)?.rings,
				logged: world.logs.filter(line => line.startsWith('Doorbell for @lint #a2'))
			}, {
				asked: [true, true],
				whileOff: { rings: 0, tries: 1 },
				rings: 1,
				logged: ['Doorbell for @lint #a2 was not sent: the agent framework was disabled when its turn arrived. Delivery resumes when the framework is enabled.']
			});
		});

		test('turned off, a message to the person - theirs, given back by an agent that ended meanwhile - is recorded, and kept in its chat room, but not shown to them; turned on again, it is (M10; M3)', async () => {
			await team('lint');
			world.facade.mail.send(PERSON, ['@lint'], 'Rebase onto main.', undefined);
			world.switches.framework = false;
			world.facade.frameworkChanged();
			world.terminals.end(terminalOf(2), { exitCode: 0, byThePerson: false });
			await sleep(1_000);
			const whileOff = { shown: world.person.notified.map(each => each.text), returned: world.table.state.mail.returns.get(2)?.as };
			world.switches.framework = true;
			world.facade.frameworkChanged();

			assert.deepStrictEqual({ whileOff, shown: world.person.notified.map(each => each.text.split(' (')[0]) }, {
				whileOff: { shown: [], returned: 3 },
				shown: ['Facade: #m2 was returned because @lint #a2 ended without fetching it']
			});
		});

		test('turned off, a message to the person is held in the record, unread, not shown; a reload while it is off keeps it so, and turned on again it is shown and recorded delivered - once (M10; M3; MS-03)', async () => {
			const { lead } = await team();
			world.switches.framework = false;
			world.facade.frameworkChanged();
			const sent = world.facade.mail.send(lead, ['@human'], 'Pick red or blue.', undefined);
			const id = sent[0].id;
			const whileOff = { shown: world.person.notified.length, state: world.table.state.mail.entries.get(id)?.state };
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			world.switches.framework = false;
			world.terminals.running.add(terminalOf(1));
			await world.facade.recover(true);
			const reloaded = { shown: world.person.notified.length, state: world.table.state.mail.entries.get(id)?.state };
			world.switches.framework = true;
			world.facade.frameworkChanged();
			world.facade.frameworkChanged();

			assert.deepStrictEqual({ whileOff, reloaded, on: { shown: world.person.notified.map(each => each.text), state: world.table.state.mail.entries.get(id)?.state } }, {
				whileOff: { shown: 0, state: 'unread' },
				reloaded: { shown: 0, state: 'unread' },
				on: { shown: ['@lead #a1 sent you a message: Pick red or blue.'], state: 'delivered' }
			});
		});

		test('turned off without its switch reaching the doorbells - window.json not written, say - a task and messages that wait unfetched are not told of while it is off; on again, they are, timed from then (M10)', async () => {
			world.timing.startTimeoutMs = 30_000;
			const { lead } = await team('lint');
			await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', name: 'stuck', task: 'Stuck.' });
			world.facade.mail.send(lead, ['@lint'], 'Unfetched.', undefined);
			// The setting says off; what it would have stopped was not told
			world.switches.framework = false;
			await sleep(60_000);
			const whileOff = world.facadeMessagesTo(1, 'unread');
			world.switches.framework = true;
			world.facade.frameworkChanged();
			await sleep(29_000);
			const early = world.facadeMessagesTo(1, 'unread');
			await sleep(2_000);

			assert.deepStrictEqual({ whileOff, early, told: world.facadeMessagesTo(1, 'unread').map(text => text.split(/ since | after /)[0]).sort() }, {
				whileOff: [],
				early: [],
				told: ['@lint #a2 has not fetched #m3', '@stuck #a3 has not fetched task #m2']
			});
		});
	});

	suite('after a fresh start', () => {

		test('the agents that ended have left the list, not the chat rooms: a message of theirs fetched by number names its room, and Open Chat Room lists it under the agent the person started, ended (M4, M9; L12)', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'Old.', undefined);
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			await world.facade.recover();
			await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', name: 'next', folder: work });
			const refused = await world.fetched(3, { ids: ['#m2'] }).then(() => 'fetched', err => messageOf(err));

			assert.deepStrictEqual({
				listed: [...world.table.state.agents.keys()],
				refused,
				rooms: world.facade.mail.rooms.list().map(room => `${room.root.name} #a${room.root.id} ${room.live ? 'running' : 'ended'}: ${room.messages}`)
			}, {
				listed: [3],
				refused: `Message #m2 predates this window's current session. Its only copy is in chat room ${path.join(dir, 'rooms', 'lead-a1.md')}.`,
				rooms: ['lead #a1 ended: 2']
			});
		});
	});

	suite('the files', () => {

		test('Delete Chat Rooms: the rooms go for good, and none is written again as the window loads; the long texts this session\'s mailboxes give stay; a fresh start of the window takes what nothing needs any more', async () => {
			const { lead } = await team('lint');
			world.facade.mail.send(lead, ['@lint'], 'd'.repeat(TEXT_IN_LINE + 1), undefined);
			world.facade.mail.send(lead, ['@human'], 'e'.repeat(TEXT_IN_LINE + 1), undefined);
			world.facade.mail.deleteRooms();
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			world.terminals.running.add(terminalOf(1));
			world.terminals.running.add(terminalOf(2));
			await world.facade.recover(true);
			const fetched = await world.fetched(2);
			const files = fs.readdirSync(path.join(dir, 'messages'));
			world.dispose();
			world = fakeWorld(dir, { repositories: { [lab]: ['work'] } });
			await world.facade.recover();

			assert.deepStrictEqual({ rooms: fs.existsSync(path.join(dir, 'rooms')), files, text: fetched.messages[0]?.length, deleted: world.table.state.mail.roomsDeletedUpTo, person: HUMAN, fresh: fs.readdirSync(path.join(dir, 'messages')) }, {
				rooms: false,
				files: ['fetch-a2-1.txt', 'm2.txt', 'm3.txt'],
				text: TEXT_IN_LINE + 1,
				deleted: 3,
				person: 'human',
				fresh: []
			});
		});
	});
});
