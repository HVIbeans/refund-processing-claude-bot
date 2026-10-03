// A conversation with Claude over the Messages API. The API is stateless: every request
// sends the system prompt and the whole history, and we append each reply to that history.
import { buildSystemPrompt } from "./systemPrompt.js";

// Used when ANTHROPIC_MODEL isn't set. It must be a model the gateway serves:
// list them with client.models.list().
export const DEFAULT_MODEL = "claude-sonnet-4-6";
const REFUSAL_REPLY =
  "Sorry, I can't help with that here. Is there anything else about a refund I can help with?";
const EMPTY_REPLY = "Sorry, I didn't get a reply that time. Could you say that again?";

const textOf = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

export function createChat({
  client,
  model = DEFAULT_MODEL,
  system = buildSystemPrompt(),
  maxTokens = 5000,
}) {
  const history = [];

  async function send(text) {
    const before = history.length;
    history.push({ role: "user", content: text });
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: history,
      });
    } catch (err) {
      history.length = before; // drop the user turn so a retry doesn't send it twice
      throw err;
    }

    const { stop_reason: stopReason, usage } = response;
    if (stopReason === "refusal") {
      history.length = before; // keep the declined turn out of the conversation
      return { text: REFUSAL_REPLY, stopReason, usage };
    }
    if (response.content.length === 0) {
      // The API rejects an empty assistant turn anywhere but last, so it would break every later request.
      history.length = before;
      return { text: EMPTY_REPLY, stopReason, usage };
    }

    // Append the full content (not just the text): it can include thinking blocks,
    // which must be passed back unchanged on later turns.
    history.push({ role: "assistant", content: response.content });
    let reply = textOf(response.content);
    if (stopReason === "max_tokens") reply += "\n\n(The reply was cut off.)";
    return { text: reply, stopReason, usage };
  }

  return {
    send,
    reset: () => {
      history.length = 0;
    },
    history,
  };
}
