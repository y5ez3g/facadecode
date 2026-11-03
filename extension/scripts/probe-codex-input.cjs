/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Native Codex 0.166.0 ordinary-input regression (CLIS-2.1), using Node 24 after compile:
// node scripts/probe-codex-input.cjs --cli /absolute/path/to/codex --output /tmp/codex-input
// --compiled /earlier/build/out exercises the old reader and delivery path. --raw proves native acceptance independently.
// --no-warning also records the footer without its warning. Only an isolated process and loopback fixture provider are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: {
  cli: { type: 'string' }, output: { type: 'string' }, compiled: { type: 'string' }, raw: { type: 'boolean' }, 'no-warning': { type: 'boolean' }
} });
assert.ok(values.cli && path.isAbsolute(values.cli), '--cli must name the native executable by its absolute path');
const { installedVersionOf } = require('../build/out/clis/version');
assert.equal(installedVersionOf('codex', values.cli)?.version, '0.166.0');
const compiled = path.resolve(values.compiled || path.join(__dirname, '../build/out'));
const { Run } = require(path.join(compiled, 'ptyd/run'));
const { OrdinaryInput } = require(path.join(compiled, 'host/input'));
const { inputScreenOf, readInput } = require(path.join(compiled, 'ptyd/composer'));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'facade-codex-input-')));
const state = path.join(root, 'codex'), cwd = path.join(root, 'work');
fs.mkdirSync(state); fs.mkdirSync(cwd);
const output = path.resolve(values.output || path.join(root, 'evidence'));
const snapshots = [], writes = [], accepted = [];
let run, input, raw = '', request = 0, turns = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }]);
const firstMessage = 'Isolated passive footer delivery.\nKeep this second line exactly once.';
const nextMessage = 'Isolated new activity delivery.\nKeep this follow-up exactly once.';
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const tools = flatten([...(body.tools || []), ...(body.input || []).flatMap(item => item.type === 'additional_tools' ? item.tools : [])]);
    const title = !tools.length || !!body.text?.format?.schema?.properties?.title;
    const n = ++request, turn = title ? 0 : ++turns;
    let item;
    if (turn === 1) {
      const exec = tools.find(tool => tool.name === 'exec_command');
      const meta = tools.find(tool => tool.name === 'exec');
      const args = { cmd: 'sleep 90', yield_time_ms: 1, max_output_tokens: 100 };
      assert.ok(exec || meta, 'native execution tool must be offered');
      item = { id: 'item_' + n, call_id: 'call_' + n, status: 'completed', ...(exec
        ? { type: 'function_call', name: exec.name, namespace: exec.namespace, arguments: JSON.stringify(args) }
        : { type: 'custom_tool_call', name: meta.name, namespace: meta.namespace, input: `text(await tools.exec_command(${JSON.stringify(args)}));` }) };
    } else {
      await delay(turn ? 1000 : 0);
      const text = title ? (body.text?.format ? JSON.stringify({ title: 'Input fixture' }) : 'Input fixture')
        : Array.from({ length: 80 }, (_, i) => `Fixture history row ${i + 1}.`).join('\n\n') + `\n\nFixture response ${turn}.`;
      item = { id: 'item_' + n, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    }
    const response = { id: 'response_' + n, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model,
      output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, error: null };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sequence = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress',
      ...(item.type === 'message' ? { content: [] } : item.type === 'custom_tool_call' ? { input: '' } : { arguments: '' }) } });
    if (item.type === 'message') {
      const part = { type: 'output_text', text: item.content[0].text, annotations: [] };
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: part.text });
      if (turn === 3) await delay(2000); // New activity while the native turn is genuinely still streaming.
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: part.text });
      event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part });
    } else if (item.type === 'custom_tool_call') {
      event('response.custom_tool_call_input.delta', { item_id: item.id, output_index: 0, delta: item.input });
      event('response.custom_tool_call_input.done', { item_id: item.id, output_index: 0, input: item.input });
    } else {
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
      event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments, name: item.name });
    }
    event('response.output_item.done', { output_index: 0, item }); event('response.completed', { response }); res.end();
  } catch (error) { res.destroy(error); }
});

