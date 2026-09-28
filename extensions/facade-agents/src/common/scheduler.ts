/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FeatureSize, FeatureStatus, LEAD_RUNG } from './model';

/*
 * Which features to start now (design doc section 7.1). Pure, so its rules are tested on their
 * own: never more workers than slots, never more than an agent's own limit, never a feature whose
 * dependencies are not merged, and the longest chain first.
 */

export interface SchedulerFeature {
	readonly id: string;
	readonly status: FeatureStatus;
	readonly dependsOn: readonly string[];
	readonly size: FeatureSize;
	/** Position in the plan: the tie-breaker. */
	readonly order: number;
	/** The agent on the feature's current rung; `lead` or undefined means no worker can take it. */
	readonly agent: string | undefined;
}

export interface SchedulerInput {
	readonly features: readonly SchedulerFeature[];
	/** Features whose work is on the integration branch. */
	readonly merged: ReadonlySet<string>;
	readonly maxParallel: number;
	/** The most features one agent may hold at once; absent means no limit of its own. */
	readonly agentCaps: ReadonlyMap<string, number>;
}

/** Statuses in which a worker holds a slot. */
export function holdsSlot(status: FeatureStatus): boolean {
	return status === 'running' || status === 'verifying';
}

/** The feature ids to start, in the order to start them. */
export function pickStarts(input: SchedulerInput): string[] {
	const busy = input.features.filter(feature => holdsSlot(feature.status));
	let free = input.maxParallel - busy.length;
	if (free <= 0) {
		return [];
	}
	const perAgent = new Map<string, number>();
	for (const feature of busy) {
		if (feature.agent) {
			perAgent.set(feature.agent, (perAgent.get(feature.agent) ?? 0) + 1);
		}
	}

	const chain = criticalPaths(input.features);
	const ready = input.features
		.filter(feature => feature.status === 'pending' && feature.agent !== undefined && feature.agent !== LEAD_RUNG && feature.dependsOn.every(dep => input.merged.has(dep)))
		.sort((a, b) => (chain.get(b.id)! - chain.get(a.id)!) || (sizeRank(b.size) - sizeRank(a.size)) || (a.order - b.order));

	const starts: string[] = [];
	for (const feature of ready) {
		if (free === 0) {
			break;
		}
		const agent = feature.agent!;
		const cap = input.agentCaps.get(agent);
		const holding = perAgent.get(agent) ?? 0;
		if (cap !== undefined && holding >= cap) {
			continue;
		}
		perAgent.set(agent, holding + 1);
		starts.push(feature.id);
		free--;
	}
	return starts;
}

function sizeRank(size: FeatureSize): number {
	return size === 'M' ? 1 : 0;
}

/**
 * For each feature, the length of the longest chain of features that wait on it, itself included.
 * Starting the head of the longest chain first shortens the whole program.
 */
export function criticalPaths(features: readonly SchedulerFeature[]): Map<string, number> {
	const dependents = new Map<string, string[]>();
	for (const feature of features) {
		for (const dep of feature.dependsOn) {
			const list = dependents.get(dep) ?? [];
			list.push(feature.id);
			dependents.set(dep, list);
		}
	}
	const lengths = new Map<string, number>();
	const visiting = new Set<string>();
	const length = (id: string): number => {
		const known = lengths.get(id);
		if (known !== undefined) {
			return known;
		}
		if (visiting.has(id)) {
			// A cycle; the validator rejects those, so just stop here.
			return 1;
		}
		visiting.add(id);
		let longest = 0;
		for (const next of dependents.get(id) ?? []) {
			longest = Math.max(longest, length(next));
		}
		visiting.delete(id);
		lengths.set(id, longest + 1);
		return longest + 1;
	};
	for (const feature of features) {
		length(feature.id);
	}
	return lengths;
}
