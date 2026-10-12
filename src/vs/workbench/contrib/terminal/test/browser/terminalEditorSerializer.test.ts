/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IReconnectionProperties, TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ILifecycleService, ShutdownReason, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { facadeRunProperties } from '../../../facadeCommands/common/facadeRun.js';
import { AGENT_TERMINAL_ICON } from '../../../terminalLaunchers/common/terminalLaunchers.js';
import { IDeserializedTerminalEditorInput, ISerializedTerminalEditorInput, ITerminalEditorService, ITerminalInstance } from '../../browser/terminal.js';
import { TerminalEditorInput } from '../../browser/terminalEditorInput.js';
import { TerminalInputSerializer } from '../../browser/terminalEditorSerializer.js';

/** The tab a terminal came back as, standing in for the terminal editor's own. */
class TestTerminalTab extends EditorInput {
	override readonly typeId = 'test.terminalTab';
	override readonly resource = undefined;
}

suite('Terminal editor serializer - bringing a terminal tab back', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Whether a tab drawn with `icon` - and marked as an agent's run, with `reconnectionProperties` - comes back as
	 * the window starts the way `kind` says, its workspace's last shutdown having been `last` - none, after a crash.
	 */
	function comesBack(kind: StartupKind, last: ShutdownReason | undefined, icon: TerminalIcon | undefined, reconnectionProperties?: IReconnectionProperties): boolean {
		const serializer = new TerminalInputSerializer(
			new class extends mock<ITerminalEditorService>() {
				override reviveInput(_input: IDeserializedTerminalEditorInput): EditorInput {
					return store.add(new TestTerminalTab());
				}
			},
			new class extends mock<ILifecycleService>() {
				override readonly startupKind = kind;
				override readonly lastShutdownReason = last;
			}
		);
		const tab: ISerializedTerminalEditorInput = { id: 7, pid: 1, title: 'Claude Code', titleSource: TitleEventSource.Process, cwd: '', icon, color: undefined, reconnectionProperties, shellIntegrationNonce: '' };

		return !!serializer.deserialize(new class extends mock<IInstantiationService>() { }, JSON.stringify(tab));
	}

	test('a tab a reload brought back is written with its run mark and its title as kept, not the label made from it - so the next reload still knows the agent\'s run, and adds no second suffix (N-25, N-03)', () => {
		const serializer = new TerminalInputSerializer(new class extends mock<ITerminalEditorService>() { }, new class extends mock<ILifecycleService>() { });
		const run = facadeRunProperties({ workspace: 'w', id: 3 });
		const written = (instance: Partial<ITerminalInstance>) => {
			const text = serializer.serialize(upcastPartial<TerminalEditorInput>({ terminalInstance: upcastPartial<ITerminalInstance>({ persistentProcessId: 8, processId: 41, shouldPersist: true, icon: AGENT_TERMINAL_ICON, shellIntegrationNonce: 'n', ...instance }) }));
			const { title, titleSource, reconnectionProperties } = JSON.parse(text ?? '{}');
			return { title, titleSource, reconnectionProperties };
		};

		assert.deepStrictEqual({
			broughtBack: written({ shellLaunchConfig: { attachPersistentProcess: { id: 8, pid: 41, title: 'Fix it', titleSource: TitleEventSource.Sequence, cwd: '', reconnectionProperties: run, shellIntegrationNonce: 'n' } }, reconnectionProperties: run, title: 'Fix it - @codex #a3', titleSource: TitleEventSource.Sequence, sequence: 'Fix it' }),
			renamed: written({ shellLaunchConfig: { reconnectionProperties: run }, reconnectionProperties: run, title: 'mine - @codex #a3', titleSource: TitleEventSource.Api, staticTitle: 'mine' })
		}, {
			broughtBack: { title: 'Fix it', titleSource: TitleEventSource.Sequence, reconnectionProperties: run },
			renamed: { title: 'mine', titleSource: TitleEventSource.Api, reconnectionProperties: run }
		});
	});

	test('an agent tab - its run\'s, by its mark - comes back after a reload, which finds the agent running, and after a crash, whose new window finds it running too - not once its window was closed, the app quit, or the window left for another workspace; whatever its icon: a run repainted is a run, and an ordinary terminal the person gave the robot comes back as any other (N-49, N-78; NI-06)', () => {
		const run = facadeRunProperties({ workspace: 'w', id: 1 });
		assert.deepStrictEqual({
			agentAfterReload: comesBack(StartupKind.ReloadedWindow, ShutdownReason.RELOAD, AGENT_TERMINAL_ICON, run),
			agentAfterCrash: comesBack(StartupKind.NewWindow, undefined, AGENT_TERMINAL_ICON, run),
			agentAfterQuit: comesBack(StartupKind.NewWindow, ShutdownReason.QUIT, AGENT_TERMINAL_ICON, run),
			agentAfterClose: comesBack(StartupKind.NewWindow, ShutdownReason.CLOSE, AGENT_TERMINAL_ICON, run),
			agentInAReopenedWindow: comesBack(StartupKind.ReopenedWindow, ShutdownReason.LOAD, AGENT_TERMINAL_ICON, run),
			shellAfterQuit: comesBack(StartupKind.NewWindow, ShutdownReason.QUIT, Codicon.terminal),
			robotShellAfterQuit: comesBack(StartupKind.NewWindow, ShutdownReason.QUIT, AGENT_TERMINAL_ICON),
			repaintedRunAfterReload: comesBack(StartupKind.ReloadedWindow, ShutdownReason.RELOAD, Codicon.terminal, run),
			repaintedRunAfterCrash: comesBack(StartupKind.NewWindow, undefined, Codicon.terminal, run),
			repaintedRunAfterQuit: comesBack(StartupKind.NewWindow, ShutdownReason.QUIT, Codicon.terminal, run),
		}, {
			agentAfterReload: true,
			agentAfterCrash: true,
			agentAfterQuit: false,
			agentAfterClose: false,
			agentInAReopenedWindow: false,
			shellAfterQuit: true,
			robotShellAfterQuit: true,
			repaintedRunAfterReload: true,
			repaintedRunAfterCrash: true,
			repaintedRunAfterQuit: false,
		});
	});

	test('an agent\'s tab whose terminal is not kept - persistent sessions off - is written, as one that never comes back, even after a reload: the floating window saved holding it is then known to have come back emptied; an ordinary terminal not kept is not written, as upstream (N-88, D10)', () => {
		const serializer = new TerminalInputSerializer(
			new class extends mock<ITerminalEditorService>() {
				override reviveInput(_input: IDeserializedTerminalEditorInput): EditorInput {
					return store.add(new TestTerminalTab());
				}
			},
			new class extends mock<ILifecycleService>() {
				override readonly startupKind = StartupKind.ReloadedWindow;
				override readonly lastShutdownReason = ShutdownReason.RELOAD;
			}
		);
		const written = (instance: Partial<ITerminalInstance>) => serializer.serialize(upcastPartial<TerminalEditorInput>({ terminalInstance: upcastPartial<ITerminalInstance>({ persistentProcessId: 9, processId: 42, shouldPersist: false, icon: AGENT_TERMINAL_ICON, shellLaunchConfig: {}, title: 'Claude Code', titleSource: TitleEventSource.Process, shellIntegrationNonce: 'n', ...instance }) }));
		const agentTab = written({ reconnectionProperties: facadeRunProperties({ workspace: 'w', id: 2 }) });

		assert.deepStrictEqual({
			agentWritten: agentTab !== undefined,
			agentComesBack: agentTab !== undefined && !!serializer.deserialize(new class extends mock<IInstantiationService>() { }, agentTab),
			shellWritten: written({}) !== undefined
		}, {
			agentWritten: true,
			agentComesBack: false,
			shellWritten: false
		});
	});
});
