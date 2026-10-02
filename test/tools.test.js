import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema, openDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createTools } from '../src/tools.js';

const today = new Date('2026-10-03T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// Credentials from the seed data: email + last 4 digits of a card on file.
const priya = { email: 'priya.shah@example.com', card_last4: '4242' };
const arjun = { email: 'arjun.mehta@example.com', card_last4: '5454' };
const neha = { email: 'neha.kapoor@example.com', card_last4: '6070' };
const rahul = { email: 'rahul.verma@example.com', card_last4: '9001' };
const sana = { email: 'sana.iqbal@example.com', card_last4: '3131' };
const vikram = { email: 'vikram.rao@example.com', card_last4: '6521' };
const anita = { email: 'anita.desai@example.com', card_last4: '7777' };

let db;
let tools;

beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db);
  seed(db, today);
  tools = createTools(db, { now: () => today });
});

const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
let keyCounter = 0;
const refund = (who, order_id, amount, extra = {}) =>
  tools.initiateRefund({ ...who, order_id, amount, reason: 'damaged', idempotency_key: `test-${++keyCounter}`, ...extra });

describe('getCustomer', () => {
  test('verifies with email + last 4 and returns the profile, masked cards and orders', () => {
    const result = tools.getCustomer(priya);
    assert.equal(result.ok, true);
    assert.deepEqual(result.customer, { id: 'CUS-1001', name: 'Priya Shah', email: 'priya.shah@example.com', status: 'active', tier: 'standard' });
    assert.deepEqual(result.cards, [{ brand: 'visa', last4: '4242' }]);
    assert.deepEqual(result.orders.map((o) => o.id), ['ORD-5001', 'ORD-5002', 'ORD-5003']); // newest first
    assert.equal(result.orders[0].total_display, '₹3,499.00');
  });

  test('ignores email case and surrounding whitespace', () => {
    assert.equal(tools.getCustomer({ email: '  Priya.Shah@Example.COM ', card_last4: ' 4242 ' }).ok, true);
  });

  test('any card on file verifies', () => {
    assert.equal(tools.getCustomer(neha).customer.id, 'CUS-1003');
    assert.equal(tools.getCustomer({ ...neha, card_last4: '1881' }).customer.id, 'CUS-1003');
  });

  test('gives the same answer for a wrong card, an unknown email and a customer with no cards', () => {
    const wrongCard = tools.getCustomer({ ...priya, card_last4: '0000' });
    const unknownEmail = tools.getCustomer({ email: 'nobody@example.com', card_last4: '4242' });
    const noCards = tools.getCustomer({ email: 'meera.nair@example.com', card_last4: '1234' });
    assert.equal(wrongCard.error, 'identity_not_verified');
    assert.deepEqual(unknownEmail, wrongCard);
    assert.deepEqual(noCards, wrongCard);
  });

  test('rejects malformed or missing credentials', () => {
    for (const input of [{ ...priya, card_last4: '42' }, { ...priya, card_last4: 4242 }, { email: priya.email }, {}, undefined]) {
      assert.equal(tools.getCustomer(input).error, 'identity_not_verified');
    }
  });
});

describe('getOrder', () => {
  test("returns the customer's own order with its payment status", () => {
    const { order } = tools.getOrder({ ...priya, order_id: 'ORD-5001' });
    assert.equal(order.description, 'Wireless earbuds');
    assert.equal(order.status, 'delivered');
    assert.equal(order.payment_id, 'PAY-9001');
    assert.equal(order.payment_status, 'captured');
  });

  test("treats another customer's order like a missing one", () => {
    const notTheirs = tools.getOrder({ ...priya, order_id: 'ORD-5004' });
    assert.equal(notTheirs.error, 'order_not_found');
    assert.deepEqual(tools.getOrder({ ...priya, order_id: 'ORD-0000' }), notTheirs);
  });

  test('checks identity before looking anything up', () => {
    assert.equal(tools.getOrder({ ...priya, card_last4: '0000', order_id: 'ORD-5001' }).error, 'identity_not_verified');
  });
});

