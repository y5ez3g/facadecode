/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Drives the actual packaged Electron workbench through Chromium's input APIs.
// Steps must not contain credentials. Assertions observe the real DOM; no services are replaced.
import { chromium, type Page } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

interface ILocatorTarget {
	within?: string;
	role?: Parameters<Page['getByRole']>[0];
	name?: string;
	regex?: string;
	exact?: boolean;
	selector?: string;
	hasText?: string;
	first?: boolean;
}
type IUiStep =
	| (ILocatorTarget & { action: 'click'; button?: 'left' | 'right' | 'middle' })
	| (ILocatorTarget & { action: 'dblclick' | 'hover' | 'focus' | 'view' })
	| (ILocatorTarget & { action: 'drag'; to: ILocatorTarget })
	| (ILocatorTarget & { action: 'drop-files'; files: string[] })
	| (ILocatorTarget & { action: 'fill'; text: string })
	| (ILocatorTarget & { action: 'press'; key: string })
	| (ILocatorTarget & { action: 'wait'; state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number })
	| { action: 'key'; key: string }
	| { action: 'type'; text: string }
	| { action: 'assert-text'; selector: string; text: string; timeout?: number }
	| { action: 'command'; query: string; option?: string }
	| { action: 'reload'; timeout?: number }
	| { action: 'read' | 'snapshot' };

const { values } = parseArgs({
	options: {
		client: { type: 'string' }, steps: { type: 'string' }, label: { type: 'string' }
	}
});
if (!values.client || !values.steps || !values.label || !/^[a-z0-9-]+$/.test(values.label)) {
	throw new Error('Usage: ui.ts --client <launch.json> --steps <JSON array> --label <evidence name>');
}
const launch = JSON.parse(readFileSync(resolve(values.client), 'utf8'));
const steps: IUiStep[] = JSON.parse(readFileSync(resolve(values.steps), 'utf8'));
if (!Array.isArray(steps)) { throw new Error('Steps must be an array.'); }
const evidence = launch.evidenceDir || dirname(resolve(values.client));
mkdirSync(evidence, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + launch.cdpPort);
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench.html'));
if (!page) { throw new Error('Actual workbench page not found.'); }
page.setDefaultTimeout(10000);
await page.bringToFront();
// Allow Electron's native window activation to finish before opening transient menus.
await page.waitForTimeout(200);
const observations = [];
const target = (step: ILocatorTarget) => {
	const scope = step.within ? page.locator(step.within) : page;
	if (!step.role && !step.selector) { throw new Error('A real UI target needs a role or selector.'); }
	let locator = step.role ? scope.getByRole(step.role, {
		name: step.regex ? new RegExp(step.regex) : step.name, exact: !step.regex && step.exact !== false
	}) : scope.locator(step.selector!);
	if (step.hasText) { locator = locator.filter({ hasText: step.hasText }); }
	return step.first ? locator.first() : locator;
};
const scrub = (text: string) => text.replace(/connectionToken==[^\r\n]*/g, 'connectionToken==[REDACTED]==');
let failed;
try {
	for (const [index, step] of steps.entries()) {
		const startedAt = new Date().toISOString();
		let result;
		switch (step.action) {
			case 'click':
				// Upstream menus deliberately enable mouse-up activation after 100 ms.
				if (step.role === 'menuitem') { await page.waitForTimeout(120); }
				await target(step).click({ button: step.button || 'left' });
				break;
			case 'dblclick': await target(step).dblclick(); break;
			case 'hover': await target(step).hover(); break;
			case 'drag': await target(step).dragTo(target(step.to)); break;
			case 'drop-files': {
				const files = step.files.map(file => resolve(file));
				if (!files.length || files.some(file => !statSync(file).isFile())) { throw new Error('Actual local files are required'); }
				await target(step).scrollIntoViewIfNeeded();
				const box = await target(step).boundingBox();
				if (!box) { throw new Error('Actual drop target is not visible'); }
				const session = await page.context().newCDPSession(page);
				try {
					const data = { items: [], files, dragOperationsMask: 1 };
					for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
						await session.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data });
					}
					result = { files, target: box };
				} finally { await session.detach(); }
				break;
			}
			case 'focus': await target(step).focus(); break;
			case 'fill': await target(step).fill(step.text); break;
			case 'key': await page.keyboard.press(step.key); break;
			case 'press': await target(step).press(step.key); break;
			case 'view':
				if (await target(step).getAttribute('aria-selected') !== 'true' || !await page.locator('.part.sidebar').isVisible()) {
					await target(step).click();
				}
				break;
			case 'type': await page.keyboard.insertText(step.text); break;
			case 'wait': await target(step).waitFor({ state: step.state || 'visible', timeout: step.timeout || 30000 }); break;
			case 'assert-text': {
				await page.waitForFunction(({ selector, text }) => Array.from(document.querySelectorAll(selector)).some(element => element.textContent?.includes(text)),
					{ selector: step.selector, text: step.text }, { timeout: step.timeout || 15000 });
				break;
			}
			case 'command': {
				await page.keyboard.press('Meta+Shift+p');
				await page.locator('.quick-input-widget:visible input').fill('>' + step.query);
				await page.locator('.quick-input-widget:visible').getByRole('option').filter({ hasText: step.option || step.query }).first().click();
				break;
			}
			case 'reload': {
				const loaded = page.waitForEvent('domcontentloaded', { timeout: step.timeout || 90000 });
				loaded.catch(() => { });
				await page.keyboard.press('Meta+Shift+p');
				await page.locator('.quick-input-widget:visible input').fill('>Developer: Reload Window');
				await page.locator('.quick-input-widget:visible').getByRole('option').filter({ hasText: 'Developer: Reload Window' }).first().click();
				await loaded;
				await page.getByRole('tree', { name: 'Workspace Folders', exact: true }).waitFor({ timeout: step.timeout || 90000 });
				break;
			}
			case 'read': result = {
				title: await page.title(), lines: await page.locator('.view-line').allTextContents(),
				editorLines: await page.locator('.part.editor .view-line').allTextContents(),
				focus: await page.evaluate(() => ({
					tag: document.activeElement?.tagName, classes: document.activeElement?.className,
					insideEditor: !!document.activeElement?.closest('.monaco-editor')
				})),
				textboxes: await page.getByRole('textbox').evaluateAll(elements => elements.map(element => ({
					name: element.getAttribute('aria-label'),
					value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : undefined
				}))),
				rows: await page.getByRole('tree', { name: 'Workspace Folders', exact: true }).getByRole('treeitem').allTextContents(),
				dialogs: await page.getByRole('dialog').evaluateAll(elements => elements.map(element => (element as HTMLElement).innerText))
			}; break;
			case 'snapshot': {
				const filename = join(evidence, values.label + '-' + index + '.yml');
				writeFileSync(filename, scrub(await page.locator('body').ariaSnapshot()), { mode: 0o600 });
				result = { filename }; break;
			}
			default: throw new Error('Unknown real UI action.');
		}
		observations.push({ index, action: step.action, startedAt, endedAt: new Date().toISOString(), result });
	}
} catch (error) {
	failed = String(error);
} finally {
	await page.screenshot({ path: join(evidence, values.label + '.png') }).catch(() => { });
	const result = { label: values.label, client: launch.name, finishedAt: new Date().toISOString(), ok: !failed, failed, observations };
	writeFileSync(join(evidence, values.label + '.json'), scrub(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
	console.log(scrub(JSON.stringify(result)));
	// Closing this connection must not close the application being tested.
	process.exit(failed ? 1 : 0);
}
