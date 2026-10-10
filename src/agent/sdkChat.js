// A conversation with the refund agent built on the Claude Agent SDK (roadmap step 25): the same
// agent loop Claude Code runs, as a library. query() spawns a bundled Claude Code process that
// runs the tool loop, starts our MCP server itself and streams messages back.
//
// Out of the box that process is a coding agent: it loads CLAUDE.md, .claude/settings.json, hooks,
// skills and .mcp.json (which starts the server with --reviewer), and has Bash, Read, Edit and the
// rest. Most of the options below exist to switch all that off, so the customer-facing agent sees
// only the customer tools. Option semantics were checked in the installed SDK's own typings
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts), not just its docs.
//
// Same createChat-shaped interface as chat.js and toolRunnerChat.js. Not ported: decision
// extraction (the SDK's history isn't in Messages API form for extractDecision()), chat.js's
// rollback/onDiscard/connection retry (the SDK retries API errors itself), and /cache (the SDK
// caches the system prompt and tools on its own).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_MODEL } from "./chat.js";

export const SERVER_NAME = "refund-tools";
const PREFIX = `mcp__${SERVER_NAME}__`;
const serverScript = fileURLToPath(new URL("../mcp/stdio.js", import.meta.url));
const ERROR_REPLY = "Sorry, I couldn't finish that. Could you say that again?";

const notify = (observer, ...args) => {
  try {
    observer(...args);
  } catch {
    // ignore
  }
};

// A tool_result's content is a string or an array of blocks; our server only returns text.
const resultText = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");

// The last line of defence, as a PreToolUse hook: it runs before every tool call, including ones
// allowedTools already approved, so a name off the allowlist is denied even if the options above
// were ever loosened. (canUseTool wouldn't do: auto-approved calls never reach it.)
export function allowOnlyHook(allowed) {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || allowed.has(input.tool_name)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `There is no tool named "${input.tool_name}".`,
      },
    };
  };
}

// The Claude Code process's working directory. With no built-in tools nothing reads it, but its
// path and git status go into the context, so it's an empty folder outside the project. A fresh
// random one per process: a fixed path could be pre-filled with a .claude/ folder by someone else.
let dir;
const agentDir = () => (dir ??= mkdtempSync(join(tmpdir(), "refund-agent-")));

// The query() options. Exported so the tests can check every isolation setting.
// hiddenToolNames: tools the server has that the agent mustn't even see (log_decision).
export function buildOptions({ model, system, toolNames, hiddenToolNames = [], thinking, effort }) {
  const allowed = toolNames.map((name) => PREFIX + name);
  return {
    model,
    systemPrompt: system, // a plain string replaces Claude Code's whole system prompt
    // Customer text is untrusted: by default the CLI expands "@path" mentions into file contents
    // (a customer could type "@.env") and runs "/commands" (/model, /clear, skills). This sends
    // every message as written instead.
    verbatimPrompts: true,
    tools: [], // no built-in tools (Bash, Read, Edit, WebFetch, Agent, ...)
    skills: [],
    // allowedTools only pre-approves; this removes the tool definitions from the request.
    disallowedTools: hiddenToolNames.map((name) => PREFIX + name),
    settingSources: [], // no CLAUDE.md, settings, hooks or skills from disk
    // settingSources: [] still left these in (seen in a request captured by a local mock API):
    settings: { autoMemoryEnabled: false }, // the developer's auto-memory, as "instructions"
    title: "Refund chat", // else a second request sends the customer's message to make a title
    cwd: agentDir(), // an empty folder: the env reminder would show the project path and git
    strictMcpConfig: true, // only the server below; .mcp.json would add the --reviewer one
    mcpServers: {
      [SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        // No --reviewer, same as mcpClient.js's stdioTransport().
        args: ["--disable-warning=ExperimentalWarning", serverScript],
        env: getDefaultEnvironment(), // PATH and the like, not ANTHROPIC_API_KEY
      },
    },
    allowedTools: allowed, // listed one by one: log_decision is on the server but not for the agent
    permissionMode: "dontAsk", // anything not pre-approved is denied, never prompted for
    hooks: { PreToolUse: [{ hooks: [allowOnlyHook(new Set(allowed))] }] },
    persistSession: false, // transcripts hold customer emails and card digits
    includePartialMessages: true, // stream_event messages carry the text as it's written
    thinking: thinking ? { type: "adaptive" } : { type: "disabled" },
    ...(effort && { effort }),
  };
}

