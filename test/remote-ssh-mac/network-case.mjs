// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
	campaign: { type: 'string' }, target: { type: 'string' }, url: { type: 'string' },
	duration: { type: 'string' }, 'expected-pid': { type: 'string' }, label: { type: 'string' }
} });
const duration = Number(values.duration);
const pid = Number(values['expected-pid']);
if (!values.campaign || !['linux', 'windows'].includes(values.target) || !values.url?.startsWith('http://127.0.0.1:') ||
	![10, 60].includes(duration) || !Number.isSafeInteger(pid) || !values.label || !/^[a-z0-9-]+$/.test(values.label)) {
	throw new Error('Usage: network-case.mjs --campaign <dir> --target linux|windows --url <actual forwarded loopback URL> --duration 10|60 --expected-pid <real PID> --label <evidence name>');
}
const campaign = resolve(values.campaign);
const policyPath = join(campaign, 'network-policy.json');
const evidence = join(campaign, 'network-cases');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const observations = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sample = async phase => {
	const started = performance.now();
	try {
		const response = await fetch(values.url, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) { throw new Error('HTTP ' + response.status); }
		const body = await response.json();
		const valid = body.pid === pid && body.os === (values.target === 'windows' ? 'win32' : 'linux');
		const result = { phase, at: new Date().toISOString(), ms: performance.now() - started, reachable: true, valid, body };
		observations.push(result);
		return result;
	} catch (error) {
		const result = { phase, at: new Date().toISOString(), ms: performance.now() - started, reachable: false, error: String(error) };
		observations.push(result);
		return result;
	}
};
const writePolicy = policy => {
	const temporary = policyPath + '.new-' + process.pid;
	writeFileSync(temporary, JSON.stringify(policy) + '\n', { mode: 0o600 });
	renameSync(temporary, policyPath);
};
let pauseUntil;
let failure;
let recovered;
try {
	if (!(await sample('before-real-cut')).valid) { throw new Error('Actual forwarded HTTP endpoint was not healthy before the cut.'); }
	const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
	if (Date.parse(policy[values.target]?.pauseUntil || '') > Date.now()) { throw new Error('Another real network test already owns this target.'); }
	pauseUntil = new Date(Date.now() + duration * 1000).toISOString();
	policy[values.target] = { pauseUntil, label: values.label };
	writePolicy(policy);
	await sleep(duration * 500);
	if ((await sample('during-real-cut')).reachable) { throw new Error('The client endpoint remained reachable; the intended SSH connection was not cut.'); }
	await sleep(Math.max(0, Date.parse(pauseUntil) - Date.now()) + 1000);
	const recoveryDeadline = Date.now() + 120000;
	while (Date.now() < recoveryDeadline) {
		const observation = await sample('automatic-recovery');
		if (observation.valid) { recovered = observation; break; }
		if (observation.reachable) { throw new Error('The recovered endpoint belongs to a different process or OS.'); }
		await sleep(2000);
	}
	if (!recovered) { throw new Error('No automatic recovery of the same real HTTP process within 120 seconds.'); }
} catch (error) {
	failure = String(error);
} finally {
	const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
	if (pauseUntil && policy[values.target]?.pauseUntil === pauseUntil) {
		delete policy[values.target];
		writePolicy(policy);
	}
	const result = { label: values.label, target: values.target, actualCutSeconds: duration, expectedPid: pid,
		finishedAt: new Date().toISOString(), ok: !failure, failure, observations,
		qualification: 'Actual SSH transport interruption and forwarded HTTP process continuity only; agent, dirty-editor and sleep/wake checks are separate.' };
	writeFileSync(join(evidence, values.label + '.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
	console.log(JSON.stringify(result));
	process.exitCode = failure ? 1 : 0;
}
