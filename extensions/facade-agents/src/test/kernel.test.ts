/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Kernel, KernelError } from '../common/kernel/kernel';
import { LEDGER_FILE, Ledger, LedgerLockedError } from '../common/kernel/ledger';
import { Caller, YOU } from '../common/kernel/model';
import { pagePath, parseAddresses } from '../common/kernel/names';
import { pageFile } from '../common/kernel/notebook';
import { workspaceDir } from '../common/kernel/workspace';
import { tempDir } from './util';

function open(dir: string): Kernel {
	return Kernel.open({ dir });
}

function agent(kernel: Kernel, name: string, groups: string[] = [], startedBy?: string): Caller {
	const added = kernel.addAgent({ name, agent: 'fake', groups, startedBy });
	return { name: added.name, incarnation: added.incarnation };
}

const you: Caller = { name: YOU, incarnation: 1 };

function texts(kernel: Kernel, name: string): string[] {
	return kernel.messagesAfter(name, 0, 1000).map(message => message.text);
}

suite('Kernel: participants and messages', () => {

	let temp: { dir: string; remove(): void };
	let kernel: Kernel;

	setup(() => {
		temp = tempDir('facade-kernel-');
		kernel = open(temp.dir);
	});

	teardown(() => {
		kernel.dispose();
		temp.remove();
	});

	test('the person is always there, with a token that survives a reload', () => {
		assert.deepStrictEqual(kernel.who().map(view => view.name), [YOU]);
		const token = fs.readFileSync(path.join(temp.dir, 'you.token'), 'utf8');
		assert.strictEqual(token, kernel.youToken);
		assert.deepStrictEqual(kernel.authenticate(token), { name: YOU, incarnation: 1 });
		kernel.dispose();
		kernel = open(temp.dir);
		assert.strictEqual(kernel.youToken, token);
		assert.deepStrictEqual(kernel.authenticate(token), { name: YOU, incarnation: 1 });
	});

	test('messages reach @names and the members of #groups, in order, and recv moves the cursor', async () => {
		const a = agent(kernel, 'a');
		const b = agent(kernel, 'b', ['team']);
		agent(kernel, 'c');
		kernel.send(a, '#team', 'to the team');
		kernel.send(a, ['@c', '#team'], 'to c and the team');
		kernel.send(b, '@a', 'back to a');
		assert.deepStrictEqual(texts(kernel, 'b'), ['to the team', 'to c and the team']);
		assert.deepStrictEqual(texts(kernel, 'c'), ['to c and the team']);
		assert.deepStrictEqual(texts(kernel, 'a'), ['back to a']);
		assert.strictEqual(kernel.unread('b'), 2);
		const first = await kernel.recv(b, { limit: 1 });
		assert.deepStrictEqual(first.messages.map(message => message.text), ['to the team']);
		assert.strictEqual(first.more, true);
		assert.strictEqual(kernel.unread('b'), 1);
		const second = await kernel.recv(b, {});
		assert.deepStrictEqual(second.messages.map(message => message.text), ['to c and the team']);
		assert.strictEqual(second.more, false);
		assert.strictEqual((await kernel.recv(b, {})).messages.length, 0);
		// Re-reading from the start does not move the cursor back.
		const again = await kernel.recv(b, { after: 0 });
		assert.strictEqual(again.messages.length, 2);
		assert.strictEqual(kernel.unread('b'), 0);
		assert.strictEqual(second.messages[0].from, 'a');
		assert.deepStrictEqual(second.messages[0].to, ['@c', '#team']);
	});

	test('a message to nobody known is refused; a group nobody is in, or a stopped agent, is reported', () => {
		const a = agent(kernel, 'a');
		assert.throws(() => kernel.send(a, '@ghost', 'hello'), (err: KernelError) => err.code === 'NOT_FOUND' && /@ghost/.test(err.message));
		assert.throws(() => kernel.send(a, '@you', '   '), (err: KernelError) => err.code === 'INVALID');
		assert.deepStrictEqual(kernel.send(a, '#nobody', 'anyone?').emptyGroups, ['#nobody']);
		const b = agent(kernel, 'b');
		kernel.setState(b.name, b.incarnation, 'stopped');
		assert.deepStrictEqual(kernel.send(a, '@b', 'later').stopped, ['b']);
		assert.throws(() => kernel.send(a, '@b', 'reply', 999), (err: KernelError) => err.code === 'NOT_FOUND');
	});

	test('recv waits for a message and wakes when one comes; a wait with none times out', async () => {
		const a = agent(kernel, 'a');
		const b = agent(kernel, 'b');
		const waiting = kernel.recv(b, { waitSec: 20 });
		setTimeout(() => kernel.send(a, '@b', 'wake up'), 50);
		const woken = await waiting;
		assert.deepStrictEqual(woken.messages.map(message => message.text), ['wake up']);
		assert.strictEqual(woken.timedOut, false);
		const started = Date.now();
		const quiet = await kernel.recv(b, { waitSec: 1 });
		assert.strictEqual(quiet.messages.length, 0);
		assert.strictEqual(quiet.timedOut, true);
		assert.ok(Date.now() - started >= 900);
		const controller = new AbortController();
		const cancelled = kernel.recv(b, { waitSec: 20 }, controller.signal);
		controller.abort();
		await assert.rejects(cancelled, /Cancelled/);
	});

	test('a new incarnation keeps the name and its messages; the old token stops working', async () => {
		const a = agent(kernel, 'a');
		const first = kernel.addAgent({ name: 'w', agent: 'fake' });
		kernel.send(a, '@w', 'for whoever is w');
		const second = kernel.addAgent({ name: 'w', agent: 'other' });
		assert.strictEqual(second.incarnation, 2);
		assert.strictEqual(kernel.authenticate(first.token), undefined);
		assert.deepStrictEqual(kernel.authenticate(second.token), { name: 'w', incarnation: 2 });
		const got = await kernel.recv({ name: 'w', incarnation: 2 }, {});
		assert.deepStrictEqual(got.messages.map(message => message.text), ['for whoever is w']);
		assert.strictEqual(kernel.who().find(view => view.name === 'w')!.agent, 'other');
	});

	test('groups are joined and left; who lists a group', () => {
		const a = agent(kernel, 'a');
		assert.deepStrictEqual(kernel.join(a, '#P1'), ['a']);
		assert.deepStrictEqual(kernel.join(you, 'p1'), ['you', 'a']);
		assert.deepStrictEqual(kernel.who('p1').map(view => view.name), ['you', 'a']);
		assert.deepStrictEqual(kernel.leave(a, 'p1'), ['you']);
		assert.throws(() => kernel.join(a, '#no spaces'), (err: KernelError) => err.code === 'INVALID');
	});

	test('the one who started an agent hears when it starts, waits, ends a turn and stops; its token ends with it', async () => {
		const added = kernel.addAgent({ name: 'f2', agent: 'codex', startedBy: YOU });
		kernel.setState('f2', 1, 'working');
		kernel.setState('f2', 1, 'waiting', 'a permission prompt');
		kernel.setState('f2', 1, 'working');
		kernel.setState('f2', 1, 'idle');
		kernel.setState('f2', 1, 'stopped', 'its process exited');
		kernel.setState('f2', 1, 'working');
		assert.deepStrictEqual(texts(kernel, YOU), [
			'@f2 started working.',
			'@f2 is waiting in its terminal: a permission prompt',
			'@f2 finished its turn.',
			'@f2 stopped: its process exited'
		]);
		assert.strictEqual(kernel.who().find(view => view.name === 'f2')!.state, 'stopped');
		assert.strictEqual(kernel.authenticate(added.token), undefined);
		const got = await kernel.recv(you, {});
		assert.ok(got.messages.every(message => message.notice && message.from === 'facade'));
	});

	test('free names count up per prefix', () => {
		agent(kernel, 'codex-1');
		assert.strictEqual(kernel.freeName('codex'), 'codex-2');
		assert.strictEqual(kernel.freeName('Claude Code'), 'claude-code-1');
	});
});

