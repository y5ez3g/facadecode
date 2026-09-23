/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the Windows installer says this product is, and who ships it.
 *
 * ⚠️ These read the build's own files as text rather than importing them. `gulpfile.vscode.ts` and
 * `lib/electron.ts` pull gulp and the Electron download in at import time, which is not something a
 * unit test should be starting; and what is being guarded here is a literal, which is exactly what
 * reading the text checks.
 *
 * ⚠️ The point is the merge. Every one of these files is upstream's, and an upstream change that
 * restores its own product identity in one of them is a change that would otherwise ship quietly -
 * the installer only says any of it once, on a machine that is not this one.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * Upstream's product identity: what it calls itself and where it sends people.
 *
 * ⚠️ `Microsoft Corporation` is deliberately not on this list. It is the answer to "whose copyright
 * is in this binary", which is a different question from "who ships it", and it has to keep
 * appearing wherever the first question is asked. The tests below check where it may appear rather
 * than that it does not.
 */
const UPSTREAM_IDENTITY = [
	'code.visualstudio.com',
	'Visual Studio Code',
	'VSCodeSetup'
];

suite('Facade branding - the installer', () => {

	test('the setup script names this product and nobody else', () => {
		const iss = read('build/win32/code.iss');
		// ⚠️ `SOFTWARE\Microsoft\Windows\...` and the Quick Launch path are Windows' own and stay.
		const microsoft = iss.split(/\r?\n/)
			.filter(l => l.includes('Microsoft Corporation'))
			.map(l => l.split('=')[0]);

		assert.deepStrictEqual({
			found: UPSTREAM_IDENTITY.filter(s => iss.includes(s)),
			publisher: /^AppPublisher=(.*)$/m.exec(iss)?.[1],
			microsoft
		}, {
			found: [],
			publisher: '{#NameLong}',
			microsoft: ['VersionInfoCopyright']		// the licence line, and only that
		});
	});

	test('every installer message takes the product name as an argument', () => {
		const dir = path.join(root, 'build/win32/i18n');
		const offenders: string[] = [];
		for (const name of fs.readdirSync(dir).filter(n => n.startsWith('messages.') && n.endsWith('.isl'))) {
			const line = fs.readFileSync(path.join(dir, name), 'utf8')
				.split(/\r?\n/).find(l => l.startsWith('UpdatingVisualStudioCode='));
			// ⚠️ `%1`, the way every other message in these files already gets the name. The key
			// keeps upstream's spelling: it is referenced from `code.iss` and renaming it buys
			// nothing but a bigger diff.
			if (!line || !line.includes('%1') || UPSTREAM_IDENTITY.some(s => line.includes(s))) {
				offenders.push(`${name}: ${line ?? '(missing)'}`);
			}
		}

		assert.deepStrictEqual(offenders, []);
	});

	test('the version info stamped on the binaries follows the product', () => {
		const electron = read('build/lib/electron.ts');
		const desktop = read('build/gulpfile.vscode.ts');
		const server = read('build/gulpfile.reh.ts');

		assert.deepStrictEqual([
			electron.includes('companyName: product.nameLong,'),
			desktop.includes(`'CompanyName': product.nameLong,`),
			server.includes(`'CompanyName': productContents.nameLong,`),
			// the licence is a different question from the publisher, and both names belong on it
			[electron, desktop, server].every(s => /Microsoft Corporation and \$\{product(Contents)?\.nameLong\} contributors/.test(s))
		], [true, true, true, true]);
	});

	test('the Store manifest claims nobody else as publisher', () => {
		// ⚠️ This file is only read when the quality is `stable` or `insider`, which this fork is
		// not, so nothing here is built today. It is on the list because what it said was a claim
		// about who ships the package, and a claim does not stop being one for being unreachable.
		const manifest = read('resources/win32/appx/AppxManifest.xml');
		// the namespaces are `schemas.microsoft.com`, which is where the schemas are, not branding
		const withoutNamespaces = manifest.split(/\r?\n/).filter(l => !l.includes('xmlns')).join('\n');

		assert.deepStrictEqual({
			microsoft: /Microsoft/.test(withoutNamespaces),
			publisher: /Publisher="([^"]*)"/.exec(manifest)?.[1],
			display: /<PublisherDisplayName>([^<]*)</.exec(manifest)?.[1]
		}, {
			microsoft: false,
			publisher: '@@AppxPublisher@@',
			display: '@@AppxPublisherDisplayName@@'
		});
	});

	test('the product points at its own home', () => {
		const product = JSON.parse(read('product.json'));
		const urls = ['productHomeUrl', 'licenseUrl', 'serverLicenseUrl', 'reportIssueUrl'];

		assert.deepStrictEqual(
			urls.map(k => [k, typeof product[k] === 'string' && !/github\.com\/microsoft|visualstudio\.com/.test(product[k])]),
			urls.map(k => [k, true]));
	});
});

