/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The globs plans use for `owns`, `scaffold.paths` and hotspots. Small on purpose: `**`, `*`, `?`,
 * `{a,b}` and `[...]`, relative to the repository root, always with `/`.
 *
 * A pattern without wildcards names a path and everything below it, so `src/agents` owns the folder
 * as the lead meant it, and `src/agents/claude.ts` owns just the file.
 */

export type PathMatcher = (path: string) => boolean;

/** `a\b`, `./a/b` and `a//b` all become `a/b`. */
export function normalizePath(path: string): string {
	let result = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	while (result.startsWith('./')) {
		result = result.slice(2);
	}
	return result.endsWith('/') && result.length > 1 ? result.slice(0, -1) : result;
}

export function isGlob(pattern: string): boolean {
	return /[*?[\]{}]/.test(pattern);
}

/**
 * Compiles a pattern to a matcher. Paths are compared case-insensitively where the file system
 * usually is (Windows and macOS), because a lead may not type the casing git reports.
 */
export function compileGlob(pattern: string, ignoreCase = process.platform === 'win32' || process.platform === 'darwin'): PathMatcher {
	const normalized = normalizePath(pattern);
	const flags = ignoreCase ? 'i' : '';
	if (!isGlob(normalized)) {
		const literal = ignoreCase ? normalized.toLowerCase() : normalized;
		return path => {
			const candidate = ignoreCase ? normalizePath(path).toLowerCase() : normalizePath(path);
			return candidate === literal || candidate.startsWith(`${literal}/`);
		};
	}
	const regex = new RegExp(`^${toRegexSource(normalized)}$`, flags);
	return path => regex.test(normalizePath(path));
}

/** Whether any of `patterns` matches `path`. */
export function matchesAny(patterns: readonly string[], path: string, ignoreCase?: boolean): boolean {
	return patterns.some(pattern => compileGlob(pattern, ignoreCase)(path));
}

function toRegexSource(pattern: string): string {
	let source = '';
	let index = 0;
	let inGroup = false;
	while (index < pattern.length) {
		const char = pattern[index];
		if (char === '*') {
			if (pattern[index + 1] === '*') {
				const atStart = index === 0 || pattern[index - 1] === '/';
				const atEnd = index + 2 === pattern.length || pattern[index + 2] === '/';
				if (atStart && atEnd) {
					if (index + 2 === pattern.length) {
						// `a/**` is everything below `a`; `**` alone is everything.
						source += '.*';
						index += 2;
					} else {
						// `**/` is zero or more whole segments.
						source += '(?:[^/]*/)*';
						index += 3;
					}
					continue;
				}
				// `a**b` is two single stars.
				source += '[^/]*';
				index += 2;
				continue;
			}
			source += '[^/]*';
			index++;
			continue;
		}
		if (char === '?') {
			source += '[^/]';
			index++;
			continue;
		}
		if (char === '[') {
			const close = pattern.indexOf(']', index + 1);
			if (close > index + 1) {
				let body = pattern.slice(index + 1, close);
				if (body.startsWith('!')) {
					body = `^${body.slice(1)}`;
				}
				source += `[${body.replace(/\\/g, '\\\\')}]`;
				index = close + 1;
				continue;
			}
		}
		if (char === '{' && !inGroup) {
			inGroup = true;
			source += '(?:';
			index++;
			continue;
		}
		if (char === '}' && inGroup) {
			inGroup = false;
			source += ')';
			index++;
			continue;
		}
		if (char === ',' && inGroup) {
			source += '|';
			index++;
			continue;
		}
		source += char.replace(/[.+^$()|\\{}[\]]/g, '\\$&');
		index++;
	}
	if (inGroup) {
		throw new Error(`Unclosed "{" in glob: ${pattern}`);
	}
	return source;
}
