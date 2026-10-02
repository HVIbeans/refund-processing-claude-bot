// Local HTTP server for the app. The refund chat UI will live at /; for now it serves the prompt-coach viewer.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFeedback, watchFeedback } from './promptFeedback.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Browsers connected to the live feedback stream (Server-Sent Events).
const feedbackClients = new Set();

function sendEvent(res, entries) {
  res.write(`data: ${JSON.stringify(entries)}\n\n`);
}

function sendPage(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(join(publicDir, file)));
}

function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  switch (pathname) {
    case '/':
      return sendPage(res, 'index.html');
    case '/prompt-feedback':
      return sendPage(res, 'prompt-feedback.html');
    case '/api/prompt-feedback':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(readFeedback()));
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

export function startServer({ port = Number(process.env.PORT) || 3000, host = '127.0.0.1' } = {}) {
  const server = createServer(handle);

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
