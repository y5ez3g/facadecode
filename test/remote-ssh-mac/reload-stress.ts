/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reloads real packaged workbenches. All process and MCP observations use the real hosts.
import { chromium, type Browser, type Page } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ICampaignTargets, IHostProbe, IHostProcess, ILaunchInfo, IRemoteAgent, IRemoteTarget, IRunState } from './types.ts';

const run = promisify(execFile);
const { values } = parseArgs({ options: { campaign: { type: 'string' }, rounds: { type: 'string', default: '20' }, label: { type: 'string', default: 'reload-20' } } });
const rounds = Number(values.rounds);
if (!values.campaign || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100 || !/^[a-z0-9-]+$/.test(values.label)) {
	throw new Error('Usage: reload-stress.ts --campaign <dir> [--rounds 20] [--label <name>]');
}
const campaign = resolve(values.campaign);
const root = resolve(import.meta.dirname, '../..');
const evidence = join(campaign, values.label);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const config: ICampaignTargets = json(join(campaign, 'soak-targets.json'));
interface IClient { target: IRemoteTarget; browser: Browser; page: Page; expectedLines: string[]; processes: IHostProcess[] }
const clients: IClient[] = [];
const state: IRunState & { requestedRoundsPerTarget: number; observations: unknown[] } =
	{ startedAt: new Date().toISOString(), requestedRoundsPerTarget: rounds, status: 'RUNNING', observations: [] };
