/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The product icons Facade's workbench registers for the built-in agents' logos, by their CLIs' ids: those its agent
 * menu and their terminals' tabs show (`terminalLaunchers.ts`, `AGENT_ICONS`).
 */
const BUILT_IN_ICONS: ReadonlyMap<string, string> = new Map([
	['claude', 'agent-claude'],
	['codex', 'agent-codex'],
	['agy', 'agent-antigravity'],
	['muse', 'agent-muse']
]);

/** The codicon of every custom agent, whatever program it runs (AGENT-LAUNCHER.md, L3). */
const CUSTOM_AGENT_ICON = 'robot';

/**
 * The id of the icon an agent is shown with, as the agent menu shows it: a built-in's logo, by its CLI's id; the robot
 * for a custom agent, or a built-in the workbench has no logo of.
 */
export function agentIconId(id: string, custom: boolean): string {
	return (!custom && BUILT_IN_ICONS.get(id)) || CUSTOM_AGENT_ICON;
}
