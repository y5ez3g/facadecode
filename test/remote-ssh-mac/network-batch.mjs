// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// Repeats actual SSH socket cuts with real HTTP, MCP, host process and UI observations.
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const run = promisify(execFile);
const { values } = parseArgs({ options: { campaign: { type: 'string' }, label: { type: 'string', default: 'network-batch-576' },
	'ten-second-rounds': { type: 'string', default: '20' }, 'minute-rounds': { type: 'string', default: '5' } } });
const ten = Number(values['ten-second-rounds']);
const minute = Number(values['minute-rounds']);
if (!values.campaign || !/^[a-z0-9-]+$/.test(values.label) || ![ten, minute].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100)) {
	throw new Error('Usage: network-batch.mjs --campaign <dir> [--label <name>] [--ten-second-rounds 20] [--minute-rounds 5]');
}
const campaign = resolve(values.campaign);
const root = resolve(import.meta.dirname, '../..');
const evidence = join(campaign, values.label);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const config = json(join(campaign, 'soak-targets.json'));
const state = { pid: process.pid, startedAt: new Date().toISOString(), status: 'RUNNING', requestedPerTarget: { tenSecond: ten, minute }, cases: [] };
const browsers = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) { throw new Error(message); } };
const save = () => writeFileSync(join(evidence, 'results.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const observe = async (target, label, withUi) => {
	const [mcp, probe, http] = await Promise.all([
		run(process.execPath, [join(root, 'test/remote-ssh-mac/control.mjs'), '--campaign', campaign, '--target', target.target,
			'--record', target.record, '--commit', target.commit, '--tool', 'list_agents', '--label', label], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }),
		run(process.execPath, [join(root, 'test/remote-ssh-mac/remote.mjs'), '--campaign', campaign, '--target', target.target,
			'--script', target.probe], { timeout: 30000, maxBuffer: 1024 * 1024 }),
		withUi ? Promise.all(target.http.map(async endpoint => {
			const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(10000) });
			check(response.ok, endpoint.name + ': HTTP ' + response.status);
			const body = await response.json();
			check(body.pid === endpoint.pid && body.os === target.os && body.host === target.hostname, endpoint.name + ': process/host identity changed');
			return body;
		})) : undefined
	]);
	const agents = JSON.parse(mcp.stdout).data.agents;
	for (const id of target.agents) { check(agents.some(agent => agent.id === id && agent.state === 'running' && agent.connected), target.target + ': original agent ' + id + ' unavailable'); }
	const host = JSON.parse(probe.stdout.replace(/^\uFEFF/, ''));
	check(host.ok, target.target + ': independent host check failed');
	const first = json(join(campaign, `phase576-${target.target}-independent-first-probe.json`));
	for (const previous of first.processes) {
		const current = host.processes.find(process => process.kind === previous.kind);
		check(current?.pid === previous.pid && current.startTicks === previous.startTicks && current.created === previous.created,
			target.target + ': original ' + previous.kind + ' process changed');
	}
	let ui;
	if (withUi) {
		const launch = json(target.client);
		let browser = browsers.get(launch.cdpPort);
		if (!browser?.isConnected()) { browser = await chromium.connectOverCDP('http://127.0.0.1:' + launch.cdpPort); browsers.set(launch.cdpPort, browser); }
		const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench.html'));
		check(page, target.target + ': workbench missing');
		const rows = await page.getByRole('tree', { name: 'Workspace Folders', exact: true }).getByRole('treeitem').allTextContents();
		check(rows.some(row => row.startsWith('repo-a')) && rows.some(row => row.startsWith('repo-b')), target.target + ': original workspace rows missing');
		ui = { title: await page.title(), rows };
	}
	return { at: new Date().toISOString(), agents, host, http, ui };
};
const notify = async () => {
	const config = json(join(campaign, 'notification.json'));
	if (!config.enabled) { return; }
	return run(process.execPath, [join(root, 'test/remote-ssh-mac/live-mcp.mjs'), '--client', join(campaign, 'mcpClient.cjs'),
		'--shim', config.shim, '--record', config.record,
		'--tool', 'send_message', '--args-file', config.argsFile, '--timeout-ms', '15000'
	], { timeout: 20000, maxBuffer: 1024 * 1024 });
};
try {
	check(config.ready, 'Actual target metadata is not ready');
	for (const [duration, count] of [[10, ten], [60, minute]]) {
		for (let round = 1; round <= count; round++) {
			for (const target of config.targets) {
				while (existsSync(join(campaign, 'network-batch.pause'))) {
					state.status = 'PAUSED-BETWEEN-CASES'; save(); await sleep(1000);
				}
				state.status = 'RUNNING';
				const label = `${values.label}-${target.target}-${duration}s-${round}`;
				state.current = { target: target.target, commit: target.commit, duration, round, label, startedAt: new Date().toISOString() }; save();
				const before = await observe(target, label + '-before', true);
				const endpoint = target.http[0];
				const fault = run(process.execPath, [join(root, 'test/remote-ssh-mac/network-case.mjs'), '--campaign', campaign, '--target', target.target,
					'--url', endpoint.url, '--duration', String(duration), '--expected-pid', String(endpoint.pid), '--label', label], { timeout: 200000, maxBuffer: 2 * 1024 * 1024 });
				fault.catch(() => {});
				await sleep(duration * 500);
				let during;
				let duringError;
				try { during = await observe(target, label + '-during', false); } catch (error) { duringError = String(error); }
				const transport = JSON.parse((await fault).stdout);
				check(transport.ok, label + ': real transport did not recover');
				check(!duringError, label + ': independent observation failed: ' + duringError);
				const after = await observe(target, label + '-after', true);
				state.cases.push({ ...state.current, finishedAt: new Date().toISOString(), status: 'PASS', before, during, after,
					transportEvidence: 'network-cases/' + label + '.json' }); save();
				console.log(JSON.stringify({ target: target.target, duration, round, status: 'PASS', at: new Date().toISOString() }));
			}
		}
	}
	state.status = 'PASS';
} catch (error) {
	state.status = 'NEEDS-INVESTIGATION'; state.error = String(error); console.error(String(error));
} finally {
	state.finishedAt = new Date().toISOString();
	state.qualification = 'Repeated real transport, original process/MCP and visible workspace continuity only; this does not establish the entire acceptance matrix.';
	save(); await notify().catch(() => {}); process.exit(state.status === 'PASS' ? 0 : 1);
}
