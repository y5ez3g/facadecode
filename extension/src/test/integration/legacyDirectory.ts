/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The subset published by the installed 0.1.5 Window Component that the cutover driver reads. */
export interface Directory {
	readonly self: string;
	readonly windows: readonly {
		readonly window: string;
		readonly agents: readonly {
			readonly alias: string;
			readonly run: string;
			readonly name: string;
			readonly lifecycle: string;
			readonly cwd: string;
		}[];
	}[];
}
