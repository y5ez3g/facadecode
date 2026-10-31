/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's identifiers (PANEL-1.1, UX-3): every command has one `facade.` ID; `package.json` contributes the same set.

/** The panel's one webview view, in the activity-bar container `facade` (PANEL-1.1). */
export const PANEL_VIEW = 'facade.agents';

/** The public commands of UX-3.1 and the context-only ones of UX-3.2. */
export const COMMANDS = {
	newAgent: 'facade.newAgent',
	showActiveAgents: 'facade.showActiveAgents',
	renameAgent: 'facade.renameAgent',
	copyAgentReference: 'facade.copyAgentReference',
	closeAgent: 'facade.closeAgent',
	filter: 'facade.filter',
	clearFilter: 'facade.clearFilter',
	configureAgents: 'facade.configureAgents',
	/** Registered by the host, which has the CLIs' launch and the agents log (CLIS-4.1, ARCHITECTURE-3.3). */
	showAgentLaunch: 'facade.showAgentLaunch',
	showAgentsLog: 'facade.showAgentsLog',
	newWorktree: 'facade.newWorktree',
	moveUp: 'facade.moveUp',
	moveDown: 'facade.moveDown',
	filterByLocation: 'facade.filterByLocation',
	filterByFolder: 'facade.filterByFolder',
	/** Filter by Working Location as its title button shows it while a filter is on: filled (UX-3.2). */
	filterOn: 'facade.filterOn',
	revealAgent: 'facade.revealAgent'
} as const;

/** Commands the integration suite's build alone registers (UX-3.2): never in the manifest or the shipped bundle. */
export const TEST_COMMANDS = {
	state: 'facade.state',
	selectRow: 'facade.selectRow',
	probe: 'facade.probe'
} as const;

/** Context keys from the panel's state (UX-3.2). */
export const CONTEXT = {
	hasAgents: 'facade.hasAgents',
	agentSelected: 'facade.agentSelected',
	agentSelectedEnded: 'facade.agentSelectedEnded',
	filtered: 'facade.filtered'
} as const;

/** Where Configure Agents goes: the Settings editor showing this extension's settings alone, in the execution environment (CLIS-1.1). */
export const AGENT_SETTINGS = '@ext:facade.facadecode';
