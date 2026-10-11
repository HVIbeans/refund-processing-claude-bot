// Local HTTP server for the app: the refund chat at / (step 32) and the prompt-coach viewer.
//
// POST /api/chat { conversationId?, message } runs one turn of the agent and streams it back as
// Server-Sent Events: `start` { conversationId }, `text` { text } for each piece of the reply,
// `working` while tools run, `discard` when shown text is withdrawn, then `done` { text, fallback }
// or `error` { message }. The customer only ever sees the reply: no tool names, inputs, results,
// decisions or token usage reach the browser (they stay in the audit log).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFeedback, watchFeedback } from './promptFeedback.js';
import { MAX_TEXT } from './policy.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MAX_BODY_BYTES = 4096;
const ERROR_REPLY = 'Sorry, something went wrong on our side. Please try again in a moment.';

// Browsers connected to the live feedback stream (Server-Sent Events).
const feedbackClients = new Set();

function sendEvent(res, entries) {
  res.write(`data: ${JSON.stringify(entries)}\n\n`);
}

function sendPage(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(join(publicDir, file)));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Reads a JSON body of at most MAX_BODY_BYTES. Resolves { body } or { status, error }.
// Past the limit it stops keeping the data but still reads to the end, so the 413 can be sent
// (closing the request early would close the socket before the response).
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return resolve({ status: 413, error: 'Message too long.' });
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ status: 400, error: 'Request body must be JSON.' });
      }
    });
    req.on('error', () => resolve({ status: 400, error: 'Could not read the request.' }));
  });
}

// createConversation({ onText, onDiscard, onWorking }) returns an object with send(message),
// resolving { text, fallback }. Undefined when the agent couldn't start (e.g. no API key):
// the chat then answers 503 while the rest of the server keeps working.
// Conversations live in memory and are dropped after idleMs without a message (roadmap step 35
// replaces this with a store that survives restarts).
export function startServer({
  port = Number(process.env.PORT) || 3000,
  host = '127.0.0.1',
  createConversation,
  idleMs = 30 * 60_000,
  now = () => Date.now(),
} = {}) {
  const conversations = new Map();

  function sweep() {
    for (const [id, conv] of conversations) {
      if (!conv.busy && now() - conv.lastUsed > idleMs) conversations.delete(id);
    }
  }

  function openConversation() {
    const conv = { id: randomUUID(), busy: false, lastUsed: now(), sink: null };
    // The agent's callbacks are fixed when it's created, but each turn streams to a different
    // response, so they write to whatever sink the current turn has set.
    conv.agent = createConversation({
      onText: (text) => conv.sink?.('text', { text }),
      onDiscard: () => conv.sink?.('discard', {}),
      onWorking: () => conv.sink?.('working', {}),
    });
    conversations.set(conv.id, conv);
    return conv;
  }

  async function chat(req, res) {
    if (!createConversation) return sendJson(res, 503, { error: 'The chat is not available right now.' });
    const { body, status, error } = await readJson(req);
    if (status) return sendJson(res, status, { error });
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return sendJson(res, 400, { error: 'Send a non-empty message.' });
    if (message.length > MAX_TEXT) return sendJson(res, 413, { error: 'Message too long.' });

    sweep();
    // An unknown or expired ID starts a new conversation; the `start` event tells the page its ID.
    let conv = typeof body.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (conv?.busy) return sendJson(res, 409, { error: 'Please wait for the reply to your last message.' });
    conv ??= openConversation();
    conv.busy = true;
    conv.lastUsed = now();

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // If the browser goes away mid-turn, the turn still finishes (a refund may be under way) and
    // stays in the history; only the streaming stops.
    let open = true;
    res.on('close', () => {
      open = false;
    });
    const event = (name, data) => {
      if (open) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    conv.sink = event;
    event('start', { conversationId: conv.id });
    try {
      const reply = await conv.agent.send(message);
      event('done', { text: reply.text, fallback: Boolean(reply.fallback) });
    } catch (err) {
      console.error('[chat]', err); // details stay in the server log
      event('error', { message: ERROR_REPLY });
    } finally {
      conv.sink = null;
      conv.busy = false;
      conv.lastUsed = now();
      res.end();
    }
  }

  function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/chat') {
      if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
      return chat(req, res);
    }
    if (req.method !== 'GET') return res.writeHead(405).end();

    switch (pathname) {
      case '/':
        return sendPage(res, 'index.html');
      case '/prompt-feedback':
        return sendPage(res, 'prompt-feedback.html');
      case '/api/prompt-feedback':
        return sendJson(res, 200, readFeedback());
      case '/api/prompt-feedback/stream':
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        sendEvent(res, readFeedback());
        feedbackClients.add(res);
        req.on('close', () => feedbackClients.delete(res));
        return;
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  const server = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((err) => {
      console.error('[server]', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
      else res.end();
    });
  });

  const stopWatching = watchFeedback((entries) => {
    for (const res of feedbackClients) sendEvent(res, entries);
  });
  // A comment line every 25s stops idle connections from being dropped.
  const heartbeat = setInterval(() => {
    for (const res of feedbackClients) res.write(': ping\n\n');
  }, 25_000);

  server.on('close', () => {
    stopWatching();
    clearInterval(heartbeat);
  });

  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
