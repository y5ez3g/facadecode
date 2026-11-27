// With the Anthropic messages API. A model on this machine alone: answers "ok" at once; counts slowly for 40 s when asked to write integers; refuses every
// request under /fail. OpenAI chat completions and responses. Usage: node fake-model2.mjs <port>
import http from 'node:http';

const port = Number(process.argv[2]);
if (!(port > 1024 && port < 65536)) { console.error('a port'); process.exit(2); }
let n = 0;
const sleep = ms => new Promise(done => setTimeout(done, ms));
http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  let asked = {};
  try { asked = JSON.parse(body || '{}'); } catch {}
  const id = ++n;
  const path = req.url.split('?')[0];
  if (process.env.SAY) console.log(new Date().toISOString(), req.method, path, body.length);
  if (path.startsWith('/fail')) {
    await sleep(200);
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Rate limit reached for this model. Try again later.', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
  }
  // The last thing a person gave it decides how it answers.
  const turns = asked.input || asked.messages || [];
  let last = '';
  for (const turn of Array.isArray(turns) ? turns : []) if (turn.role === 'user') last = JSON.stringify(turn.content);
  const words = /integers from 1 to 700/.test(last) ? Array.from({ length: 160 }, (_, i) => `number ${i + 1}\n`) : ['ok'];
  // Asked by the last thing the person gave it, and not answered yet.
  const lastTurn = (Array.isArray(turns) ? turns : []).filter(turn => ['user', 'tool', 'assistant'].includes(turn.role)).at(-1);
  const answered = JSON.stringify(lastTurn ?? '').includes('tool_result') || lastTurn?.role === 'tool';
  const asks = !answered && /ASKME/.test(JSON.stringify(lastTurn ?? ''));
  const names = (asked.tools || []).map(tool => tool.name || tool.function?.name);
  const wait = 600 + (id * 377) % 2200;
  let open = true;
  res.on('close', () => { open = false; });
  const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  await sleep(120);
  const text = words.join('');
  if (path.endsWith('/responses')) {
    const response = { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: asked.model || 'fake', output: [] };
    const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    sse();
    event('response.created', { response });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const word of words) {
      if (!open) return;
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: word });
      if (words.length > 1) await sleep(250);
    }
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 } } });
    return res.end();
  }
  if (path.endsWith('/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"input_tokens":10}');
  }
  if (path.endsWith('/messages')) {
    const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: asked.model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    if (!asked.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    }
    const ask = names.includes('AskUserQuestion');
    if (asks && ask) {
      sse();
      event('message_start', { message });
      await sleep(wait);
      const input = { questions: [{ question: 'Which one do you want?', header: 'Pick', multiSelect: false, options: [{ label: 'One', description: 'the first' }, { label: 'Two', description: 'the second' }] }] };
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${id}`, name: 'AskUserQuestion', input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {});
      console.log(new Date().toISOString(), 'asked after', wait);
      return res.end();
    }
    sse();
    event('message_start', { message });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const word of words) {
      if (!open) return;
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: word } });
      if (words.length > 1) await sleep(250);
    }
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {});
    return res.end();
  }
  if (path.endsWith('/chat/completions')) {
    const chunk = (delta, finish) => ({ id: `c${id}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: asked.model || 'fake', choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
    if (!asked.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: `c${id}`, object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
    }
    sse();
    if (asks && names.includes('question')) {
      await sleep(wait);
      const args = { questions: [{ question: 'Which one do you want?', header: 'Pick', options: [{ label: 'One', description: 'the first' }, { label: 'Two', description: 'the second' }] }] };
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: 'question', arguments: JSON.stringify(args) } }] }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
      res.write('data: [DONE]\n\n');
      console.log(new Date().toISOString(), 'asked after', wait);
      return res.end();
    }
    for (const word of words) {
      if (!open) return;
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: word }))}\n\n`);
      if (words.length > 1) await sleep(250);
    }
    res.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  console.log('not here:', req.method, path);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"not here"}}');
}).listen(port, '127.0.0.1', () => console.log('ready', port));
