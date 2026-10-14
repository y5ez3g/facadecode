/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isJsonObject } from '../base/json';
import { AgentCli, CliConfig } from '../clis/cli';
import { readCliConfig, readSeconds } from '../clis/config';
import { CUSTOM_AGENTS_SETTING, CustomAgent, customAgentOf } from '../clis/custom';
import { knownClis } from '../clis/registry';
import { customAgentNameProblem, START_TIMEOUT_MS } from '../core/launch';

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
	return Object.entries(value).map(([name, entry]) => customAgentOf(name, entry, customAgentNameProblem(name, builtIns)));
}

/**
 * The person's timeout, `facade.agents.timeout`: how long Facade waits for a new agent to come up, for an
 * agent's process to end once stopped, an agent's MCP server for the window - as it starts, and through a
 * reload - and a window that reloads for the pipe its running agents call.
 */
export function timeoutMs(): number {
	return readSeconds('facade.agents.timeout', vscode.workspace.getConfiguration('facade.agents').get<unknown>('timeout'), START_TIMEOUT_MS).ms;
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

/** Whether the agent framework is on: `facade.orchestration.enabled`, on by default - and where it holds neither true nor false. */
export function frameworkOn(): boolean {
	return vscode.workspace.getConfiguration().get<unknown>(FRAMEWORK_SETTING) !== false;
}

/**
 * What is wrong in the person's settings that hold for every agent - the agent framework's switch, the
 * timeout - and what Facade uses instead, each naming the setting: never a value taken without saying so
 * (AGENT-LAUNCHER.md, L5; X-59).
 */
export function settingsProblems(): string[] {
	const problems: string[] = [];
	const framework = vscode.workspace.getConfiguration().get<unknown>(FRAMEWORK_SETTING);
	if (framework !== undefined && typeof framework !== 'boolean') {
		problems.push(`${FRAMEWORK_SETTING} is ${JSON.stringify(framework)}, which is neither true nor false: on, its default, is used`);
	}
	const timeout = readSeconds('facade.agents.timeout', vscode.workspace.getConfiguration('facade.agents').get<unknown>('timeout'), START_TIMEOUT_MS);
	if (timeout.wrong) {
		problems.push(timeout.wrong);
	}
	return problems;
}
