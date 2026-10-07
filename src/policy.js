// Refund policy. All amounts are whole rupees (no paise).
// The tools in src/tools.js enforce these rules; the agent's system prompt only describes them.
export const POLICY = Object.freeze({
  currency: 'INR',
  refundWindowDays: 30, // counted from orders.delivered_at
  autoApproveLimit: Object.freeze({ standard: 5_000, vip: 25_000 }),
  validReasons: Object.freeze(['damaged', 'wrong_item', 'not_as_described']),
});

// Shared cap for free-text fields (reason_details, decision reasons, escalation summaries).
export const MAX_TEXT = 2000;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export function formatInr(rupees) {
  return inr.format(rupees);
}
