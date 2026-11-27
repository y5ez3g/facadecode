// Projects only the answer to a known question call from a local model request.
// The caller associates the expected call ID with its isolated trial.
function toolResults(request, callId) {
  const results = [];
  for (const turn of Array.isArray(request?.messages) ? request.messages : []) {
    if (turn?.role === 'tool' && turn.tool_call_id === callId) {
      results.push(turn.content);
    }
    if (turn?.role === 'user' && Array.isArray(turn.content)) {
      for (const part of turn.content) {
        if (part?.type === 'tool_result' && part.tool_use_id === callId && !part.is_error) {
          results.push(part.content);
        }
      }
    }
  }
  if (Array.isArray(request?.input)) {
    for (const item of request.input) {
      if (item?.type === 'function_call_output' && item.call_id === callId) {
        results.push(item.output);
      }
    }
  }
  return results;
}

function pick(value) {
  while (Array.isArray(value) && value.length === 1) {
    [value] = value;
  }
  return value === 'One' || value === 'Two' ? value : undefined;
}

function resultAnswer(result, question) {
  if (Array.isArray(result) && result.every(part => part?.type === 'text')) {
    result = result.map(part => part.text).join('');
  }
  if (typeof result === 'string') {
    const text = result.trim();
    const direct = pick(text);
    if (direct) return direct;
    if (text.startsWith('{')) {
      try {
        result = JSON.parse(text);
      } catch {
        return undefined;
      }
    } else {
      const prefix = 'User has answered your questions: ' + JSON.stringify(question) + '=';
      for (const answer of ['One', 'Two']) {
        const response = prefix + JSON.stringify(answer);
        if (text === response || text.startsWith(response + '. ')) return answer;
      }
      return undefined;
    }
  }
  const answers = result?.answers ?? result?.metadata?.answers;
  if (answers && Object.hasOwn(answers, question)) {
    return pick(answers[question]);
  }
  return Array.isArray(answers) ? pick(answers) : undefined;
}

export function questionResult(request, callId, question) {
  if (typeof callId !== 'string' || !callId || typeof question !== 'string' || !question) {
    throw new TypeError('A trial must identify the expected question call');
  }
  const results = toolResults(request, callId);
  if (results.length === 0) return { outcome: 'no_result' };
  const answers = results.map(result => resultAnswer(result, question));
  const [answer] = answers;
  if (answer && answers.every(value => value === answer)) {
    return { outcome: 'answer', answer };
  }
  return { outcome: 'unread' };
}