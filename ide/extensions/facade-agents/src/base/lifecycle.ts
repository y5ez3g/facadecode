/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Disposes each of `disposables`, in order: one that throws is said to `failed`, and the rest are disposed all the
 * same - a deactivation that stopped at the first would leave the window's subscriptions, and the record, open (C4).
 */
export function disposeAll(disposables: Iterable<{ dispose(): unknown }>, failed: (err: unknown) => void): void {
	for (const disposable of disposables) {
		try {
			disposable.dispose();
		} catch (err) {
			failed(err);
		}
	}
}
