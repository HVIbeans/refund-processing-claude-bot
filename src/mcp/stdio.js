// Entry point: runs the MCP server over stdio (npm run mcp). Pass --reviewer for the reviewer tools.
// stdout carries the JSON-RPC protocol, so never console.log here. Log with console.error.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { applySchema, defaultDbPath, openDb } from '../db/index.js';
import { seed } from '../db/seed.js';
import { createTools } from '../tools.js';
import { createMcpServer } from './server.js';

// Check that the DB is fully set up, not just that the file exists: openDb creates an empty file
// immediately, so a first run that crashed mid-setup would otherwise leave a broken DB behind.
// The seed runs in one transaction, so seeded customers mean the whole setup finished.
const isReady = (db) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'escalations'").get() &&
  db.prepare('SELECT 1 FROM customers LIMIT 1').get();

mkdirSync(dirname(defaultDbPath), { recursive: true });
let db = openDb();
if (!isReady(db)) {
  db.close();
  rmSync(defaultDbPath, { force: true });
  db = openDb();
  applySchema(db);
  seed(db);
  console.error(`[refund-tools] created and seeded ${defaultDbPath}`);
}

// --reviewer adds the human-reviewer tools (.mcp.json passes it for Claude Code). The agent's
// server is started without it, so it never has resolve_refund_approval.
const server = createMcpServer(createTools(db), { reviewer: process.argv.includes('--reviewer') });
await server.connect(new StdioServerTransport());
console.error('[refund-tools] MCP server running on stdio');

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown); // the client closed the pipe
