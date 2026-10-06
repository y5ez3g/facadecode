/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentCli, CliConfig } from '../clis/cli';
import { readCliConfig, secondsSetting } from '../clis/config';
import { START_TIMEOUT_MS } from '../core/launch';

/**
 * How the person has Facade start a CLI: its settings, `facade.orchestration.<section>.*`, as the window
 * has them now.
 */
export function configFor(cli: AgentCli): CliConfig {
	const settings = vscode.workspace.getConfiguration(`facade.orchestration.${cli.section}`);
	return readCliConfig(cli, name => settings.get(name));
}

/**
 * The person's timeout, `facade.orchestration.timeout`: how long Facade waits for a new agent to come
 * up, an agent's MCP server for the window - as it starts, and through a reload - and a window that
 * reloads for the pipe its running agents call.
 */
export function timeoutMs(): number {
	return secondsSetting(vscode.workspace.getConfiguration('facade.orchestration').get('timeout'), START_TIMEOUT_MS);
}
