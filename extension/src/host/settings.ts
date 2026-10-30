/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Facade settings a launch reads (UX-4.1), as the execution environment's editor has them: `facade.yolo` and each CLI's
// `facade.<cli>.path`. They are read on use and strictly: a wrong value is an error naming its setting, never replaced by a default
// without saying so.

import * as vscode from 'vscode';
import type { SettingsReader } from '../clis/catalog';
import { shown } from '../clis/config';
import { PlanError } from '../core/ports';

/** The YOLO setting of RULES-4.3. */
export const YOLO_SETTING = 'facade.yolo';

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
