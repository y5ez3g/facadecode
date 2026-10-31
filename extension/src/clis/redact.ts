/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Secrets kept out of what Facade shows and logs (CLIS-4.1, ARCHITECTURE-3.3): a value under a secret's name, and the secrets text
// carries - an authorization header, a bearer credential, a URL's password, a secret's `NAME=value`.

import { isJsonObject } from '../base/json';

/**
 * The names of variables, settings, options and keys whose values are secrets, which the document never shows (CLIS-4.1): a token -
 * not a count of tokens - a secret, a password, a key, a personal access token, credentials, authorization, a cookie.
 */
const SECRET_NAME = /token(?!s)|secret|passw(?:or)?d|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth|cookie|bearer|session[-_]?key|(?:^|[-_.])(?:key|pat|pass)$/i;
const REDACTED = '<redacted>';

/** Whether `value` holds a value of its own, not only `${name}`s filled in later - which name no secret. */
function holdsValue(value: string): boolean {
	return value.replace(/\$\{[^}]*\}/g, '').trim() !== '';
}

/** An authorization header in text, its value to its end: `Authorization: Bearer x`, `"Proxy-Authorization": "Basic x"`. */
const AUTHORIZATION = /\b(?<name>(?:proxy-)?authorization)(?<separator>["']?\s*[:=]\s*["']?)(?<value>[^\r\n"',;}]*)/gi;
/** A bearer credential in text: `Bearer x`. */
const BEARER = /\b(?<scheme>bearer)\s+(?<value>[^\s"',;}]+)/gi;
/** A URL's password: `https://user:password@host`. */
const URL_PASSWORD = /\b(?<prefix>[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)(?<value>[^\s@/]+)@/gi;
/** A name and its value in text such as JSON, TOML or a list of settings: `"NAME": "value"`, `NAME = 'value'`, `NAME=value`. */
const NAMED_VALUE = /(?<key>(?<quote>["']?)(?<name>[A-Za-z_][\w.-]*)\k<quote>\s*[:=]\s*)(?<value>"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"',;{}[\]]+)/g;

/**
 * `text` with the secrets inside it redacted: a JSON value's secret members, an authorization header or bearer credential, a URL's
 * password, and the value of a secret's name in text such as `"API_KEY": "x"` or `TOKEN=x`. Text with none stays exactly as it is.
 */
export function redactedText(text: string): string {
	if (/^\s*[[{]/.test(text)) {
		try {
			const value: unknown = JSON.parse(text);
			const shown = redacted(value);
			return JSON.stringify(shown) === JSON.stringify(value) ? text : JSON.stringify(shown);
		} catch {
			// Not JSON: read as text
		}
	}
	return text
		.replace(AUTHORIZATION, (whole, name: string, separator: string, value: string) => holdsValue(value) ? `${name}${separator}${REDACTED}` : whole)
		.replace(BEARER, (whole, scheme: string, value: string) => value === REDACTED || !holdsValue(value) ? whole : `${scheme} ${REDACTED}`)
		.replace(URL_PASSWORD, (_whole, prefix: string) => `${prefix}${REDACTED}@`)
		.replace(NAMED_VALUE, (whole, key: string, _quote: string, name: string, value: string) => {
			const quoted = /^["']/.test(value) ? value[0] : '';
			const inner = quoted ? value.slice(1, -1) : value;
			return SECRET_NAME.test(name) && inner !== REDACTED && holdsValue(inner) ? `${key}${quoted}${REDACTED}${quoted}` : whole;
		});
}

/**
 * `value` - arguments, an environment map, or any JSON - with every secret in it redacted (CLIS-4.1): a variable's, a setting's or a
 * member's value under a secret's name, an option's value after a secret's option or its `=`, a `NAME=value` of a secret's name, and
 * the secrets inside text - a JSON value, an authorization header, a bearer credential, a `"NAME": "value"` of a secret's name.
 */
export function redacted(value: unknown, name?: string): unknown {
	const secret = name !== undefined && SECRET_NAME.test(name);
	// A number under a secret's name is one too: a PIN, a numeric password
	if (secret && (typeof value === 'number' || typeof value === 'bigint')) {
		return REDACTED;
	}
	if (typeof value === 'string') {
		return secret && holdsValue(value) ? REDACTED : redactedText(value);
	}
	if (Array.isArray(value)) {
		if (secret) {
			return REDACTED;
		}
		return value.map((each: unknown, i) => {
			if (typeof each !== 'string') {
				return redacted(each);
			}
			const option: unknown = value[i - 1];
			if (typeof option === 'string' && /^-{1,2}[\w.-]+$/.test(option) && SECRET_NAME.test(option) && !each.startsWith('-') && holdsValue(each)) {
				return REDACTED;
			}
			const assigned = /^(?<key>-{0,2}[\w.-]+)=(?<rest>[\s\S]*)$/.exec(each)?.groups;
			if (assigned && SECRET_NAME.test(assigned.key) && holdsValue(assigned.rest)) {
				return `${assigned.key}=${REDACTED}`;
			}
			return assigned ? `${assigned.key}=${redactedText(assigned.rest)}` : redactedText(each);
		});
	}
	if (isJsonObject(value)) {
		return secret ? REDACTED : Object.fromEntries(Object.entries(value).map(([key, each]) => [key, redacted(each, key)]));
	}
	return value;
}
