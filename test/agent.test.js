import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { createChat } from '../src/agent/chat.js';

// A stand-in for the Anthropic client: records each request and replies from a script.
// No real API calls in tests.
function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    messages: {
      async create(params) {
        requests.push(structuredClone(params)); // snapshot: the history array keeps changing
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, ...next };
      },
    },
  };
}
const say = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });
const use = (...calls) => ({
  content: calls.map(([id, name, input = {}]) => ({ type: 'tool_use', id, name, input })),
  stop_reason: 'tool_use',
});
const TOOLS = [{ name: 'get_customer', description: 'Look up', input_schema: { type: 'object', properties: {} } }];

// A stand-in for mcp.callTool: records calls and answers from a map of name -> result (or Error).
function fakeTools(answers = {}) {
  const calls = [];
  return {
    calls,
    async callTool(name, input) {
      calls.push({ name, input });
      const answer = answers[name] ?? { text: '{"ok":true}', isError: false };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

// Every message in a request must be non-empty, and user/assistant turns must alternate.
function assertValidMessages(messages) {
  messages.forEach((m, i) => {
    assert.ok(m.content.length > 0, `message ${i} is empty`);
    assert.equal(m.role, i % 2 === 0 ? 'user' : 'assistant', `message ${i} has the wrong role`);
  });
}

describe('buildSystemPrompt', () => {
  test('states the policy from src/policy.js', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /within 30 days of delivery/);
    assert.match(prompt, /arrived damaged/);
    assert.match(prompt, /wrong item/);
    assert.match(prompt, /not as described/);
    assert.match(prompt, /change of mind/);
  });

  test("doesn't reveal the internal approval limits", () => {
    assert.doesNotMatch(buildSystemPrompt(), /5,000|25,000|5000|25000/);
  });

  test('is identical every time, so it can be cached', () => {
    assert.equal(buildSystemPrompt(), buildSystemPrompt());
  });

  test("includes the MCP server's tool instructions and tells the agent to use its tools", () => {
    const prompt = buildSystemPrompt(undefined, { toolInstructions: 'Verify the customer first.' });
    assert.match(prompt, /Tool notes:\nVerify the customer first\.$/);
    assert.match(prompt, /Use your tools to verify the customer/);
    assert.doesNotMatch(prompt, /cannot look up/);
  });
});

describe('createChat tool loop', () => {
  test('sends the tools on every request, and none when there are none', async () => {
    const withTools = fakeClient([say('Hi')]);
    await createChat({ client: withTools, tools: TOOLS }).send('Hi');
    assert.deepEqual(withTools.requests[0].tools, TOOLS);
    assert.equal('tool_choice' in withTools.requests[0], false);

    const without = fakeClient([say('Hi')]);
    await createChat({ client: without }).send('Hi');
    assert.equal('tools' in without.requests[0], false);
  });

  test('runs a requested tool and sends its result back until end_turn', async () => {
    const input = { email: 'priya.shah@example.com', card_last4: '4242' };
    const client = fakeClient([
      { ...use(['t1', 'get_customer', input]), usage: { input_tokens: 100, output_tokens: 20 } },
      say('You are verified.', { usage: { input_tokens: 150, output_tokens: 10 } }),
    ]);
    const tools = fakeTools({ get_customer: { text: '{"ok":true,"customer":{}}', isError: false } });
    const chat = createChat({ client, tools: TOOLS, callTool: tools.callTool });

    const result = await chat.send('Hi, I am Priya');
    assert.equal(result.text, 'You are verified.');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.rounds, 1);
    assert.deepEqual(result.usage, { input_tokens: 250, output_tokens: 30 });
    assert.deepEqual(tools.calls, [{ name: 'get_customer', input }]);

    const second = client.requests[1].messages;
    assert.deepEqual(second.slice(1), [
      { role: 'assistant', content: use(['t1', 'get_customer', input]).content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true,"customer":{}}', is_error: false }] },
    ]);
    assertValidMessages(second);
  });

  test('runs several tool calls in order and returns all results in one message', async () => {
    const client = fakeClient([use(['a', 'get_order'], ['b', 'get_payment']), say('Done')]);
    const tools = fakeTools();
    await createChat({ client, tools: TOOLS, callTool: tools.callTool }).send('Check both');
    assert.deepEqual(tools.calls.map((c) => c.name), ['get_order', 'get_payment']);
    const results = client.requests[1].messages.at(-1).content;
    assert.deepEqual(results.map((r) => r.tool_use_id), ['a', 'b']);
  });

  test('tool errors are sent back as is_error results and the loop continues', async () => {
    const client = fakeClient([use(['a', 'initiate_refund'], ['b', 'get_order']), say('Sorry about that.')]);
    const tools = fakeTools({
      initiate_refund: { text: '{"ok":false,"error":"outside_refund_window"}', isError: true },
      get_order: new Error('MCP connection closed'),
    });
    const seen = [];
    const chat = createChat({ client, tools: TOOLS, callTool: tools.callTool, onToolCall: (c) => seen.push(c) });

    assert.equal((await chat.send('Refund please')).text, 'Sorry about that.');
    const [refund, order] = client.requests[1].messages.at(-1).content;
    assert.equal(refund.is_error, true);
    assert.match(refund.content, /outside_refund_window/);
    assert.equal(order.is_error, true);
    assert.match(order.content, /could not be run: MCP connection closed/);
    assert.deepEqual(seen.map((c) => [c.name, c.isError]), [['initiate_refund', true], ['get_order', true]]);
  });

  test('a throwing onToolCall still sends every tool result', async () => {
    const client = fakeClient([use(['a', 'initiate_refund']), say('Refund done.')]);
    const chat = createChat({
      client, tools: TOOLS, callTool: fakeTools().callTool,
      onToolCall: () => { throw new Error('logger broke'); },
    });
    assert.equal((await chat.send('Refund ₹500')).text, 'Refund done.');
    assert.equal(client.requests[1].messages.at(-1).content[0].tool_use_id, 'a');
    assertValidMessages(client.requests[1].messages);
  });

  test('after the round limit, the model must answer without tools', async () => {
    const client = fakeClient([use(['a', 'get_order']), use(['b', 'get_order']), say('Here is what I found.')]);
    const tools = fakeTools();
    const result = await createChat({ client, tools: TOOLS, callTool: tools.callTool, maxRounds: 2 }).send('Loop');
    assert.equal(result.text, 'Here is what I found.');
    assert.equal(tools.calls.length, 2);
    assert.equal('tool_choice' in client.requests[1], false);
    assert.deepEqual(client.requests[2].tool_choice, { type: 'none' });
  });

  test("a tool call cut off by max_tokens isn't run, and the turn is rolled back", async () => {
    const client = fakeClient([say('Hello!'), { ...use(['a', 'initiate_refund']), stop_reason: 'max_tokens' }]);
    const tools = fakeTools();
    const chat = createChat({ client, tools: TOOLS, callTool: tools.callTool });
    await chat.send('Hi');
    const { text, stopReason } = await chat.send('Refund ₹500');
    assert.equal(stopReason, 'max_tokens');
    assert.match(text, /cut off/);
    assert.equal(tools.calls.length, 0);
    assert.equal(chat.history.length, 2);
  });

  test('an API error after a tool round keeps that round, and the next message joins its results', async () => {
    const client = fakeClient([use(['a', 'initiate_refund']), new Error('overloaded'), say('Your refund is done.')]);
    const tools = fakeTools();
    const chat = createChat({ client, tools: TOOLS, callTool: tools.callTool });

    await assert.rejects(chat.send('Refund ₹500'), /overloaded/);
    assert.equal(tools.calls.length, 1); // the refund ran, so the history must keep it
    assert.equal(chat.history.length, 3);

    await chat.send('Did it work?');
    const messages = client.requests[2].messages;
    assertValidMessages(messages);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[2].content.map((b) => b.type), ['tool_result', 'text']);
    assert.equal(messages[2].content[1].text, 'Did it work?');
  });

  test('a failed request right after a tool round removes the merged text again', async () => {
    const client = fakeClient([use(['a', 'get_order']), new Error('down'), new Error('still down')]);
    const chat = createChat({ client, tools: TOOLS, callTool: fakeTools().callTool });
    await assert.rejects(chat.send('Check my order'));
    await assert.rejects(chat.send('Hello?'));
    assert.deepEqual(chat.history.at(-1).content.map((b) => b.type), ['tool_result']);
  });
});

