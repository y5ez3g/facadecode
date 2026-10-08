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
			throw invalid(`${tool} takes an object of arguments: ${params.join(', ')}.`);
		}
		const known = params.map(param => param.replace(/\?$/, ''));
		const unknown = Object.keys(input).filter(key => !known.includes(key));
		if (unknown.length) {
			throw invalid(`${tool} takes ${params.join(', ') || 'no arguments'}; not ${unknown.join(', ')}.`);
		}
		this.values = input;
	}

	/** A string with something in it, trimmed. */
	text(name: string): string {
		const value = this.string(name);
		if (!value.trim()) {
			throw invalid(`${name} must not be empty.`);
		}
		return value.trim();
	}

	/** A string as it is given, its spaces and all: a message's text, say. */
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

	/** A list of strings, each as it is given; a string alone is a list of one, as a model may give it. */
	strings(name: string): string[] {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`${name} is required.`);
		}
		if (typeof value === 'string') {
			return [value];
		}
		if (!isStringArray(value)) {
			throw invalid(`${name} must be a list of strings.`);
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
			throw invalid(`${name} must have one at least, or be left out.`);
		}
		return value;
	}

	/** A string with something in it, trimmed, if it is given: an empty one counts as not given. */
	optionalText(name: string): string | undefined {
		const value = this.values[name];
		return value === undefined || value === '' ? undefined : this.text(name);
	}

	/** True or false, if it is given. */
	boolean(name: string): boolean | undefined {
		const value = this.values[name];
		if (value === undefined || typeof value === 'boolean') {
			return value;
		}
		throw invalid(`${name} must be true or false.`);
	}

	/** A whole number from `min` to `max`, if it is given. */
	integer(name: string, min: number, max: number): number | undefined {
		const value = this.values[name];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
			throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
		}
		return value;
	}

	/** A string with something in it, exactly as it is given: its spaces at the ends too. */
	exactText(name: string): string {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`${name} is required.`);
		}
		if (typeof value !== 'string') {
			throw invalid(`${name} must be a string.`);
		}
		if (!value) {
			throw invalid(`${name} must not be empty.`);
		}
		return value;
	}
}

function invalid(message: string): FacadeError {
	return new FacadeError('INVALID', message);
}
