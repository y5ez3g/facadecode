/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentInfo, MessageRef, WindowInfo, WindowRef } from '../../base/coreProtocol';
import { freePort, Workbench } from './cdpInput';
import { endEditors, normalizeDriveLetter, until } from './editors';
import type { PinIdentity, SavedPin, WindowAction, WindowAnswer, WindowReady, WindowView } from './rustMultiWindowDriver';
import type { RunningAgent } from './rustWindowDriver';

/** The workspace driver and the two helpers it uses beside either copy of the extension. */
export function multiWindowDriverFiles(): Readonly<Record<string, string>> {
	const source = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
	return {
		'package.json': JSON.stringify({
			name: 'rust-multi-window-driver', publisher: 'facade-it', version: '0.0.0',
			engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], extensionKind: ['workspace'], main: './extension.js'
		}),
		'extension.js': source('rustMultiWindowDriver.js'),
		'rustWindowDriver.js': source('rustWindowDriver.js'),
		'editors.js': source('editors.js')
	};
}

interface WindowFiles {
	/** A path under the run's root, also writable by the workspace driver. */
	readonly prefix: string;
	read(file: string): string;
	write(file: string, text: string): void;
}

interface DrivenWindow {
	readonly ready: WindowReady;
	act<Result>(action: WindowAction): Promise<Result>;
	close(): Promise<void>;
	workbench(): Promise<Workbench>;
}

type OpenWindow = (folder: string, profile: string) => Promise<DrivenWindow>;
type StartEditor = (folder: string, profile: string, control: string, port: number) => ChildProcess;

/** Start each window with its own profile and mailbox and reap exactly the editors the journey started. */
export async function withRustWindows(files: WindowFiles, start: StartEditor, journey: (open: OpenWindow) => Promise<void>): Promise<void> {
	const editors: ChildProcess[] = [];
	let opened = 0;
	const open: OpenWindow = async (folder, profile) => {
		const control = `${files.prefix}-${++opened}`;
		const port = await freePort();
		const editor = start(folder, profile, control, port);
		editors.push(editor);
		let output = '';
		const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', capture);
		editor.stderr?.on('data', capture);
		editor.on('error', capture);
		const receive = async <Result>(file: string): Promise<Result> => {
			try {
				const answer = await until(file, () => {
					const text = files.read(file);
					return text ? JSON.parse(text) as WindowAnswer : undefined;
				}, 120_000);
				if ('error' in answer) { throw new Error(answer.error); }
				return answer.result as Result;
			} catch (error) {
				console.error(`Editor output for ${profile}:\n${output}`);
				throw error;
			}
		};
		const ready = await receive<WindowReady>(`${control}.ready`);
		let sent = 0;
		const act = <Result>(action: WindowAction) => {
			const request = `${control}.${++sent}`;
			files.write(`${request}.request`, JSON.stringify(action));
			return receive<Result>(`${request}.answer`);
		};
		return {
			ready, act,
			workbench: () => Workbench.connect(port, path.basename(folder)),
			close: async () => {
				await act<boolean>({ kind: 'close' });
				if (process.platform !== 'win32') {
					await endEditors([editor]);
					return;
				}
				// The driver's reply comes during shutdown. Let VS Code finish saving its editor layout before reopening.
				try {
					await until(`the VS Code process for ${profile} to exit`, () =>
						editor.exitCode !== null || editor.signalCode !== null || undefined, 20_000);
				} finally {
					console.log(`  VS Code ${profile} after Close Window has exit code ${editor.exitCode} and signal ${editor.signalCode ?? 'none'}`);
				}
				assert.strictEqual(editor.exitCode, 0, `VS Code ${profile} did not exit cleanly`);
			}
		};
	};
	try {
		await journey(open);
	} finally {
		await endEditors(editors);
	}
}

async function expectAgent(window: DrivenWindow, id: string, pinned: boolean): Promise<void> {
	await until(`#${id}'s ${pinned ? 'pinned ' : ''}card and terminal in ${window.ready.folder}`, async () => {
		const { cards, terminals } = await window.act<WindowView>({ kind: 'snapshot' });
		return cards.length === 1 && cards[0].id === id && cards[0].pinned === pinned && cards[0].column !== null && terminals === 1 || undefined;
	});
}

