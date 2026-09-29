/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RESERVED_NAMES } from './events';

class NameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NameError';
	}
}

export const MAX_NAME_CHARS = 40;
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * A name an agent may be given, without its `@` (WA-4.2). Lower case, so that two spellings never
 * name two agents on a file system that folds case.
 */
export function agentName(text: string): string {
	const name = text.trim().replace(/^@/, '').toLowerCase();
	if (!NAME.test(name)) {
		throw new NameError(`"${text}" is not a name: use up to ${MAX_NAME_CHARS} letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
	}
	if (RESERVED_NAMES.has(name)) {
		throw new NameError(`"${name}" is reserved; choose another name.`);
	}
	return name;
}

/** The name a worktree gives its agents: its own, lower case, a branch's slashes as dashes. */
export function nameOfWorktree(worktree: string): string {
	const name = worktree.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, MAX_NAME_CHARS).replace(/[^a-z0-9]+$/, '');
	return NAME.test(name) && !RESERVED_NAMES.has(name) ? name : 'agent';
}
