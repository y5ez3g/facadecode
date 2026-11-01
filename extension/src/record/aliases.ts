/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { takeNumbers } from './counter';
import { facadeHome } from './paths';

/**
 * `#aN` aliases from one counter per execution environment, never reused (RULES-2.2): every window of this environment draws
 * from it under a lock. A counter that cannot be read is an error, never a count from `#a1` again.
 */
export class AliasCounter {
	private readonly file: string;

	constructor(home: string = facadeHome()) {
		this.file = path.join(home, 'agent-aliases.json');
	}

	next(): string {
		return `#a${takeNumbers(this.file, 1, 'agent number')}`;
	}
}
