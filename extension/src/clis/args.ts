/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The arguments a person gives a built-in CLI (CONFIGURATION-3.1, CLIS-3.1): options and their values, passed as written. What
// Facade sets or decides itself is not among them - approvals and sandbox (`yolo`), model and effort (`model`, `effort`), the
// folder, the session and where it runs, the terminal and the first task - in any spelling the CLI takes: an alias, a value apart or
// after `=`, a configuration override of the same key, its parent or a key below it. An argument that is no option's value is a task,
// a file or a folder to the CLI, so it is refused too. Each argument is read once, as the CLI's own parser reads it: an option the CLI
// always gives a value takes the argument after it whatever it looks like; any other option takes it only where it does not start
// with `-` - so an option Facade does not know, which a CLI may add later, is never refused for its value. Validation, migration and
// what Facade takes from or merges into the arguments all read them this one way (CLIS-3.1).

import { parse as parseToml } from 'smol-toml';
import type { CliProblem } from './config';

/** The arguments of a built-in CLI that Facade sets or decides itself (CONFIGURATION-3.1). */
export interface ArgsGrammar {
	/** Options Facade sets or decides itself, every spelling of each. */
	readonly reserved: readonly string[];
	/** Of `reserved`, the short options a value can be written right after, as in `-mgpt-5`. */
	readonly attached?: readonly string[];
	/** The CLI's configuration override options - Codex's `-c` and `--config` - and the keys of them Facade sets itself. */
	readonly config?: { readonly options: readonly string[]; readonly reserved: readonly string[] };
	/** Options that take every argument after them up to the next option, as Claude Code's `--add-dir a b` does. */
	readonly variadic?: readonly string[];
	/**
	 * Whether its CLI reads an option after one dash or two alike, as Go's flag package does: `-mode` is `--mode`, `--p` is `-p`, and
	 * `-p=true` is `-p` given `true`. It reads no run of short options.
	 */
	readonly singleDash?: boolean;
	/**
	 * The short options of a CLI that reads the letters after a single dash as short options each, as commander, clap and yargs do -
	 * `-cp` is `-c -p` - that take a value: the rest of such a run is that value, as in `-pwork`.
	 */
	readonly clusters?: { readonly values: readonly string[] };
	/**
	 * The options its CLI always gives a value, which take the argument after one alone whatever it looks like - as Commander takes
	 * an option written `<value>`, Go's flag package a flag that is no switch, and Pi its value options: Claude Code's
	 * `--append-system-prompt --model=x` appends the text `--model=x`. Any other option takes the next argument only where that does
	 * not start with `-`, as clap and yargs read one.
	 */
	readonly required?: readonly string[];
	/** Whether its CLI reads `--name=value` as `--name` and its value; Pi's parser does not, taking it as a flag it does not know. */
	readonly equalsValue?: boolean;
}

/**
 * One unit of a CLI's arguments as its parser reads them (CLIS-3.1): an option with the arguments that are its value, a configuration
 * override with its text, a positional argument, or the end of the options - each at its index, spanning its arguments.
 */
export type ArgumentUnit = {
	readonly kind: 'option';
	readonly index: number;
	readonly span: number;
	/** The option as written, before `=` or an attached value - `--model`, `-m`, a Go program's `-model` - or a run of short options whole. */
	readonly option: string;
	/** How its value is written: after `=`, right after a short option, as the arguments after it, not at all, or in a run of short options. */
	readonly form: 'equals' | 'attached' | 'apart' | 'none' | 'cluster';
	/** Its value, or a list option's values. */
	readonly values: readonly string[];
} | {
	readonly kind: 'override';
	readonly index: number;
	readonly span: number;
	/** `-c` or `--config`, as written. */
	readonly option: string;
	/** Its `key=value` text; none where it has none. */
	readonly text: string | undefined;
} | {
	readonly kind: 'positional' | 'end';
	readonly index: number;
	readonly span: 1;
};

/** An option among a CLI's arguments, with its value. */
type OptionUnit = Extract<ArgumentUnit, { readonly kind: 'option' }>;

/** An argument refused: an option or configuration key Facade sets itself, or one that is no option's value. */
export type Refusal = { readonly kind: 'option'; readonly index: number; readonly option: string }
	| { readonly kind: 'key'; readonly index: number; readonly key: string }
	| { readonly kind: 'positional'; readonly index: number };

/** The segments of a configuration key: `mcp_servers."a.b".command` is `mcp_servers`, `a.b`, `command`. */
function keySegments(key: string): string[] {
	const segments: string[] = [];
	let current = '';
	let quote: string | undefined;
	for (const char of key.trim()) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '.') {
			segments.push(current.trim());
			current = '';
		} else {
			current += char;
		}
	}
	segments.push(current.trim());
	return segments;
}