describe('getPayment', () => {
  test('shows the card, past refunds and what is left to refund', () => {
    const result = tools.getPayment({ ...neha, order_id: 'ORD-5006' });
    assert.deepEqual(result.payment.card, { brand: 'rupay', last4: '6070' });
    assert.deepEqual(result.refunds.map((r) => [r.id, r.status]), [['REF-301', 'completed']]);
    assert.equal(result.refund_eligibility.eligible, true);
    assert.equal(result.refund_eligibility.refundable_amount, 500_000);
  });

  test('counts a refund waiting for approval against what is left', () => {
    const { refund_eligibility } = tools.getPayment({ ...anita, order_id: 'ORD-5014' });
    assert.equal(refund_eligibility.refundable_amount, 200_000);
  });

  test('explains why each seeded edge case is not refundable', () => {
    const cases = [
      [priya, 'ORD-5003', 'outside_refund_window', undefined],
      [neha, 'ORD-5007', 'already_fully_refunded', undefined],
      [rahul, 'ORD-5008', 'account_under_review', 'risk'],
      [sana, 'ORD-5009', 'account_suspended', 'account'],
      [vikram, 'ORD-5010', 'order_not_delivered', undefined],
      [vikram, 'ORD-5011', 'payment_not_captured', undefined],
      [vikram, 'ORD-5012', 'payment_not_captured', undefined],
      [vikram, 'ORD-5013', 'payment_disputed', 'risk'],
    ];
    for (const [who, order_id, code, escalate] of cases) {
      const { refund_eligibility } = tools.getPayment({ ...who, order_id });
      assert.equal(refund_eligibility.eligible, false, order_id);
      assert.equal(refund_eligibility.code, code, order_id);
      assert.equal(refund_eligibility.escalate_as, escalate, order_id);
    }
  });
});

describe('initiateRefund', () => {
  test('completes a refund within the limit and sends it back to the original card', () => {
    const result = refund(priya, 'ORD-5001', 349_900);
    assert.equal(result.ok, true);
    assert.equal(result.refund.status, 'completed');
    assert.deepEqual(result.refund.refund_to, { brand: 'visa', last4: '4242' });
    assert.equal(result.escalation_id, null);
    const row = db.prepare('SELECT status, resolved_by FROM refunds WHERE id = ?').get(result.refund.id);
    assert.deepEqual({ ...row }, { status: 'completed', resolved_by: 'agent' });
  });

  test('records a refund above the limit as pending approval and escalates it', () => {
    const result = refund(priya, 'ORD-5002', 1_299_900);
    assert.equal(result.refund.status, 'pending_approval');
    assert.equal(result.refund.resolved_at, null);
    const esc = db.prepare('SELECT type, customer_id, order_id, refund_id, status FROM escalations WHERE id = ?').get(result.escalation_id);
    assert.deepEqual({ ...esc }, { type: 'refund_approval', customer_id: 'CUS-1001', order_id: 'ORD-5002', refund_id: result.refund.id, status: 'open' });
  });

  test('uses the higher limit for VIP customers', () => {
    assert.equal(refund(arjun, 'ORD-5004', 1_850_000).refund.status, 'completed');
    assert.equal(refund(arjun, 'ORD-5005', 4_200_000).refund.status, 'pending_approval');
  });

  test('allows a partial refund up to what is left, and no more', () => {
    const tooMuch = refund(neha, 'ORD-5006', 500_001);
    assert.equal(tooMuch.error, 'exceeds_refundable_amount');
    assert.equal(tooMuch.refundable_amount, 500_000);
    assert.equal(refund(neha, 'ORD-5006', 200_000).refund.status, 'completed'); // ₹3,000 + ₹2,000 = ₹5,000, at the limit
  });

  test('applies the limit to the running total, so splitting a refund does not avoid approval', () => {
    // ₹3,000 already refunded + ₹2,500 = ₹5,500, above the ₹5,000 standard limit.
    assert.equal(refund(neha, 'ORD-5006', 250_000).refund.status, 'pending_approval');
  });

  test('a retry with the same idempotency key returns the original refund instead of refunding twice', () => {
    const args = { ...priya, order_id: 'ORD-5001', amount: 100_000, reason: 'damaged', idempotency_key: 'retry-me' };
    const first = tools.initiateRefund(args);
    const second = tools.initiateRefund(args);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.refund.id, first.refund.id);
    assert.equal(count('refunds'), 4);
  });

  test('rejects an idempotency key reused for a different request, including another customer\'s', () => {
    refund(priya, 'ORD-5001', 100_000, { idempotency_key: 'k1' });
    assert.equal(refund(priya, 'ORD-5001', 200_000, { idempotency_key: 'k1' }).error, 'idempotency_key_reused');
    assert.equal(refund(priya, 'ORD-5001', 100_000, { idempotency_key: 'seed-ref-301' }).error, 'idempotency_key_reused');
    assert.equal(refund(priya, 'ORD-5001', 100_000, { idempotency_key: '  ' }).error, 'invalid_idempotency_key');
  });

  test('rejects invalid amounts and reasons', () => {
    for (const amount of [0, -100, 1.5, '100', undefined]) {
      assert.equal(refund(priya, 'ORD-5001', amount).error, 'invalid_amount', String(amount));
    }
    assert.equal(refund(priya, 'ORD-5001', 100_000, { reason: 'changed_mind' }).error, 'invalid_reason');
    assert.equal(refund(priya, 'ORD-5001', 100_000, { reason_details: 'x'.repeat(2001) }).error, 'invalid_reason_details');
  });

  test('refuses every seeded edge case and writes nothing', () => {
    const cases = [
      [priya, 'ORD-5003', 219_900, 'outside_refund_window'],
      [neha, 'ORD-5007', 100, 'already_fully_refunded'],
      [rahul, 'ORD-5008', 100_000, 'account_under_review'],
      [sana, 'ORD-5009', 100_000, 'account_suspended'],
      [vikram, 'ORD-5010', 100_000, 'order_not_delivered'],
      [vikram, 'ORD-5011', 100_000, 'payment_not_captured'],
      [vikram, 'ORD-5013', 100_000, 'payment_disputed'],
      [{ ...priya, card_last4: '0000' }, 'ORD-5001', 100_000, 'identity_not_verified'],
      [priya, 'ORD-5004', 100_000, 'order_not_found'],
    ];
    for (const [who, orderId, amount, code] of cases) {
      assert.equal(refund(who, orderId, amount).error, code, orderId);
    }
    assert.equal(count('refunds'), 3);
    assert.equal(count('escalations'), 1);
  });

  test('the refund window includes day 30 and ends right after it', () => {
    const deliveredAt = today.getTime() - 5 * DAY_MS; // ORD-5001
    const at = (ms) => createTools(db, { now: () => new Date(ms) });
    const args = { ...priya, order_id: 'ORD-5001', amount: 100_000, reason: 'damaged' };
    assert.equal(at(deliveredAt + 30 * DAY_MS).initiateRefund({ ...args, idempotency_key: 'day-30' }).ok, true);
    assert.equal(at(deliveredAt + 30 * DAY_MS + 1).initiateRefund({ ...args, idempotency_key: 'day-30+1ms' }).error, 'outside_refund_window');
  });
});

