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
			publisher: '{#Publisher}',
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
			electron.includes('companyName: product.publisher,'),
			desktop.includes(`'CompanyName': product.publisher,`),
			server.includes(`'CompanyName': productContents.publisher,`),
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

	test('ID-16 Explorer\'s context menu is offered on Windows 10 only: Windows 11 takes its entries from an AppX, which this product does not build', () => {
		const iss = read('build/win32/code.iss');
		const task = (name: string) => iss.split(/\r?\n/).find(l => l.startsWith(`Name: "${name}";`)) ?? '';
		const product = JSON.parse(read('product.json'));

		assert.deepStrictEqual({
			files: task('addcontextmenufiles').includes('OnlyBelowVersion: 10.0.22000'),
			folders: task('addcontextmenufolders').includes('OnlyBelowVersion: 10.0.22000'),
			// `gulpfile.vscode.win32.ts` builds the AppX for these two qualities only
			appx: ['stable', 'insider'].includes(product.quality)
		}, { files: true, folders: true, appx: false });
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

suite('Facade branding - the ids the operating system keeps', () => {

	const product = JSON.parse(read('product.json'));

	/**
	 * Code - OSS's own ids, as upstream's `product.json` carries them. A fork that keeps any of them is the
	 * same application to the operating system: installing one upgrades, overwrites or removes the other.
	 */
	const CODE_OSS: Record<string, string> = {
		win32x64AppId: '{{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}',
		win32arm64AppId: '{{D1ACE434-89C5-48D1-88D3-E2991DF85475}',
		win32x64UserAppId: '{{CC6B787D-37A0-49E8-AE24-8559A032BE0C}',
		win32arm64UserAppId: '{{3AEBF0C8-F733-4AD4-BADE-FDB816D53D7B}',
		darwinProfileUUID: '47827DD9-4734-49A0-AF80-7E19B11495CC',
		darwinProfilePayloadUUID: 'CF808BE7-53F3-46C6-A7E2-7EDB98A5E959',
	};

	test('ID-01 the names, ids and links are IDENTITY.md\'s, and no id the operating system keeps is Code - OSS\'s', () => {
		const pick = (keys: string[]) => Object.fromEntries(keys.map(key => [key, product[key]]));

		assert.deepStrictEqual({
			names: pick(['nameShort', 'nameLong', 'applicationName', 'urlProtocol', 'serverApplicationName', 'tunnelApplicationName', 'linuxIconName', 'dataFolderName', 'sharedDataFolderName', 'serverDataFolderName']),
			ids: pick(['darwinBundleIdentifier', 'win32AppUserModelId', 'win32MutexName', 'win32TunnelServiceMutex', 'win32TunnelMutex', 'win32RegValueName', 'win32DirName', 'win32ShellNameShort']),
			fresh: Object.keys(CODE_OSS).filter(key => typeof product[key] === 'string' && product[key].length > 0 && product[key] !== CODE_OSS[key]),
			distinct: new Set(Object.keys(CODE_OSS).map(key => product[key])).size,
			links: pick(['productHomeUrl', 'licenseUrl', 'serverLicenseUrl', 'reportIssueUrl', 'packageMaintainer', 'publisher']),
			voice: product.voiceWsUrl
		}, {
			names: {
				nameShort: 'Facade Code', nameLong: 'Facade Code', applicationName: 'facade', urlProtocol: 'facade', serverApplicationName: 'facade-server',
				tunnelApplicationName: 'facade-tunnel', linuxIconName: 'facade', dataFolderName: '.facade', sharedDataFolderName: '.facade-shared', serverDataFolderName: '.facade-server'
			},
			ids: {
				darwinBundleIdentifier: 'com.facadecode.FacadeCode', win32AppUserModelId: 'FacadeCode.FacadeCode', win32MutexName: 'facadecode', win32TunnelServiceMutex: 'facadecode-tunnelservice',
				win32TunnelMutex: 'facadecode-tunnel', win32RegValueName: 'FacadeCode', win32DirName: 'Facade Code', win32ShellNameShort: 'F&acade Code'
			},
			fresh: Object.keys(CODE_OSS),
			distinct: Object.keys(CODE_OSS).length,
			links: {
				productHomeUrl: 'https://facadecode.com/',
				licenseUrl: 'https://github.com/y5ez3g/facadecode/blob/main/LICENSE.txt',
				serverLicenseUrl: 'https://github.com/y5ez3g/facadecode/blob/main/LICENSE.txt',
				reportIssueUrl: 'https://github.com/y5ez3g/facadecode/issues/new',
				packageMaintainer: 'Yuanzhe Zhang <y5ez3g@gmail.com>',
				publisher: 'Yuanzhe Zhang'
			},
			voice: undefined
		});
	});

	test('ID-14 the Debian package neither adds nor removes anything of Microsoft\'s apt repository or signing key', () => {
		// What VS Code's own package does, and a package beside it must not: removing this one would take VS
		// Code's updates with it (IDENTITY.md I8)
		const microsoft = /packages\.microsoft\.com|microsoft\.gpg|vscode\.sources|vscode\.list|add-microsoft-repo/;
		const scripts = ['postinst', 'postrm', 'prerm'];

		assert.deepStrictEqual({
			scripts: scripts.map(script => [script, microsoft.test(read(`resources/linux/debian/${script}.template`))]),
			asks: fs.existsSync(path.join(root, 'resources/linux/debian/templates.template')) || read('build/gulpfile.vscode.linux.ts').includes('templates.template')
		}, {
			scripts: scripts.map(script => [script, false]),
			asks: false
		});
	});
});

suite('Facade branding - the Linux policy file', () => {

	test('ID-17 the policy is read from the product\'s own file, named after it, and not VS Code\'s', () => {
		const policy = read('src/vs/base/common/policy.ts');
		const readers = ['src/vs/code/electron-main/main.ts', 'src/vs/code/node/cliProcessMain.ts'].map(read);

		assert.deepStrictEqual({
			path: policy.includes('return `/etc/${applicationName}/policy.json`;'),
			// As a string the code reads, not the comment that says why it is not upstream's
			vscodes: [policy, ...readers].some(text => /['"`]\/etc\/vscode\//.test(text)),
			readers: readers.map(text => text.includes('linuxSystemPolicyFilePath(productService.applicationName)')),
			applicationName: JSON.parse(read('product.json')).applicationName
		}, { path: true, vscodes: false, readers: [true, true], applicationName: 'facade' });
	});
});

suite('Facade branding - the repository', () => {

	test('ID-20 its SECURITY.md, README.md and issue templates are Facade\'s, point to its repository, and name no Microsoft contact', () => {
		const files = ['SECURITY.md', 'README.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md', '.github/ISSUE_TEMPLATE/config.yml'];
		// VS Code the project may be named - it is what this builds on; Microsoft's channels may not be offered as this one's
		const microsoftContact = /aka\.ms|opensource\.microsoft\.com|code\.visualstudio\.com|microsoft\/vscode\/issues|vscode-discussions|stackoverflow\.com/i;

		assert.deepStrictEqual({
			contacts: files.filter(file => microsoftContact.test(read(file))),
			pointHome: files.filter(file => read(file).includes('github.com/y5ez3g/facadecode')),
			copilot: fs.existsSync(path.join(root, '.github/ISSUE_TEMPLATE/copilot_bug_report.md'))
		}, { contacts: [], pointHome: files, copilot: false });
	});
});

suite('Facade branding - sign-in and AI', () => {

	test('ID-15 Microsoft sign-in is not shipped', () => {
		const excluded = /const excludedExtensions = \[([^\]]*)\]/.exec(read('build/lib/extensions.ts'))?.[1] ?? '';

		assert.ok(excluded.includes(`'microsoft-authentication'`), excluded);
	});

	test('ID-06 AI features are off in a fresh profile: the setting that hides them defaults to on', () => {
		const contribution = read('src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts');
		const at = contribution.indexOf('[ChatAIDisabledSettingId]: {');
		// the setting's schema, up to the next setting's key
		const schema = at === -1 ? '' : contribution.slice(at, contribution.indexOf('\n\t\t[', at));

		assert.deepStrictEqual({
			id: read('src/vs/platform/chat/common/chatSettings.ts').includes(`export const ChatAIDisabledSettingId = 'chat.disableAIFeatures';`),
			default: /^\s*default: true,\s*$/m.test(schema)
		}, { id: true, default: true });
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