/** Read the real notification center, then use its Open Message button to check the ID. */
async function expectNotice(window: DrivenWindow, message: MessageRef, text: string, earlier?: string): Promise<void> {
	await window.act({ kind: 'notifications' });
	const workbench = await window.workbench();
	try {
		const messages = await until(`a Facade notification in ${window.ready.folder}`, async () => {
			const messages = await workbench.cdp.evaluate<string[]>(`Array.from(document.querySelectorAll(
				'.notifications-center .notification-list-item-message'), item => item.textContent ?? '')`);
			return messages.some(message => message.includes(text)) ? messages : undefined;
		});
		assert.strictEqual(messages.filter(message => message.includes(text)).length, 1);
		if (earlier !== undefined) {
			assert.ok(messages.every(message => !message.includes(earlier)), 'adoption does not show an older message');
		}
		const opened = await workbench.cdp.evaluate<boolean>(`(() => {
			const item = Array.from(document.querySelectorAll('.notifications-center .notification-list-item'))
				.find(item => item.querySelector('.notification-list-item-message')?.textContent?.includes(${JSON.stringify(text)}));
			const button = Array.from(item?.querySelectorAll('.monaco-button') ?? [])
				.find(button => button.textContent?.trim() === 'Open Message');
			button?.click();
			return !!button;
		})()`);
		assert.ok(opened, 'the notice offers Open Message');
		const id = `#${message.message_id}`;
		const address = `${id}@id:${message.machine_id.replace(/-/g, '')}`;
		const document = await window.act<string>({ kind: 'message', address });
		assert.ok(document.includes(id) && document.includes(text), document);
	} finally {
		workbench.cdp.close();
	}
}

interface WindowJourney {
	readonly home: string;
	readonly remote: string | null;
	readonly folder: string;
	readonly peer: string;
	readonly shared: string;
	readonly files: WindowFiles;
	windows(): Promise<readonly WindowInfo[]>;
}

async function firstMember(window: DrivenWindow, agent: string): Promise<WindowRef> {
	const members = await window.act<WindowRef[]>({ kind: 'members', agent });
	assert.strictEqual(members.length, 1, JSON.stringify(members));
	assert.strictEqual(members[0].machine_id, window.ready.machineId);
	return members[0];
}

async function waitConnections(journey: WindowJourney, expected: readonly { readonly window: WindowRef; readonly connected: boolean }[]): Promise<void> {
	await until('each logical window to have its expected connection', async () => {
		const windows = await journey.windows();
		return expected.every(({ window, connected }) => windows.some(each =>
			each.window_id === window.window_id && each.machine_id === window.machine_id && each.connected === connected)) || undefined;
	});
}

function assertSameRun(actual: RunningAgent, expected: RunningAgent, message?: string): void {
	assert.deepStrictEqual(
		{ ...actual, cwd: normalizeDriveLetter(actual.cwd) },
		{ ...expected, cwd: normalizeDriveLetter(expected.cwd) },
		message
	);
}

