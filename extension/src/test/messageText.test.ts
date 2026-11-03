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

/** The editor, as far as the person's notifications and the message they open use it. */
function fakeEditor(overrides: { readonly openTextDocument?: () => Promise<unknown> } = {}) {
	const none = { dispose: () => undefined };
	const providers = new Map<string, { provideTextDocumentContent(uri: unknown): string }>();
	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const notifications: { text: string; items: string[] }[] = [];
	const opened: { uri: { scheme: string; path: string; query: string }; text: string }[] = [];
	let choice: string | undefined;
	const vscode = {
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, at) => String(args[Number(at)])) },
		env: { language: 'en' },
		Uri: { from: (parts: { scheme: string; path: string; query: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}?${parts.query}` }) },
		EventEmitter: class { event = () => none; fire() { /* no open editor */ } dispose() { /* none */ } },
		ThemeIcon: class { constructor(readonly id: string) { } },
		window: {
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
		commands, notifications, opened, revealed: [] as string[],
		choose: (value: string | undefined) => { choice = value; },
		history: load<typeof import('../ui/messageText')>(require.resolve('../ui/messageText')),
		contact: load<typeof import('../host/contact')>(require.resolve('../host/contact'))
	};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

suite('A message as the person opens it, and contact with the person (COLLABORATION-2.3, 3.2; UX-1.2)', () => {

	test('an operation receipt shows the recorded action/target and keeps long identity below the unchanged body', () => {
		const { history } = fakeEditor();
		const receipt = record(42, { kind: 'result', from: { run: 'facade' }, to: ada, agent: bob,
			operation: { tool: 'stop_agent', window: 'win-backend' }, callId: 'stop-original', requestId: 'request-original', text: 'Bob has stopped.',
			result: { status: 'success', data: { closed: true }, effects: { outcome: 'confirmed' } },
			delivery: { status: 'failure', reason: 'ended', effects: { outcome: 'none' }, attempts: 0 } }, T);
		const text = history.recordText(receipt, 'en');
		assert.ok(text.includes('Operation: Stop agent\nAgent: Bob #a2\nDelivery: Not delivered'));
		assert.ok(text.includes('Bob has stopped.\n\nTechnical details\ncall_id: stop-original'));
		assert.ok(text.includes('request_id: request-original') && text.includes('window: win-backend'));
		assert.ok(text.includes('status: success'), 'a lost receipt does not turn the successful operation into a failed one');
		const absent = history.recordText({ ...receipt, operation: undefined, about: 'm-999', agent: undefined }, 'en');
		assert.ok(absent.includes('About message: #m999'));
		assert.ok(!absent.includes('Operation:'), 'prose never manufactures an operation or missing original');
	});

	test('unconfirmed native acceptance is not displayed as delivered or still being delivered', () => {
		const { history } = fakeEditor();
		const native = { ...RECORDS[0], delivery: { status: 'unknown' as const, effects: { outcome: 'unknown' as const }, via: 'launch' as const, attempts: 0 } };
		const text = history.recordText(native, 'en');
		assert.ok(text.includes('Delivery: Could not confirm that the agent received the message\n'));
		assert.ok(!text.includes('Delivery: Delivered') && !text.includes('Delivery: Being delivered'));
	});

	test('machine outcome facts do not replace the readable history body or change older receipts', () => {
		const { history } = fakeEditor();
		const old = record(42, { kind: 'result', from: { run: 'facade' }, to: ada, about: 'm-1', text: 'Your message was submitted to its CLI.' }, T);
		const current = { ...old, result: { status: 'success', data: { message_id: '#m1', disposition: 'submitted_to_cli' }, effects: { outcome: 'confirmed' } } };
		assert.ok(!history.recordText(old, 'en').includes('submitted_to_cli'));
		assert.ok(history.recordText(current, 'en').includes('outcome: confirmed'));
		assert.ok(history.recordText(current, 'en').includes(old.text));
		assert.ok(history.recordText(current, 'en').includes('submitted_to_cli'));
	});

	test('one delivery state says how each message reached its agent: its CLI took it, the agent checked its messages, or it was its first task (COLLABORATION-3.1)', () => {
		const { history } = fakeEditor();
		const text = (id: string) => history.recordText(RECORDS.find(each => each.id === id)!, 'en');
		assert.ok(text('m-7').startsWith('#m7 · ') && text('m-7').includes('Delivery: Delivered when the agent checked its messages\n'), text('m-7'));
		assert.ok(text('m-8').includes('Delivery: Delivered as the agent\'s first task\n'), text('m-8'));
		assert.ok(text('m-6').includes('Delivery: Delivered to the agent\n'), text('m-6'));
	});

	test('a message\'s document: source, recipient, time, reply, outcome and Facade results, then the text as text, its command links inert', () => {
		const { history } = fakeEditor();
		const time = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' }).format(T + 1_000);
		const [first, reply, result] = ['m-1', 'm-2', 'm-3'].map(id => RECORDS.find(each => each.id === id)!);
		const text = history.recordText(first, 'en', ['#m3']);
		assert.ok(text.startsWith(`#m1 · ${time}\nFrom: Ada #a1\nTo: Bob #a2\nDelivery: Delivered to the agent\nResult reported in: #m3\n\nSee [docs](command\u200b:workbench.action.quit) now.\n`), text);
		assert.ok(history.recordText(reply, 'en').includes('From: Bob #a2\nTo: Ada #a1\nIn reply to: #m1\nDelivery: Not delivered: the terminal contained an unsent draft\n'));
		assert.ok(history.recordText(result, 'en').includes('From: Facade\nTo: Ada #a1\nAbout message: #m1\nDelivery: Delivered to the agent\n'));
		assert.ok(!text.includes('command:'), text);
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
		assert.ok(editor.opened[0].text.includes('Delivery: Delivered as a notification'), editor.opened[0].text);
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
