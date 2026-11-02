// Fixed whole-journey measurements (VERIFICATION-1.2, M36). Compile first; this runs isolated contract fakes, never real agents.
// node scripts/measure-mcp.mjs [--compiled build/out] [--output build/mcp-measurement.json] [--allow-failures]
// --compiled can select a frozen baseline. Its failures remain visible; --allow-failures only changes the exit code.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const compiled = path.resolve(root, option('--compiled') ?? 'build/out');
const require = createRequire(import.meta.url);
const load = file => require(path.join(compiled, file));
const { setUp, runFacts, runId, FakeNetwork, remoteAgent } = load('test/contractFakes.js');
const { TOOLS } = load('schema/tools.js');
const { instructionsFor, launchContextText } = load('schema/instructions.js');
const { FACADE_SKILL } = load('schema/skill.js');
const { MOST_CALL_SECONDS } = load('clis/tools.js');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = [];

async function journey(name, run) {
	const s = setUp();
	// Contract message fixtures are timestamped at 3000+n; use the same fixed clock for request retention.
	s.deps.clock = { now: () => 3000 };
	const caller = runFacts(1, { yolo: true });
	s.agents.add(caller);
	const row = { name, calls: [], checks: [], text_bytes: 0, structured_bytes: 0, file_bytes: 0 };
	const check = (name, passed) => row.checks.push({ name, passed: !!passed });
	const call = async (tool, args, from = caller) => {
		const began = performance.now();
		const answer = await s.call(from, tool, args);
		row.calls.push({ tool, status: answer.structured.status, text_bytes: bytes(answer.text), structured_bytes: bytes(answer.structured), harness_ms: performance.now() - began });
		row.text_bytes += bytes(answer.text); row.structured_bytes += bytes(answer.structured);
		check(`${tool}: text equals structured`, JSON.stringify(JSON.parse(answer.text)) === JSON.stringify(answer.structured));
		return answer.structured;
	};
	try {
		await run({ s, caller, call, check, row });
		row.file_bytes = s.written.reduce((sum, file) => sum + bytes(file.text), 0);
		row.effects = { launches: s.agents.launched.length, sends: s.messages.sent.length, raw_text_writes: s.terminal.typed.length, key_sequences: s.terminal.pressed.length };
	} catch (error) { row.error = String(error); check('journey completed', false); }
	finally { s.dispose(); }
	rows.push(row);
}

