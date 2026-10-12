/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A JSON object as it was parsed, its fields not checked yet. */
export type JsonObject = { readonly [key: string]: unknown };

/** Whether a parsed JSON value is an object: neither null nor an array. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a parsed JSON value is an array of strings. */
export function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * `defaults` with `set` over it, key by key down through objects: a key set to null taken out, any other
 * value replacing the default's. An object of the person's where the default has none is gone through
 * too, so that no null of theirs reaches the CLI as a value.
 */
export function mergedObject(defaults: JsonObject, set: unknown): JsonObject {
	if (!isJsonObject(set)) {
		return defaults;
	}
	const merged: { [key: string]: unknown } = { ...defaults };
	for (const [key, value] of Object.entries(set)) {
		const byDefault = merged[key];
		if (value === null) {
			delete merged[key];
		} else {
			merged[key] = isJsonObject(value) ? mergedObject(isJsonObject(byDefault) ? byDefault : {}, value) : value;
		}
	}
	return merged;
}
