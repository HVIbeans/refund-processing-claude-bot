import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { applySchema, openDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createTools } from '../src/tools.js';
import { createMcpServer } from '../src/mcp/server.js';

const today = new Date('2026-10-03T12:00:00Z');
const priya = { email: 'priya.shah@example.com', card_last4: '4242' };

let db;
let server;
let client;

// A real MCP client and server talking over a linked in-memory transport pair: the same
// protocol messages as stdio, without a subprocess.
beforeEach(async () => {
  db = openDb(':memory:');
  applySchema(db);
  seed(db, today);
  server = createMcpServer(createTools(db, { now: () => today }));
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content[0].text };
};
const callJson = async (name, args) => {
  const { isError, text } = await call(name, args);
  return { isError, body: JSON.parse(text) };
};
const refundCount = () => db.prepare('SELECT count(*) AS n FROM refunds').get().n;

test('lists the five tools with descriptions, schemas and read-only hints', async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['escalate_to_human', 'get_customer', 'get_order', 'get_payment', 'initiate_refund']);
  for (const tool of tools) {
    assert.ok(tool.description, tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
  }
  for (const name of ['get_customer', 'get_order', 'get_payment']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  for (const name of ['initiate_refund', 'escalate_to_human']) assert.equal(byName[name].annotations.readOnlyHint, false, name);
  assert.deepEqual(byName.initiate_refund.inputSchema.properties.reason.enum, ['damaged', 'wrong_item', 'not_as_described']);
  assert.deepEqual(byName.initiate_refund.inputSchema.required.sort(), ['amount', 'card_last4', 'email', 'idempotency_key', 'order_id', 'reason']);
});

test('sends the server instructions to the client', () => {
  assert.match(client.getInstructions(), /whole rupees/);
});

test('get_customer returns the verified customer as JSON', async () => {
  const { isError, body } = await callJson('get_customer', priya);
  assert.equal(isError, false);
  assert.equal(body.customer.id, 'CUS-1001');
});

test('initiate_refund completes once, and a retry with the same key replays it', async () => {
  const args = { ...priya, order_id: 'ORD-5001', amount: 1_000, reason: 'damaged', idempotency_key: 'mcp-1' };
  const first = await callJson('initiate_refund', args);
  const retry = await callJson('initiate_refund', args);
  assert.equal(first.body.refund.status, 'completed');
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.refund.id, first.body.refund.id);
  assert.equal(refundCount(), 4);
});

test('a policy refusal comes back as isError with the error code', async () => {
  const { isError, body } = await callJson('initiate_refund', { ...priya, order_id: 'ORD-5003', amount: 2_199, reason: 'damaged', idempotency_key: 'mcp-2' });
  assert.equal(isError, true);
  assert.equal(body.error, 'outside_refund_window');
});

test('input that fails the schema is rejected before the tool runs', async () => {
  const base = { ...priya, order_id: 'ORD-5001', amount: 1_000, reason: 'damaged', idempotency_key: 'mcp-3' };
  for (const bad of [{ amount: 'lots' }, { amount: 99.5 }, { reason: 'changed_mind' }, { idempotency_key: undefined }]) {
    const { isError, text } = await call('initiate_refund', { ...base, ...bad });
    assert.equal(isError, true, JSON.stringify(bad));
    assert.match(text, /Input validation error/);
  }
  assert.equal(refundCount(), 3);
});
