// Localization exporter and checker (ARCHITECTURE-4.4, UX-5.1). Repository-owned and repeatable: it reads the code with the
// repository's pinned `typescript` and the translations under l10n/, and needs no language pack or temporary file.
//
//   node scripts/l10n.mjs export   rewrites l10n/bundle.l10n.json with exactly the texts the code passes to vscode.l10n.t
//   node scripts/l10n.mjs check    fails, with a readable list, on any key, placeholder or manifest mismatch in any locale
//
// `--root <dir>` reads (and, for export, writes) another checkout laid out like this one; the tests use it for fixtures.
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');

/** The translated languages (UX-2.4); English is the source and the fallback. */
export const LOCALES = ['zh-cn', 'zh-tw', 'pt-br', 'es', 'ru', 'de', 'ja', 'fr', 'ko', 'tr', 'pl'];

const REPOSITORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function layout(root) {
	const l10n = path.join(root, 'l10n');
	return {
		root,
		l10n,
		src: path.join(root, 'src'),
		test: path.join(root, 'src', 'test'),
		manifest: path.join(root, 'package.json'),
		windowManifest: path.join(root, 'window', 'package.json'),
		bundle: path.join(l10n, 'bundle.l10n.json'),
		nls: path.join(l10n, 'package.nls.json')
	};
}

const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function sourceFiles(dir, skip) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (file !== skip) {
				files.push(...sourceFiles(file, skip));
			}
		} else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
			files.push(file);
		}
	}
	return files;
}

/** A string literal's text, or undefined when the expression is not a literal. */
function literal(node) {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** `l10n.t` or `<anything>.l10n.t`. */
function isL10nT(node) {
	return ts.isPropertyAccessExpression(node) && node.name.text === 't'
		&& ((ts.isIdentifier(node.expression) && node.expression.text === 'l10n')
			|| (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'l10n'));
}

/** The message (and comment) of one call's first argument, or a problem saying why it cannot be read. */
function readMessage(arg) {
	if (!arg) {
		return { problem: 'no message argument' };
	}
	const text = literal(arg);
	if (text !== undefined) {
		return { message: text };
	}
	if (ts.isObjectLiteralExpression(arg)) {
		let message;
		let comment = [];
		for (const property of arg.properties) {
			if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
				return { problem: 'an object message with a property that is not a plain `name: value`' };
			}
			const name = property.name.text;
			if (name === 'message') {
				message = literal(property.initializer);
				if (message === undefined) {
					return { problem: '`message` is not a string literal' };
				}
			} else if (name === 'comment') {
				const value = property.initializer;
				if (literal(value) !== undefined) {
					comment = [literal(value)];
				} else if (ts.isArrayLiteralExpression(value) && value.elements.every(element => literal(element) !== undefined)) {
					comment = value.elements.map(literal);
				} else {
					return { problem: '`comment` is not a string literal or an array of string literals' };
				}
			}
			// `args` may be anything: it is not part of the text
		}
		if (message === undefined) {
			return { problem: 'an object message without `message`' };
		}
		return comment.length ? { message, comment } : { message };
	}
	return { problem: `the message is not a string literal but an expression (${ts.SyntaxKind[arg.kind]})` };
}

/**
 * Every text the code (src/ without src/test) passes to vscode.l10n.t, keyed as VS Code looks it up (`message`, or
 * `message/comment` for the object form), in order of first appearance (files by path, then position); and every call or
 * reference whose text cannot be read.
 */
