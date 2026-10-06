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
});
