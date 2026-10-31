/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog (CLIS-1.1): the built-ins in their order, each with its settings as read. Discovery inspects files and
// configuration only: it never runs a CLI, logs in, installs or changes settings.

import { CliAdapter } from './adapter';
import { antigravityAdapter } from './antigravity';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { CliSettings, readCliSettings } from './config';
import { museAdapter } from './muse';
import { openCodeAdapter } from './opencode';
import { piAdapter } from './pi';

/** The built-ins, in the order every list gives them (CLIS-1.1). */
export const BUILT_IN_ADAPTERS: readonly CliAdapter[] = [claudeAdapter, codexAdapter, antigravityAdapter, museAdapter, openCodeAdapter, piAdapter];

/** One CLI of the catalog: its adapter, and its settings as read. */
export interface CatalogEntry {
	readonly adapter: CliAdapter;
	/** Whether new starts are offered it: its `.enabled` (CLIS-1.1). */
	readonly enabled: boolean;
	/** The configured program: `.path`, empty for its command on PATH. */
	readonly path: string;
	/** The configured literal options: `.launch.arguments` (CLIS-3.1). */
	readonly extra: readonly string[];
	/** The configured variables: `.launch.environment` (CLIS-1.2, 3.1). */
	readonly environment: CliSettings['environment'];
	/** Its configuration problems, each naming the setting path; while any stands it does not start. */
	readonly problems: CliSettings['problems'];
}

/**
 * The options a built-in's adapter sets itself - its run settings and its YOLO mapping, either way (CLIS-1.3, 3.2): a launch argument
 * repeating one would put the person's value in Facade's place, so it is refused (CLIS-3.1). Its folder's trust is not among them.
 */
export function ownedOptions(adapter: CliAdapter): readonly string[] {
	return [...adapter.groups.quiet ?? [], ...adapter.groups.yoloOn ?? [], ...adapter.groups.yoloOff ?? []].filter(token => token.startsWith('-'));
}

/** How the catalog reads the settings: by their full names, as the destination environment's editor has them. */
export type SettingsReader = (name: string) => unknown;

/** The catalog: its entries. */
export interface Catalog {
	readonly entries: readonly CatalogEntry[];
}

/** The catalog under the settings `read` gives (CLIS-1.1, 1.2, 3.1): every built-in, a turned-off one too. */
export function catalogOf(read: SettingsReader): Catalog {
	return {
		entries: BUILT_IN_ADAPTERS.map((adapter): CatalogEntry => {
			const settings = readCliSettings(adapter.setting, key => read(`${adapter.setting}.${key}`), ownedOptions(adapter));
			return { adapter, enabled: settings.enabled, path: settings.path, extra: settings.arguments, environment: settings.environment, problems: settings.problems };
		})
	};
}

/** The catalog's entry for the API ID `cli`; undefined for one no built-in has. */
export function entryOf(catalog: Catalog, cli: string): CatalogEntry | undefined {
	return catalog.entries.find(entry => entry.adapter.id === cli);
}
