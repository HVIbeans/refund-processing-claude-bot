// Refund policy. All amounts are whole rupees (no paise).
// The tools in src/tools.js enforce these rules; the agent's system prompt only describes them.
export const POLICY = Object.freeze({
  currency: 'INR',
  refundWindowDays: 30, // counted from orders.delivered_at
  autoApproveLimit: Object.freeze({ standard: 5_000, vip: 25_000 }),
  validReasons: Object.freeze(['damaged', 'wrong_item', 'not_as_described']),
  // Fraud signals (step 26). maxRefunds is a hard limit: a customer with this many refunds
  // (completed or pending) requested in the last windowDays gets no more without a human review.
  // newAccountDays and highValueOrder are soft signals; reviewAtSignals of the three signals
  // together (or frequent refunds alone) mean a human should review before a refund. None of these
  // numbers is shown to the model, only whether each signal is true.
  risk: Object.freeze({ windowDays: 30, maxRefunds: 3, newAccountDays: 30, highValueOrder: 10_000, reviewAtSignals: 2 }),
});

// Shared cap for free-text fields (reason_details, decision reasons, escalation summaries).
export const MAX_TEXT = 2000;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export function formatInr(rupees) {
  return inr.format(rupees);
}