suite('Facade branding - the Linux packages', () => {

	const templates = [
		'resources/linux/debian/control.template',
		'resources/linux/rpm/code.spec.template',
		'resources/linux/code.appdata.xml',
		'resources/linux/snap/snapcraft.yaml',
		// ⚠️ The desktop entries belong on this list too. They carry no `Microsoft` and no URL, so
		// nothing here caught them, and what they did carry was upstream's tagline in `Comment` and
		// its name in `Keywords` - the line under the icon in a Linux menu, and the word somebody
		// types to find it.
		'resources/linux/code.desktop',
		'resources/linux/code-url-handler.desktop'
	];

	/**
	 * ⚠️ A citation is not a claim. `code.spec.template` carries a comment linking to the upstream
	 * issue that explains why it turns ELF stripping off; that link is the reason the workaround is
	 * there, and a fork that strips it keeps the workaround and loses the why. Comments pointing at
	 * upstream's tracker are read past - everything else is not.
	 */
	const withoutCitations = (text: string) => text.split(/\r?\n/)
		.filter(line => !/^\s*(#|<!--).*github\.com\/microsoft\/vscode/.test(line))
		.join('\n');

	test('no packager names another product', () => {
		// `vscode` and the tagline as well: neither carries a URL, so nothing else on the list
		// would have found them where they were - in a desktop entry's `Keywords` and `Comment`.
		const identity = [...UPSTREAM_IDENTITY, 'Code Editing. Redefined.', 'vscode'];

		assert.deepStrictEqual(
			templates.map(p => [p, identity.filter(s => withoutCitations(read(p)).includes(s))]),
			templates.map(p => [p, []]));
	});

	test('what the menu shows under the name is this product\'s own', () => {
		// ⚠️ `.code-workspace` is deliberately not on this list. It is the workspace file's
		// extension, which is upstream's format and one this fork reads - renaming it would make a
		// workspace somebody already has stop opening.
		const entries = ['resources/linux/code.desktop', 'resources/linux/code-url-handler.desktop'];
		const field = (file: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(read(file))?.[1];

		assert.deepStrictEqual(
			entries.map(f => [path.basename(f), field(f, 'Comment'), field(f, 'Keywords')]),
			entries.map(f => [path.basename(f), '@@SUMMARY@@', '@@NAME@@;']));
	});

	test('the summary obeys the rules the three packagers put on it', () => {
		// ⚠️ These are not house style, they are the formats' own:
		//
		//   Debian Policy 3.4.1     the synopsis carries no trailing full stop, and does not open
		//                           with an article - it is read as a phrase completing the package
		//                           name, not as a sentence
		//   rpmlint                 `summary-ended-with-dot`
		//   AppStream               the summary is not a sentence and takes no full stop
		//   snapcraft               `summary` is at most 78 characters
		//
		// And one of YAML's: a plain scalar cannot carry a colon followed by a space, which is what
		// `summary: <this>` in `snapcraft.yaml` would turn into a mapping.
		const summary = JSON.parse(read('product.json')).productSummary;

		assert.deepStrictEqual({
			endsInAFullStop: summary.endsWith('.'),
			opensWithAnArticle: /^(a|an|the)\s/i.test(summary),
			length: summary.length <= 78,
			oneLine: !summary.includes('\n'),
			safeAsAPlainScalar: !summary.includes(': ')
		}, {
			endsInAFullStop: false,
			opensWithAnArticle: false,
			length: true,
			oneLine: true,
			safeAsAPlainScalar: true
		});
	});

	test('the description survives the markup it is pasted into', () => {
		// ⚠️ `code.appdata.xml` takes it between `<p>` and `</p>` with no escaping in between, and
		// the RPM spec takes it as the body of `%description`, where a line opening with `%` is a
		// directive. Neither file is generated by anything that would notice.
		const description = JSON.parse(read('product.json')).productDescription;

		assert.deepStrictEqual({
			xmlSpecials: /[<>&]/.test(description),
			opensASpecDirective: description.split('\n').some((l: string) => l.startsWith('%'))
		}, {
			xmlSpecials: false,
			opensASpecDirective: false
		});
	});

	test('the Debian description comes out as one field', () => {
		// ⚠️ Debian continues a field only while the next line starts with a space, and an empty one
		// ends the record. A description pasted in without that prefix is a control file that stops
		// after its first line, which `dpkg-deb` will take and the package will be wrong.
		const product = JSON.parse(read('product.json'));
		const rendered = read('resources/linux/debian/control.template')
			.replace('@@SUMMARY@@', product.productSummary)
			.replace('@@DESCRIPTION_INDENTED@@', product.productDescription.replace(/^/gm, ' '));

		const body = rendered.split(/\r?\n/).slice(rendered.split(/\r?\n/).findIndex(l => l.startsWith('Description:')) + 1);
		assert.deepStrictEqual({
			summaryIsOneLine: !product.productSummary.includes('\n'),
			everyBodyLineIndented: body.filter(l => l.length > 0).every(l => l.startsWith(' ')),
			noEmptyLineInsideBody: !body.slice(0, body.length - 1).some(l => l.length === 0),
			maintainerHasAnAddress: /^.+ <[^@\s]+@[^@\s]+>$/.test(product.packageMaintainer)
		}, {
			summaryIsOneLine: true,
			everyBodyLineIndented: true,
			noEmptyLineInsideBody: true,
			maintainerHasAnAddress: true
		});
	});
});

suite('Facade branding - what must not move', () => {

	test('the licence keeps upstream\'s notice and adds this fork\'s', () => {
		const licence = read('LICENSE.txt');

		// ⚠️ MIT asks for its copyright notice to be included in all copies. Upstream's line is that
		// notice, and it is the reason this fork is allowed to exist; ours sits beside it because the
		// binary is both. Neither one is branding and neither one is ours to take out.
		assert.deepStrictEqual([
			licence.includes('Copyright (c) 2015 - present Microsoft Corporation'),
			licence.includes('Copyright (c) 2026 - present Facade Code contributors'),
			licence.includes('The above copyright notice and this permission notice shall be included in all')
		], [true, true, true]);
	});
});
