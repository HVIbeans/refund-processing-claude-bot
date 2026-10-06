// Structured output for the agent's final decision each turn, via a forced tool call.
// The Messages API has no JSON-mode: a dedicated tool plus a forced tool_choice is how
// Claude produces guaranteed-shape structured data. This is a separate request from the
// conversational one, so it never appears in the customer-facing tool loop.
import { z } from "zod";

const DECISIONS = ["none", "approved", "partial", "denied", "escalated"];
const MAX_REASON = 2000; // matches MAX_TEXT in tools.js

export const DECISION_TOOL = {
  name: "record_decision",
  description:
    "Record the outcome of this turn. Call every time, right after your reply to the customer. Use \"none\" when nothing was decided yet (verifying identity, looking things up, general chat).",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: DECISIONS, description: "Outcome of this turn." },
      amount: { type: "integer", minimum: 0, description: "Whole rupees refunded or escalated for; 0 if none." },
      reason: { type: "string", description: "Short reason for the decision (a sentence or two)." },
      needs_human: { type: "boolean", description: "Whether a human needs to review or approve this." },
    },
    required: ["decision", "amount", "reason", "needs_human"],
  },
};

const DecisionSchema = z.object({
  decision: z.enum(DECISIONS),
  amount: z.number().int().min(0),
  reason: z.string().min(1).max(MAX_REASON),
  needs_human: z.boolean(),
});

const FALLBACK = { decision: "none", amount: 0, reason: "the decision could not be extracted", needs_human: false };

const INSTRUCTION =
  'Call record_decision now, summarizing the outcome of your reply above. Use "none" if nothing was decided yet.';

// A forced tool_choice can't be combined with extended thinking, and none is needed here:
// the model is reporting the outcome of reasoning it already did in the conversational call.
export async function extractDecision({ client, model, system, history }) {
  const messages = [...history, { role: "user", content: INSTRUCTION }];
  const response = await client.messages
    .stream({
      model,
      max_tokens: 300,
      system,
      messages,
      tools: [DECISION_TOOL],
      tool_choice: { type: "tool", name: "record_decision" },
    })
    .finalMessage();

  const call = response.content.find((b) => b.type === "tool_use" && b.name === "record_decision");
  // An overlong reason shouldn't sink an otherwise-valid decision (e.g. a real needs_human: true).
  let input = call?.input;
  if (typeof input?.reason === "string" && input.reason.length > MAX_REASON) {
    input = { ...input, reason: input.reason.slice(0, MAX_REASON) };
  }
  const parsed = input && DecisionSchema.safeParse(input);
  const fields = parsed?.success ? parsed.data : FALLBACK;
  return { ...fields, usage: response.usage };
}
