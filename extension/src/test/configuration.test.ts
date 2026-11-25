/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempDir } from './util';
import { withModules } from './withModules';

const displayed = (file: string) => {
	const rel = path.relative(os.homedir(), file);
	return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : file;
};

suite('Opening the execution host settings (CONFIGURATION-7.1, UX-6.2)', () => {
	const l10n = { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])) };
	let temp: ReturnType<typeof tempDir>;
	let previousHome: string | undefined;
	let legacyRoot: string;
	let file: string;

	setup(() => {
		temp = tempDir('fd-framework-settings-');
		previousHome = process.env.FACADE_HOME;
		legacyRoot = path.join(temp.dir, 'legacy');
		file = path.join(temp.dir, 'status', 'facade.json');
		process.env.FACADE_HOME = legacyRoot;
	});

	teardown(() => {
		if (previousHome === undefined) { delete process.env.FACADE_HOME; } else { process.env.FACADE_HOME = previousHome; }
		temp.remove();
	});

	function settingsFor(linkSync = fs.linkSync) {
		const opened: { file: string; preview: boolean; text: string }[] = [];
		const errors: string[] = [];
		const created: string[] = [];
		let requests = 0;
		let edit: (() => Promise<void>) | undefined;
		const vscode = {
			l10n,
			Uri: { file: (fsPath: string) => ({ fsPath }) },
			commands: {
				registerCommand: (id: string, run: () => Promise<void>) => {
					assert.strictEqual(id, 'facade.openSettingsFile');
					edit = run;
					return { dispose: () => { edit = undefined; } };
				}
			},
			window: {
				showTextDocument: async (uri: { fsPath: string }, options: { preview: boolean }) => {
					opened.push({ file: uri.fsPath, preview: options.preview, text: fs.readFileSync(uri.fsPath, 'utf8') });
				},
				showErrorMessage: async (text: string) => { errors.push(text); }
			}
		};
		const hostFs = new Proxy(fs, { get: (target, key) => key === 'linkSync' ? linkSync : Reflect.get(target, key) });
		const { frameworkSettings } = withModules({ vscode, fs: hostFs })<typeof import('../host/framework/settings')>(require.resolve('../host/framework/settings'));
		const settings = frameworkSettings({
			status: async () => { requests++; return { settings_file: file }; },
			log: { event: text => created.push(text) }
		});
		return { settings, opened, errors, created, requests: () => requests, edit: () => (edit ?? assert.fail('Edit command was not registered'))() };
	}

	test('both settings entry points open the status path and preserve saved edits', async () => {
		const result = settingsFor();
		const command = result.settings.register();
		try {
			assert.strictEqual(result.requests(), 0);
			assert.strictEqual(fs.existsSync(file), false);
			await result.settings.open();
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
			const edited = '{ // keep this comment\n\t"yolo": false\n}\n';
			fs.writeFileSync(file, edited);
			await result.edit();
			assert.deepStrictEqual(result.opened, [
				{ file, preview: false, text: '{}\n' },
				{ file, preview: false, text: edited }
			]);
			assert.deepStrictEqual([result.requests(), fs.existsSync(legacyRoot), result.created, result.errors], [2, false, ['Created ' + displayed(file)], []]);
		} finally {
			command.dispose();
		}
	});

	test('reports exclusive creation failure without opening a document', async () => {
		const denied = () => { throw Object.assign(new Error('Link denied'), { code: 'EACCES' }); };
		const result = settingsFor(denied);
		const command = result.settings.register();
		try {
			await assert.rejects(result.settings.open(), /facade\.json could not be created: Link denied/);
			await result.edit();
			assert.deepStrictEqual(result.errors, [displayed(file) + ' could not be created: Link denied']);
			assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), []);
			assert.deepStrictEqual([result.opened, result.created], [[], []]);
		} finally {
			command.dispose();
		}
	});
});