for (const location of ['loc-1', 'loc-wt']) {
	await journey(`discover-and-start:${location}`, async ({ s, caller, call, check }) => {
		s.agents.add({ ...caller, location });
		const discovered = await call('list_start_options', {});
		const started = await call('start_agent', { name: 'worker', window_id: discovered.data.window_id, location_id: discovered.data.location_id, cli: 'claude', request_id: 'one-start', prompt: 'Check the input. 中文 📨' });
		check('one discovery at the registered location', discovered.data.location_id === location);
		check('one launch and one complete initial message', started.status === 'success' && s.agents.launched.length === 1 && s.messages.records[0].text === 'Check the input. 中文 📨');
	});
}
for (const count of [1, 20, 100, 200]) {
	for (const details of [false, true]) {
		await journey(`agents:${count}:${details ? 'details' : 'compact'}`, async ({ s, caller, call, check, row }) => {
			for (let i = 2; i <= count; i++) { s.agents.add(runFacts(i, { root: caller.id, name: `worker ${i}`, activitySince: 1700000000000 })); }
			const ids = []; let cursor;
			do {
				const result = await call('list_agents', { details, ...(cursor ? { cursor } : {}) });
				ids.push(...result.data.agents.map(agent => agent.agent_id)); cursor = result.data.next_cursor;
			} while (cursor && row.calls.length < 10);
			check('complete pagination with no duplicated agents', ids.length === count && new Set(ids).size === count && !cursor);
			check('no extra page', row.calls.length === Math.ceil(count / 100));
		});
	}
}
await journey('message-and-inbox', async ({ s, caller, call, check }) => {
	const worker = runFacts(2, { root: caller.id }); s.agents.add(worker);
	const text = 'First line\nLiteral [[selected]] and {{dim}} · 中文 📨';
	const sent = await call('send_message', { to: '#a2', text, request_id: 'one-message' });
	const read = await call('read_messages', { ids: [sent.data.message_id] }, worker);
	const repeated = await call('send_message', { to: '#a2', text, request_id: 'one-message' });
	check('complete body, one send, same identity', read.data.messages[0].text === text && s.messages.sent.length === 1 && repeated.data.message_id === sent.data.message_id);
});
await journey('empty-inbox-is-not-a-wait', async ({ call, check }) => {
	const read = await call('read_messages', {});
	check('an empty snapshot with no completion or recovery claim', read.data.messages.length === 0 && !read.recovery);
	check('automatic delivery remains visible at the empty read', /delivered automatically/.test(read.data.notice ?? '') && /does not wait/.test(read.data.notice ?? ''));
});
for (const large of [false, true]) {
	await journey(`screen:${large ? 'file' : 'inline'}`, async ({ s, caller, call, check }) => {
		const text = large ? '中文 [[literal]] {{literal}} \\ '.repeat(700) : 'selected [[literal]] {{literal}} \\ 中文';
		s.terminal.screen = { lines: [text], text: [text], styles: [{ start: 0, end: 2, inverse: true }], buffer: 'normal', older: false, trimmed: false, capturedAt: 1700000000000, exited: false };
		const result = await call('read_screen', { agent: caller.alias });
		const data = large ? JSON.parse(s.written[0].text) : result.data;
		check('one complete styled body with literal delimiters escaped', typeof data.text === 'string' && data.text.includes('\\[\\[literal\\]\\]') && data.text_format === 'facade-styled' && !('annotated' in data));
		check('only large screens use a file', s.written.length === (large ? 1 : 0));
	});
}
await journey('lost-send-then-target-absent', async ({ s, call, check }) => {
	const network = s.deps.network = new FakeNetwork(); network.window(2, 'Backend', [remoteAgent(20)]);
	network.respond = () => ({ ok: false, reason: 'timeout', message: 'Reply lost.', effects: 'unknown' });
	const args = { to: '#a20', text: 'Do once', request_id: 'original' };
	const lost = await call('send_message', args);
	network.respond = () => ({ ok: true, result: { status: 'failure', error: { code: 'NOT_FOUND', reason: 'not_found', message: 'Target gone.' } } });
	const retry = await call('send_message', args);
	check('preserves timeout reason and original-request recovery', lost.error?.reason === 'timeout' && lost.recovery?.action === 'repeat_original_request');
	check('a later absence does not settle an earlier unknown effect', retry.effects.outcome === 'unknown');
	check('same original message and target; no new allocation', retry.data.message_id === lost.data.message_id && s.messages.allocated.length === 1 && network.routed.every(route => route.window === 'win-2' && route.args.to === runId(20)));
});
await journey('malformed-window-list', async ({ s, call, check }) => {
	const network = s.deps.network = new FakeNetwork(); network.window(2, 'Backend');
	network.respond = () => ({ ok: true, result: {} });
	for (const tool of ['list_agents', 'list_start_options']) {
		const result = await call(tool, tool === 'list_start_options' ? { scope: 'all' } : {});
		check(`${tool}: no invented empty complete window`, result.data.complete === false && result.data.unavailable_windows[0].reason === 'invalid_response');
	}
});
await journey('lost-read-versus-raw-input', async ({ s, call, check }) => {
	const network = s.deps.network = new FakeNetwork(); network.window(2, 'Backend', [remoteAgent(20)]);
	network.respond = () => ({ ok: false, reason: 'timeout', message: 'Reply lost.', effects: 'unknown' });
	const read = await call('read_screen', { agent: '#a20' });
	const write = await call('type_text', { agent: '#a20', text: 'once', enter: true });
	check('pure read has no business effect', read.effects.outcome === 'none');
	check('raw input remains unknown and offers inspection', write.effects.outcome === 'unknown' && write.recovery?.action === 'inspect_effects');
	check('no automatic replay', network.routed.length === 2);
});
await journey('raw-partial-and-unconfirmed-stop', async ({ s, call, check }) => {
	s.agents.add(runFacts(2)); s.terminal.typeWith = { outcome: 'partial', pasted: true, entered: false };
	const input = await call('type_text', { agent: '#a2', text: 'once', enter: true });
	s.agents.closeWith = 'unconfirmed'; const stop = await call('stop_agent', { agent: '#a2' });
	check('partial input is not success or replayed', input.status === 'failure' && input.effects.outcome === 'partial' && s.terminal.typed.length === 1);
	check('closure is not verified process exit', stop.status === 'failure' && stop.effects.outcome === 'partial' && stop.data.closed === true);
});
await journey('accepted-start-and-original-receipt', async ({ s, call, check }) => {
	s.agents.startWith = undefined; s.timeout = 0.001;
	const args = { name: 'worker', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', request_id: 'start-once' };
	const accepted = await call('start_agent', args);
	const repeated = await call('start_agent', args);
	const child = s.agents.list().find(agent => agent.alias === accepted.data.agent_id);
	s.agents.settle(child.id, { state: 'running' });
	await new Promise(resolve => setImmediate(resolve));
	check('accepted is continuing, not failure or completed work', accepted.status === 'accepted' && accepted.effects.outcome === 'pending');
	check('lookup keeps one launch and its reserved receipt', s.agents.launched.length === 1 && repeated.data.result_message_id === accepted.data.result_message_id);
	check('one final receipt with original call identity', s.messages.records.length === 1 && s.messages.records[0].alias === accepted.data.result_message_id && s.messages.records[0].callId === accepted.data.call_id);
});

const dynamic = launchContextText({ creator: { id: '#a1', label: 'Ben #a1' }, window: 'Backend', location: { path: '/work/app.worktrees/feature-input', label: 'feature/input', branch: 'feature/input', kind: 'checkout', environment: 'local', folders: [{ name: 'app' }] }, initialMessage: '#m42' });
const sources = ['schema/tools.js', 'schema/instructions.js', 'schema/skill.js', 'contract/tools.js', 'schema/recovery.js', 'test/contractFakes.js'];
const result = {
	format: 1, at: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, compiled,
	evidence: 'Deterministic contract fakes; no native/model behavior or network latency claim. UTF-8 bytes, not tokens. Text and structured sizes are separate copies, not assumed both model-visible.',
	compiled_sha256: Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(compiled, file)))])),
	tool_arguments_sha256: hash(JSON.stringify(TOOLS.map(({ name, inputSchema }) => ({ name, inputSchema })))),
	static: { tools: bytes(TOOLS), instructions: bytes(instructionsFor('#a1')), skill: bytes(FACADE_SKILL), example_dynamic_context: bytes(dynamic) },
	wait_margin: { configured_outer_seconds: MOST_CALL_SECONDS, maximum_operation_seconds: 3600, route_allowance_seconds: 10, remaining_seconds: MOST_CALL_SECONDS - 3610 },
	journeys: rows,
	totals: { calls: rows.reduce((n, row) => n + row.calls.length, 0), text_bytes: rows.reduce((n, row) => n + row.text_bytes, 0), structured_bytes: rows.reduce((n, row) => n + row.structured_bytes, 0), file_bytes: rows.reduce((n, row) => n + row.file_bytes, 0), checks: rows.reduce((n, row) => n + row.checks.length, 0), failures: rows.flatMap(row => row.checks.filter(check => !check.passed).map(check => `${row.name}: ${check.name}`)) }
};
const output = path.resolve(root, option('--output') ?? 'build/mcp-measurement.json');
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, static: result.static, totals: result.totals }, null, 2));
if ((result.totals.failures.length || result.wait_margin.remaining_seconds <= 0) && !process.argv.includes('--allow-failures')) { process.exitCode = 1; }
