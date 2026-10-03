// Seed data: each customer exists to exercise a specific refund scenario (see the comments).
// Dates are relative to `today` so the refund-window cases stay correct whenever the DB is reset.

const DAY_MS = 24 * 60 * 60 * 1000;

export function seed(db, today = new Date()) {
  const daysAgo = (n) => new Date(today.getTime() - n * DAY_MS).toISOString();

  const customers = [
    // id, name, email, phone, status, tier, created_at
    ['CUS-1001', 'Priya Shah', 'priya.shah@example.com', '+91 98200 00001', 'active', 'standard', daysAgo(400)],
    ['CUS-1002', 'Arjun Mehta', 'arjun.mehta@example.com', '+91 98200 00002', 'active', 'vip', daysAgo(900)],
    ['CUS-1003', 'Neha Kapoor', 'neha.kapoor@example.com', '+91 98200 00003', 'active', 'standard', daysAgo(250)],
    ['CUS-1004', 'Rahul Verma', 'rahul.verma@example.com', '+91 98200 00004', 'flagged', 'standard', daysAgo(30)],
    ['CUS-1005', 'Sana Iqbal', 'sana.iqbal@example.com', '+91 98200 00005', 'suspended', 'standard', daysAgo(600)],
    ['CUS-1006', 'Vikram Rao', 'vikram.rao@example.com', '+91 98200 00006', 'active', 'standard', daysAgo(180)],
    ['CUS-1007', 'Anita Desai', 'anita.desai@example.com', '+91 98200 00007', 'active', 'standard', daysAgo(320)],
    ['CUS-1008', 'Meera Nair', 'meera.nair@example.com', '+91 98200 00008', 'active', 'standard', daysAgo(10)], // no cards: can't be verified
  ];

  const paymentMethods = [
    // id, customer_id, brand, last4, exp_month, exp_year
    ['PM-201', 'CUS-1001', 'visa', '4242', 8, 2028],
    ['PM-202', 'CUS-1002', 'mastercard', '5454', 3, 2029],
    ['PM-203', 'CUS-1003', 'rupay', '6070', 11, 2027], // Neha has two cards; either one verifies
    ['PM-204', 'CUS-1003', 'visa', '1881', 5, 2030],
    ['PM-205', 'CUS-1004', 'visa', '9001', 1, 2028],
    ['PM-206', 'CUS-1005', 'mastercard', '3131', 7, 2027],
    ['PM-207', 'CUS-1006', 'rupay', '6521', 9, 2028],
    ['PM-208', 'CUS-1007', 'visa', '7777', 12, 2029],
  ];

  // Each order gets exactly one payment: [order, payment].
  // order: id, customer_id, description, status, placed_at, delivered_at, total
  // payment: payment_method_id, status
  const orders = [
    // Priya: happy path, above the standard limit, and outside the 30-day window
    [['ORD-5001', 'CUS-1001', 'Wireless earbuds', 'delivered', daysAgo(8), daysAgo(5), 3_499], ['PM-201', 'captured']],
    [['ORD-5002', 'CUS-1001', 'Smartwatch', 'delivered', daysAgo(14), daysAgo(10), 12_999], ['PM-201', 'captured']],
    [['ORD-5003', 'CUS-1001', 'Phone case + screen guard', 'delivered', daysAgo(50), daysAgo(45), 2_199], ['PM-201', 'captured']],
    // Arjun (VIP): within the VIP limit, then above even the VIP limit
    [['ORD-5004', 'CUS-1002', 'Espresso machine', 'delivered', daysAgo(6), daysAgo(3), 18_500], ['PM-202', 'captured']],
    [['ORD-5005', 'CUS-1002', '4K television', 'delivered', daysAgo(12), daysAgo(7), 42_000], ['PM-202', 'captured']],
    // Neha: partially refunded, and fully refunded (duplicate attempt)
    [['ORD-5006', 'CUS-1003', 'Running shoes x2', 'delivered', daysAgo(15), daysAgo(12), 8_000], ['PM-203', 'captured']],
    [['ORD-5007', 'CUS-1003', 'Yoga mat', 'delivered', daysAgo(20), daysAgo(17), 2_499], ['PM-204', 'captured']],
    // Rahul (flagged) and Sana (suspended)
    [['ORD-5008', 'CUS-1004', 'Bluetooth speaker', 'delivered', daysAgo(11), daysAgo(8), 6_000], ['PM-205', 'captured']],
    [['ORD-5009', 'CUS-1005', 'Desk lamp', 'delivered', daysAgo(9), daysAgo(6), 1_500], ['PM-206', 'captured']],
    // Vikram: not delivered, pending payment, failed payment, disputed payment
    [['ORD-5010', 'CUS-1006', 'Backpack', 'shipped', daysAgo(4), null, 5_600], ['PM-207', 'captured']],
    [['ORD-5011', 'CUS-1006', 'Water bottle', 'placed', daysAgo(1), null, 1_999], ['PM-207', 'pending']],
    [['ORD-5012', 'CUS-1006', 'Keyboard', 'cancelled', daysAgo(3), null, 3_200], ['PM-207', 'failed']],
    [['ORD-5013', 'CUS-1006', 'Gaming mouse', 'delivered', daysAgo(18), daysAgo(15), 4_200], ['PM-207', 'disputed']],
    // Anita: a refund already waiting for approval
    [['ORD-5014', 'CUS-1007', 'Office chair', 'delivered', daysAgo(10), daysAgo(6), 9_000], ['PM-208', 'captured']],
  ];

  const refunds = [
    // id, payment_id, amount, reason, reason_details, status, idempotency_key, requested_at, resolved_at, resolved_by
    ['REF-301', 'PAY-9006', 3_000, 'damaged', 'One shoe split at the sole', 'completed', 'seed-ref-301', daysAgo(10), daysAgo(10), 'agent'],
    ['REF-302', 'PAY-9007', 2_499, 'not_as_described', 'Much thinner than the listing said', 'completed', 'seed-ref-302', daysAgo(15), daysAgo(15), 'agent'],
    ['REF-303', 'PAY-9014', 7_000, 'damaged', 'Armrest snapped off on day one', 'pending_approval', 'seed-ref-303', daysAgo(2), null, null],
  ];

  const escalations = [
    // id, type, customer_id, contact_email, order_id, refund_id, summary, status, created_at
    ['ESC-401', 'refund_approval', 'CUS-1007', null, 'ORD-5014', 'REF-303',
      'Verified customer requests ₹7,000 of ₹9,000 for an office chair whose armrest broke on day one. Above the ₹5,000 standard limit.',
      'open', daysAgo(2)],
  ];

  const insert = (table, columns, rows) => {
    const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (const row of rows) stmt.run(...row);
  };

  db.exec('BEGIN');
  try {
    insert('customers', ['id', 'name', 'email', 'phone', 'status', 'tier', 'created_at'], customers);
    insert('payment_methods', ['id', 'customer_id', 'brand', 'last4', 'exp_month', 'exp_year'], paymentMethods);
    insert('orders', ['id', 'customer_id', 'description', 'status', 'placed_at', 'delivered_at', 'total'], orders.map(([order]) => order));
    insert(
      'payments',
      ['id', 'order_id', 'payment_method_id', 'amount', 'status', 'captured_at'],
      orders.map(([order, [methodId, status]]) => {
        const [orderId, , , , placedAt, , total] = order;
        const captured = status === 'captured' || status === 'disputed';
        return [orderId.replace('ORD-5', 'PAY-9'), orderId, methodId, total, status, captured ? placedAt : null];
      }),
    );
    insert(
      'refunds',
      ['id', 'payment_id', 'amount', 'reason', 'reason_details', 'status', 'idempotency_key', 'requested_at', 'resolved_at', 'resolved_by'],
      refunds,
    );
    insert('escalations', ['id', 'type', 'customer_id', 'contact_email', 'order_id', 'refund_id', 'summary', 'status', 'created_at'], escalations);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
