/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { AgentCli, CliConfig } from '../clis/cli';
import { readCliConfig, secondsSetting } from '../clis/config';
import { CUSTOM_AGENTS_SETTING, CustomAgent, customAgentOf } from '../clis/custom';
import { knownClis } from '../clis/registry';
import { START_TIMEOUT_MS } from '../core/launch';
import { agentName } from '../record/agents';

/** The agent framework's switch (AGENT-LAUNCHER.md, L7). */
export const FRAMEWORK_SETTING = 'facade.orchestration.enabled';

/** How the person has Facade start a built-in: its settings, `facade.agents.<cli>.*`, as the window has them now. */
export function configFor(cli: AgentCli): CliConfig {
	const settings = vscode.workspace.getConfiguration(cli.setting);
	return readCliConfig(cli, name => settings.get(name));
}

/**
 * The person's custom agents, `facade.agents.custom`, in the order they wrote them: each with what is wrong
 * in it - a name an agent cannot have, or a built-in's id, among it.
 */
export function customAgents(): readonly CustomAgent[] {
	const value = vscode.workspace.getConfiguration().get<unknown>(CUSTOM_AGENTS_SETTING);
	if (!isJsonObject(value)) {
		return [];
	}
	const builtIns = new Set(knownClis().map(cli => cli.id));
	return Object.entries(value).map(([name, entry]) => customAgentOf(name, entry, nameProblem(name, builtIns)));
}

/** Why `name` cannot be a custom agent's: not an agent's name, or a built-in's id, by which agents start a built-in. */
function nameProblem(name: string, builtIns: ReadonlySet<string>): string | undefined {
	if (builtIns.has(name)) {
		return `${name} is a built-in's id, by which agents start it: give the custom agent another name`;
	}
	try {
		return agentName(name) === name ? undefined : `"${name}" is not a name as an agent's is`;
	} catch (err) {
		return messageOf(err);
	}
}

/**
 * The person's timeout, `facade.agents.timeout`: how long Facade waits for a new agent to come up, for an
 * agent's process to end once stopped, an agent's MCP server for the window - as it starts, and through a
 * reload - and a window that reloads for the pipe its running agents call.
 */
export function timeoutMs(): number {
	return secondsSetting(vscode.workspace.getConfiguration('facade.agents').get('timeout'), START_TIMEOUT_MS);
}

/**
 * The person's YOLO, `facade.agents.yolo`, for the next agent they start: on by default. Throws, naming the
 * setting, where it holds neither true nor false: Facade never takes its own value for one the person got
 * wrong.
 */
export function yolo(): boolean {
	const value = vscode.workspace.getConfiguration('facade.agents').get<unknown>('yolo');
	if (value !== undefined && typeof value !== 'boolean') {
		throw new Error(`facade.agents.yolo is ${JSON.stringify(value)}, which is neither true nor false`);
	}
	return value ?? true;
}

/** Whether the agent framework is on: `facade.orchestration.enabled`, on by default. */
export function frameworkOn(): boolean {
	return vscode.workspace.getConfiguration().get<unknown>(FRAMEWORK_SETTING) !== false;
}
