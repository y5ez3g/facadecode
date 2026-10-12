/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from '../../base/common/json.js';
import { ChatAIDisabledSettingId } from '../../platform/chat/common/chatSettings.js';

/** The command line's ways into upstream's AI: the `chat` subcommand, and `--agents`, which opens the agents window. */
export const AI_CLI_OPTIONS = ['chat', 'agents'] as const;

/**
 * Whether upstream's AI features are off, as `chat.disableAIFeatures` in the person's settings says: off
 * unless they turned them back on (IDENTITY.md I11). Settings that are not there, or cannot be read, are
 * the default's, off.
 */
export function areAIFeaturesOff(userSettings: string | undefined): boolean {
	if (!userSettings) {
		return true;
	}

	const settings: unknown = parse(userSettings);
	return !(settings && typeof settings === 'object' && (settings as Record<string, unknown>)[ChatAIDisabledSettingId] === false);
}

/** `options` without the command line's ways into upstream's AI: its help while they are off. */
export function withoutAIOptions<T extends object>(options: T): T {
	const kept: Record<string, unknown> = { ...options as Record<string, unknown> };
	for (const option of AI_CLI_OPTIONS) {
		delete kept[option];
	}
	return kept as T;
}