describe('createChat', () => {
  test('sends the whole history on each turn, with the full assistant content', async () => {
    const assistantContent = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Hello!' }];
    const client = fakeClient([{ content: assistantContent }, say('Sure.')]);
    const chat = createChat({ client, model: 'test-model', system: 'SYSTEM' });

    assert.equal((await chat.send('Hi')).text, 'Hello!');
    assert.equal((await chat.send('I want a refund')).text, 'Sure.');

    const second = client.requests[1];
    assert.equal(second.model, 'test-model');
    assert.equal(second.system, 'SYSTEM');
    assert.deepEqual(second.messages, [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: 'I want a refund' },
    ]);
    assert.equal(chat.history.length, 4);
  });

  test('returns the stop reason and usage', async () => {
    const chat = createChat({ client: fakeClient([say('Hi', { usage: { input_tokens: 120, output_tokens: 8 } })]) });
    const result = await chat.send('Hi');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 8 });
  });

  test('marks a reply cut off by max_tokens', async () => {
    const chat = createChat({ client: fakeClient([say('Our policy is', { stop_reason: 'max_tokens' })]) });
    const { text, stopReason } = await chat.send('Explain the policy');
    assert.equal(stopReason, 'max_tokens');
    assert.match(text, /^Our policy is/);
    assert.match(text, /cut off/);
  });

  test('a refusal returns a fallback reply and leaves the history unchanged', async () => {
    const chat = createChat({ client: fakeClient([say('Hello!'), { content: [], stop_reason: 'refusal' }]) });
    await chat.send('Hi');
    const { text, stopReason } = await chat.send('something declined');
    assert.equal(stopReason, 'refusal');
    assert.match(text, /can't help with that/);
    assert.equal(chat.history.length, 2);
  });

  test('an empty reply returns a fallback and leaves the history unchanged', async () => {
    const client = fakeClient([say('Hello!'), { content: [] }, say('Sure.')]);
    const chat = createChat({ client });
    await chat.send('Hi');
    const { text, stopReason } = await chat.send('Are you there?');
    assert.equal(stopReason, 'end_turn');
    assert.match(text, /say that again/);
    assert.equal(chat.history.length, 2);
    await chat.send('Are you there?');
    assert.ok(client.requests[2].messages.every((m) => m.content.length > 0));
  });

  test('a failed request leaves the history unchanged and can be retried', async () => {
    const client = fakeClient([new Error('network down'), say('Hello!')]);
    const chat = createChat({ client });
    await assert.rejects(chat.send('Hi'), /network down/);
    assert.equal(chat.history.length, 0);
    await chat.send('Hi');
    assert.deepEqual(client.requests[1].messages, [{ role: 'user', content: 'Hi' }]);
  });

  test('reset clears the conversation', async () => {
    const chat = createChat({ client: fakeClient([say('Hello!')]) });
    await chat.send('Hi');
    chat.reset();
    assert.equal(chat.history.length, 0);
  });
});
