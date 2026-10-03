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
