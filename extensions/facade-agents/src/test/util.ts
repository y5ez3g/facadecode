/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentAdapter, AgentCatalog } from '../common/agents';
import { EngineSettings } from '../common/engine';
import { Cmd, FeatureSpec, ProgramPlan } from '../common/model';

/**
 * What every git in these tests runs with: none of this machine's configuration, and none of the
 * `GIT_` variables of whatever runs the tests.
 */
export const gitEnvironment: NodeJS.ProcessEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))),
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@test',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@test'
};

export function run(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnvironment }).trim();
}

export function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** A temporary folder, real path, removed by the returned function. */
export function tempDir(prefix: string): { dir: string; remove(): void } {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

/** A repository with one commit on `main`, holding `files`. */
export function makeRepo(root: string, files: Record<string, string>): string {
	const repo = path.join(root, 'repo');
	for (const [name, content] of Object.entries(files)) {
		write(path.join(repo, name), content);
	}
	run(repo, 'init', '-q', '-b', 'main');
	run(repo, 'config', 'user.name', 'test');
	run(repo, 'config', 'user.email', 'test@test');
	run(repo, 'config', 'core.autocrlf', 'false');
	run(repo, 'add', '.');
	run(repo, 'commit', '-q', '-m', 'init');
	return repo;
}

/** A check that passes when `file` contains `text`: node, so it runs the same on every platform. */
export function fileContains(file: string, text: string): Cmd {
	return { argv: [process.execPath, '-e', `process.exit(require('fs').existsSync(${JSON.stringify(file)}) && require('fs').readFileSync(${JSON.stringify(file)}, 'utf8').includes(${JSON.stringify(text)}) ? 0 : 1)`] };
}

export const alwaysPasses: Cmd = { argv: [process.execPath, '-e', 'process.exit(0)'] };

export function feature(id: string, overrides: Partial<FeatureSpec> = {}): FeatureSpec {
	return {
		id,
		title: `Build ${id}`,
		goal: `Write done into src/${id}.txt.`,
		owns: [`src/${id}.txt`],
		acceptance: { criteria: [`src/${id}.txt says done`], commands: [fileContains(`src/${id}.txt`, 'done')] },
		size: 'S',
		risk: 'low',
		...overrides
	};
}

export function plan(features: readonly FeatureSpec[], overrides: Partial<ProgramPlan> = {}): ProgramPlan {
	return {
		schema: 1,
		goal: 'Write done into every feature file.',
		approach: 'One feature per file.',
		base: 'main',
		conventions: ['English only'],
		scaffold: { summary: 'Shared notes', paths: ['src/shared.txt'] },
		checks: { fast: [alwaysPasses], full: [] },
		features,
		...overrides
	};
}

export const settings: EngineSettings = {
	maxParallel: 4,
	checkSlots: 2,
	ladder: [],
	retriesPerRung: 1,
	agentConcurrency: {},
	hotspots: ['**/package-lock.json'],
	stallMinutes: 20,
	closeVerifiedWorkers: false,
	workerMode: 'interactive'
};

/** A catalogue of the given adapters, all installed, with `executable` as their program. */
export function catalogOf(adapters: readonly AgentAdapter[], executable = process.execPath): AgentCatalog {
	return {
		known: new Set(adapters.map(adapter => adapter.id)),
		installed: new Map(adapters.map(adapter => [adapter.id, { adapter, executable }])),
		defaultLadder: [...adapters.map(adapter => adapter.id), 'lead']
	};
}

/** An adapter that hands the MCP launch to the fake agent as JSON. */
export function fakeAdapter(id: string, script: string, extra: Partial<AgentAdapter> & { injected?: { path: string; content: string }[] } = {}): AgentAdapter {
	return {
		id,
		displayName: `Fake ${id}`,
		command: id,
		sharesLeadQuota: false,
		headless: false,
		buildLaunch(input, executable) {
			return {
				executable,
				args: [script, ...(input.headless ? ['--headless'] : []), ...(input.trusted ? ['--trusted'] : [])],
				env: { FACADE_FAKE_MCP: JSON.stringify(input.mcp), FACADE_FAKE_AGENT: id },
				cwd: input.worktree,
				files: [],
				injected: extra.injected
			};
		},
		...extra
	};
}

/** Waits until `condition` holds, polling, or fails after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 20_000, what = 'the condition'): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}.`);
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}
