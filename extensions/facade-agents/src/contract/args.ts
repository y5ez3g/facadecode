/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { FacadeError } from '../core/errors';

/**
 * A tool's or an action's arguments, each checked as it is read: a wrong one is INVALID, and the
 * error says what is right (WORKTREE-AGENTS.md, WA-5.7). An argument it does not take is refused
 * with the ones it takes.
 */
export class Args {

	private readonly values: Record<string, unknown>;

	/** `params` as the model is told them: `?` marks one it may leave out. */
	constructor(owner: string, params: readonly string[], input: unknown) {
		if (!isObject(input)) {
			throw invalid(`${owner} takes an object of arguments: ${params.join(', ')}.`);
		}
		const known = params.map(param => param.replace(/\?$/, ''));
		const unknown = Object.keys(input).filter(key => !known.includes(key));
		if (unknown.length) {
			throw invalid(`${owner} takes ${params.join(', ') || 'no arguments'}; not ${unknown.join(', ')}.`);
		}
		this.values = input;
	}

	/** A string, perhaps empty. */
	string(name: string): string {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`${name} is required.`);
		}
		if (typeof value !== 'string') {
			throw invalid(`${name} must be a string.`);
		}
		return value;
	}

	/** A string with something in it, trimmed. */
	text(name: string): string {
		const value = this.string(name).trim();
		if (!value) {
			throw invalid(`${name} must not be empty.`);
		}
		return value;
	}

	optionalText(name: string): string | undefined {
		return this.values[name] === undefined || this.values[name] === '' ? undefined : this.text(name);
	}

	/** An absolute path, normalized. */
	path(name: string): string {
		const value = this.text(name);
		if (!path.isAbsolute(value)) {
			throw invalid(`${name} must be an absolute path, not ${value}.`);
		}
		return path.normalize(value);
	}

	/** A whole number above 0, if it is given. */
	count(name: string): number | undefined {
		const value = this.values[name];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
			throw invalid(`${name} must be a whole number above 0.`);
		}
		return value;
	}

	boolean(name: string): boolean | undefined {
		const value = this.values[name];
		if (value === undefined || typeof value === 'boolean') {
			return value;
		}
		throw invalid(`${name} must be true or false.`);
	}

	list(name: string): readonly unknown[] | undefined {
		const value = this.values[name];
		if (value === undefined || Array.isArray(value)) {
			return value;
		}
		throw invalid(`${name} must be a list.`);
	}

	object(name: string): Record<string, unknown> | undefined {
		const value = this.values[name];
		if (value === undefined || isObject(value)) {
			return value;
		}
		throw invalid(`${name} must be an object: the action's arguments.`);
	}
}

export function invalid(message: string): FacadeError {
	return new FacadeError('INVALID', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
