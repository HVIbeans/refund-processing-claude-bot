// Structured output for the agent's final decision each turn, via a forced tool call.
// The Messages API has no JSON-mode: a dedicated tool plus a forced tool_choice is how
// Claude produces guaranteed-shape structured data. This is a separate request from the
// conversational one, so it never appears in the customer-facing tool loop.
// This is the model's own self-report, not cross-checked against the actual tool_result JSON
// (e.g. initiate_refund's real amount/status) already in history. Fine for a display line today;
// step 19's audit log should reconcile against the real tool results, not trust this at face value.
import { z } from "zod";
import { MAX_TEXT } from "../policy.js";

const DECISIONS = ["none", "approved", "partial", "denied", "escalated"];

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
  reason: z.string().min(1).max(MAX_TEXT),
  needs_human: z.boolean(),
});

const FALLBACK = { decision: "none", amount: 0, reason: "the decision could not be extracted", needs_human: false };

const INSTRUCTION =
  'Call record_decision now, summarizing the outcome of your reply above. Use "none" if nothing was decided yet.';

// A history ending in a tool_result is still a user message: appending another one would send two
// consecutive user messages, which the API rejects. Merge into it instead, exactly like chat.js's
// own pushUserText does for real customer text.
function appendInstruction(history) {
  const last = history.at(-1);
  if (last?.role === "user" && Array.isArray(last.content)) {
    return [...history.slice(0, -1), { ...last, content: [...last.content, { type: "text", text: INSTRUCTION }] }];
  }
  return [...history, { role: "user", content: INSTRUCTION }];
}

// A UTF-16 slice can split a surrogate pair; drop a dangling leading surrogate left at the cut.
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// A forced tool_choice can't be combined with extended thinking, and none is needed here:
// the model is reporting the outcome of reasoning it already did in the conversational call.
// tools: an optional, already-prepared tool list (e.g. with a cache_control breakpoint) to send
// ahead of DECISION_TOOL, so this call's prefix can match and reuse the conversational call's
// cache. Left out, only DECISION_TOOL is sent, as before. If the shared tools are themselves
// cache-marked, DECISION_TOOL (identical on every call) gets its own breakpoint too.
export async function extractDecision({ client, model, system, history, tools = [] }) {
  const sharing = tools.length > 0 && Boolean(tools.at(-1)?.cache_control);
  const decisionTool = sharing ? { ...DECISION_TOOL, cache_control: { type: "ephemeral" } } : DECISION_TOOL;
  const response = await client.messages
    .stream({
      model,
      max_tokens: 1024, // room for a full tool_use call with a reason near MAX_TEXT long
      system,
      messages: appendInstruction(history),
      tools: [...tools, decisionTool],
      tool_choice: { type: "tool", name: "record_decision" },
    })
    .finalMessage();

  const call = response.content.find((b) => b.type === "tool_use" && b.name === "record_decision");
  // An overlong reason shouldn't sink an otherwise-valid decision (e.g. a real needs_human: true).
  let input = call?.input;
  if (typeof input?.reason === "string" && input.reason.length > MAX_TEXT) {
    input = { ...input, reason: truncate(input.reason, MAX_TEXT) };
  }
  const parsed = input && DecisionSchema.safeParse(input);
  const fields = parsed?.success ? parsed.data : FALLBACK;
  return { ...fields, usage: response.usage };
}
