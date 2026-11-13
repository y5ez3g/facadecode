/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { build } from 'esbuild';
import type { Card } from '../webview/protocol';

/** Real Chromium input and layout, in a throwaway headless profile. No installed browser profile or editor is attached. */
suite('The agent panel in Chromium', function () {
	this.timeout(15_000);
	// Chrome or Chromium where each platform installs it; CHROMIUM_EXECUTABLE names another
	const windowsChrome = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((dir): dir is string => !!dir).map(dir => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
	const executable = [process.env.CHROMIUM_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', ...windowsChrome].find(file => file && fs.existsSync(file));
	let child: ChildProcess;
	let profile: string;
	let socket: WebSocket;
	let call: (method: string, params?: object) => Promise<any>;
	let evaluate: (expression: string) => Promise<any>;
	const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
	const until = async (check: () => boolean | Promise<boolean>, ms = 8_000, what = 'Chromium did not become ready') => {
		const deadline = Date.now() + ms;
		while (!await check()) {
			if (Date.now() > deadline) { throw new Error(what); }
			await wait(30);
		}
	};
	/** Whether a page condition comes true within a deadline: a busy CI runner can fire a page's timer late, so tests wait for
	 * what the page does instead of sleeping for exactly as long as its timer. */
	const becomes = (expression: string, ms = 5_000) => until(() => evaluate(expression), ms).then(() => true, () => false);
	/** Read the rendered pixel: validates the actual visible color/opacity rather than only its CSS declaration. */
	const pixelAt = async (x: number, y: number): Promise<number[]> => {
		const offset = await evaluate('({ x: scrollX, y: scrollY })');
		const png = Buffer.from((await call('Page.captureScreenshot', { format: 'png', clip: { x: x + offset.x, y: y + offset.y, width: 1, height: 1, scale: 1 } })).result.data, 'base64');
		const chunks: Buffer[] = [];
		for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) {
			if (png.toString('ascii', at + 4, at + 8) === 'IDAT') { chunks.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at))); }
		}
		return [...zlib.inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
	};
	const snapshot = async (name: string) => {
		const folder = process.env.FACADE_UI_EVIDENCE_DIR;
		if (folder) {
			fs.mkdirSync(folder, { recursive: true });
			const shot = await call('Page.captureScreenshot', { format: 'png' });
			fs.writeFileSync(path.join(folder, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
		}
	};
	/** The shipped page, and the integration build's: the same source, its test mode defined either way (UX-3.2). */
	let shipped: string;
	let tested: string;
	let css: string;
	/** The page's words: each its own key, the templates as the extension gives them. */
	const words = { noAgentsIn: 'No agents found in "{0}".', otherAgents: '{0} other agents are in this workspace.', otherAgent: '1 other agent is in this workspace.', started: 'Started {0}', startedBy: 'Started {0} by {1}',
		ago: { now: 'just now', secs: '{0} secs ago', min: '{0} min ago', mins: '{0} mins ago', hr: '{0} hr ago', hrs: '{0} hrs ago', day: '{0} day ago', days: '{0} days ago', wk: '{0} wk ago', wks: '{0} wks ago', mo: '{0} mo ago', mos: '{0} mos ago', yr: '{0} yr ago', yrs: '{0} yrs ago' } };
	/** Loads a new page of the panel, as the view does each time it shows. */
	const load = async (bundle = shipped, saved?: unknown) => {
		await call('Page.navigate', { url: 'about:blank' });
		await wait(50);
		// The shipped webview declares HTML5. about:blank otherwise leaves this fixture in quirks mode, where the body owns scrolling.
		await evaluate(`document.open(); document.write('<!DOCTYPE html><html><head></head><body></body></html>'); document.close()`);
		await evaluate(`document.body.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style><div id="list"></div><div id="empty"></div>'; window.errors = []; window.posted = []; window.saved = ${JSON.stringify(saved ?? null)}; window.acquireVsCodeApi = () => ({postMessage(message) { window.posted.push(message); if (message.type === 'error') window.errors.push(message.message); }, getState: () => window.saved ?? undefined, setState: state => { window.saved = state; }}); window.FACADE_STRINGS = new Proxy(${JSON.stringify(words)}, {get: (words, key) => words[key] ?? String(key)}); window.FACADE_LOGOS = '';`);
		await evaluate(bundle);
		await evaluate(CARDS);
	};
	/** What the extension says to this page: a message as it posts one, for this page's generation. */
	const deliver = (message: object) => evaluate(`window.dispatchEvent(new MessageEvent('message', {data: {page: panel.page, ...${JSON.stringify(message)}}}))`);
	/** Thirty working cards, `window.agents`, drawn by `redraw()`; `newCard(i, more)` and `stateOf(cards, more)` make others as the host does. */
	const CARDS = `
		// A card's details as the host sends them: where it works and its path always, its title and who started it where it has them
		window.detailsFor = (i, more = {}) => ({ location: { id: 'location', label: 'Location: ', value: 'main', kind: 'repo' }, path: { id: 'path', label: 'Path: ', value: '/project' }, titleLabel: 'Title: ', ...more.summary ? { description: { title: '', place: '' } } : { untitled: 'No title yet', description: { title: 'Title: No title yet', place: '' } }, ...more });
		window.newCard = (i, more = {}) => ({ runId: 'run-' + i, selected: false, name: 'Agent ' + i, alias: '#a' + i, avatar: { file: 'avatar-claude.png' },
			dot: 'working', stateText: 'Working', line: 'Step one', details: detailsFor(i),
			label: 'Agent ' + i + ', #a' + i + ', Working, project, Claude Code, Step one', startedAt: Date.now(), menu: { moveUp: false, moveDown: false }, ...more });
		window.stateOf = (cards, more = {}) => ({ revision: 1, loading: false, cards, cardCount: cards.length, capabilities: { remote: false }, ...more });
		window.agents = Array.from({ length: 30 }, (_, i) => newCard(i + 1));
		window.redraw = (more = {}) => panel.render(stateOf(agents, more));
		// A row of the details as the person reads it: its words after its icon, what only a screen reader hears left out, a no-break
		// space read as a space
		window.wordsOf = row => [...row.children].filter(child => !(child instanceof SVGElement) && !child.classList.contains('visually-hidden')).map(child => child.textContent).join('').replace(/\u00a0/g, ' ');
		// A card's details as lines, its ⓘ opening and closing them: each shown row's words
		window.detailsOf = card => {
			card.querySelector('.details-button').click();
			const lines = [...document.querySelectorAll('.details .details-fact')].filter(row => !row.hidden).map(wordsOf);
			card.querySelector('.details-button').click();
			return lines;
		};
		redraw();`;
	suiteSetup(async function () {
		if (!executable) { this.skip(); return; }
		// A browser's cold start on a busy computer can take longer than the page's own checks wait: on a CI Windows runner more than
		// eight seconds, in one run of many
		this.timeout(75_000);
		const root = path.resolve(__dirname, '../../..');
		const source = fs.readFileSync(path.join(root, 'src/webview/panel.ts'), 'utf8');
		const hooks = `\n(window as any).panel = { page, render: (next: PanelState) => { state = next; render(); } };`;
		const bundle = async (testMode: boolean) => (await build({ stdin: { contents: source + hooks, loader: 'ts', resolveDir: path.join(root, 'src/webview') }, bundle: true, write: false, format: 'iife', minifySyntax: true, define: { FACADE_TEST_MODE: String(testMode) } })).outputFiles[0].text;
		[shipped, tested] = await Promise.all([bundle(false), bundle(true)]);
		css = fs.readFileSync(path.join(root, 'media/panel.css'), 'utf8');
		profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-panel-'));
		child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
		// What it said last, for a start that fails
		let said = '';
		child.stderr?.on('data', chunk => { said = `${said}${chunk}`.slice(-2_000); });
		// Chromium makes the file before it writes the port in it: read once the port is there, or it has ended
		const portOf = () => fs.existsSync(path.join(profile, 'DevToolsActivePort')) ? fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] : '';
		await until(() => /^\d+$/.test(portOf()) || child.exitCode !== null || child.signalCode !== null, 60_000).catch(() => undefined);
		if (!/^\d+$/.test(portOf())) {
			const ended = child.exitCode !== null || child.signalCode !== null ? `it ended (${child.exitCode ?? child.signalCode})` : 'it is still running';
			throw new Error(`Chromium did not become ready within 60 seconds: ${ended}; it said: ${said.trim() || 'nothing'}`);
		}
		const port = portOf();
		const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
		socket = new WebSocket(pages.find(page => page.type === 'page')!.webSocketDebuggerUrl);
		await new Promise<void>(resolve => socket.addEventListener('open', () => resolve(), { once: true }));
		let id = 0;
		const pending = new Map<number, (reply: any) => void>();
		socket.addEventListener('message', event => {
			const reply = JSON.parse(String(event.data));
			pending.get(reply.id)?.(reply); pending.delete(reply.id);
		});
		call = (method, params = {}) => new Promise(resolve => { const request = ++id; pending.set(request, resolve); socket.send(JSON.stringify({ id: request, method, params })); });
		evaluate = async expression => {
			const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
			assert.ok(!reply.error && !reply.result?.exceptionDetails, JSON.stringify(reply));
			return reply.result.result.value;
		};
	});
	suiteTeardown(async () => {
		socket?.close();
		if (child) {
			const exited = new Promise(resolve => child.once('exit', resolve));
			child.kill(); await Promise.race([exited, wait(1_000)]);
			if (child.exitCode === null) { child.kill('SIGKILL'); }
		}
		if (profile) { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); }
	});
	setup(async function () {
		// The first page a cold browser lays out can take longer than eight seconds on a busy CI runner, as its start can
		this.timeout(45_000);
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 2, mobile: false });
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
		await load();
		// The initial cards schedule a ResizeObserver update; input tests need its overlay ready first.
		await until(() => evaluate(`!document.querySelector('.facade-scrollbar').hidden && document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().height > 0`),
			30_000, 'The panel\'s scrollbar overlay was not ready within 30 seconds of loading the page');
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('a card keeps its element, face and dot through every change of what it says; its dot, second line, label and details are the host\'s (PANEL-1.4, 1.5, 3.2)', async () => {
		assert.deepStrictEqual(await evaluate(`(() => {
			const card = document.querySelector('.agent'), dot = card.querySelector('.dot'), face = card.querySelector('.face');
			agents[0] = newCard(1, { dot: 'none', stateText: 'Idle', line: 'Fix the login', label: 'Agent 1, #a1, Idle, project, Claude Code, Fix the login',
				details: detailsFor(1, { summary: { id: 'title', label: 'Title: ', value: 'Fix the login' }, description: { title: 'Title: Fix the login', place: 'Path: /project' } }) });
			redraw({ revision: 2 });
			return [card === document.querySelector('.agent'), dot === card.querySelector('.dot'), face === card.querySelector('.face'), dot.className, card.querySelector('.title').textContent, card.getAttribute('aria-label'), detailsOf(card), card.getAttribute('aria-description').replace(/\u00a0/g, ' ')];
		})()`), [true, true, true, 'dot none', 'Fix the login', 'Agent 1, #a1, Idle, project, Claude Code, Fix the login',
			['Fix the login', 'Agent 1 #a1', 'Started just now', 'main', '/project'],
			'Title: Fix the login, Started just now, Path: /project']);
	});

	test('PANEL-1.5: a card\'s details are five rows, each an icon and one line: its title, No title yet where it has none and Title unavailable where none can come, after the same Title: label; its name and short ID, an empty name its ID alone; when it started - and who started it; where it works, its icon its kind\'s; its path', async () => {
		const worktree = { location: { id: 'location', label: 'Location: ', value: 'rrr', kind: 'worktree' }, path: { id: 'path', label: 'Path: ', value: '~/shop.worktrees/rrr' } };
		await deliver({ type: 'state', state: await evaluate(`stateOf([
			newCard(1, { startedAt: Date.now() - 5 * 60_000, details: detailsFor(1, { summary: { id: 'title', label: 'Title: ', value: 'Fix the login' }, startedBy: 'Maker #a7', ...${JSON.stringify(worktree)} }) }),
			newCard(2),
			newCard(3, { details: detailsFor(3, { location: { id: 'location', label: 'Location: ', value: 'shop', kind: 'folder' }, path: { id: 'path', label: 'Path: ', value: '~/shop' } }) }),
			// An empty name: its ID is its name, the separator right after it; a custom CLI's, whose title can never come
			newCard(4, { name: '', details: detailsFor(4, { untitled: 'Title unavailable', description: { title: 'Title: Title unavailable', place: '' } }) })
		])`) });
		// The theme's text and quieter colours apart, as a theme has them
		await evaluate(`document.documentElement.style.cssText = '--vscode-foreground:#cccccc;--vscode-descriptionForeground:#999999;--vscode-editorHoverWidget-foreground:#cccccc;--vscode-editorHoverWidget-background:#202020'`);
		const seen = await evaluate(`(() => [...document.querySelectorAll('.agent')].map(card => {
			card.querySelector('.details-button').click();
			const rows = [...document.querySelectorAll('.details .details-fact')];
			const color = element => getComputedStyle(element).color;
			const shown = { lines: rows.filter(row => !row.hidden).map(wordsOf), heard: rows.map(row => row.querySelector('.visually-hidden')?.textContent ?? null),
				untitled: rows[0].classList.contains('untitled'), icons: rows.map(row => row.querySelector('svg path')?.getAttribute('d')),
				// The start's words in the text colour, as where it works; its icon and the short ID quieter
				colors: [color(rows[2].querySelector('span')), color(rows[3].querySelector('span:not(.visually-hidden)')), color(rows[2].querySelector('svg')), color(rows[1].querySelector('.details-more'))],
				named: document.getElementById(document.querySelector('.details').getAttribute('aria-labelledby')).parentElement === rows[1] };
			card.querySelector('.details-button').click();
			return shown;
		}))()`);
		await evaluate(`document.documentElement.style.cssText = ''`);
		assert.deepStrictEqual(seen.map((each: { lines: string[] }) => each.lines), [
			['Fix the login', 'Agent 1 #a1', 'Started 5 mins ago by Maker #a7', 'rrr', '~/shop.worktrees/rrr'],
			['No title yet', 'Agent 2 #a2', 'Started just now', 'main', '/project'],
			['No title yet', 'Agent 3 #a3', 'Started just now', 'shop', '~/shop'],
			['Title unavailable', '#a4', 'Started just now', 'main', '/project']
		]);
		// What a screen reader says before each value; a title it has not got is quieter; the dialog is named by who
		assert.deepStrictEqual([seen[0].heard, seen[1].heard, seen.map((each: { untitled: boolean }) => each.untitled), seen.every((each: { named: boolean }) => each.named)],
			[['Title: ', null, null, 'Location: ', 'Path: '], ['Title: ', null, null, 'Location: ', 'Path: '], [false, true, true, true], true]);
		const [startText, placeText, startIcon, alias] = seen[0].colors;
		assert.deepStrictEqual([startText === placeText, startIcon === alias, startText !== alias], [true, true, true]);
		// Its title's, who's and its start's icons; a worktree's icon, a main checkout's and a folder's are three; the path's is the folder's
		const [worktreeIcons, repoIcons, folderIcons] = seen.map((each: { icons: string[] }) => each.icons);
		assert.deepStrictEqual([new Set(worktreeIcons).size, new Set([worktreeIcons[3], repoIcons[3], folderIcons[3]]).size, folderIcons[3] === folderIcons[4], worktreeIcons[4] === folderIcons[4], worktreeIcons.every(Boolean)], [5, 3, true, true, true]);
		assert.ok(worktreeIcons[2].startsWith('M2 8C2 4.68629'), 'the start\'s icon is codicon clockface');
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('PANEL-1.5, UX-2.4: the start says how long ago by the host\'s clock in Resume Agent\'s words - just now under 30 s - lower-cased within the sentence and kept whole on a wrap; a time ahead of the clock, its date and time', async () => {
		const sourceNow = Date.UTC(2020, 0, 1, 12);
		const ago = [10_000, 45_000, 60_000, 40 * 60_000, 2 * 3_600_000, 3 * 86_400_000];
		await deliver({ type: 'state', state: await evaluate(`stateOf(${JSON.stringify(ago)}.map((ms, i) => newCard(i + 1, { startedAt: ${sourceNow} - ms })), { clockAt: ${sourceNow} })`) });
		// The start's row: its words as they are, a no-break space among them
		const startOf = `(card => { card.querySelector('.details-button').click(); const start = document.querySelectorAll('.details .details-fact')[2].querySelector('span').textContent; card.querySelector('.details-button').click(); return start; })`;
		const seen = await evaluate(`[...document.querySelectorAll('.agent')].map(${startOf})`);
		assert.deepStrictEqual(seen.map((start: string) => start.replace(/\u00a0/g, ' ')), [
			'Started just now', 'Started 45 secs ago', 'Started 1 min ago', 'Started 40 mins ago', 'Started 2 hrs ago', 'Started 3 days ago'
		]);
		// One unit: no line breaks inside "Started 40 mins ago"
		assert.strictEqual(seen[3], 'Started\u00a040\u00a0mins\u00a0ago');
		// A language whose word for it begins a list's line in upper case says it in lower case within the sentence
		await evaluate(`window.FACADE_STRINGS.ago.mins = 'Vor {0} Minuten'`);
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { startedAt: ${sourceNow} - 5 * 60_000 })], { revision: 2, clockAt: ${sourceNow} })`) });
		const lowered = (await evaluate(`${startOf}(document.querySelector('.agent'))`)).replace(/\u00a0/g, ' ');
		await evaluate(`window.FACADE_STRINGS.ago.mins = '{0} mins ago'`);
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { startedAt: ${sourceNow} + 60_000 })], { revision: 3, clockAt: ${sourceNow} })`) });
		const future = await evaluate(`detailsOf(document.querySelector('.agent'))[2]`);
		assert.deepStrictEqual([lowered, /2020/.test(future), future.includes('just now')], ['Started vor 5 Minuten', true, false]);
	});

	test('UX-2.4: a start ahead of the clock says the locale\'s whole date and time, its capitals kept, while a past start is lower-cased within the sentence', async () => {
		const sourceNow = Date.UTC(2020, 0, 1, 12);
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { startedAt: ${sourceNow} + 60_000 }), newCard(2, { startedAt: ${sourceNow} - 5 * 60_000 })], { clockAt: ${sourceNow} })`) });
		const [future, past] = await evaluate(`[...document.querySelectorAll('.agent')].map(card => detailsOf(card)[2])`);
		const absolute = await evaluate(`new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(${sourceNow} + 60_000)`);
		assert.deepStrictEqual([future, past.replace(/\u00a0/g, ' ')], [`Started ${absolute}`, 'Started 5 mins ago']);
		assert.ok(/[A-Z]/.test(absolute), absolute);
	});

	test('PANEL-1.5, UX-2.4: open details say their start again at the next age where its words change - 30 rounded seconds, each second, each half minute the minutes round up - a start ahead of the clock as it stops being ahead, and anew as their card\'s start changes', async () => {
		const sourceNow = Date.UTC(2020, 0, 1, 12);
		// A clock the test moves, and the page's timers recorded rather than run
		await evaluate(`(() => {
			window.fakeNow = 1_000_000; window.timers = []; window.realSetTimeout = window.setTimeout;
			Object.defineProperty(performance, 'now', { configurable: true, value: () => window.fakeNow });
			window.setTimeout = (run, wait) => { window.timers.push({ run, wait }); return window.timers.length; };
			window.startNow = () => document.querySelectorAll('.details .details-fact')[2].querySelector('span').textContent.replace(/\u00a0/g, ' ');
			// Opened on the first card, then each next timer run: what the start says, and how long until its next
			window.clockSteps = count => {
				document.querySelector('.agent .details-button').click();
				const steps = [[startNow(), timers.at(-1).wait]];
				for (let i = 0; i < count; i++) {
					const timer = timers.at(-1);
					fakeNow += timer.wait;
					timer.run();
					steps.push([startNow(), timers.at(-1).wait]);
				}
				return steps;
			};
		})()`);
		let revision = 10;
		const opened = async (age: number, count: number) => {
			await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { startedAt: ${sourceNow} - ${age} })], { revision: ${++revision}, clockAt: ${sourceNow} })`) });
			const steps = await evaluate(`clockSteps(${count})`);
			await evaluate(`document.querySelector('.agent .details-button').click()`);
			return steps;
		};
		try {
			assert.deepStrictEqual(await opened(10_000, 3), [['Started just now', 19_500], ['Started 30 secs ago', 1_000], ['Started 31 secs ago', 1_000], ['Started 32 secs ago', 1_000]]);
			// The last second, then the minutes as they round up: 59.5 s, 89.5 s, 149.5 s
			assert.deepStrictEqual(await opened(58_000, 4), [['Started 58 secs ago', 500], ['Started 59 secs ago', 1_000], ['Started 1 min ago', 30_000], ['Started 2 mins ago', 60_000], ['Started 3 mins ago', 60_000]]);
			// Opened within a minute's words: to where they next change, not a minute on
			assert.deepStrictEqual(await opened(75_000, 1), [['Started 1 min ago', 14_500], ['Started 2 mins ago', 60_000]]);
			// The last of the minutes gives way to the hour; past it, a look each minute
			assert.deepStrictEqual(await opened(3_569_000, 2), [['Started 59 mins ago', 500], ['Started 60 mins ago', 30_000], ['Started 1 hr ago', 60_000]]);
			// Ahead of the clock by 5 s: its date and time for those 5 s, then how long ago; far ahead, looked at again within a minute
			const ahead = await opened(-5_000, 1);
			assert.deepStrictEqual([/2020/.test(ahead[0][0]), ahead[0][1], ahead[1]], [true, 5_000, ['Started just now', 29_500]]);
			assert.deepStrictEqual((await opened(-3_600_000, 0))[0][1], 60_000);
			// Its card's start changing while they are open: from the new start at once
			const moved = await evaluate(`(() => { clockSteps(0); return timers.at(-1).wait; })()`);
			await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { startedAt: ${sourceNow} - 75_000 })], { revision: ${++revision}, clockAt: ${sourceNow} })`) });
			assert.deepStrictEqual([moved, await evaluate(`[startNow(), timers.at(-1).wait]`)], [60_000, ['Started 1 min ago', 14_500]]);
			await evaluate(`document.querySelector('.agent .details-button').click()`);
		} finally {
			await evaluate(`window.setTimeout = window.realSetTimeout; delete performance.now;`);
		}
	});

	test('PANEL-1.5: with the focus in the details - pressed in, by real input - the ⓘ closes them once and gives the focus to the card, not closing and opening them again', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		const middle = (selector: string) => evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
		const press = async ({ x, y }: { x: number; y: number }) => {
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
			await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
			await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
			await wait(30);
		};
		// Its buttons show under the pointer
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await middle('.agent .title') });
		await wait(30);
		const info = await middle('.agent .details-button');
		await press(info);
		const open = await evaluate(`!document.querySelector('.details').hidden`);
		await press(await middle('.details .details-fact'));
		const inside = await evaluate(`document.querySelector('.details').contains(document.activeElement)`);
		await evaluate(`(() => { window.hiddenChanges = 0; new MutationObserver(records => { window.hiddenChanges += records.length; }).observe(document.querySelector('.details'), { attributes: true, attributeFilter: ['hidden'] }); })()`);
		await press(info);
		assert.deepStrictEqual([open, inside, await evaluate(`[document.querySelector('.details').hidden, window.hiddenChanges, document.activeElement === document.querySelector('.agent')]`)], [true, true, [true, 1, true]]);
		// With none open, a press on it opens them, the keyboard on its card
		await press(info);
		assert.deepStrictEqual(await evaluate(`[document.querySelector('.details').hidden, document.activeElement === document.querySelector('.agent')]`), [false, true]);
		await press(info);
	});

	test('PANEL-1.5: a card\'s accessible description says how long ago it started as of when it gets the focus, with no new state, writing only where its words changed', async () => {
		const sourceNow = Date.UTC(2020, 0, 1, 12);
		await call('Emulation.setFocusEmulationEnabled', { enabled: true });
		await evaluate(`(() => { window.fakeNow = 1_000_000; Object.defineProperty(performance, 'now', { configurable: true, value: () => window.fakeNow }); })()`);
		try {
			await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { startedAt: ${sourceNow} - 5_000 }), newCard(2, { startedAt: ${sourceNow} - 5_000 })], { clockAt: ${sourceNow} })`) });
			const said = `document.querySelector('.agent').getAttribute('aria-description').replace(/\\u00a0/g, ' ')`;
			const before = await evaluate(said);
			await evaluate(`document.activeElement?.blur(); window.fakeNow += 3_600_000`);
			const unfocused = await evaluate(said);
			await evaluate(`document.querySelector('.agent').focus()`);
			const focused = await evaluate(said);
			// Focused again at once: the same words, and no attribute written
			const writes = await evaluate(`new Promise(resolve => { const seen = []; new MutationObserver(records => seen.push(records.length)).observe(document.querySelector('.agent'), { attributes: true, attributeFilter: ['aria-description'] }); document.querySelector('.agent').blur(); document.querySelector('.agent').focus(); setTimeout(() => resolve(seen.length), 20); })`);
			assert.deepStrictEqual([before.includes('Started just now'), unfocused, focused.includes('Started 1 hr ago'), writes], [true, before, true, 0]);
		} finally {
			await evaluate(`delete performance.now`);
		}
	});

	// ---- Batch 3: the details, the buttons, the menu and the stylesheet, each rule proved where a break of it would pass unnoticed

	/** A long title, so that details too tall for a short view scroll within themselves. */
	const LONG = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long native title`).join('\n');
	const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
	const middleOf = (selector: string) => evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
	const pressAt = async ({ x, y }: { x: number; y: number }) => {
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
		await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
		await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
		await wait(30);
	};
	const longCard = `newCard(1, { details: detailsFor(1, { summary: { id: 'title', label: 'Title: ', value: ${JSON.stringify(LONG)} }, description: { title: '', place: '' } }) })`;

	test('PANEL-1.5, UX-2.3: open details keep where the person scrolled them across a new state and a clock tick', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 220, deviceScaleFactor: 2, mobile: false });
		await evaluate(`(() => { window.fakeNow = 1_000_000; window.timers = []; window.realSetTimeout = window.setTimeout; Object.defineProperty(performance, 'now', { configurable: true, value: () => window.fakeNow }); window.setTimeout = (run, wait) => { window.timers.push({ run, wait }); return window.timers.length; }; })()`);
		try {
			const sourceNow = Date.UTC(2020, 0, 1, 12);
			await deliver({ type: 'state', state: await evaluate(`stateOf([${longCard.replace('newCard(1, {', `newCard(1, { startedAt: ${sourceNow} - 40_000,`)}, newCard(2)], { clockAt: ${sourceNow} })`) });
			await evaluate(`document.querySelector('.agent .details-button').click()`);
			await frames();
			const scroll = `document.querySelector('.details-scroll')`;
			const room = await evaluate(`${scroll}.scrollHeight > ${scroll}.clientHeight + 120`);
			await evaluate(`${scroll}.scrollTop = 120`);
			await deliver({ type: 'state', state: await evaluate(`stateOf([${longCard.replace('newCard(1, {', `newCard(1, { startedAt: ${sourceNow} - 40_000,`)}, newCard(2, { line: 'Another' })], { revision: 2, clockAt: ${sourceNow} })`) });
			const afterState = await evaluate(`${scroll}.scrollTop`);
			await evaluate(`(() => { const timer = timers.at(-1); fakeNow += timer.wait; timer.run(); })()`);
			const afterTick = await evaluate(`${scroll}.scrollTop`);
			assert.deepStrictEqual([room, afterState, afterTick, await evaluate(`!document.querySelector('.details').hidden`)], [true, 120, 120, true]);
		} finally {
			await evaluate(`window.setTimeout = window.realSetTimeout; delete performance.now;`);
		}
	});

	test('PANEL-1.5: open details follow their card when a card above it closes up and goes', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await evaluate(`document.querySelectorAll('.agent')[1].querySelector('.details-button').click()`);
		// Past their entrance, which slides them 10 px
		await wait(450);
		const gap = `(() => { const card = document.querySelector('[data-run="run-2"]').getBoundingClientRect(), details = document.querySelector('.details').getBoundingClientRect(); return Math.round(details.top - card.bottom); })()`;
		const before = await evaluate(gap);
		await evaluate(`agents.splice(0, 1); redraw({ revision: 3, exited: ['run-1'] })`);
		await becomes(`!document.querySelector('.agent.closing')`, 3_000);
		assert.deepStrictEqual([before, await evaluate(gap)], [8, 8]);
	});

	test('UX-2.3: a press on any of a card\'s buttons puts the keyboard on that card, never on the button - the ⓘ of its open details too, with the keyboard on another card', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		const keyed = `[document.activeElement?.dataset?.run, [...document.querySelectorAll('.agent')].find(card => card.tabIndex === 0)?.dataset.run]`;
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await middleOf('.agent .title') });
		await wait(30);
		const info = await middleOf('.agent .details-button');
		await pressAt(info);
		// The keyboard moved on to the next card, the details still open on the first
		await evaluate(`document.querySelectorAll('.agent')[1].focus()`);
		await pressAt(info);
		const afterInfo = await evaluate(keyed);
		await evaluate(`document.querySelectorAll('.agent')[2].focus()`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await middleOf('.agent .title') });
		await wait(30);
		await pressAt(await middleOf('.agent .menu-button'));
		const afterGear = await evaluate(keyed);
		assert.deepStrictEqual([afterInfo, afterGear, await evaluate(`document.activeElement.classList.contains('action')`)], [['run-1', 'run-1'], ['run-1', 'run-1'], false]);
	});

	test('PANEL-1.5: the view losing the focus closes the details; so does the gear, whose menu opens', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await evaluate(`document.querySelector('.agent .details-button').click()`);
		await evaluate(`window.dispatchEvent(new Event('blur'))`);
		const blurred = await evaluate(`document.querySelector('.details').hidden`);
		await evaluate(`document.querySelector('.agent .details-button').click()`);
		await evaluate(`document.querySelector('.agent .menu-button').click()`);
		assert.deepStrictEqual([blurred, await evaluate(`[document.querySelector('.details').hidden, document.querySelector('.agent').classList.contains('menu-open')]`)], [true, [true, true]]);
	});

	test('PANEL-1.5, U01: a fact with selected text keeps its words across a new state, and takes the new ones once the selection ends', async () => {
		const titled = (value: string, revision: number) => evaluate(`stateOf([newCard(1, { details: detailsFor(1, { summary: { id: 'title', label: 'Title: ', value: ${JSON.stringify(value)} } }) })], { revision: ${revision} })`);
		await deliver({ type: 'state', state: await titled('First title', 2) });
		await evaluate(`document.querySelector('.agent .details-button').click()`);
		const words = `document.querySelectorAll('.details .details-fact')[0].querySelector('span:not(.visually-hidden)').textContent`;
		await evaluate(`(() => { const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('.details .details-fact')[0].querySelector('span:not(.visually-hidden)')); getSelection().removeAllRanges(); getSelection().addRange(range); })()`);
		await deliver({ type: 'state', state: await titled('Second title', 3) });
		const held = await evaluate(words);
		await evaluate(`getSelection().removeAllRanges()`);
		await wait(30);
		assert.deepStrictEqual([held, await evaluate(words)], ['First title', 'Second title']);
	});

	test('PANEL-1.5: details open above only where they do not fit below, and keep the side they opened on while they fit there', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 400, deviceScaleFactor: 2, mobile: false });
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents.slice(0, 8))`) });
		await frames();
		const side = (index: number) => evaluate(`(() => { const card = document.querySelectorAll('.agent')[${index}]; card.querySelector('.details-button').click(); const above = document.querySelector('.details').classList.contains('above'); return above; })()`);
		// Near the top there is room below; near the bottom there is not
		const top = await side(0);
		await evaluate(`document.querySelectorAll('.agent')[0].querySelector('.details-button').click()`);
		const bottom = await side(7);
		// The view grown: they would now fit below, and stay above while they fit there
		await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 900, deviceScaleFactor: 2, mobile: false });
		await frames();
		const kept = await evaluate(`[document.querySelector('.details').classList.contains('above'), !document.querySelector('.details').hidden]`);
		await evaluate(`document.querySelectorAll('.agent')[7].querySelector('.details-button').click()`);
		// A card past the middle of a longer list: more room above it, but they fit below, where they open
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents, { revision: 5 })`) });
		await frames();
		const middle = await evaluate(`(() => { const card = [...document.querySelectorAll('.agent')].find(each => { const at = each.getBoundingClientRect(); return at.top > innerHeight * 0.55 && at.bottom < innerHeight * 0.65; }); card.querySelector('.details-button').click(); const at = card.getBoundingClientRect(), shown = document.querySelector('.details').getBoundingClientRect(); return [at.top > innerHeight - at.bottom, shown.height < innerHeight - at.bottom - 14, document.querySelector('.details').classList.contains('above')]; })()`);
		assert.deepStrictEqual([top, bottom, kept, middle], [false, true, [true, true], [true, true, false]]);
	});

	test('UX-2.3: with the focus in the details Home scrolls them and the wheel scrolls them, never the list under them', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 220, deviceScaleFactor: 2, mobile: false });
		await deliver({ type: 'state', state: await evaluate(`stateOf([${longCard}, ...agents.slice(1)])`) });
		await deliver({ type: 'details', run: 'run-1' });
		await frames();
		const scroll = `document.querySelector('.details-scroll')`;
		await evaluate(`${scroll}.scrollTop = 100`);
		const listBefore = await evaluate(`document.scrollingElement.scrollTop`);
		await evaluate(`${scroll}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
		const home = await evaluate(`${scroll}.scrollTop`);
		const at = await middleOf('.details');
		await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 60 });
		await wait(200);
		assert.deepStrictEqual([home, (await evaluate(`${scroll}.scrollTop`)) > 0, await evaluate(`document.scrollingElement.scrollTop`)], [0, true, listBefore]);
	});

	test('UX-2.3: their card going with the focus in its details puts the focus on the keyboard\'s card', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await deliver({ type: 'details', run: 'run-1' });
		await frames();
		const inside = await evaluate(`document.querySelector('.details').contains(document.activeElement)`);
		await evaluate(`agents.splice(0, 1); redraw({ revision: 5 })`);
		assert.deepStrictEqual([inside, await evaluate(`document.activeElement?.dataset?.run`)], [true, 'run-2']);
	});

	test('UX-2.3: Show Agent Details scrolls its card into view, as little as it takes, and opens them; another card\'s then leaves the first unmarked', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await deliver({ type: 'details', run: 'run-25' });
		await frames();
		const shown = await evaluate(`(() => { const card = document.querySelector('[data-run="run-25"]').getBoundingClientRect(); return card.top >= 0 && card.bottom <= innerHeight && !document.querySelector('.details').hidden; })()`);
		await deliver({ type: 'details', run: 'run-24' });
		await frames();
		assert.deepStrictEqual([shown, await evaluate(`[...document.querySelectorAll('.agent.details-open')].map(card => card.dataset.run)`)], [true, ['run-24']]);
	});

	test('UX-2.3: Shift+F10 opens the card\'s menu, F10 alone does not, and opening the menu closes the details; a menu the editor never shows leaves no mark after a second', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		const key = (shiftKey: boolean) => evaluate(`(() => { const card = document.querySelector('.agent'); card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: ${shiftKey}, bubbles: true, cancelable: true })); return card.classList.contains('menu-open'); })()`);
		const alone = await key(false);
		await evaluate(`document.querySelector('.agent .details-button').click()`);
		const shifted = await key(true);
		const closed = await evaluate(`document.querySelector('.details').hidden`);
		const cleared = await becomes(`!document.querySelector('.agent').classList.contains('menu-open')`);
		assert.deepStrictEqual([alone, shifted, closed, !cleared], [false, true, true, false]);
	});

	test('PANEL-1.3: the pointer leaving the view hides a card\'s buttons; they have no Tab stop and the passive Pin is hidden from a screen reader; a pinned card\'s Pin button is filled', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { pinned: true, menu: { moveUp: false, moveDown: true, unpin: true } }), newCard(2, { menu: { moveUp: true, moveDown: false, pin: true } })])`) });
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await middleOf('.agent .title') });
		await wait(30);
		const hovered = await evaluate(`document.querySelector('.agent').classList.contains('hovered')`);
		await evaluate(`document.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }))`);
		const facts = await evaluate(`(() => { const [one, two] = document.querySelectorAll('.agent'); return [one.classList.contains('hovered'), [...one.querySelectorAll('.action')].every(button => button.tabIndex === -1), one.querySelector('.pin')?.getAttribute('aria-hidden'), one.querySelector('.pin-button path').getAttribute('d') !== two.querySelector('.pin-button path').getAttribute('d'), one.querySelector('.pin-button path').getAttribute('d').split('Z').length - 1]; })()`);
		assert.deepStrictEqual([hovered, ...facts], [true, false, true, 'true', true, 1]);
	});

	test('PANEL-1.5: a starter\'s name and its #aN stay together on a wrap', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { details: detailsFor(1, { startedBy: 'Maker #a7' }) })])`) });
		const start = await evaluate(`(() => { document.querySelector('.agent .details-button').click(); const text = document.querySelectorAll('.details .details-fact')[2].querySelector('span').textContent; document.querySelector('.agent .details-button').click(); return text; })()`);
		assert.ok(start.includes('Maker #a7'), JSON.stringify(start));
	});

	test('UX-2.2: a closing card where its animation does not run goes all the same; with reduced motion details only appear', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await evaluate(`(() => { const style = document.createElement('style'); style.id = 'no-animation'; style.textContent = '.item.closing { animation: none !important; }'; document.head.append(style); })()`);
		await evaluate(`agents.splice(1, 1); redraw({ revision: 6, exited: ['run-2'] })`);
		const gone = await becomes(`!document.querySelector('[data-run="run-2"]')`, 3_000);
		await evaluate(`document.getElementById('no-animation').remove()`);
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
		await evaluate(`document.querySelector('.agent .details-button').click()`);
		await frames();
		const transition = await evaluate(`document.querySelector('.details').classList.contains('open') && getComputedStyle(document.querySelector('.details')).transitionDuration`);
		await evaluate(`document.querySelector('.agent .details-button').click()`);
		assert.deepStrictEqual([gone, String(transition).split(',').every((each: string) => parseFloat(each) === 0)], [true, true]);
	});

	test('UX-2.2: with the editor\'s workbench.reduceMotion - its mark on the page, the system asking for nothing - details only appear', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await evaluate(`document.body.classList.add('vscode-reduce-motion')`);
		try {
			await evaluate(`document.querySelector('.agent .details-button').click()`);
			await frames();
			const transition = await evaluate(`document.querySelector('.details').classList.contains('open') && getComputedStyle(document.querySelector('.details')).transitionDuration`);
			assert.ok(String(transition).split(',').every((each: string) => parseFloat(each) === 0), String(transition));
		} finally {
			await evaluate(`document.body.classList.remove('vscode-reduce-motion')`);
		}
	});

	test('UX-2.3: details the pointer opened, the keyboard on their card, are replaced by another card\'s that Show Agent Details opens: the first left unmarked, its ⓘ released', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await middleOf('.agent .title') });
		await wait(30);
		await pressAt(await middleOf('.agent .details-button'));
		await frames();
		const first = await evaluate(`[!document.querySelector('.details').hidden, document.querySelector('.details').contains(document.activeElement)]`);
		await deliver({ type: 'details', run: 'run-2' });
		await frames();
		assert.deepStrictEqual([first, await evaluate(`[[...document.querySelectorAll('.agent.details-open')].map(card => card.dataset.run), document.querySelector('.agent .details-button').classList.contains('active')]`)],
			[[true, false], [['run-2'], false]]);
	});

	test('UX-2.1, D7, PANEL-1.3: the stylesheet - a card\'s close is 150 ms; its line keeps room for two buttons, three where it can be pinned; an untitled first row is quieter; a selected card\'s buttons at 80%, whole where 80% reads below 4.5:1 and in high contrast, edged there under the pointer', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { selected: true, menu: { moveUp: false, moveDown: true, pin: true } }), newCard(2)])`) });
		const close = await evaluate(`(() => { const probe = document.createElement('div'); probe.className = 'item agent closing'; document.querySelector('#list').append(probe); const duration = getComputedStyle(probe).animationDuration; probe.remove(); return duration; })()`);
		const room = await evaluate(`[...document.querySelectorAll('.agent')].map(card => { card.classList.add('hovered'); const padding = getComputedStyle(card.querySelector('.line.top')).paddingRight; card.classList.remove('hovered'); return padding; })`);
		await evaluate(`document.documentElement.style.cssText = '--vscode-foreground:#cccccc;--vscode-descriptionForeground:#999999;--vscode-editorHoverWidget-foreground:#cccccc;--vscode-editorHoverWidget-background:#202020'`);
		await wait(60);
		const untitled = await evaluate(`(() => { document.querySelectorAll('.agent')[1].querySelector('.details-button').click(); const row = document.querySelectorAll('.details .details-fact')[0]; const seen = [row.classList.contains('untitled'), getComputedStyle(row).color !== getComputedStyle(document.querySelectorAll('.details .details-fact')[4]).color]; document.querySelectorAll('.agent')[1].querySelector('.details-button').click(); return seen; })()`);
		// Each read once the page has looked at the theme again: a body class is a theme's change to it
		await evaluate(`document.documentElement.style.cssText = ''`);
		const opacity = async () => { await wait(60); return evaluate(`getComputedStyle(document.querySelector('.agent.selected .action')).opacity`); };
		const quiet = await opacity();
		// A selection whose foreground at 80% reads below 4.5:1: the page draws its quieter text whole
		await evaluate(`document.documentElement.style.cssText = '--vscode-list-activeSelectionForeground:#ffffff;--vscode-list-activeSelectionBackground:#8a8a8a'`);
		const whole = [await opacity(), await evaluate(`document.body.classList.contains('whole-quiet-text')`)];
		await evaluate(`document.documentElement.style.cssText = '--vscode-contrastActiveBorder:#f38518'; document.body.classList.add('vscode-high-contrast')`);
		const contrast = await opacity();
		await evaluate(`document.querySelector('.agent .menu-button').classList.add('active')`);
		await wait(60);
		const edge = await evaluate(`(() => { const button = document.querySelector('.agent .menu-button'); const outline = [getComputedStyle(button).outlineStyle, getComputedStyle(button).outlineWidth]; button.classList.remove('active'); return outline; })()`);
		await evaluate(`document.body.classList.remove('vscode-high-contrast'); document.documentElement.style.cssText = ''`);
		assert.deepStrictEqual([close, room, untitled, quiet, whole, contrast, edge], ['0.15s', ['58px', '38px'], [true, true], '0.8', ['1', true], '1', ['dashed', '1px']]);
	});

	test('UX-2.1: flat dim takes the text colour at 75% only where that keeps 4.5:1, and selected quiet text goes whole where 80% of it reads below 4.5:1', async () => {
		const set = async (style: string) => {
			await evaluate(`document.body.className = 'vscode-light'; document.documentElement.style.cssText = '${style}';`);
			await evaluate('new Promise(resolve => setTimeout(resolve, 0))');
			return evaluate(`[document.body.classList.contains('flat-dim'), document.body.classList.contains('whole-quiet-text')]`);
		};
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { selected: true })])`) });
		const flat = await set('--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-sideBar-background:#f8f8f8;--vscode-editorHoverWidget-background:#f8f8f8');
		const dim = await evaluate(`getComputedStyle(document.body).getPropertyValue('--facade-dim')`);
		// Text too faint for 75% to keep 4.5:1: no flat dim
		const faint = await set('--vscode-foreground:#8a8a8a;--vscode-descriptionForeground:#8a8a8a;--vscode-sideBar-background:#f8f8f8;--vscode-editorHoverWidget-background:#f8f8f8');
		// A selection whose foreground at 80% reads below 4.5:1
		const selection = await set('--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-sideBar-background:#f8f8f8;--vscode-editorHoverWidget-background:#f8f8f8;--vscode-list-activeSelectionForeground:#ffffff;--vscode-list-activeSelectionBackground:#8a8a8a;--vscode-list-inactiveSelectionForeground:#ffffff;--vscode-list-inactiveSelectionBackground:#8a8a8a');
		await evaluate(`document.body.className = ''; document.documentElement.style.cssText = '';`);
		assert.deepStrictEqual([flat[0], dim.includes('75%'), faint[0], selection[1]], [true, true, false, true], dim);
	});

	test('PANEL-1.5: a view resize\'s own scroll re-places open details on their card', async () => {
		const size = (width: number, height: number) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
		try {
			await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
			await evaluate(`document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight`);
			await frames();
			await evaluate(`[...document.querySelectorAll('.agent')].at(-1).querySelector('.details-button').click()`);
			await wait(450);
			// The page's own scroll as it fits the new size, after the resize was said
			await evaluate(`window.addEventListener('resize', () => { document.scrollingElement.scrollTop -= 40; }, { once: true })`);
			await size(400, 500);
			await frames();
			const gap = await evaluate(`(() => { const card = [...document.querySelectorAll('.agent')].at(-1).getBoundingClientRect(), details = document.querySelector('.details').getBoundingClientRect(); return [Math.round(details.top - card.bottom), Math.round(card.top - details.bottom)]; })()`);
			assert.ok(gap.some((each: number) => each === 8), JSON.stringify(gap));
		} finally {
			await size(400, 300);
			await frames();
		}
	});

	test('PANEL-1.5: a view resize keeps open details open, placed again as wide as their card and on the side they opened on; a scroll the page makes as it fits the new size does not close them, and the person\'s scroll still does', async () => {
		const size = (width: number, height: number) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
		const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
		const seen = `(() => { const details = document.querySelector('.details'), card = document.querySelector('.agent.details-open'); return [!!card && !details.hidden, card && Math.round(details.getBoundingClientRect().width) === Math.round(card.getBoundingClientRect().width), Math.round(details.getBoundingClientRect().width)]; })()`;
		try {
			await deliver({ type: 'state', state: await evaluate(`stateOf(agents)`) });
			await evaluate(`document.querySelector('.agent .details-button').click()`);
			await frames();
			const [open, matched, wide] = await evaluate(seen);
			await size(260, 300);
			await frames();
			const [openNarrow, matchedNarrow, narrow] = await evaluate(seen);
			assert.deepStrictEqual([open, matched, openNarrow, matchedNarrow, narrow < wide], [true, true, true, true, true]);
			await evaluate(`document.querySelector('.agent .details-button').click()`);
			// Scrolled to the end, then the view grows: the list no longer reaches as far, and the page scrolls by itself
			await size(400, 300);
			await evaluate(`document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight`);
			await frames();
			const before = await evaluate(`document.scrollingElement.scrollTop`);
			await evaluate(`[...document.querySelectorAll('.agent')].at(-1).querySelector('.details-button').click()`);
			await frames();
			await size(400, 500);
			await frames();
			const after = await evaluate(`document.scrollingElement.scrollTop`);
			const [stayed] = await evaluate(seen);
			assert.deepStrictEqual([after < before, stayed], [true, true]);
			// The person's own scroll closes them, as ever
			await evaluate(`document.scrollingElement.scrollTop = 0`);
			await frames();
			assert.strictEqual((await evaluate(seen))[0], false);
		} finally {
			await size(400, 300);
			await frames();
		}
	});

	test('PANEL-1.5, UX-2.1: where the theme\'s quieter colour is its text colour, the panel\'s quieter words take the text colour at 75%; never in high contrast; details whose quieter colour reads below 4.5:1 take the text colour', async () => {
		const flat = async (style: string, kind = 'vscode-light') => {
			await evaluate(`document.body.className = '${kind}'; document.documentElement.style.cssText = '${style}';`);
			await evaluate('new Promise(resolve => setTimeout(resolve, 0))');
			return evaluate(`[document.body.classList.contains('flat-dim'), getComputedStyle(document.querySelector('.agent .title')).color]`);
		};
		const light = '--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-sideBar-background:#f8f8f8;--vscode-editorHoverWidget-background:#f8f8f8';
		const same = await flat(light);
		const own = await flat(light.replace('--vscode-descriptionForeground:#3b3b3b', '--vscode-descriptionForeground:#717171'));
		const contrast = await flat(light, 'vscode-high-contrast-light');
		assert.deepStrictEqual([same[0], own, contrast[0]], [true, [false, 'rgb(113, 113, 113)'], false]);
		assert.notStrictEqual(same[1], 'rgb(59, 59, 59)', 'the quieter words are quieter than the text');
		// A quieter colour too faint on the hover colour: the details' quieter words in the text colour
		await flat('--vscode-foreground:#333333;--vscode-descriptionForeground:#bbbbbb;--vscode-sideBar-background:#ffffff;--vscode-editorHoverWidget-background:#ffffff');
		const plain = await evaluate(`(() => { const card = document.querySelector('.agent'); card.querySelector('.details-button').click(); const details = document.querySelector('.details'); const seen = [details.classList.contains('plain-quiet'), getComputedStyle(details.querySelector('.details-more')).color]; card.querySelector('.details-button').click(); return seen; })()`);
		await evaluate(`document.body.className = ''; document.documentElement.style.cssText = '';`);
		assert.deepStrictEqual(plain[0], true);
	});

	// Two shadows stacked the same size each smoothed their edge, and the side bar's under the row's showed through it at 125%: a light
	// rim round the dot of a card selected in blue (2026-11-03). The ring is the dot's own border, painted with it as one shape
	test('the dot\'s cut-out ring is the colour the row shows: a translucent hover or selection colour over the side bar, never over the avatar, painted as the dot\'s own border (PANEL-1.3)', async () => {
		await evaluate(`document.documentElement.style.cssText = '--vscode-charts-green:#00ff00;--vscode-sideBar-background:#202020;--vscode-list-activeSelectionBackground:rgba(0, 120, 255, 0.3)';`);
		const rings = await evaluate(`(() => { agents[0] = newCard(1, { selected: true }); redraw({ revision: 2 }); const cards = document.querySelectorAll('.agent'); return [cards[0], cards[1]].map(card => { const dot = card.querySelector('.dot'), style = getComputedStyle(dot); return [style.backgroundImage, style.backgroundClip, style.borderTopWidth, style.width, style.boxShadow, getComputedStyle(dot, '::after').backgroundImage.startsWith('linear-gradient')]; }); })()`);
		const layers = (row: string) => `linear-gradient(rgb(0, 255, 0), rgb(0, 255, 0)), linear-gradient(${row}, ${row}), linear-gradient(rgb(32, 32, 32), rgb(32, 32, 32))`;
		assert.deepStrictEqual(rings, [
			[layers('rgba(0, 120, 255, 0.3)'), 'padding-box, border-box, border-box', '2px', '14px', 'none', true],
			[layers('rgb(32, 32, 32)'), 'padding-box, border-box, border-box', '2px', '14px', 'none', true]
		]);
	});

	test('J05: green work breathes and a red error is still; idle, a blocker and unknown activity show no dot, each named in its card\'s label (RULES-3.2)', async () => {
		await evaluate(`document.documentElement.style.cssText = '--vscode-charts-green:#00ff00;--vscode-descriptionForeground:#888888;--vscode-charts-yellow:#ffff00;--vscode-charts-red:#ff0000;--vscode-sideBar-background:#202020';`);
		const cards = await evaluate(`[newCard(1), newCard(2, { dot: 'none', stateText: 'Idle' }), newCard(3, { dot: 'none', stateText: 'Permission needed', line: 'Permission needed · Run tests?' }), newCard(4, { dot: 'none', stateText: 'Status unavailable · check terminal', line: 'Status unavailable · check terminal' }), newCard(5, { dot: 'error', stateText: 'Error · Process exited · code 2' })]`);
		await deliver({ type: 'state', state: { revision: 2, loading: false, cards, cardCount: 5, capabilities: { remote: false } } });
		const seen = await evaluate(`(() => { return [...document.querySelectorAll('.agent')].map(card => { const dot = card.querySelector('.dot'), style = getComputedStyle(dot); const paint = style.backgroundImage.match(/rgba?\\([^)]+\\)/)?.[0] ?? style.backgroundColor; return [dot.className, style.display === 'none' ? 'hidden' : paint, getComputedStyle(dot, '::after').animationName, style.boxShadow.includes('inset')]; }); })()`);
		assert.deepStrictEqual(seen, [
			['dot working', 'rgb(0, 255, 0)', 'facade-breathe', false],
			['dot none', 'hidden', 'none', false],
			['dot none', 'hidden', 'none', false],
			['dot none', 'hidden', 'none', false],
			['dot error', 'rgb(255, 0, 0)', 'none', false]
		]);
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('a card has no unread dot, completed check, bold name or extra badge (PANEL-1.4)', async () => {
		assert.deepStrictEqual(await evaluate(`(() => { const cards = [...document.querySelectorAll('.agent')]; return [document.querySelectorAll('.unread-dot, .done-mark, .codicon-check, .item.unread, .item.attention, .badge').length, new Set(cards.map(card => getComputedStyle(card.querySelector('.name')).fontWeight)).size, getComputedStyle(cards[0].querySelector('.name')).fontWeight, cards[0].querySelector('.line.bottom').children.length]; })()`), [0, 1, '400', 1]);
	});

	test('CLI words in the card, accessible label and details are literal text, never HTML or command links (PANEL-3.2)', async () => {
		const text = '[Review](command:test.run) <a href="command:test.run">Review</a>';
		assert.deepStrictEqual(await evaluate(`(() => { agents = [newCard(1, { name: ${JSON.stringify(text)}, line: ${JSON.stringify(text)}, label: ${JSON.stringify(text)}, details: detailsFor(1, { summary: { id: 'title', label: 'Title: ', value: ${JSON.stringify(text)} } }) })]; redraw({ revision: 2 }); const card = document.querySelector('.agent'); const name = card.querySelector('.name').textContent; card.querySelector('.details-button').click(); const links = document.querySelectorAll('a').length; card.querySelector('.details-button').click(); return [name === ${JSON.stringify(text)} || name.endsWith('…') && ${JSON.stringify(text)}.startsWith(name.slice(0, -1)), card.querySelector('.title').textContent, detailsOf(card).join('\\n').includes(${JSON.stringify(text)}), card.getAttribute('aria-label'), links]; })()`), [true, text, true, text, 0]);
	});

	test('working dots breathe without per-frame style recalculation, and both reduced-motion settings leave them still', async () => {
		// Give the isolated page real theme colors, and let its initial layout and compositor promotion settle.
		await evaluate(`document.documentElement.style.cssText = '--vscode-charts-green:#89d185;--vscode-sideBar-background:#252526';`);
		await call('Performance.enable');
		await wait(300);
		const metrics = async () => Object.fromEntries((await call('Performance.getMetrics')).result.metrics.map((each: { name: string; value: number }) => [each.name, each.value]));
		const before = await metrics();
		await wait(1_000);
		const after = await metrics();
		assert.ok(after.RecalcStyleCount - before.RecalcStyleCount < 10, `Working dots caused ${after.RecalcStyleCount - before.RecalcStyleCount} style recalculations in one second`);
		assert.strictEqual(await evaluate(`document.getAnimations().some(animation => animation.playState === 'running')`), true, 'working dots still breathe');
		await evaluate(`document.body.classList.add('vscode-reduce-motion')`);
		assert.strictEqual(await evaluate(`document.getAnimations().some(animation => animation.playState === 'running')`), false);
		await evaluate(`document.body.classList.remove('vscode-reduce-motion')`);
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
		assert.strictEqual(await evaluate(`document.getAnimations().some(animation => animation.playState === 'running')`), false);
		assert.strictEqual(await evaluate(`getComputedStyle(document.querySelector('.dot')).backgroundImage.match(/rgba?\\([^)]+\\)/)[0]`), 'rgb(137, 209, 133)');
	});

	test('UX-2.2: a new card opens in 200 ms, but not on the first draw, a change of filter or with reduced motion; a card that goes is removed at once, never animated out', async () => {
		const seen = await evaluate(`(() => {
			const first = document.querySelectorAll('.agent.opening').length;
			agents = [newCard(31), ...agents]; redraw({ revision: 2 });
			const opened = document.querySelector('.agent').classList.contains('opening') ? getComputedStyle(document.querySelector('.agent')).animationDuration : 'none';
			agents = agents.slice(2); redraw({ revision: 3 });
			const gone = [document.querySelectorAll('.agent').length, document.querySelectorAll('.closing').length, [...document.querySelectorAll('.agent .name')].some(name => name.textContent === 'Agent 1')];
			agents = [newCard(32), ...agents]; redraw({ revision: 4, filter: { kind: 'location', id: 'loc-1', label: 'project' } });
			const filtered = document.querySelector('.agent').classList.contains('opening');
			// The same filter again: a new card opens as ever
			agents = [newCard(34), ...agents]; redraw({ revision: 5, filter: { kind: 'location', id: 'loc-1', label: 'project' } });
			const sameFilter = document.querySelector('.agent').classList.contains('opening');
			document.body.classList.add('vscode-reduce-motion');
			agents = [newCard(33), ...agents]; redraw({ revision: 6, filter: { kind: 'location', id: 'loc-1', label: 'project' } });
			return [first, opened, gone, filtered, sameFilter, document.querySelector('.agent').classList.contains('opening')];
		})()`);
		assert.deepStrictEqual(seen, [0, '0.2s', [29, 0, false], false, true, false]);
	});

	test('filtering preserves keyboard navigation and F2 targets the visible custom agent', async () => {
		const result = await evaluate(`(() => {
			document.querySelector('[data-run="run-1"]').focus();
			agents = [newCard(2, { avatar: { file: 'robot-teal-face.svg', eyes: 'robot-eyes.svg' } }), newCard(3)];
			redraw({ revision: 2, filter: { kind: 'location', id: 'filtered', label: 'main' } });
			const stops = [...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0);
			stops[0].focus();
			window.posted = [];
			stops[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
			return [stops.map(card => card.dataset.run), stops[0].querySelector('.face img').getAttribute('src').split('/').pop(),
				window.posted.filter(message => message.type === 'act').map(({ what, target }) => [what, target])];
		})()`);
		assert.deepStrictEqual(result, [['run-2'], 'robot-teal-face.svg', [['rename', 'run-2']]]);
	});

	test('PANEL-1.5, LIFECYCLE-3.1: an agent with an empty name is said by its #aN when its state changes', async () => {
		await evaluate(`agents[0] = newCard(1, { name: '' }); redraw()`);
		await evaluate(`agents[0] = newCard(1, { name: '', dot: 'none', stateText: 'Idle' }); redraw()`);
		assert.strictEqual(await evaluate(`document.querySelector('[role="status"]').textContent`), '#a1: Idle');
	});

	test('UX-2.2: a card whose process ended, in view, fades as its row closes up from its own height where it was - the cards after it are not put before it - and then goes; one out of view goes at once', async () => {
		await evaluate(`agents.splice(4, 1); redraw({ exited: ['run-5'] })`);
		const during = await evaluate(`(() => { const children = [...document.querySelector('#list').children]; const closing = document.querySelector('.agent.closing'); return [closing?.dataset.run, children.indexOf(closing), children.length, closing?.style.getPropertyValue('--facade-closing-height'), closing?.getAttribute('aria-hidden'), closing?.tabIndex]; })()`);
		await becomes(`!document.querySelector('.agent.closing')`, 3_000);
		const after = await evaluate(`[document.querySelectorAll('.agent.closing').length, document.querySelectorAll('.agent').length]`);
		await evaluate(`agents.splice(-1, 1); redraw({ exited: ['run-30'] })`);
		const away = await evaluate(`[document.querySelectorAll('.agent.closing').length, document.querySelectorAll('.agent').length]`);
		assert.deepStrictEqual([during, after, away], [['run-5', 4, 30, '44px', 'true', -1], [0, 29], [0, 28]]);
	});

	test('a state change is said politely, once, in a live region; a repeated state says nothing new (PANEL-1.5)', async () => {
		const said = await evaluate(`(() => {
			const status = document.querySelector('[role=status]');
			agents[0] = newCard(1, { dot: 'none', stateText: 'Idle' }); agents[1] = newCard(2, { dot: 'error', stateText: 'Error · Process exited · code 2' }); redraw({ revision: 2 });
			const first = status.textContent;
			agents[0] = newCard(1, { dot: 'none', stateText: 'Idle', line: 'Another line' }); redraw({ revision: 3 });
			return [status.getAttribute('aria-live'), first, status.textContent];
		})()`);
		assert.deepStrictEqual(said, ['polite', 'Agent 1: Idle. Agent 2: Error · Process exited · code 2', 'Agent 1: Idle. Agent 2: Error · Process exited · code 2']);
	});

	test('PANEL-1.3: no card shows a location; a short name and its short ID stay together, the Pin at the line\'s right; a long name gives way first, ending between whole graphemes, and comes back whole as the panel widens', async () => {
		const seen = await evaluate(`(async () => {
			const long = 'Refactor the authentication middleware 👩🏽‍💻👩🏽‍💻👩🏽‍💻 Cafe\u0301 and everything around it';
			agents = [
				newCard(1, { name: long, repeated: true, details: detailsFor(1, { location: { id: 'location', label: 'Location: ', value: 'api · main', kind: 'repo' } }) }),
				newCard(2, { name: 'Ada', repeated: true, pinned: true }),
				newCard(3, { name: long, repeated: true, pinned: true }),
				newCard(4, { name: '' }),
				newCard(5, { name: 'Ada', pinned: true }),
				newCard(6, { name: 'Ada' })
			];
			document.body.style.width = '260px';
			redraw({ revision: 3 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const read = () => [...document.querySelectorAll('.agent')].map(card => {
				const top = card.querySelector('.top').getBoundingClientRect(), name = card.querySelector('.name'), id = card.querySelector('.short-id'), pin = card.querySelector('.pin');
				const nameBox = name.getBoundingClientRect(), idBox = id?.getBoundingClientRect(), pinBox = pin?.getBoundingClientRect();
				// The Pin's place: 7 px in from the card's right, as from its top
				return { name: name.textContent, id: id?.textContent, idGap: idBox && idBox.left - nameBox.right, pinGap: pinBox && pinBox.left - (idBox ?? nameBox).right, pinEnd: pinBox && card.getBoundingClientRect().right - 7 - pinBox.right, end: top.right - (pinBox ?? idBox ?? nameBox).right, text: card.textContent };
			});
			const narrow = read();
			const segment = text => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(each => each.segment);
			const whole = narrow.filter(row => row.name.endsWith('…')).every(row => segment(row.name.slice(0, -1)).every(part => segment(long).includes(part)));
			const hover = detailsOf(document.querySelector('.agent')).join('\\n'), label = document.querySelector('.agent').getAttribute('aria-label');
			document.body.style.width = '900px';
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const wide = read();
			document.body.style.width = '';
			return { narrow, whole, hover, wide, long, errors: window.errors };
		})()`);
		const [cut, short, cutPinned, empty, pinned, plain] = seen.narrow;
		assert.deepStrictEqual([seen.errors, seen.whole], [[], true]);
		assert.ok(seen.narrow.every((row: { text: string }) => !row.text.includes('project') && !row.text.includes('main')), 'no card says where it works');
		assert.ok(seen.hover.split('\n').includes('api · main'), 'its details do');
		assert.ok(cut.name.endsWith('…') && cut.id === '#a1' && cut.idGap >= 3.5 && cut.end >= -1, JSON.stringify(cut));
		assert.ok(short.name === 'Ada' && short.id === '#a2' && Math.abs(short.idGap - 4) <= 1 && short.pinGap > 40 && Math.abs(short.pinEnd) <= 1, JSON.stringify(short));
		assert.ok(cutPinned.name.endsWith('…') && cutPinned.id === '#a3' && cutPinned.pinGap >= 3.5 && Math.abs(cutPinned.pinEnd) <= 1, JSON.stringify(cutPinned));
		assert.deepStrictEqual([empty.name, empty.id], ['#a4', undefined], 'an empty name shows its short ID alone, as a name');
		assert.ok(pinned.id === undefined && Math.abs(pinned.pinEnd) <= 1, JSON.stringify(pinned));
		assert.ok(plain.id === undefined && plain.end > 40, 'an unpinned card reserves no Pin box');
		assert.strictEqual(seen.wide[0].name, seen.long.replace(/\s+/g, ' '), 'widened, the original name comes back');
	});

	test('PANEL-3.2: a state the extension sends is drawn whichever of a card\'s fields it has - two cards of one name with their short IDs among them; none is refused', async () => {
		// Every field a card can have: a field the host's cards gain that the page's check does not know fails here, as `repeated` did
		const every: { readonly [K in keyof Required<Card>]: Card[K] } = {
			pinned: true, runId: 'run-1', selected: true, name: 'Ada', alias: '#a1', avatar: { file: 'avatar-claude.png' }, repeated: true,
			dot: 'working', stateText: 'Working', line: '📨 Check the build',
			details: { summary: { id: 'title', label: 'Title: ', value: 'Check the build' }, titleLabel: 'Title: ', untitled: 'No title yet', startedBy: 'Maker #a7', location: { id: 'location', label: 'Location: ', value: 'main', kind: 'repo' }, path: { id: 'path', label: 'Path: ', value: '/project' }, description: { title: 'Title: Check the build', place: 'Path: /project' } },
			label: 'Ada, #a1, Working', startedAt: Date.now(), menu: { pin: false, unpin: true, moveUp: false, moveDown: true }
		};
		const twin: Card = { ...every, pinned: undefined, selected: false, runId: 'run-2', alias: '#a2', avatar: { file: 'robot-sky-face.svg', eyes: 'robot-eyes.svg' }, menu: { pin: true, moveUp: true, moveDown: false } };
		const other: Card = { ...twin, repeated: undefined, runId: 'run-3', name: 'Cy', alias: '#a3' };
		await deliver({ type: 'state', state: { revision: 7, loading: false, cards: [every, twin, other], cardCount: 3, capabilities: { remote: false }, clockAt: Date.now() } });
		await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
		assert.deepStrictEqual(await evaluate(`[window.errors, [...document.querySelectorAll('.agent')].map(card => [card.querySelector('.name').textContent, card.querySelector('.short-id')?.textContent ?? null])]`),
			[[], [['Ada', '#a1'], ['Ada', '#a2'], ['Cy', null]]]);
	});

	test('PANEL-1.3: Pin and Unpin refit the same card, and a repeated name\'s ID comes and goes without losing its name', async () => {
		const seen = await evaluate(`(async () => {
			document.body.style.width = '220px';
			agents = [newCard(1, { name: 'A name long enough to need most of the first line of its card' })];
			redraw({ revision: 2 });
			const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			await settle();
			const card = document.querySelector('.agent');
			const read = () => ({ name: card.querySelector('.name').textContent, pin: !!card.querySelector('.pin'), id: card.querySelector('.short-id')?.textContent });
			const before = read();
			agents[0] = { ...agents[0], pinned: true }; redraw({ revision: 3 }); await settle();
			const pinned = read();
			agents[0] = { ...agents[0], repeated: true }; redraw({ revision: 4 }); await settle();
			const both = read();
			agents[0] = { ...agents[0], pinned: false, repeated: undefined }; redraw({ revision: 5 }); await settle();
			document.body.style.width = '';
			return [before, pinned, both, read()];
		})()`);
		const [before, pinned, both, after] = seen as { name: string; pin: boolean; id?: string }[];
		assert.deepStrictEqual([before.pin, pinned.pin, both.pin, both.id, after.pin, after.id], [false, true, true, '#a1', false, undefined]);
		assert.ok(pinned.name.length < before.name.length && both.name.length < pinned.name.length, JSON.stringify(seen));
		assert.deepStrictEqual(after, before, 'Unpin returns all of the space to the name');
	});

	test('U13: first-line bounds survive narrow widths, theme changes and zoom scales', async function () {
		this.timeout(60_000);
		// Bundled VS Code theme values and their registered defaults. Scaling the CSS viewport and output together emulates editor zoom.
		const themes = [
			{ name: 'dark-modern', kind: 'vscode-dark', background: '#181818', foreground: '#cccccc', secondary: '#9d9d9d', green: '#89d185', yellow: '#cca700', red: '#f14c4c' },
			{ name: 'light-modern', kind: 'vscode-light', background: '#f8f8f8', foreground: '#3b3b3b', secondary: '#3b3b3b', green: '#388a34', yellow: '#bf8803', red: '#e51400' },
			{ name: 'hc-dark', kind: 'vscode-high-contrast', background: '#000000', foreground: '#ffffff', secondary: '#ffffffb3', green: '#89d185', yellow: '#ffd370', red: '#f48771' },
			{ name: 'hc-light', kind: 'vscode-high-contrast-light', background: '#ffffff', foreground: '#292929', secondary: '#292929b3', green: '#374e06', yellow: '#895503', red: '#b5200d' },
			{ name: 'solarized-light', kind: 'vscode-light', background: '#eee8d5', foreground: '#616161', secondary: '#717171', green: '#388a34', yellow: '#bf8803', red: '#e51400' }
		];
		const capture = process.env.FACADE_PANEL_CAPTURE;
		if (capture) { fs.mkdirSync(capture, { recursive: true }); }
		const root = path.resolve(__dirname, '../../..');
		const logo = `data:image/png;base64,${fs.readFileSync(path.join(root, 'media/agents/avatar-claude.png')).toString('base64')}`;
		for (const theme of themes) {
			await evaluate(`(() => {
				document.body.className = ${JSON.stringify(theme.kind)};
				const vars = ${JSON.stringify({ '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', '--vscode-sideBar-background': theme.background, '--vscode-foreground': theme.foreground, '--vscode-descriptionForeground': theme.secondary, '--vscode-charts-green': theme.green, '--vscode-charts-yellow': theme.yellow, '--vscode-charts-red': theme.red })};
				for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
				document.body.style.backgroundColor = ${JSON.stringify(theme.background)};
				agents = [
					newCard(1, { name: 'Ada', repeated: true, line: '✳ Improving the panel layout' }),
					newCard(2, { name: 'Moss', dot: 'none', stateText: 'Idle', line: 'Ready for input' }),
					newCard(3, { name: 'Luna', dot: 'none', stateText: 'Permission needed', line: 'Permission needed · Run tests?' }),
					newCard(4, { name: 'Nova', dot: 'error', stateText: 'Error · Connection lost', line: 'Connection lost' }),
					newCard(5, { name: 'Authentication middleware helper with a long name', repeated: true, pinned: true, line: 'OC | Update the login flow' }),
					newCard(6, { name: '小林 👩🏽‍💻', pinned: true, line: '正在调整工作区显示' })
				]; redraw({ revision: 3 });
				for (const img of document.querySelectorAll('.face img')) img.src = ${JSON.stringify(logo)};
			})()`);
			for (const width of [180, 260, 420, 720]) {
				for (const zoom of [-1, 0, 2]) {
					const factor = 1.2 ** zoom;
					await call('Emulation.setDeviceMetricsOverride', { width: Math.round(width / factor), height: Math.round(340 / factor), deviceScaleFactor: factor * 2, mobile: false });
					await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
					const result = await evaluate(`(() => {
						const rows = [...document.querySelectorAll('.agent')].map(card => {
							const top = card.querySelector('.top').getBoundingClientRect(), pin = card.querySelector('.pin')?.getBoundingClientRect();
							const flow = [card.querySelector('.name'), card.querySelector('.short-id')].filter(Boolean).map(part => part.getBoundingClientRect()), parts = pin ? [...flow, pin] : flow;
							// The Pin in its place 7 px in from the card's right; the name and ID within the line
							return { gaps: parts.slice(1).map((part, i) => part.left - parts[i].right), over: flow[flow.length - 1].right - top.right, pinned: !!pin, pinAtEnd: pin ? Math.abs(card.getBoundingClientRect().right - 7 - pin.right) : 0 };
						});
						return { rows, overflow: document.documentElement.scrollWidth > window.innerWidth, errors: window.errors, colours: [...document.querySelectorAll('.dot')].slice(0, 4).map(dot => getComputedStyle(dot).display === 'none' ? 'none' : getComputedStyle(dot).backgroundImage.match(/rgba?\\([^)]+\\)/)[0]) };
					})()`);
					const context = `${theme.name}, ${width}px, zoom ${zoom}: ${JSON.stringify(result)}`;
					assert.ok(result.rows.every((row: { gaps: number[]; over: number; pinned: boolean; pinAtEnd: number }) => row.gaps.every(gap => gap >= 3.5) && row.over <= 1 && (!row.pinned || row.pinAtEnd <= 1)), context);
					assert.strictEqual(result.overflow, false, context);
					assert.deepStrictEqual(result.errors, [], context);
					// Work green and an error red, apart; idle and a blocker without a dot (RULES-3.2)
					assert.deepStrictEqual([result.colours[1], result.colours[2], new Set([result.colours[0], result.colours[3], 'none']).size], ['none', 'none', 3], context);
					if (capture && zoom === 0 && (width === 260 || width === 420)) {
						const shot = await call('Page.captureScreenshot', { format: 'png' });
						fs.writeFileSync(path.join(capture, `${theme.name}-${width}.png`), Buffer.from(shot.result.data, 'base64'));
					}
				}
			}
		}
		if (capture) {
			fs.writeFileSync(path.join(capture, 'environment.json'), JSON.stringify({ browser: (await call('Browser.getVersion')).result, isolatedProfile: profile, widths: [180, 260, 420, 720], emulatedZoom: [-1, 0, 2], themes: themes.map(theme => theme.name) }, null, 2));
		}
	});

	test('PANEL-1.5: nothing in the panel has a native tooltip, and with its buttons hidden a card is the card itself under the pointer, its dot and Pin included', async () => {
		const seen = await evaluate(`(async () => {
			document.body.style.width = '300px';
			agents = [
				newCard(1, { selected: true }),
				newCard(2, { name: 'Refactor the authentication middleware', repeated: true, pinned: true, menu: { unpin: true, moveUp: false, moveDown: true } }),
				newCard(3, { menu: { pin: true, moveUp: true, moveDown: false } })
			];
			redraw({ revision: 3 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const under = new Set();
			for (const card of document.querySelectorAll('.agent')) {
				const box = card.getBoundingClientRect();
				for (let y = box.top + 1; y < box.bottom - 1; y += 3) {
					for (let x = box.left + 5; x < box.right - 5; x += 3) {
						const at = document.elementFromPoint(x, y);
						under.add(at === card ? 'card' : String(at.className?.baseVal ?? at.className) || at.tagName);
					}
				}
			}
			document.body.style.width = '';
			return [[...under].sort(), document.querySelectorAll('[title]').length];
		})()`);
		assert.deepStrictEqual(seen, [['card'], 0]);
	});

	test('PANEL-1.3: the pointer on a pinned card puts its Pin button where its Pin was, whose click Unpins without opening the card', async () => {
		const seen = await evaluate(`(async () => {
			agents = [newCard(1, { pinned: true, menu: { unpin: true, moveUp: false, moveDown: true } }), newCard(2)];
			redraw({ revision: 2 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const mark = document.querySelector('.agent .pin svg').getBoundingClientRect();
			window.posted = [];
			return { x: mark.left + mark.width / 2, y: mark.top + mark.height / 2 };
		})()`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seen.x, y: seen.y });
		const shown = await evaluate(`(() => {
			const card = document.querySelector('.agent'), icon = card.querySelector('.pin-button svg').getBoundingClientRect();
			return { mark: getComputedStyle(card.querySelector('.pin')).display, visible: getComputedStyle(card.querySelector('.actions')).visibility, under: document.elementFromPoint(${seen.x}, ${seen.y}).className, x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 };
		})()`);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await call('Input.dispatchMouseEvent', { type, x: seen.x, y: seen.y, button: 'left', clickCount: 1 });
		}
		const acted = await evaluate(`window.posted.filter(message => message.type === 'act').map(message => [message.what, message.target])`);
		assert.deepStrictEqual([shown.mark, shown.visible, shown.under, acted], ['none', 'visible', 'action pin-button', [['unpin', 'run-1']]]);
		assert.ok(Math.abs(shown.x - seen.x) <= 1 && Math.abs(shown.y - seen.y) <= 1, JSON.stringify([seen, shown]));
	});

	test('PANEL-1.3: the pointer on a card shows its ⓘ, gear and - where it has one - Pin at the first line\'s end, its name giving them room, and they go with the pointer', async () => {
		const seen = await evaluate(`(async () => {
			document.body.style.width = '260px';
			agents = [newCard(1, { name: 'A name long enough to need most of the first line of its card', menu: { pin: true, moveUp: false, moveDown: true } }), newCard(2, { name: 'Short' }), newCard(3)];
			redraw({ revision: 2 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const [first, second] = [...document.querySelectorAll('.agent')].map(card => card.getBoundingClientRect());
			return { first: { x: first.left + 40, y: first.top + 10 }, second: { x: second.left + 40, y: second.top + 10 }, name: document.querySelector('.agent .name').textContent };
		})()`);
		const read = () => evaluate(`[...document.querySelectorAll('.agent')].slice(0, 2).map(card => {
			const buttons = [...card.querySelectorAll('.action')].filter(button => !button.hidden), boxes = buttons.map(button => button.getBoundingClientRect());
			const name = card.querySelector('.name').getBoundingClientRect(), box = card.getBoundingClientRect(), icon = buttons[0].querySelector('svg').getBoundingClientRect();
			return { visible: getComputedStyle(card.querySelector('.actions')).visibility, kinds: buttons.map(button => button.classList[1]), name: card.querySelector('.name').textContent, room: boxes[0].left - name.right,
				insets: [boxes[0].top - box.top, box.right - boxes[boxes.length - 1].right].map(Math.round), iconTop: Math.round(icon.top - box.top), sizes: boxes.map(each => [each.width, each.height]) };
		})`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seen.first.x, y: seen.first.y });
		const over = await read();
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seen.second.x, y: seen.second.y });
		const moved = await read();
		assert.deepStrictEqual([over[0].visible, over[0].kinds, over[1].visible, moved[0].visible, moved[1].visible, moved[1].kinds],
			['visible', ['details-button', 'menu-button', 'pin-button'], 'hidden', 'hidden', 'visible', ['details-button', 'menu-button']]);
		assert.ok(over[0].name.endsWith('…') && over[0].name.length < seen.name.length && over[0].room >= 3.5, JSON.stringify([seen, over[0]]));
		// As far from the card's top as from its right, the icons centered on the first line
		assert.deepStrictEqual([over[0].insets, over[0].iconTop, moved[1].insets], [[5, 5], 7, [5, 5]]);
		assert.ok(over[0].sizes.every(([width, height]: number[]) => width === 18 && height === 18), JSON.stringify(over[0].sizes));
		assert.strictEqual(moved[0].name, seen.name, 'the name takes its room back as the pointer goes');
	});

	test('PANEL-2.2: the gear opens its card\'s native menu under it, Shift+F10 and the menu key too, the card keeping its buttons while the editor shows it; a right click opens nothing', async () => {
		const seen = await evaluate(`(async () => {
			agents = [newCard(1, { menu: { moveUp: false, moveDown: true } }), newCard(2)];
			redraw({ revision: 2 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			// A context menu event as the editor's webview takes it: the card it is on, where, and whether the page let it through
			window.menus = [];
			window.addEventListener('contextmenu', event => window.menus.push([event.target.closest?.('.agent')?.dataset.run ?? null, Math.round(event.clientX), Math.round(event.clientY), event.isTrusted, event.defaultPrevented]));
			window.posted = [];
			const [first, second] = [...document.querySelectorAll('.agent')].map(card => card.getBoundingClientRect());
			return { first: { x: first.left + 40, y: first.top + 10 }, second: { x: Math.round(second.left + 40), y: Math.round(second.top + 10) } };
		})()`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seen.first.x, y: seen.first.y });
		const gear = await evaluate(`(() => { const box = document.querySelector('.agent .menu-button').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: Math.round(box.left), bottom: Math.round(box.bottom) }; })()`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gear.x, y: gear.y });
		for (const type of ['mousePressed', 'mouseReleased']) {
			await call('Input.dispatchMouseEvent', { type, x: gear.x, y: gear.y, button: 'left', clickCount: 1 });
		}
		const opened = await evaluate(`(() => { const card = document.querySelector('.agent'); return [card.classList.contains('menu-open'), card.querySelector('.menu-button').classList.contains('active'), window.posted.filter(message => message.type === 'act').length]; })()`);
		// The editor marks the page while its menu shows, and unmarks it as the menu closes
		const closed = await evaluate(`(async () => {
			document.body.classList.add('vscode-context-menu-visible');
			await new Promise(resolve => setTimeout(resolve, 0));
			document.body.classList.remove('vscode-context-menu-visible');
			await new Promise(resolve => setTimeout(resolve, 0));
			return document.querySelector('.agent').classList.contains('menu-open');
		})()`);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await call('Input.dispatchMouseEvent', { type, x: seen.second.x, y: seen.second.y, button: 'right', clickCount: 1 });
		}
		const menus = await evaluate(`(() => {
			const card = document.querySelector('.agent');
			card.focus();
			card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
			card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
			return window.menus;
		})()`);
		assert.deepStrictEqual([opened, closed], [[true, true, 0], false]);
		assert.deepStrictEqual(menus, [
			['run-1', gear.left, gear.bottom, false, false],
			['run-2', seen.second.x, seen.second.y, true, true],
			['run-1', gear.left, gear.bottom, false, false],
			['run-1', gear.left, gear.bottom, false, false]
		]);
	});

	/**
	 * Two cards, the first's middle and gear, the second's middle and a place below them: the page as a card's menu tests take it. The
	 * editor marks the page as it shows the menu the page's own context menu event asks for, unless a test holds that back.
	 */
	const menuCards = () => evaluate(`(async () => {
		agents = [newCard(1), newCard(2)];
		redraw({ revision: 2 });
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		window.marking = true;
		window.addEventListener('contextmenu', event => {
			if (!event.isTrusted && window.marking) {
				setTimeout(() => document.body.classList.add('vscode-context-menu-visible'), 0);
			}
		});
		const [card, last] = [...document.querySelectorAll('.agent')].map(each => each.getBoundingClientRect()), gear = document.querySelector('.agent .menu-button').getBoundingClientRect();
		return { card: { x: card.left + 40, y: card.top + 10 }, gear: { x: gear.left + gear.width / 2, y: gear.top + gear.height / 2 }, second: { x: last.left + 40, y: last.top + 10 }, below: { x: card.left + 40, y: last.bottom + 60 } };
	})()`);
	/** The pointer's move out of the page: the leave a page hears as the pointer moves on the menu the editor draws over it. */
	const away = async () => {
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -1, y: -1 });
		await wait(30);
	};
	/** Shift+F10 on the first card, which opens its menu. */
	const keysOpen = `(() => { const card = document.querySelector('.agent'); card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); })()`;

	test('PANEL-2.2: the editor\'s menu over the page takes the pointer from it; the click on the card that closes the menu leaves the card as under the pointer - its buttons and hover colour - until the page sees the pointer again', async () => {
		const seen = await menuCards();
		await evaluate(`document.documentElement.style.setProperty('--vscode-list-hoverBackground', 'rgb(1, 2, 3)')`);
		const read = `(() => { const card = document.querySelector('.agent'); return [getComputedStyle(card.querySelector('.actions')).visibility, getComputedStyle(card).backgroundColor, card.querySelector('.menu-button').classList.contains('active')]; })()`;
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.card });
		await pressAt(seen.gear);
		// The pointer moves on the menu, which the editor draws in its window over the page where its menus are not native
		await away();
		const shown = await evaluate(read);
		// The press on the card closes the menu, the editor unmarking the page, before anything of the pointer reaches the page
		const closed = await evaluate(`(async () => { document.body.classList.remove('vscode-context-menu-visible'); await new Promise(resolve => setTimeout(resolve, 0)); return ${read}; })()`);
		// Its release does, on the card
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.card });
		await wait(30);
		const back = await evaluate(read);
		assert.deepStrictEqual([shown, closed, back], [['visible', 'rgb(1, 2, 3)', true], ['visible', 'rgb(1, 2, 3)', false], ['visible', 'rgb(1, 2, 3)', false]]);
	});

	test('PANEL-2.2, UX-2.1: a menu the keys open on one card while the pointer rests on another leaves that one as under the pointer once the menu closes - in high contrast its dashed edge - and while a menu opened again before the page hears of the pointer shows', async () => {
		const seen = await menuCards();
		await evaluate(`document.body.classList.add('vscode-high-contrast'); document.documentElement.style.setProperty('--vscode-contrastActiveBorder', 'rgb(4, 5, 6)')`);
		const read = `(() => { const card = document.querySelectorAll('.agent')[1]; return [getComputedStyle(card.querySelector('.actions')).visibility, getComputedStyle(card).outlineStyle]; })()`;
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.second });
		await wait(30);
		const over = await evaluate(read);
		await evaluate(keysOpen);
		await wait(30);
		await away();
		const shown = await evaluate(read);
		const closed = await evaluate(`(async () => { document.body.classList.remove('vscode-context-menu-visible'); await new Promise(resolve => setTimeout(resolve, 0)); return ${read}; })()`);
		// Opened again at once by the keys, the editor showing it only after the second the closed one left the card has passed
		const again = await evaluate(`(async () => {
			window.marking = false;
			${keysOpen};
			await new Promise(resolve => setTimeout(resolve, 1300));
			const showing = ${read};
			document.body.classList.add('vscode-context-menu-visible');
			await new Promise(resolve => setTimeout(resolve, 0));
			document.body.classList.remove('vscode-context-menu-visible');
			await new Promise(resolve => setTimeout(resolve, 0));
			return [showing, ${read}];
		})()`);
		// The menu not yet shown, nothing keeps the dashed edge from the card under the pointer
		assert.deepStrictEqual([over, shown, closed, ...again], [['visible', 'dashed'], ['visible', 'none'], ['visible', 'dashed'], ['visible', 'dashed'], ['visible', 'dashed']]);
	});

	test('PANEL-2.2: a card going while its menu shows leaves the pointer the menu\'s: the card under the pointer stays as it was until the editor closes the menu, whether the pointer moved before the card went or after', async () => {
		const seen = await menuCards();
		const buttons = `getComputedStyle(document.querySelector('.agent .actions')).visibility`;
		// The menu of the second card, the pointer resting on the first, which stays where it is as the second goes
		const openSecond = `(() => { const card = document.querySelectorAll('.agent')[1]; card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); })()`;
		const closeLater = `(async () => {
			await new Promise(resolve => setTimeout(resolve, 1300));
			const showing = ${buttons};
			document.body.classList.remove('vscode-context-menu-visible');
			await new Promise(resolve => setTimeout(resolve, 0));
			return [document.querySelectorAll('.agent').length, showing, ${buttons}];
		})()`;
		const phases = [];
		for (const movedFirst of [true, false]) {
			await evaluate(`agents = [newCard(1), newCard(2)]; redraw({ revision: ${movedFirst ? 3 : 5} })`);
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.card });
			await wait(30);
			await evaluate(openSecond);
			await wait(30);
			if (movedFirst) {
				await away();
			}
			await evaluate(`agents = [agents[0]]; redraw({ revision: ${movedFirst ? 4 : 6} })`);
			if (!movedFirst) {
				await away();
			}
			phases.push(await evaluate(closeLater));
		}
		assert.deepStrictEqual(phases, [[1, 'visible', 'visible'], [1, 'visible', 'visible']]);
	});

	test('PANEL-2.2: a menu the editor shows only after the page took it for one never shown has the pointer all the same: the card under the pointer stays as it was until that menu closes', async () => {
		const seen = await menuCards();
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.second });
		await wait(30);
		await evaluate(`window.marking = false; ${keysOpen}`);
		await wait(30);
		await away();
		const late = await evaluate(`(async () => {
			const buttons = () => getComputedStyle(document.querySelectorAll('.agent')[1].querySelector('.actions')).visibility;
			const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
			// Past the page's second for the editor to show the menu, which then shows at last
			await sleep(1100);
			document.body.classList.add('vscode-context-menu-visible');
			// Past the second the page would have waited for the pointer had the menu not shown
			await sleep(1200);
			const showing = buttons();
			document.body.classList.remove('vscode-context-menu-visible');
			await sleep(0);
			return [showing, buttons()];
		})()`);
		assert.deepStrictEqual(late, ['visible', 'visible']);
	});

	test('PANEL-2.2: a menu opened again, which the editor shows late, is no menu the editor never showed to the check of the one before it', async () => {
		await menuCards();
		const marks = await evaluate(`(async () => {
			const card = document.querySelector('.agent');
			const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
			${keysOpen};
			await sleep(300);
			// Esc closes it
			document.body.classList.remove('vscode-context-menu-visible');
			await sleep(300);
			// Opened again, the editor showing this one only after the first's second has passed
			window.marking = false;
			${keysOpen};
			await sleep(550);
			const kept = card.classList.contains('menu-open');
			document.body.classList.add('vscode-context-menu-visible');
			await sleep(0);
			const shown = card.classList.contains('menu-open');
			document.body.classList.remove('vscode-context-menu-visible');
			await sleep(0);
			return [kept, shown, card.classList.contains('menu-open')];
		})()`);
		assert.deepStrictEqual(marks, [true, true, false]);
	});

	test('PANEL-2.2: once the editor\'s menu closes, the card it took the pointer from loses its buttons where the page sees the pointer off it, or a second on where it sees nothing of it; a card whose pointer the menu never took keeps them', async () => {
		const seen = await menuCards();
		const buttons = `getComputedStyle(document.querySelector('.agent .actions')).visibility`;
		const open = async () => {
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.card });
			await pressAt(seen.gear);
		};
		const close = () => evaluate(`(async () => { document.body.classList.remove('vscode-context-menu-visible'); await new Promise(resolve => setTimeout(resolve, 0)); return ${buttons}; })()`);
		// Closed by a press below the cards, whose release the page sees there
		await open();
		await away();
		const kept = await close();
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.below });
		await wait(30);
		const below = await evaluate(buttons);
		// Closed by a press outside the view: the page sees nothing more. Kept as long as a click's release can take to reach a busy
		// window's page, then gone
		await open();
		await away();
		const timed = await evaluate(`(async () => {
			document.body.classList.remove('vscode-context-menu-visible');
			const closedAt = performance.now();
			await new Promise(resolve => setTimeout(resolve, 300));
			const later = ${buttons};
			while (${buttons} === 'visible' && performance.now() - closedAt < 4000) {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			return [later, ${buttons}, performance.now() - closedAt];
		})()`);
		// The pointer stays on the page while the menu shows - a native menu, as macOS's, takes nothing from the page: the card keeps its
		// buttons as long as the pointer rests on it
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seen.card });
		await wait(30);
		await evaluate(keysOpen);
		await wait(30);
		const stayed = await evaluate(`(async () => {
			document.body.classList.remove('vscode-context-menu-visible');
			await new Promise(resolve => setTimeout(resolve, 1500));
			return ${buttons};
		})()`);
		assert.deepStrictEqual([kept, below, timed[0], timed[1], stayed], ['visible', 'hidden', 'visible', 'hidden', 'visible']);
		assert.ok(timed[2] < 4000, `gone ${Math.round(timed[2])} ms after the menu closed`);
	});

	test('PANEL-1.5, UX-2.2: the ⓘ opens its card\'s details under it, as wide as it, their arrow at the ⓘ, fading in as they slide 10 px down over 400 ms; Esc, a press elsewhere, the ⓘ again and the card going close them at once; the same words again keep their rows and a selection in them', async () => {
		const seen = await evaluate(`(async () => {
			const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			agents = [newCard(1, { pinned: true, menu: { unpin: true, moveUp: false, moveDown: true }, details: detailsFor(1, { summary: { id: 'title', label: 'Title: ', value: 'Fix the login' } }) }), newCard(2), newCard(3)];
			redraw({ revision: 2 });
			await frames();
			const card = document.querySelector('.agent'), info = card.querySelector('.details-button'), details = document.querySelector('.details');
			// Closed as the person asked: gone at once, out of the accessibility tree
			const closed = () => details.hidden && !details.classList.contains('open') && details.getAttribute('aria-hidden') === 'true';
			info.click();
			const entering = [getComputedStyle(details).opacity, getComputedStyle(details).translate];
			await frames();
			const style = getComputedStyle(details);
			const motion = [style.transitionProperty, style.transitionDuration];
			// Await the transitions themselves: CI can delay a rendering frame beyond a wall-clock sleep.
			await Promise.all(details.getAnimations().map(animation => animation.finished));
			motion.push(style.opacity, style.translate);
			const box = card.getBoundingClientRect(), shown = details.getBoundingClientRect(), arrow = details.querySelector('.details-arrow').getBoundingClientRect(), button = info.getBoundingClientRect();
			const open = { role: details.getAttribute('role'), named: wordsOf(document.getElementById(details.getAttribute('aria-labelledby')).parentElement), ariaHidden: details.getAttribute('aria-hidden'), shown: details.classList.contains('open'),
				below: shown.top >= box.bottom, width: Math.round(shown.width) === Math.round(box.width), left: Math.round(shown.left) === Math.round(box.left), arrowAtInfo: Math.abs(arrow.left + arrow.width / 2 - (button.left + button.width / 2)) <= 2,
				rows: details.querySelectorAll('.details-fact').length, extras: details.querySelectorAll('.face, .details-note, .details-head, .details-group').length,
				buttons: card.querySelector('.actions').getAttribute('aria-hidden'), visible: getComputedStyle(card.querySelector('.actions')).visibility, pressed: info.classList.contains('active') };
			const first = details.querySelector('.details-fact');
			getSelection().selectAllChildren(details.querySelector('.details-scroll'));
			redraw({ revision: 3 });
			const kept = details.querySelector('.details-fact') === first && getSelection().toString().includes('Fix the login');
			getSelection().removeAllRanges();
			card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			const escaped = closed();
			info.click();
			document.querySelectorAll('.agent')[2].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			const pressed = closed();
			info.click(); info.click();
			const again = closed();
			info.click();
			agents = agents.slice(1); redraw({ revision: 4 });
			const gone = closed();
			return { entering, motion, open, kept, closed: [escaped, pressed, again, gone], acts: window.posted.filter(message => message.type === 'act').length, errors: window.errors };
		})()`);
		assert.deepStrictEqual([seen.entering, seen.motion], [['0', '0px -10px'], ['opacity, translate', '0.4s, 0.4s', '1', 'none']]);
		assert.deepStrictEqual(seen.open, { role: 'dialog', named: 'Agent 1 #a1', ariaHidden: null, shown: true, below: true, width: true, left: true, arrowAtInfo: true, rows: 5, extras: 0, buttons: 'true', visible: 'visible', pressed: true });
		assert.deepStrictEqual([seen.kept, seen.closed, seen.acts, seen.errors], [true, [true, true, true, true], 0, []]);
	});

	test('PANEL-1.5, UX-2.3: Show Agent Details opens a card\'s details with the focus in them; the scroll keys scroll them alone, Esc takes the focus back to the card, and the focus leaving them closes them', async () => {
		// Focus events as a focused window has them
		await call('Emulation.setFocusEmulationEnabled', { enabled: true });
		const seen = await evaluate(`(async () => {
			const frames = (count = 3) => new Promise(resolve => { const next = left => left ? requestAnimationFrame(() => next(left - 1)) : resolve(); next(count); });
			const long = Array.from({ length: 120 }, (_, i) => 'word' + i).join(' ');
			agents = [newCard(1), newCard(2, { details: detailsFor(2, { summary: { id: 'title', label: 'Title: ', value: long } }) }), newCard(3)];
			redraw({ revision: 2 });
			await frames();
			const details = document.querySelector('.details'), scroll = details.querySelector('.details-scroll'), [, second, third] = document.querySelectorAll('.agent');
			window.dispatchEvent(new MessageEvent('message', { data: { page: panel.page, type: 'details', run: 'run-2' } }));
			await frames();
			const opened = [document.activeElement === scroll, scroll.tabIndex, second.classList.contains('details-open'), scroll.scrollHeight > scroll.clientHeight];
			const listTop = (document.scrollingElement ?? document.documentElement).scrollTop;
			scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
			const scrolled = [scroll.scrollTop > 0, (document.scrollingElement ?? document.documentElement).scrollTop === listTop, details.classList.contains('open')];
			scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			const escaped = [document.activeElement === second, details.getAttribute('aria-hidden')];
			window.dispatchEvent(new MessageEvent('message', { data: { page: panel.page, type: 'details', run: 'run-2' } }));
			await frames();
			third.focus();
			const left = [document.activeElement === third, details.getAttribute('aria-hidden'), details.hidden];
			return { opened, scrolled, escaped, left, errors: window.errors };
		})()`);
		assert.deepStrictEqual(seen, { opened: [true, 0, true, true], scrolled: [true, true, true], escaped: [true, 'true'], left: [true, 'true', true], errors: [] });
	});

	test('PANEL-1.3, 2.2: the Pin button Pins or Unpins its card, and shows only where it can; a button\'s press opens no card and never puts the focus on the button', async () => {
		const seen = await evaluate(`(async () => {
			agents = [newCard(1, { menu: { pin: true, moveUp: false, moveDown: true } }), newCard(2, { pinned: true, menu: { unpin: true, moveUp: true, moveDown: true } }), newCard(3)];
			redraw({ revision: 2 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			window.posted = [];
			const cards = [...document.querySelectorAll('.agent')];
			const shown = cards.map(card => !card.querySelector('.pin-button').hidden), looks = cards.map(card => card.querySelector('.pin-button').dataset.look);
			cards[0].querySelector('.pin-button').click();
			cards[1].querySelector('.pin-button').click();
			const card = cards[2].getBoundingClientRect(), info = cards[2].querySelector('.details-button').getBoundingClientRect();
			return { shown, looks, card: { x: card.left + 40, y: card.top + 10 }, info: { x: info.left + info.width / 2, y: info.top + info.height / 2 }, focused: document.activeElement === document.body };
		})()`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seen.card.x, y: seen.card.y });
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seen.info.x, y: seen.info.y });
		for (const type of ['mousePressed', 'mouseReleased']) {
			await call('Input.dispatchMouseEvent', { type, x: seen.info.x, y: seen.info.y, button: 'left', clickCount: 1 });
		}
		const after = await evaluate(`[!document.activeElement.closest('.action'), window.posted.filter(message => message.type === 'act').map(message => [message.what, message.target]), !document.querySelector('.details').hidden]`);
		assert.deepStrictEqual([seen.shown, seen.looks, seen.focused], [[true, true, false], ['outline', 'filled', 'outline'], true]);
		assert.deepStrictEqual(after, [true, [['pin', 'run-1'], ['unpin', 'run-2']], true]);
	});

	test('PANEL-2.2: outside a card there is no menu at all - the webview\'s default Cut/Copy/Paste included - below the last card too', async () => {
		// The context VS Code's webview gives a right click: each marked element's from the one clicked up, the nearest winning
		const contextAt = `(element => { let context = {}; for (let at = element; (at = at && at.closest('[data-vscode-context]')); at = at.parentElement) { context = { ...JSON.parse(at.dataset.vscodeContext), ...context }; } return context; })`;
		// Below the last card in VS Code the click lands on the page's root, which the body does not reach down to
		const at = await evaluate(`(() => { agents = [newCard(1)]; redraw({}); return [document.documentElement, document.elementFromPoint(5, innerHeight - 5), document.getElementById('empty')].map(${contextAt}); })()`);
		assert.deepStrictEqual(at, [{ preventDefaultContextMenuItems: true }, { preventDefaultContextMenuItems: true }, { preventDefaultContextMenuItems: true }]);
	});

	test('PANEL-2.2: a card\'s menu is given its run ID and only the actions that apply: Move Up or Down where it moves; Rename and End always; never Pin or Unpin, its button\'s', async () => {
		assert.deepStrictEqual(await evaluate(`(() => { agents[0] = newCard(1, { menu: { moveUp: false, moveDown: true } }); agents[1] = newCard(2, { menu: { pin: true, moveUp: true, moveDown: false } }); agents[2] = newCard(3, { pinned: true, menu: { unpin: true, moveUp: false, moveDown: false } }); redraw({ revision: 7 }); return [...document.querySelectorAll('.agent')].slice(0, 4).map(card => JSON.parse(card.dataset.vscodeContext)); })()`), [
			{ webviewSection: 'agent', run_id: 'run-1', webviewMoveDown: true, preventDefaultContextMenuItems: true },
			{ webviewSection: 'agent', run_id: 'run-2', webviewMoveUp: true, preventDefaultContextMenuItems: true },
			{ webviewSection: 'agent', run_id: 'run-3', preventDefaultContextMenuItems: true },
			{ webviewSection: 'agent', run_id: 'run-4', preventDefaultContextMenuItems: true }
		]);
	});

	test('UX-2.3: the card a context menu is open on gets no frame', async () => {
		const seen = await evaluate(`(() => {
			document.documentElement.style.setProperty('--vscode-focusBorder', '#0078d4');
			agents = [newCard(1), newCard(2)]; redraw({ revision: 2 });
			const [card] = document.querySelectorAll('.agent');
			card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
			document.body.classList.add('vscode-context-menu-visible');
			const framed = getComputedStyle(card).outlineStyle;
			document.body.classList.remove('vscode-context-menu-visible');
			document.documentElement.style.removeProperty('--vscode-focusBorder');
			return framed;
		})()`);
		assert.strictEqual(seen, 'none');
	});

	test('PANEL-2.1: a new card goes last; the one the person started, selected, scrolls into view once it has opened, and an agent\'s leaves the list where it is', async () => {
		const seen = await evaluate(`(async () => {
			const root = document.scrollingElement ?? document.documentElement;
			agents = Array.from({ length: 30 }, (_, i) => newCard(i + 1)); redraw({ revision: 2 });
			root.scrollTop = 0;
			// An agent's start, which selects nothing
			agents = [...agents, newCard(31)]; redraw({ revision: 3 });
			await new Promise(resolve => setTimeout(resolve, 500));
			const stayed = root.scrollTop;
			// The person's start, selected
			agents = [...agents, newCard(32, { selected: true })]; redraw({ revision: 4 });
			await new Promise(resolve => setTimeout(resolve, 500));
			const box = document.querySelector('[data-run="run-32"]').getBoundingClientRect();
			const shown = box.top >= 0 && box.bottom <= innerHeight + 1;
			const last = [...document.querySelectorAll('.agent')].at(-1).dataset.run;
			agents = Array.from({ length: 30 }, (_, i) => newCard(i + 1)); redraw({ revision: 5 });
			return [stayed, shown, last];
		})()`);
		assert.deepStrictEqual(seen, [0, true, 'run-32']);
	});

	test('U02: a click posts the page\'s generation, an action ID no other page has and the card\'s run - no expected revision; a failed open gives the highlight back to the selected card', async () => {
		const first = await evaluate(`(() => { agents[0] = newCard(1, { selected: true }); redraw({ revision: 3 }); window.posted = []; const cards = document.querySelectorAll('.agent'); cards[2].click(); const moved = [cards[0].classList.contains('selected'), cards[2].classList.contains('selected')]; cards[4].click(); return { page: panel.page, posted: window.posted, moved }; })()`);
		await deliver({ type: 'outcome', action: `${first.page}-1`, ok: false, reason: 'gone' });
		const restored = await evaluate(`[...document.querySelectorAll('.agent')].map((card, i) => card.classList.contains('selected') ? i : -1).filter(i => i >= 0)`);
		await load();
		const second = await evaluate(`(() => { window.posted = []; document.querySelectorAll('.agent')[2].click(); return panel.page; })()`);
		assert.match(first.page, /^[0-9a-f]{32}$/);
		assert.notStrictEqual(first.page, second);
		assert.deepStrictEqual([first.moved, first.posted, restored], [[false, true], [
			{ type: 'act', action: `${first.page}-1`, what: 'open', target: 'run-3', page: first.page },
			{ type: 'act', action: `${first.page}-2`, what: 'open', target: 'run-5', page: first.page }
		], [0]]);
	});

	test('PANEL-3.1: a page made as the view shows again restores the still-valid scroll position and keyboard card from its saved state, without taking focus', async () => {
		await call('Emulation.setFocusEmulationEnabled', { enabled: true });
		await evaluate(`document.querySelector('[data-run="run-12"]').focus(); (document.scrollingElement ?? document.documentElement).scrollTop = 400; document.activeElement.blur()`);
		// The page keeps where the person was as the scroll's event comes, a frame or more later on a busy machine: waited for, not timed
		await until(() => evaluate(`window.saved?.scrollTop === 400`)).catch(() => undefined);
		const saved = await evaluate('window.saved');
		await load(shipped, saved);
		// Restored on the first list drawn
		await until(() => evaluate(`(document.scrollingElement ?? document.documentElement).scrollTop === 400`)).catch(() => undefined);
		const back = await evaluate(`[(document.scrollingElement ?? document.documentElement).scrollTop, document.activeElement === document.body, [...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)]`);
		// A scroll beyond the list is kept within it; a card no longer there, or what an earlier build saved beside it, is nothing
		await load(shipped, { scrollTop: 1e6, target: 'run-99', focused: 'run-12' });
		await until(() => evaluate(`(() => { const root = document.scrollingElement ?? document.documentElement; return JSON.stringify(window.saved) === JSON.stringify({ scrollTop: root.scrollHeight - window.innerHeight, target: 'run-1' }); })()`));
		const kept = await evaluate(`(() => { const root = document.scrollingElement ?? document.documentElement, end = root.scrollHeight - window.innerHeight; return [root.scrollTop === end, document.activeElement === document.body, [...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run), JSON.stringify(window.saved) === JSON.stringify({ scrollTop: end, target: 'run-1' })]; })()`);
		await load();
		assert.deepStrictEqual([saved, back, kept], [{ scrollTop: 400, target: 'run-12' }, [400, true, ['run-12']], [true, true, ['run-1'], true]]);
	});

	test('U02: a state meant for an earlier page does nothing on the page made since in its place (PANEL-3.1)', async () => {
		const earlier = await evaluate('panel.page');
		await load();
		await evaluate(`window.dispatchEvent(new MessageEvent('message', {data: {type: 'state', page: ${JSON.stringify(earlier)}, state: stateOf([], { revision: 99 })}}))`);
		await wait(30);
		assert.deepStrictEqual([await evaluate(`document.querySelectorAll('.agent').length`), await evaluate(`document.getElementById('empty').hidden`), await evaluate('window.errors')], [30, true, []]);
	});

	test('a message for this page of an unknown type, with a missing, extra or mistyped field, is refused with a diagnostic and changes nothing (PANEL-3.2)', async () => {
		const bad = await evaluate(`[stateOf([newCard(1, { dot: 'unknown' })]), stateOf([{ ...newCard(1), avatar: { file: '../x.png' } }]), (() => { const state = stateOf([newCard(1)]); delete state.capabilities; return state; })(), stateOf([{ ...newCard(1), extra: true }]),
			stateOf([newCard(1, { line: 7 })]), stateOf([newCard(1)], { capabilities: { canManageWorktrees: false, remote: false } })]`);
		for (const message of [{ type: 'navigate', url: 'https://example.com' }, { type: 'state' }, ...bad.map((state: object) => ({ type: 'state', state })), { type: 'renameAgent', agent: '1' }, { type: 'answer', action: 'x', value: {} }, { type: 'outcome', action: 'x', ok: 'yes' }, { type: 'scrolling', scrolling: { sensitivity: 1, fast: 5, smooth: false } }]) {
			await evaluate('window.errors = []');
			await deliver(message);
			assert.deepStrictEqual([(await evaluate('window.errors')).length, await evaluate(`document.querySelectorAll('.agent').length`)], [1, 30], JSON.stringify(message));
		}
	});

	test('PANEL-1.2, J13: the empty panel says why - no agents, none in the filter\'s location, no folder - each with its own native, keyboard-reachable buttons; nothing while loading', async () => {
		const empty = (state: object) => evaluate(`(() => { panel.render(stateOf([], ${JSON.stringify(state)})); const empty = document.getElementById('empty'); return [empty.hidden, [...empty.children].map(each => { const button = each.querySelector('button'); return button ? (button.classList.contains('secondary') ? 'secondary:' : 'button:') + button.textContent : each.textContent; })]; })()`);
		// No agent: New Agent, no ellipsis (PANEL-1.2), with Resume secondary
		assert.deepStrictEqual(await empty({ empty: 'noAgents' }), [false, ['noAgents', 'button:newAgent', 'secondary:resumeAgent']]);
		// A filter shows none: how many it hides, Clear Filter first and New Agent secondary
		assert.deepStrictEqual(await empty({ empty: 'noMatch', cardCount: 3, filter: { kind: 'location', id: 'loc-1', label: 'shop · login-fix' } }), [false, ['No agents found in "shop · login-fix".', '3 other agents are in this workspace.', 'button:clearFilter', 'secondary:newAgent']]);
		assert.deepStrictEqual((await empty({ empty: 'noMatch', cardCount: 1, filter: { kind: 'location', id: 'loc-1', label: 'main' } }))[1][1], '1 other agent is in this workspace.');
		// A location's name is said as it is, `$&` and all
		assert.deepStrictEqual((await empty({ empty: 'noMatch', cardCount: 0, filter: { kind: 'folder', id: 'file:///price', label: 'price$&$\'' } }))[1][0], 'No agents found in "price$&$\'".');
		assert.deepStrictEqual((await empty({ empty: 'noMatch', cardCount: 0, filter: { kind: 'location', id: 'loc-1', label: 'main' } }))[1].length, 3);
		assert.deepStrictEqual(await empty({ empty: 'noFolder' }), [false, ['noFolder', 'button:openFolder']]);
		assert.deepStrictEqual((await empty({ loading: true }))[0], true);
		const acted = await evaluate(`(() => { window.posted = []; const render = () => panel.render(stateOf([], { revision: 8, empty: 'noMatch', filter: { kind: 'folder', id: 'file:///shop', label: 'shop' } })); render(); const buttons = [...document.querySelectorAll('#empty button')]; buttons[0].focus(); render(); const kept = document.activeElement === buttons[0]; buttons.forEach(button => button.click()); return [buttons.every(button => button.type === 'button' && button.tabIndex === 0), kept, window.posted.map(({ type, what, revision, target }) => ({ type, what, revision, target }))]; })()`);
		assert.deepStrictEqual(acted, [true, true, [{ type: 'act', what: 'clearFilter' }, { type: 'act', what: 'new' }]]);
	});

	test('E03, UX-3.2: the shipped page has none of the probe\'s code and answers no probe; the integration build\'s page does', async () => {
		const probe = { type: 'probe', id: 5, op: 'read', selector: '.agent .name' };
		await deliver(probe);
		const inShipped = [await evaluate(`[window.posted.filter(each => each.type === 'probed').length, window.errors.length]`), /probed|"layout"/.test(shipped)];
		await load(tested);
		await evaluate(`agents = agents.slice(0, 2); redraw()`);
		await deliver(probe);
		assert.deepStrictEqual([inShipped, await evaluate(`window.posted.filter(each => each.type === 'probed').map(({ id, value }) => ({ id, value }))`)], [[[0, 1], false], [{ id: 5, value: ['Agent 1', 'Agent 2'] }]]);
	});

	test('UX-2.3: the list is one Tab stop the keys move - arrows, Home, End and the page keys, scrolled into view as little as it takes - Enter or Space opens, F2 renames; a key with Ctrl is the editor\'s', async () => {
		/** Presses `key` as the person does, its virtual key code `vk`. */
		const press = async (key: string, vk: number, code = key) => {
			for (const type of ['rawKeyDown', 'keyUp']) {
				await call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
			}
		};
		const on = () => evaluate(`document.activeElement?.closest('.agent')?.dataset.run ?? null`);
		const stops = await evaluate(`[...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)`);
		await press('Tab', 9);
		const tabbed = await on();
		await press('ArrowDown', 40);
		const down = [await on(), await evaluate(`document.activeElement.matches(':focus-visible')`)];
		await press('ArrowUp', 38);
		const up = await on();
		await press('End', 35);
		const end = [await on(), await evaluate(`(() => { const box = document.activeElement.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`)];
		await press('Home', 36);
		const home = [await on(), await evaluate('(document.scrollingElement ?? document.documentElement).scrollTop')];
		const visible = await evaluate(`[...document.querySelectorAll('.agent')].filter(card => { const box = card.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }).length`);
		await press('PageDown', 34, 'PageDown');
		const paged = await on();
		await press('PageUp', 33, 'PageUp');
		const back = await on();
		await press('ArrowDown', 40);
		await evaluate('window.posted = []');
		await press('Enter', 13);
		await press(' ', 32, 'Space');
		await press('F2', 113);
		const posted = await evaluate(`window.posted.filter(message => message.type === 'act').map(message => [message.what, message.target])`);
		const stopsNow = await evaluate(`[...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)`);
		const editors = await evaluate(`['ArrowDown', 'End', 'a'].map(key => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })))`);
		// Tab leaves the list for what follows it on the page, never another card
		await evaluate(`document.body.append(Object.assign(document.createElement('button'), { id: 'after', textContent: 'After' }))`);
		await press('Tab', 9);
		const left = await evaluate(`document.activeElement?.id || document.activeElement?.closest('.agent')?.dataset.run || null`);
		assert.deepStrictEqual({ stops, tabbed, down, up, end, home, paged, back, posted, stopsNow, editors, left }, {
			stops: ['run-1'], tabbed: 'run-1', down: ['run-2', true], up: 'run-1', end: ['run-30', true], home: ['run-1', 0],
			paged: `run-${Math.max(1, visible - 1) + 1}`, back: 'run-1',
			posted: [['open', 'run-2'], ['open', 'run-2'], ['rename', 'run-2']], stopsNow: ['run-2'], editors: [true, true, true], left: 'after'
		});
	});

	test('UX-2.3: typing goes to the next card whose name starts with what was typed within 750 ms, wrapping; a click focuses a card without the keyboard\'s outline', async () => {
		await call('Emulation.setFocusEmulationEnabled', { enabled: true });
		await evaluate(`agents[19].name = 'Zed'; agents[24].name = 'Zelda Two'; redraw()`);
		const type = async (text: string) => {
			for (const char of text) {
				await call('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, code: char === ' ' ? 'Space' : `Key${char.toUpperCase()}` });
				await call('Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: char === ' ' ? 'Space' : `Key${char.toUpperCase()}` });
			}
		};
		const on = () => evaluate(`document.activeElement?.closest('.agent')?.dataset.run ?? null`);
		await evaluate(`document.querySelector('.agent').focus()`);
		await type('z');
		const first = await on();
		await type('el');
		const longer = await on();
		await evaluate('window.posted = []');
		await type('da t');
		const spaced = [await on(), await evaluate(`window.posted.filter(message => message.type === 'act').length`)];
		await wait(800);
		await type('z');
		const wrapped = await on();
		const box = await evaluate(`(() => { document.querySelector('[data-run="run-3"]').scrollIntoView({ block: 'nearest' }); const box = document.querySelector('[data-run="run-3"]').getBoundingClientRect(); return { x: box.left + 40, y: box.top + 10 }; })()`);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
		}
		const clicked = [await on(), await evaluate(`document.activeElement.matches(':focus-visible')`), await evaluate(`[...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)`)];
		assert.deepStrictEqual({ first, longer, spaced, wrapped, clicked }, {
			first: 'run-20', longer: 'run-25', spaced: ['run-25', 0], wrapped: 'run-20', clicked: ['run-3', false, ['run-3']]
		});
	});

	test('UX-2.3: the keyboard\'s card closed with the focus on it gives the focus to the card in its place; the Tab stop is the selected card until the keys move it (PANEL-2.1)', async () => {
		await call('Emulation.setFocusEmulationEnabled', { enabled: true });
		await evaluate(`agents[4].selected = true; redraw()`);
		const stop = await evaluate(`[...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)`);
		await evaluate(`document.querySelector('[data-run="run-5"]').focus()`);
		await evaluate(`agents.splice(4, 1); redraw()`);
		const after = await evaluate(`[document.activeElement?.dataset.run ?? null, [...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)]`);
		await evaluate(`agents.splice(agents.length - 1, 1); redraw()`);
		await evaluate(`document.querySelector('[data-run="run-29"]').focus()`);
		await evaluate(`agents.splice(agents.length - 1, 1); redraw()`);
		const last = await evaluate(`document.activeElement?.dataset.run ?? null`);
		assert.deepStrictEqual({ stop, after, last }, { stop: ['run-5'], after: ['run-6', ['run-6']], last: 'run-28' });
	});

	test('PANEL-3.3: a wheel scrolls the page as it does a VS Code list - 50 px a line times `mouseWheelScrollSensitivity`, `fastScrollSensitivity` times more with Alt, never past its end, the list taking every wheel and leaving Ctrl\'s to the editor - and its scrollbar is VS Code\'s: 10px in the slider colours over no track, whatever VS Code\'s own webview default', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		// VS Code's own webview defaults must not restore a browser scrollbar/gutter behind the overlay.
		await evaluate(`(() => {
			const vscode = document.createElement('style');
			vscode.textContent = '@layer vscode-default { html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); } ::-webkit-scrollbar { width: 10px; height: 10px; } ::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); } }';
			document.head.prepend(vscode);
			document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000;--vscode-scrollbarSlider-hoverBackground:#00ff00;--vscode-scrollbarSlider-activeBackground:#0000ff;--vscode-editor-background:#ffff00';
			window.cancelled = [];
			window.addEventListener('wheel', event => window.cancelled.push(event.defaultPrevented));
		})()`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
		await wait(150);
		const width = await evaluate('innerWidth - document.documentElement.clientWidth');
		const [slider, track] = [(await pixelAt(395, 5)).join(','), (await pixelAt(395, 295)).join(',')];
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 10 });
		const hovered = (await pixelAt(395, 5)).join(',');
		await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 395, y: 10, button: 'left', clickCount: 1 });
		const pressed = (await pixelAt(395, 5)).join(',');
		await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 395, y: 10, button: 'left', clickCount: 1 });
		// A real wheel turn: one line to Chromium, whatever its pixels - natively, these four would scroll 373 px
		const wheel = async (modifiers = 0) => {
			await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 100, modifiers });
			return evaluate('document.scrollingElement.scrollTop');
		};
		const lines = [await wheel(), await wheel()];
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 2, fastSensitivity: 5, smooth: false, zoomFactor: 1 } });
		const sensitive = await wheel();
		// Alt: CDP's modifier 1
		const fast = await wheel(1);
		const end = await evaluate('document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight');
		await evaluate(`document.scrollingElement.scrollTop = ${end} - 10`);
		const atEnd = await wheel();
		const cancelled = await evaluate('window.cancelled');
		// Ctrl's wheel is the editor's: not taken, nothing scrolled
		const ctrl = await evaluate(`(() => { const before = document.scrollingElement.scrollTop; const event = new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, cancelable: true }); window.dispatchEvent(event); return [event.defaultPrevented, document.scrollingElement.scrollTop === before]; })()`);
		// Out of every card's way, for the tests after
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 295 });
		assert.deepStrictEqual([width, slider, track, hovered, pressed, await evaluate(`document.querySelectorAll('.facade-scrollbar').length`)], [0, '255,0,0', '255,255,255', '0,255,0', '0,0,255', 1]);
		assert.deepStrictEqual({ lines, sensitive, fast, atEnd: atEnd === end, cancelled: cancelled.length === 5 && cancelled.every(Boolean), ctrl, errors: await evaluate('window.errors') },
			{ lines: [50, 100], sensitive: 200, fast: 700, atEnd: true, cancelled: true, ctrl: [false, true], errors: [] });
	});

	test('PANEL-3.3: the overlay reveals on hover/scroll and fades while idle without taking width', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000;--vscode-scrollbarSlider-hoverBackground:#00ff00;--vscode-scrollbarSlider-activeBackground:#0000ff'`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 310 });
		await wait(900);
		const bounds = () => evaluate(`({ gutter: innerWidth - document.documentElement.clientWidth, width: document.querySelector('.agent').getBoundingClientRect().width })`);
		const hiddenBounds = await bounds();
		assert.deepStrictEqual(hiddenBounds, { gutter: 0, width: 392 });
		assert.deepStrictEqual(await pixelAt(395, 5), [255, 255, 255]);
		await snapshot('scrollbar-hidden');
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
		await wait(160);
		assert.deepStrictEqual(await pixelAt(395, 5), [255, 0, 0]);
		assert.deepStrictEqual(await bounds(), hiddenBounds);
		await snapshot('scrollbar-visible');
		await wait(600);
		assert.deepStrictEqual(await pixelAt(395, 5), [255, 0, 0], 'hover holds the scrollbar beyond the scroll idle timeout');
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 310 });
		await wait(200);
		const fading = await pixelAt(395, 5);
		assert.ok(fading[0] === 255 && fading[1] > 0 && fading[1] < 255, `overlay must actually fade: ${fading}`);
		await snapshot('scrollbar-fading');
		await wait(700);
		assert.deepStrictEqual(await pixelAt(395, 5), [255, 255, 255]);
		assert.deepStrictEqual(await bounds(), hiddenBounds);
		// A scroll without hover, such as keyboard navigation, wakes the thumb and extends its idle deadline.
		await evaluate(`document.scrollingElement.scrollTop = 50`);
		await wait(180);
		assert.deepStrictEqual(await pixelAt(395, 25), [255, 0, 0]);
		await wait(250);
		await evaluate(`document.scrollingElement.scrollTop = 100`);
		await wait(250);
		await snapshot('scrollbar-scrolled');
		assert.deepStrictEqual(await pixelAt(395, 25), [255, 0, 0]);
		await wait(1200);
		assert.deepStrictEqual(await pixelAt(395, 25), [255, 255, 255]);
		assert.equal(await evaluate('document.scrollingElement.scrollTop'), 100);
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('PANEL-3.3: dragging outside stays visible and releasing outside cannot leave the overlay stuck', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000;--vscode-scrollbarSlider-hoverBackground:#00ff00;--vscode-scrollbarSlider-activeBackground:#0000ff'`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 10 });
		await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 395, y: 10, button: 'left', clickCount: 1 });
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 140, button: 'left', buttons: 1 });
		await wait(1450);
		assert.ok(await evaluate('document.scrollingElement.scrollTop') > 0, 'captured pointer movement must scroll outside the viewport');
		const thumbY = await evaluate(`document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().top + 5`);
		await snapshot('scrollbar-dragging');
		assert.deepStrictEqual(await pixelAt(395, thumbY), [0, 0, 255]);
		await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 140, button: 'left', clickCount: 1 });
		await wait(900);
		assert.deepStrictEqual(await pixelAt(395, thumbY), [255, 255, 255]);
		// Track clicks scroll without triggering a card underneath the overlay.
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 295 });
		const before = await evaluate('document.scrollingElement.scrollTop');
		await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 395, y: 295, button: 'left', clickCount: 1 });
		await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 395, y: 295, button: 'left', clickCount: 1 });
		await wait(250);
		assert.ok(await evaluate('document.scrollingElement.scrollTop') > before);
		assert.deepStrictEqual(await evaluate(`window.posted.filter(message => message.type === 'act')`), []);
	});

	test('PANEL-3.3: entering the overlay thumb fades its hover color too', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000;--vscode-scrollbarSlider-hoverBackground:#00ff00'`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 310 });
		await wait(900);
		// Slow CSS animations for this one observation, so the 100 ms reveal cannot finish during screenshot capture.
		await call('Animation.enable');
		await call('Animation.setPlaybackRate', { playbackRate: 0.1 });
		try {
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 10 });
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 10 });
			await wait(120);
			const fading = await pixelAt(395, 5);
			assert.ok(fading[1] === 255 && fading[0] > 0 && fading[0] < 255, `hover must fade, not appear at full opacity: ${fading}`);
		} finally {
			await call('Animation.setPlaybackRate', { playbackRate: 1 });
		}
	});

	test('PANEL-3.3: scrollbar follows both reduced-motion preferences and clears visibility after focus loss', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000'`);
		for (const source of ['editor', 'system']) {
			await evaluate(`document.body.classList.toggle('vscode-reduce-motion', ${source === 'editor'})`);
			await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: source === 'system' ? 'reduce' : 'no-preference' }] });
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 310 });
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
			assert.deepStrictEqual(await pixelAt(395, 5), [255, 0, 0]);
			assert.equal(await evaluate(`getComputedStyle(document.querySelector('.facade-scrollbar')).transitionDuration`), '0s');
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 310 });
			assert.deepStrictEqual(await pixelAt(395, 5), [255, 255, 255]);
		}
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
		await evaluate(`window.dispatchEvent(new Event('blur'))`);
		assert.deepStrictEqual(await pixelAt(395, 5), [255, 255, 255]);
		await evaluate(`window.dispatchEvent(new Event('focus'))`);
		assert.deepStrictEqual(await pixelAt(395, 5), [255, 0, 0]);
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('PANEL-3.3: Modern UI changes width, painted corners and hit area live without moving cards, scrolling or keyboard focus', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.body.classList.add('vscode-reduce-motion'); document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000;--vscode-scrollbar-background:#123456';
			document.querySelectorAll('.agent')[3].focus({ preventScroll: true }); scrollTo(0, 50)`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
		await wait(30);
		const settings = { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1 };
		const geometry = () => evaluate(`(() => {
			const bar = document.querySelector('.facade-scrollbar'), thumb = bar.firstElementChild;
			return { width: bar.getBoundingClientRect().width, left: bar.getBoundingClientRect().left, radius: getComputedStyle(thumb).borderRadius,
				top: thumb.getBoundingClientRect().top, gutter: innerWidth - document.documentElement.clientWidth,
				cardWidth: document.querySelector('.agent').getBoundingClientRect().width, scroll: scrollY, focus: document.activeElement.dataset.run };
		})()`);
		for (const modernUI of [true, false, true]) {
			await deliver({ type: 'scrolling', scrolling: { ...settings, modernUI } });
			const seen = await geometry();
			assert.deepStrictEqual([seen.width, seen.radius, seen.gutter, seen.cardWidth, seen.scroll, seen.focus], [modernUI ? 8 : 10, modernUI ? '4px' : '0px', 0, 392, 50, 'run-4']);
			const corner = await pixelAt(seen.left, seen.top);
			assert.deepStrictEqual(corner, modernUI ? [18, 52, 86] : [255, 0, 0], 'rounded corners expose the track; square ones fill it: ' + JSON.stringify(seen));
			assert.deepStrictEqual(await pixelAt(396, seen.top + 6), [255, 0, 0]);
			await snapshot(modernUI ? 'scrollbar-modern' : 'scrollbar-traditional');
		}
		await evaluate(`document.documentElement.style.setProperty('--vscode-cornerRadius-small', '2px')`);
		assert.equal((await geometry()).radius, '2px', 'the native size token takes precedence over the 4 px fallback');
		// At x=390 the old 10 px bar covered the card; the inset modern 8 px bar must leave it clickable. The card's second line there,
		// clear of the buttons at its first line's corner (PANEL-1.3)
		await evaluate('scrollTo(0, 0); window.posted = []');
		const click = async () => {
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 390, y: 212 });
			for (const type of ['mousePressed', 'mouseReleased']) {
				await call('Input.dispatchMouseEvent', { type, x: 390, y: 212, button: 'left', clickCount: 1 });
			}
		};
		await click();
		assert.equal(await evaluate('scrollY'), 0);
		assert.deepStrictEqual(await evaluate(`window.posted.filter(message => message.type === 'act').map(message => message.what)`), ['open']);
		// An old host's message removes the optional mode: the same pixel belongs to the traditional track again.
		await deliver({ type: 'scrolling', scrolling: settings });
		assert.deepStrictEqual([(await geometry()).width, (await geometry()).radius], [10, '0px']);
		await evaluate('window.posted = []');
		await click();
		assert.ok(await evaluate('scrollY') > 0);
		assert.deepStrictEqual(await evaluate(`window.posted.filter(message => message.type === 'act')`), []);
		assert.deepStrictEqual(await evaluate('window.errors'), []);
		await deliver({ type: 'scrolling', scrolling: { ...settings, modernUI: 'true' } });
		assert.equal((await evaluate('window.errors')).length, 1);
	});

	test('PANEL-3.3: host clipping is corrected and removed even when the inner iframe size stays unchanged', async () => {
		await call('Page.navigate', { url: 'about:blank' });
		await wait(50);
		await evaluate(`document.open(); document.write('<!DOCTYPE html><html><body style="margin:0"><div id="clip" style="width:400px;height:300px;overflow:hidden"><iframe style="display:block;border:0;width:400px;height:300px"></iframe></div></body></html>'); document.close()`);
		const inside = (script: string) => evaluate(`document.querySelector('iframe').contentWindow.eval(${JSON.stringify(script)})`);
		await inside(`document.open(); document.write('<!DOCTYPE html><html><head></head><body></body></html>'); document.close();
			document.body.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style><div id="list"></div><div id="empty"></div>';
			window.errors = []; window.posted = []; window.acquireVsCodeApi = () => ({ postMessage(message) { posted.push(message); if (message.type === 'error') errors.push(message.message); }, getState() {}, setState() {} });
			window.FACADE_STRINGS = new Proxy(${JSON.stringify(words)}, { get: (words, key) => words[key] ?? String(key) }); window.FACADE_LOGOS = '';`);
		await inside(shipped);
		await inside(CARDS);
		await inside(`document.body.classList.add('vscode-reduce-motion'); document.querySelectorAll('.agent')[3].focus({ preventScroll: true }); scrollTo(0, 50)`);
		for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
			await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor, mobile: false });
			for (const modernUI of [true, false]) {
				await inside(`window.dispatchEvent(new MessageEvent('message', { data: { page: panel.page, type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1, modernUI: ${modernUI} } } }))`);
				for (const lostPixels of [0, 1, 2, 1, 0]) {
					const width = 400 - lostPixels / deviceScaleFactor, height = 300 - lostPixels / deviceScaleFactor;
					await evaluate(`document.getElementById('clip').style.width = '${width}px'; document.getElementById('clip').style.height = '${height}px'`);
					const geometry = () => inside(`(() => { const bar = document.querySelector('.facade-scrollbar'); return { rect: bar.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight], card: document.querySelector('.agent').getBoundingClientRect().width, scroll: scrollY, focus: document.activeElement.dataset.run }; })()`);
					await until(async () => { const { rect } = await geometry(); return Math.abs(rect.right - (width - (modernUI ? 1 : 0))) < 0.05 && Math.abs(rect.bottom - (height - (modernUI ? 2 : 0))) < 0.05; });
					const seen = await geometry();
					assert.deepStrictEqual([seen.viewport, seen.scroll, seen.focus, seen.rect.width], [[400, 300], 50, 'run-4', modernUI ? 8 : 10]);
					assert.ok(Math.abs(seen.card - (width - 8)) < 0.05, 'card layout follows the same visible width as the track');
				}
				await inside('scrollTo(0, document.documentElement.scrollHeight)');
				// Scroll events update the overlay on the next animation frame, which can be delayed on CI.
				await until(() => inside(`Math.abs(document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().bottom - ${modernUI ? 298 : 300}) < 0.05`));
				const end = await inside(`({ card: document.querySelector('.agent:last-child').getBoundingClientRect().bottom, thumb: document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().bottom })`);
				assert.ok(Math.abs(end.card - 300) < 0.05);
				assert.ok(Math.abs(end.thumb + (modernUI ? 2 : 0) - end.card) < 1 / deviceScaleFactor, 'only the modern slider is inset from the safe content bottom: ' + JSON.stringify({ deviceScaleFactor, modernUI, end }));
				await inside('scrollTo(0, 50)');
			}
		}
		// Clipping compensation is also needed when no scrollbar exists, and after the list becomes empty.
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.getElementById('clip').style.width = '398px'; document.getElementById('clip').style.height = '298px'`);
		await inside(`agents = agents.slice(0, 2); redraw({ revision: 2 }); scrollTo(0, 0)`);
		await until(() => inside(`Math.abs(document.querySelector('.agent').getBoundingClientRect().right - 394) < 0.05 && document.querySelector('.facade-scrollbar').hidden`));
		assert.deepStrictEqual(await inside(`({ hidden: document.querySelector('.facade-scrollbar').hidden, top: document.querySelector('.agent').getBoundingClientRect().top })`), { hidden: true, top: 0 });
		await inside(`agents = []; redraw({ revision: 3, empty: 'noAgents' })`);
		await wait(30);
		assert.deepStrictEqual(await inside(`({ hidden: document.querySelector('.facade-scrollbar').hidden, right: document.body.getBoundingClientRect().right - parseFloat(getComputedStyle(document.body).paddingRight), bottomPadding: getComputedStyle(document.body).paddingBottom })`), { hidden: true, right: 398, bottomPadding: '2px' });
		assert.deepStrictEqual(await inside('window.errors'), []);
	});

	test('PANEL-3.3: both modern caps survive the rounded host clip at four display scales, with full-range dragging and clickable clearance', async () => {
		await evaluate(`document.body.classList.add('vscode-reduce-motion'); document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000';`);
		const settings = { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1 };
		await deliver({ type: 'scrolling', scrolling: { ...settings, modernUI: true } });
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
		// The native webview overlay clips all four corners, including the top below the title bar.
		await evaluate(`(() => {
			const clip = document.createElement('div'); clip.id = 'host-clip-fixture';
			clip.style.cssText = 'position:fixed;inset:0;overflow:hidden;transform:translateZ(0);pointer-events:none';
			document.body.append(clip); clip.append(document.querySelector('.facade-scrollbar'));
		})()`);
		const box = () => evaluate(`document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().toJSON()`);
		// Compare the cap against the same unclipped layer: preserve its filled shape, allowing shared-edge antialiasing.
		const cap = async (bottom: boolean): Promise<number[]> => {
			const bounds = await box();
			const offset = await evaluate('scrollY');
			const png = (await call('Page.captureScreenshot', { format: 'png', clip: { x: bounds.left, y: offset + (bottom ? bounds.bottom - 8 : bounds.top), width: 8, height: 8, scale: 1 } })).result.data;
			return evaluate(`(async () => {
				const image = new Image(); image.src = 'data:image/png;base64,${png}'; await image.decode();
				const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
				const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
				return [...context.getImageData(0, 0, image.width, image.height).data];
			})()`);
		};
		const clippedCaps: { scale: number; bottom: boolean; filledPixelsLost: number; edgePixelsLost: number }[] = [];
		for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
			await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor, mobile: false });
			for (const bottom of [false, true]) {
				await evaluate(`scrollTo(0, ${bottom ? 'document.documentElement.scrollHeight' : '0'}); document.getElementById('host-clip-fixture').style.borderRadius = '0'`);
				await until(async () => (await box())[bottom ? 'bottom' : 'top'] === (bottom ? 298 : 2));
				assert.equal((await box())[bottom ? 'bottom' : 'top'], bottom ? 298 : 2, `The thumb reaches the track endpoint at scale ${deviceScaleFactor}, including fractional scroll limits`);
				const before = await cap(bottom);
				assert.ok(before.some((value, index) => index % 4 === 1 && value === 0), 'the reference contains the painted red cap');
				await evaluate(`document.getElementById('host-clip-fixture').style.borderRadius = '8px'`);
				const after = await cap(bottom);
				assert.equal(after.length, before.length);
				let filledPixelsLost = 0, edgePixelsLost = 0;
				for (let pixel = 0; pixel < before.length; pixel += 4) {
					if (before[pixel + 1] === 0 && after[pixel + 1] !== 0) { filledPixelsLost++; }
					// Red on white: green measures uncovered area. Preserve the half-coverage contour;
					// subpixel fringes outside it can disappear where the two antialiased clips meet.
					else if (before[pixel + 1] < 128 && after[pixel + 1] >= 128) { edgePixelsLost++; }
				}
				if (filledPixelsLost || edgePixelsLost) { clippedCaps.push({ scale: deviceScaleFactor, bottom, filledPixelsLost, edgePixelsLost }); }
				if (deviceScaleFactor === 1) { await snapshot(`scrollbar-${bottom ? 'bottom' : 'top'}-host-clip`); }
			}
		}
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		const end = await evaluate('scrollY');
		for (const modernUI of [false, true]) {
			const previous = await evaluate('scrollY');
			await deliver({ type: 'scrolling', scrolling: { ...settings, modernUI } });
			assert.equal(await evaluate('scrollY'), previous, 'mode changes preserve scroll position without adding content height');
		}
		await evaluate('scrollTo(0, 0)');
		await wait(30);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 12 });
		await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 395, y: 12, button: 'left', clickCount: 1 });
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 310, button: 'left', buttons: 1 });
		await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 395, y: 310, button: 'left', clickCount: 1 });
		assert.equal(await evaluate('scrollY'), end, 'the shortened track still maps to the full content range');
		assert.equal((await box()).bottom, 298);
		assert.equal(await evaluate(`document.querySelector('.agent:last-child').getBoundingClientRect().bottom`), 300);
		for (const [position, y, targets] of [[end, 299, ['run-30']], [0, 1, ['run-1']]] as const) {
			await evaluate(`scrollTo(0, ${position}); window.posted = []`);
			await wait(30);
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 393, y });
			for (const type of ['mousePressed', 'mouseReleased']) {
				await call('Input.dispatchMouseEvent', { type, x: 393, y, button: 'left', clickCount: 1 });
			}
			assert.deepStrictEqual(await evaluate(`window.posted.filter(message => message.type === 'act').map(message => message.target)`), targets, 'the strips beyond the inset scrollbar still belong to the first and last cards');
		}
		await evaluate(`document.querySelector('.agent').focus()`);
		await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
		await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' });
		await wait(30);
		assert.deepStrictEqual(await evaluate(`({ target: document.activeElement.dataset.run, bottom: document.activeElement.getBoundingClientRect().bottom })`), { target: 'run-30', bottom: 300 }, 'keyboard End reaches the corrected content edge without decorative padding');
		assert.deepStrictEqual(await evaluate('window.errors'), []);
		if (process.env.FACADE_UI_EVIDENCE_DIR) {
			fs.writeFileSync(path.join(process.env.FACADE_UI_EVIDENCE_DIR, 'cap-clipping.json'), JSON.stringify(clippedCaps, null, 2));
		}
		assert.deepStrictEqual(clippedCaps, [], 'the host clip must preserve both filled cap contours');
	});

	test('PANEL-3.3: resizing and changing card counts never reserve a gutter; the slider overlays card paint and reaches both ends', async () => {
		await evaluate(`document.body.classList.add('vscode-reduce-motion')`);
		let revision = 2;
		for (const [width, height] of [[400, 300], [200, 300], [500, 120]]) {
			await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
			for (const count of [2, 30, 100, 2]) {
				await evaluate(`agents = Array.from({ length: ${count} }, (_, i) => newCard(i + 1)); redraw({ revision: ${revision++} }); scrollTo(0, 0)`);
				// Card layout is synchronous, but ResizeObserver schedules the overlay's next frame.
				await until(() => evaluate(`document.querySelector('.facade-scrollbar').hidden === ${count === 2}
					&& (${count === 2} || document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().top === 0)`));
				const geometry = await evaluate(`(() => {
					const bar = document.querySelector('.facade-scrollbar'), thumb = bar.firstElementChild, card = document.querySelector('.agent').getBoundingClientRect();
					return { gutter: innerWidth - document.documentElement.clientWidth, content: document.documentElement.scrollWidth,
						card: [card.left, card.right], hidden: bar.hidden, width: bar.getBoundingClientRect().width,
						size: thumb.getBoundingClientRect().height, top: thumb.getBoundingClientRect().top, tab: bar.tabIndex,
						aria: bar.getAttribute('aria-hidden'), position: getComputedStyle(bar).position };
				})()`);
				assert.deepStrictEqual([geometry.gutter, geometry.content, geometry.card, geometry.hidden, geometry.tab, geometry.aria, geometry.position],
					[0, width, [4, width - 4], count === 2, -1, 'true', 'fixed']);
				if (count > 2) {
					assert.equal(geometry.width, 10);
					assert.equal(geometry.top, 0);
					assert.ok(geometry.size >= 20 && geometry.size < height);
					await evaluate('scrollTo(0, document.documentElement.scrollHeight)');
					await until(async () => await evaluate(`document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().bottom`) === height);
				}
			}
		}
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.documentElement.style.cssText = '--vscode-list-activeSelectionBackground:#123456;--vscode-scrollbarSlider-background:#ff0000';
			agents = Array.from({ length: 30 }, (_, i) => newCard(i + 1, { selected: i === 0 })); redraw({ revision: ${revision++} }); scrollTo(0, 0)`);
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 310 });
		await until(async () => await evaluate(`getComputedStyle(document.querySelector('.facade-scrollbar')).opacity`) === '0');
		assert.deepStrictEqual(await pixelAt(392, 30), [18, 52, 86], 'card paint must extend under the hidden overlay');
		assert.ok(await evaluate(`document.elementFromPoint(392, 30).closest('.agent') !== null`));
		await snapshot('overlay-card-hidden');
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
		assert.deepStrictEqual(await pixelAt(392, 30), [255, 0, 0], 'the revealed slider paints over the same card pixels');
		await snapshot('overlay-card-visible');
	});

	test('PANEL-3.3: track clicks center the slider or page by the live list setting, keeping keyboard focus and card actions untouched', async () => {
		await evaluate(`document.body.classList.add('vscode-reduce-motion'); document.querySelector('.agent').focus()`);
		const click = async (y: number) => {
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y });
			for (const type of ['mousePressed', 'mouseReleased']) {
				await call('Input.dispatchMouseEvent', { type, x: 395, y, button: 'left', clickCount: 1 });
			}
			await wait(30);
		};
		await click(200);
		const centered = await evaluate(`(() => { const box = document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect(); return (box.top + box.bottom) / 2; })()`);
		assert.ok(Math.abs(centered - 200) <= 1);
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1, scrollByPage: true } });
		await evaluate('scrollTo(0, 0)');
		await wait(30);
		await click(200);
		assert.equal(await evaluate('scrollY'), 300);
		await click(10);
		assert.equal(await evaluate('scrollY'), 0);
		// A modern track starts below the viewport top: centering and thumb hit testing use track-local coordinates.
		for (const scrollByPage of [false, true]) {
			await deliver({ type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1, modernUI: true, scrollByPage } });
			await evaluate('scrollTo(0, 0)');
			await wait(30);
			await click(200);
			const bounds = await evaluate(`document.querySelector('.facade-scrollbar-thumb').getBoundingClientRect().toJSON()`);
			if (scrollByPage) { assert.equal(await evaluate('scrollY'), 300); }
			else { assert.ok(Math.abs((bounds.top + bounds.bottom) / 2 - 200) <= 1); }
			const before = await evaluate('scrollY');
			await click(bounds.bottom - 2);
			assert.equal(await evaluate('scrollY'), before, 'pressing the lower cap is a thumb press, not a track click');
			if (scrollByPage) { await click(10); assert.equal(await evaluate('scrollY'), 0); }
		}
		// Old host messages remain valid during an update; absence resets the optional setting to its default.
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1 } });
		await click(200);
		assert.ok(await evaluate('scrollY') > 300);
		assert.deepStrictEqual(await evaluate(`[document.activeElement.dataset.run, window.posted.filter(message => message.type === 'act'), window.errors]`), ['run-1', [], []]);
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1, scrollByPage: 'yes' } });
		assert.equal((await evaluate('window.errors')).length, 1);
	});

	test('PANEL-3.3: canceled, interrupted and touch drags release capture and visibility; Windows sideways reset keeps the original position', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await evaluate(`document.body.classList.add('vscode-reduce-motion'); window.addEventListener('pointerdown', event => window.pointer = event.pointerId, true)`);
		for (const end of ['cancel', 'capture', 'blur']) {
			await evaluate('scrollTo(0, 0)');
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 10 });
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 10 });
			await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 395, y: 10, button: 'left', clickCount: 1 });
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 120, button: 'left', buttons: 1 });
			assert.ok(await evaluate('scrollY') > 0);
			if (process.platform === 'win32') {
				await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 550, y: 120, button: 'left', buttons: 1 });
				assert.equal(await evaluate('scrollY'), 0, 'moving over 140 px sideways resets the drag');
				await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 120, button: 'left', buttons: 1 });
				assert.ok(await evaluate('scrollY') > 0);
			}
			// Cancellation and loss are event-driven, but each follows a real captured drag, never a synthetic pointerdown.
			await evaluate(end === 'cancel' ? `window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.pointer }))`
				: end === 'capture' ? `document.querySelector('.facade-scrollbar').releasePointerCapture(window.pointer)`
					: `window.dispatchEvent(new Event('blur'))`);
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 421, y: 121, button: 'left', buttons: 1 });
			await wait(550);
			assert.deepStrictEqual(await evaluate(`(() => { const bar = document.querySelector('.facade-scrollbar'); return [bar.hasPointerCapture(window.pointer), bar.classList.contains('dragging'), getComputedStyle(bar).opacity]; })()`), [false, false, '0'], end);
			const top = await evaluate('scrollY');
			await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 250, button: 'left', buttons: 1 });
			assert.equal(await evaluate('scrollY'), top);
			await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 250, button: 'left', clickCount: 1 });
		}
		// Touch has no persistent hover after release, even when the finger ends inside the view.
		await evaluate('scrollTo(0, 50)');
		// PANEL-3.3: the scroll event reveals the bar asynchronously, and CDP can acknowledge touch input before Chromium applies it.
		await until(() => evaluate(`scrollY === 50 && !document.querySelector('.facade-scrollbar').hidden && document.querySelector('.facade-scrollbar').classList.contains('visible')`), 5_000, 'The scrollbar did not become ready for touch.');
		await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 395, y: 20 }] });
		await until(() => evaluate(`document.querySelector('.facade-scrollbar').hasPointerCapture(window.pointer) && document.querySelector('.facade-scrollbar').classList.contains('dragging')`), 5_000, 'The touch did not capture the scrollbar.');
		await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 395, y: 150 }] });
		await until(() => evaluate('scrollY > 50'), 5_000, 'The captured touch did not scroll the page.');
		assert.ok(await evaluate('scrollY') > 50);
		await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await wait(550);
		assert.deepStrictEqual(await evaluate(`(() => { const bar = document.querySelector('.facade-scrollbar'); return [bar.hasPointerCapture(window.pointer), bar.classList.contains('dragging'), getComputedStyle(bar).opacity]; })()`), [false, false, '0']);
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('PANEL-3.3: with `smoothScrolling` a mouse wheel\'s scroll glides over 125 ms, ended where it is by what else scrolls the page; for a person who asked for less motion it does not glide; settings the page cannot read are refused', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		const wheel = () => call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 100 });
		const top = () => evaluate('document.scrollingElement.scrollTop');
		// Every scroll position the page went through
		await evaluate(`window.tops = []; window.addEventListener('scroll', () => window.tops.push(document.scrollingElement.scrollTop))`);
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: true, zoomFactor: 1 } });
		await wheel();
		await wait(400);
		const glided = await evaluate('window.tops');
		// A glide begun - nothing moves at once - and the page scrolled otherwise in the same task, the scrollbar dragged, before its
		// first frame: it stays where the person took it. A mouse wheel's line, as Chromium gives one
		const taken = await evaluate(`(async () => {
			const before = document.scrollingElement.scrollTop;
			window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, wheelDeltaY: -120, cancelable: true }));
			const atOnce = document.scrollingElement.scrollTop;
			document.scrollingElement.scrollTop = 400;
			await new Promise(resolve => setTimeout(resolve, 400));
			return [atOnce === before, document.scrollingElement.scrollTop];
		})()`);
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
		await wheel();
		const still = await top();
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 'fast', fastSensitivity: 5, smooth: true, zoomFactor: 1 } });
		const refused = (await evaluate('window.errors')).map((error: string) => error.startsWith('The panel refused a message'));
		assert.deepStrictEqual({ glides: glided.some((at: number) => at > 0 && at < 50), glided: glided[glided.length - 1], taken, still, refused },
			{ glides: true, glided: 50, taken: [true, 400], still: 450, refused: [true] });
	});

	test('UX-2.2, PANEL-3.3: a card that ends while the list glides goes at once, with no closing animation, and the glide reaches its target; one that ends with no glide under way closes as ever', async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
		await deliver({ type: 'scrolling', scrolling: { sensitivity: 1, fastSensitivity: 5, smooth: true, zoomFactor: 1 } });
		await deliver({ type: 'state', state: await evaluate(`stateOf(agents, { revision: 5 })`) });
		const glided = await evaluate(`(async () => {
			const before = document.scrollingElement.scrollTop;
			window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, wheelDeltaY: -120, cancelable: true }));
			// A card in view ends, mid-glide
			agents.splice(1, 1);
			panel.render(stateOf(agents, { revision: 6, exited: ['run-2'] }));
			const closing = document.querySelectorAll('.closing').length;
			const gone = !document.querySelector('[data-run="run-2"]');
			await new Promise(resolve => setTimeout(resolve, 400));
			return [closing, gone, document.scrollingElement.scrollTop - before];
		})()`);
		const settled = await evaluate(`(async () => {
			const [{ runId }] = agents.splice(3, 1);
			panel.render(stateOf(agents, { revision: 7, exited: [runId] }));
			const closing = document.querySelectorAll('.closing').length;
			await new Promise(resolve => setTimeout(resolve, 400));
			return [closing, document.querySelectorAll('.closing').length];
		})()`);
		assert.deepStrictEqual([glided, settled], [[0, true, 50], [1, 0]]);
	});

	test('New Agent\'s own icon draws where codicons\' `new-session` does: at 300 px, ink from 38 to 281 px of a 300 px advance, as its outline is placed in VS Code\'s codicon.ttf (PANEL-1.1)', async () => {
		const root = path.resolve(__dirname, '../../..');
		const font = fs.readFileSync(path.join(root, 'media', 'new-agent.woff')).toString('base64');
		const drawn = await evaluate(`(async () => {
			const face = new FontFace('facade-new-agent-test', 'url(data:font/woff;base64,${font})');
			document.fonts.add(await face.load());
			const context = document.createElement('canvas').getContext('2d');
			context.font = '300px facade-new-agent-test';
			const metrics = context.measureText('\\uEC84');
			return [-metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.width].map(Math.round);
		})()`);
		assert.deepStrictEqual(drawn, [38, 281, 300]);
	});

	test('a card\'s face is its CLI\'s maker avatar, and an empty circle for a CLI the host gave none; a face changes only with its avatar (PANEL-1.3, UX-2.1)', async () => {
		const seen = await evaluate(`(() => {
			agents = [newCard(1), { ...newCard(2), avatar: undefined }]; redraw({ revision: 2 });
			const faces = [...document.querySelectorAll('.agent .face')];
			const drawn = faces.map(face => [face.querySelector('img')?.getAttribute('src') ?? '', face.textContent, face.getAttribute('aria-hidden')]);
			agents = [newCard(1, { line: 'Another line' }), newCard(2)]; redraw({ revision: 3 });
			const after = [...document.querySelectorAll('.agent .face')];
			return [drawn, after[0] === faces[0], after[1] === faces[1], after[1].querySelector('img')?.getAttribute('src')];
		})()`);
		assert.deepStrictEqual(seen, [[['/avatar-claude.png', '', 'true'], ['', '', 'true']], true, false, '/avatar-claude.png']);
	});

	test('a robot\'s face is its face with its eyes over it, both images of media/agents, kept while it stays; any other avatar is refused (PANEL-1.3, CONFIGURATION-2.4)', async () => {
		const seen = await evaluate(`(() => {
			const robot = color => ({ file: 'robot-' + color + '-face.svg', eyes: 'robot-eyes.svg' });
			agents = [newCard(1, { avatar: robot('sky') }), newCard(2, { avatar: robot('pearl') })]; redraw({ revision: 2 });
			const faces = [...document.querySelectorAll('.agent .face')];
			const drawn = faces.map(face => [[...face.querySelectorAll('img')].map(img => [img.getAttribute('src').split('/').pop(), img.className]), face.getAttribute('aria-hidden')]);
			agents = [newCard(1, { avatar: robot('sky'), line: 'Another line' }), newCard(2, { avatar: robot('ocean') })]; redraw({ revision: 3 });
			const after = [...document.querySelectorAll('.agent .face')];
			return [drawn, after[0] === faces[0], after[1] === faces[1], after[1].querySelector('img').getAttribute('src').split('/').pop()];
		})()`);
		assert.deepStrictEqual(seen, [[
			[[['robot-sky-face.svg', ''], ['robot-eyes.svg', 'eyes']], 'true'],
			[[['robot-pearl-face.svg', ''], ['robot-eyes.svg', 'eyes']], 'true']
		], true, false, 'robot-ocean-face.svg']);
		// A file of media/agents by its plain name, and nothing else - an earlier build's letter avatar either - as any malformed state is refused
		for (const avatar of [{ file: '../x.svg' }, { file: 'robot-sky-face.svg', eyes: '../eyes.svg' }, { initial: 'M', color: 'blue' }, { robot: 'data:image/svg+xml;base64,' }]) {
			await evaluate('window.errors = []');
			await deliver({ type: 'state', state: { revision: 9, loading: false, cards: [{ ...(await evaluate('newCard(1)')), avatar }], cardCount: 1, capabilities: { remote: false } } });
			assert.strictEqual((await evaluate('window.errors')).length, 1, JSON.stringify(avatar));
		}
	});

	test('a robot\'s eyes go a quarter of the way each frame, reach less within a face and a half of the pointer, keep their gaze when the window loses focus, keep still with the system\'s reduced motion, and ask for no frame at rest (PANEL-1.3)', async function () {
		// Each frame is drawn without a graphics card on a CI runner: as many as the eyes take to settle, and time for them
		this.timeout(60_000);
		const seen = await evaluate(`(async () => {
			agents = [newCard(1, { avatar: { file: 'robot-sky-face.svg', eyes: 'robot-eyes.svg' } })]; redraw({ revision: 2 });
			const frames = count => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });
			const eyes = document.querySelector('.agent .face .eyes');
			const box = eyes.parentElement.getBoundingClientRect();
			const at = () => { const shift = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\)/.exec(eyes.style.transform); return shift ? [Number(shift[1]), Number(shift[2])] : [0, 0]; };
			const reach = box.width * 4 / 32;
			const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
			const move = x => document.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: cy, bubbles: true }));
			// Until the eyes stand still: three frames alike
			const settled = async () => { let last; for (let same = 0, left = 240; same < 3 && left; left--) { await frames(1); const now = eyes.style.transform; same = now === last ? same + 1 : 0; last = now; } };
			// From rest, one frame goes a quarter of the way
			move(cx + 500); await frames(1);
			const first = at()[0] / reach;
			await settled();
			// Three quarters of a face from its middle: half the reach
			move(cx + box.width * 0.75); await settled();
			const near = at()[0] / reach;
			// A card click can move focus to its terminal: the eyes keep looking at the pointer
			window.dispatchEvent(new Event('blur')); await settled();
			const blurred = at().map(value => value / reach);
			// The system's reduced motion, while the eyes look aside: in the middle at once
			move(cx + 500); await settled();
			const real = window.matchMedia;
			window.matchMedia = query => query.includes('reduced-motion') ? { matches: true, addEventListener() {}, removeEventListener() {} } : real.call(window, query);
			move(cx + 500); await frames(2);
			const still = at();
			window.matchMedia = real;
			// At rest, nothing asks for a frame
			move(cx + 500); await settled();
			let asked = 0;
			const ask = window.requestAnimationFrame;
			window.requestAnimationFrame = callback => { asked++; return ask.call(window, callback); };
			await new Promise(resolve => setTimeout(resolve, 300));
			window.requestAnimationFrame = ask;
			return [first, near, blurred, still, asked];
		})()`);
		const [first, near, blurred, still, asked] = seen as [number, number, number[], number[], number];
		assert.ok(Math.abs(first - 0.25) < 0.01 && Math.abs(near - 0.5) < 0.02, JSON.stringify(seen));
		assert.ok(Math.abs(blurred[0] - near) < 0.02 && blurred[1] === 0, JSON.stringify(seen));
		assert.deepStrictEqual([still, asked], [[0, 0], 0]);
	});

	test('a robot\'s eyes look toward the pointer over the panel, up to 4/32 of its face, keep that gaze once it leaves; not with reduced motion (CONFIGURATION-2.4)', async function () {
		// Each frame is drawn without a graphics card on a CI runner: as many as the eyes take to settle, and time for them
		this.timeout(60_000);
		const seen = await evaluate(`(async () => {
			agents = [newCard(1, { avatar: { file: 'robot-sky-face.svg', eyes: 'robot-eyes.svg' } })]; redraw({ revision: 2 });
			const frames = count => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });
			const eyes = document.querySelector('.agent .face .eyes');
			const box = eyes.parentElement.getBoundingClientRect();
			// Until the eyes stand still: three frames alike
			const settled = async () => { let last; for (let same = 0, left = 240; same < 3 && left; left--) { await frames(1); const now = eyes.style.transform; same = now === last ? same + 1 : 0; last = now; } };
			const at = () => { const shift = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\)/.exec(eyes.style.transform); return shift ? [Number(shift[1]), Number(shift[2])] : [0, 0]; };
			document.dispatchEvent(new PointerEvent('pointermove', { clientX: box.right + 200, clientY: box.top + box.height / 2, bubbles: true }));
			await frames(4);
			const moving = at();
			await settled();
			const right = at();
			// Reduced motion turned on while the eyes look aside: they stand in the middle at once, without easing there
			document.body.classList.add('vscode-reduce-motion');
			document.dispatchEvent(new PointerEvent('pointermove', { clientX: box.right + 200, clientY: box.top + box.height / 2, bubbles: true }));
			await frames(2);
			const snapped = at();
			document.body.classList.remove('vscode-reduce-motion');
			document.dispatchEvent(new PointerEvent('pointermove', { clientX: box.right + 200, clientY: box.top + box.height / 2, bubbles: true }));
			await settled();
			document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null, bubbles: true }));
			await settled();
			const left = at();
			document.body.classList.add('vscode-reduce-motion');
			document.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left - 200, clientY: box.top, bubbles: true }));
			await settled();
			const reduced = at();
			document.body.classList.remove('vscode-reduce-motion');
			return [box.width, moving, right, snapped, left, reduced];
		})()`);
		const [width, moving, right, snapped, left, reduced] = seen as [number, number[], number[], number[], number[], number[]];
		// Partway there after a few frames, then the full reach toward the pointer on its right
		assert.ok(moving[0] > 0 && moving[0] < width * 4 / 32, JSON.stringify(seen));
		assert.ok(Math.abs(right[0] - width * 4 / 32) < 0.06 && Math.abs(right[1]) < 0.06, JSON.stringify(seen));
		assert.deepStrictEqual(left, right);
		assert.deepStrictEqual([snapped, reduced], [[0, 0], [0, 0]]);
	});

	test('PANEL-1.3: a robot keeps looking at the pointer through a card click, terminal focus, details, menu handoff and state updates', async function () {
		this.timeout(60_000);
		await evaluate(`(() => {
			agents = [newCard(1, { avatar: { file: 'robot-sky-face.svg', eyes: 'robot-eyes.svg' } })]; redraw({ revision: 2 });
			window.settleEyes = async () => {
				let last;
				for (let same = 0, left = 240; same < 3 && left; left--) {
					await new Promise(resolve => requestAnimationFrame(resolve));
					const now = document.querySelector('.agent .face .eyes').style.transform;
					same = now === last ? same + 1 : 0; last = now;
				}
			};
		})()`);
		const read = `(async () => { await settleEyes(); return document.querySelector('.agent .face .eyes').style.transform; })()`;
		const at = await middleOf('.agent .title');
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
		const before = await evaluate(read);
		assert.ok(before && before !== 'translate(0.00px, 0.00px)', before);
		await pressAt(at);
		assert.deepStrictEqual(await evaluate(`posted.filter(message => message.type === 'act').map(message => [message.what, message.target])`), [['open', 'run-1']]);
		// The host focuses the terminal after Open Agent; a menu can take both focus and the pointer from the webview too.
		await evaluate(`window.dispatchEvent(new Event('blur')); document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null, bubbles: true }))`);
		assert.strictEqual(await evaluate(read), before, 'opening the terminal must keep the gaze');
		await evaluate(`document.querySelector('.details-button').click()`);
		assert.strictEqual(await evaluate(read), before, 'details must keep the gaze');
		await evaluate(`document.querySelector('.menu-button').click(); document.body.classList.add('vscode-context-menu-visible')`);
		await away();
		assert.strictEqual(await evaluate(read), before, 'a menu taking the pointer must keep the gaze');
		await evaluate(`document.body.classList.remove('vscode-context-menu-visible'); agents[0] = { ...agents[0], selected: true, dot: 'none', line: 'Updated' }; redraw({ revision: 3 })`);
		assert.strictEqual(await evaluate(read), before, 'menu dismissal, selection and status must keep the gaze');
		// The next real movement takes over smoothly from the retained position.
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: at.y });
		const after = await evaluate(read);
		assert.ok(after.startsWith('translate(-'), after);
		assert.deepStrictEqual(await evaluate('errors'), []);
	});

	test('PANEL-1.3: pointer entry and presses update a robot\'s gaze without a move, and scrolling follows the cards at the retained pointer position', async function () {
		this.timeout(60_000);
		const seen = await evaluate(`(async () => {
			agents = Array.from({ length: 30 }, (_, i) => newCard(i + 1, { avatar: { file: 'robot-sky-face.svg', eyes: 'robot-eyes.svg' } })); redraw({ revision: 2 });
			const eyes = document.querySelectorAll('.agent .face .eyes')[3];
			const face = eyes.parentElement;
			const settle = async () => {
				let last;
				for (let same = 0, left = 240; same < 3 && left; left--) {
					await new Promise(resolve => requestAnimationFrame(resolve));
					const now = eyes.style.transform;
					same = now === last ? same + 1 : 0; last = now;
				}
			};
			const at = () => (eyes.style.transform.match(/-?[\\d.]+(?=px)/g) ?? ['0', '0']).map(Number);
			const box = face.getBoundingClientRect(), cy = box.top + box.height / 2;
			document.dispatchEvent(new PointerEvent('pointerover', { clientX: box.right + 100, clientY: cy, bubbles: true }));
			await settle(); const entered = at();
			document.dispatchEvent(new PointerEvent('pointerdown', { clientX: 1, clientY: cy, bubbles: true }));
			await settle(); const pressed = at();
			// No pointer event follows: scrolling alone moves the face above the retained pointer.
			document.scrollingElement.scrollTop = 100;
			await settle(); const scrolled = at();
			return [entered, pressed, scrolled, document.scrollingElement.scrollTop];
		})()`);
		const [entered, pressed, scrolled, scrollTop] = seen as [number[], number[], number[], number];
		assert.ok(entered[0] > 0 && entered[1] === 0, JSON.stringify(seen));
		assert.ok(pressed[0] < 0 && pressed[1] === 0, JSON.stringify(seen));
		assert.ok(scrollTop === 100 && scrolled[0] < 0 && scrolled[1] > 0, JSON.stringify(seen));
	});

	test('a robot\'s eyes looking aside stand in the middle at once when reduced motion turns on - the editor\'s or the system\'s - with the pointer still and nothing else moving, and look again when it turns off (PANEL-1.3)', async function () {
		// Each frame is drawn without a graphics card on a CI runner: as many as the eyes take to settle, and time for them
		this.timeout(60_000);
		const aside = await evaluate(`(async () => {
			agents = [newCard(1, { avatar: { file: 'robot-sky-face.svg', eyes: 'robot-eyes.svg' } })]; redraw({ revision: 2 });
			window.framesOf = count => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });
			// Until the eyes stand still: three frames alike
			window.settledOf = async () => { let last; for (let same = 0, left = 240; same < 3 && left; left--) { await framesOf(1); const now = document.querySelector('.agent .face .eyes').style.transform; same = now === last ? same + 1 : 0; last = now; } };
			window.eyesAt = () => { const shift = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\)/.exec(document.querySelector('.agent .face .eyes').style.transform); return shift ? [Number(shift[1]), Number(shift[2])] : [0, 0]; };
			const box = document.querySelector('.agent .face').getBoundingClientRect();
			document.dispatchEvent(new PointerEvent('pointermove', { clientX: box.right + 300, clientY: box.top + box.height / 2, bubbles: true }));
			await settledOf();
			return eyesAt();
		})()`) as number[];
		// The editor's: VS Code's class on the page's body, and no other event
		const editor = await evaluate(`(async () => { document.body.classList.add('vscode-reduce-motion'); await framesOf(2); return eyesAt(); })()`);
		const editorOff = await evaluate(`(async () => { document.body.classList.remove('vscode-reduce-motion'); await settledOf(); return eyesAt(); })()`) as number[];
		// The system's: the media query the page listens to changes, and no other event; the page is told it in a later frame, and
		// the eyes stand in the middle in the frame after - easing there would take some twenty
		await evaluate(`(() => { window.motionQuery = matchMedia('(prefers-reduced-motion: reduce)'); window.motionChanged = new Promise(resolve => motionQuery.addEventListener('change', resolve, { once: true })); })()`);
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
		const system = await evaluate(`(async () => { await motionChanged; await framesOf(2); return eyesAt(); })()`);
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
		const systemOff = await evaluate(`(async () => { await settledOf(); return eyesAt(); })()`) as number[];
		assert.ok(aside[0] > 0 && editorOff[0] > 0 && systemOff[0] > 0, JSON.stringify([aside, editorOff, systemOff]));
		assert.deepStrictEqual([editor, system], [[0, 0], [0, 0]]);
	});
});
