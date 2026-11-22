/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessRunning } from '../../base/system';
import type { MessageRecord } from '../../core/messagePorts';
import { EDITOR_FLAGS, editorProfile, endEditors, explicitVsixInstallArgs, newRepository, until } from './editors';

interface Options {
	readonly root: string;
	readonly facade: string;
	readonly folder: string;
	readonly record: string;
	readonly executable: string;
	readonly cli: string;
	readonly driver: string;
	readonly from: readonly string[];
	readonly to: readonly string[];
	readonly receiver: ReturnType<typeof editorProfile>;
	readonly env: NodeJS.ProcessEnv;
	readonly endMatching: (path: string) => void;
}

interface PublishedAgent {
	readonly version: string;
	readonly component: string;
	readonly componentPath: string;
	readonly window: string;
	readonly token: string;
	readonly hostPid: number;
	readonly run: string;
	readonly alias: string;
}

interface Receipt {
	readonly status: string;
	readonly effects?: { readonly outcome: string; readonly text_written: string; readonly enter_written: boolean | null };
	readonly data?: { readonly message_id: string; readonly target: string; readonly window_id?: string; readonly request_id?: string; readonly repeated?: boolean; readonly disposition?: string };
	readonly error?: { readonly code: string; readonly reason: string };
	readonly recovery?: { readonly action: string; readonly request_id: string; readonly condition: string };
}

interface DriverEvent {
	readonly phase: string;
	readonly message?: string;
}

interface ToolEvent {
	readonly step: string;
	readonly phase?: number;
	readonly answer?: { readonly result?: { readonly structuredContent?: Receipt } };
}

