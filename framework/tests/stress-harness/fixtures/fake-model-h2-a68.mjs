// With the Anthropic messages API. A model on this machine alone: answers "ok" at once; counts slowly for 40 s when asked to write integers; refuses every
// request under /fail. OpenAI chat completions and responses. Usage: node fake-model2.mjs <port>
import http from 'node:http';
import {existsSync} from 'node:fs';
import { questionResult } from './question-result.mjs';

const pendingQuestions = new Map();
const sentTrials = new Set();
const log = (event, row) => console.log(JSON.stringify({event, at_ms: Date.now(), ...row}));

function fixtureAnswer(request, callId, question) {
  const result = questionResult(request, callId, question);
  if (result.outcome !== 'unread') return result;

  const responses = (Array.isArray(request.input) ? request.input : [])
    .filter(item => item.type === 'function_call_output' && item.call_id === callId);
  if (responses.length) {
    const decoded = responses.map(({output}) => {
      try {
        return typeof output === 'string' ? JSON.parse(output) : output;
      } catch {
        return undefined;
      }
    });
    for (const answer of ['One', 'Two']) {
      if (decoded.every(item =>
        (item?.status === 'answered' && item.answers?.length === 1
          && item.answers[0].id === 'choice' && item.answers[0].selected_label === answer) ||
        (Object.keys(item?.answers || {}).length === 1
          && JSON.stringify(item.answers.choice?.answers) === JSON.stringify([answer])))) {
        return {outcome:'answer', answer};
      }
    }
    if (decoded.every(item => item?.status === 'cancelled' ||
        (item?.answers && Object.keys(item.answers).length === 0))) return {outcome:'dismissed'};
  }

  // Claude 2.1.332 returns a single textual result, with a new preamble.
  const parts = (request.messages || [])
    .filter(turn => turn.role === 'user' && Array.isArray(turn.content))
    .flatMap(turn => turn.content)
    .filter(part => part.type === 'tool_result' && part.tool_use_id === callId && !part.is_error);
  for (const answer of ['One', 'Two']) {
    const response = 'Your questions have been answered: ' + JSON.stringify(question) + '='
      + JSON.stringify(answer) + '. You can now continue with these answers in mind.';
    if (parts.length && parts.every(part => part.content === response)) return {outcome:'answer', answer};
  }
  return result;
}

