/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's identifiers (PANEL-1.1, UX-3): every command has one `facade.` ID; `package.json` contributes the same set.

/** The panel's one webview view, in the activity-bar container `facade` (PANEL-1.1). */
export const PANEL_VIEW = 'facade.agents';

/** The public commands of UX-3.1 and the context-only ones of UX-3.2. */
export const COMMANDS = {
	newAgent: 'facade.newAgent',
	history: 'facade.history',
	pinAgent: 'facade.pinAgent',
	unpinAgent: 'facade.unpinAgent',
	showActiveAgents: 'facade.showActiveAgents',
	renameAgent: 'facade.renameAgent',
	closeAgent: 'facade.closeAgent',
	/** The selected card's details, for the keyboard (PANEL-1.5, UX-2.3). */
	showAgentDetails: 'facade.showAgentDetails',
	filter: 'facade.filter',
	/** The editor's Settings at Facade Code's section, whose Edit in facade.json link opens the settings file (CONFIGURATION-1.2). */
	openSettings: 'facade.openSettings',
	/** Registered by the host: the settings file opened, made first where there is none (CONFIGURATION-1.2, 1.3). */
	openSettingsFile: 'facade.openSettingsFile',
	/** Registered by the host, which has the CLIs' launch and the agents log (CLIS-4.1, ARCHITECTURE-3.3). */
	showAgentLaunch: 'facade.showAgentLaunch',
	showAgentsLog: 'facade.showAgentsLog',
	newWorktree: 'facade.newWorktree',
	moveUp: 'facade.moveUp',
	moveDown: 'facade.moveDown',
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
	agentSelectedPinned: 'facade.agentSelectedPinned',
	agentSelectedPinnable: 'facade.agentSelectedPinnable',
	/** The selected agent's card is shown: no filter hides it (PANEL-2.3). */
	agentSelectedVisible: 'facade.agentSelectedVisible',
	filtered: 'facade.filtered',
	/** The window's one place to work holds every agent: there is no location to filter by (PANEL-2.3). */
	onePlace: 'facade.onePlace'
} as const;