// A push-based async iterable: query() reads customer messages from it for as long as the
// conversation lasts (streaming input mode), and send() pushes each one in.
function messageQueue() {
  const items = [];
  let wake = null;
  let done = false;
  return {
    push(text) {
      items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) yield items.shift();
        else if (done) return;
        else await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

export function createSdkChat({
  query = sdkQuery, // injectable, so tests can script the message stream
  model = DEFAULT_MODEL,
  system,
  thinking = true,
  effort,
  tools = [], // Claude tool definitions; only their names are used, to build the allowlist
  hiddenToolNames = [], // on the server, but removed from the agent's view
  maxTurns = 8,
  onToolCall = () => {},
  onText = () => {},
  onThinking = () => {},
  onDiscard = () => {}, // a turn ended in an error: withdraw what it already streamed
  onInit = () => {}, // the system/init message: the tools and MCP servers the agent really has
}) {
  // decide and cache are fixed: see the header comment.
  const settings = { thinking, effort, decide: false, cache: true };
  const toolNames = tools.map((t) => t.name);
  const allowed = new Set(toolNames.map((name) => PREFIX + name));
  let session = null; // { q, input, pump }
  let turn = null; // the send() in progress

  function start() {
    const input = messageQueue();
    const q = query({
      prompt: input,
      options: { ...buildOptions({ model, system, toolNames, hiddenToolNames, ...settings }), maxTurns },
    });
    const s = { q, input };
    // A session closed by reset() can finish after a new one started: only the current session
    // may settle the turn in progress.
    s.pump = pump(s).then(
      () => ended(s, new Error("the agent process ended unexpectedly")),
      (err) => ended(s, err),
    );
    return s;
  }

  // Reads every message of the conversation and routes it to the current turn.
  async function pump(s) {
    const pending = new Map(); // tool_use id → { name, input }
    let wroteText = false;
    for await (const msg of s.q) {
      if (msg.type === "system" && msg.subtype === "init") {
        notify(onInit, { tools: msg.tools, mcpServers: msg.mcp_servers, model: msg.model });
        // Fail closed: if anything the options don't control (a managed policy on the machine, a
        // changed SDK default) gave the agent more tools, end the conversation before it starts.
        const extra = msg.tools.filter((name) => !allowed.has(name));
        if (extra.length) throw new Error(`the agent session has unexpected tools: ${extra.join(", ")}`);
      } else if (msg.parent_tool_use_id) {
        continue; // subagent output; there are no subagents here, but never show one's text
      } else if (msg.type === "stream_event") {
        const { event } = msg;
        // Separate text blocks get a line break between them, as in chat.js.
        if (event.type === "content_block_start" && event.content_block.type === "text" && wroteText) {
          notify(onText, "\n");
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          wroteText = true;
          notify(onText, event.delta.text);
        } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
          notify(onThinking, event.delta.thinking);
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") pending.set(block.id, { name: block.name, input: block.input });
        }
      } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_result" || !pending.has(block.tool_use_id)) continue;
          const { name, input } = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          notify(onToolCall, {
            name: name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name,
            input,
            isError: Boolean(block.is_error),
            text: resultText(block.content),
          });
        }
      } else if (msg.type === "result") {
        wroteText = false;
        const reply = toReply(msg);
        // Whatever streamed before the error mustn't stand next to the fallback reply.
        if (reply.fallback) notify(onDiscard);
        turn?.resolve(reply);
        turn = null;
      }
    }
  }

  // The message stream ended or failed. If close() didn't end it, the Claude Code process went
  // away: fail the turn, and the next send() starts a fresh conversation.
  function ended(s, err) {
    if (session !== s) return;
    session = null;
    s.input.end();
    s.q.close(); // the process may still be running, e.g. after the unexpected-tools check
    turn?.reject(err);
    turn = null;
  }

  function toReply(result) {
    const ok = result.subtype === "success" && !result.is_error;
    return {
      text: ok ? result.result : ERROR_REPLY,
      fallback: !ok, // our own reply, never streamed
      stopReason: ok ? result.stop_reason ?? "end_turn" : result.subtype,
      usage: result.usage ?? {}, // per turn in streaming input mode
      calls: result.num_turns,
      costUsd: result.total_cost_usd, // running total for the conversation, an estimate
      errors: ok ? [] : result.errors ?? [result.result].filter(Boolean),
    };
  }

  function send(text) {
    if (turn) return Promise.reject(new Error("a reply is still in progress"));
    session ??= start();
    return new Promise((resolve, reject) => {
      turn = { resolve, reject };
      session.input.push(text);
    });
  }

  function close() {
    if (!session) return;
    session.input.end();
    session.q.close();
    session = null;
  }

  return {
    send,
    // Effort can change mid-conversation; thinking only for the next one (after /reset), since
    // the SDK's live thinking setter is deprecated.
    setEffort: (level) => {
      settings.effort = level;
      session?.q.applyFlagSettings({ effortLevel: level }).catch(() => {});
    },
    setThinking: (on) => {
      settings.thinking = on;
    },
    setDecide: () => {},
    setCache: () => {},
    settings,
    reset: close, // the next send() starts a new query(), with no memory of this one
    close,
  };
}
