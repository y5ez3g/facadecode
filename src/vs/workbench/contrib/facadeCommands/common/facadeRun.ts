/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { isNumber, isObject, isString } from '../../../../base/common/types.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { FACADE_RUN_OWNER, IReconnectionProperties } from '../../../../platform/terminal/common/terminal.js';

/** An agent's run: the record of its workspace, by the record's id, and the agent's number in that record. */
export interface IFacadeRun {
	readonly workspace: string;
	readonly id: number;
}

/** Whether `candidate` is an `IFacadeRun`: a record's id, and a number from 1 up. */
export function isFacadeRun(candidate: unknown): candidate is IFacadeRun {
	if (!isObject(candidate)) {
		return false;
	}

	const { workspace, id } = candidate as Record<string, unknown>;
	return isString(workspace) && !!workspace && isNumber(id) && Number.isInteger(id) && id > 0;
}

/**
 * An agent the agents' extension says is live that has no terminal yet: its worktree being made, or its setup running
 * (AGENT-ORCHESTRATION.md, O4) - counted on the agent button and listed among the active agents (AGENT-LAUNCHER.md, L3).
 */
export interface IPreparingRun {
	/** Its number in the record: the agent's `N` in `@name #aN`. */
	readonly id: number;
	/** Its name, as `@name #aN` writes it, without the `@`. */
	readonly name: string;
	/** What it is doing: making its worktree, or running the worktree's setup. */
	readonly phase: 'creating_worktree' | 'running_setup';
	/** Its worktree, once made. */
	readonly folder?: string;
}

/** Whether `candidate` is an `IPreparingRun`. */
export function isPreparingRun(candidate: unknown): candidate is IPreparingRun {
	if (!isObject(candidate)) {
		return false;
	}

	const { id, name, phase, folder } = candidate as Record<string, unknown>;
	return isNumber(id) && Number.isInteger(id) && id > 0 && isString(name) && (phase === 'creating_worktree' || phase === 'running_setup') && (folder === undefined || isString(folder));
}

/** The reconnection properties that mark a terminal as made for `run`. */
export function facadeRunProperties(run: IFacadeRun, opened?: IFacadeRunTerminal): IReconnectionProperties {
	return { ownerId: FACADE_RUN_OWNER, data: { workspace: run.workspace, id: run.id, ...(opened?.name ? { name: opened.name } : {}), ...(opened?.folder ? { folder: opened.folder } : {}), ...(opened?.finalScreen ? { finalScreen: opened.finalScreen } : {}) } };
}

/**
 * What a run's terminal was opened with, kept with its mark: its name - `@name #aN` - and the folder it is
 * for, so that a terminal taken back for its process after the window crashed reads and is held as it was,
 * not by where the process went since (X-31); and the file its final screen goes to, so that one given back
 * after a reload keeps it before the agents' extension registers it again (AGENT-DEBUGGING.md, D6; DB-05).
 */
export interface IFacadeRunTerminal {
	readonly name?: string;
	/** The folder it is for, as a URI's string (REMOTE.md R7); a mark from before keeps a path spelled for the window's OS. */
	readonly folder?: string;
	/** The final screen's file, as a URI's string. */
	readonly finalScreen?: string;
}

/** What `terminal`'s run's terminal was opened with, as its mark keeps it; undefined for no run's, or one marked before it was kept. */
export function facadeRunTerminalOf(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): IFacadeRunTerminal | undefined {
	if (!facadeRunOf(terminal)) {
		return undefined;
	}
	const { name, folder, finalScreen } = terminal?.reconnectionProperties?.data as Record<string, unknown>;
	return isString(name) || isString(folder) || isString(finalScreen) ? { ...(isString(name) ? { name } : {}), ...(isString(folder) ? { folder } : {}), ...(isString(finalScreen) ? { finalScreen } : {}) } : undefined;
}

/** The run a terminal - or a process the pty host holds - was made for, by its mark; undefined for any other. */
export function facadeRunOf(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): IFacadeRun | undefined {
	const properties = terminal?.reconnectionProperties;
	return properties?.ownerId === FACADE_RUN_OWNER && isFacadeRun(properties.data) ? { workspace: properties.data.workspace, id: properties.data.id } : undefined;
}

