// A conversation with Claude over the Messages API, with the tool-use loop written by hand.
// The API is stateless: every request sends the system prompt, the tools and the whole history,
// and we append each reply (and each round of tool results) to that history.
import { buildSystemPrompt } from "./systemPrompt.js";

// Used when ANTHROPIC_MODEL isn't set. It must be a model the gateway serves:
// list them with client.models.list().
export const DEFAULT_MODEL = "claude-sonnet-4-6";
const REFUSAL_REPLY =
  "Sorry, I can't help with that here. Is there anything else about a refund I can help with?";
const EMPTY_REPLY = "Sorry, I didn't get a reply that time. Could you say that again?";
const CUT_OFF_REPLY = "Sorry, my reply was cut off. Could you say that again?";

const textOf = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

// Adds up the numeric usage fields of every API call in a turn.
const addUsage = (total, usage = {}) => {
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
  }
};

export function createChat({
  client,
  model = DEFAULT_MODEL,
  system = buildSystemPrompt(),
  maxTokens = 5000,
  tools = [], // Claude tool definitions (from mcpClient.js)
  callTool, // async (name, input) => { text, isError }
  maxRounds = 8, // tool rounds per customer message before the model must answer
  onToolCall = () => {}, // called after each tool runs: ({ name, input, isError, text })
}) {
  const history = [];

  // A message that ends in tool results is a user message, so new text joins it (results first,
  // then text). Starting a new user message instead would break the user/assistant alternation.
  function pushUserText(text) {
    const last = history.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push({ type: "text", text });
      return true;
    }
    history.push({ role: "user", content: text });
    return false;
  }

  // The model's tool input is untrusted: zod and tools.js validate it on the server. A tool that
  // can't be run at all (e.g. the server crashed) is reported to the model as an error result.
  async function runTool(name, input) {
    try {
      return await callTool(name, input);
    } catch (err) {
      return { text: `The tool could not be run: ${err.message}`, isError: true };
    }
  }

  async function send(text) {
    const before = history.length;
    const merged = pushUserText(text);
    // Where to roll back to if a request fails. It moves past each completed tool round, because
    // those tools have already run (a refund may have been made) and the model must remember them.
    let safe = before;
    const rollback = () => {
      history.length = safe;
      if (merged && safe === before) history.at(-1).content.pop();
    };

    const usage = {};
    let rounds = 0;
    for (;;) {
      const lastRound = rounds >= maxRounds;
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: history,
          ...(tools.length > 0 && { tools }),
          // Out of rounds: the model must answer in text with what it has.
          ...(tools.length > 0 && lastRound && { tool_choice: { type: "none" } }),
        });
      } catch (err) {
        rollback(); // so a retry doesn't send the user's text twice
        throw err;
      }
      addUsage(usage, response.usage);

      const { stop_reason: stopReason, content } = response;
      const result = (reply) => ({ text: reply, stopReason, usage, rounds });
      if (stopReason === "refusal") {
        rollback(); // keep the declined turn out of the conversation
        return result(REFUSAL_REPLY);
      }
      if (content.length === 0) {
        // The API rejects an empty assistant turn anywhere but last, so it would break every later request.
        rollback();
        return result(EMPTY_REPLY);
      }
      const toolUses = content.filter((b) => b.type === "tool_use");
      if (toolUses.length > 0 && (stopReason === "max_tokens" || lastRound)) {
        // A cut-off tool input may be incomplete, so never run it. (On the last round tool_choice
        // rules tool calls out; this only guards against looping forever.)
        rollback();
        return result(CUT_OFF_REPLY);
      }

      // Append the full content (not just the text): it can include thinking blocks and tool_use
      // blocks, which must be passed back unchanged on later requests.
      history.push({ role: "assistant", content });
      if (stopReason !== "tool_use") {
        let reply = textOf(content);
        if (stopReason === "max_tokens") reply += "\n\n(The reply was cut off.)";
        return result(reply);
      }

      // Run the requested tools one at a time, in order (refunds have side effects), and send every
      // result back in one user message. Each tool_use needs a tool_result with its id.
      const results = [];
      for (const { id, name, input } of toolUses) {
        const { text: output, isError } = await runTool(name, input);
        try {
          onToolCall({ name, input, isError, text: output });
        } catch {
          // A failing observer must not stop the loop: this tool_use still needs its tool_result,
          // and the tool may already have made a refund that the model has to hear about.
        }
        results.push({ type: "tool_result", tool_use_id: id, content: output, is_error: isError });
      }
      history.push({ role: "user", content: results });
      safe = history.length;
      rounds += 1;
    }
  }

  return {
    send,
    reset: () => {
      history.length = 0;
    },
    history,
  };
}