const files = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
// Only native lifecycle and user-message records are evidence; no reasoning is read or retained.
const events = () => files(path.join(state, 'sessions')).filter(file => file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(file, 'utf8').split('\n')).flatMap(line => {
  try {
    const entry = JSON.parse(line);
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_complete') return [{ complete: true }];
    if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user') {
      return [{ message: entry.payload.content.filter(part => part.type === 'input_text').map(part => part.text).join('') }];
    }
  } catch { /* An append may still be incomplete. */ }
  return [];
});
const lines = () => inputScreenOf(run.terminal).rows.map(row => row.map(cell => cell.chars).join('').trimEnd());
const until = async (label, predicate) => {
  const end = Date.now() + 25_000;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  await capture(label + '-timeout'); throw new Error(label + ' timed out');
};
const capture = async label => {
  await run.parsed();
  const screen = inputScreenOf(run.terminal), reading = readInput(screen, 'codex-prompt');
  const snapshot = { label, cols: run.terminal.cols, rows: screen.rows, cursor: screen.cursor, drawing: screen.drawing,
    cursorHidden: run.cursorHidden, reading, status: run.info(false).status };
  snapshots.push(snapshot);
  console.log(label + ': ' + JSON.stringify({ reading, cursor: screen.cursor, hidden: run.cursorHidden, footer: lines().at(-1) }));
  return snapshot;
};
const nothing = { outcome: 'none', text_written: 'none', enter_written: false };
const deliver = async (label, message) => {
  await capture(label + '-empty');
  const before = writes.length;
  if (values.raw) {
    assert.equal(run.terminal.modes.bracketedPasteMode, true);
    await run.type(message, false); await delay(200); await capture(label + '-pasted');
    assert.ok(lines().some(line => line.includes(message.split('\n')[0])), 'native input shows the first pasted line');
    await run.keys(['Enter']);
  } else {
    const result = await input.submit('fixture', message);
    console.log(label + ' submission: ' + JSON.stringify(result));
    assert.deepEqual(result.effects, { outcome: 'confirmed', text_written: 'full', enter_written: true }, label);
    assert.deepEqual(writes.slice(before), [{ text: message, enter: false }, { keys: ['Enter'] }], 'one complete paste, one Enter');
  }
  await until(label + ' native acceptance', () => events().some(event => event.message === message));
  assert.equal(events().filter(event => event.message === message).length, 1, 'native exact message once');
  accepted.push(message);
};
const blocked = async label => {
  const snapshot = await capture(label), before = writes.length;
  assert.notEqual(snapshot.reading.state, 'usable', label);
  assert.deepEqual((await input.submit('fixture', 'Must never be entered.')).effects, nothing, label);
  assert.equal(writes.length, before, label + ' has no text or Enter effects');
};

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(state, 'config.toml'), `model="gpt-6.1-sol"\nmodel_reasoning_effort="xhigh"\nmodel_provider="fixture"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Isolated fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nenv_key="FACADE_FIXTURE_KEY"\n[tui]\nscreen_reader_detection_done=true\n[tui.model_availability_nux]\n"gpt-6.1-sol"=4\n`);
    run = new Run({ run: 'fixture', owner: 'fixture', file: values.cli, args: ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox',
      '-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`,
      ...values['no-warning'] ? [] : ['-c', 'mcp_servers.fixture.command="/facade-fixture-does-not-exist"']],
      env: { PATH: process.env.PATH, CODEX_HOME: state, FACADE_HOME: path.join(root, 'facade'), FACADE_FIXTURE_KEY: 'local-fixture',
        TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'vscode', TMPDIR: root }, cwd, cols: 153, rows: 57, meta: {} });
    run.pty.onData(data => raw += data);
    input = new OrdinaryInput({
      get: () => ({ id: 'fixture', inputAdapter: 'codex-prompt', inputCapability: { state: 'supported', reason: 'Isolated native probe' } }),
      inspectInput: () => run.inspect('codex-prompt'),
      typeText: async (_id, text, enter) => { writes.push({ text, enter }); assert.equal(run.terminal.modes.bracketedPasteMode, true); const result = await run.type(text, enter); await delay(200); await capture('delivery-pasted'); return result; },
      pressKeys: async (_id, keys) => { writes.push({ keys }); return run.keys(keys); }
    });
    await until('initial input', async () => (await run.inspect('codex-prompt')).state === 'usable');
    await run.type('Create isolated background history.', true);
    await until('native first completion', () => events().filter(event => event.complete).length === 1);
    await until('native first summary', () => lines().some(line => /^  Worked for /u.test(line))); await delay(200);
    await run.keys(['PageUp']); await until('passive footer', () => lines().at(-1).includes('enter/esc latest'));
    await deliver('passive', firstMessage);
    await run.keys(['PageUp']);
    await until('new activity footer', () => lines().at(-1).includes('New activity · enter/esc latest'));
    await capture('new-activity-working');
    await until('native second completion', () => events().filter(event => event.complete).length === 2); await delay(200);
    await run.type('A protected draft.', false); await delay(200); await blocked('protected-draft');
    await run.keys(['Ctrl+U']); await delay(200);
    await deliver('new-activity', nextMessage);
    await until('native third completion', () => events().filter(event => event.complete).length === 3); await delay(200);
    await run.keys(['Ctrl+R']); await delay(200); await blocked('history-search'); await run.keys(['Escape']); await delay(100);
    run.write('\x1bOR'); await delay(200); await blocked('transcript-search'); await run.keys(['Escape']); await delay(100); // F3
    // Native mouse selection, entirely inside this fixture's transcript.
    run.write('\x1b[<0;5;4M'); await delay(100);
    run.write('\x1b[<32;35;7M'); await delay(200); await blocked('selection');
    run.write('\x1b[<0;35;7m'); await run.keys(['Escape']); await delay(100);
    await run.keys(['Escape','Escape']); await delay(200); await blocked('active-browsing');
    for (const message of accepted) assert.equal(events().filter(event => event.message === message).length, 1);
    console.log('PASS: exact native messages once; drafts, browsing, search and selection protected');
  } finally {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output + '.json', JSON.stringify({ root, snapshots, writes, accepted }) + '\n'); fs.writeFileSync(output + '.raw', raw);
    if (run) { await run.terminate(250); run.dispose(); }
    server.close(); console.log('Isolated state: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