suite('Kernel: the notebook', () => {

	let temp: { dir: string; remove(): void };
	let kernel: Kernel;

	setup(() => {
		temp = tempDir('facade-notebook-');
		kernel = open(temp.dir);
	});

	teardown(() => {
		kernel.dispose();
		temp.remove();
	});

	test('replace, append and create; empty text deletes; versions keep counting', () => {
		const a = agent(kernel, 'a');
		assert.deepStrictEqual(kernel.write(a, 'P1/Plan.md', 'first'), { ok: true, page: 'p1/plan', version: 1, deleted: false });
		assert.strictEqual(fs.readFileSync(pageFile(kernel.notesDir, 'p1/plan'), 'utf8'), 'first');
		kernel.write(a, 'p1/log', 'one', 'append');
		kernel.write(a, 'p1/log', 'two', 'append');
		assert.strictEqual(kernel.read(a, 'p1/log').text, 'one\ntwo\n');
		const exists = kernel.write(a, 'p1/plan', 'again', 'create');
		assert.strictEqual(exists.ok, false);
		assert.strictEqual(!exists.ok && exists.reason, 'exists');
		assert.deepStrictEqual(kernel.write(a, 'p1/plan', ''), { ok: true, page: 'p1/plan', version: 2, deleted: true });
		assert.ok(!fs.existsSync(pageFile(kernel.notesDir, 'p1/plan')));
		assert.throws(() => kernel.read(a, 'p1/plan'), (err: KernelError) => err.code === 'NOT_FOUND' && /p1\/log/.test(err.message));
		const missing = kernel.write(a, 'p1/plan', '');
		assert.strictEqual(!missing.ok && missing.reason, 'missing');
		assert.deepStrictEqual(kernel.write(a, 'p1/plan', 'back', 'create'), { ok: true, page: 'p1/plan', version: 3, deleted: false });
		assert.deepStrictEqual(kernel.list(a, 'p1').map(entry => [entry.page, entry.version, entry.author]), [['p1/log', 2, 'a'], ['p1/plan', 3, 'a']]);
		assert.deepStrictEqual(kernel.list(a, '').map(entry => entry.page), ['p1/log', 'p1/plan']);
	});

	test('if_version refuses a write over a change the writer has not seen, and hands back the current page', () => {
		const a = agent(kernel, 'a');
		const b = agent(kernel, 'b');
		kernel.write(a, 'p1/plan', 'v1');
		const seenByA = kernel.read(a, 'p1/plan').version;
		const seenByB = kernel.read(b, 'p1/plan').version;
		assert.strictEqual(kernel.write(b, 'p1/plan', 'b edit', 'replace', seenByB).ok, true);
		const refused = kernel.write(a, 'p1/plan', 'a edit', 'replace', seenByA);
		assert.strictEqual(refused.ok, false);
		assert.strictEqual(!refused.ok && refused.reason, 'conflict');
		assert.deepStrictEqual(!refused.ok && refused.current && [refused.current.version, refused.current.text, refused.current.author], [2, 'b edit', 'b']);
		assert.strictEqual(kernel.write(a, 'p1/plan', 'a edit on top', 'replace', 2).ok, true);
		// Version 0 means "only if there is no such page".
		assert.strictEqual(kernel.write(a, 'p1/new', 'x', 'replace', 0).ok, true);
		assert.strictEqual(kernel.write(a, 'p1/new', 'y', 'replace', 0).ok, false);
	});

	test('two agents taking one task with a create-only write: one gets it, the other sees who has it', () => {
		const codex = agent(kernel, 'codex-1');
		const claude = agent(kernel, 'claude-2');
		const first = kernel.write(codex, 'p1/owner/f2', '@codex-1', 'create');
		const second = kernel.write(claude, 'p1/owner/f2', '@claude-2', 'create');
		assert.strictEqual(first.ok, true);
		assert.strictEqual(second.ok, false);
		assert.deepStrictEqual(!second.ok && second.current && [second.current.text, second.current.author], ['@codex-1', 'codex-1']);
		// Releasing is writing it empty; then it can be taken again.
		kernel.write(codex, 'p1/owner/f2', '');
		assert.strictEqual(kernel.write(claude, 'p1/owner/f2', '@claude-2', 'create').ok, true);
	});

	test('a reader hears once when someone else changes a page; the writer never does; reading again arms the next', () => {
		const a = agent(kernel, 'a');
		const b = agent(kernel, 'b');
		kernel.write(b, 'p1/plan', 'v1');
		kernel.read(a, 'p1/plan');
		kernel.write(b, 'p1/plan', 'v2');
		kernel.write(b, 'p1/plan', 'v3');
		assert.deepStrictEqual(texts(kernel, 'a'), ['p1/plan changed: version 2, by @b.']);
		assert.deepStrictEqual(texts(kernel, 'b'), []);
		kernel.read(a, 'p1/plan');
		kernel.write(b, 'p1/plan', '');
		assert.deepStrictEqual(texts(kernel, 'a'), ['p1/plan changed: version 2, by @b.', 'p1/plan was deleted by @b.']);
		// A writer that reads its own page again is armed like anyone else.
		kernel.write(a, 'p1/other', 'x');
		kernel.write(b, 'p1/other', 'y');
		assert.strictEqual(texts(kernel, 'a').at(-1), 'p1/other changed: version 2, by @b.');
	});

	test('listing a folder arms one notice for a page that comes or goes in it', () => {
		const a = agent(kernel, 'a');
		const b = agent(kernel, 'b');
		assert.deepStrictEqual(kernel.list(a, 'p1/results'), []);
		kernel.write(b, 'p1/results/f2', 'done');
		kernel.write(b, 'p1/results/f3', 'done');
		kernel.write(b, 'elsewhere', 'x');
		assert.deepStrictEqual(texts(kernel, 'a'), ['New page p1/results/f2, by @b.']);
		kernel.list(a, 'p1');
		kernel.write(b, 'p1/results/f2', 'changed');
		kernel.write(b, 'p1/results/f3', '');
		assert.deepStrictEqual(texts(kernel, 'a'), ['New page p1/results/f2, by @b.', 'p1/results/f3 was deleted by @b.']);
	});

	test('a page file changed, made or removed directly is a version without an author, and its readers hear of it', () => {
		const a = agent(kernel, 'a');
		kernel.write(a, 'p1/plan', 'mine');
		const b = agent(kernel, 'b');
		kernel.read(b, 'p1/plan');
		kernel.list(b, 'notes');
		fs.writeFileSync(pageFile(kernel.notesDir, 'p1/plan'), 'edited in the editor');
		fs.mkdirSync(path.join(kernel.notesDir, 'notes'), { recursive: true });
		fs.writeFileSync(pageFile(kernel.notesDir, 'notes/idea'), 'a new one');
		fs.writeFileSync(path.join(kernel.notesDir, 'Upper.md'), 'not a page Facade can name');
		kernel.scanNotebook();
		const plan = kernel.read(b, 'p1/plan');
		assert.deepStrictEqual([plan.text, plan.version, plan.author], ['edited in the editor', 2, undefined]);
		// The files are looked at in the order of their paths.
		assert.deepStrictEqual(texts(kernel, 'b'), ['New page notes/idea, edited directly, outside Facade.', 'p1/plan changed: version 2, edited directly, outside Facade.']);
		// The writer hears of a direct edit too: it was not theirs.
		assert.deepStrictEqual(texts(kernel, 'a'), ['p1/plan changed: version 2, edited directly, outside Facade.']);
		fs.rmSync(pageFile(kernel.notesDir, 'p1/plan'));
		assert.throws(() => kernel.read(b, 'p1/plan'), (err: KernelError) => err.code === 'NOT_FOUND');
		assert.strictEqual(texts(kernel, 'b').at(-1), 'p1/plan was deleted directly, outside Facade.');
		// The host can say who made an edit: the person, saving in the editor.
		kernel.read(b, 'notes/idea');
		fs.writeFileSync(pageFile(kernel.notesDir, 'notes/idea'), 'saved by the person');
		kernel.syncPage('notes/idea', YOU);
		assert.strictEqual(kernel.read(b, 'notes/idea').author, YOU);
		assert.strictEqual(texts(kernel, 'b').at(-1), 'notes/idea changed: version 2, by @you.');
	});

	test('with the notebook watched, a direct edit is seen without anyone calling a tool', async () => {
		kernel.dispose();
		kernel = Kernel.open({ dir: temp.dir, watch: true });
		const a = agent(kernel, 'a');
		kernel.write(you, 'p1/plan', 'v1');
		kernel.read(a, 'p1/plan');
		const heard = kernel.recv(a, { waitSec: 10 });
		setTimeout(() => fs.writeFileSync(pageFile(kernel.notesDir, 'p1/plan'), 'typed in the editor'), 100);
		const got = await heard;
		assert.deepStrictEqual(got.messages.map(message => message.text), ['p1/plan changed: version 2, edited directly, outside Facade.']);
	});

	test('page paths are lower case, without .md, and never leave the notebook', () => {
		assert.strictEqual(pagePath(' /P1//Plan.md/ '), 'p1/plan');
		assert.strictEqual(pagePath('计划/第一步'), '计划/第一步');
		assert.strictEqual(pagePath('', true), '');
		for (const bad of ['', '..', 'a/../b', 'a/./b', '.hidden', 'a/b:c', 'con', 'a/nul.txt', 'trailing./x']) {
			assert.throws(() => pagePath(bad), `${bad} should be refused`);
		}
		assert.deepStrictEqual(parseAddresses('@A, #B c').map(address => [address.kind, address.name]), [['participant', 'a'], ['group', 'b'], ['participant', 'c']]);
	});
});

