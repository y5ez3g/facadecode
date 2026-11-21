/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DaemonOperations, DaemonTopics } from '../../base/coreProtocol';
import type { RustPin } from '../../core/ports';

type AgentInfo = DaemonOperations['agent.inspect']['result']['agent'];
type AgentRemoval = Extract<DaemonTopics['agents']['change'], { kind: 'removed' }>['cause'];
type PinRecord = { readonly agent: AgentInfo } | { readonly removal: AgentRemoval };

export interface PinRestoreDeps {
	/** Returns the running machine's record or a confirmed reason for removal. */
	lookup(pin: RustPin): Promise<PinRecord>;
	resumeExisting(agent: AgentInfo): Promise<AgentInfo>;
	resumeSession(pin: RustPin): Promise<AgentInfo>;
	opened(pin: RustPin, agent: AgentInfo): Promise<void>;
	removed(pin: RustPin): void;
	expired(pin: RustPin): void;
	failed(pin: RustPin, error: unknown): void;
	isMissingSession(error: unknown): boolean;
}

/** Restore Pins in saved order, once each, using the running machine's facts (RULES-6.4). */
export async function restoreRustPins(pins: readonly RustPin[], deps: PinRestoreDeps): Promise<void> {
	for (const pin of pins) {
		let result: PinRecord;
		try {
			result = await deps.lookup(pin);
		} catch (error) {
			deps.failed(pin, error);
			continue;
		}
		if ('removal' in result && result.removal === 'removed') {
			deps.removed(pin);
			continue;
		}
		let record: AgentInfo;
		try {
			if ('removal' in result) {
				record = await deps.resumeSession(pin);
			} else {
				record = result.agent.process === 'running' ? result.agent : await deps.resumeExisting(result.agent);
			}
		} catch (error) {
			if (deps.isMissingSession(error)) {
				deps.expired(pin);
			} else {
				deps.failed(pin, error);
			}
			continue;
		}
		try {
			await deps.opened(pin, record);
		} catch (error) {
			deps.failed(pin, error);
		}
	}
}
