/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Facade settings a launch reads (UX-4.1), as the execution environment's editor has them: `facade.yolo`,
// `facade.collaboration.enabled` and each CLI's `facade.<cli>.path`. They are read on use and strictly: a wrong value is an error naming its setting, never replaced by a default
// without saying so.

import * as vscode from 'vscode';
import type { SettingsReader } from '../clis/catalog';
import { shown } from '../clis/config';
import { FacadeError } from '../core/errors';

/** The YOLO setting of RULES-4.3. */
export const YOLO_SETTING = 'facade.yolo';
/** The switch of the agents' Facade tools on future starts (RULES-4.4). */
export const COLLABORATION_SETTING = 'facade.collaboration.enabled';
/** How long a start or a stop is waited for before it is answered `accepted`, in seconds: no setting changes it (MCP-1.3). */
export const WAIT_SECONDS = 120;

/** What `facade.yolo` holds now: its value, true by default, or why it holds neither true nor false. */
export function readYolo(): { readonly value: boolean; readonly problem?: undefined } | { readonly value?: undefined; readonly problem: string; readonly received: string } {
	const value = vscode.workspace.getConfiguration().get<unknown>(YOLO_SETTING);
	if (value !== undefined && typeof value !== 'boolean') {
		return { problem: `${YOLO_SETTING} must be true or false; received ${shown(value)}`, received: shown(value) };
	}
	return { value: value ?? true };
}

/**
 * The destination's YOLO for a launch being accepted (RULES-4.3): `facade.yolo`, true by default. Where it holds neither true nor
 * false, the launch is refused before any effect, `configuration_invalid`, naming the setting (UX-4.1).
 */
export function yolo(): boolean {
	const read = readYolo();
	if (read.problem !== undefined) {
		throw new FacadeError('UNAVAILABLE', 'configuration_invalid', read.problem, { kind: 'yolo_type', values: [read.received] });
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
