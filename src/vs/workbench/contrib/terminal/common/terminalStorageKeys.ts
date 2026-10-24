/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum TerminalStorageKeys {
	SuggestedRendererType = 'terminal.integrated.suggestedRendererType',
	TabsListWidthHorizontal = 'tabs-list-width-horizontal',
	TabsListWidthVertical = 'tabs-list-width-vertical',
	TabsShowDetailed = 'terminal.integrated.tabs.showDetailed',
	DeprecatedEnvironmentVariableCollections = 'terminal.integrated.environmentVariableCollections',
	EnvironmentVariableCollections = 'terminal.integrated.environmentVariableCollectionsV2',
	TerminalBufferState = 'terminal.integrated.bufferState',
	TerminalLayoutInfo = 'terminal.integrated.layoutInfo',
	// Facade Code: a remote window's layout, carried across the reload that enters a workspace (`TerminalService`)
	CarriedLayoutInfo = 'terminal.integrated.carriedLayoutInfo',
	PinnedRecentCommandsPrefix = 'terminal.pinnedRecentCommands',
	TerminalSuggestSize = 'terminal.integrated.suggestSize',
}