/** Go to Agent shares the original run, and two pinned workspaces restore one stopped run. */
export async function rustMultiWindow(open: OpenWindow, journey: WindowJourney): Promise<void> {
	const { folder, peer, home, remote } = journey;
	let machineId: string | undefined;
	const start = async (place: string, profile: string) => {
		const window = await open(place, profile);
		machineId ??= window.ready.machineId;
		assert.deepStrictEqual({
			...window.ready, folder: normalizeDriveLetter(window.ready.folder), home: normalizeDriveLetter(window.ready.home)
		}, { folder: normalizeDriveLetter(place), remote, home: normalizeDriveLetter(home), machineId });
		return window;
	};
	const first = await start(folder, 'a');
	const other = await start(peer, 'b');
	const screen = 'Shared agent screen';
	const before = await first.act<RunningAgent>({ kind: 'start', screen });
	const original = await firstMember(first, before.id);
	const earlier = 'Sent before the other window joined';
	const earlyId = await first.act<string>({ kind: 'send', agent: before.id, text: earlier });
	await expectNotice(first, { machine_id: first.ready.machineId, message_id: earlyId }, earlier);
	assertSameRun(await other.act<RunningAgent>({ kind: 'adopt', agent: before.id }), before);
	const both = await other.act<WindowRef[]>({ kind: 'members', agent: before.id });
	assert.strictEqual(both.length, 2);
	const member = both.find(window => window.window_id !== original.window_id);
	assert.ok(member && member.machine_id === original.machine_id, JSON.stringify(both));
	assert.ok(both.some(window => window.window_id === original.window_id && window.machine_id === original.machine_id));
	await Promise.all([expectAgent(first, before.id, false), expectAgent(other, before.id, false)]);
	const shared = 'Sent to both member windows';
	const sharedId = await first.act<string>({ kind: 'send', agent: before.id, text: shared });
	const sharedMessage = { machine_id: first.ready.machineId, message_id: sharedId };
	await Promise.all([expectNotice(first, sharedMessage, shared), expectNotice(other, sharedMessage, shared, earlier)]);
	console.log('  ✔ Both member windows show the same message once, and the new member does not show the earlier message');
	await first.act({ kind: 'pin', agent: before.id });
	await other.act({ kind: 'pin', agent: before.id });
	await first.close();
	await waitConnections(journey, [{ window: original, connected: false }, { window: member, connected: true }]);
	await expectAgent(other, before.id, true);
	assertSameRun(await other.act<RunningAgent>({ kind: 'running', agent: before.id, screen }), before);
	const firstBack = await start(folder, 'a');
	await expectAgent(firstBack, before.id, true);
	assertSameRun(await firstBack.act<RunningAgent>({ kind: 'running', agent: before.id, screen }), before);
	console.log('  ✔ Go to Agent shares the original process and closing one member window leaves it running in the other');

	await firstBack.act({ kind: 'stop', agent: before.id });
	await other.act({ kind: 'wait-for-exit', pid: before.pid });
	await until('the stopped agent to close in the other member window', async () => {
		const view = await other.act<WindowView>({ kind: 'snapshot' });
		return view.cards.length === 0 && view.terminals === 0 || undefined;
	});
	await Promise.all([firstBack.close(), other.close()]);
	await waitConnections(journey, [{ window: original, connected: false }, { window: member, connected: false }]);
	const restored = await Promise.all([start(folder, 'a'), start(peer, 'b')]);
	await Promise.all(restored.map(window => expectAgent(window, before.id, true)));
	const [left, right] = await Promise.all(restored.map(window => window.act<RunningAgent>({ kind: 'running', agent: before.id })));
	assertSameRun(left, right, 'both workspaces restored the same process');
	assertSameRun({ ...left, pid: before.pid }, before, 'the resume kept the number, session and cwd');
	assert.notStrictEqual(left.pid, before.pid, 'the original process ended before the resume');
	console.log('  ✔ End Agent closes both member windows\' cards and tabs, and both Pins restore one process by the original number');
	await deleteWorktree(restored[0], restored[1], original, member);
	await Promise.all(restored.map(window => window.close()));
	await sameWorkspace(start, journey);
}

async function deleteWorktree(source: DrivenWindow, peer: DrivenWindow, sourceRef: WindowRef, peerRef: WindowRef): Promise<void> {
	const branch = 'agent-in-other-window';
	const agent = await source.act<AgentInfo>({ kind: 'worktree', source: sourceRef, peer: peerRef, branch });
	const shown = await source.act<WindowView>({ kind: 'snapshot' });
	assert.ok(shown.cards.every(card => card.id !== agent.agent_id), 'the location source is outside the agent\'s member windows');
	await until('the peer window to display its worktree agent', async () => {
		const view = await peer.act<WindowView>({ kind: 'snapshot' });
		return view.cards.some(card => card.id === agent.agent_id) || undefined;
	});
	const workbench = await source.workbench();
	try {
		await until('Change Working Location', () => workbench.cdp.evaluate<boolean | undefined>(`(() => {
			const row = Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row'))
				.find(row => row.textContent?.includes('Change Working Location'));
			if (!row) { return undefined; }
			row.click();
			return true;
		})()`));
		await until('the linked worktree\'s Delete Worktree button', () => workbench.cdp.evaluate<boolean | undefined>(`(() => {
			const row = Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row'))
				.find(row => row.textContent?.includes(${JSON.stringify(branch)}));
			const button = row?.querySelector('[aria-label="Delete Worktree"], a.codicon-close');
			if (!button) { return undefined; }
			button.click();
			return true;
		})()`));
		const confirmation = await until('the Delete Worktree confirmation', () => workbench.cdp.evaluate<string | undefined>(
			`document.querySelector('.monaco-dialog-box')?.textContent ?? undefined`));
		assert.ok(confirmation.includes(agent.cwd) && confirmation.includes('Its agent will be ended.'), confirmation);
		const confirmed = await workbench.cdp.evaluate<boolean>(`(() => {
			const button = Array.from(document.querySelectorAll('.monaco-dialog-box .monaco-button'))
				.find(button => button.textContent?.trim() === 'Delete');
			button?.click();
			return !!button;
		})()`);
		assert.ok(confirmed, 'the confirmation offers Delete');
		await source.act({ kind: 'worktree-removed', id: agent.agent_id, folder: agent.cwd });
		await peer.act({ kind: 'wait-for-exit', pid: agent.pid! });
		console.log('  ✔ Delete Worktree counts the running agent of another member window and waits for it to end before Git removes its working folder');
	} finally {
		workbench.cdp.close();
	}
}

