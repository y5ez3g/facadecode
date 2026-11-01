/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Tests compile to build/out/test; the fixtures stay beside their source
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures');

/** Domains reserved for examples and tests (RFC 2606, RFC 6761): no person's address. */
const RESERVED = /(?:^|\.)(?:example\.(?:com|net|org)|[a-z0-9-]+\.(?:test|example|invalid|localhost))$/i;

function filesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(file) : [file];
	});
}

// Recorded screens are published with the repository: a CLI draws its account's email address, so `scripts/capture-inputs.mjs`
// masks it before a screen becomes a recorded case, and this keeps one that slipped through from being committed.
suite('Recorded fixtures', () => {
	test('show no email address outside the domains reserved for examples', () => {
		const found = filesUnder(FIXTURES).flatMap(file => {
			const text = fs.readFileSync(file, 'utf8');
			const addresses = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
			return addresses.filter(address => !RESERVED.test(address.slice(address.indexOf('@') + 1))).map(() => path.relative(FIXTURES, file));
		});
		assert.deepStrictEqual(found, [], `Mask the email addresses in ${[...new Set(found)].join(', ')}`);
	});
});
