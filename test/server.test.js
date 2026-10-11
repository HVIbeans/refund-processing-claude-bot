import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { MAX_TEXT } from '../src/policy.js';

// A real HTTP server on a random port, with a fake agent in place of chat.js: no API calls.
// Each conversation records its messages and plays the next step of `script` for every send().
// A step is ({ onText, onDiscard, onWorking }, message) => reply, and may be async or throw.
function fakeAgents(script) {
  const conversations = [];
  const createConversation = (callbacks) => {
    const conv = { messages: [] };
    conversations.push(conv);
    return {
      async send(message) {
        conv.messages.push(message);
        const step = script.shift() ?? ((cb) => {
          cb.onText('ok');
          return { text: 'ok', fallback: false };
        });
        return step(callbacks, message);
      },
    };
  };
  return { conversations, createConversation };
}

let server;
let base;
async function start(options) {
  server = await startServer({ port: 0, ...options });
  base = `http://127.0.0.1:${server.address().port}`;
}
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

// POSTs to /api/chat and parses the SSE response into [{ event, data }].
async function chat(body, { raw } = {}) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
    return { status: response.status, json: JSON.parse(text), text };
  }
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    return {
      event: lines.find((l) => l.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith('data: ')).slice(6)),
    };
  });
  return { status: response.status, events, text };
}

describe('POST /api/chat', () => {
  test('streams start, working, the reply pieces and done, in order', async () => {
    const { createConversation } = fakeAgents([
      ({ onText, onWorking }) => {
        onWorking();
        onText('Your refund ');
        onText('is done.');
        return { text: 'Your refund is done.', fallback: false, usage: { input_tokens: 99 }, decision: { decision: 'approved' } };
      },
    ]);
    await start({ createConversation });

    const { status, events, text } = await chat({ message: 'refund please' });

    assert.equal(status, 200);
    assert.deepEqual(events.map((e) => e.event), ['start', 'working', 'text', 'text', 'done']);
    assert.match(events[0].data.conversationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(events.at(-1).data, { text: 'Your refund is done.', fallback: false });
    // Usage and the decision stay on the server.
    assert.doesNotMatch(text, /input_tokens|approved|decision/);
  });

  test('the same conversation ID continues the chat; an unknown one starts a new chat', async () => {
    const agents = fakeAgents([]);
    await start({ createConversation: agents.createConversation });

    const first = await chat({ message: 'one' });
    const id = first.events[0].data.conversationId;
    const second = await chat({ conversationId: id, message: 'two' });
    assert.equal(second.events[0].data.conversationId, id);

    const other = await chat({ conversationId: 'not-a-real-id', message: 'three' });
    assert.notEqual(other.events[0].data.conversationId, id);
    assert.deepEqual(agents.conversations.map((c) => c.messages), [['one', 'two'], ['three']]);
  });

  test('a second message while a reply is still running gets 409', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { createConversation } = fakeAgents([async () => {
      await gate;
      return { text: 'done', fallback: false };
    }]);
    await start({ createConversation });

    const first = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'slow' }) });
    const reader = first.body.pipeThrough(new TextDecoderStream()).getReader();
    const { value } = await reader.read(); // the start event, written before the turn runs
    const id = JSON.parse(value.split('data: ')[1]).conversationId;

    const busy = await chat({ conversationId: id, message: 'hurry up' });
    assert.equal(busy.status, 409);

    release();
    while (!(await reader.read()).done);
    assert.equal((await chat({ conversationId: id, message: 'now?' })).status, 200);
  });

  test('a withdrawn reply becomes a discard event, followed by the fallback text', async () => {
    const { createConversation } = fakeAgents([({ onText, onDiscard }) => {
      onText('Sure, I will refund');
      onDiscard();
      return { text: 'Sorry, could you say that again?', fallback: true };
    }]);
    await start({ createConversation });

    const { events } = await chat({ message: 'hi' });
    assert.deepEqual(events.map((e) => e.event), ['start', 'text', 'discard', 'done']);
    assert.deepEqual(events.at(-1).data, { text: 'Sorry, could you say that again?', fallback: true });
  });

  test('a failed turn sends a generic error, never the internal details', async () => {
    const { createConversation } = fakeAgents([() => {
      throw new Error('SQLITE_CORRUPT at C:\\secret\\refunds.db');
    }]);
    await start({ createConversation });
    const original = console.error;
    console.error = () => {}; // the details go to the server log; keep the test output clean
    try {
      const { events, text } = await chat({ message: 'hi' });
      assert.equal(events.at(-1).event, 'error');
      assert.doesNotMatch(text, /SQLITE|secret|refunds\.db/);
    } finally {
      console.error = original;
    }
  });

  test('rejects bad requests before running the agent', async () => {
    const agents = fakeAgents([]);
    await start({ createConversation: agents.createConversation });

    assert.equal((await chat(null, { raw: 'not json' })).status, 400);
    assert.equal((await chat({ message: '   ' })).status, 400);
    assert.equal((await chat({ message: 42 })).status, 400);
    assert.equal((await chat({ message: 'x'.repeat(MAX_TEXT + 1) })).status, 413);
    assert.equal((await chat(null, { raw: JSON.stringify({ message: 'x'.repeat(10_000) }) })).status, 413);
    assert.equal(agents.conversations.length, 0);

    const get = await fetch(`${base}/api/chat`);
    assert.equal(get.status, 405);
  });

  test('answers 503 when the agent could not start, while the pages still work', async () => {
    await start({}); // no createConversation
    assert.equal((await chat({ message: 'hi' })).status, 503);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /textContent/);
  });

  test('drops conversations idle for longer than idleMs', async () => {
    let clock = 0;
    const agents = fakeAgents([]);
    await start({ createConversation: agents.createConversation, idleMs: 1000, now: () => clock });

    const id = (await chat({ message: 'one' })).events[0].data.conversationId;
    clock = 5000;
    const later = await chat({ conversationId: id, message: 'two' });
    assert.notEqual(later.events[0].data.conversationId, id);
    assert.equal(agents.conversations.length, 2);
  });
});

describe('the chat page', () => {
  test('never inserts reply text as HTML', async () => {
    await start({});
    const html = await (await fetch(`${base}/`)).text();
    const script = html.slice(html.indexOf('<script>'));
    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
