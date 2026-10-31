/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Facade settings a launch reads (UX-4.1), as the execution environment's editor has them: `facade.yolo`,
// `facade.collaboration.enabled`, `facade.collaboration.waitSeconds` and each CLI's `facade.<cli>.path`. They are read on use and strictly: a wrong value is an error naming its setting, never replaced by a default
// without saying so.

import * as vscode from 'vscode';
import type { SettingsReader } from '../clis/catalog';
import { shown } from '../clis/config';
import { PlanError } from '../core/ports';

/** The YOLO setting of RULES-4.3. */
export const YOLO_SETTING = 'facade.yolo';
/** The switch of the agents' Facade tools on future starts (RULES-4.4). */
export const COLLABORATION_SETTING = 'facade.collaboration.enabled';
/** How long startup and stop wait for their outcome, in seconds (MCP-1.3). */
export const WAIT_SETTING = 'facade.collaboration.waitSeconds';
export const WAIT_DEFAULT = 120;
export const WAIT_MAX = 3600;

/** What `facade.yolo` holds now: its value, true by default, or why it holds neither true nor false. */
export function readYolo(): { readonly value: boolean; readonly problem?: undefined } | { readonly value?: undefined; readonly problem: string; readonly received: string } {
	const value = vscode.workspace.getConfiguration().get<unknown>(YOLO_SETTING);
	if (value !== undefined && typeof value !== 'boolean') {
		return { problem: `${YOLO_SETTING} must be true or false; received ${shown(value)}`, received: shown(value) };
	}
	return { value: value ?? true };
}

/**
 * The destination's YOLO for a launch being accepted (RULES-4.3): `facade.yolo`, true by default. Throws a PlanError naming
 * the setting where it holds neither true nor false.
 */
export function yolo(): boolean {
	const read = readYolo();
	if (read.problem !== undefined) {
		throw new PlanError(read.problem, 'configuration_invalid', { kind: 'yolo_type', values: [read.received] });
	}
	return read.value;
}

/** The settings the CLI catalog reads, by their full names (CLIS-1.1, 1.2). */
export const readSetting: SettingsReader = name => vscode.workspace.getConfiguration().get<unknown>(name);

/**
 * What `facade.collaboration.enabled` holds now (RULES-4.4): its value, true by default; for a value that is neither true nor
 * false, off - no tools are injected into a process on a setting that does not say so - with why, for the agents log.
 */
export function readCollaboration(read: SettingsReader = readSetting): { readonly value: boolean; readonly problem?: string } {
	const value = read(COLLABORATION_SETTING);
	if (value !== undefined && typeof value !== 'boolean') {
		return { value: false, problem: `${COLLABORATION_SETTING} must be true or false; received ${shown(value)}. Agents start without the Facade tools until it is fixed` };
	}
	return { value: value ?? true };
}

/**
 * What `facade.collaboration.waitSeconds` holds now (MCP-1.3, UX-4.1): its seconds, a whole number from 1 to 3600, 120 by default; for any other
 * value 120 all the same, with why, for the agents log.
 */
export function readWaitSeconds(read: SettingsReader = readSetting): { readonly value: number; readonly problem?: string } {
	const value = read(WAIT_SETTING);
	if (value === undefined) {
		return { value: WAIT_DEFAULT };
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > WAIT_MAX) {
		return { value: WAIT_DEFAULT, problem: `${WAIT_SETTING} must be a whole number of seconds from 1 to ${WAIT_MAX}; received ${shown(value)}. ${WAIT_DEFAULT} seconds are used until it is fixed` };
	}
	return { value };
}

/** `facade.collaboration.waitSeconds` in seconds for a call now (MCP-1.3); a wrong value is 120, its problem told to `log` (UX-4.1). */
export function waitSeconds(read: SettingsReader = readSetting, log?: (line: string) => void): number {
	const { value, problem } = readWaitSeconds(read);
	if (problem !== undefined) {
		log?.(problem);
	}
	return value;
}