/**
 * Whether a terminal is an agent's run's: kept in its window - no Detach Session, no moving into another
 * window - never relaunched, and never revived.
 */
export function isFacadeRunTerminal(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): boolean {
	return facadeRunOf(terminal) !== undefined;
}

/**
 * The window's URI for a run's stored folder: a URI's string the window wrote revived, else a path on
 * the machine at `remoteAuthority` - the window's own with none (REMOTE.md R7). A Windows remote spells
 * a drive (`C:\x`); any other remote's path is already URI-shaped. Old marks hold a path spelled for
 * the window's OS, which revives the same way.
 */
export function runFolderUri(folder: string, remoteAuthority: string | undefined): URI {
	// A URI's string the window wrote, `file://` or `vscode-remote://`: a bare path parses too, as
	// `file`, which is not what it is on a remote
	if (folder.indexOf('://') !== -1) {
		try {
			const revived = URI.parse(folder);
			if (revived.scheme === Schemas.file || revived.scheme === Schemas.vscodeRemote) {
				return revived;
			}
		} catch {
			// Not a URI's string after all: a bare path, below
		}
	}
	if (!remoteAuthority) {
		return URI.file(folder);
	}
	const normalized = folder.replace(/\\/g, '/');
	const drive = /^([a-zA-Z]):\//.exec(normalized);
	const path = drive ? `/${drive[1]}:${normalized.slice(2)}` : normalized.startsWith('/') ? normalized : `/${normalized}`;
	return URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path });
}

/** The window's workspace storage key for its agents-record id, as the agents' extension last said it (`setLive`). */
export const AGENT_RECORD_STORAGE_KEY = 'facade.agents.record';

/**
 * Whether layout restore leaves an agent's terminal out, for the take-back to bring back once the
 * window's record is known: in a remote window, while the record it was told - `record`, remembered
 * from its workspace storage - is none, or another's (REMOTE.md R7; RM-20). Layout restore runs
 * before the agents' extension says the record, and a remote folder's id is its URI's hash, so the
 * pty host hands another computer's agents over with this one's: attaching them then, made or not,
 * is forbidden, and a tab that says the agent is elsewhere is none of this window's either. Left
 * out, an orphan of this window's record is taken back with no tab doubled; one of another's never.
 * A local window restores as it did: its orphans are its own (LA-14).
 */
export function agentRestoreDeferred(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined, record: string | undefined, remoteAuthority: string | undefined): boolean {
	const run = facadeRunOf(terminal);
	return !!remoteAuthority && !!run && run.workspace !== record;
}

/**
 * Whether the agents' extension still wants the window operation with `ticket` done
 * (`_facade.agents.claimTicket`): claimed at the moment the window would act - as input leaves the
 * queue to be written, before a terminal is made or ended, before a screen is read. Refused where the
 * extension says no - its caller was already told the operation was not done - where there is no
 * ticket to claim, or where the extension cannot be asked (REMOTE.md R4, R7).
 */
export async function claimTicket(commands: ICommandService, ticket: unknown): Promise<boolean> {
	if (!isString(ticket) || !ticket) {
		return false;
	}
	try {
		const answer = await commands.executeCommand<unknown>('_facade.agents.claimTicket', ticket);
		return isObject(answer) && (answer as Record<string, unknown>).granted === true;
	} catch {
		return false;
	}
}

/** The answer {@link agentRecordForAttach} gives, and which registration gave it. */
let attaching: { readonly record: string | undefined } | undefined;

/**
 * The window's agents-record id - what the agents' extension says this window's record is - for deciding
 * whether an attaching terminal's agent process belongs to this window (REMOTE.md R7); undefined until
 * the extension says, when attaching falls back to how it was.
 */
export function agentRecordForAttach(): string | undefined {
	return attaching?.record;
}

/**
 * Answers {@link agentRecordForAttach} from now on, until disposed. Disposing it clears the answer only
 * while it is still the latest: one set since - the same record again, as the extension says it on each
 * change - stays.
 */
export function setAgentRecordForAttach(record: string | undefined): IDisposable {
	const registration = { record };
	attaching = registration;
	return toDisposable(() => {
		if (attaching === registration) {
			attaching = undefined;
		}
	});
}