/** Whether the keys `a` and `b` are the same, or one is below the other: setting either sets the other's value. */
function overlaps(a: string, b: string): boolean {
	const left = keySegments(a);
	const right = keySegments(b);
	return left.slice(0, Math.min(left.length, right.length)).every((segment, index) => segment === right[index]);
}

/**
 * The name `grammar`'s CLI looks the option `written` up by: as written for most, before any `=` given; for a Go program, without its
 * one dash or two - `-p`, `--p` and `-p=true` are all `p`.
 */
function optionName(written: string, grammar: ArgsGrammar): string {
	return grammar.singleDash ? written.replace(/^--?/, '').split('=', 1)[0] : written;
}

/** Whether the option written `written` is `option`, as `grammar`'s CLI reads its options' names (CLIS-3.1). */
export function isOption(written: string, option: string, grammar: ArgsGrammar): boolean {
	return optionName(written, grammar) === optionName(option, grammar);
}

/** Whether `grammar`'s CLI gives `option` the argument after it whatever that looks like. */
function takesAny(option: string, grammar: ArgsGrammar): boolean {
	return grammar.required?.some(each => isOption(option, each, grammar)) ?? false;
}

/** The configuration override at `index` of `args` - `-c key=value`, `--config=key=value` or `-ckey=value` - and what it spans; none for another argument. */
function overrideAt(args: readonly string[], index: number, grammar: ArgsGrammar): ArgumentUnit | undefined {
	const arg = args[index];
	for (const option of grammar.config?.options ?? []) {
		if (arg === option) {
			const next = args[index + 1];
			const taken = next !== undefined && (!next.startsWith('-') || takesAny(option, grammar));
			return { kind: 'override', index, span: taken ? 2 : 1, option, text: taken ? next : undefined };
		}
		if (arg.startsWith(`${option}=`)) {
			return { kind: 'override', index, span: 1, option, text: arg.slice(option.length + 1) };
		}
		// A short option's value may follow it at once: `-ckey=value`
		if (/^-[^-]$/.test(option) && arg.startsWith(option) && arg.length > option.length) {
			return { kind: 'override', index, span: 1, option, text: arg.slice(option.length) };
		}
	}
	return undefined;
}

/** The option `option` at `index` of `args`, alone in its argument: with the arguments after it that are its value. */
function apart(args: readonly string[], index: number, option: string, grammar: ArgsGrammar): OptionUnit {
	const most = grammar.variadic?.some(each => isOption(option, each, grammar)) ? Infinity : 1;
	const values: string[] = [];
	let at = index + 1;
	if (takesAny(option, grammar) && at < args.length) {
		values.push(args[at++]);
	}
	while (values.length < most && at < args.length && !args[at].startsWith('-')) {
		values.push(args[at++]);
	}
	return { kind: 'option', index, span: at - index, option, form: values.length ? 'apart' : 'none', values };
}

/** The option at `index` of `args`, which starts with `-`, and the arguments that are its value. */
function optionAt(args: readonly string[], index: number, grammar: ArgsGrammar): OptionUnit {
	const arg = args[index];
	const long = arg.startsWith('--') || (grammar.singleDash === true && /^-[^-]{2,}/.test(arg));
	const equals = arg.indexOf('=');
	if (long || !grammar.clusters || arg.length === 2 || equals === 2) {
		// Its value after `=`: a Go program's `-p=true` is `-p` given `true`
		if (equals > 1 && grammar.equalsValue !== false) {
			return { kind: 'option', index, span: 1, option: arg.slice(0, equals), form: 'equals', values: [arg.slice(equals + 1)] };
		}
		const attached = long ? undefined : grammar.attached?.find(each => arg.startsWith(each) && arg.length > each.length);
		if (attached !== undefined) {
			return { kind: 'option', index, span: 1, option: attached, form: 'attached', values: [arg.slice(attached.length)] };
		}
		return apart(args, index, arg, grammar);
	}
	// A run of short options, each letter its own, up to one that takes a value: the rest of the run, or else the next argument
	for (let at = 1; at < arg.length && /[A-Za-z0-9]/.test(arg[at]); at++) {
		const option = `-${arg[at]}`;
		if (grammar.clusters.values.includes(option)) {
			const rest = arg.slice(at + 1);
			if (rest) {
				return at === 1 ? { kind: 'option', index, span: 1, option, form: 'attached', values: [rest] } : { kind: 'option', index, span: 1, option: arg, form: 'cluster', values: [rest] };
			}
			return { ...apart(args, index, option, grammar), option: arg, form: 'cluster' };
		}
	}
	// None takes one: its last may be an option Facade does not know, which takes a value
	return { ...apart(args, index, arg, grammar), form: 'cluster' };
}

