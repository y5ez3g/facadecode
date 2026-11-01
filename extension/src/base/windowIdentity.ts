/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from './json';
import { isOwnerClaim, type OwnerClaim } from './ownership';

/** Public command shared by the workspace and local window components; it is not a palette action. */
export const WINDOW_IDENTITY_COMMAND = 'facade.window.identity';
export const WINDOW_TERMINALS_COMMAND = 'facade.window.terminals';
/** Bounds an abandoned registration; it is not an owner lease or a process lifetime. */
export const TERMINAL_REGISTRATION_MS = 10_000;

/** Plain cross-host registration requests; the actual Terminal stays in its owning extension host. */
export interface TerminalOwner {
	readonly session: string;
	readonly claim: OwnerClaim;
}

export type TerminalRegistration = TerminalOwner & (
	{ readonly kind: 'activate'; readonly handedOver?: boolean }
	| { readonly kind: 'retire'; readonly runs: readonly string[] }
	| { readonly kind: 'begin'; readonly run: string }
	| { readonly kind: 'finish' | 'cancel'; readonly run: string; readonly ticket: string }
);

export function isTerminalRegistration(value: unknown): value is TerminalRegistration {
	if (!isJsonObject(value) || typeof value.session !== 'string' || !isOwnerClaim(value.claim)) {
		return false;
	}
	return (value.kind === 'activate' && (value.handedOver === undefined || typeof value.handedOver === 'boolean'))
		|| (value.kind === 'retire' && Array.isArray(value.runs) && value.runs.every(run => typeof run === 'string' && !!run))
		|| (typeof value.run === 'string' && !!value.run
		&& (value.kind === 'begin' || ((value.kind === 'finish' || value.kind === 'cancel') && typeof value.ticket === 'string' && !!value.ticket)));
}

export interface WindowIdentity {
	readonly version: 1;
	readonly token: string;
	readonly session: string;
	/** The window's remote authority, `ssh-remote+host`, which only the local component sees; none in a local window. */
	readonly remote?: string;
	/** The component's own version, which a remote extension host cannot see, for Copy Diagnostics (ARCHITECTURE-3.3, D116). */
	readonly component?: string;
}

export function isWindowToken(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** A late reply from an earlier editor session cannot identify the current window. */
export function isWindowIdentity(value: unknown, session: string): value is WindowIdentity {
	return isJsonObject(value) && value.version === 1 && value.session === session && isWindowToken(value.token)
		&& (value.remote === undefined || (typeof value.remote === 'string' && !!value.remote))
		&& (value.component === undefined || (typeof value.component === 'string' && !!value.component));
}

/**
 * The local component's reply where this window's identity record is damaged: it invents no other identity (ARCHITECTURE-2.2), so
 * this window cannot tell its agents. Reloading reads the same record; another window, or another editor session, has its own.
 */
export interface DamagedWindowIdentity {
	readonly version: 1;
	readonly session: string;
	readonly damaged: true;
}

export function isDamagedWindowIdentity(value: unknown, session: string): value is DamagedWindowIdentity {
	return isJsonObject(value) && value.version === 1 && value.session === session && value.damaged === true;
}

/**
 * The local component's reply where this window's identity record could not be read now - a lock, no file handles left - and is not
 * known damaged: a reload reads it again. Without it the workspace component would wait for a component that is there, and say to
 * install it.
 */
export interface UnreadableWindowIdentity {
	readonly version: 1;
	readonly session: string;
	/** Why it could not be read, for the log. */
	readonly unreadable: string;
}

export function isUnreadableWindowIdentity(value: unknown, session: string): value is UnreadableWindowIdentity {
	return isJsonObject(value) && value.version === 1 && value.session === session && typeof value.unreadable === 'string';
}
