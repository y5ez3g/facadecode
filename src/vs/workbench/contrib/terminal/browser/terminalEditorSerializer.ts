/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNumber, isObject } from '../../../../base/common/types.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TitleEventSource } from '../../../../platform/terminal/common/terminal.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ISerializedTerminalEditorInput, ITerminalEditorService, ITerminalInstance, type IDeserializedTerminalEditorInput } from './terminal.js';
import { TerminalEditorInput } from './terminalEditorInput.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { isAgentGoneAtStartup } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { AGENT_RECORD_STORAGE_KEY, agentRestoreDeferred, isFacadeRunTerminal } from '../../facadeCommands/common/facadeRun.js';

export class TerminalInputSerializer implements IEditorSerializer {
	constructor(
		@ITerminalEditorService private readonly _terminalEditorService: ITerminalEditorService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService
	) { }

	public canSerialize(editorInput: TerminalEditorInput): editorInput is TerminalEditorInput & { readonly terminalInstance: ITerminalInstance } {
		// Facade Code: an agent's tab too when its terminal is not kept - persistent sessions off - written as one that
		// never comes back (`notKept`). Left out, the floating window it was alone in would be saved empty, as New
		// Empty Editor Window makes one, and come back so: D10 closes only a window saved holding tabs that came back
		// with none (N-88)
		const instance = editorInput.terminalInstance;
		return !!instance && (instance.shouldPersist ? isNumber(instance.persistentProcessId) : isFacadeRunTerminal(instance));
	}

	public serialize(editorInput: TerminalEditorInput): string | undefined {
		if (!this.canSerialize(editorInput)) {
			return;
		}
		const instance = editorInput.terminalInstance;
		const written: ISerializedTerminalEditorInput = instance.shouldPersist ? this._toJson(instance) : { ...this._toJson(instance), id: instance.persistentProcessId ?? -1, notKept: true };
		return JSON.stringify(written);
	}

	public deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		const editorInput = JSON.parse(serializedEditorInput) as unknown;
		if (!isDeserializedTerminalEditorInput(editorInput)) {
			throw new Error(`Could not revive terminal editor input, ${editorInput}`);
		}
		// Facade Code: an agent's tab that is gone after the app restarted is not brought back, rather
		// than brought back and closed, which would flash it (`isAgentGoneAtStartup`). ⚠️ Later in the
		// session too, deliberately: what deserializes then is above all a folder's working set, and an
		// agent tab in one was closed - its agent with it - when the window left that folder. Nor one
		// whose terminal was not kept: its agent ended with the window (`notKept`, N-88)
		if (editorInput.notKept || isAgentGoneAtStartup(editorInput, this._lifecycleService)) {
			return undefined;
		}
		// Facade Code: on a remote, an agent's tab of a record not this window's - or none told yet - is left
		// out, for the take-back: no tab for another window's agent, attached or saying it is elsewhere (RM-20)
		if (agentRestoreDeferred(editorInput, this._storageService.get(AGENT_RECORD_STORAGE_KEY, StorageScope.WORKSPACE), this._environmentService.remoteAuthority)) {
			return undefined;
		}
		return this._terminalEditorService.reviveInput(editorInput);
	}

	private _toJson(instance: ITerminalInstance): ISerializedTerminalEditorInput {
		// Facade Code: the title kept as the pty host keeps it (`TerminalService._updateTitle`): the person's name as
		// itself, a sequence's title as the sequence - not the label made from it, which coming back would get its
		// template's additions a second time: `Fix it - @codex #a3 - @codex #a3` (N-03)
		const title = instance.staticTitle ?? (instance.titleSource === TitleEventSource.Sequence && instance.sequence ? instance.sequence : instance.title);
		return {
			id: instance.persistentProcessId!,
			pid: instance.processId || 0,
			title,
			titleSource: instance.staticTitle ? TitleEventSource.Api : instance.titleSource,
			cwd: '',
			icon: instance.icon,
			color: instance.color,
			hasChildProcesses: instance.hasChildProcesses,
			isFeatureTerminal: instance.shellLaunchConfig.isFeatureTerminal,
			hideFromUser: instance.shellLaunchConfig.hideFromUser,
			// Facade Code: wherever it was given - a terminal a reload brought back has it in what it attached to, and
			// lost it at the next reload: an agent's tab then no longer known as its run's (N-25)
			reconnectionProperties: instance.reconnectionProperties,
			shellIntegrationNonce: instance.shellIntegrationNonce
		};
	}
}

function isDeserializedTerminalEditorInput(obj: unknown): obj is IDeserializedTerminalEditorInput {
	return isObject(obj) && 'id' in obj && 'pid' in obj;
}