/**
 * `args` as `grammar`'s CLI reads them (CLIS-3.1), each argument in one unit: an option with its value - after `=`, attached, or the
 * arguments after it, as 3.1 has a value read - a configuration override, a positional argument, or `--` and every argument after it.
 * An argument taken as a value is never read again as an option or the end of the options.
 */
export function argumentUnits(args: readonly string[], grammar: ArgsGrammar): ArgumentUnit[] {
	const units: ArgumentUnit[] = [];
	for (let index = 0; index < args.length;) {
		const arg = args[index];
		if (arg === '--') {
			units.push({ kind: 'end', index, span: 1 });
			for (let after = index + 1; after < args.length; after++) {
				units.push({ kind: 'positional', index: after, span: 1 });
			}
			break;
		}
		const unit: ArgumentUnit = !arg.startsWith('-') || arg === '-' ? { kind: 'positional', index, span: 1 } : overrideAt(args, index, grammar) ?? optionAt(args, index, grammar);
		units.push(unit);
		index += unit.span;
	}
	return units;
}

/** The configuration overrides of `args` that `grammar`'s CLI reads, in their order: each option's text as `key` and `value`. */
export function configOverrides(args: readonly string[], grammar: ArgsGrammar): { readonly index: number; readonly span: number; readonly key: string; readonly value?: string }[] {
	return argumentUnits(args, grammar).flatMap(unit => {
		if (unit.kind !== 'override' || unit.text === undefined) {
			return [];
		}
		const at = unit.text.indexOf('=');
		return [{ index: unit.index, span: unit.span, key: (at < 0 ? unit.text : unit.text.slice(0, at)).trim(), ...at < 0 ? {} : { value: unit.text.slice(at + 1) } }];
	});
}

/**
 * The option of `grammar.reserved` that the option argument `arg` names, in any spelling its CLI reads - alone, `--x=value`, a short
 * option with its value attached, a long option after a single dash, or one of a run of short options.
 */
