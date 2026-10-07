import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toRunnerTool, applyCacheToSystem, applyCacheToTools } from '../src/agent/toolRunnerChat.js';

const TOOL = { name: 'get_customer', description: 'Look up', input_schema: { type: 'object', properties: {} } };

describe('toRunnerTool', () => {
  test('wraps the Claude tool def for the runner (name, description, input_schema)', () => {
    const tool = toRunnerTool(TOOL, async () => ({ text: '{}', isError: false }));
    assert.equal(tool.name, 'get_customer');
    assert.equal(tool.description, 'Look up');
    assert.deepEqual(tool.input_schema, { type: 'object', properties: {} });
    assert.equal(typeof tool.run, 'function');
  });

  test('run() calls callTool and returns its text on success, notifying onToolCall', async () => {
    const calls = [];
    const callTool = async (name, input) => {
      calls.push({ name, input });
      return { text: '{"ok":true}', isError: false };
    };
    const seen = [];
    const tool = toRunnerTool(TOOL, callTool, (c) => seen.push(c));

    const result = await tool.run({ email: 'a@b.com' });

    assert.equal(result, '{"ok":true}');
    assert.deepEqual(calls, [{ name: 'get_customer', input: { email: 'a@b.com' } }]);
    assert.deepEqual(seen, [{ name: 'get_customer', input: { email: 'a@b.com' }, isError: false, text: '{"ok":true}' }]);
  });

  test('run() throws with the tool text when callTool reports an error', async () => {
    const callTool = async () => ({ text: 'outside_refund_window', isError: true });
    const tool = toRunnerTool(TOOL, callTool);
    await assert.rejects(() => tool.run({}), /outside_refund_window/);
  });

  test('a throwing onToolCall does not stop run() from returning the result', async () => {
    const callTool = async () => ({ text: '{"ok":true}', isError: false });
    const tool = toRunnerTool(TOOL, callTool, () => {
      throw new Error('logger broke');
    });
    assert.equal(await tool.run({}), '{"ok":true}');
  });
});

describe('applyCacheToSystem / applyCacheToTools', () => {
  test('pass through unchanged when caching is off', () => {
    assert.equal(applyCacheToSystem('SYSTEM', false), 'SYSTEM');
    const tools = [{ name: 'a' }, { name: 'b' }];
    assert.deepEqual(applyCacheToTools(tools, false), tools);
  });

  test('mark the system prompt and the last tool as cache breakpoints when on', () => {
    assert.deepEqual(applyCacheToSystem('SYSTEM', true), [
      { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
    ]);
    const tools = [{ name: 'a' }, { name: 'b' }];
    const result = applyCacheToTools(tools, true);
    assert.equal('cache_control' in result[0], false);
    assert.deepEqual(result[1].cache_control, { type: 'ephemeral' });
  });

  test('an empty tool list is left empty even with caching on', () => {
    assert.deepEqual(applyCacheToTools([], true), []);
  });
});
