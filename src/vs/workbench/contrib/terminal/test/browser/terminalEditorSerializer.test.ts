/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ILifecycleService, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { AGENT_TERMINAL_ICON } from '../../../terminalLaunchers/common/terminalLaunchers.js';
import { IDeserializedTerminalEditorInput, ISerializedTerminalEditorInput, ITerminalEditorService } from '../../browser/terminal.js';
import { TerminalInputSerializer } from '../../browser/terminalEditorSerializer.js';

/** The tab a terminal came back as, standing in for the terminal editor's own. */
class TestTerminalTab extends EditorInput {
	override readonly typeId = 'test.terminalTab';
	override readonly resource = undefined;
}

suite('Terminal editor serializer - bringing a terminal tab back', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Whether a tab drawn with `icon` comes back as the window starts the way `kind` says. */
	function comesBack(kind: StartupKind, icon: TerminalIcon | undefined): boolean {
		const serializer = new TerminalInputSerializer(
			new class extends mock<ITerminalEditorService>() {
				override reviveInput(_input: IDeserializedTerminalEditorInput): EditorInput {
					return store.add(new TestTerminalTab());
				}
			},
			new class extends mock<ILifecycleService>() {
				override readonly startupKind = kind;
			}
		);
		const tab: ISerializedTerminalEditorInput = { id: 7, pid: 1, title: 'Claude Code', titleSource: TitleEventSource.Process, cwd: '', icon, color: undefined, shellIntegrationNonce: '' };

		return !!serializer.deserialize(new class extends mock<IInstantiationService>() { }, JSON.stringify(tab));
	}

	test('an agent tab comes back after a reload, which finds the agent running, and not once the app restarted', () => {
		assert.deepStrictEqual({
			agentAfterReload: comesBack(StartupKind.ReloadedWindow, AGENT_TERMINAL_ICON),
			agentAfterRestart: comesBack(StartupKind.NewWindow, AGENT_TERMINAL_ICON),
			agentInAReopenedWindow: comesBack(StartupKind.ReopenedWindow, AGENT_TERMINAL_ICON),
			shellAfterRestart: comesBack(StartupKind.NewWindow, Codicon.terminal),
		}, {
			agentAfterReload: true,
			agentAfterRestart: false,
			agentInAReopenedWindow: false,
			shellAfterRestart: true,
		});
	});
});
