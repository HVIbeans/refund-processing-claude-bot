// Refund policy. Amounts are in paise (₹1 = 100 paise).
// The tools in step 6 enforce these rules; the agent's system prompt only describes them.
export const POLICY = Object.freeze({
  currency: 'INR',
  refundWindowDays: 30, // counted from orders.delivered_at
  autoApproveLimit: Object.freeze({ standard: 500_000, vip: 2_500_000 }), // ₹5,000 / ₹25,000
  validReasons: Object.freeze(['damaged', 'wrong_item', 'not_as_described']),
});

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function formatInr(paise) {
  return inr.format(paise / 100);
}
