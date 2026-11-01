/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { MessageRecord } from '../core/messagePorts';
import { withModules } from './withModules';

const A = 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'run-cccccccccccccccccccccccccccccccc';
const T = Date.UTC(2026, 9, 28, 9);

const ada = { run: A, alias: '#a1', name: 'Ada' };
const bob = { run: B, alias: '#a2', name: 'Bob' };
const cy = { run: C, alias: '#a3', name: 'Cy' };

function record(n: number, fields: Partial<MessageRecord> & Pick<MessageRecord, 'from' | 'to'>, at: number): MessageRecord {
	return {
		id: `m-${n}`, alias: `#m${n}`, kind: 'message', window: 'win-1', environment: 'local', workspace: 'ws-1', at, text: `text ${n}`, length: 6,
		delivery: { status: 'success', effects: { outcome: 'confirmed', text_written: 'full', enter_written: true }, attempts: 1 },
		...fields
	};
}

const RECORDS: readonly MessageRecord[] = [
	record(6, { from: ada, to: cy }, T),
	record(1, { from: ada, to: bob, text: 'See [docs](command:workbench.action.quit) now.' }, T + 1_000),
	record(2, { from: bob, to: ada, replyTo: 'm-1', delivery: { status: 'failure', reason: 'input_draft', effects: { outcome: 'none', text_written: 'none', enter_written: false }, attempts: 5 } }, T + 2_000),
	record(3, { kind: 'result', from: { run: 'facade' }, to: ada, about: 'm-1' }, T + 3_000),
	record(4, { from: cy, to: { run: '@human' } }, T + 4_000),
	record(5, { kind: 'result', from: { run: 'facade' }, to: cy, callId: 'call-1' }, T + 5_000),
	// Reached Cy by its own read, not its terminal; and a start's prompt, by the child's launch (COLLABORATION-3.1, 2.2)
	record(7, { from: ada, to: cy, delivery: { status: 'success', effects: { outcome: 'none', text_written: 'none', enter_written: false }, attempts: 5, via: 'read', deliveredAt: T + 8_000 } }, T - 2_000),
	record(8, { from: ada, to: cy, delivery: { status: 'success', effects: { outcome: 'confirmed' }, attempts: 1, via: 'launch', deliveredAt: T - 3_000 } }, T - 3_000)
];