export function collect(root = REPOSITORY) {
	const at = layout(root);
	const texts = new Map();
	const problems = [];
	for (const file of sourceFiles(at.src, at.test)) {
		const code = fs.readFileSync(file, 'utf8');
		if (!/\bl10n\b/.test(code)) {
			continue;
		}
		const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		const where = node => {
			const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
			return `${path.relative(root, file).split(path.sep).join('/')}:${line + 1}:${character + 1}`;
		};
		const visit = node => {
			if (isL10nT(node)) {
				const call = node.parent;
				if (!(ts.isCallExpression(call) && call.expression === node)) {
					problems.push(`${where(node)}: vscode.l10n.t is used other than by calling it directly, so its texts cannot be read`);
				} else {
					const read = readMessage(call.arguments[0]);
					if (read.problem) {
						problems.push(`${where(call)}: ${read.problem}: ${call.getText(source).replace(/\s+/g, ' ').slice(0, 120)}`);
					} else {
						const key = read.comment ? `${read.message}/${read.comment.join('')}` : read.message;
						if (!texts.has(key)) {
							texts.set(key, { ...read, at: where(call) });
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { texts, problems };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const serialize = value => `${JSON.stringify(value, undefined, '\t')}\n`;

/** The English bundle `export` writes: the code's texts, each English value its key, any existing `{ message, comment }` kept. */
function englishFor(texts, existing) {
	const bundle = {};
	for (const [key, { message, comment }] of texts) {
		const old = existing[key];
		bundle[key] = comment ? { message, comment } : old && typeof old === 'object' && old.message === message ? old : message;
	}
	return bundle;
}

const messageOf = value => typeof value === 'string' ? value : value?.message;

const placeholders = text => [...new Set([...text.matchAll(/\{(\d+)\}/g)].map(match => match[0]))].sort();

/** `code` spans in a manifest text: setting names, values and variables a translation keeps as they are. */
const codeSpans = text => [...text.matchAll(/`[^`]*`/g)].map(match => match[0]).sort();

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

const quote = text => JSON.stringify(text.length > 100 ? `${text.slice(0, 97)}...` : text);

/** Every string value in the manifest that is exactly `%key%`, as VS Code substitutes them. */
function manifestKeys(value, keys = new Set()) {
	if (typeof value === 'string') {
		const match = /^%(.+)%$/.exec(value);
		if (match) {
			keys.add(match[1]);
		}
	} else if (Array.isArray(value)) {
		value.forEach(item => manifestKeys(item, keys));
	} else if (value && typeof value === 'object') {
		Object.values(value).forEach(item => manifestKeys(item, keys));
	}
	return keys;
}

/** Reads a JSON file, recording why it cannot be read instead of throwing. */
function readOrRecord(problems, file, name) {
	if (!fs.existsSync(file)) {
		problems.push(`${name}: missing`);
		return undefined;
	}
	try {
		const value = readJson(file);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			problems.push(`${name}: not a JSON object`);
			return undefined;
		}
		return value;
	} catch (error) {
		problems.push(`${name}: not valid JSON: ${error.message}`);
		return undefined;
	}
}

function checkTranslations(problems, english, kind, translated, name, compare) {
	for (const key of Object.keys(english)) {
		if (!(key in translated)) {
			problems.push(`${name}: missing ${kind} ${quote(key)}`);
		}
	}
	for (const [key, value] of Object.entries(translated)) {
		if (!(key in english)) {
			problems.push(`${name}: obsolete ${kind} ${quote(key)}`);
			continue;
		}
		const text = messageOf(value);
		if (typeof text !== 'string' || !text.trim()) {
			problems.push(`${name}: ${quote(key)} has no translation`);
			continue;
		}
		compare(key, messageOf(english[key]), text);
	}
}

/** Every localization problem of the checkout at `root`, as readable lines; empty when clean. */
export function check(root = REPOSITORY) {
	const at = layout(root);
	const problems = [];
	const { texts, problems: unreadable } = collect(root);
	problems.push(...unreadable);

	// (e) The English bundle is what `export` writes
	const english = readOrRecord(problems, at.bundle, 'bundle.l10n.json');
	if (english) {
		const expected = englishFor(texts, english);
		const before = problems.length;
		for (const key of Object.keys(expected)) {
			if (!(key in english)) {
				problems.push(`bundle.l10n.json: missing ${quote(key)} (${texts.get(key).at}); run \`node scripts/l10n.mjs export\``);
			}
		}
		for (const key of Object.keys(english)) {
			if (!(key in expected)) {
				problems.push(`bundle.l10n.json: ${quote(key)} is not in the code; run \`node scripts/l10n.mjs export\``);
			} else if (JSON.stringify(english[key]) !== JSON.stringify(expected[key])) {
				problems.push(`bundle.l10n.json: ${quote(key)} is not its English text; run \`node scripts/l10n.mjs export\``);
			}
		}
		// Its line endings are the checkout's: Git's core.autocrlf gives a Windows checkout CRLF in place of what export writes
		if (problems.length === before && fs.readFileSync(at.bundle, 'utf8').replace(/\r\n/g, '\n') !== serialize(expected)) {
			problems.push('bundle.l10n.json: its order or layout is not what `export` writes; run `node scripts/l10n.mjs export`');
		}

		// (a), (b) Each translated bundle has the English keys alone, each with the English placeholders
		for (const locale of LOCALES) {
			const name = `bundle.l10n.${locale}.json`;
			const translated = readOrRecord(problems, path.join(at.l10n, name), name);
			if (translated) {
				checkTranslations(problems, english, 'text', translated, name, (key, source, text) => {
					if (!sameList(placeholders(source), placeholders(text))) {
						problems.push(`${name}: ${quote(key)} has placeholders ${placeholders(text).join(' ') || 'none'}, the English ${placeholders(source).join(' ') || 'none'}`);
					}
				});
			}
		}
	}

	// (d) The manifest's %key% strings and package.nls.json are the same set
	const nls = readOrRecord(problems, at.nls, 'package.nls.json');
	const manifest = readOrRecord(problems, at.manifest, 'package.json');
	if (nls && manifest) {
		const used = manifestKeys(manifest);
		if (fs.existsSync(at.windowManifest) || manifest.extensionPack?.includes('facade.facadecode-window')) {
			const windowManifest = readOrRecord(problems, at.windowManifest, 'window/package.json');
			if (windowManifest) { manifestKeys(windowManifest, used); }
		}
		for (const key of used) {
			if (!(key in nls)) {
				problems.push(`package.nls.json: missing "${key}", which package.json uses as %${key}%`);
			}
		}
		for (const key of Object.keys(nls)) {
			if (!used.has(key)) {
				problems.push(`package.nls.json: "${key}" is not used by package.json`);
			}
		}
	}

	// (c) Each translated package.nls has the English keys alone, its `code` spans kept as they are
	if (nls) {
		for (const locale of LOCALES) {
			const name = `package.nls.${locale}.json`;
			const translated = readOrRecord(problems, path.join(at.l10n, name), name);
			if (translated) {
				checkTranslations(problems, nls, 'key', translated, name, (key, source, text) => {
					if (!sameList(codeSpans(source), codeSpans(text))) {
						problems.push(`${name}: "${key}" changes the \`code\` spans of the English: ${codeSpans(source).join(' ') || 'none'} -> ${codeSpans(text).join(' ') || 'none'}`);
					}
				});
			}
		}
	}

	// No translation for a language this product does not ship
	for (const file of fs.readdirSync(at.l10n)) {
		const match = /^(?:bundle\.l10n|package\.nls)\.(.+)\.json$/.exec(file);
		if (match && !LOCALES.includes(match[1])) {
			problems.push(`${file}: ${match[1]} is not a supported language (UX-2.4)`);
		}
	}
	return problems;
}

/** Rewrites the English bundle from the code; returns what changed, or the calls whose text cannot be read. */
export function exportBundle(root = REPOSITORY) {
	const at = layout(root);
	const { texts, problems } = collect(root);
	if (problems.length) {
		return { problems };
	}
	const existing = fs.existsSync(at.bundle) ? readJson(at.bundle) : {};
	const bundle = englishFor(texts, existing);
	fs.writeFileSync(at.bundle, serialize(bundle));
	return {
		problems,
		count: Object.keys(bundle).length,
		added: Object.keys(bundle).filter(key => !(key in existing)).length,
		removed: Object.keys(existing).filter(key => !(key in bundle)).length
	};
}

function main(args) {
	const rootAt = args.indexOf('--root');
	const root = rootAt >= 0 ? path.resolve(args[rootAt + 1] ?? '.') : REPOSITORY;
	const command = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--root');
	const list = problems => problems.map(problem => `  ${problem}`).join('\n');
	if (command === 'export') {
		const { problems, count, added, removed } = exportBundle(root);
		if (problems.length) {
			console.error(`l10n export: ${problems.length} call(s) whose text cannot be read:\n${list(problems)}`);
			process.exitCode = 1;
			return;
		}
		console.log(`l10n export: ${count} texts in l10n/bundle.l10n.json (${added} added, ${removed} removed)`);
	} else if (command === 'check') {
		const problems = check(root);
		if (problems.length) {
			console.error(`l10n check: ${problems.length} problem(s):\n${list(problems)}`);
			process.exitCode = 1;
			return;
		}
		const at = layout(root);
		console.log(`l10n check: ${Object.keys(readJson(at.bundle)).length} runtime texts and ${Object.keys(readJson(at.nls)).length} manifest strings, complete in English and ${LOCALES.length} languages`);
	} else {
		console.error('usage: node scripts/l10n.mjs export|check [--root <dir>]');
		process.exitCode = 2;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
