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

/** Real Chromium input and layout, in a throwaway headless profile. No installed browser profile or editor is attached. */
suite('The agent panel in Chromium', function () {
	this.timeout(15_000);
	const executable = [process.env.CHROMIUM_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => file && fs.existsSync(file));
	let child: ChildProcess;
	let profile: string;
	let socket: WebSocket;
	let call: (method: string, params?: object) => Promise<any>;
	let evaluate: (expression: string) => Promise<any>;
	const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
	const until = async (check: () => boolean | Promise<boolean>) => {
		const deadline = Date.now() + 8_000;
		while (!await check()) {
			if (Date.now() > deadline) { throw new Error('Chromium did not become ready'); }
			await wait(30);
		}
	};
	/** The shipped page, and the integration build's: the same source, its test mode defined either way (UX-3.2). */
	let shipped: string;
	let tested: string;
	let css: string;
	/** The page's words: each its own key, the templates as the extension gives them. */
	const words = { noAgentsIn: 'No agents found in "{0}".', otherAgents: '{0} other agents are in this workspace.', otherAgent: '1 other agent is in this workspace.', started: 'Started {0}' };
	/** Loads a new page of the panel, as the view does each time it shows. */
	const load = async (bundle = shipped, saved?: unknown) => {
		await call('Page.navigate', { url: 'about:blank' });
		await wait(50);
		await evaluate(`document.body.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style><div id="list"></div><div id="empty"></div>'; window.errors = []; window.posted = []; window.saved = ${JSON.stringify(saved ?? null)}; window.acquireVsCodeApi = () => ({postMessage(message) { window.posted.push(message); if (message.type === 'error') window.errors.push(message.message); }, getState: () => window.saved ?? undefined, setState: state => { window.saved = state; }}); window.FACADE_STRINGS = new Proxy(${JSON.stringify(words)}, {get: (words, key) => words[key] ?? String(key)}); window.FACADE_LOGOS = '';`);
		await evaluate(bundle);
		await evaluate(CARDS);
	};
	/** What the extension says to this page: a message as it posts one, for this page's generation. */
	const deliver = (message: object) => evaluate(`window.dispatchEvent(new MessageEvent('message', {data: {page: panel.page, ...${JSON.stringify(message)}}}))`);
	/** Thirty working cards, `window.agents`, drawn by `redraw()`; `newCard(i, more)` and `stateOf(cards, more)` make others as the host does. */
	const CARDS = `
		window.newCard = (i, more = {}) => ({ runId: 'run-' + i, selected: false, name: 'Agent ' + i, alias: '#a' + i, avatar: { file: 'avatar-claude.png' },
			location: { label: 'project', full: 'project · /project' }, dot: 'working', stateText: 'Working', line: 'Step one', tooltip: ['Agent ' + i + ' · #a' + i + ' · Claude Code', 'Working'],
			label: 'Agent ' + i + ', #a' + i + ', Working, project, Claude Code, Step one', startedAt: Date.now(), menu: { moveUp: false, moveDown: false, filterLocation: false, filterFolder: false, clearFilter: false }, ...more });
		window.stateOf = (cards, more = {}) => ({ revision: 1, loading: false, cards, cardCount: cards.length, capabilities: { remote: false }, ...more });
		window.agents = Array.from({ length: 30 }, (_, i) => newCard(i + 1));
		window.redraw = (more = {}) => panel.render(stateOf(agents, more));
		redraw();`;
	suiteSetup(async function () {
		if (!executable) { this.skip(); return; }
		const root = path.resolve(__dirname, '../../..');
		const source = fs.readFileSync(path.join(root, 'src/webview/panel.ts'), 'utf8');
		const hooks = `\n(window as any).panel = { page, render: (next: PanelState) => { state = next; render(); } };`;
		const bundle = async (testMode: boolean) => (await build({ stdin: { contents: source + hooks, loader: 'ts', resolveDir: path.join(root, 'src/webview') }, bundle: true, write: false, format: 'iife', minifySyntax: true, define: { FACADE_TEST_MODE: String(testMode) } })).outputFiles[0].text;
		[shipped, tested] = await Promise.all([bundle(false), bundle(true)]);
		css = fs.readFileSync(path.join(root, 'media/panel.css'), 'utf8');
		profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-panel-'));
		child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
		// Chromium makes the file before it writes the port in it: read once the port is there
		const portOf = () => fs.existsSync(path.join(profile, 'DevToolsActivePort')) ? fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] : '';
		await until(() => /^\d+$/.test(portOf()));
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
	setup(async () => {
		await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 2, mobile: false });
		await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
		await load();
		await wait(30);
		assert.deepStrictEqual(await evaluate('window.errors'), []);
	});

	test('a card keeps its element, face and dot through every change of what it says; its dot, second line, label and hover are the host\'s (PANEL-1.4, 1.5, 3.2)', async () => {
		assert.deepStrictEqual(await evaluate(`(() => {
			const card = document.querySelector('.agent'), dot = card.querySelector('.dot'), face = card.querySelector('.face');
			agents[0] = newCard(1, { dot: 'idle', stateText: 'Idle', line: 'Fix the login', label: 'Agent 1, #a1, Idle, project, Claude Code, Fix the login', tooltip: ['Agent 1 · #a1 · Claude Code', 'Fix the login', 'Idle'] });
			redraw({ revision: 2 });
			return [card === document.querySelector('.agent'), dot === card.querySelector('.dot'), face === card.querySelector('.face'), dot.className, dot.title, card.querySelector('.title').textContent, card.getAttribute('aria-label'), card.title.split('\\n')];
		})()`), [true, true, true, 'dot not-working', 'Idle', 'Fix the login', 'Agent 1, #a1, Idle, project, Claude Code, Fix the login', ['Agent 1 · #a1 · Claude Code', 'Fix the login', 'Idle', 'Started now', 'project · /project']]);
	});

	test('PANEL-1.5: a card\'s hover says how long ago it started, then its location and window', async () => {
		await deliver({ type: 'state', state: await evaluate(`stateOf([newCard(1, { location: { label: 'project', full: 'project · /project · Window: shop' } }), newCard(2)])`) });
		assert.deepStrictEqual(await evaluate(`[window.errors, [...document.querySelectorAll('.agent')].map(card => card.title.split('\\n').slice(-2))]`), [[], [
			['Started now', 'project · /project · Window: shop'],
			['Started now', 'project · /project']
		]]);
	});

	test('the dot\'s cut-out ring is the colour the row shows: a translucent hover or selection colour over the side bar, never over the avatar (PANEL-1.3)', async () => {
		await evaluate(`document.documentElement.style.cssText = '--vscode-sideBar-background:#202020;--vscode-list-activeSelectionBackground:rgba(0, 120, 255, 0.3)';`);
		const rings = await evaluate(`(() => { agents[0] = newCard(1, { selected: true }); redraw({ revision: 2 }); const cards = document.querySelectorAll('.agent'); return [cards[0], cards[1]].map(card => { const dot = card.querySelector('.dot'); return [getComputedStyle(dot).boxShadow, getComputedStyle(dot, '::after').backgroundImage.startsWith('linear-gradient')]; }); })()`);
		assert.deepStrictEqual(rings, [
			['rgba(0, 120, 255, 0.3) 0px 0px 0px 2px, rgb(32, 32, 32) 0px 0px 0px 2px', true],
			['rgb(32, 32, 32) 0px 0px 0px 2px, rgb(32, 32, 32) 0px 0px 0px 2px', true]
		]);
	});

	test('J05: green breathes, yellow and red are still - unknown activity is red, never a fourth state - each in words in its hover (RULES-3.2, PANEL-1.4, UX-2.1)', async () => {
		await evaluate(`document.documentElement.style.cssText = '--vscode-charts-green:#00ff00;--vscode-charts-yellow:#ffff00;--vscode-charts-red:#ff0000;--vscode-sideBar-background:#202020';`);
		const seen = await evaluate(`(() => { agents = [newCard(1), newCard(2, { dot: 'idle', stateText: 'Idle' }), newCard(3, { dot: 'error', stateText: 'Activity unavailable', line: 'This CLI reports no activity' })]; redraw({ revision: 2 }); return [...document.querySelectorAll('.agent')].map(card => { const dot = card.querySelector('.dot'), style = getComputedStyle(dot); return [dot.className, dot.title, style.backgroundColor, getComputedStyle(dot, '::after').animationName, style.boxShadow.includes('inset')]; }); })()`);
		assert.deepStrictEqual(seen, [
			['dot working', 'Working', 'rgb(0, 255, 0)', 'facade-breathe', false],
			['dot not-working', 'Idle', 'rgb(255, 255, 0)', 'none', false],
			['dot error', 'Activity unavailable', 'rgb(255, 0, 0)', 'none', false]
		]);
	});

	test('a card has no unread dot, completed check, bold name or extra badge (PANEL-1.4)', async () => {
		assert.deepStrictEqual(await evaluate(`(() => { const cards = [...document.querySelectorAll('.agent')]; return [document.querySelectorAll('.unread-dot, .done-mark, .codicon-check, .item.unread, .item.attention, .badge').length, new Set(cards.map(card => getComputedStyle(card.querySelector('.name')).fontWeight)).size, getComputedStyle(cards[0].querySelector('.name')).fontWeight, cards[0].querySelector('.line.bottom').children.length]; })()`), [0, 1, '400', 1]);
	});

	test('CLI words in the card, accessible label and hover are literal text, never HTML or command links (PANEL-3.2)', async () => {
		const text = '[Review](command:test.run) <a href="command:test.run">Review</a>';
		assert.deepStrictEqual(await evaluate(`(() => { agents = [newCard(1, { name: ${JSON.stringify(text)}, line: ${JSON.stringify(text)}, label: ${JSON.stringify(text)}, tooltip: [${JSON.stringify(text)}] })]; redraw({ revision: 2 }); const card = document.querySelector('.agent'); return [card.querySelector('.name').textContent, card.querySelector('.title').textContent, card.title.includes(${JSON.stringify(text)}), card.getAttribute('aria-label'), card.querySelectorAll('a').length]; })()`), [text, text, true, text, 0]);
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
		assert.strictEqual(await evaluate(`getComputedStyle(document.querySelector('.dot')).backgroundColor`), 'rgb(137, 209, 133)');
	});

	test('UX-2.2: a new card opens in 180 ms, but not on the first draw, a change of filter or with reduced motion; a card that goes is removed at once, never animated out', async () => {
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
		assert.deepStrictEqual(seen, [0, '0.18s', [29, 0, false], false, true, false]);
	});

	test('filtering preserves keyboard navigation and F2 targets the visible custom agent', async () => {
		const result = await evaluate(`(() => {
			document.querySelector('[data-run="run-1"]').focus();
			agents = [newCard(2, { avatar: { initial: 'C', color: 'blue' } }), newCard(3)];
			redraw({ revision: 2, filter: { kind: 'location', id: 'filtered', label: 'main' } });
			const stops = [...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0);
			stops[0].focus();
			window.posted = [];
			stops[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
			return [stops.map(card => card.dataset.run), stops[0].querySelector('.initial').textContent,
				window.posted.filter(message => message.type === 'act').map(({ what, target }) => [what, target])];
		})()`);
		assert.deepStrictEqual(result, [['run-2'], 'C', [['rename', 'run-2']]]);
	});

	test('PANEL-1.5, LIFECYCLE-3.1: an agent with an empty name is said by its #aN when its state changes', async () => {
		await evaluate(`agents[0] = newCard(1, { name: '' }); redraw()`);
		await evaluate(`agents[0] = newCard(1, { name: '', dot: 'idle', stateText: 'Idle' }); redraw()`);
		assert.strictEqual(await evaluate(`document.querySelector('[role="status"]').textContent`), '#a1: Idle');
	});

	test('UX-2.2: a card whose process ended fades out where it was - the cards after it are not put before it - and then goes', async () => {
		await evaluate(`agents.splice(4, 1); redraw({ exited: ['run-5'] })`);
		const during = await evaluate(`(() => { const children = [...document.querySelector('#list').children]; const closing = document.querySelector('.agent.closing'); return [closing?.dataset.run, children.indexOf(closing), children.length]; })()`);
		await wait(300);
		const after = await evaluate(`[document.querySelectorAll('.agent.closing').length, document.querySelectorAll('.agent').length]`);
		assert.deepStrictEqual([during, after], [['run-5', 4, 30], [0, 29]]);
	});

	test('a state change is said politely, once, in a live region; a repeated state says nothing new (PANEL-1.5)', async () => {
		const said = await evaluate(`(() => {
			const status = document.querySelector('[role=status]');
			agents[0] = newCard(1, { dot: 'idle', stateText: 'Idle' }); agents[1] = newCard(2, { dot: 'error', stateText: 'Error: Exited with code 2' }); redraw({ revision: 2 });
			const first = status.textContent;
			agents[0] = newCard(1, { dot: 'idle', stateText: 'Idle', line: 'Another line' }); redraw({ revision: 3 });
			return [status.getAttribute('aria-live'), first, status.textContent];
		})()`);
		assert.deepStrictEqual(said, ['polite', 'Agent 1: Idle. Agent 2: Error: Exited with code 2', 'Agent 1: Idle. Agent 2: Error: Exited with code 2']);
	});

	test('PANEL-1.3, D72: a location keeps its own width up to 40% of its line, the name has the rest; a workspace folder\'s name is shown whole or not at all', async () => {
		const seen = await evaluate(`(async () => {
			document.body.style.width = '300px';
			agents = [
				newCard(1, { name: 'Refactor the authentication middleware', location: { label: 'main', folderPrefix: 'demo', full: 'demo · main · /demo' } }),
				newCard(2, { name: 'Relay', location: { label: 'feature-login-redesign-with-a-long-name', folderPrefix: 'untitled folder 2', full: 'x' } })
			];
			redraw({ revision: 3 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const facts = [...document.querySelectorAll('.agent')].map(card => {
				const line = card.querySelector('.line.top').getBoundingClientRect().width, place = card.querySelector('.place'), name = card.querySelector('.name');
				const text = place.querySelector('.tree') ?? place;
				return [place.getBoundingClientRect().width / line <= 0.401, text.scrollWidth > text.clientWidth + 1, place.classList.contains('narrow'), name.scrollWidth > name.clientWidth + 1];
			});
			document.body.style.width = '';
			return facts;
		})()`);
		// A short location whole and the long name cut; a long location cut at 40%, without its folder's name, the short name whole
		assert.deepStrictEqual(seen, [[true, false, false, true], [true, true, true, false]]);
	});

	test('PANEL-1.4, 1.5: under the pointer a card is the card itself or its dot, so crossing it never clears and sets the same tooltip again (electron/electron#49843)', async () => {
		const seen = await evaluate(`(async () => {
			document.body.style.width = '300px';
			agents = [
				newCard(1, { selected: true, location: { label: 'main', folderPrefix: 'demo', full: 'demo · main · /demo' } }),
				newCard(2, { name: 'Refactor the authentication middleware', location: { label: 'feature-login-redesign-with-a-long-name', folderPrefix: 'untitled folder 2', full: 'x' } }),
				newCard(3)
			];
			redraw({ revision: 3 });
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const under = new Set();
			for (const card of document.querySelectorAll('.agent')) {
				const box = card.getBoundingClientRect(), dot = card.querySelector('.dot');
				for (let y = box.top + 1; y < box.bottom - 1; y += 3) {
					for (let x = box.left + 5; x < box.right - 5; x += 3) {
						const at = document.elementFromPoint(x, y);
						under.add(at === card ? 'card' : at === dot ? 'dot' : at.className || at.tagName);
					}
				}
			}
			const ownHover = [...document.querySelectorAll('.agent')].every(card => card.title !== '' && card.querySelector('.dot').title !== '' && card.querySelector('.dot').title !== card.title);
			document.body.style.width = '';
			return [[...under].sort(), ownHover];
		})()`);
		assert.deepStrictEqual(seen, [['card', 'dot'], true]);
	});

	test('PANEL-2.2: outside a card there is no menu at all - the webview\'s default Cut/Copy/Paste included - below the last card too', async () => {
		// The context VS Code's webview gives a right click: each marked element's from the one clicked up, the nearest winning
		const contextAt = `(element => { let context = {}; for (let at = element; (at = at && at.closest('[data-vscode-context]')); at = at.parentElement) { context = { ...JSON.parse(at.dataset.vscodeContext), ...context }; } return context; })`;
		// Below the last card in VS Code the click lands on the page's root, which the body does not reach down to
		const at = await evaluate(`(() => { agents = [newCard(1)]; redraw({}); return [document.documentElement, document.elementFromPoint(5, innerHeight - 5), document.getElementById('empty')].map(${contextAt}); })()`);
		assert.deepStrictEqual(at, [{ preventDefaultContextMenuItems: true }, { preventDefaultContextMenuItems: true }, { preventDefaultContextMenuItems: true }]);
	});

	test('PANEL-2.2: a card\'s menu is given its run ID and only the actions that apply: Move Up or Down where it moves, its filters where they change what is shown, Clear Filter while filtered; Rename, Copy and Close always', async () => {
		assert.deepStrictEqual(await evaluate(`(() => { agents[0] = newCard(1, { menu: { moveUp: false, moveDown: true, filterLocation: true, filterFolder: false, clearFilter: true } }); redraw({ revision: 7 }); return [...document.querySelectorAll('.agent')].slice(0, 2).map(card => JSON.parse(card.dataset.vscodeContext)); })()`), [
			{ webviewSection: 'agent', run_id: 'run-1', webviewMoveDown: true, webviewFilterLocation: true, webviewFiltered: true, preventDefaultContextMenuItems: true },
			{ webviewSection: 'agent', run_id: 'run-2', preventDefaultContextMenuItems: true }
		]);
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
		await wait(80);
		const saved = await evaluate('window.saved');
		await load(shipped, saved);
		await wait(30);
		const back = await evaluate(`[(document.scrollingElement ?? document.documentElement).scrollTop, document.activeElement === document.body, [...document.querySelectorAll('.agent')].filter(card => card.tabIndex === 0).map(card => card.dataset.run)]`);
		// A scroll beyond the list is kept within it; a card no longer there, or what an earlier build saved beside it, is nothing
		await load(shipped, { scrollTop: 1e6, target: 'run-99', focused: 'run-12' });
		await wait(80);
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
		// No agent: New Agent, no ellipsis (D60), and nothing else
		assert.deepStrictEqual(await empty({ empty: 'noAgents' }), [false, ['noAgents', 'button:newAgent']]);
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
		/** The screen's colour at one CSS pixel: a 1x1 PNG's only pixel, whichever filter its one row has. */
		const pixelAt = async (x: number, y: number) => {
			const png = Buffer.from((await call('Page.captureScreenshot', { format: 'png', clip: { x, y, width: 1, height: 1, scale: 1 } })).result.data, 'base64');
			const chunks: Buffer[] = [];
			for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) {
				if (png.toString('ascii', at + 4, at + 8) === 'IDAT') { chunks.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at))); }
			}
			return [...zlib.inflateSync(Buffer.concat(chunks)).subarray(1, 4)].join(',');
		};
		// VS Code 1.143's own default, in its layer (webview/browser/pre/index.html): its root's scrollbar-color turns the page's rules off
		await evaluate(`(() => {
			const vscode = document.createElement('style');
			vscode.textContent = '@layer vscode-default { html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); } ::-webkit-scrollbar { width: 10px; height: 10px; } ::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); } }';
			document.head.prepend(vscode);
			document.documentElement.style.cssText = '--vscode-scrollbarSlider-background:#ff0000;--vscode-scrollbarSlider-hoverBackground:#00ff00;--vscode-scrollbarSlider-activeBackground:#0000ff;--vscode-editor-background:#ffff00';
			window.cancelled = [];
			window.addEventListener('wheel', event => window.cancelled.push(event.defaultPrevented));
		})()`);
		const width = await evaluate('innerWidth - document.documentElement.clientWidth');
		const [slider, track] = [await pixelAt(395, 5), await pixelAt(395, 295)];
		await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 395, y: 10 });
		const hovered = await pixelAt(395, 5);
		await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 395, y: 10, button: 'left', clickCount: 1 });
		const pressed = await pixelAt(395, 5);
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
		assert.deepStrictEqual([width, slider, track, hovered, pressed, await evaluate(`document.querySelectorAll('.scrollbar, .slider').length`)], [10, '255,0,0', '255,255,255', '0,255,0', '0,0,255', 0]);
		assert.deepStrictEqual({ lines, sensitive, fast, atEnd: atEnd === end, cancelled: cancelled.length === 5 && cancelled.every(Boolean), ctrl, errors: await evaluate('window.errors') },
			{ lines: [50, 100], sensitive: 200, fast: 700, atEnd: true, cancelled: true, ctrl: [false, true], errors: [] });
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

	test('New Agent\'s own icon draws where codicons\' `new-session` does: at 300 px, ink from 38 to 281 px of a 300 px advance, as its outline is placed in VS Code\'s codicon.ttf (PANEL-1.1, D85)', async () => {
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

	test('a custom CLI\'s face is its initial on its theme colour, kept while it stays, on a fainter tint or the side bar\'s own colour where its letter would not read (PANEL-1.3, UX-2.1)', async () => {
		/** The theme's colours, as VS Code sets them on the page's root: null removes one. */
		const theme = (colors: { readonly [name: string]: string | null }) => evaluate(`(() => {
			for (const [name, value] of Object.entries(${JSON.stringify(colors)})) {
				value === null ? document.documentElement.style.removeProperty(name) : document.documentElement.style.setProperty(name, value);
			}
		})()`);
		const grounds = () => evaluate(`[...document.querySelectorAll('.agent .face')].map(face => [face.classList.contains('faint') ? 'faint' : face.classList.contains('unreadable') ? 'plain' : 'tint', getComputedStyle(face).backgroundColor])`);
		// Dark Modern, whose orange is VS Code's own, see-through: taken opaque, so that every circle is measured as it is drawn
		await theme({ '--vscode-foreground': '#cccccc', '--vscode-sideBar-background': '#181818', '--vscode-charts-blue': '#3794ff', '--vscode-charts-orange': '#d186167e', '--vscode-charts-purple': '#b180d7' });
		const seen = await evaluate(`(() => {
			agents = [newCard(1, { avatar: { initial: 'M', color: 'blue' } }), newCard(2, { avatar: { initial: 'Q', color: 'purple' } }), newCard(3, { avatar: { initial: 'Z', color: 'purple' } })]; redraw({ revision: 2 });
			const faces = [...document.querySelectorAll('.agent .face')];
			const drawn = faces.map(face => [face.classList.contains('initial'), face.className.match(/on-\\w+/)[0], face.textContent, face.querySelector('img') === null, face.getAttribute('aria-hidden')]);
			agents = [newCard(1, { avatar: { initial: 'M', color: 'blue' }, line: 'Another line' }), newCard(2, { avatar: { initial: 'Q', color: 'orange' } }), agents[2]]; redraw({ revision: 3 });
			const after = [...document.querySelectorAll('.agent .face')];
			return [drawn, after[0] === faces[0], after[1] === faces[1], after[1].className.match(/on-\\w+/)[0]];
		})()`);
		assert.deepStrictEqual(seen, [[[true, 'on-blue', 'M', true, 'true'], [true, 'on-purple', 'Q', true, 'true'], [true, 'on-purple', 'Z', true, 'true']], true, false, 'on-orange']);
		const dark = await grounds();
		assert.deepStrictEqual(dark.map((each: string[]) => each[0]), ['tint', 'tint', 'tint']);
		assert.ok(dark.every((each: string[]) => !/rgba\(|\/ 0?\.\d/.test(each[1])), JSON.stringify(dark));
		// Light+: no letter reads on the tint, each does on the fainter one
		await theme({ '--vscode-foreground': '#616161', '--vscode-sideBar-background': '#f3f3f3', '--vscode-charts-blue': '#1a85ff', '--vscode-charts-orange': '#d18616', '--vscode-charts-purple': '#652d90' });
		await wait(30);
		const light = (await grounds()).map((each: string[]) => each[0]);
		// A theme whose text reads best on the side bar itself; and one without a colour, which leaves that circle clear and untested
		await theme({ '--vscode-foreground': '#5a7fb0', '--vscode-sideBar-background': '#ffffff', '--vscode-charts-purple': null });
		await wait(30);
		const poor = (await grounds()).map((each: string[]) => each[0]);
		await theme({ '--vscode-foreground': '#cccccc', '--vscode-sideBar-background': '#181818', '--vscode-charts-purple': '#b180d7' });
		await wait(30);
		assert.deepStrictEqual([light, poor, (await grounds()).map((each: string[]) => each[0])], [['faint', 'faint', 'faint'], ['plain', 'plain', 'tint'], ['tint', 'tint', 'tint']]);
		// An initial must be a letter and its colour one of the three: anything else is refused, as any malformed state is
		for (const avatar of [{ initial: '', color: 'blue' }, { initial: 'M', color: 'red' }, { initial: 'M' }]) {
			await evaluate('window.errors = []');
			await deliver({ type: 'state', state: { revision: 9, loading: false, cards: [{ ...(await evaluate('newCard(1)')), avatar }], cardCount: 1, capabilities: { remote: false } } });
			assert.strictEqual((await evaluate('window.errors')).length, 1, JSON.stringify(avatar));
		}
	});
});
