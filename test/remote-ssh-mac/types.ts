/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IRemoteAgent {
	id: number;
	state: string;
	connected: boolean;
}

export interface IHostProcess {
	kind: string;
	pid: number;
	startTicks?: string;
	created?: string;
}

export interface IHostProbe {
	ok: boolean;
	errors?: string[];
	processes: IHostProcess[];
}

export interface IRemoteTarget {
	target: 'linux' | 'windows';
	record: string;
	commit: string;
	probe: string;
	client: string;
	hostname: string;
	os: string;
	agents: number[];
	http: { name: string; url: string; pid: number }[];
}

export interface ICampaignTargets {
	ready: boolean;
	alerts?: boolean;
	targets: IRemoteTarget[];
}

export interface ILaunchInfo {
	name: string;
	cdpPort: number;
	evidenceDir?: string;
}

export interface IScenarioResults {
	cases: { target: string; key: string; status: string; observation: string }[];
}

export interface IRunState {
	status: string;
	startedAt: string;
	current?: { target: string; round: number; startedAt: string; commit?: string; duration?: number; label?: string };
	finishedAt?: string;
	error?: string;
	qualification?: string;
}
