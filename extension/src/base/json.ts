/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A JSON object as it was parsed, its fields not checked yet. */
export type JsonObject = { readonly [key: string]: unknown };

/** Whether a parsed JSON value is an object: neither null nor an array. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` written as JSON with each object's keys in order and each array as it is: the same content however its writer ordered
 * the fields, while another order of a list is another value (CLIS-2.2).
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, each: unknown) => isJsonObject(each) ? Object.fromEntries(Object.keys(each).sort().map(key => [key, each[key]])) : each);
}
