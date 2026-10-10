import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { allowOnlyHook, buildOptions, createSdkChat } from '../src/agent/sdkChat.js';

const CUSTOMER_TOOLS = ['get_customer', 'get_order', 'get_payment', 'initiate_refund', 'escalate_to_human'];
const TOOLS = CUSTOMER_TOOLS.map((name) => ({ name, description: name, input_schema: { type: 'object' } }));
const P = 'mcp__refund-tools__';

// SDK message builders, in the shapes sdk.d.ts declares.
const delta = (text) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const textStart = () => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
const toolUse = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, text, isError = false) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] } });
const success = (result, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 1, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001, ...extra });

// A fake query(): records its options and, for each customer message it reads from the prompt
// iterable, yields the next scripted batch of messages.
function fakeQuery(...turns) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const call = { options, prompts: [], closed: false, flags: [] };
    calls.push(call);
    async function* run() {
      yield { type: 'system', subtype: 'init', tools: options.allowedTools, mcp_servers: [{ name: 'refund-tools', status: 'connected' }], model: options.model };
      for await (const msg of prompt) {
        call.prompts.push(msg.message.content);
        yield* turns.shift() ?? [success('(no script)')];
        if (call.closed) return;
      }
    }
    const q = run();
    q.close = () => { call.closed = true; };
    q.applyFlagSettings = async (s) => { call.flags.push(s); };
    return q;
  };
  return { query, calls };
}

describe('buildOptions', () => {
  const options = buildOptions({ model: 'm', system: 'SYS', toolNames: CUSTOMER_TOOLS, hiddenToolNames: ['log_decision'], thinking: true, effort: 'low' });

  test('sends customer text as written: no @file expansion, no slash commands', () => {
    assert.equal(options.verbatimPrompts, true);
  });

  test('removes hidden server tools from the request, not just from the allowlist', () => {
    assert.deepEqual(options.disallowedTools, [P + 'log_decision']);
  });

  test('loads nothing from disk and has no built-in tools', () => {
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.skills, []);
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.persistSession, false);
    assert.equal(options.systemPrompt, 'SYS');
  });

  test('keeps auto-memory, title generation and the project folder out of the context', () => {
    assert.deepEqual(options.settings, { autoMemoryEnabled: false });
    assert.equal(typeof options.title, 'string');
    assert.ok(!options.cwd.startsWith(process.cwd()), options.cwd);
  });

  test('allows exactly the customer tools, and denies anything else without asking', () => {
    assert.deepEqual(options.allowedTools, CUSTOMER_TOOLS.map((n) => P + n));
    assert.equal(options.permissionMode, 'dontAsk');
  });

  test("starts only the agent's server, without --reviewer or the API key", () => {
    assert.deepEqual(Object.keys(options.mcpServers), ['refund-tools']);
    const server = options.mcpServers['refund-tools'];
    assert.match(server.args.at(-1), /src[\\/]mcp[\\/]stdio\.js$/);
    assert.ok(!server.args.includes('--reviewer'));
    assert.equal(server.env.ANTHROPIC_API_KEY, undefined);
  });

  test('passes thinking and effort through', () => {
    assert.deepEqual(options.thinking, { type: 'adaptive' });
    assert.equal(options.effort, 'low');
    const off = buildOptions({ model: 'm', system: 'S', toolNames: [], thinking: false });
    assert.deepEqual(off.thinking, { type: 'disabled' });
    assert.ok(!('effort' in off));
  });
});

describe('allowOnlyHook', () => {
  const hook = allowOnlyHook(new Set([P + 'get_customer']));
  const pre = (tool_name) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} });

  test('lets an allowed tool through', async () => {
    assert.deepEqual(await pre(P + 'get_customer'), {});
  });

  for (const name of ['Bash', P + 'resolve_refund_approval', P + 'log_decision']) {
    test(`denies ${name}`, async () => {
      const { hookSpecificOutput } = await pre(name);
      assert.equal(hookSpecificOutput.permissionDecision, 'deny');
    });
  }
});

