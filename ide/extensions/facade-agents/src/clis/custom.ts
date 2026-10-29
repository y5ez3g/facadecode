/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { isJsonObject } from '../base/json';
import { AgentCli, CliConfig, launchArgs, launchUses, launchValues } from './cli';
import { launchOf, shown } from './config';

/** The setting that holds the person's custom agents, by name. */
export const CUSTOM_AGENTS_SETTING = 'facade.agents.custom';

/** A custom agent: its definition, and how the person has Facade start it - their launch alone. */
export interface CustomAgent {
	readonly cli: AgentCli;
	readonly config: CliConfig;
}

/**
 * A custom agent of the person's, as `facade.agents.custom.<name>` has it: `{ path, launch }` (AGENT-LAUNCHER.md,
 * L9). Its program is found as a built-in's is; its launch has the parts of a built-in's, and Facade fills
 * in none of them: each group the person filled in applies as a built-in's does, one left out adds nothing.
 * So it gets YOLO, trust, Facade's tools, a model, an effort or a task only as far as the person said how.
 * In its arguments, `${mcpConfig}` stands for a file of its run that names Facade's MCP server in the
 * `mcpServers` form many CLIs read; the values every launch has - `${folder}`, `${repository}`, `${home}`,
 * `${messagesDir}`, `${screensDir}`, `${model}`, `${effort}`, `${task}` and the connection's - as for a built-in. Where its name is not one an agent can have, `nameProblem` says why, and it is
 * not started.
 */
export function customAgentOf(name: string, value: unknown, nameProblem: string | undefined): CustomAgent {
	const setting = `${CUSTOM_AGENTS_SETTING}.${name}`;
	const wrong: string[] = nameProblem ? [`${setting}: ${nameProblem}`] : [];
	const set = isJsonObject(value) ? value : {};
	if (!isJsonObject(value)) {
		wrong.push(`${setting} must be an object such as { "path": ..., "launch": { ... } }; received ${shown(value)}`);
	}
	for (const key of Object.keys(set)) {
		if (key !== 'path' && key !== 'launch') {
			wrong.push(`Unknown field '${key}' in ${setting}. A custom agent accepts path and launch`);
		}
	}
	const program = typeof set.path === 'string' ? set.path.trim() : '';
	if (!program) {
		wrong.push(`${setting}.path is ${set.path === undefined ? 'missing' : shown(set.path)}. Specify the program to launch`);
	}
	if (set.launch !== undefined && !isJsonObject(set.launch)) {
		wrong.push(`${setting}.launch must be an object; received ${shown(set.launch)}`);
	}
	const blank: AgentCli = {
		id: name,
		displayName: name,
		setting,
		command: program,
		defaults: { path: program, enabled: true, launch: { arguments: {}, environment: {}, enterDelay: 250, taskDelay: 0 } },
		task: 'argument',
		sandbox: { yoloOn: 'unknown', yoloOff: 'unknown' },
		exemption: 'unknown',
		questionTool: 'unknown',
		custom: true,
		launch: () => {
			throw new Error('not a launch');
		}
	};
	const launch = launchOf(blank, isJsonObject(set.launch) ? set.launch : {}, `${setting}.launch`, wrong);
	const cli: AgentCli = {
		...blank,
		// A task group in its launch, or in the unattended part an agent that gives it a task starts it with (L9)
		task: launch.arguments.task?.length || launch.unattended?.arguments.task?.length ? 'argument' : 'none',
		trustValues: ({ folder, repository }) => ({ folder: canonicalFolder(folder), repository: canonicalFolder(repository) }),
		launch(input, executable) {
			const { connection } = input;
			const mcpConfig = path.join(input.runDir, `${input.slug}.mcp.json`);
			return {
				executable,
				args: launchArgs(`${setting}.launch`, input.config, { ...launchValues(input), ...connection ? { mcpConfig } : {} }, launchUses(input)),
				env: input.config.launch.environment,
				cwd: input.folder,
				files: connection ? [{ path: mcpConfig, content: JSON.stringify({ mcpServers: { facade: { command: connection.mcp.command, args: connection.mcp.args, env: connection.mcp.env } } }, undefined, '\t') }] : [],
				injected: []
			};
		}
	};
	return { cli, config: { path: program, enabled: true, launch, ...(wrong.length ? { wrong } : {}) } };
}
