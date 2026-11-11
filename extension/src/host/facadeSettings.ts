/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Facade's settings file in this execution environment (CONFIGURATION-1.1, 1.3): `facade.json` in the Facade home, read on every use
// so that a saved change applies to the next start. Facade writes it once, in one step, where it does not exist: from the settings
// it replaced where the person set any, else `{}`; created by its user alone, never over a file another window or the person made
// first, and never half written. Where the old settings cannot all have a place in it, no file is made and every start says why.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { messageOf } from '../base/errors';
import { catalogOf } from '../clis/catalog';
import type { Environment } from '../clis/environment';
import { destinationProblems } from '../clis/plan';
import type { CliProblem } from '../clis/config';
import { LegacyReader, Migration, MigrationNote, migrationOf, settingsText } from '../clis/migration';
import { defaultSettings, parseSettings, SETTINGS_FILE, SettingsSnapshot } from '../clis/settingsFile';
import { facadeRoot } from '../record/paths';

/** The settings file of Facade's root `root`. */
function settingsFileOf(root: string = facadeRoot()): string {
	return path.join(root, SETTINGS_FILE);
}

/** `file` as the person reads it: from their home folder as `~` where it is there. */
export function shownFile(file: string, home: string = os.homedir()): string {
	const relative = path.relative(home, file);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `~${path.sep}${relative}` : file;
}

/** What the one generation step did (CONFIGURATION-1.3). */
export type Generated = { readonly kind: 'exists' }
	| { readonly kind: 'created'; readonly migrated: boolean; readonly notes: readonly MigrationNote[] }
	| { readonly kind: 'conflict'; readonly problems: readonly CliProblem[] }
	| { readonly kind: 'failed'; readonly problem: CliProblem };

/**
 * Creates `file` holding `text`, readable and writable by its user alone, in one step: a whole file or none, never over one that is
 * there (CONFIGURATION-1.3). False where another window or the person made it first, which then stays as it is. The file is written
 * beside it first and then linked into place, which is atomic and never replaces a file; a file system without hard links is said
 * as a failure, never given a file another window could read half written.
 */
function createExclusively(file: string, text: string): boolean {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
		try {
			fs.linkSync(temporary, file);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
				return false;
			}
			throw err;
		}
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// Never made, or gone already
		}
	}
}

/** Where the settings come from: Facade's root, the settings they replaced, and what is said once a migration made the file. */
export interface FacadeSettingsOptions {
	readonly root?: string;
	readonly legacy?: LegacyReader;
	/** The environment a start's `${env:NAME}` reads, and its platform: this extension host's unless a test gives its own. */
	readonly host?: Environment;
	readonly platform?: NodeJS.Platform;
	/** Said once, by the window that made the file from the old settings (CONFIGURATION-6.3). */
	readonly migrated?: (file: string, notes: readonly MigrationNote[]) => void;
	readonly log?: (line: string) => void;
}

function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/**
 * Where a settings file `settings` has problems (CONFIGURATION-6.2, 6.3): the file itself, or each entry with one, by its setting path -
 * one whose `env` reads a variable the environment `host` has not, which an earlier build read as empty, too.
 */
function needsFixing(settings: SettingsSnapshot, host: Environment, platform: NodeJS.Platform): MigrationNote[] {
	if (settings.problems.length) {
		return [{ kind: 'file_needs_fix', from: settings.file }];
	}
	return catalogOf(settings).entries.filter(entry => entry.problems.length || destinationProblems(entry, { host, platform }).length)
		.map(entry => ({ kind: 'needs_fix' as const, from: entry.entry.setting }));
}

/** Facade's settings in this execution environment (CONFIGURATION-1.1): the file read on every use. */
export class FacadeSettings {

	/** The settings file. */
	readonly file: string;
	/** The file as problems name it to the person. */
	readonly shown: string;
	private readonly legacy: LegacyReader;
	private readonly migrated: FacadeSettingsOptions['migrated'];
	private readonly log: (line: string) => void;
	private readonly host: Environment;
	private readonly platform: NodeJS.Platform;

	constructor(options: FacadeSettingsOptions = {}) {
		this.file = settingsFileOf(options.root);
		this.shown = shownFile(this.file);
		this.legacy = options.legacy ?? (() => undefined);
		this.migrated = options.migrated;
		this.log = options.log ?? (() => undefined);
		this.host = options.host ?? process.env;
		this.platform = options.platform ?? process.platform;
	}

	/**
	 * The one generation step (CONFIGURATION-1.3, 6.2): where the file does not exist, it is made - from the old settings where the person
	 * set any, else with every built-in's defaults. Where those cannot all have a place in it, or it cannot be written, none is made, and why
	 * is returned.
	 */
	ensure(): Generated {
		if (fs.existsSync(this.file)) {
			return { kind: 'exists' };
		}
		let migration: Migration;
		try {
			migration = migrationOf(this.legacy);
		} catch (err) {
			return { kind: 'failed', problem: problem(`The settings ${this.shown} would be made from could not be read: ${messageOf(err)}`, 'settings_migration_read', this.shown, messageOf(err)) };
		}
		if (migration.kind === 'conflict') {
			return migration;
		}
		const text = migration.kind === 'file' ? migration.text : settingsText(undefined, []);
		try {
			if (!createExclusively(this.file, text)) {
				return { kind: 'exists' };
			}
		} catch (err) {
			return { kind: 'failed', problem: problem(`${this.shown} could not be created: ${messageOf(err)}`, 'settings_create', this.shown, messageOf(err)) };
		}
		const migrated = migration.kind === 'file';
		// The old values the file's rules find wrong, by where they are now: each to be fixed in the file (CONFIGURATION-6.2)
		const fixes: MigrationNote[] = migrated ? needsFixing(parseSettings(text, this.shown), this.host, this.platform) : [];
		const notes = migration.kind === 'file' ? [...migration.notes, ...fixes] : [];
		this.log(migrated ? `Created ${this.shown} from the Facade settings of the editor` : `Created ${this.shown}`);
		if (migrated) {
			this.migrated?.(this.file, notes);
		}
		return { kind: 'created', migrated, notes };
	}

	/**
	 * The settings now (CONFIGURATION-1.1): the file as it reads, made first where it does not exist. Where it cannot be made or read,
	 * or reads wrong, its problems stand for every start; nothing is taken from an earlier read.
	 */
	snapshot(): SettingsSnapshot {
		// A file removed between its making and its reading is made again, once: a missing file is never every default (CONFIGURATION-1.3)
		for (let attempt = 0; ; attempt++) {
			const generated = this.ensure();
			if (generated.kind === 'conflict') {
				return { ...defaultSettings(this.shown), problems: generated.problems.map(each => ({
					text: `${this.shown} was not made from the editor's Facade settings: ${each.text}`, said: each.said
				})) };
			}
			if (generated.kind === 'failed') {
				return { ...defaultSettings(this.shown), problems: [generated.problem] };
			}
			try {
				return parseSettings(fs.readFileSync(this.file, 'utf8'), this.shown);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || attempt) {
					return { ...defaultSettings(this.shown), problems: [problem(`${this.shown} could not be read: ${messageOf(err)}`, 'settings_read', this.shown, messageOf(err))] };
				}
			}
		}
	}
}