const save = () => writeFileSync(join(evidence, 'results.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
function check(condition: unknown, message: string): asserts condition { if (!condition) { throw new Error(message); } }
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

const showA = async (client: IClient) => {
	const { page, target, expectedLines } = client;
	await page.getByRole('tree', { name: 'Workspace Folders', exact: true }).getByRole('treeitem', { name: /^repo-a(?:,|$)/ }).click();
	await page.locator('.part.sidebar [aria-label*="/repo-a/sentinel.txt"]').waitFor();
	await page.getByRole('tab', { name: 'sentinel.txt', exact: true }).click();
	await page.waitForFunction(text => Array.from(document.querySelectorAll('.view-line')).some(element => element.textContent?.includes(text)),
		'UNSAVED_CANDIDATE576_' + (target.target === 'linux' ? 'LINUX' : 'WINDOWS') + '_A447');
	const lines = await page.locator('.part.editor .view-line').allTextContents();
	check(JSON.stringify(lines) === JSON.stringify(expectedLines), target.target + ': hidden dirty contents changed');
	check(await page.getByRole('tab', { name: `repo-a - @codex #a${target.agents[0]}`, exact: true }).count() === 1, target.target + ': A agent tab count is not one');
	return lines;
};
const showB = async (client: IClient) => {
	const { page, target } = client;
	await page.getByRole('tree', { name: 'Workspace Folders', exact: true }).getByRole('treeitem', { name: /^repo-b(?:,|$)/ }).click();
	await page.locator('.part.sidebar [aria-label*="/repo-b/sentinel.txt"]').waitFor();
	const name = `repo-b - @codex #a${target.agents[1]}`;
	check(await page.getByRole('tab', { name, exact: true }).count() === 1, target.target + ': B agent tab count is not one');
	await page.getByRole('tab', { name, exact: true }).click();
	check(await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected') === 'true', target.target + ': B agent tab is not selected');
	await page.waitForFunction(name => document.title.includes(name), name);
	// Windows may replace the terminal's accessible name with its environment notice.
	// The selected agent tab identifies the editor; the panel is a different scope.
	await page.locator('[role="main"]').getByRole('textbox').focus();
};
const observe = async (client: IClient, round: number | string) => {
	const { target } = client;
	const label = `${values.label}-${target.target}-${round}`;
	const observations = await Promise.allSettled([
		run(process.execPath, [join(root, 'test/remote-ssh-mac/control.ts'), '--campaign', campaign, '--target', target.target,
			'--record', target.record, '--commit', target.commit, '--tool', 'list_agents', '--label', label], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }),
		run(process.execPath, [join(root, 'test/remote-ssh-mac/remote.ts'), '--campaign', campaign, '--target', target.target,
			'--script', target.probe], { timeout: 30000, maxBuffer: 1024 * 1024 }),
		Promise.all(target.http.map(async endpoint => {
			const attempts = [];
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				try {
					const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(5000) });
					check(response.ok, endpoint.name + ': HTTP ' + response.status);
					const body = await response.json();
					check(body.pid === endpoint.pid && body.host === target.hostname && body.os === target.os, endpoint.name + ': actual process/host changed');
					return { endpoint: endpoint.name, body, attempts };
				} catch (error) {
					attempts.push({ at: new Date().toISOString(), error: String(error) });
					await sleep(500);
				}
			}
			throw new Error(endpoint.name + ': did not recover within 30 seconds: ' + JSON.stringify(attempts));
		}))
	]);
	for (const result of observations) { if (result.status === 'rejected') { throw result.reason; } }
	const unwrap = <T>(result: PromiseSettledResult<T>): T => {
		if (result.status === 'rejected') { throw result.reason; }
		return result.value;
	};
	const mcp = unwrap(observations[0]);
	const probe = unwrap(observations[1]);
	const http = unwrap(observations[2]);
	const agents: IRemoteAgent[] = JSON.parse(mcp.stdout).data.agents;
	for (const id of target.agents) {
		check(agents.some(agent => agent.id === id && agent.state === 'running' && agent.connected), target.target + ': agent ' + id + ' lost or disconnected');
	}
	const host: IHostProbe = JSON.parse(probe.stdout.replace(/^\uFEFF/, ''));
	check(host.ok, target.target + ': independent process/heartbeat check failed: ' + JSON.stringify(host.errors));
	for (const previous of client.processes) {
		const current = host.processes.find(process => process.kind === previous.kind);
		check(current?.pid === previous.pid && current.startTicks === previous.startTicks && current.created === previous.created,
			target.target + ': original ' + previous.kind + ' process was replaced');
	}
	return { agents, http, host };
};
try {
	for (const target of config.targets) {
		const launch: ILaunchInfo = json(target.client);
		const browser = await chromium.connectOverCDP('http://127.0.0.1:' + launch.cdpPort);
		const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench.html'));
		check(page, target.target + ': no actual workbench page');
		page.setDefaultTimeout(30000);
		const original: { observations: { action: string; result: { lines: string[] } }[] } = json(join(campaign, 'client-' + launch.name, '011-dirty-a-hidden-in-b.json'));
		const originalRead = original.observations.find(entry => entry.action === 'read');
		check(originalRead, target.target + ': original dirty-editor evidence is missing');
		clients.push({
			target, browser, page, expectedLines: originalRead.result.lines,
			processes: json(join(campaign, `phase576-${target.target}-independent-first-probe.json`)).processes
		});
	}
	for (let round = 1; round <= rounds; round++) {
		for (const client of clients) {
			const startedAt = new Date().toISOString();
			state.current = { target: client.target.target, round, startedAt };
			save();
			await client.page.bringToFront();
			await showA(client);
			await showB(client);
			const before = await observe(client, 'before-' + round);
			const loaded = client.page.waitForEvent('domcontentloaded', { timeout: 90000 });
			loaded.catch(() => { });
			await client.page.keyboard.press('F1');
			await client.page.locator('.quick-input-widget:visible input').fill('>Developer: Reload Window');
			await client.page.locator('.quick-input-widget:visible').getByRole('option').filter({ hasText: 'Developer: Reload Window' }).first().waitFor();
			await client.page.locator('.quick-input-widget:visible input').press('Enter');
			await loaded;
			await client.page.getByRole('tab', { name: `repo-b - @codex #a${client.target.agents[1]}`, exact: true }).waitFor({ timeout: 90000 });
			await client.page.locator('[role="main"]').getByRole('textbox').waitFor({ timeout: 90000 });
			const observed = await observe(client, round);
			const dirtyLines = await showA(client);
			await client.page.screenshot({ path: join(evidence, `${client.target.target}-${round}-dirty-a.png`) });
			await showB(client);
			await client.page.screenshot({ path: join(evidence, `${client.target.target}-${round}-agent-b.png`) });
			state.observations.push({ target: client.target.target, commit: client.target.commit, round, startedAt, finishedAt: new Date().toISOString(), status: 'PASS', dirtyLines, before, ...observed });
			save();
			console.log(JSON.stringify({ target: client.target.target, round, status: 'PASS', at: new Date().toISOString() }));
		}
	}
	state.status = 'PASS';
} catch (error) {
	state.status = 'NEEDS-INVESTIGATION';
	state.error = String(error);
	console.error(String(error));
} finally {
	state.finishedAt = new Date().toISOString();
	save();
	process.exit(state.status === 'PASS' ? 0 : 1);
}
