/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UsageRecord } from './model';

/*
 * What each attempt cost (design doc section 12.5), from what the agents themselves report: the
 * event stream of a headless run, or, for an interactive Claude Code worker, the usage in the
 * transcript its Stop hook names. Dollars only where the agent reports them or where Facade knows
 * the model's price; a subscription agent costs tokens of its own quota, not dollars.
 */

/** Dollars per million tokens: input, output, cache read, cache write (design doc section 3). */
const PRICES: readonly { readonly model: RegExp; readonly price: readonly [number, number, number, number] }[] = [
	{ model: /^claude-fable-5-1/, price: [10, 50, 0.25, 12.5] },
	{ model: /^claude-opus-5-5/, price: [4, 20, 0.20, 5] },
	{ model: /^claude-sonnet-5(?![-.]\d)/, price: [2, 10, 0.20, 2.5] },
	{ model: /^claude-haiku-4-5/, price: [1, 5, 0.10, 1.25] }
];

export function priceOf(usage: Omit<UsageRecord, 'costUsd'>): number | undefined {
	const model = usage.model;
	const known = model ? PRICES.find(entry => entry.model.test(model)) : undefined;
	if (!known) {
		return undefined;
	}
	const [input, output, read, write] = known.price;
	return (usage.inputTokens * input + usage.outputTokens * output + usage.cacheReadTokens * read + usage.cacheWriteTokens * write) / 1e6;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Claude Code's stream-json: the final `result` event carries the session's totals and cost. */
export function claudeStreamUsage(events: readonly unknown[]): UsageRecord | undefined {
	let model: string | undefined;
	let result: Record<string, unknown> | undefined;
	for (const event of events) {
		const item = record(event);
		if (item?.type === 'system' && typeof item.model === 'string') {
			model = item.model;
		} else if (item?.type === 'result') {
			result = item;
		}
	}
	const usage = record(result?.usage);
	if (!result || !usage) {
		return undefined;
	}
	return {
		inputTokens: num(usage.input_tokens),
		outputTokens: num(usage.output_tokens),
		cacheReadTokens: num(usage.cache_read_input_tokens),
		cacheWriteTokens: num(usage.cache_creation_input_tokens),
		costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
		model
	};
}

/** `codex exec --json`: every `turn.completed` carries that turn's usage; cached input is part of the input. */
export function codexStreamUsage(events: readonly unknown[]): UsageRecord | undefined {
	let total: UsageRecord | undefined;
	for (const event of events) {
		const item = record(event);
		const usage = item?.type === 'turn.completed' ? record(item.usage) : undefined;
		if (!usage) {
			continue;
		}
		const cached = num(usage.cached_input_tokens);
		total = {
			inputTokens: (total?.inputTokens ?? 0) + Math.max(0, num(usage.input_tokens) - cached),
			outputTokens: (total?.outputTokens ?? 0) + num(usage.output_tokens),
			cacheReadTokens: (total?.cacheReadTokens ?? 0) + cached,
			cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + num(usage.cache_write_input_tokens)
		};
	}
	return total;
}

/** Antigravity's stream-json: the last `result` event holds the session's cumulative usage. */
export function antigravityStreamUsage(events: readonly unknown[]): UsageRecord | undefined {
	let usage: Record<string, unknown> | undefined;
	for (const event of events) {
		const item = record(event);
		const result = item?.event === 'result' ? record(item.result) : undefined;
		usage = record(result?.usage) ?? usage;
	}
	return usage ? {
		inputTokens: num(usage.input_tokens),
		outputTokens: num(usage.output_tokens) + num(usage.thinking_tokens),
		cacheReadTokens: num(usage.cache_read_tokens),
		cacheWriteTokens: 0
	} : undefined;
}

/** For agents without a documented stream: the last object named `usage` with token counts. */
export function genericStreamUsage(events: readonly unknown[]): UsageRecord | undefined {
	let found: Record<string, unknown> | undefined;
	const visit = (value: unknown, depth: number) => {
		const item = record(value);
		if (!item || depth > 4) {
			return;
		}
		const usage = record(item.usage);
		if (usage && (usage.input_tokens !== undefined || usage.inputTokens !== undefined || usage.prompt_tokens !== undefined)) {
			found = usage;
		}
		for (const child of Object.values(item)) {
			visit(child, depth + 1);
		}
	};
	events.forEach(event => visit(event, 0));
	if (!found) {
		return undefined;
	}
	const usage = found;
	return {
		inputTokens: num(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
		outputTokens: num(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
		cacheReadTokens: num(usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cacheReadTokens),
		cacheWriteTokens: num(usage.cache_write_tokens ?? usage.cacheWriteTokens)
	};
}

/**
 * The usage in a Claude Code transcript: one line per message; an assistant message may appear on
 * several lines as it streams, so each counts once, by its id.
 */
export function claudeTranscriptUsage(text: string): UsageRecord | undefined {
	const byMessage = new Map<string, { model?: string; usage: Record<string, unknown> }>();
	for (const line of text.split('\n')) {
		if (!line.includes('"usage"')) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const message = record(record(parsed)?.message);
		const usage = record(message?.usage);
		if (!message || !usage) {
			continue;
		}
		byMessage.set(typeof message.id === 'string' ? message.id : `line-${byMessage.size}`, { model: typeof message.model === 'string' ? message.model : undefined, usage });
	}
	if (!byMessage.size) {
		return undefined;
	}
	let model: string | undefined;
	const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	let cost = 0;
	let priced = true;
	for (const entry of byMessage.values()) {
		const one = {
			inputTokens: num(entry.usage.input_tokens),
			outputTokens: num(entry.usage.output_tokens),
			cacheReadTokens: num(entry.usage.cache_read_input_tokens),
			cacheWriteTokens: num(entry.usage.cache_creation_input_tokens),
			model: entry.model
		};
		total.inputTokens += one.inputTokens;
		total.outputTokens += one.outputTokens;
		total.cacheReadTokens += one.cacheReadTokens;
		total.cacheWriteTokens += one.cacheWriteTokens;
		model = entry.model ?? model;
		const price = priceOf(one);
		if (price === undefined) {
			priced = false;
		} else {
			cost += price;
		}
	}
	return { ...total, costUsd: priced ? cost : undefined, model };
}

/** Parses the JSON lines of a log, skipping what is not JSON. */
export function jsonLines(text: string): unknown[] {
	const values: unknown[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			values.push(JSON.parse(trimmed));
		} catch {
			// A line cut short, or output that only looks like JSON.
		}
	}
	return values;
}

/** Adds the price when the agent reported none and the model's price is known. */
export function withPrice(usage: UsageRecord): UsageRecord {
	return usage.costUsd !== undefined ? usage : { ...usage, costUsd: priceOf(usage) };
}
