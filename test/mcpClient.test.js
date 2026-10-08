import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { applySchema, openDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createTools } from '../src/tools.js';
import { createMcpServer } from '../src/mcp/server.js';
import { POLICY } from '../src/policy.js';
import { connectMcp, toClaudeTool } from '../src/agent/mcpClient.js';

let db;
let server;
let mcp;

// The real server over an in-memory transport pair: no subprocess, no API calls.
beforeEach(async () => {
  db = openDb(':memory:');
  applySchema(db);
  seed(db);
  server = createMcpServer(createTools(db));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  mcp = await connectMcp(clientTransport);
});

afterEach(async () => {
  await mcp.close();
  await server.close();
  db.close();
});

test('lists the server, its instructions and all ten tools', () => {
  assert.equal(mcp.server.name, 'refund-tools');
  assert.match(mcp.instructions, /Verify the customer first/);
  assert.deepEqual(mcp.tools.map((t) => t.name).sort(), [
    'escalate_to_human', 'get_customer', 'get_order', 'get_payment', 'initiate_refund',
    'list_decisions', 'list_escalations', 'list_tool_calls', 'log_decision', 'resolve_refund_approval',
  ]);
});

test('converts each tool to a Claude tool definition', () => {
  for (const tool of mcp.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'input_schema', 'name']);
    assert.ok(tool.description.length > 0);
    assert.equal(tool.input_schema.type, 'object');
    assert.equal('$schema' in tool.input_schema, false);
  }
});

test('initiate_refund keeps its required fields, reason enum and integer amount', () => {
  const { input_schema: schema } = mcp.tools.find((t) => t.name === 'initiate_refund');
  assert.deepEqual(schema.required.sort(), ['amount', 'card_last4', 'email', 'idempotency_key', 'order_id', 'reason']);
  assert.deepEqual(schema.properties.reason.enum, [...POLICY.validReasons]);
  assert.equal(schema.properties.amount.type, 'integer');
});

test("toClaudeTool doesn't change its input and falls back to the title", () => {
  const mcpTool = { name: 'x', title: 'Do X', inputSchema: { $schema: 'draft-07', type: 'object', properties: {} } };
  const copy = structuredClone(mcpTool);
  assert.deepEqual(toClaudeTool(mcpTool), { name: 'x', description: 'Do X', input_schema: { type: 'object', properties: {} } });
  assert.deepEqual(mcpTool, copy);
});

test('callTool returns the result text, and isError for invalid input', async () => {
  const priya = { email: 'priya.shah@example.com', card_last4: '4242' };
  const ok = await mcp.callTool('get_customer', priya);
  assert.equal(ok.isError, false);
  assert.equal(JSON.parse(ok.text).ok, true);

  const bad = await mcp.callTool('initiate_refund', {
    ...priya, order_id: 'ORD-5001', amount: 100, reason: 'changed_mind', idempotency_key: 'k1',
  });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Input validation error/);
});

test('calls fail after close', async () => {
  await mcp.close();
  await assert.rejects(mcp.client.listTools());
});
