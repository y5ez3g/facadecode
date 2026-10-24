// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// Continuous real HTTP, SSH, Facade MCP and workbench observations. No UI input is sent.
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const { values } = parseArgs({ options: { campaign: { type: 'string' }, until: { type: 'string' } } });
const until = Date.parse(values.until || '');
if (!values.campaign || !Number.isFinite(until)) { throw new Error('Usage: health.mjs --campaign <dir> --until <UTC timestamp>'); }
const campaign = resolve(values.campaign);
const root = resolve(import.meta.dirname, '../..');
const evidence = join(campaign, 'soak');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const browsers = new Map();
const streaks = new Map();
const totals = { cycles: 0, pass: 0, transient: 0, fail: 0 };
let lastAlert = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const notify = async () => {
	const config = json(join(campaign, 'notification.json'));
	if (!config.enabled) { return; }
	await run(process.execPath, [join(root, 'test/remote-ssh-mac/live-mcp.mjs'), '--client', join(campaign, 'mcpClient.cjs'),
		'--shim', config.shim, '--record', config.record,
		'--tool', 'send_message', '--args-file', config.argsFile, '--timeout-ms', '15000'
	], { timeout: 20000, maxBuffer: 1024 * 1024 });
};
const observe = async (target, cycle) => {
	const observations = {};
	const failures = [];
	for (const endpoint of target.http) {
		try {
			const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) { throw new Error('HTTP ' + response.status); }
			const body = await response.json();
			observations[endpoint.name] = body;
			if (body.pid !== endpoint.pid || body.os !== target.os || body.host !== target.hostname) {
				failures.push(endpoint.name + ': actual host/process identity changed');
			}
		} catch (error) { failures.push(endpoint.name + ': ' + error); }
	}
	try {
		const result = await run(process.execPath, [join(root, 'test/remote-ssh-mac/control.mjs'), '--campaign', campaign,
			'--target', target.target, '--record', target.record, '--commit', target.commit, '--tool', 'list_agents',
			'--label', `soak-${target.target}-${cycle}`], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
		const agents = JSON.parse(result.stdout).data.agents;
		observations.agents = agents;
		for (const id of target.agents) {
			const agent = agents.find(agent => agent.id === id);
			if (!agent || agent.state !== 'running' || !agent.connected) { failures.push('Agent ' + id + ': not running and connected'); }
		}
	} catch (error) { failures.push('Actual MCP: ' + String(error).slice(0, 600)); }
	if (target.probe) {
		try {
			const result = await run(process.execPath, [join(root, 'test/remote-ssh-mac/remote.mjs'), '--campaign', campaign,
				'--target', target.target, '--script', target.probe], { timeout: 20000, maxBuffer: 1024 * 1024 });
			observations.independentHostProbe = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
			if (observations.independentHostProbe.ok !== true) { failures.push('Independent host process/heartbeat check failed'); }
		} catch (error) { failures.push('Independent SSH observation: ' + String(error).slice(0, 600)); }
	}
	try {
		const launch = json(target.client);
		let browser = browsers.get(launch.cdpPort);
		if (!browser?.isConnected()) { browser = await chromium.connectOverCDP('http://127.0.0.1:' + launch.cdpPort, { timeout: 5000 }); browsers.set(launch.cdpPort, browser); }
		const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench.html'));
		if (!page) { throw new Error('Workbench page missing'); }
		observations.ui = { title: await page.title(), rows: await page.getByRole('tree', { name: 'Workspace Folders', exact: true }).getByRole('treeitem').allTextContents() };
	} catch (error) { failures.push('Actual workbench: ' + error); }
	const streak = failures.length ? (streaks.get(target.target) || 0) + 1 : 0;
	streaks.set(target.target, streak);
	const status = failures.length ? (streak >= 3 ? 'FAIL' : 'TRANSIENT') : 'PASS';
	return { target: target.target, commit: target.commit, at: new Date().toISOString(), status, streak, failures, observations };
};
while (Date.now() < until) {
	const started = Date.now();
	let config;
	try { config = json(join(campaign, 'soak-targets.json')); } catch { await sleep(1000); continue; }
	if (!config.ready) { await sleep(1000); continue; }
	const results = await Promise.all(config.targets.map(target => observe(target, totals.cycles)));
	totals.cycles++;
	for (const result of results) { totals[result.status.toLowerCase()]++; appendFileSync(join(evidence, 'events.jsonl'), JSON.stringify(result) + '\n', { mode: 0o600 }); }
	const snapshot = { at: new Date().toISOString(), collectionState: 'RUNNING', until: values.until, totals, results };
	writeFileSync(join(evidence, 'latest.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
	const campaignResults = json(join(campaign, 'results.json'));
	const report = '# Remote SSH overnight observations\n\nUpdated: ' + snapshot.at + '. Collection is **RUNNING**. Full acceptance gate is **NOT COMPLETE**.\n\n' +
		`Continuous checks: ${totals.cycles} cycles; ${totals.pass} passing target observations, ${totals.transient} transient and ${totals.fail} persistent failures. These counts are observations, not distinct acceptance cases.\n\n` +
		results.map(result => `- ${result.target}: **${result.status}** (${result.commit.slice(0, 8)})${result.failures.length ? ' — ' + result.failures.join('; ') : ''}`).join('\n') + '\n\n' +
		'## Scenario evidence\n\n' + campaignResults.cases.map(result => `- ${result.target} / ${result.key}: **${result.status}** — ${result.observation}`).join('\n') + '\n\n' +
		'Untested parts of PLAN.md remain untested. Public server release downloads and vendor quota restrictions are reported separately. The raw real HTTP, MCP, SSH and workbench observations are in `soak/events.jsonl`.\n';
	writeFileSync(join(evidence, 'REPORT.md'), report);
	if (Date.now() >= Date.parse('2026-10-24T14:00:00Z')) { writeFileSync(join(campaign, 'MORNING-REPORT.md'), report); }
	if (config.alerts && results.some(result => result.status === 'FAIL') && Date.now() - lastAlert > 900000) {
		lastAlert = Date.now();
		await notify().catch(error => appendFileSync(join(evidence, 'notification-errors.log'), String(error) + '\n'));
	}
	await sleep(Math.max(1, Math.min(60000 - (Date.now() - started), until - Date.now())));
}
writeFileSync(join(evidence, 'finished.json'), JSON.stringify({ finishedAt: new Date().toISOString(), totals, fullAcceptanceGate: 'See scenario results; completion of sampling is not release approval.' }, null, 2) + '\n');
await notify().catch(() => {});
process.exit(0);
