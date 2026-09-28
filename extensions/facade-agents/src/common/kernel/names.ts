/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RESERVED_NAMES } from './model';

/*
 * The names people and agents write: participants (`@f2`), groups (`#p1`) and pages (`p1/plan`).
 * All are lower case, so that two spellings never name two things on a file system that folds case.
 */

export class NameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NameError';
	}
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** A participant's name, without its `@`. */
export function participantName(text: string): string {
	const name = text.trim().replace(/^@/, '').toLowerCase();
	if (!NAME.test(name)) {
		throw new NameError(`"${text}" is not a name: use up to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
	}
	return name;
}

/** A name an agent may be given: not one Facade keeps for itself. */
export function agentName(text: string): string {
	const name = participantName(text);
	if (RESERVED_NAMES.has(name)) {
		throw new NameError(`"${name}" is reserved; choose another name.`);
	}
	return name;
}

/** A group's name, without its `#`. */
export function groupName(text: string): string {
	const name = text.trim().replace(/^#/, '').toLowerCase();
	if (!NAME.test(name)) {
		throw new NameError(`"${text}" is not a group: use up to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
	}
	return name;
}

export type Address = { readonly kind: 'participant'; readonly name: string } | { readonly kind: 'group'; readonly name: string };

/** `@f2`, `#p1`, or a bare name, which is a participant's. Several may be given, split by commas or spaces. */
export function parseAddresses(to: string | readonly string[]): Address[] {
	const items = (typeof to === 'string' ? [to] : [...to]).flatMap(item => String(item).split(/[\s,]+/)).filter(Boolean);
	if (!items.length) {
		throw new NameError('Say who the message is for: @name for a participant, #name for a group.');
	}
	const addresses: Address[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const address: Address = item.startsWith('#') ? { kind: 'group', name: groupName(item) } : { kind: 'participant', name: participantName(item) };
		const key = `${address.kind}:${address.name}`;
		if (!seen.has(key)) {
			seen.add(key);
			addresses.push(address);
		}
	}
	return addresses;
}

export function formatAddress(address: Address): string {
	return address.kind === 'group' ? `#${address.name}` : `@${address.name}`;
}

const MAX_PAGE_CHARS = 200;
/** Characters no file name on Windows may hold, and control characters. */
const FORBIDDEN_IN_SEGMENT = /[<>:"|?*\\\x00-\x1f]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;

/**
 * A page's path: segments split by `/`, lower case, no `.md` at the end. `folder` allows the empty
 * path, which is the whole notebook.
 */
export function pagePath(text: string, folder = false): string {
	let page = String(text ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
	if (!folder) {
		page = page.replace(/\.md$/, '');
	}
	if (!page) {
		if (folder) {
			return '';
		}
		throw new NameError('A page needs a path, such as p1/plan.');
	}
	if (page.length > MAX_PAGE_CHARS) {
		throw new NameError(`A page path has at most ${MAX_PAGE_CHARS} characters.`);
	}
	for (const segment of page.split('/')) {
		if (segment === '.' || segment === '..' || /^[\s.]|[\s.]$/.test(segment) || FORBIDDEN_IN_SEGMENT.test(segment) || WINDOWS_DEVICE.test(segment)) {
			throw new NameError(`"${text}" is not a page path: each part between slashes needs a name that can be a file name, not starting or ending with a dot or a space.`);
		}
	}
	return page;
}
