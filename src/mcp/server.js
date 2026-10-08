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

  // The next two are for a human reviewer, not the customer-facing agent (which never lists them).
  server.registerTool('list_escalations', {
    title: 'List escalations for a human to review',
    description: 'List escalations (refund approvals, account issues, risk holds) by status, for a human reviewer.',
    inputSchema: {
      status: z.enum(['open', 'resolved']).optional().describe('Defaults to open'),
    },
    annotations: { readOnlyHint: true },
  }, handle(tools.listEscalations));

  server.registerTool('resolve_refund_approval', {
    title: 'Approve or reject a pending refund',
    description: 'A human approves or rejects a refund that initiate_refund deferred for being above the auto-approve limit. Only works on open refund_approval escalations.',
    inputSchema: {
      escalation_id: z.string().describe('The escalation ID, e.g. ESC-401'),
      decision: z.enum(['approve', 'reject']).describe('Whether to approve or reject the pending refund'),
      resolution_note: z.string().optional().describe('Optional note for the audit trail, e.g. why it was rejected'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, handle(tools.resolveRefundApproval));

  // The next three are the audit log (step 19). log_decision is called directly by the
  // harness (src/agent/repl.js) after each turn, never by the model; the two list_* tools
  // are for a human reviewer, like list_escalations above.
  server.registerTool('log_decision', {
    title: "Log the agent's decision for a turn",
    description: 'Records a structured decision (decision, amount, reason, needs_human) to the audit log. Not for use by the customer-facing agent.',
    inputSchema: {
      decision: z.enum(['none', 'approved', 'partial', 'denied', 'escalated']).describe('Outcome of the turn'),
      amount: z.number().int().min(0).describe('Whole rupees refunded or escalated for; 0 if none'),
      reason: z.string().describe('Short reason for the decision'),
      needs_human: z.boolean().describe('Whether a human needed to review or approve this'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, handle(tools.logDecision));

  server.registerTool('list_tool_calls', {
    title: 'List logged tool calls for a human to review',
    description: 'List every MCP tool call (by any consumer), newest first, optionally filtered by time or tool name.',
    inputSchema: {
      since: z.string().optional().describe('ISO-8601 timestamp; only calls at or after this time'),
      tool_name: z.string().optional().describe('Only calls to this tool'),
      limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50, max 200'),
    },
    annotations: { readOnlyHint: true },
  }, handle(tools.listToolCalls));

  server.registerTool('list_decisions', {
    title: 'List logged decisions for a human to review',
    description: 'List every structured decision logged by log_decision, newest first, optionally filtered by time.',
    inputSchema: {
      since: z.string().optional().describe('ISO-8601 timestamp; only decisions at or after this time'),
      limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50, max 200'),
    },
    annotations: { readOnlyHint: true },
  }, handle(tools.listDecisions));

  return server;
}