describe('createSdkChat', () => {
  test('streams the text and returns the result, usage and calls', async () => {
    const { query } = fakeQuery([delta('Hel'), delta('lo'), success('Hello')]);
    const texts = [];
    let init;
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS, onText: (t) => texts.push(t), onInit: (i) => { init = i; } });

    const reply = await chat.send('hi');

    assert.deepEqual(texts, ['Hel', 'lo']);
    assert.equal(reply.text, 'Hello');
    assert.equal(reply.fallback, false);
    assert.equal(reply.calls, 1);
    assert.deepEqual(reply.usage, { input_tokens: 10, output_tokens: 5 });
    assert.deepEqual(init.tools, CUSTOMER_TOOLS.map((n) => P + n));
    chat.close();
  });

  test('puts a line break between separate text blocks', async () => {
    const { query } = fakeQuery([textStart(), delta('One.'), textStart(), delta('Two.'), success('One.\nTwo.')]);
    const texts = [];
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS, onText: (t) => texts.push(t) });
    await chat.send('hi');
    assert.equal(texts.join(''), 'One.\nTwo.');
    chat.close();
  });

  test('reports each tool call with its short name, input and result', async () => {
    const { query } = fakeQuery([
      toolUse('t1', P + 'get_customer', { email: 'a@b.com' }),
      toolResult('t1', '{"ok":false,"error":"not_found"}', true),
      success('Not found'),
    ]);
    const seen = [];
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS, onToolCall: (c) => seen.push(c) });
    await chat.send('hi');
    assert.deepEqual(seen, [{ name: 'get_customer', input: { email: 'a@b.com' }, isError: true, text: '{"ok":false,"error":"not_found"}' }]);
    chat.close();
  });

  test('keeps one conversation across turns, and /reset starts a new one', async () => {
    const { query, calls } = fakeQuery([success('A')], [success('B')], [success('C')]);
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS });

    assert.equal((await chat.send('one')).text, 'A');
    assert.equal((await chat.send('two')).text, 'B');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].prompts, ['one', 'two']);

    chat.reset();
    assert.equal(calls[0].closed, true);
    assert.equal((await chat.send('three')).text, 'C');
    assert.equal(calls.length, 2);
    chat.close();
  });

  test('a turn that ends in an error result gets a fallback reply', async () => {
    const { query } = fakeQuery([{ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 8, stop_reason: null, usage: {}, errors: [] }]);
    let discarded = 0;
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS, onDiscard: () => { discarded += 1; } });
    const reply = await chat.send('hi');
    assert.equal(reply.fallback, true);
    assert.equal(reply.stopReason, 'error_max_turns');
    assert.equal(discarded, 1, 'text streamed before the error is withdrawn');
    chat.close();
  });

  test('a stream that fails rejects the turn, and the next send starts over', async () => {
    let n = 0;
    const query = () => {
      n += 1;
      const q = (async function* () {
        if (n === 1) throw new Error('process crashed');
        yield success('back');
      })();
      q.close = () => {};
      return q;
    };
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS });
    await assert.rejects(() => chat.send('hi'), /process crashed/);
    assert.equal((await chat.send('again')).text, 'back');
    assert.equal(n, 2);
    chat.close();
  });

  test('refuses to start a conversation whose session has tools beyond the allowlist', async () => {
    const query = ({ options }) => {
      const q = (async function* () {
        yield { type: 'system', subtype: 'init', tools: [...options.allowedTools, 'Bash'], mcp_servers: [], model: 'm' };
        yield success('should never be returned');
      })();
      q.close = () => {};
      return q;
    };
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS });
    await assert.rejects(() => chat.send('hi'), /unexpected tools: Bash/);
    chat.close();
  });

  test('effort changes apply to the running conversation', async () => {
    const { query, calls } = fakeQuery([success('A')]);
    const chat = createSdkChat({ query, system: 'S', tools: TOOLS, effort: 'medium' });
    await chat.send('hi');
    chat.setEffort('high');
    assert.deepEqual(calls[0].flags, [{ effortLevel: 'high' }]);
    assert.equal(chat.settings.effort, 'high');
    chat.close();
  });
});
