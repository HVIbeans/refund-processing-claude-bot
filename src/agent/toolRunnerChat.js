// A conversation with Claude using the SDK's beta Tool Runner (client.beta.messages.toolRunner)
// instead of chat.js's hand-written loop, to compare the two (roadmap step 16). Confirmed against
// the SDK's own source (node_modules/@anthropic-ai/sdk/src/lib/tools/BetaToolRunner.ts), not just
// its docs: the runner executes each tool's run() and feeds the result back automatically, so no
// manual generateToolResponse() call is needed to drive the loop, and runner.params.messages is
// the full transcript (every tool round) once the loop ends - that's what keeps history in sync
// across turns, since each send() call is scoped to one turn (a fresh runner per customer message,
// given the full history so far), not one long-lived runner reused across turns.
//
// Deliberately NOT ported from chat.js: the refusal/empty-reply/cut-off-tool-call fallback replies,
// history rollback on a failed request, and the onDiscard "withdraw that reply" mechanism - see
// CLAUDE.md for why. `onDiscard` is accepted only for interface parity with chat.js.
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { buildSystemPrompt } from "./systemPrompt.js";
import { extractDecision } from "./decision.js";
import { DEFAULT_MODEL } from "./chat.js";

const textOf = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

const notify = (observer, ...args) => {
  try {
    observer(...args);
  } catch {
    // ignore
  }
};

const addUsage = (total, usage = {}) => {
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
  }
};

// Wraps an MCP-derived Claude tool def (name, description, input_schema) in a run() function the
// Tool Runner calls directly - no manual tool_use/tool_result plumbing. A thrown error becomes an
// is_error tool_result (the runner prefixes it "Error: "), so the model sees it and can react.
export function toRunnerTool(claudeTool, callTool, onToolCall = () => {}) {
  return betaTool({
    name: claudeTool.name,
    description: claudeTool.description,
    inputSchema: claudeTool.input_schema,
    run: async (input) => {
      const { text, isError } = await callTool(claudeTool.name, input);
      notify(onToolCall, { name: claudeTool.name, input, isError, text });
      if (isError) throw new Error(text);
      return text;
    },
  });
}

// Both are byte-identical on every request for the life of the conversation - see chat.js's
// cachedSystem()/cachedTools() for the full caching rationale; this mirrors it exactly.
export function applyCacheToSystem(system, enabled) {
  return enabled
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;
}

export function applyCacheToTools(tools, enabled) {
  return enabled && tools.length > 0
    ? [...tools.slice(0, -1), { ...tools.at(-1), cache_control: { type: "ephemeral" } }]
    : tools;
}

export function createToolRunnerChat({
  client,
  model = DEFAULT_MODEL,
  system = buildSystemPrompt(),
  maxTokens = 16000,
  thinking = true,
  effort,
  decide = false,
  cache = false,
  tools = [], // Claude tool definitions (from mcpClient.js)
  callTool, // async (name, input) => { text, isError }
  maxRounds = 8,
  onToolCall = () => {},
  onText = () => {},
  onThinking = () => {},
  onDiscard = () => {}, // accepted for interface parity with chat.js; never called here
}) {
  const history = [];
  const settings = { thinking, effort, decide, cache };
  const runnerTools = tools.map((t) => toRunnerTool(t, callTool, onToolCall));

  const cachedSystem = () => applyCacheToSystem(system, settings.cache);
  const cachedTools = () => applyCacheToTools(runnerTools, settings.cache);

  // Same merge-into-trailing-tool-result-message logic as chat.js's pushUserText: a history
  // ending in a tool round is still a user message, so a new one would break role alternation.
  function pushUserText(text) {
    const last = history.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push({ type: "text", text });
      return;
    }
    history.push({ role: "user", content: text });
  }

  // A failure here must never cost the customer their reply: fall back instead of throwing.
  async function runDecision() {
    try {
      const sharedTools = settings.cache ? cachedTools() : [];
      const { usage: decisionUsage, ...fields } = await extractDecision({
        client, model, system: cachedSystem(), history, tools: sharedTools,
      });
      return { fields, usage: decisionUsage };
    } catch (err) {
      return {
        fields: { decision: "none", amount: 0, reason: `decision extraction failed: ${err.message}`, needs_human: false },
        usage: {},
      };
    }
  }

  async function send(text) {
    pushUserText(text);

    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: maxTokens,
      system: cachedSystem(),
      messages: history,
      ...(runnerTools.length > 0 && { tools: cachedTools() }),
      max_iterations: maxRounds,
      stream: true,
      ...(settings.thinking && { thinking: { type: "adaptive" } }),
      ...(settings.effort && { output_config: { effort: settings.effort } }),
    });

    const usage = {};
    let calls = 0;
    let finalMessage;
    for await (const stream of runner) {
      stream.on("text", (d) => notify(onText, d));
      stream.on("thinking", (d) => notify(onThinking, d));
      finalMessage = await stream.finalMessage();
      addUsage(usage, finalMessage.usage);
      calls += 1;
    }
    if (!finalMessage) {
      throw new Error("the tool runner ended without producing a message (check max_iterations)");
    }

    // The runner tracked every tool round internally; sync our own history to match, since the
    // next send() call creates a fresh runner scoped to that turn, given this full history so far.
    history.length = 0;
    history.push(...runner.params.messages);

    let decision;
    if (settings.decide) {
      const { fields, usage: decisionUsage } = await runDecision();
      decision = fields;
      addUsage(usage, decisionUsage);
      calls += 1;
    }

    return {
      text: textOf(finalMessage.content),
      fallback: false,
      stopReason: finalMessage.stop_reason,
      usage,
      // Matches chat.js's convention: rounds counts completed tool rounds only, not the final
      // answering call (or the decision-extraction call) - so a tool-free turn has rounds: 0.
      rounds: Math.max(calls - (decision ? 2 : 1), 0),
      calls,
      decision,
    };
  }

  return {
    send,
    setEffort: (level) => {
      settings.effort = level;
    },
    setThinking: (on) => {
      settings.thinking = on;
    },
    setDecide: (on) => {
      settings.decide = on;
    },
    setCache: (on) => {
      settings.cache = on;
    },
    settings,
    reset: () => {
      history.length = 0;
    },
    history,
  };
}
