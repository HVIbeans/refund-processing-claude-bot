import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_TOOL, extractDecision } from '../src/agent/decision.js';

// A stand-in for the Anthropic client: one scripted reply (or Error), no streaming listeners needed.
function fakeClient(reply) {
  const requests = [];
  return {
    requests,
    messages: {
      stream(params) {
        requests.push(structuredClone(params));
        return {
          on() {
            return this;
          },
          async finalMessage() {
            if (reply instanceof Error) throw reply;
            return { content: [], usage: { input_tokens: 1, output_tokens: 1 }, ...reply };
          },
        };
      },
    },
  };
}

const toolUse = (input) => ({ content: [{ type: 'tool_use', id: 't1', name: 'record_decision', input }] });

describe('extractDecision', () => {
  test('sends a forced tool_choice request with only the decision tool, and no thinking', async () => {
    const client = fakeClient(toolUse({ decision: 'approved', amount: 500, reason: 'within window', needs_human: false }));
    const history = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ];
    const snapshot = structuredClone(history);

    await extractDecision({ client, model: 'test-model', system: 'SYSTEM', history });

    const req = client.requests[0];
    assert.equal(req.model, 'test-model');
    assert.equal(req.system, 'SYSTEM');
    assert.deepEqual(req.tools, [DECISION_TOOL]);
    assert.deepEqual(req.tool_choice, { type: 'tool', name: 'record_decision' });
    assert.equal('thinking' in req, false);
    assert.deepEqual(history, snapshot, 'the passed-in history is never mutated');
    assert.equal(req.messages.length, history.length + 1);
    assert.equal(req.messages.at(-1).role, 'user');
  });

  test('appends DECISION_TOOL after any tools passed in, for cache-prefix sharing', async () => {
    const sharedTool = { name: 'get_customer', description: 'Look up', input_schema: { type: 'object', properties: {} } };
    const client = fakeClient(toolUse({ decision: 'none', amount: 0, reason: 'r', needs_human: false }));
    await extractDecision({ client, model: 'm', system: 's', history: [], tools: [sharedTool] });
    assert.deepEqual(client.requests[0].tools, [sharedTool, DECISION_TOOL]);
  });

  test('parses a valid tool_use block into the expected shape, plus usage', async () => {
    const client = fakeClient({
      ...toolUse({ decision: 'denied', amount: 0, reason: 'outside window', needs_human: false }),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await extractDecision({ client, model: 'm', system: 's', history: [] });
    assert.deepEqual(result, {
      decision: 'denied', amount: 0, reason: 'outside window', needs_human: false,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  test('falls back to decision: none when the tool_use block is missing', async () => {
    const client = fakeClient({ content: [{ type: 'text', text: 'oops, no tool call' }] });
    const result = await extractDecision({ client, model: 'm', system: 's', history: [] });
    assert.equal(result.decision, 'none');
    assert.equal(result.amount, 0);
    assert.equal(result.needs_human, false);
  });

  test('falls back to decision: none when the input fails schema validation', async () => {
    const badInputs = [
      { decision: 'maybe', amount: 100, reason: 'bad enum value', needs_human: false },
      { decision: 'approved', amount: -5, reason: 'negative amount', needs_human: false },
      { decision: 'approved', amount: 5, needs_human: false }, // missing reason
      { decision: 'approved', amount: 5, reason: 'x', needs_human: 'yes' }, // wrong type
    ];
    for (const input of badInputs) {
      const client = fakeClient(toolUse(input));
      const result = await extractDecision({ client, model: 'm', system: 's', history: [] });
      assert.equal(result.decision, 'none', `expected a fallback for ${JSON.stringify(input)}`);
    }
  });

  test('truncates an overlong reason instead of discarding an otherwise-valid decision', async () => {
    const longReason = 'x'.repeat(2500);
    const client = fakeClient(toolUse({ decision: 'escalated', amount: 12000, reason: longReason, needs_human: true }));
    const result = await extractDecision({ client, model: 'm', system: 's', history: [] });
    assert.equal(result.decision, 'escalated');
    assert.equal(result.amount, 12000);
    assert.equal(result.needs_human, true);
    assert.equal(result.reason.length, 2000);
  });

  test('truncation never splits a surrogate pair', async () => {
    const emoji = '😀'; // a single surrogate pair, 2 UTF-16 code units
    const longReason = 'x'.repeat(1999) + emoji + 'y'.repeat(10); // the pair straddles index 2000
    const client = fakeClient(toolUse({ decision: 'denied', amount: 0, reason: longReason, needs_human: false }));
    const result = await extractDecision({ client, model: 'm', system: 's', history: [] });
    assert.equal(result.reason.length, 1999); // drops the whole pair rather than split it
    assert.doesNotMatch(result.reason, /[\uD800-􏰀-\uDFFF]/);
  });

  test("merges the instruction into a trailing tool-result message instead of starting a second consecutive user message", async () => {
    const client = fakeClient(toolUse({ decision: 'approved', amount: 500, reason: 'r', needs_human: false }));
    const history = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'initiate_refund', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] },
    ];
    const snapshot = structuredClone(history);

    await extractDecision({ client, model: 'm', system: 's', history });

    const messages = client.requests[0].messages;
    assert.equal(messages.length, 3); // no 4th message: merged into the trailing tool-result message
    assert.equal(messages.at(-1).role, 'user');
    assert.deepEqual(messages.at(-1).content[0], { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' });
    assert.equal(messages.at(-1).content[1].type, 'text');
    assert.match(messages.at(-1).content[1].text, /Call record_decision now/);
    assert.deepEqual(history, snapshot, 'the passed-in history is never mutated');
  });

  test('DECISION_TOOL gets its own cache breakpoint when the shared tools are already cache-marked', async () => {
    const cachedTool = {
      name: 'get_customer', description: 'Look up', input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral' },
    };
    const client = fakeClient(toolUse({ decision: 'none', amount: 0, reason: 'r', needs_human: false }));
    await extractDecision({ client, model: 'm', system: 's', history: [], tools: [cachedTool] });
    const [shared, decisionTool] = client.requests[0].tools;
    assert.deepEqual(shared, cachedTool);
    assert.deepEqual(decisionTool.cache_control, { type: 'ephemeral' });
  });

  test("DECISION_TOOL stays uncached when the shared tools aren't cache-marked", async () => {
    const plainTool = { name: 'get_customer', description: 'Look up', input_schema: { type: 'object', properties: {} } };
    const client = fakeClient(toolUse({ decision: 'none', amount: 0, reason: 'r', needs_human: false }));
    await extractDecision({ client, model: 'm', system: 's', history: [], tools: [plainTool] });
    assert.equal('cache_control' in client.requests[0].tools.at(-1), false);
  });
});
