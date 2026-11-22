/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface EditorApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

// Injected into the test-only Webview bundle. Replays an earlier document's action through VS Code's real message channel.
export function acquireVsCodeApi(): EditorApi {
	const host = globalThis as unknown as {
		acquireVsCodeApi(): EditorApi;
		addEventListener(type: 'message', listener: (event: { data: Record<string, unknown>; stopImmediatePropagation(): void }) => void): void;
	};
	const api = host.acquireVsCodeApi();
	let page: string | undefined;
	let outcomes: unknown[] | undefined;
	host.addEventListener('message', event => {
		const message = event.data;
		if (!message || message.page !== page) { return; }
		if (message.type === 'outcome') { outcomes?.push(message); }
		if (message.type !== 'probe' || message.op !== 'generation-fixture') { return; }
		event.stopImmediatePropagation();
		const seen = outcomes ??= [];
		const actions = JSON.parse(message.selector as string) as readonly { page: string; action: string; what: string; target: string }[];
		for (const action of actions) { api.postMessage({ type: 'act', ...action }); }
		// Same channel and order as the replayed actions. The host must have received them when it answers this probe.
		api.postMessage({ type: 'probed', id: message.id, page, value: { page, outcomes: seen } });
	});
	return {
		getState: () => api.getState(),
		setState: state => api.setState(state),
		postMessage: message => {
			const value = message as { type?: unknown; page?: unknown };
			if (value.type === 'ready' && typeof value.page === 'string') { page = value.page; }
			api.postMessage(message);
		}
	};
}
