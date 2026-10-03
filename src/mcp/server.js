// MCP server exposing the refund tools (src/tools.js). Transport-agnostic: src/mcp/stdio.js
// connects it to stdin/stdout, and the tests connect it to an in-memory client.
//
// Everything here (instructions, descriptions, input schemas) is sent to the model, so keep it short.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { POLICY } from '../policy.js';
import pkg from '../../package.json' with { type: 'json' };

const instructions = `Tools for handling customer refund requests. All amounts are whole rupees (INR).
- Verify the customer first with get_customer (email + last 4 digits of a card on file). Every tool except escalate_to_human needs both; if the customer can't be verified, escalate as "account" with their email.
- Use get_payment to check refund eligibility before calling initiate_refund.
- A result with isError: true has an "error" code and a "message". Act on the message; don't retry the same call.
- If initiate_refund fails mid-call, retry with the SAME idempotency_key so the customer isn't refunded twice.
- Don't disclose internal reasons such as account review or risk flags to the customer.`;

const identity = {
  email: z.string().describe("The customer's email address"),
  card_last4: z.string().describe('Last 4 digits of any card on file, as told by the customer'),
};
const orderId = z.string().describe('Order ID, e.g. ORD-5001');

const toResult = (result) => ({
  content: [{ type: 'text', text: JSON.stringify(result) }],
  isError: !result.ok,
});

// Unexpected errors (e.g. from the DB) are reported to the model without internal details.
const handle = (fn) => async (args) => {
  try {
    return toResult(fn(args));
  } catch (err) {
    console.error('[refund-tools]', err); // stderr: stdout is reserved for the protocol
    return toResult({ ok: false, error: 'internal_error', message: 'The tool failed unexpectedly. Escalate to a human if this keeps happening.' });
  }
};

export function createMcpServer(tools) {
  const server = new McpServer({ name: 'refund-tools', version: pkg.version }, { instructions });

  server.registerTool('get_customer', {
    title: 'Verify and look up a customer',
    description: "Verify a customer's identity and return their profile, cards (last 4 only) and orders.",
    inputSchema: identity,
    annotations: { readOnlyHint: true },
  }, handle(tools.getCustomer));

  server.registerTool('get_order', {
    title: 'Look up an order',
    description: "Return one of the verified customer's orders, with its delivery and payment status.",
    inputSchema: { ...identity, order_id: orderId },
    annotations: { readOnlyHint: true },
  }, handle(tools.getOrder));

  server.registerTool('get_payment', {
    title: 'Look up a payment and refund eligibility',
    description: "Return the payment for one of the verified customer's orders, its past refunds, and refund_eligibility: whether a refund is allowed, how much is left, and what to escalate as if not.",
    inputSchema: { ...identity, order_id: orderId },
    annotations: { readOnlyHint: true },
  }, handle(tools.getPayment));

  server.registerTool('initiate_refund', {
    title: 'Refund an order',
    description: 'Refund part or all of an order to its original card. Within the approval limit it completes immediately; above it, it waits for a human and an escalation is created automatically.',
    inputSchema: {
      ...identity,
      order_id: orderId,
      amount: z.number().int().positive().describe('Amount to refund, in whole rupees'),
      reason: z.enum(POLICY.validReasons).describe('Why the customer wants a refund'),
      reason_details: z.string().optional().describe("The customer's description of the problem, in their words"),
      idempotency_key: z.string().describe('A unique key for this refund request. Reuse it only when retrying the same request.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, handle(tools.initiateRefund));

  server.registerTool('escalate_to_human', {
    title: 'Escalate to a human',
    description: 'Hand the case to a human: "account" for account requests (including customers who cannot be verified), "risk" when an eligibility check says so. Refund approvals are escalated automatically by initiate_refund.',
    inputSchema: {
      type: z.enum(['account', 'risk']).describe('Kind of escalation'),
      summary: z.string().describe('What the human needs to know: who, what they asked for, what you checked, and why it needs a human'),
      email: z.string().describe("The customer's email address, used for follow-up"),
      card_last4: z.string().optional().describe('Last 4 digits of a card on file, if the customer gave them'),
      order_id: orderId.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, handle(tools.escalateToHuman));

  return server;
}
