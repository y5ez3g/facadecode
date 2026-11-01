/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { withFileLock } from '../base/lock';
import { facadeHome } from './paths';

/** How many values of each choice are kept per CLI and environment, the most recent first. */
const KEPT = 20;

/** The explicit models and efforts that started a CLI, most recent first. */
export interface StartChoices {
	readonly model: readonly string[];
	readonly effort: readonly string[];
}

interface Entry extends StartChoices {
	readonly environment: string;
	readonly cli: string;
}

/**
 * The explicit model and effort values of agent starts whose process started, per CLI and execution environment (CLIS-1.4,
 * MCP-2.1): offered as earlier choices, never as a complete list or a promise that a value still works. One small file in the
 * Facade directory, every window of the environment writing it under a lock.
 */
export class ChoiceStore {
	private readonly file: string;

	constructor(home: string = facadeHome()) {
		this.file = path.join(home, 'start-choices.json');
	}

	list(environment: string, cli: string): StartChoices {
		const entry = this.read().find(each => each.environment === environment && each.cli === cli);
		return { model: entry?.model ?? [], effort: entry?.effort ?? [] };
	}

	/** Puts the start's explicit values first; a start that gave neither changes nothing. */
	remember(environment: string, cli: string, choice: { readonly model?: string; readonly effort?: string }): void {
		if (choice.model === undefined && choice.effort === undefined) {
			return;
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		withFileLock(this.file, () => {
			const entries = this.read();
			const old = entries.find(each => each.environment === environment && each.cli === cli);
			const first = (value: string | undefined, kept: readonly string[]) => value === undefined ? kept : [value, ...kept.filter(each => each !== value)].slice(0, KEPT);
			const entry: Entry = { environment, cli, model: first(choice.model, old?.model ?? []), effort: first(choice.effort, old?.effort ?? []) };
			replaceFile(this.file, `${JSON.stringify([entry, ...entries.filter(each => each !== old)])}\n`);
		});
	}

	private read(): Entry[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
		} catch {
			return [];
		}
	}
}

function isEntry(value: unknown): value is Entry {
	const entry = value as Partial<Record<keyof Entry, unknown>> | null;
	const strings = (list: unknown) => Array.isArray(list) && list.every(each => typeof each === 'string');
	return !!entry && typeof entry.environment === 'string' && typeof entry.cli === 'string' && strings(entry.model) && strings(entry.effort);
}
