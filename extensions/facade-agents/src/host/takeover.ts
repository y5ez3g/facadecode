/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { isProcessRunning, ProcessIdentity, processStartTime } from '../base/system';
import { holderStartedLater, LedgerTakeoverError, liveHolderOf, takeoverLedgerLock } from '../record/ledger';
import { readWindowRecord } from '../transport/endpoint';
import { PipeClient } from '../transport/pipe';

/** How long this window's earlier extension host has to answer `/release` before its process is ended instead (REMOTE.md R4). */
export const RELEASE_ASK_MS = 3_000;
/** How long an earlier extension host that answered `/release` has to record what is under way and close before its process is ended (REMOTE.md R4). */
export const RELEASE_CLOSE_MS = 5_000;
/** How long an earlier extension host that cannot be asked - no pipe, refused, cut off - has to close, the handover wait from before it is ended (REMOTE.md R4). */
export const TAKEOVER_HANDOVER_MS = 10_000;

/** What taking over from this window's earlier extension host needs of its world. */
export interface TakeoverPorts {
	/** Tells the person, and the log. */
	info(message: string): void;
	warn(message: string): void;
	/** Whether the service stopped meanwhile: no more waiting then. */
	stopped?: () => boolean;
	/** Whether `pid` runs; the processes unless told. */
	isRunning?: (pid: number) => boolean;
	/** What ends `pid` with `signal`; the processes unless told. */
	kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
	/** What `pid` runs; the processes unless told. */
	identify?: (pid: number) => ProcessIdentity | undefined;
	/** Asks `/release` through `pipe` with `secret`; a pipe client unless told. */
	askRelease?: (pipe: string, secret: string, signal: AbortSignal) => Promise<void>;
	/** How long `/release` has to answer, an answer has to close, and the unaskable has to close: 3, 5 and 10 seconds, unless told. */
	askMs?: number;
	closeMs?: number;
	handoverMs?: number;
	/** How often the lock is looked at while waited for: 250 ms, unless told. */
	pollMs?: number;
	/** When this host started, in milliseconds: a holder that started later is left alone - now minus this process's uptime, unless told. */
	startedAt?: number;
}

/**
 * How taking over from this window's earlier extension host came out: the lock is this window's to
 * take - or this stale host gives up, its holder newer, quietly, telling nobody of another window (L5).
 */
export type TakeoverOutcome = 'taken' | 'newer-holder' | 'failed';

/**
 * Takes over from this window's earlier extension host, whose process `holder` holds the ledger's
 * lock in `dir`: asked through its pipe to let go; one that answers is waited for only as long as it
 * takes to record what is under way and close, one that cannot be asked - no pipe, refused, cut off -
 * the handover wait, as it is usually already closing, and one that answers nothing in time is ended
 * at once; one that still holds after its wait is ended - checked first to be an extension host of
 * this server. Only from a holder that started earlier than this host: a newer holder is given up to
 * at once - no ask, no wait, no kill (L5). 'taken' where the lock is this window's to take now
 * (REMOTE.md R4).
 */
export async function releaseEarlierHost(dir: string, holder: number, owner: string, ports: TakeoverPorts): Promise<TakeoverOutcome> {
	const ours = { at: ports.startedAt ?? processStartTime(), pid: process.pid };
	const live = liveHolderOf(dir, ports.isRunning ?? isProcessRunning);
	if (live !== undefined && live.pid === holder && holderStartedLater({ at: live.startedAt, pid: live.pid }, ours)) {
		return 'newer-holder';
	}
	const window = readWindowRecord(dir);
	let answered = false;
	let timedOut = false;
	if (window?.release !== undefined) {
		const asking = new AbortController();
		const askRelease = ports.askRelease ?? ((pipe, secret, signal) => new PipeClient(pipe, secret).release(ours.at, signal).then(() => { }));
		const unanswered = setTimeout(() => { timedOut = true; asking.abort(); }, ports.askMs ?? RELEASE_ASK_MS);
		try {
			await askRelease(window.pipe, window.release, asking.signal);
			answered = true;
			ports.info(`This window's earlier extension host (process ${holder}) is letting go of the workspace's agents.`);
		} catch (err) {
			if (timedOut) {
				ports.warn(`This window's earlier extension host (process ${holder}) did not answer letting go in time (${messageOf(err)}). Ending its process.`);
			} else {
				ports.info(`This window's earlier extension host (process ${holder}) could not be asked to let go (${messageOf(err)}). Waiting for it to close.`);
			}
		} finally {
			clearTimeout(unanswered);
		}
	} else {
		ports.info(`This window's earlier extension host (process ${holder}) names no release; waiting for it to close.`);
	}
	if (answered) {
		if (await lockLetGo(dir, holder, ports.closeMs ?? RELEASE_CLOSE_MS, ports)) {
			return 'taken';
		}
	} else if (!timedOut) {
		if (await lockLetGo(dir, holder, ports.handoverMs ?? TAKEOVER_HANDOVER_MS, ports)) {
			return 'taken';
		}
	}
	if (ports.stopped?.() ?? false) {
		// Stopped meanwhile: its end is another's to see to - nothing is ended here.
		return 'failed';
	}
	if (answered) {
		ports.warn(`This window's earlier extension host (process ${holder}) answered letting go but still holds the lock. Ending its process.`);
	} else if (!timedOut) {
		ports.warn(`This window's earlier extension host (process ${holder}) did not let go of the lock. Ending its process.`);
	}
	try {
		await takeoverLedgerLock(dir, holder, owner, {
			...(ports.isRunning !== undefined ? { isRunning: ports.isRunning } : {}),
			...(ports.kill !== undefined ? { kill: ports.kill } : {}),
			...(ports.identify !== undefined ? { identify: ports.identify } : {}),
			...(ports.startedAt !== undefined ? { startedAt: ports.startedAt } : {}),
		});
		return 'taken';
	} catch (err) {
		if (err instanceof LedgerTakeoverError && err.why === 'moved-on') {
			return 'taken';
		}
		if (err instanceof LedgerTakeoverError && err.why === 'newer-holder') {
			// Newer than this host after all - asked before it was known, or moved meanwhile: given up to, quietly
			return 'newer-holder';
		}
		ports.warn(err instanceof LedgerTakeoverError ? err.message : messageOf(err));
		return 'failed';
	}
}

/** Whether `holder` lets go of the lock in `dir` - closes, or is gone - within `ms`. */
async function lockLetGo(dir: string, holder: number, ms: number, ports: TakeoverPorts): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (; ;) {
		const live = liveHolderOf(dir, ports.isRunning ?? isProcessRunning);
		if (live === undefined || live.pid !== holder) {
			return true;
		}
		if ((ports.stopped?.() ?? false) || Date.now() >= deadline) {
			return false;
		}
		await timeout(ports.pollMs ?? 250);
	}
}