async function sameWorkspace(open: OpenWindow, journey: WindowJourney): Promise<void> {
	const folder = journey.shared;
	const left = await open(folder, 'c');
	const right = await open(folder, 'd');
	const agentLeft = await left.act<RunningAgent>({ kind: 'start', screen: 'Agent in the first window', secondGroup: true });
	const agentRight = await right.act<RunningAgent>({ kind: 'start', screen: 'Agent in the second window' });
	const leftRef = await firstMember(left, agentLeft.id);
	const rightRef = await firstMember(right, agentRight.id);
	assert.notStrictEqual(leftRef.window_id, rightRef.window_id, 'the two active windows have independent references');
	await Promise.all([expectAgent(left, agentLeft.id, false), expectAgent(right, agentRight.id, false)]);
	// Both hosts have already read the workspace. Each changes a different Pin in its own window.
	await left.act({ kind: 'pin', agent: agentLeft.id });
	await right.act({ kind: 'pin', agent: agentRight.id });
	const { file } = await right.act<SavedPin>({ kind: 'saved-pin', agent: agentRight.id });
	const saved = JSON.parse(journey.files.read(file)) as { 'facade.pins': PinIdentity[] };
	const pinOrder = saved['facade.pins'].map(pin => pin.agent);
	const pinned = [agentLeft.id, agentRight.id].sort();
	assert.deepStrictEqual([...pinOrder].sort(), pinned, 'both Pin changes are saved');
	const lastPin = pinOrder.at(-1)!;
	await left.act({ kind: 'filter' });
	const presentation = async (window: DrivenWindow, id: string) => {
		const snapshot = await window.act<WindowView>({ kind: 'snapshot' });
		const card = snapshot.cards.find(each => each.id === id);
		return { selected: snapshot.cards.filter(each => each.selected).map(each => each.id), column: card?.column, filter: snapshot.filter };
	};
	const before = await Promise.all([presentation(left, agentLeft.id), presentation(right, agentRight.id)]);
	assert.strictEqual(before[0].filter?.kind, 'location');
	assert.strictEqual(before[1].filter, undefined);
	assert.deepStrictEqual(before.map(each => [each.selected, each.column]), [[[agentLeft.id], 2], [[agentRight.id], 1]]);

	await Promise.all([left.close(), right.close()]);
	await waitConnections(journey, [{ window: leftRef, connected: false }, { window: rightRef, connected: false }]);
	const firstBack = await open(folder, 'c');
	await waitConnections(journey, [{ window: leftRef, connected: true }, { window: rightRef, connected: false }]);
	const secondBack = await open(folder, 'd');
	await waitConnections(journey, [{ window: rightRef, connected: true }]);
	for (const window of [firstBack, secondBack]) {
		await until('both Pins in the reopened workspace', async () => {
			const snapshot = await window.act<WindowView>({ kind: 'snapshot' });
			const shown = snapshot.cards.filter(card => card.pinned && card.column !== null).map(card => card.id).sort();
			return JSON.stringify(shown) === JSON.stringify(pinned) || undefined;
		});
	}
	// LIFECYCLE-3.5 and PANEL-2.1 select the last Pin opened in saved order.
	const restored = await Promise.all([presentation(firstBack, agentLeft.id), presentation(secondBack, agentRight.id)]);
	assert.deepStrictEqual(restored, before.map(view => ({ ...view, selected: [lastPin] })));
	console.log('  ✔ Two windows keep both Pin changes, keep their own filters and tab groups, and select the last restored Pin');
}