describe('escalateToHuman', () => {
  test('links a verified customer and their order', () => {
    const result = tools.escalateToHuman({ ...rahul, order_id: 'ORD-5008', type: 'risk', summary: 'Wants a refund for a speaker; account is flagged.' });
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    const row = db.prepare('SELECT type, customer_id, contact_email, order_id FROM escalations WHERE id = ?').get(result.escalation.id);
    assert.deepEqual({ ...row }, { type: 'risk', customer_id: 'CUS-1004', contact_email: null, order_id: 'ORD-5008' });
  });

  test('records an unverified customer by contact email only, and ignores the order', () => {
    const result = tools.escalateToHuman({ email: 'Meera.Nair@example.com', order_id: 'ORD-5001', type: 'account', summary: 'Cannot verify; no card on file.' });
    assert.equal(result.verified, false);
    const row = db.prepare('SELECT customer_id, contact_email, order_id FROM escalations WHERE id = ?').get(result.escalation.id);
    assert.deepEqual({ ...row }, { customer_id: null, contact_email: 'meera.nair@example.com', order_id: null });
  });

  test("doesn't reveal whether an unverified email has an account", () => {
    const strip = ({ escalation, ...rest }) => rest;
    const existing = tools.escalateToHuman({ email: priya.email, card_last4: '0000', type: 'account', summary: 'Locked out.' });
    const unknown = tools.escalateToHuman({ email: 'nobody@example.com', type: 'account', summary: 'Locked out.' });
    assert.deepEqual(strip(existing), strip(unknown));
  });

  test('returns the open escalation instead of creating a duplicate', () => {
    const args = { ...sana, order_id: 'ORD-5009', type: 'account', summary: 'Suspended account asking for a refund.' };
    const first = tools.escalateToHuman(args);
    const second = tools.escalateToHuman(args);
    assert.equal(second.already_open, true);
    assert.equal(second.escalation.id, first.escalation.id);
    assert.equal(count('escalations'), 2);
  });

  test('rejects bad input', () => {
    const base = { ...priya, type: 'risk', summary: 'x' };
    assert.equal(tools.escalateToHuman({ ...base, type: 'refund_approval' }).error, 'invalid_escalation_type');
    assert.equal(tools.escalateToHuman({ ...base, summary: '   ' }).error, 'invalid_summary');
    assert.equal(tools.escalateToHuman({ ...base, email: 'not-an-email', card_last4: undefined }).error, 'invalid_email');
    assert.equal(tools.escalateToHuman({ ...base, order_id: 'ORD-5004' }).error, 'order_not_found');
  });
});
