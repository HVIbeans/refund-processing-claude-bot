// The agent's abilities as plain functions. Step 7 wraps each one as an MCP tool.
// Every argument is untrusted (it comes from the model, which got it from the customer),
// so the refund policy is enforced here, not in the prompt.
//
// Tools are stateless: each call re-verifies identity with email + the last 4 digits of a card
// on file, and only returns orders that belong to the verified customer.
// Results are plain objects: { ok: true, ... } or { ok: false, error: '<code>', message }.
import { POLICY, MAX_TEXT, formatInr } from './policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ESCALATION_TYPES = ['account', 'risk']; // refund_approval escalations are created by initiateRefund
const RESOLUTION_DECISIONS = ['approve', 'reject'];
// Mirrors decision.js's DECISIONS. Duplicated rather than imported: src/tools.js is the data
// layer and shouldn't depend on src/agent/* (the same reason refunds.reason duplicates
// POLICY.validReasons in schema.sql instead of the schema importing policy.js).
const DECISIONS = ['none', 'approved', 'partial', 'denied', 'escalated'];

const fail = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });

// The same answer for an unknown email, a wrong card and a customer with no cards,
// so a caller can't use this to find out whether an email has an account.
const notVerified = () =>
  fail('identity_not_verified', 'Could not verify the customer with that email and card. Ask them to check both, or escalate.');

// The same answer for a missing order and someone else's order.
const orderNotFound = () => fail('order_not_found', 'No order with that ID was found for this customer.');

// SQLITE_BUSY (another connection holds the write lock) or SQLITE_CONSTRAINT_TRIGGER (the
// refund_total_guard trigger fired because a concurrent writer committed between this call's
// eligibility check and its own BEGIN IMMEDIATE). Both mean "retry", not "something is broken".
const isRetryable = (err) => err?.errcode === 5 || err?.errcode === 1811;