function geminiResults(request, callId, tool) {
  const results = [];
  for (const turn of request.contents || []) {
    for (const part of turn.parts || []) {
      const response = part.functionResponse;
      if (response?.name === tool && response.id === callId) results.push(response);
    }
  }
  return results;
}

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
  if (req.method === 'HEAD' && path === '/api/hello') {
    res.writeHead(200);
    return res.end();
  }
  if (process.env.SAY) console.log(new Date().toISOString(), req.method, path, body.length);
  if (path.startsWith('/fail')) {
    await sleep(200);
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Rate limit reached for this model. Try again later.', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
  }
  // Agy appends a user-role mode instruction after the conversational prompt.
  const gemini = /:(?:streamGenerateContent|generateContent)$/u.test(path);
  const agyTitle = gemini && (asked.systemInstruction?.parts || []).some(part =>
    part.text?.includes('You are a conversation title generator.'));
  const turns = asked.input || asked.messages || asked.contents || [];
  let last = '';
  let latestGeminiTag;
  let latestGeminiE2 = '';
  const busyPrompt = 'Write the integers from 1 to 700 in English words';
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn.role !== 'user') continue;
    last = JSON.stringify(turn.content || turn.parts) ?? '';
    if (gemini) {
      const recorded = last.match(/\bH2Q_[A-Za-z0-9_]+\b/u)?.[0];
      if (recorded) latestGeminiTag = recorded;
      if (last.includes(busyPrompt) || last.includes('reply with the single word ok')) {
        latestGeminiE2 = last;
      }
    }
  }
  const profile = last.match(/\bH2P_[A-Za-z0-9_]+\b/u)?.[0];
  if (profile && req.method === 'POST' &&
      (gemini || /\/(?:messages|chat\/completions|responses)$/u.test(path))) {
    log('profile_probe', {trial:profile, path, model:asked.model || null});
  }
  const names = (asked.tools || []).flatMap(tool => [
    tool.name || tool.function?.name,
    ...(tool.functionDeclarations || []).map(declaration => declaration.name),
    ...(tool.tools || []).map(declaration => declaration.name),
  ]).filter(Boolean);
  for (const [callId, trial] of pendingQuestions) {
    const result = fixtureAnswer(asked, callId, trial.question);
    const matchingGemini = geminiResults(asked, callId, trial.tool);
    const agyOutput = matchingGemini.length === 1 ? matchingGemini[0].response?.output : undefined;
    const agyAnswer = typeof agyOutput === 'string' ?
      /^Created At: [^\r\n]+\r?\nCompleted At: [^\r\n]+\r?\nA1: (One|Two)(?:\r?\n\r?\n|$)/u.exec(agyOutput)?.[1] : undefined;
    if (result.outcome === 'answer' || agyAnswer) {
      log('answer', {call_id: callId, trial: trial.tag, answer: agyAnswer || result.answer});
      pendingQuestions.delete(callId);
    } else if (result.outcome === 'dismissed') {
      log('dismissed', {call_id:callId, trial:trial.tag});
      pendingQuestions.delete(callId);
    } else if (!trial.reportedUnread && (result.outcome === 'unread' || matchingGemini.length)) {
      trial.reportedUnread = true;
      log('unread_result', {call_id: callId, trial: trial.tag});
      if (process.env.FACADE_H2_CALIBRATE === '1') {
        for (const turn of asked.messages || []) {
          for (const part of Array.isArray(turn.content) ? turn.content : []) {
            if (part.type === 'tool_result' && part.tool_use_id === callId) {
              log('fixture_result', {call_id: callId, trial: trial.tag, content: part.content, is_error: part.is_error});
            }
          }
        }
        for (const item of Array.isArray(asked.input) ? asked.input : []) {
          if (item.type === 'function_call_output' && item.call_id === callId) {
            log('fixture_result', {call_id: callId, trial: trial.tag, output: item.output});
          }
        }
        for (const functionResponse of matchingGemini) {
          log('fixture_result', {call_id:callId, trial:trial.tag, functionResponse});
        }
      }
    }
  }
  if (req.method === 'GET' && path.endsWith('/models')) {
    res.writeHead(200, {'content-type': 'application/json'});
    if (path.startsWith('/v1beta/')) {
      return res.end(JSON.stringify({models: [{
        name: 'models/gemini-3.8-flash', displayName: 'Loopback', inputTokenLimit: 32768,
        outputTokenLimit: 2048, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      }]}));
    }
    const models = ['gpt-6-luna', 'fake', 'claude-haiku-5-5', 'muse-spark-1.3'];
    return res.end(JSON.stringify({object: 'list', data: models.map(id => ({id, object: 'model', created: 0, owned_by: 'loopback'}))}));
  }
  const tag = gemini ? latestGeminiTag : last.match(/\bH2Q_[A-Za-z0-9_]+\b/u)?.[0];
  if (gemini && process.env.FACADE_H2_AGY_DIAGNOSTIC === '1') {
    const instruction = (asked.systemInstruction?.parts || []).map(part => part.text || '').join('\n');
    log('agy_request_shape', {trial: tag, path, config: asked.generationConfig,
      system_chars: instruction.length, title: agyTitle,
      tools: names});
  }
  const tool = gemini ? names.find(name => /^(ask_?user_?question|ask_?question|request_?user_?input)$/iu.test(name)) || 'ask_question'
    : path.endsWith('/responses') ? 'request_user_input'
    : path.endsWith('/messages') ? 'AskUserQuestion'
    : names.includes('question') ? 'question' : 'h2_question';
  const injected = names.length === 0 && path.endsWith('/responses') &&
    process.env.FACADE_H2_CODEX_INJECT === '1';
  const available = names.includes(tool) || injected;
  const asks = !!tag && available && !sentTrials.has(tag);
  const namespace = (asked.tools || []).find(entry => entry.tools?.some(inner => inner.name === tool));
  if (tag && !agyTitle && !sentTrials.has(tag) && !available && !path.endsWith('/count_tokens')) {
    log('tool_unavailable', {trial: tag, path, wanted: tool, available_names: names,
      request_keys: Object.keys(asked)});
  }
  const question = tag ? "Pick a value for " + tag : null;
  const options = [{label:'One', description:'First test value'}, {label:'Two', description:'Second test value'}];
  const questionEntry = {question, header: 'Pick a value', options};
  const askInput = tool === 'request_user_input'
    ? {questions: [{...questionEntry, id: 'choice'}]}
    : tool === 'AskUserQuestion' ? {questions: [{...questionEntry, multiSelect: false}]}
    : tool === 'h2_question' ? questionEntry : {questions: [questionEntry]};
  const emitQuestion = (callId) => {
    pendingQuestions.set(callId, {tag, question, tool});
    log('question', {call_id: callId, trial: tag, question, tool, injected});
  };
  const wait = Number(process.env.FACADE_H2_ASK_DELAY ?? '700');
  const prepareQuestion = async () => {
    sentTrials.add(tag);
    log('scheduled', {trial: tag, planned_ms: Date.now() + wait});
    await sleep(wait);
  };
  const e2Stop = process.env.FACADE_E2_STOP_FILE;
  const held = !agyTitle && e2Stop && (process.env.FACADE_E2_HOLD_EVERY_TURN === '1' || (gemini ? latestGeminiE2 : last).includes(busyPrompt));
  const words = held ? Array.from({length:1200}, (_, index) => `number ${index + 1}\n`)
    : [agyTitle ? 'Single Choice Test' : 'ok'];
  let open = true;
  res.on('close', () => { open = false; });
  const streamWords = async append => {
    let output = '';
    for (const word of words) {
      if (!open) return null;
      if (held && existsSync(e2Stop)) break;
      append(word);
      output += word;
      if (held) await sleep(1000);
    }
    return open ? output : null;
  };
  const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let sequence = 0;
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  await sleep(120);
  const text = words.join('');
  if (gemini) {
    const streaming = path.endsWith(':streamGenerateContent');
    if (streaming) sse();
    else res.writeHead(200, {'content-type':'application/json'});
    let part = {text};
    if (streaming && held && !asks) {
      const output = await streamWords(word => res.write('data: ' + JSON.stringify({
        candidates:[{content:{role:'model', parts:[{text:word}]}, index:0}],
      }) + '\n\n'));
      if (output === null) return;
      part = {text:''};
    }
    if (asks) {
      await prepareQuestion();
      const callId = 'call_' + id;
      emitQuestion(callId);
      part = {functionCall: {name: tool, args: {questions:[{question, options:['One', 'Two']}]}, id: callId}};
    }
    const result = {candidates: [{content: {role:'model', parts:[part]}, finishReason:'STOP', index:0}],
      usageMetadata: {promptTokenCount:10, candidatesTokenCount:1, totalTokenCount:11}};
    return res.end(streaming ? 'data: ' + JSON.stringify(result) + '\n\n' : JSON.stringify(result));
  }
  if (path.endsWith('/responses')) {
    const response = { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: asked.model || 'fake', output: [] };
    const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    if (asks) {
      sse();
      event('response.created', { response });
      await prepareQuestion();
      const callId = 'call_' + id;
      const item = {id: 'fc_' + id, type: 'function_call', call_id: callId, name: tool,
        arguments: JSON.stringify(askInput), status: 'completed'};
      if (namespace) item.namespace = namespace.name;
      emitQuestion(callId);
      event('response.output_item.added', {output_index: 0, item: {...item, arguments: '', status: 'in_progress'}});
      event('response.function_call_arguments.delta', {item_id:item.id, output_index: 0, delta:item.arguments});
      event('response.function_call_arguments.done', {item_id:item.id, output_index: 0, arguments:item.arguments});
      event('response.output_item.done', {output_index: 0, item});
      event('response.completed', {response: {...response, status: 'completed', output: [item],
        usage: {input_tokens: 10, input_tokens_details: {cached_tokens: 0}, output_tokens: 1,
          output_tokens_details: {reasoning_tokens: 0}, total_tokens: 11}}});
      return res.end();
    }
    sse();
    event('response.created', { response });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    const output = await streamWords(word => event('response.output_text.delta',
      {item_id:item.id, output_index:0, content_index:0, delta:word}));
    if (output === null) return;
    item.content[0].text = output;
    event('response.output_text.done', {item_id:item.id, output_index:0, content_index:0, text:output});
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
    const ask = asks && tool === 'AskUserQuestion';
    if (ask) {
      sse();
      event('message_start', { message });
      await prepareQuestion();
      const input = askInput;
      emitQuestion(`toolu_${id}`);
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${id}`, name: 'AskUserQuestion', input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {});

      return res.end();
    }
    sse();
    event('message_start', { message });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const output = await streamWords(word => event('content_block_delta',
      {index:0, delta:{type:'text_delta', text:word}}));
    if (output === null) return;
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
    if (asks) {
      await prepareQuestion();
      const args = askInput;
      emitQuestion(`call_${id}`);
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
      res.write('data: [DONE]\n\n');

      return res.end();
    }
    const output = await streamWords(word =>
      res.write(`data: ${JSON.stringify(chunk({role:'assistant', content:word}))}\n\n`));
    if (output === null) return;
    res.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  console.log('not here:', req.method, path);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"not here"}}');
}).listen(port, '127.0.0.1', () => log('ready', {port, pid: process.pid}));
