/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import type { AgentRef } from '../base/frameworkProtocol';
import type { WindowIdentity } from '../base/windowIdentity';
import { codeOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import type { FrameworkPin, Pin } from '../core/ports';
import { isPin } from './pins';

export const LEGACY_STATE_FILE = 'workspace-state.json';

export type LegacySessionPin = Pin & { readonly agent?: undefined; readonly machine_id?: undefined };

export interface LegacyPinInput {
	readonly pins: readonly Pin[];
	readonly unrecognized: readonly unknown[];
}

export interface LegacyPredecessor {
	readonly owner: string;
	readonly window?: WindowIdentity;
}

export interface LegacyResumeTarget {
	readonly reference: AgentRef;
	readonly startedAt: string;
}

export interface LegacyResumeAttempt extends LegacyResumeTarget {
	readonly requestedAt: number;
}

export interface SharedPinRecovery {
	begin(target?: LegacyResumeTarget): Promise<void>;
	refused(): Promise<void>;
}

export type LegacyPinOutcome = { readonly kind: 'deferred' } | { readonly kind: 'unconfirmed' }
	| { readonly kind: 'confirmed'; readonly reference: AgentRef };

export interface LegacyPinMigration {
	snapshot(): LegacyPinInput | undefined;
	recover(pin: LegacySessionPin, previousAttempt: () => { readonly attempted: boolean; readonly reference?: AgentRef },
		perform: (reservation: SharedPinRecovery) => Promise<AgentRef>,
		reconcile?: (attempt: LegacyResumeAttempt) => Promise<AgentRef | undefined>,
		reconcilePrevious?: (reference: AgentRef) => Promise<AgentRef | undefined>): Promise<LegacyPinOutcome>;
}

export interface LegacyMigrationSource {
	readonly predecessor?: LegacyPredecessor;
	readonly pins: (owner: string) => LegacyPinMigration;
}

export function isFrameworkPin(value: unknown): value is FrameworkPin {
	return isPin(value) && value.agent !== undefined && value.machine_id !== undefined;
}

export function isLegacySessionPin(value: unknown): value is LegacySessionPin {
	return isPin(value) && value.agent === undefined && value.machine_id === undefined;
}

export function isLegacyWorkspaceKey(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

export function legacyStateFile(home: string, owner: string): string {
	return path.join(home, 'workspaces', owner, LEGACY_STATE_FILE);
}

/** Only a committed sidecar can establish saved Pin intent across editor hosts. */
export function readLegacyPins(file: string | undefined): LegacyPinInput | undefined {
	if (!file) { return undefined; }
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		if (codeOf(error) === 'ENOENT') { return undefined; }
		throw error;
	}
	if (!isJsonObject(value)) {
		throw new Error(`Invalid Facade Code Extension workspace state: ${file}`);
	}
	const saved = value['facade.pins'];
	if (!Array.isArray(saved)) {
		return { pins: [], unrecognized: saved === undefined ? [] : [saved] };
	}
	const pins: Pin[] = [];
	const unrecognized: unknown[] = [];
	// Preserve the unsupported input while recovering only the recognized Pin format (ARCHITECTURE-4.2).
	for (const pin of saved) {
		if (isPin(pin)) { pins.push(pin); }
		else { unrecognized.push(pin); }
	}
	return { pins, unrecognized };
}