export function createTools(db, { now = () => new Date() } = {}) {
  const findCustomer = db.prepare(`
    SELECT c.id, c.name, c.email, c.status, c.tier FROM customers c
    WHERE c.email = ? AND EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.customer_id = c.id AND pm.last4 = ?)
  `);
  const listCards = db.prepare('SELECT brand, last4 FROM payment_methods WHERE customer_id = ? ORDER BY id');
  const listOrders = db.prepare(`
    SELECT id, description, status, placed_at, delivered_at, total FROM orders WHERE customer_id = ? ORDER BY placed_at DESC
  `);
  const findOrder = db.prepare(`
    SELECT o.id, o.description, o.status, o.placed_at, o.delivered_at, o.currency, o.total,
           p.id AS payment_id, p.status AS payment_status, p.amount AS payment_amount, p.captured_at,
           pm.brand AS card_brand, pm.last4 AS card_last4
    FROM orders o
    JOIN payments p ON p.order_id = o.id
    JOIN payment_methods pm ON pm.id = p.payment_method_id
    WHERE o.id = ? AND o.customer_id = ?
  `);
  const listRefunds = db.prepare(`
    SELECT id, amount, reason, status, requested_at, resolved_at FROM refunds WHERE payment_id = ? ORDER BY requested_at, id
  `);
  const findRefundByKey = db.prepare('SELECT id, payment_id, amount, reason FROM refunds WHERE idempotency_key = ?');
  const findRefund = db.prepare(`
    SELECT r.id, r.amount, r.reason, r.status, r.requested_at, r.resolved_at, p.order_id, pm.brand, pm.last4,
           e.id AS escalation_id
    FROM refunds r
    JOIN payments p ON p.id = r.payment_id
    JOIN payment_methods pm ON pm.id = p.payment_method_id
    LEFT JOIN escalations e ON e.refund_id = r.id
    WHERE r.id = ?
  `);
  const insertRefund = db.prepare(`
    INSERT INTO refunds (id, payment_id, amount, reason, reason_details, status, idempotency_key, requested_at, resolved_at, resolved_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEscalation = db.prepare(`
    INSERT INTO escalations (id, type, customer_id, contact_email, order_id, refund_id, summary, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `);
  const findOpenEscalation = db.prepare(`
    SELECT id, type, status, created_at FROM escalations
    WHERE status = 'open' AND type = ? AND customer_id IS ? AND contact_email IS ? AND order_id IS ?
  `);
  const listEscalationsByStatus = db.prepare(`
    SELECT e.id, e.type, e.contact_email, e.order_id, e.refund_id, e.summary, e.status, e.created_at, e.resolved_at, e.resolution_note,
           c.name AS customer_name, c.tier AS customer_tier
    FROM escalations e
    LEFT JOIN customers c ON c.id = e.customer_id
    WHERE e.status = ?
    ORDER BY e.created_at
  `);
  const findEscalation = db.prepare('SELECT id, type, status, refund_id FROM escalations WHERE id = ?');
  const updateRefundResolution = db.prepare('UPDATE refunds SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?');
  const resolveEscalationRow = db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ?, resolution_note = ? WHERE id = ?");
  const insertToolCallLog = db.prepare('INSERT INTO tool_call_log (id, at, tool_name, input, output, is_error) VALUES (?, ?, ?, ?, ?, ?)');
  const insertDecisionLog = db.prepare('INSERT INTO decision_log (id, at, decision, amount, reason, needs_human) VALUES (?, ?, ?, ?, ?, ?)');
  // Order by rowid (not id, which sorts lexicographically past TCL-9) as a tiebreaker for `at`:
  // two calls within the same ISO second (easy, e.g. in a fast burst or under a fixed clock in
  // tests) would otherwise sort arbitrarily, breaking "newest first".
  const listToolCallsStmt = db.prepare(`
    SELECT id, at, tool_name, input, output, is_error FROM tool_call_log
    WHERE (? IS NULL OR at >= ?) AND (? IS NULL OR tool_name = ?)
    ORDER BY at DESC, rowid DESC LIMIT ?
  `);
  const listDecisionsStmt = db.prepare(`
    SELECT id, at, decision, amount, reason, needs_human FROM decision_log
    WHERE (? IS NULL OR at >= ?)
    ORDER BY at DESC, rowid DESC LIMIT ?
  `);

  // Runs fn() inside a write transaction, translating lock contention or the DB's own
  // refund_total_guard trigger into a stable { error: 'try_again' } instead of a raw exception.
  function inTransaction(fn, retryMessage) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isRetryable(err)) return fail('try_again', retryMessage);
      throw err;
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      if (isRetryable(err)) return fail('try_again', retryMessage);
      throw err;
    }
  }

  // Best-effort: a write-lock conflict (another connection mid-transaction, exactly what
  // audited() itself may be reporting as try_again) must never stop the real result from
  // being returned - the log entry is just dropped rather than crashing the call.
  function logToolCall(name, input, output, isError) {
    try {
      insertToolCallLog.run(nextId('tool_call_log', 'TCL-', 1), now().toISOString(), name, JSON.stringify(input ?? null), JSON.stringify(output), isError ? 1 : 0);
    } catch (err) {
      console.error('[audit] failed to log tool call:', err.message);
    }
  }

  // Wraps every tool function so every call is audited (step 19), for both consumers: the
  // customer-facing agent and a human reviewer alike - whichever client the MCP server is
  // actually talking to. An exception is logged too (as the same internal_error server.js's
  // handle() reports) and then rethrown, so existing error handling is unaffected.
  function audited(name, fn) {
    return (input) => {
      try {
        const output = fn(input);
        logToolCall(name, input, output, !output.ok);
        return output;
      } catch (err) {
        logToolCall(name, input, { ok: false, error: 'internal_error', message: err.message }, true);
        throw err;
      }
    };
  }

  // IDs look like REF-301; the next one is the highest number + 1.
  const nextId = (table, prefix, first) => {
    const { n } = db.prepare(`SELECT max(CAST(substr(id, ${prefix.length + 1}) AS INTEGER)) AS n FROM ${table}`).get();
    return `${prefix}${n == null ? first : n + 1}`;
  };

  function verify(email, cardLast4) {
    if (typeof email !== 'string' || typeof cardLast4 !== 'string') return null;
    const last4 = cardLast4.trim();
    if (!/^\d{4}$/.test(last4)) return null;
    return findCustomer.get(email.trim().toLowerCase(), last4) ?? null;
  }

  function ownedOrder(orderId, customerId) {
    if (typeof orderId !== 'string') return null;
    return findOrder.get(orderId.trim(), customerId) ?? null;
  }

  // Whether this order can be refunded right now, and how much is left.
  // getPayment shows it to the agent; initiateRefund enforces it.
  function assess(customer, order, refunds) {
    const committed = refunds.filter((r) => r.status !== 'rejected').reduce((sum, r) => sum + r.amount, 0);
    const refundable = order.payment_amount - committed;
    const elapsed = order.delivered_at ? now() - new Date(order.delivered_at) : null;
    const facts = {
      refundable_amount: refundable,
      refundable_display: formatInr(refundable),
      already_refunded_or_pending: committed,
      days_since_delivery: elapsed == null ? null : Math.floor(elapsed / DAY_MS),
      auto_approve_limit: POLICY.autoApproveLimit[customer.tier],
    };

    let blocker = null;
    if (customer.status === 'suspended') {
      blocker = ['account_suspended', 'This account is suspended, so refunds are not allowed. Escalate as type "account".', 'account'];
    } else if (customer.status === 'flagged') {
      blocker = ['account_under_review', 'This account needs a manual review before any refund. Escalate as type "risk", and do not tell the customer why.', 'risk'];
    } else if (order.payment_status === 'disputed') {
      blocker = ['payment_disputed', 'The customer has a card dispute open for this payment, so refunding would pay them twice. Escalate as type "risk".', 'risk'];
    } else if (order.payment_status !== 'captured') {
      blocker = ['payment_not_captured', `The payment is ${order.payment_status}, so no money was taken and there is nothing to refund.`];
    } else if (order.status !== 'delivered') {
      blocker = ['order_not_delivered', `The order is ${order.status}, not delivered. Refunds are only for delivered orders.`];
    } else if (elapsed > POLICY.refundWindowDays * DAY_MS) {
      blocker = ['outside_refund_window', `The order was delivered ${facts.days_since_delivery} days ago, past the ${POLICY.refundWindowDays}-day refund window.`];
    } else if (refundable <= 0) {
      blocker = ['already_fully_refunded', 'This order has already been fully refunded (or the rest is waiting for approval).'];
    }

    if (!blocker) return { eligible: true, ...facts };
    const [code, message, escalate] = blocker;
    return { eligible: false, code, message, ...(escalate && { escalate_as: escalate }), ...facts };
  }

  function refundResult(refundId, replayed) {
    const r = findRefund.get(refundId);
    const messages = {
      completed: `Refund of ${formatInr(r.amount)} completed. It goes back to the ${r.brand} card ending ${r.last4}.`,
      pending_approval: `Refund of ${formatInr(r.amount)} is above the agent's approval limit and is waiting for a human to approve it (${r.escalation_id}).`,
      rejected: `Refund of ${formatInr(r.amount)} was reviewed and rejected.`,
    };
    return {
      ok: true,
      replayed,
      refund: {
        id: r.id,
        order_id: r.order_id,
        amount: r.amount,
        amount_display: formatInr(r.amount),
        reason: r.reason,
        status: r.status,
        requested_at: r.requested_at,
        resolved_at: r.resolved_at,
        refund_to: { brand: r.brand, last4: r.last4 },
      },
      escalation_id: r.escalation_id ?? null,
      message: messages[r.status],
    };
  }

  function getCustomer({ email, card_last4 } = {}) {
    const customer = verify(email, card_last4);
    if (!customer) return notVerified();
    return {
      ok: true,
      customer: { id: customer.id, name: customer.name, email: customer.email, status: customer.status, tier: customer.tier },
      cards: listCards.all(customer.id).map((c) => ({ brand: c.brand, last4: c.last4 })),
      orders: listOrders.all(customer.id).map((o) => ({
        id: o.id,
        description: o.description,
        status: o.status,
        placed_at: o.placed_at,
        delivered_at: o.delivered_at,
        total: o.total,
        total_display: formatInr(o.total),
      })),
    };
  }

  function getOrder({ email, card_last4, order_id } = {}) {
    const customer = verify(email, card_last4);
    if (!customer) return notVerified();
    const o = ownedOrder(order_id, customer.id);
    if (!o) return orderNotFound();
    return {
      ok: true,
      order: {
        id: o.id,
        description: o.description,
        status: o.status,
        placed_at: o.placed_at,
        delivered_at: o.delivered_at,
        currency: o.currency,
        total: o.total,
        total_display: formatInr(o.total),
        payment_id: o.payment_id,
        payment_status: o.payment_status,
      },
    };
  }

  function getPayment({ email, card_last4, order_id } = {}) {
    const customer = verify(email, card_last4);
    if (!customer) return notVerified();
    const o = ownedOrder(order_id, customer.id);
    if (!o) return orderNotFound();
    const refunds = listRefunds.all(o.payment_id);
    return {
      ok: true,
      payment: {
        id: o.payment_id,
        order_id: o.id,
        status: o.payment_status,
        amount: o.payment_amount,
        amount_display: formatInr(o.payment_amount),
        card: { brand: o.card_brand, last4: o.card_last4 },
        captured_at: o.captured_at,
      },
      refunds: refunds.map((r) => ({
        id: r.id,
        amount: r.amount,
        amount_display: formatInr(r.amount),
        reason: r.reason,
        status: r.status,
        requested_at: r.requested_at,
        resolved_at: r.resolved_at,
      })),
      refund_eligibility: assess(customer, o, refunds),
    };
  }

  // amount is whole rupees. idempotency_key: retrying with the same key returns the original refund
  // instead of refunding twice.
  function initiateRefund({ email, card_last4, order_id, amount, reason, reason_details, idempotency_key } = {}) {
    const customer = verify(email, card_last4);
    if (!customer) return notVerified();
    const order = ownedOrder(order_id, customer.id);
    if (!order) return orderNotFound();

    if (typeof idempotency_key !== 'string' || !idempotency_key.trim() || idempotency_key.length > 200) {
      return fail('invalid_idempotency_key', 'idempotency_key must be a non-empty string (at most 200 characters), unique to this refund request.');
    }
    const key = idempotency_key.trim();
    const existing = findRefundByKey.get(key);
    if (existing) {
      const sameRequest = existing.payment_id === order.payment_id && existing.amount === amount && existing.reason === reason;
      if (!sameRequest) {
        return fail('idempotency_key_reused', 'That idempotency key was already used for a different refund request. Use a new key.');
      }
      return refundResult(existing.id, true);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return fail('invalid_amount', 'amount must be a positive whole number of rupees.');
    }
    if (!POLICY.validReasons.includes(reason)) {
      return fail('invalid_reason', `reason must be one of: ${POLICY.validReasons.join(', ')}. Other reasons (such as a change of mind) are not refundable.`);
    }
    if (reason_details != null && (typeof reason_details !== 'string' || reason_details.length > MAX_TEXT)) {
      return fail('invalid_reason_details', `reason_details must be text of at most ${MAX_TEXT} characters.`);
    }

    const refunds = listRefunds.all(order.payment_id);
    const eligibility = assess(customer, order, refunds);
    if (!eligibility.eligible) {
      const { code, message, ...facts } = eligibility;
      return fail(code, message, facts);
    }
    if (amount > eligibility.refundable_amount) {
      return fail(
        'exceeds_refundable_amount',
        `Only ${eligibility.refundable_display} can still be refunded on this order.`,
        { refundable_amount: eligibility.refundable_amount, refundable_display: eligibility.refundable_display },
      );
    }

    // The limit applies to the order's running total, so splitting a big refund into small ones doesn't avoid approval.
    const limit = POLICY.autoApproveLimit[customer.tier];
    const runningTotal = eligibility.already_refunded_or_pending + amount;
    const needsApproval = runningTotal > limit;

    const refundId = nextId('refunds', 'REF-', 301);
    const at = now().toISOString();
    return inTransaction(() => {
      insertRefund.run(
        refundId, order.payment_id, amount, reason, reason_details ?? null,
        needsApproval ? 'pending_approval' : 'completed', key, at,
        needsApproval ? null : at, needsApproval ? null : 'agent',
      );
      if (needsApproval) {
        const summary =
          `${customer.name} (${customer.tier}) requests ${formatInr(amount)} of ${formatInr(order.total)} for "${order.description}" (${order.id}), ` +
          `reason: ${reason}${reason_details ? ` ("${reason_details}")` : ''}. ` +
          `Refunds on this order would total ${formatInr(runningTotal)}, above the ${formatInr(limit)} ${customer.tier} limit.`;
        insertEscalation.run(nextId('escalations', 'ESC-', 401), 'refund_approval', customer.id, null, order.id, refundId, summary, at);
      }
      return refundResult(refundId, false);
    }, 'Another refund request for this order is in progress. Retry with the same idempotency_key.');
  }

  // For account requests and risk cases. Works for unverified customers too: the escalation is then
  // tied to the contact email only, and the reply doesn't reveal whether that email has an account.
  function escalateToHuman({ type, summary, email, card_last4, order_id } = {}) {
    if (!ESCALATION_TYPES.includes(type)) {
      return fail('invalid_escalation_type', `type must be one of: ${ESCALATION_TYPES.join(', ')}. Refund approvals are created by initiate_refund.`);
    }
    if (typeof summary !== 'string' || !summary.trim() || summary.length > MAX_TEXT) {
      return fail('invalid_summary', `summary must be non-empty text of at most ${MAX_TEXT} characters, written for the human who picks this up.`);
    }
    const contactEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(contactEmail)) {
      return fail('invalid_email', 'A valid email address is required so a human can follow up.');
    }

    const customer = verify(email, card_last4);
    let orderId = null;
    if (customer && order_id != null) {
      const order = ownedOrder(order_id, customer.id);
      if (!order) return orderNotFound();
      orderId = order.id;
    }
    // Unverified: order_id is ignored, since linking it would confirm the order exists. Mention it in the summary instead.
    const customerId = customer?.id ?? null;
    const contact = customer ? null : contactEmail;
    const message = 'A member of our team will follow up by email.';

    const open = findOpenEscalation.get(type, customerId, contact, orderId);
    if (open) {
      return { ok: true, already_open: true, verified: Boolean(customer), escalation: { ...open }, message };
    }

    const id = nextId('escalations', 'ESC-', 401);
    const at = now().toISOString();
    insertEscalation.run(id, type, customerId, contact, orderId, null, summary.trim(), at);
    return { ok: true, already_open: false, verified: Boolean(customer), escalation: { id, type, status: 'open', created_at: at }, message };
  }

  // For a human reviewer, not the customer-facing agent: lists escalations of every type
  // (refund approvals, account issues, risk holds) so a human sees the full picture.
  function listEscalations({ status = 'open' } = {}) {
    if (!['open', 'resolved'].includes(status)) {
      return fail('invalid_status', 'status must be one of: open, resolved.');
    }
    return {
      ok: true,
      escalations: listEscalationsByStatus.all(status).map((e) => ({
        id: e.id,
        type: e.type,
        status: e.status,
        created_at: e.created_at,
        resolved_at: e.resolved_at,
        resolution_note: e.resolution_note,
        customer: e.customer_name ? { name: e.customer_name, tier: e.customer_tier } : null,
        contact_email: e.contact_email,
        order_id: e.order_id,
        refund_id: e.refund_id,
        summary: e.summary,
      })),
    };
  }

  // For a human reviewer only: approves or rejects a refund that initiateRefund deferred for
  // being above the auto-approve limit. Never exposed to the customer-facing agent.
  function resolveRefundApproval({ escalation_id, decision, resolution_note } = {}) {
    if (typeof escalation_id !== 'string' || !escalation_id.trim()) {
      return fail('invalid_escalation_id', 'escalation_id is required.');
    }
    if (!RESOLUTION_DECISIONS.includes(decision)) {
      return fail('invalid_decision', `decision must be one of: ${RESOLUTION_DECISIONS.join(', ')}.`);
    }
    if (resolution_note != null && (typeof resolution_note !== 'string' || resolution_note.length > MAX_TEXT)) {
      return fail('invalid_resolution_note', `resolution_note must be text of at most ${MAX_TEXT} characters.`);
    }

    const id = escalation_id.trim();
    const escalation = findEscalation.get(id);
    if (!escalation) return fail('escalation_not_found', 'No escalation with that id was found.');
    if (escalation.type !== 'refund_approval') {
      return fail('not_a_refund_approval', `This escalation is type "${escalation.type}"; resolve_refund_approval only handles refund_approval escalations.`);
    }
    if (escalation.status !== 'open') {
      return fail('already_resolved', 'This escalation was already resolved.');
    }

    const refund = findRefund.get(escalation.refund_id);
    if (!refund || refund.status !== 'pending_approval') {
      return fail('refund_not_pending', 'This refund is no longer pending approval.');
    }

    const at = now().toISOString();
    const note = resolution_note?.trim() || null;
    const newStatus = decision === 'approve' ? 'completed' : 'rejected';
    return inTransaction(() => {
      updateRefundResolution.run(newStatus, at, 'human', refund.id);
      resolveEscalationRow.run(at, note, id);
      return {
        ...refundResult(refund.id, false),
        decision,
        escalation: { id, status: 'resolved', resolved_at: at, resolution_note: note },
      };
    }, 'Another request to resolve this escalation is in progress. Wait a moment and try again.');
  }

  // Called directly by the harness (src/agent/repl.js), never by the model: whether a
  // decision (step 14) gets logged isn't something the LLM should decide. Input is still
  // validated, since an MCP call is an untrusted-input boundary regardless of who's calling.
  function logDecision({ decision, amount, reason, needs_human } = {}) {
    if (!DECISIONS.includes(decision)) {
      return fail('invalid_decision', `decision must be one of: ${DECISIONS.join(', ')}.`);
    }
    if (!Number.isInteger(amount) || amount < 0) {
      return fail('invalid_amount', 'amount must be a non-negative whole number.');
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_TEXT) {
      return fail('invalid_reason', `reason must be non-empty text of at most ${MAX_TEXT} characters.`);
    }
    if (typeof needs_human !== 'boolean') {
      return fail('invalid_needs_human', 'needs_human must be true or false.');
    }

    const id = nextId('decision_log', 'DEC-', 1);
    const at = now().toISOString();
    insertDecisionLog.run(id, at, decision, amount, reason.trim(), needs_human ? 1 : 0);
    return { ok: true, id, at };
  }

  function validateLogFilters({ since, tool_name, limit = 50 } = {}) {
    if (since != null && (typeof since !== 'string' || Number.isNaN(Date.parse(since)))) {
      return fail('invalid_since', 'since must be an ISO-8601 timestamp.');
    }
    if (tool_name != null && typeof tool_name !== 'string') {
      return fail('invalid_tool_name', 'tool_name must be a string.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return fail('invalid_limit', 'limit must be a whole number between 1 and 200.');
    }
    return null;
  }

  // For a human reviewer: every tool call, by every consumer, oldest-filter-first.
  function listToolCalls({ since, tool_name, limit = 50 } = {}) {
    const invalid = validateLogFilters({ since, tool_name, limit });
    if (invalid) return invalid;
    const rows = listToolCallsStmt.all(since ?? null, since ?? null, tool_name ?? null, tool_name ?? null, limit);
    return {
      ok: true,
      tool_calls: rows.map((r) => ({
        id: r.id, at: r.at, tool_name: r.tool_name,
        input: JSON.parse(r.input), output: JSON.parse(r.output), is_error: Boolean(r.is_error),
      })),
    };
  }

  // For a human reviewer: every structured decision the agent has logged.
  function listDecisions({ since, limit = 50 } = {}) {
    const invalid = validateLogFilters({ since, limit });
    if (invalid) return invalid;
    const rows = listDecisionsStmt.all(since ?? null, since ?? null, limit);
    return {
      ok: true,
      decisions: rows.map((r) => ({
        id: r.id, at: r.at, decision: r.decision, amount: r.amount, reason: r.reason, needs_human: Boolean(r.needs_human),
      })),
    };
  }

  // Maps each JS function to the snake_case name server.js registers it under, so
  // tool_call_log.tool_name (and listToolCalls's tool_name filter) matches what a human
  // reviewing the log actually sees in Claude Code or the MCP Inspector.
  const MCP_NAMES = {
    getCustomer: 'get_customer', getOrder: 'get_order', getPayment: 'get_payment',
    initiateRefund: 'initiate_refund', escalateToHuman: 'escalate_to_human',
    listEscalations: 'list_escalations', resolveRefundApproval: 'resolve_refund_approval',
    logDecision: 'log_decision', listToolCalls: 'list_tool_calls', listDecisions: 'list_decisions',
  };
  return Object.fromEntries(
    Object.entries({
      getCustomer, getOrder, getPayment, initiateRefund, escalateToHuman,
      listEscalations, resolveRefundApproval, logDecision, listToolCalls, listDecisions,
    }).map(([key, fn]) => [key, audited(MCP_NAMES[key], fn)]),
  );
}
