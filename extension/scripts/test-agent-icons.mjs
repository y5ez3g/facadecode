// Native terminal rendering regression for LIFECYCLE-2.2 and CONFIGURATION-2.4 (VERIFICATION U15): each built-in's logo, and each
// of the 16 robots an entry's icon can name. Run after compile and package.
// Only the test's own temporary editor is controlled; no CLI process or owner profile is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { officialEditor, sanitizedEnvironment, EDITOR_FLAGS, endMatching } = require('../build/out/test/integration/editors.js');
const source = path.resolve(import.meta.dirname, '..');
const stage = path.join(source, 'build', 'extension');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-icons-')));
const file = (...parts) => path.join(root, ...parts);
const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
// The built-ins' logos, then every robot, each a tab named by the icon it shows
const robots = ['red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink', 'aurora', 'sunset', 'ocean', 'orchid', 'pearl', 'graphite'];
const clis = ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi', ...robots.map(robot => `facade-${robot}`)];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, read) {
	for (let i = 0; i < 200; i++) {
		const value = await read();
		if (value) { return value; }
		await pause(100);
	}
	throw new Error(`Timed out: ${label}. Evidence: ${root}`);
}

for (const dir of ['u/User', 'x', 's', 'workspace', 'driver']) { fs.mkdirSync(file(dir), { recursive: true }); }
fs.writeFileSync(file('u/User/settings.json'), JSON.stringify({
	'workbench.colorTheme': 'Light Modern', 'workbench.startupEditor': 'none',
	'window.restoreWindows': 'none', 'extensions.autoUpdate': false, 'update.mode': 'none'
}));
fs.cpSync(path.join(stage, 'media'), file('driver/media'), { recursive: true });
fs.copyFileSync(path.join(stage, 'package.nls.json'), file('driver/package.nls.json'));
fs.writeFileSync(file('driver/package.json'), JSON.stringify({
	name: 'icon-test', publisher: 'facade-test', version: '0.0.1', engines: manifest.engines,
	main: './extension.cjs', activationEvents: ['onStartupFinished'],
	contributes: { icons: manifest.contributes.icons }
}));
// Exercise the actual icon factory with the packaged manifest/font, through VS Code's public API.
function driver() {
	const v = require('vscode'), fs = require('fs'), path = require('path');
	const root = process.env.FACADE_ICON_TEST;
	const { cliTerminalIcon } = require(path.join(process.env.FACADE_ICON_SOURCE, 'build/out/ui/presentation.js'));
	exports.activate = async context => {
		await v.commands.executeCommand('workbench.action.closeSidebar');
		await v.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		const icons = {};
		for (const cli of JSON.parse(process.env.FACADE_ICON_CLIS)) {
			const output = new v.EventEmitter();
			icons[cli] = cliTerminalIcon(cli).id;
			const terminal = v.window.createTerminal({ name: cli, iconPath: cliTerminalIcon(cli),
				location: v.TerminalLocation.Editor, isTransient: true,
				pty: { onDidWrite: output.event, open() { output.fire('Icon rendering test\r\n'); }, close() {} } });
			terminal.show(true);
			context.subscriptions.push(terminal, output);
		}
		fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ version: v.version, generation: Date.now(), icons }));
		let busy = false;
		const timer = setInterval(async () => {
			const request = path.join(root, 'request.json');
			if (busy || !fs.existsSync(request)) { return; }
			busy = true;
			try {
				const r = JSON.parse(fs.readFileSync(request, 'utf8'));
				fs.unlinkSync(request);
				if (r.reload) { await v.commands.executeCommand('workbench.action.reloadWindow'); return; }
				if (r.theme) { await v.workspace.getConfiguration('workbench').update('colorTheme', r.theme, v.ConfigurationTarget.Global); }
				if ('fileTheme' in r) { await v.workspace.getConfiguration('workbench').update('iconTheme', r.fileTheme, v.ConfigurationTarget.Global); }
				fs.writeFileSync(path.join(root, `done-${r.id}`), 'ok');
			} finally { busy = false; }
		}, 100);
		context.subscriptions.push({ dispose() { clearInterval(timer); } });
	};
}
fs.writeFileSync(file('driver/extension.cjs'), `(${driver.toString()})();`);
sanitizedEnvironment();
const log = fs.openSync(file('editor.log'), 'a');
const child = spawn(officialEditor(), [file('workspace'), '--new-window', '--disable-extensions',
	'--user-data-dir', file('u'), '--extensions-dir', file('x'), '--shared-data-dir', file('s'),
	'--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--extensionDevelopmentPath=${file('driver')}`, ...EDITOR_FLAGS],
{ env: { ...process.env, FACADE_HOME: file('facade'), FACADE_ICON_TEST: root, FACADE_ICON_SOURCE: source, FACADE_ICON_CLIS: JSON.stringify(clis) }, stdio: ['ignore', log, log] });
fs.closeSync(log);
let ws;
let serial = 0;
const results = [];
async function connect() {
	const port = fs.readFileSync(file('u/DevToolsActivePort'), 'utf8').split('\n')[0];
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
	assert.ok(target, 'the isolated workbench renderer');
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	const pending = new Map();
	ws.onmessage = event => { const r = JSON.parse(event.data); if (r.id) { pending.get(r.id)?.(r); pending.delete(r.id); } };
	return (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++serial;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
		pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
try {
	await until('activation', () => fs.existsSync(file('ready.json')));
	let call = await connect();
	for (const [id, theme, fileTheme] of [
		['light', 'Light Modern', 'vs-seti'], ['dark', 'Dark Modern', 'vs-seti'],
		['hc-light', 'Default High Contrast Light', 'vs-seti'], ['hc-dark', 'Default High Contrast', 'vs-seti'],
		['no-file-icons', 'Light Modern', null], ['minimal-file-icons', 'Dark Modern', 'vs-minimal'],
		['solarized-light', 'Solarized Light', 'vs-seti'],
		['reload-light', 'Light Modern', 'vs-seti']
	]) {
		fs.writeFileSync(file('request.json'), JSON.stringify({ id, theme, fileTheme }));
		await until(id, () => fs.existsSync(file(`done-${id}`)));
		if (id === 'reload-light') {
			const previous = fs.readFileSync(file('ready.json'), 'utf8');
			ws.close();
			fs.writeFileSync(file('request.json'), JSON.stringify({ reload: true }));
			await until('reactivation', () => fs.readFileSync(file('ready.json'), 'utf8') !== previous);
			call = await connect();
		}
		await pause(500);
		const state = await call('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
			await document.fonts.ready;
			return [...document.querySelectorAll('.tabs-container .tab .monaco-icon-label')].map(e => {
				const css = getComputedStyle(e, '::before');
				if (css.content === 'none') return { name: e.textContent, hidden: true };
				const glyph = JSON.parse(css.content);
				const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
				ctx.font = css.fontSize + ' ' + css.fontFamily;
				return { name: e.textContent, glyph, font: css.fontFamily, color: css.color,
					loaded: document.fonts.check(ctx.font, glyph), width: ctx.measureText(glyph).width, slot: parseFloat(css.width) };
			});
		})()` });
		assert.ok(!state.exceptionDetails, JSON.stringify(state.exceptionDetails));
		const tabs = state.result.value;
		assert.deepStrictEqual(tabs.map(t => t.name).sort(), [...clis].sort());
		const { icons } = JSON.parse(fs.readFileSync(file('ready.json'), 'utf8'));
		for (const tab of tabs) {
			if (fileTheme === null) { assert.ok(tab.hidden, 'respect disabled file icons'); continue; }
			// The glyph the manifest registers for the icon the extension gives the tab: a logo, or a robot
			const { fontPath, fontCharacter } = manifest.contributes.icons[icons[tab.name]].default;
			assert.ok(tab.loaded && tab.font.includes(path.basename(fontPath)), `${id}/${tab.name}: real ${path.basename(fontPath)} loaded`);
			assert.strictEqual(tab.glyph.codePointAt(0), parseInt(fontCharacter.slice(1), 16), `${id}/${tab.name}: its own glyph, not a generic file glyph`);
			assert.ok(Math.abs(tab.width - tab.slot) < 0.05, `${id}/${tab.name}: ${tab.width}px glyph in ${tab.slot}px slot`);
		}
		results.push({ id, tabs });
		const screenshot = await call('Page.captureScreenshot', { format: 'png' });
		fs.writeFileSync(file(`${id}.png`), Buffer.from(screenshot.data, 'base64'));
		console.log(`${id}: ${fileTheme === null ? 'native hidden-icon preference respected' : 'all six logos and 16 robots loaded at the native icon size'}`);
	}
	fs.writeFileSync(file('results.json'), JSON.stringify({ editor: JSON.parse(fs.readFileSync(file('ready.json'), 'utf8')), results }, null, 2));
	console.log(`Evidence: ${root}`);
} finally {
	ws?.close();
	await endMatching(root + path.sep);
	child.unref();
}