suite('Kernel: on disk', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-ledger-');
	});

	teardown(() => {
		temp.remove();
	});

	test('a reload loses nothing: names, tokens, messages, cursors, pages, and who is armed for a notice', async () => {
		let kernel = open(temp.dir);
		const added = kernel.addAgent({ name: 'a', agent: 'claude', groups: ['p1'], startedBy: YOU });
		const a: Caller = { name: 'a', incarnation: 1 };
		kernel.send(you, '#p1', 'hello team');
		kernel.send(you, '@a', 'hello a');
		await kernel.recv(a, { limit: 1 });
		kernel.write(you, 'p1/plan', 'the plan');
		kernel.read(a, 'p1/plan');
		kernel.dispose();

		kernel = open(temp.dir);
		assert.deepStrictEqual(kernel.authenticate(added.token), a);
		assert.strictEqual(kernel.unread('a'), 1);
		assert.deepStrictEqual((await kernel.recv(a, {})).messages.map(message => message.text), ['hello a']);
		kernel.write(you, 'p1/plan', 'changed after the reload');
		assert.strictEqual(texts(kernel, 'a').at(-1), 'p1/plan changed: version 2, by @you.');
		assert.deepStrictEqual(kernel.who('p1').map(view => view.name), ['a']);
		kernel.dispose();
	});

	test('a last line cut short by a crash is dropped, and the file is repaired', () => {
		let kernel = open(temp.dir);
		kernel.addAgent({ name: 'a', agent: 'claude' });
		const seq = kernel.state.seq;
		kernel.dispose();
		const file = path.join(temp.dir, LEDGER_FILE);
		fs.appendFileSync(file, '{"v":1,"seq":99,"type":"message.se');
		kernel = open(temp.dir);
		assert.strictEqual(kernel.state.seq, seq);
		kernel.send({ name: 'a', incarnation: 1 }, '@you', 'still works');
		assert.ok(fs.readFileSync(file, 'utf8').endsWith('"}\n') || fs.readFileSync(file, 'utf8').endsWith('}\n'));
		kernel.dispose();
		kernel = open(temp.dir);
		assert.deepStrictEqual(texts(kernel, YOU), ['still works']);
		kernel.dispose();
	});

	test('a second window is refused while the first is alive, and takes over once it is gone', () => {
		fs.mkdirSync(temp.dir, { recursive: true });
		fs.writeFileSync(path.join(temp.dir, 'ledger.lock'), '424242');
		assert.throws(() => Ledger.open(temp.dir, Date.now, () => true), LedgerLockedError);
		const ledger = Ledger.open(temp.dir, Date.now, () => false);
		ledger.close();
		assert.ok(!fs.existsSync(path.join(temp.dir, 'ledger.lock')));
	});

	test('a workspace is found by its first folder, whatever the case of its path on Windows', () => {
		const folder = path.join(temp.dir, 'My Repo');
		fs.mkdirSync(folder);
		const dir = workspaceDir('/root', folder);
		assert.match(path.basename(dir), /^My_Repo-[0-9a-f]{12}$/);
		assert.strictEqual(workspaceDir('/root', folder), dir);
		if (process.platform === 'win32') {
			assert.strictEqual(workspaceDir('/root', folder.toUpperCase()), dir);
		}
		assert.notStrictEqual(workspaceDir('/root', temp.dir), dir);
	});
});
