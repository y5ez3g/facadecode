/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The message of an error, or the thrown value as text. */
export function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The stack of an error where it has one, for the log. */
export function stackOf(err: unknown): string {
	return err instanceof Error ? err.stack ?? err.message : String(err);
}

/** The code Node gives an error, such as `ENOENT`. */
export function codeOf(err: unknown): string | undefined {
	const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined;
	return typeof code === 'string' ? code : undefined;
}
