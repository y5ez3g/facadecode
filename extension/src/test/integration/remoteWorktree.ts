/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentRef } from '../../base/frameworkProtocol';
import { frameworkCall, EDITOR_FLAGS, editorProfile, officialEditor, sanitizedEnvironment } from './editors';
import { multiWindowDriverFiles, withFrameworkWindows } from './frameworkMultiWindow';

const SCENARIO = 'a_remote_worktree_is_shared_by_the_shell_and_editor';
const EDITOR_EVIDENCE = 'remote editor evidence ';
const EDITOR_STAGE = path.resolve(__dirname, '../../..', 'extension-it');

/** Run the Framework fixture, which keeps its SSH route and Shell Attach clients alive while the editor opens. */
export function runRemoteWorktree(home: string, executable: string): 'framework' {
	assert.deepStrictEqual([process.platform, process.arch], ['linux', 'x64']);
	const framework = path.resolve(__dirname, '../../../../..', 'framework');
	// Cargo adds the package version to the source stamp.
	const [, stamp] = fs.readFileSync(path.join(EDITOR_STAGE, 'bin', 'VERSION'), 'utf8').trim().split('+', 2);
	assert.ok(stamp, 'The editor stage records its source build.');
	const gitConfig = path.join(home, 'gitconfig');
	fs.writeFileSync(gitConfig, '');
	const result = spawnSync('cargo', [
		'test', '--locked', '-p', 'facade-scenarios', '--test', 'machines',
		'--', '--ignored', '--exact', '--test-threads=1', '--show-output', SCENARIO
	], {
		cwd: framework, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
		env: {
			...process.env,
			HOME: home, CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'),
			RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'),
			GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, CARGO_INCREMENTAL: '0',
			FACADE_BUILD: stamp,
			FACADE_TEST_REMOTE_WORKTREE_NODE: process.execPath, FACADE_TEST_REMOTE_WORKTREE_BRIDGE: __filename,
			VSCODE_EXECUTABLE: executable,
		}
	});
	assert.ifError(result.error);
	const output = result.stdout.trimEnd();
	console.log(output);
	assert.strictEqual(result.status, 0, `remote worktree test exited ${result.status ?? result.signal}`);
	const lines = output.split('\n');
	assert.deepStrictEqual(lines.filter(line => /^test .* \.\.\. /u.test(line)), [`test ${SCENARIO} ... ok`]);
	const summaries = lines.filter(line => line.startsWith('test result:'));
	assert.strictEqual(summaries.length, 1);
	assert.match(summaries[0], /^test result: ok\. 1 passed; 0 failed; 0 ignored;/u);
	const observations = lines.filter(line => line.startsWith(EDITOR_EVIDENCE));
	assert.strictEqual(observations.length, 1, 'one real editor observed the Framework fixture');
	const observed = JSON.parse(observations[0].slice(EDITOR_EVIDENCE.length)) as { implementation: 'framework'; viewers: number[] };
	assert.strictEqual(observed.implementation, 'framework');
	assert.deepStrictEqual(observed.viewers, [2, 3, 2]);
	return observed.implementation;
}

/** Called inside the Framework fixture's own home and display. The remote agent remains owned by that fixture. */
async function observeWorktree(args: readonly string[]): Promise<void> {
	assert.strictEqual(args.length, 6);
	const [folder, home, origin, address, expectedJson, marker] = args;
	const root = path.dirname(home);
	assert.strictEqual(path.dirname(folder), root);
	assert.strictEqual(process.env.FACADE_HOME, home);
	const expected = JSON.parse(expectedJson) as { reference: AgentRef; pid: number; cwd: string };
	sanitizedEnvironment();

	const editor = officialEditor();
	const driver = path.join(root, 'driver');
	fs.mkdirSync(driver);
	for (const [name, value] of Object.entries(multiWindowDriverFiles())) {
		fs.writeFileSync(path.join(driver, name), value);
	}
	const files = {
		prefix: path.join(root, 'editor'),
		read: (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
		write: (file: string, text: string) => {
			fs.writeFileSync(`${file}.new`, text);
			fs.renameSync(`${file}.new`, file);
		}
	};
	const start = (project: string, name: string, control: string, port: number) => {
		const profile = editorProfile(root, name);
		const user = path.join(profile.user, 'User');
		fs.mkdirSync(user, { recursive: true });
		fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
			'facade.framework': 'auto',
			'terminal.integrated.enablePersistentSessions': false,
			'window.restoreWindows': 'none',
			'update.mode': 'none',
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'telemetry.telemetryLevel': 'off'
		}));
		return spawn(editor, [project, '--new-window', '--disable-extensions', ...profile.args,
			`--extensionDevelopmentPath=${EDITOR_STAGE}`, `--extensionDevelopmentPath=${driver}`,
			`--remote-debugging-port=${port}`, '--locale=en', ...EDITOR_FLAGS], {
			env: { ...process.env, ...profile.env, FACADE_HOME: home, FACADE_IT_WINDOW_CONTROL: control,
				FACADE_IT_WINDOW_NO_COMPONENT: '1' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
	};
	const inspect = async () => {
		const { agent, viewers } = await frameworkCall(home, 'agent.inspect', { target: expected.reference });
		assert.strictEqual(agent.address, address);
		assert.deepStrictEqual({ reference: agent.reference, pid: agent.pid, cwd: agent.cwd }, expected);
		assert.strictEqual(agent.process, 'running');
		return viewers;
	};
	const before = await inspect();
	assert.strictEqual(before.length, 2, 'both Shell Attach clients are live');
	await withFrameworkWindows(files, start, async open => {
		const window = await open(folder, 'vs');
		assert.deepStrictEqual([window.ready.folder, window.ready.home, window.ready.remote, window.ready.machineId], [folder, home, null, origin]);
		assert.notStrictEqual(origin, expected.reference.machine_id);
		assert.strictEqual(await window.act({ kind: 'open-shell-agent', name: 'worker', address, text: marker }), address);
		assert.strictEqual(await window.act({ kind: 'remote-card', agent: address, machine: 'devbox' }), address);
		const alongside = await inspect();
		assert.strictEqual(alongside.length, 3);
		for (const viewer of before) { assert.ok(alongside.includes(viewer), 'both original Shell views remain attached'); }
		await window.close();
	});
	const after = await inspect();
	assert.deepStrictEqual([...after].sort(), [...before].sort());
	console.log(JSON.stringify({ implementation: 'framework', origin, address, ...expected, viewers: [before.length, 3, after.length], marker }));
}

if (require.main === module) {
	observeWorktree(process.argv.slice(2)).catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