/** The editor, as far as Message History and the person's notifications use it. */
function fakeEditor(overrides: { readonly openTextDocument?: () => Promise<unknown> } = {}) {
	const none = { dispose: () => undefined };
	const listeners = <T>() => {
		const set = new Set<(value: T) => void>();
		return { add: (listener: (value: T) => void) => { set.add(listener); return { dispose: () => set.delete(listener) }; }, fire: (value: T) => set.forEach(listener => listener(value)) };
	};
	const providers = new Map<string, { provideTextDocumentContent(uri: unknown): string }>();
	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const notifications: { text: string; items: string[] }[] = [];
	const opened: { uri: { scheme: string; path: string; query: string }; text: string }[] = [];
	let choice: string | undefined;
	const accepts = listeners<void>();
	const hides = listeners<void>();
	const picker = {
		title: '', placeholder: '', matchOnDescription: false, matchOnDetail: false, items: [] as { label: string; description?: string; detail?: string }[], activeItems: [] as unknown[],
		onDidAccept: accepts.add, onDidHide: hides.add, show: () => undefined, hide: () => hides.fire(), dispose: () => undefined,
		accept: (index: number) => { picker.activeItems = [picker.items[index]]; accepts.fire(); }
	};
	const vscode = {
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, at) => String(args[Number(at)])) },
		env: { language: 'en' },
		Uri: { from: (parts: { scheme: string; path: string; query: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}?${parts.query}` }) },
		EventEmitter: class { event = () => none; fire() { /* no open editor */ } dispose() { /* none */ } },
		ThemeIcon: class { constructor(readonly id: string) { } },
		window: {
			createQuickPick: () => picker,
			showInformationMessage: (text: string, ...items: string[]) => { notifications.push({ text, items }); return Promise.resolve(choice); },
			showTextDocument: async () => undefined
		},
		workspace: {
			registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: unknown): string }) => { providers.set(scheme, provider); return none; },
			openTextDocument: overrides.openTextDocument ?? (async (uri: { scheme: string; path: string; query: string }) => { const text = providers.get(uri.scheme)!.provideTextDocumentContent(uri); opened.push({ uri, text }); return { uri }; }),
			onDidCloseTextDocument: () => none
		},
		commands: { registerCommand: (id: string, run: (...args: unknown[]) => unknown) => { commands.set(id, run); return none; } }
	};
	const load = withModules({ vscode });
	return {
		picker, commands, notifications, opened, revealed: [] as string[],
		choose: (value: string | undefined) => { choice = value; },
		history: load<typeof import('../ui/pickers/messageHistory')>(require.resolve('../ui/pickers/messageHistory')),
		host: load<typeof import('../host/messageHistory')>(require.resolve('../host/messageHistory')),
		contact: load<typeof import('../host/contact')>(require.resolve('../host/contact'))
	};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

suite('Message History and contact with the person (COLLABORATION-2.3, 3.2; UX-1.2, 3.1)', () => {

	test('one-to-one conversations, most recently active first; a Facade result goes with the message it reports on', () => {
		const { history } = fakeEditor();
		const conversations = history.conversationsOf(RECORDS);
		assert.deepStrictEqual(conversations.map(each => [history.conversationTitle(each), each.records.map(record => record.id)]), [
			['Cy #a3 ↔ Facade', ['m-5']],
			['Cy #a3 ↔ You', ['m-4']],
			['Ada #a1 ↔ Bob #a2', ['m-1', 'm-2', 'm-3']],
			['Ada #a1 ↔ Cy #a3', ['m-6', 'm-7', 'm-8']]
		]);
	});

	test('one delivery state says how each message reached its agent: its CLI took it, the agent checked its messages, or it was its first task (COLLABORATION-3.1)', () => {
		const { history } = fakeEditor();
		const conversation = history.conversationsOf(RECORDS).find(each => each.records.some(record => record.id === 'm-7'))!;
		const text = history.conversationText(conversation, 'en');
		assert.ok(text.includes('#m7 · ') && text.includes('Status: Delivered when the agent checked its messages\n'), text);
		assert.ok(text.includes('Status: Delivered as the agent\'s first task\n'), text);
		assert.ok(text.includes('Status: Delivered to the agent\n'), text);
	});

	test('a conversation\'s document: source, recipient, time, reply, outcome and Facade results, then the text as text, its command links inert', () => {
		const { history } = fakeEditor();
		const conversation = history.conversationsOf(RECORDS).find(each => each.records.length === 3)!;
		const text = history.conversationText(conversation, 'en');
		const time = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' }).format(T + 1_000);
		assert.ok(text.startsWith('Message History: Ada #a1 ↔ Bob #a2\nRead-only. Messages are shown as they were sent; links in them cannot run editor commands.\n'), text);
		assert.ok(text.includes(`#m1 · ${time}\nFrom: Ada #a1\nTo: Bob #a2\nStatus: Delivered to the agent\nResult reported in: #m3\n\nSee [docs](command​:workbench.action.quit) now.\n`), text);
		assert.ok(text.includes('From: Bob #a2\nTo: Ada #a1\nIn reply to: #m1\nStatus: Not delivered: there was unsent text in the agent\'s input box\n'), text);
		assert.ok(text.includes('From: Facade\nTo: Ada #a1\nAbout message: #m1\nStatus: Delivered to the agent\n'), text);
		assert.ok(!text.includes('command:'), text);
	});

	test('Message History... is one native picker: conversations by recent activity; choosing one opens its read-only document', async () => {
		const editor = fakeEditor();
		const disposables = editor.host.registerMessageHistory({ messages: { history: () => RECORDS, onDidRecord: () => ({ dispose: () => undefined }) }, language: 'en' });
		assert.deepStrictEqual([...editor.commands.keys()], ['facade.messageHistory']);
		const done = editor.commands.get('facade.messageHistory')!() as Promise<void>;
		assert.deepStrictEqual([editor.picker.title, editor.picker.items.map(item => [item.label, item.description])], ['Message History', [
			['Cy #a3 ↔ Facade', '1 message'], ['Cy #a3 ↔ You', '1 message'], ['Ada #a1 ↔ Bob #a2', '3 messages'], ['Ada #a1 ↔ Cy #a3', '3 messages']
		]]);
		editor.picker.accept(2);
		await done;
		await flush();
		assert.deepStrictEqual(editor.opened.map(each => [each.uri.scheme, each.uri.path, each.uri.query]), [['facade-message-history', '/Ada #a1 ↔ Bob #a2', `${A} ${B}`]]);
		assert.ok(editor.opened[0].text.includes('Result reported in: #m3'));
		disposables.forEach(each => each.dispose());
	});

	test('with no records the picker says so, and offers nothing to send or delete', async () => {
		const editor = fakeEditor();
		editor.host.registerMessageHistory({ messages: { history: () => [], onDidRecord: () => ({ dispose: () => undefined }) }, language: 'en' });
		const done = editor.commands.get('facade.messageHistory')!() as Promise<void>;
		assert.deepStrictEqual([editor.picker.items, editor.picker.placeholder], [[], 'No messages in this window yet']);
		editor.picker.hide();
		await done;
	});

	test('#human: an information notification naming the source with the first line of its message, at most 300 code points; Open Message opens the whole message', async () => {
		const editor = fakeEditor();
		editor.choose('Open Message');
		const kept = new Map<string, MessageRecord>();
		const port = new editor.contact.WindowContact(async run => void editor.revealed.push(run), 'en');
		const saved = (id: string) => kept.get(id);
		const long = `Deploy is blocked.\nSee [this](command:workbench.action.quit) ${'é'.repeat(400)}`;
		const message = record(9, { from: ada, to: { run: '@human' }, text: long, delivery: { status: 'pending', effects: { outcome: 'pending' }, attempts: 0 } }, T);
		// Saved as handed over: Show opens the record as it is kept when shown, not as it was given
		kept.set(message.id, { ...message, delivery: { status: 'success', effects: { outcome: 'confirmed' }, attempts: 1 } });
		assert.strictEqual(port.contact(message, saved), true);
		await flush();
		const [shown] = editor.notifications;
		assert.deepStrictEqual(shown.items, ['Open Message', 'Show Agent']);
		assert.ok(shown.text.startsWith('Ada #a1: Deploy is blocked.') && !shown.text.includes('See'), shown.text);
		assert.ok([...shown.text].length <= 300 && !shown.text.includes('](') && !/command:/.test(shown.text) && !shown.text.includes('\n'), shown.text);
		assert.strictEqual(editor.opened.length, 1);
		assert.ok(editor.opened[0].text.startsWith('Message #m9 from Ada #a1\n\n'), editor.opened[0].text);
		assert.ok(editor.opened[0].text.includes(`${'é'.repeat(400)}\n`), 'the complete message');
		assert.ok(editor.opened[0].text.includes('Status: Shown to you as a notification'), editor.opened[0].text);
		port.dispose();
	});

	test('#human: Show Agent shows the agent that wrote, in this window; Open Message is not needed for it', async () => {
		const editor = fakeEditor();
		editor.choose('Show Agent');
		const port = new editor.contact.WindowContact(async run => void editor.revealed.push(run), 'en');
		const message = record(12, { from: ada, to: { run: '@human' }, text: 'Please review the plan.' }, T);
		assert.strictEqual(port.contact(message, () => message), true);
		await flush();
		assert.deepStrictEqual([editor.revealed, editor.opened.length], [[ada.run], 0]);
		port.dispose();
	});

	test('#human: a message or an agent that fails to open is no unhandled failure of the window', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => void unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const errors = console.error;
		console.error = () => undefined;
		try {
			for (const action of ['Open Message', 'Show Agent']) {
				const editor = fakeEditor({ openTextDocument: () => Promise.reject(new Error('cannot open')) });
				editor.choose(action);
				const port = new editor.contact.WindowContact(() => Promise.reject(new Error('cannot show')), 'en');
				const message = record(12, { from: ada, to: { run: '@human' }, text: 'Please review the plan.' }, T);
				port.contact(message, () => message);
				await flush();
				await flush();
				port.dispose();
			}
		} finally {
			console.error = errors;
			process.off('unhandledRejection', onUnhandled);
		}
		assert.deepStrictEqual(unhandled, []);
	});

	test('#human: Open Message looks the message up by its ID, however many came since; one no longer kept says so', async () => {
		const editor = fakeEditor();
		editor.choose('Open Message');
		const kept = new Map<string, MessageRecord>();
		const port = new editor.contact.WindowContact(async run => void editor.revealed.push(run), 'en');
		const saved = (id: string) => kept.get(id);
		const first = record(10, { from: ada, to: { run: '@human' }, text: 'the first' }, T);
		kept.set(first.id, first);
		port.contact(first, saved);
		for (let n = 11; n < 260; n++) {
			editor.choose(undefined);
			port.contact(record(n, { from: bob, to: { run: '@human' } }, T), saved);
		}
		await flush();
		assert.ok(editor.opened.length === 1 && editor.opened[0].text.includes('the first'));
		kept.clear();
		editor.choose('Open Message');
		port.contact(record(300, { from: cy, to: { run: '@human' }, text: 'expired' }, T), saved);
		await flush();
		assert.strictEqual(editor.opened[1].text, 'This message is no longer available.\n');
		port.dispose();
	});
});
