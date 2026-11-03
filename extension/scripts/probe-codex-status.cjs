/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Native Codex 0.166.0 regression (CLIS-2.3). Run after compile, with Node 24:
// node scripts/probe-codex-status.cjs --cli /absolute/path/to/codex --output /tmp/codex-status
// --compiled /path/to/earlier/build/out runs the same assertions against an earlier supervisor implementation.
// Only a loopback deterministic provider is used. No account, owner configuration, editor or live supervisor is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: { cli: { type: 'string' }, output: { type: 'string' }, compiled: { type: 'string' } } });
assert.ok(values.cli && path.isAbsolute(values.cli), '--cli must name the native executable by its absolute path');
const { installedVersionOf } = require('../build/out/clis/version');
assert.equal(installedVersionOf('codex', values.cli)?.version, '0.166.0', 'this probe is scoped to Codex 0.166.0');
const { Run } = require(path.resolve(values.compiled || path.join(__dirname, '../build/out'), 'ptyd/run.js'));
// This reader records evidence only; the selected Run above owns status evaluation.
const { readStatusLines } = require('../build/out/ptyd/screen');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'facade-codex-status-')));
const state = path.join(root, 'codex');
const cwd = path.join(root, 'work');
fs.mkdirSync(state); fs.mkdirSync(cwd);
const output = path.resolve(values.output || path.join(root, 'evidence'));
const snapshots = [];
let requests = 0, turnRequests = 0, streaming = false, run, raw = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }]);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const tools = flatten(body.tools || []);
    const n = ++requests;
    const turn = tools.length ? ++turnRequests : 0; // Native ancillary title generation is not an interactive turn.
    let item;
    if (turn === 1) {
      const exec = tools.find(tool => tool.name === 'exec_command');
      assert.ok(exec, 'native exec_command must be offered');
      item = { type: 'function_call', id: 'item_' + n, call_id: 'call_' + n, status: 'completed', name: exec.name, namespace: exec.namespace,
        arguments: JSON.stringify({ cmd: 'sleep 90', yield_time_ms: 1, max_output_tokens: 100 }) };
    } else {
      await delay(turn ? 3000 : 0); // Hold the response so genuine work can be sampled before streaming.
      item = { type: 'message', id: 'item_' + n, role: 'assistant', status: 'completed', content: [{ type: 'output_text',
        text: turn ? `Fixture response ${turn}.\nStill part of this response.` : 'Run status fixture', annotations: [] }] };
    }
    const response = { id: 'resp_' + n, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model,
      output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, error: null };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sequence = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
    if (item.type === 'message') {
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
      if (turn === 3) { streaming = true; await delay(2000); streaming = false; }
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
      event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    } else {
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
      event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments, name: item.name });
    }
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response });
    res.end();
  } catch (error) { res.destroy(error); }
});

const capture = label => {
  const screen = readStatusLines(run.terminal);
  const info = run.info(false);
  const snapshot = { label, status: info.status, title: info.title, cols: run.terminal.cols, clippedStart: screen.clippedStart,
    dimLines: [...screen.dimLines], lines: screen.lines.map(line => line.replaceAll(root, '/isolated')) };
  snapshots.push(snapshot);
  console.log(`${label}: ${info.status?.state}; title=${JSON.stringify(info.title)}`);
  return snapshot;
};
const until = async (label, predicate) => {
  const end = Date.now() + 25_000;
  while (Date.now() < end) { if (predicate()) return; await delay(100); }
  capture(label + '-timeout');
  throw new Error(label + ' timed out');
};
// Native lifecycle evidence verifies that a rendered response has actually completed, independently of Facade's status.
const completedTurns = () => {
  const files = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
  return files(path.join(state, 'sessions')).filter(file => file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(file, 'utf8').split('\n'))
    .filter(line => { try { const entry = JSON.parse(line); return entry.type === 'event_msg' && entry.payload?.type === 'task_complete'; } catch { return false; } }).length;
};
const renderedCompletions = () => readStatusLines(run.terminal).lines.filter(line => /^  Worked for .* • /u.test(line)).length;

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(state, 'config.toml'), `model="test-model"\nmodel_provider="fixture"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Isolated fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nenv_key="FACADE_FIXTURE_KEY"\n[tui]\nscreen_reader_detection_done=true\n[tui.model_availability_nux]\n"gpt-6.1-sol"=4\n`);
    const env = { PATH: process.env.PATH, CODEX_HOME: state, FACADE_HOME: path.join(root, 'facade'), FACADE_FIXTURE_KEY: 'local-fixture',
      TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'vscode', TMPDIR: root };
    run = new Run({ run: 'fixture', owner: 'fixture', file: values.cli,
      args: ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox', '-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`],
      env, cwd, cols: 120, rows: 40, meta: {}, screenStatus: 'codex-0.166' });
    run.pty.onData(data => raw += data);
    await until('initial idle', () => run.info(false).status?.state === 'idle'); capture('initial');
    await run.type('Start the isolated background fixture.', true);
    await until('first request', () => turnRequests > 0); capture('working');
    await until('first native task_complete', () => completedTurns() === 1);
    await until('first native summary rendered', () => renderedCompletions() === 1); await delay(500); capture('background-completed');
    await run.type('Follow-up fixture message.', true);
    await until('follow-up request', () => turnRequests >= 3); await delay(350); capture('follow-up-working');
    await until('streaming', () => streaming); await delay(600); capture('follow-up-streaming');
    await until('second native task_complete', () => completedTurns() === 2);
    await until('second native summary rendered', () => renderedCompletions() === 2); await delay(500); capture('follow-up-completed');
    for (const [cols, rows] of [[60, 24], [120, 40]]) { run.resize(cols, rows); await delay(600); capture('resize-' + cols); }
    const reports = [...raw.matchAll(/\x1b\]7501;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)].map(match => match[1]);
    console.log('Native OSC 7501:', JSON.stringify(reports));
    assert.deepEqual(reports, ['state=idle:app=codex', 'state=working:app=codex'], 'background command keeps the native aggregate working across both turns');
    for (const snapshot of snapshots) {
      const idle = ['initial', 'background-completed', 'follow-up-completed', 'resize-60', 'resize-120'].includes(snapshot.label);
      assert.equal(snapshot.status?.state, idle ? 'idle' : 'working', snapshot.label);
      if (snapshot.label.includes('completed')) assert.ok(snapshot.lines.some(line => line.startsWith('  1 background terminal running')), 'background command remains alive');
    }
    console.log('PASS: native completion, retained command, follow-up, streaming and resize');
  } finally {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output + '.json', JSON.stringify({ root, snapshots }, null, 2) + '\n');
    fs.writeFileSync(output + '.raw', raw);
    if (run) { await run.terminate(250); run.dispose(); }
    server.close();
    console.log('Isolated state:', root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
