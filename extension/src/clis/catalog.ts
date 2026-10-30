/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog (CLIS-1.1): the built-ins in their order, each with its settings as read. Discovery inspects files and
// configuration only: it never runs a CLI, logs in, installs or changes settings.

import { CliAdapter } from './adapter';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { CliSettings, readCliSettings } from './config';

/** The built-ins, in the order every list gives them (CLIS-1.1). */
export const BUILT_IN_ADAPTERS: readonly CliAdapter[] = [claudeAdapter, codexAdapter];

/** One CLI of the catalog: its adapter and its settings as read. */
export interface CatalogEntry {
	readonly adapter: CliAdapter;
	/** The configured program: `.path`, empty for its command on PATH. */
	readonly path: string;
	/** Its configuration problems, each naming the setting path; while any stands it does not start. */
	readonly problems: CliSettings['problems'];
	readonly said?: CliSettings['said'];
}

/** How the catalog reads the settings: by their full names, as the destination environment's editor has them. */
export type SettingsReader = (name: string) => unknown;

/** The catalog: its entries. */
export interface Catalog {
	readonly entries: readonly CatalogEntry[];
}

/** The catalog under the settings `read` gives (CLIS-1.1, 1.2): every built-in. */
export function catalogOf(read: SettingsReader): Catalog {
	return {
		entries: BUILT_IN_ADAPTERS.map((adapter): CatalogEntry => {
			const settings = readCliSettings(adapter.setting, key => read(`${adapter.setting}.${key}`));
			return { adapter, path: settings.path, problems: settings.problems, ...settings.said ? { said: settings.said } : {} };
		})
	};
}

/** The catalog's entry for the API ID `cli`; undefined for one no built-in has. */
export function entryOf(catalog: Catalog, cli: string): CatalogEntry | undefined {
	return catalog.entries.find(entry => entry.adapter.id === cli);
}
