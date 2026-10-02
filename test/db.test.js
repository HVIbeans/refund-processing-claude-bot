import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema, openDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { POLICY, formatInr } from '../src/policy.js';

const today = new Date('2026-10-03T12:00:00Z');
let db;

beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db);
  seed(db, today);
});

const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('seeds the expected number of rows', () => {
  assert.deepEqual(
    Object.fromEntries(['customers', 'payment_methods', 'orders', 'payments', 'refunds', 'escalations'].map((t) => [t, count(t)])),
    { customers: 8, payment_methods: 8, orders: 14, payments: 14, refunds: 3, escalations: 1 },
  );
});

test('has no broken foreign keys', () => {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('each payment uses a card owned by the order customer and matches the order total', () => {
  const mismatches = db.prepare(`
    SELECT p.id FROM payments p
    JOIN orders o ON o.id = p.order_id
    JOIN payment_methods pm ON pm.id = p.payment_method_id
    WHERE pm.customer_id <> o.customer_id OR p.amount <> o.total
  `).all();
  assert.deepEqual(mismatches, []);
});

test('no payment is refunded beyond its amount', () => {
  const over = db.prepare(`
    SELECT p.id FROM payments p
    JOIN refunds r ON r.payment_id = p.id AND r.status IN ('completed', 'pending_approval')
    GROUP BY p.id HAVING sum(r.amount) > p.amount
  `).all();
  assert.deepEqual(over, []);
});

test('seed edge cases sit on the right side of the refund window', () => {
  const daysSinceDelivery = (id) => {
    const { delivered_at } = db.prepare('SELECT delivered_at FROM orders WHERE id = ?').get(id);
    return (today - new Date(delivered_at)) / 86_400_000;
  };
  assert.ok(daysSinceDelivery('ORD-5001') <= POLICY.refundWindowDays);
  assert.ok(daysSinceDelivery('ORD-5003') > POLICY.refundWindowDays);
});

test('seed amounts sit on the right side of the approval limits', () => {
  const total = (id) => db.prepare('SELECT total FROM orders WHERE id = ?').get(id).total;
  assert.ok(total('ORD-5001') <= POLICY.autoApproveLimit.standard);
  assert.ok(total('ORD-5002') > POLICY.autoApproveLimit.standard);
  assert.ok(total('ORD-5004') > POLICY.autoApproveLimit.standard && total('ORD-5004') <= POLICY.autoApproveLimit.vip);
  assert.ok(total('ORD-5005') > POLICY.autoApproveLimit.vip);
});

test('CHECK constraints reject invalid rows', () => {
  assert.throws(() => db.prepare("UPDATE customers SET status = 'banned' WHERE id = 'CUS-1001'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE orders SET delivered_at = NULL WHERE id = 'ORD-5001'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE payment_methods SET last4 = '42a2' WHERE id = 'PM-201'").run(), /CHECK/);
  assert.throws(
    () => db.prepare("INSERT INTO escalations (id, type, summary, created_at) VALUES ('ESC-999', 'account', 'x', 'now')").run(),
    /CHECK/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO escalations (id, type, customer_id, summary, created_at) VALUES ('ESC-998', 'refund_approval', 'CUS-1001', 'x', 'now')").run(),
    /CHECK/,
  );
});

test('a reused idempotency key is rejected', () => {
  assert.throws(
    () => db.prepare(`
      INSERT INTO refunds (id, payment_id, amount, reason, status, idempotency_key, requested_at, resolved_at, resolved_by)
      VALUES ('REF-999', 'PAY-9001', 100, 'damaged', 'completed', 'seed-ref-301', 'now', 'now', 'agent')
    `).run(),
    /UNIQUE/,
  );
});

test('formatInr shows paise as rupees', () => {
  assert.equal(formatInr(349_900), '₹3,499.00');
  assert.equal(formatInr(4_200_000), '₹42,000.00');
});