/** Update the receiving profile while its old component has a routed send whose paste is still in the original CLI's input. */
export async function replacementInFlight(options: Options): Promise<void> {
	const { root, facade, folder, record, driver, executable, from, to, receiver, endMatching } = options;
	const sender = editorProfile(root, 'snd');
	const otherFolder = path.join(root, 'send');
	newRepository(otherFolder);
	fs.mkdirSync(path.join(sender.user, 'User'), { recursive: true });
	fs.copyFileSync(path.join(receiver.user, 'User', 'settings.json'), path.join(sender.user, 'User', 'settings.json'));
	const install = (profile: typeof sender, packages: readonly string[]) => {
		for (const file of packages) {
			execFileSync(options.cli, [...profile.args, ...explicitVsixInstallArgs(file)], {
				env: { ...options.env, ...profile.env }, stdio: 'pipe', shell: process.platform === 'win32', timeout: 15_000
			});
		}
	};
	const editors: ChildProcess[] = [];
	const tail = new Map<string, string>();
	const start = (role: string, profile: typeof sender, cwd: string) => {
		const out = path.join(root, `upgrade-${role}.jsonl`);
		const editor = spawn(executable, [cwd, '--new-window', ...profile.args, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], {
			stdio: ['ignore', 'pipe', 'pipe'], env: { ...options.env, ...profile.env, FACADE_IT_UPDATE: out, FACADE_IT_UPDATE_ROLE: role }
		});
		editors.push(editor);
		const capture = (chunk: unknown) => tail.set(role, ((tail.get(role) ?? '') + String(chunk)).slice(-12_000));
		editor.stdout?.on('data', capture);
		editor.stderr?.on('data', capture);
		return out;
	};
	// Only complete records count while the editor or fake CLI is appending its next line.
	const rows = <T>(file: string): T[] => fs.existsSync(file)
		? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line) as T) : [];
	const phase = <T>(file: string, name: string, ms = 45_000) => until<T>(`${name} in ${file}`, () => {
		const events = rows<DriverEvent & Partial<T>>(file);
		const error = events.find(each => each.phase === 'error');
		if (error) { throw new Error(error.message); }
		return events.find(each => each.phase === name) as T | undefined;
	}, ms);
	const text = 'Deliver exactly once through component replacement.';
	const rejectedText = 'An already used request must not send here.';
	const requestId = 'window-component-update';
	const messages = path.join(facade, 'extension', 'messages');
	const originals = () => fs.existsSync(messages) ? fs.readdirSync(messages).filter(file => /^m-\d+\.json$/u.test(file))
		.map(file => JSON.parse(fs.readFileSync(path.join(messages, file), 'utf8')) as MessageRecord)
		.filter(message => message.requestId === requestId) : [];
	const input = (alias: string) => fs.existsSync(`${record}.bytes.${alias}`) ? fs.readFileSync(`${record}.bytes.${alias}`, 'utf8') : '';
	const receive = (alias: string) => rows<string>(`${record}.received.${alias}`);
	const launches = (alias: string) => fs.readFileSync(`${record}.starts.${alias}`, 'utf8').trim().split(/\r?\n/u).map(Number);
	const send = (alias: string, target: string, value: string) => fs.writeFileSync(`${record}.mcp-script.${alias}`, JSON.stringify([
		{ tool: 'send_message', arguments: { to: target, text: value, request_id: requestId } }
	]));
	const calls = (alias: string) => rows<ToolEvent>(`${record}.mcp.${alias}`);
	const reply = async (alias: string, number: number): Promise<Receipt> => until(`the sender's MCP answer for phase ${number}`, () => {
		const answer = calls(alias).find(each => each.step === 'send_message' && each.phase === number)?.answer;
		if (answer === undefined) { return undefined; }
		assert.ok(answer.result?.structuredContent, JSON.stringify(answer));
		return answer.result.structuredContent;
	});
	let target: PublishedAgent | undefined;
	let author: PublishedAgent | undefined;
	try {
		install(receiver, from);
		install(sender, from);
		const receiverOut = start('receiver', receiver, folder);
		target = await phase<PublishedAgent>(receiverOut, 'started', 90_000);
		const senderOut = start('sender', sender, otherFolder);
		author = await phase<PublishedAgent>(senderOut, 'started', 90_000);
		assert.notStrictEqual(target.window, author.window);
		assert.notStrictEqual(target.run, author.run);
		assert.ok(target.version);
		assert.deepStrictEqual([target.component, author.version, author.component], [target.version, target.version, target.version]);
		const [pid] = launches(target.alias);
		const [senderPid] = launches(author.alias);
		const held = `${record}.quirks.${target.alias}`;
		fs.writeFileSync(held, JSON.stringify({ swallow: 100 }));
		send(author.alias, target.alias, text);
		const initial = await until('the routed paste to reach the original recipient without Enter taking it', () => {
			const [message] = originals();
			return message?.delivery.status === 'pending' && message.delivery.pasted && input(target!.alias).includes(text)
				&& !receive(target!.alias).some(each => each.includes(text)) ? message : undefined;
		});
		const deadline = initial.delivery.deadline;
		assert.ok(typeof deadline === 'number');
		assert.deepStrictEqual([initial.from.run, initial.to.run, initial.window, initial.fromWindow], [author.run, target.run, target.window, author.window]);
		assert.ok(!calls(author.alias).some(each => each.step === 'send_message'), 'the original sender is still waiting when the upgrade begins');
		console.log('  Routed message in flight ' + JSON.stringify({ target, sender: author, message: initial.id, deadline: initial.delivery.deadline, pid }));
		install(receiver, to);
		assert.strictEqual(originals()[0]?.delivery.status, 'pending');
		fs.writeFileSync(`${receiverOut}.reload`, '');
		const reload = await phase<{ at: number }>(receiverOut, 'reloading');
		const successor = await phase<PublishedAgent>(receiverOut, 'updated');
		assert.ok(successor.version);
		assert.strictEqual(successor.component, successor.version);
		assert.notStrictEqual(successor.component, target.component);
		assert.notStrictEqual(successor.componentPath, target.componentPath);
		assert.notStrictEqual(successor.hostPid, target.hostPid);
		assert.deepStrictEqual([successor.window, successor.token, successor.run, successor.alias], [target.window, target.token, target.run, target.alias]);
		assert.deepStrictEqual(launches(target.alias), [pid]);
		assert.ok(isProcessRunning(pid) && isProcessRunning(senderPid));
		assert.ok(reload.at < deadline && Date.now() < deadline);
		assert.deepStrictEqual(originals().map(message => [message.id, message.delivery.status, message.delivery.deadline]), [[initial.id, 'pending', deadline]]);
		assert.ok(!receive(target.alias).some(each => each.includes(text)));
		console.log('  Receiver replaced while the same message was pending ' + JSON.stringify({ successor, message: initial.id, deadline, reload: reload.at, pid }));
		fs.rmSync(held);
		const delivered = await until('the original receiver to take the original pending send after replacement', () => {
			const [message] = originals();
			return message?.delivery.status === 'success' ? message : undefined;
		}, Math.max(500, deadline - Date.now() + 500));
		assert.deepStrictEqual([delivered.id, delivered.to.run, delivered.delivery.deadline], [initial.id, target.run, deadline]);
		assert.ok(typeof delivered.delivery.deliveredAt === 'number' && delivered.delivery.deliveredAt <= deadline);
		const confirmedEffects = { outcome: 'confirmed', text_written: 'full', enter_written: true };
		assert.deepStrictEqual(delivered.delivery.effects, confirmedEffects);
		const first = await reply(author.alias, 0);
		assert.deepStrictEqual([first.data?.message_id, first.data?.target, first.data?.window_id], [initial.alias, target.alias, target.window]);
		if (first.status === 'failure') {
			assert.deepStrictEqual(first.effects, { outcome: 'unknown', text_written: 'unknown', enter_written: null });
			assert.deepStrictEqual(first.error, { code: 'UNAVAILABLE', reason: 'window_unavailable' });
			assert.deepStrictEqual(first.recovery, { action: 'repeat_original_request', request_id: requestId, condition: 'within_original_hour' });
		} else {
			assert.strictEqual(first.status, 'success');
			assert.strictEqual(first.data?.disposition, 'submitted_to_cli');
			assert.deepStrictEqual(first.effects, confirmedEffects);
			if (first.data?.request_id !== undefined) { assert.strictEqual(first.data.request_id, requestId); }
		}
		send(author.alias, target.alias, text);
		const repeated = await reply(author.alias, 1);
		send(author.alias, author.alias, rejectedText);
		const redirected = await reply(author.alias, 2);
		for (const receipt of [repeated, redirected]) {
			assert.deepStrictEqual([
				receipt.status, receipt.data?.message_id, receipt.data?.target, receipt.data?.request_id,
				receipt.data?.repeated, receipt.data?.disposition, receipt.effects
			], ['success', initial.alias, target.alias, requestId, true, 'submitted_to_cli', confirmedEffects]);
		}
		assert.deepStrictEqual(originals().map(message => message.id), [initial.id]);
		assert.strictEqual(input(target.alias).split(text).length - 1, 1);
		const submissions = receive(target.alias);
		assert.strictEqual(submissions.length, 1, JSON.stringify(submissions));
		const [header, ...body] = submissions[0].split(/\r?\n/u);
		assert.deepStrictEqual(header.match(/#[am]\d+\b/gu), [author.alias, initial.alias]);
		assert.strictEqual(body.join('\n'), text);
		assert.deepStrictEqual(receive(author.alias), []);
		assert.ok(!input(target.alias).includes(rejectedText) && !input(author.alias).includes(rejectedText));
		assert.ok(!input(author.alias).includes(text));
		assert.deepStrictEqual(launches(target.alias), [pid]);
		assert.deepStrictEqual(launches(author.alias), [senderPid]);
		console.log('  ✔ The replacement settled exactly the original routed send ' + JSON.stringify({ successor, first, repeated, redirected, delivered: delivered.delivery, pid, senderPid }));
	} catch (error) {
		console.error('Replacement diagnostics ' + JSON.stringify({ target, author, originals: originals(), logs: Object.fromEntries(tail) }));
		throw error;
	} finally {
		try { await endEditors(editors); }
		finally {
			endMatching(sender.env.VSCODE_PORTABLE);
			endMatching(receiver.env.VSCODE_PORTABLE);
			endMatching(path.join(facade, 'extension', 'ptyd'));
		}
	}
}
