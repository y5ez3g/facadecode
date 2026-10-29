/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject, isStringArray, JsonObject } from '../base/json';
import { FacadeError } from '../core/errors';

/**
 * A tool's arguments, each checked as it is read: a wrong one is `INVALID`, and the error says what is
 * right. An argument the tool does not take is refused with the ones it takes.
 */
export class Args {

	private readonly values: JsonObject;

	/** `params` as the model is told them: `?` marks one it may leave out. */
	constructor(tool: string, params: readonly string[], input: unknown) {
		if (!isJsonObject(input)) {
			throw invalid(`Provide a JSON arguments object for ${tool}. Accepted arguments (? = optional): ${params.join(', ')}.`);
		}
		const known = params.map(param => param.replace(/\?$/, ''));
		const unknown = Object.keys(input).filter(key => !known.includes(key));
		if (unknown.length) {
			throw invalid(`Unknown arguments for ${tool}: ${unknown.join(', ')}. Accepted arguments (? = optional): ${params.join(', ') || 'none'}.`);
		}
		this.values = input;
	}

	/** A string with something in it, trimmed. */
	text(name: string): string {
		const value = this.string(name);
		if (!value.trim()) {
			throw invalid(`Argument '${name}' must not be empty.`);
		}
		return value.trim();
	}

	/** A string as it is given, its spaces and all: a message's text, say. */
	string(name: string): string {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`Argument '${name}' is required.`);
		}
		if (typeof value !== 'string') {
			throw invalid(`Argument '${name}' must be a string.`);
		}
		return value;
	}

	/**
	 * A list of strings, each as it is given; a string alone is a list of one, as a model may give it. A string holding
	 * a JSON list of strings is that list: offered a string or a list, a client may send a list so (Muse Code).
	 */
	strings(name: string): string[] {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`Argument '${name}' is required.`);
		}
		if (typeof value === 'string') {
			return listIn(value) ?? [value];
		}
		if (!isStringArray(value)) {
			throw invalid(`Argument '${name}' must be a string or an array of strings.`);
		}
		return [...value];
	}

	/** A list of strings, if it is given: one given must have one at least. */
	optionalStrings(name: string): string[] | undefined {
		if (this.values[name] === undefined) {
			return undefined;
		}
		const value = this.strings(name);
		if (!value.length) {
			throw invalid(`Argument '${name}' must contain at least one item. Omit it if no selection is needed.`);
		}
		return value;
	}

	/** A string with something in it, trimmed, if it is given: an empty one is refused, as a blank one is. */
	optionalText(name: string): string | undefined {
		return this.values[name] === undefined ? undefined : this.text(name);
	}

	/** A string with something in it, exactly as given, if it is given - words someone wrote, a task's: a blank one is refused. */
	optionalWords(name: string): string | undefined {
		if (this.values[name] === undefined) {
			return undefined;
		}
		this.text(name);
		return this.values[name] as string;
	}

	/** True or false, if it is given. */
	boolean(name: string): boolean | undefined {
		const value = this.values[name];
		if (value === undefined || typeof value === 'boolean') {
			return value;
		}
		throw invalid(`Argument '${name}' must be a boolean.`);
	}

	/** A whole number from `min` to `max`, if it is given. */
	integer(name: string, min: number, max: number): number | undefined {
		const value = this.values[name];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
			throw invalid(`Argument '${name}' must be an integer between ${min} and ${max}.`);
		}
		return value;
	}

	/** A string with something in it, exactly as it is given: its spaces at the ends too. */
	exactText(name: string): string {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`Argument '${name}' is required.`);
		}
		if (typeof value !== 'string') {
			throw invalid(`Argument '${name}' must be a string.`);
		}
		if (!value) {
			throw invalid(`Argument '${name}' must not be empty.`);
		}
		return value;
	}
}

/** The strings a JSON list in `value` holds - `["#a1", "#a2"]` - or undefined where it holds none. */
function listIn(value: string): string[] | undefined {
	if (!value.trimStart().startsWith('[')) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return isStringArray(parsed) ? [...parsed] : undefined;
	} catch {
		return undefined;
	}
}

function invalid(message: string): FacadeError {
	return new FacadeError('INVALID', message);
}
