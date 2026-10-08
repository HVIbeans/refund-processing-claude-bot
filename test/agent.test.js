import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { createChat } from '../src/agent/chat.js';
import { DECISION_TOOL } from '../src/agent/decision.js';

// A stand-in for the Anthropic client: records each request and replies from a script.
// Like the SDK's messages.stream(), it emits each text block as 'text' pieces (split in two, as
// real deltas would be) before finalMessage() resolves. No real API calls in tests.
function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    messages: {
      stream(params) {
        requests.push(structuredClone(params)); // snapshot: the history array keeps changing
        const next = replies.shift();
        const listeners = { text: [], thinking: [], streamEvent: [] };
        const emit = (event, value) => listeners[event].forEach((cb) => cb(value));
        const streamText = (text) => {
          const half = Math.ceil(text.length / 2);
          for (const piece of [text.slice(0, half), text.slice(half)]) if (piece) emit('text', piece);
        };
        return {
          on(event, cb) {
            listeners[event]?.push(cb);
            return this;
          },
          async finalMessage() {
            if (next instanceof Error) throw next;
            if (next?.failAfter) {
              // Some text arrives, then the connection drops. failError lets a test pick which
              // error (e.g. an APIConnectionError, to exercise the one-retry path).
              emit('streamEvent', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
              streamText(next.failAfter);
              throw next.failError ?? new Error('stream interrupted');
            }
            const message = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, ...next };
            message.content.forEach((block, index) => {
              emit('streamEvent', { type: 'content_block_start', index, content_block: { type: block.type } });
              if (block.type === 'text') streamText(block.text);
              if (block.type === 'thinking' && block.thinking) emit('thinking', block.thinking);
            });
            return message;
          },
        };
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

describe('createChat thinking and effort', () => {
  const think = (thinking, text) => ({
    content: [{ type: 'thinking', thinking, signature: 'sig' }, { type: 'text', text }],
  });

  test('asks for adaptive thinking by default, with effort only when set', async () => {
    const client = fakeClient([say('a'), say('b')]);
    await createChat({ client }).send('Hi');
    await createChat({ client, effort: 'low' }).send('Hi');
    assert.deepEqual(client.requests[0].thinking, { type: 'adaptive' });
    assert.equal('output_config' in client.requests[0], false);
    assert.deepEqual(client.requests[1].output_config, { effort: 'low' });
  });

  test('thinking: false sends no thinking setting', async () => {
    const client = fakeClient([say('a')]);
    await createChat({ client, thinking: false }).send('Hi');
    assert.equal('thinking' in client.requests[0], false);
  });

  test('setEffort and setThinking change the next request and keep the history', async () => {
    const client = fakeClient([say('a'), say('b')]);
    const chat = createChat({ client, effort: 'medium' });
    await chat.send('Hi');
    chat.setEffort('high');
    chat.setThinking(false);
    await chat.send('Again');
    assert.deepEqual(client.requests[0].output_config, { effort: 'medium' });
    assert.deepEqual(client.requests[1].output_config, { effort: 'high' });
    assert.equal('thinking' in client.requests[1], false);
    assert.equal(client.requests[1].messages.length, 3);
  });

  test('streams thinking and text to separate callbacks', async () => {
    const thoughts = [];
    const pieces = [];
    const result = await createChat({
      client: fakeClient([think('Partly refunded already; check what is left.', 'You can get ₹4,000 back.')]),
      onThinking: (d) => thoughts.push(d), onText: (d) => pieces.push(d),
    }).send('Refund my shoes');
    assert.equal(thoughts.join(''), 'Partly refunded already; check what is left.');
    assert.equal(pieces.join(''), 'You can get ₹4,000 back.');
    assert.equal(result.text, 'You can get ₹4,000 back.');
  });

  test('the thinking before a tool call is sent back unchanged with the tool round', async () => {
    const thinkingBlock = { type: 'thinking', thinking: 'Verify first.', signature: 'sig-123' };
    const first = { content: [thinkingBlock, ...use(['t1', 'get_customer']).content], stop_reason: 'tool_use' };
    const client = fakeClient([first, say('Verified.')]);
    await createChat({ client, tools: TOOLS, callTool: fakeTools().callTool }).send('Hi');
    const assistant = client.requests[1].messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content[0], thinkingBlock);
    assert.equal(assistant.content[1].type, 'tool_use');
  });

  test('a reply cut off mid-thinking is rolled back, not kept with an unsigned block', async () => {
    let discarded = 0;
    const cutOff = { content: [{ type: 'thinking', thinking: 'Let me weigh the window and', signature: '' }], stop_reason: 'max_tokens' };
    const client = fakeClient([say('Hello!'), cutOff, say('Sure.')]);
    const chat = createChat({ client, onDiscard: () => discarded++ });
    await chat.send('Hi');
    const result = await chat.send('Is ORD-5003 refundable?');
    assert.equal(result.fallback, true);
    assert.match(result.text, /cut off/);
    assert.equal(discarded, 1);
    assert.equal(chat.history.length, 2);
    await chat.send('Again?');
    assert.ok(client.requests[2].messages.every((m) => !Array.isArray(m.content) || m.content.every((b) => b.type !== 'thinking' || b.signature)));
  });

  test('a refusal after streamed thinking withdraws it', async () => {
    let discarded = 0;
    const refused = { content: [{ type: 'thinking', thinking: 'Hmm.', signature: 's' }], stop_reason: 'refusal' };
    const result = await createChat({ client: fakeClient([refused]), onDiscard: () => discarded++ }).send('x');
    assert.equal(result.fallback, true);
    assert.equal(discarded, 1);
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

  test('streams the text of every API call in the turn, in order', async () => {
    const preamble = { content: [{ type: 'text', text: 'Let me check.' }, ...use(['a', 'get_order']).content], stop_reason: 'tool_use' };
    const client = fakeClient([preamble, say('It was delivered.')]);
    const pieces = [];
    const result = await createChat({ client, tools: TOOLS, callTool: fakeTools().callTool, onText: (d) => pieces.push(d) })
      .send('Where is my order?');
    assert.ok(pieces.length > 2, 'text arrives in pieces');
    assert.equal(pieces.join(''), 'Let me check.It was delivered.');
    assert.equal(result.text, 'It was delivered.');
    assert.equal(result.fallback, false);
  });

  test('separate text blocks in one reply are streamed with a line break between them', async () => {
    const reply = { content: [{ type: 'text', text: 'I checked.' }, { type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'All good.' }] };
    const pieces = [];
    const result = await createChat({ client: fakeClient([reply]), onText: (d) => pieces.push(d) }).send('Hi');
    assert.equal(pieces.join(''), 'I checked.\nAll good.');
    assert.equal(pieces.join(''), result.text);
  });

  test('our own replies are marked as fallback, because they were never streamed', async () => {
    const pieces = [];
    let discarded = 0;
    const chat = createChat({
      client: fakeClient([{ content: [], stop_reason: 'refusal' }]),
      onText: (d) => pieces.push(d), onDiscard: () => discarded++,
    });
    const result = await chat.send('something declined');
    assert.equal(result.fallback, true);
    assert.deepEqual(pieces, []);
    assert.equal(discarded, 0, 'nothing was shown, so nothing to withdraw');
  });

  test('a refusal after some streamed text withdraws that text', async () => {
    let discarded = 0;
    const chat = createChat({ client: fakeClient([say('Sure, here is', { stop_reason: 'refusal' })]), onDiscard: () => discarded++ });
    const result = await chat.send('something declined');
    assert.equal(result.fallback, true);
    assert.equal(discarded, 1);
    assert.equal(chat.history.length, 0);
  });

  test("a streamed promise before a cut-off tool call is withdrawn, and the tool isn't run", async () => {
    const promise = { content: [{ type: 'text', text: "I'll refund ₹4,000 now." }, ...use(['a', 'initiate_refund']).content], stop_reason: 'max_tokens' };
    const tools = fakeTools();
    let discarded = 0;
    const chat = createChat({ client: fakeClient([promise]), tools: TOOLS, callTool: tools.callTool, onDiscard: () => discarded++ });
    const result = await chat.send('Refund please');
    assert.equal(discarded, 1);
    assert.equal(result.fallback, true);
    assert.equal(tools.calls.length, 0);
  });

  test('a stream that fails partway withdraws its text and rolls back', async () => {
    let discarded = 0;
    const chat = createChat({ client: fakeClient([{ failAfter: 'Your refund is' }]), onDiscard: () => discarded++ });
    await assert.rejects(chat.send('Refund please'), /stream interrupted/);
    assert.equal(discarded, 1);
    assert.equal(chat.history.length, 0);
  });

  test('a throwing onText still finishes the turn', async () => {
    const chat = createChat({ client: fakeClient([say('Hello!')]), onText: () => { throw new Error('terminal gone'); } });
    assert.equal((await chat.send('Hi')).text, 'Hello!');
    assert.equal(chat.history.length, 2);
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

describe('createChat structured decisions', () => {
  const decide = (input, extra = {}) => ({ content: [{ type: 'tool_use', id: 'd1', name: 'record_decision', input }], ...extra });
  const NONE = { decision: 'none', amount: 0, reason: 'just chatting', needs_human: false };

  test('decide defaults to off: no extraction call is made', async () => {
    const client = fakeClient([say('Hello!')]);
    const result = await createChat({ client }).send('Hi');
    assert.equal(result.decision, undefined);
    assert.equal(result.calls, 1);
    assert.equal(client.requests.length, 1);
  });

  test('decide: true requests a decision after a normal reply, with a forced tool_choice', async () => {
    const client = fakeClient([say('Hello!'), decide(NONE)]);
    const result = await createChat({ client, decide: true }).send('Hi');
    assert.deepEqual(result.decision, NONE);
    assert.equal(result.calls, 2);
    assert.deepEqual(client.requests[1].tools, [DECISION_TOOL]);
    assert.deepEqual(client.requests[1].tool_choice, { type: 'tool', name: 'record_decision' });
  });

  test('fallback replies (refusal, empty, cut-off tool call) still attempt decision extraction, from whatever already happened', async () => {
    // Nothing happened before any of these, so each falls back to a harmless "none".
    const refusal = await createChat({ client: fakeClient([{ content: [], stop_reason: 'refusal' }]), decide: true }).send('x');
    assert.equal(refusal.decision.decision, 'none');

    const empty = await createChat({ client: fakeClient([{ content: [] }]), decide: true }).send('x');
    assert.equal(empty.decision.decision, 'none');

    const cutOffClient = fakeClient([{ ...use(['a', 'initiate_refund']), stop_reason: 'max_tokens' }]);
    const cutOff = await createChat({ client: cutOffClient, tools: TOOLS, callTool: fakeTools().callTool, decide: true }).send('x');
    assert.equal(cutOff.decision.decision, 'none'); // the cut-off tool call itself was never run
    assert.equal(cutOffClient.requests.length, 2); // the cut-off attempt, plus the extraction call
  });

  test('a tool-use round triggers exactly one extraction call, after the final reply', async () => {
    const client = fakeClient([use(['a', 'get_order']), say('Found it.'), decide({ ...NONE, reason: 'lookup only' })]);
    const result = await createChat({ client, tools: TOOLS, callTool: fakeTools().callTool, decide: true }).send('Where is my order?');
    assert.equal(result.text, 'Found it.');
    assert.equal(client.requests.length, 3);
    assert.equal(result.calls, 3);
    assert.deepEqual(result.decision, { ...NONE, reason: 'lookup only' });
  });

  test('setDecide toggles mid-conversation', async () => {
    const client = fakeClient([say('First'), say('Second'), decide(NONE)]);
    const chat = createChat({ client, decide: false });
    await chat.send('Hi');
    chat.setDecide(true);
    await chat.send('Again');
    assert.equal(client.requests.length, 3);
  });

  test("extraction usage is added into the turn's total usage", async () => {
    const client = fakeClient([
      say('Hi', { usage: { input_tokens: 100, output_tokens: 10 } }),
      decide(NONE, { usage: { input_tokens: 50, output_tokens: 5 } }),
    ]);
    const result = await createChat({ client, decide: true }).send('Hi');
    assert.deepEqual(result.usage, { input_tokens: 150, output_tokens: 15 });
  });

  test('a failed extraction call still returns the customer reply, with a safe fallback decision', async () => {
    const client = fakeClient([say('Hello!'), new Error('rate limited')]);
    const result = await createChat({ client, decide: true }).send('Hi');
    assert.equal(result.text, 'Hello!');
    assert.equal(result.decision.decision, 'none');
    assert.match(result.decision.reason, /decision extraction failed/);
  });

  test('a refusal after a successful tool round still extracts a decision from what already happened', async () => {
    const client = fakeClient([
      use(['a', 'initiate_refund']),
      { content: [], stop_reason: 'refusal' },
      decide({ decision: 'approved', amount: 500, reason: 'refund issued before the refusal', needs_human: false }),
    ]);
    const tools = fakeTools({ initiate_refund: { text: '{"ok":true}', isError: false } });
    const result = await createChat({ client, tools: TOOLS, callTool: tools.callTool, decide: true }).send('Refund please');
    assert.equal(result.fallback, true);
    assert.deepEqual(result.decision, { decision: 'approved', amount: 500, reason: 'refund issued before the refusal', needs_human: false });
    assert.equal(client.requests.length, 3);
    // The extraction call's history still ends in the tool-result message; it must not send two
    // consecutive user messages (the real API rejects that).
    assertValidMessages(client.requests[2].messages);
  });
});

describe('createChat prompt caching', () => {
  const CACHE_CONTROL = { type: 'ephemeral' };

  test('cache defaults to off: system is a plain string, tools carry no cache_control', async () => {
    const client = fakeClient([say('Hi')]);
    await createChat({ client, tools: TOOLS }).send('Hi');
    assert.equal(typeof client.requests[0].system, 'string');
    assert.equal('cache_control' in client.requests[0].tools[0], false);
  });

  test('cache: true marks the system prompt and the last tool as cache breakpoints', async () => {
    const twoTools = [...TOOLS, { name: 'get_order', description: 'Look up', input_schema: { type: 'object', properties: {} } }];
    const client = fakeClient([say('Hi')]);
    await createChat({ client, system: 'SYSTEM', tools: twoTools, cache: true }).send('Hi');

    const req = client.requests[0];
    assert.deepEqual(req.system, [{ type: 'text', text: 'SYSTEM', cache_control: CACHE_CONTROL }]);
    assert.equal('cache_control' in req.tools[0], false);
    assert.deepEqual(req.tools[1].cache_control, CACHE_CONTROL);
    assert.equal(req.tools[0].name, 'get_customer');
    assert.equal(req.tools[1].name, 'get_order');
  });

  test('cache: true, decide: true: the decision call shares the exact cached system and tools prefix', async () => {
    const decide = (input) => ({ content: [{ type: 'tool_use', id: 'd1', name: 'record_decision', input }] });
    const NONE = { decision: 'none', amount: 0, reason: 'just chatting', needs_human: false };
    const client = fakeClient([say('Hi'), decide(NONE)]);
    await createChat({ client, system: 'SYSTEM', tools: TOOLS, cache: true, decide: true }).send('Hi');

    const [conversational, extraction] = client.requests;
    assert.deepEqual(extraction.system, conversational.system);
    assert.deepEqual(extraction.tools.slice(0, TOOLS.length), conversational.tools);
    assert.equal(extraction.tools.at(-1).name, 'record_decision');
  });

  test('decide: true with cache left off: the decision call still sends only its own tool, unchanged', async () => {
    const decide = (input) => ({ content: [{ type: 'tool_use', id: 'd1', name: 'record_decision', input }] });
    const NONE = { decision: 'none', amount: 0, reason: 'just chatting', needs_human: false };
    const client = fakeClient([say('Hi'), decide(NONE)]);
    await createChat({ client, tools: TOOLS, decide: true }).send('Hi');
    assert.deepEqual(client.requests[1].tools, [DECISION_TOOL]);
  });

  test('setCache toggles mid-conversation', async () => {
    const client = fakeClient([say('First'), say('Second')]);
    const chat = createChat({ client, system: 'SYSTEM', tools: TOOLS, cache: false });
    await chat.send('Hi');
    assert.equal(typeof client.requests[0].system, 'string');
    chat.setCache(true);
    await chat.send('Again');
    assert.notEqual(typeof client.requests[1].system, 'string');
  });
});

describe('createChat connection retry', () => {
  test('retries once on an APIConnectionError and succeeds', async () => {
    const client = fakeClient([new Anthropic.APIConnectionError({ message: 'network down' }), say('Hello!')]);
    const result = await createChat({ client }).send('Hi');
    assert.equal(result.text, 'Hello!');
    assert.equal(client.requests.length, 2);
  });

  test('gives up and rolls back after a second APIConnectionError in the same round', async () => {
    const client = fakeClient([
      new Anthropic.APIConnectionError({ message: 'still down' }),
      new Anthropic.APIConnectionError({ message: 'still down' }),
    ]);
    const chat = createChat({ client });
    await assert.rejects(chat.send('Hi'), /still down/);
    assert.equal(client.requests.length, 2);
    assert.equal(chat.history.length, 0); // rolled back, safe to retry later
  });

  test('does not retry a non-connection error (e.g. a rate limit or auth failure)', async () => {
    const client = fakeClient([new Error('rate limited')]);
    await assert.rejects(createChat({ client }).send('Hi'), /rate limited/);
    assert.equal(client.requests.length, 1);
  });

  test('withdraws any partial output streamed before the dropped connection, then retries cleanly', async () => {
    let discarded = 0;
    const client = fakeClient([
      { failAfter: 'Your refund is', failError: new Anthropic.APIConnectionError({ message: 'dropped' }) },
      say('All set.'),
    ]);
    const result = await createChat({ client, onDiscard: () => discarded++ }).send('Hi');
    assert.equal(discarded, 1);
    assert.equal(result.text, 'All set.');
  });
});