function reservedIn(arg: string, grammar: ArgsGrammar): string | undefined {
	const whole = grammar.reserved.find(option => grammar.singleDash ? isOption(arg, option, grammar) : arg === option || arg.startsWith(`${option}=`));
	if (whole !== undefined) {
		return whole;
	}
	const attached = grammar.attached?.find(option => arg.startsWith(option) && arg.length > option.length && !arg.startsWith('--'));
	if (attached !== undefined) {
		return attached;
	}
	if (!grammar.clusters || arg.startsWith('--')) {
		return undefined;
	}
	// Each letter its own short option, up to one that takes the rest as its value
	for (let at = 1; at < arg.length; at++) {
		const option = `-${arg[at]}`;
		if (grammar.reserved.includes(option)) {
			return option;
		}
		if (!/[A-Za-z0-9]/.test(arg[at]) || grammar.clusters.values.includes(option)) {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The arguments of `args` that `grammar` refuses (CONFIGURATION-3.1), read as its CLI reads them: each option or configuration key
 * Facade sets itself, and each argument that is no option's value - after `--`, every one, as the end of the options is Facade's to
 * place, before the task it gives.
 */
export function refusedArguments(args: readonly string[], grammar: ArgsGrammar): Refusal[] {
	return argumentUnits(args, grammar).flatMap((unit): Refusal[] => {
		switch (unit.kind) {
			case 'end': return [{ kind: 'option', index: unit.index, option: '--' }];
			case 'positional': return [{ kind: 'positional', index: unit.index }];
			case 'override': {
				const key = unit.text === undefined ? '' : unit.text.split('=', 1)[0];
				const owned = key ? grammar.config?.reserved.find(each => overlaps(each, key)) : undefined;
				return owned !== undefined ? [{ kind: 'key', index: unit.index, key: key.trim() }] : [];
			}
			case 'option': {
				const option = reservedIn(args[unit.index], grammar);
				return option !== undefined ? [{ kind: 'option', index: unit.index, option }] : [];
			}
		}
	});
}

function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/** The problems of `args` at `setting` under `grammar` (CONFIGURATION-3.1, 4.1): by place and option, never an argument's value. */
export function argsProblems(args: readonly string[], grammar: ArgsGrammar, setting: string): CliProblem[] {
	return refusedArguments(args, grammar).map(each => {
		const at = `${setting}[${each.index}]`;
		switch (each.kind) {
			case 'option': return problem(`${at} is ${each.option}, which Facade sets or decides itself; remove it`, 'args_reserved', setting, String(each.index), each.option);
			case 'key': return problem(`${at} sets ${each.key}, which Facade sets itself; remove it`, 'args_reserved_key', setting, String(each.index), each.key);
			case 'positional': return problem(`${at} is not an option: Facade gives the CLI its task and folder itself, so args holds only options and their values`, 'args_positional', setting, String(each.index));
		}
	});
}

/** Where a built-in type's earlier arguments said its model and effort (CONFIGURATION-6.2), in its own spelling. */
interface ChoiceSpelling {
	readonly model: readonly string[];
	readonly effort: readonly string[];
	/** Its configuration override options, the keys of model and effort in them, and how their values are written. */
	readonly config?: { readonly options: readonly string[]; readonly model: string; readonly effort: string; readonly values: 'toml' | 'json' };
}

/** Each built-in type's spellings of model and effort (CONFIGURATION-6.2). OpenCode takes neither. */
const CHOICE_SPELLINGS: { readonly [type: string]: ChoiceSpelling } = {
	claude: { model: ['--model'], effort: ['--effort'] },
	// A Go program, which reads its options after one dash or two alike (`isOption`)
	agy: { model: ['--model'], effort: ['--effort'] },
	codex: { model: ['--model', '-m'], effort: [], config: { options: ['-c', '--config'], model: 'model', effort: 'model_reasoning_effort', values: 'toml' } },
	muse: { model: ['--model'], effort: ['--reasoning-effort', '--effort'], config: { options: ['-c', '--config'], model: 'model', effort: 'reasoning_effort', values: 'json' } },
	pi: { model: ['--model'], effort: ['--thinking'] }
};

/** The string a configuration override's value `text` holds, as its CLI reads it; none where it holds no plain string. */
function configString(text: string, values: 'toml' | 'json'): string | undefined {
	if (values === 'json') {
		try {
			const value: unknown = JSON.parse(text);
			return typeof value === 'string' && value.trim() ? value : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const value: unknown = parseToml(`value = ${text}`).value;
		return typeof value === 'string' && value.trim() ? value : undefined;
	} catch {
		// Text TOML does not read is taken as a string by Codex: a plain word, nothing that needed quoting
		return /^[\w.:/@+-]+$/.test(text.trim()) ? text.trim() : undefined;
	}
}

/**
 * The model and effort a built-in type's earlier arguments `args` set (CONFIGURATION-6.2), read as `grammar`'s CLI reads them and
 * taken out of them; each only where one option alone says it plainly - two of them, one with no plain value, or one inside a run of
 * short options leave every such argument where it is, for the rules to say what is wrong. A value of another option that looks like
 * one of them is that option's, and stays.
 */
export function takeChoices(args: readonly string[], type: string, grammar: ArgsGrammar): { readonly args: readonly string[]; readonly model?: string; readonly effort?: string } {
	const spelling = CHOICE_SPELLINGS[type];
	if (!spelling) {
		return { args };
	}
	const found: { model: { index: number; span: number; value: string | undefined }[]; effort: { index: number; span: number; value: string | undefined }[] } = { model: [], effort: [] };
	for (const unit of argumentUnits(args, grammar)) {
		// What follows the end of the options is a task, never an option
		if (unit.kind === 'end') {
			break;
		}
		if (unit.kind === 'override' && spelling.config?.options.includes(unit.option)) {
			const text = unit.text ?? '';
			const at = text.indexOf('=');
			const key = (at < 0 ? text : text.slice(0, at)).trim();
			for (const choice of ['model', 'effort'] as const) {
				if (key === spelling.config[choice]) {
					found[choice].push({ index: unit.index, span: unit.span, value: at < 0 ? undefined : configString(text.slice(at + 1), spelling.config.values) });
				}
			}
		}
		if (unit.kind === 'option') {
			for (const choice of ['model', 'effort'] as const) {
				if (spelling[choice].some(option => isOption(unit.option, option, grammar))) {
					// A value that looks like an option, which its CLI may have taken as one, says nothing plainly
					const [value] = unit.values;
					const plain = unit.form !== 'cluster' && value !== undefined && value.trim() !== '' && !(unit.form === 'apart' && value.startsWith('-'));
					found[choice].push({ index: unit.index, span: unit.span, value: plain ? value : undefined });
				}
			}
		}
	}
	const taken = new Set<number>();
	const result: { model?: string; effort?: string } = {};
	for (const choice of ['model', 'effort'] as const) {
		const [only, ...more] = found[choice];
		if (only && !more.length && only.value !== undefined) {
			result[choice] = only.value;
			for (let at = only.index; at < only.index + only.span; at++) {
				taken.add(at);
			}
		}
	}
	return { args: args.filter((_, index) => !taken.has(index)), ...result };
}
