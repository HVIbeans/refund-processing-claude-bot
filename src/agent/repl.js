// npm run chat: talk to the refund agent in the terminal.
// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment (.env).
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, createChat } from './chat.js';
import { createToolRunnerChat } from './toolRunnerChat.js';
import { createSdkChat } from './sdkChat.js';
import { createMultiAgentChat } from './multiAgent.js';
import { connectMcp, stdioTransport } from './mcpClient.js';
import { modelSupport } from './capabilities.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { POLICY, formatInr } from '../policy.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
const EFFORTS = ['low', 'medium', 'high'];
const effort = process.env.ANTHROPIC_EFFORT || 'medium';
if (!EFFORTS.includes(effort)) {
  console.error(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')} (got "${effort}").`);
  process.exit(1);
}
const client = new Anthropic();
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Start the MCP server as a child process and list its tools. The agent reaches data only through them.
// If it dies mid-conversation, callTool transparently respawns it (stdioTransport passed again) and
// retries the in-flight call once - see mcpClient.js.
let mcp;
try {
  mcp = await connectMcp(stdioTransport(), { reconnect: stdioTransport });
} catch (err) {
  console.error(`Could not start the refund-tools MCP server: ${err.message}`);
  process.exit(1);
}

// Only ask for thinking and effort if the model accepts them; otherwise every request would 400.
const support = await modelSupport(client, model);
const supportsEffort = (level) => support.effortLevels.includes(level);

// Only controls what's printed: hidden thinking is still generated, kept in the history and billed.
let showThinking = true;

// Roadmap steps 16, 25 and 26: compare the hand-written loop against the SDK's beta Tool Runner
// (ANTHROPIC_LOOP=runner), the Claude Agent SDK (ANTHROPIC_LOOP=sdk) and an orchestrator with
// specialist agents, on the hand-written loop (ANTHROPIC_LOOP=multi).
const LOOPS = {
  manual: { create: createChat, label: 'manual' },
  runner: { create: createToolRunnerChat, label: 'tool runner (beta)' },
  sdk: { create: createSdkChat, label: 'Claude Agent SDK' },
  multi: { create: createMultiAgentChat, label: 'multi-agent (orchestrator + triage, fraud-checker, refund-specialist)' },
};
const loop = LOOPS[process.env.ANTHROPIC_LOOP || 'manual'];
if (!loop) {
  console.error(`ANTHROPIC_LOOP must be one of ${Object.keys(LOOPS).join(', ')} (got "${process.env.ANTHROPIC_LOOP}").`);
  process.exit(1);
}

// log_decision is harness-only: called directly below, never by the model (whether a decision
// gets logged isn't the model's call). The reviewer tools (resolve_refund_approval and the like)
// aren't here because the agent's server doesn't have them: stdioTransport() starts it without
// --reviewer. chat.js also refuses any tool_use for a tool not in agentTools.
const NOT_FOR_AGENT_TOOLS = new Set(['log_decision']);
const agentTools = mcp.tools.filter((t) => !NOT_FOR_AGENT_TOOLS.has(t.name));

// The server's instructions go into the system prompt, as MCP clients usually do.
// The Agent SDK adds them itself (as a system reminder), so it gets the prompt without them.
const system = buildSystemPrompt(POLICY, { toolInstructions: loop === LOOPS.sdk ? undefined : mcp.instructions });
const chat = loop.create({
  client, model, system,
  thinking: support.adaptiveThinking,
  effort: supportsEffort(effort) ? effort : undefined,
  decide: true, // on by default in the REPL; toggle with /decision
  cache: true, // on by default in the REPL; toggle with /cache
  tools: agentTools, callTool: mcp.callTool,
  onText: (text) => emit('agent', text),
  onThinking: (text) => {
    if (showThinking) emit('thinking', text);
  },
  onToolCall: showToolCall, onDiscard: withdraw,
  // Agent SDK only: it starts its own copy of the server, so it must be told what to hide.
  hiddenToolNames: [...NOT_FOR_AGENT_TOOLS],
  onInit: showInit,
  // Multi-agent only: the specialists' prompts carry the server's instructions.
  toolInstructions: mcp.instructions,
  onAgent: showAgent,
});

// Streamed text is written as it arrives. Each stretch starts with its prefix, `thinking> ` (dim)
// or `agent> `, so thinking, tool-call lines and the reply stay on separate lines.
let current = null; // the kind of stretch being written, or null at the start of a line
let turnStart = true;
let shown = false; // has the current API call printed anything (that a discard would withdraw)?
function emit(kind, text) {
  shown = true;
  if (current !== kind) {
    endLine();
    startBlock();
    output.write(kind === 'thinking' ? dim('thinking> ') : 'agent> ');
    current = kind;
  }
  output.write(kind === 'thinking' ? dim(text) : text);
}
function startBlock() {
  if (turnStart) output.write('\n'); // a blank line between "you> " and the turn's output
  turnStart = false;
}
function endLine() {
  if (current) output.write('\n');
  current = null;
}
// A reply that was already shown was thrown away (refused, cut off or failed): the customer
// mustn't rely on it. A web UI would delete or grey out the message; a terminal can only say so.
// Nothing is printed if that reply never reached the screen (e.g. its thinking was hidden).
function withdraw() {
  if (!shown) return;
  shown = false;
  endLine();
  console.log(dim('(that reply was withdrawn)'));
}
const thinkingLabel = () => {
  if (!support.adaptiveThinking) return `off (${model} doesn't support adaptive thinking)`;
  return chat.settings.thinking ? `adaptive${showThinking ? '' : ' (hidden)'}` : 'off';
};
const effortLabel = () => chat.settings.effort ?? (support.effortLevels.length ? 'model default' : 'not supported');

console.log(`Refund agent · model ${model} · endpoint ${new URL(client.baseURL).host} · loop: ${loop.label}`);
console.log(`Connected to ${mcp.server.name} v${mcp.server.version} · ${agentTools.length} tools`);
console.log(`Thinking: ${thinkingLabel()} · effort: ${effortLabel()} · decision: ${chat.settings.decide ? 'on' : 'off'} · cache: ${chat.settings.cache ? 'on' : 'off'} ${dim(`(capabilities from the ${support.source})`)}`);
console.log(dim('Tools are live: refunds change data/refunds.db (npm run db:reset undoes them).'));
console.log(dim('Commands: /tools, /effort [low|medium|high], /thinking (show/hide), /thinking on|off, /decision on|off, /cache on|off, /reset, /exit.\n'));

const rl = readline.createInterface({ input, output, prompt: 'you> ' });
let closed = false;
rl.on('close', () => { closed = true; });
rl.prompt();

// Lines are read one at a time; the next prompt appears only after the reply. Ctrl+D ends input.
for await (const raw of rl) {
  const line = raw.trim();
  const [command, arg] = line.split(/\s+/);
  if (line === '/exit') break;
  if (line === '/tools') {
    await showTools();
  } else if (command === '/effort') {
    if (arg && !EFFORTS.includes(arg)) {
      console.log(dim(`(effort must be one of ${EFFORTS.join(', ')})\n`));
    } else if (arg && !supportsEffort(arg)) {
      console.log(dim(`(${model} doesn't support effort ${arg})\n`));
    } else {
      if (arg) chat.setEffort(arg);
      console.log(dim(`(effort: ${effortLabel()})\n`));
    }
  } else if (command === '/thinking') {
    if (arg === 'on' || arg === 'off') {
      // What the API is asked for. If the model can't think, it stays off and the label says why.
      if (arg === 'off' || support.adaptiveThinking) chat.setThinking(arg === 'on');
    } else if (arg) {
      console.log(dim('(use /thinking, /thinking on or /thinking off)'));
    }
    else showThinking = !showThinking; // only what's printed
    console.log(dim(`(thinking: ${thinkingLabel()})\n`));
  } else if (command === '/decision') {
    if (arg === 'on' || arg === 'off') chat.setDecide(arg === 'on');
    else if (arg) console.log(dim('(use /decision, /decision on or /decision off)'));
    console.log(dim(`(decision extraction: ${chat.settings.decide ? 'on' : 'off'})\n`));
  } else if (command === '/cache') {
    if (arg === 'on' || arg === 'off') chat.setCache(arg === 'on');
    else if (arg) console.log(dim('(use /cache, /cache on or /cache off)'));
    console.log(dim(`(prompt caching: ${chat.settings.cache ? 'on' : 'off'})\n`));
  } else if (line === '/reset') {
    chat.reset();
    console.log(dim('(conversation cleared)\n'));
  } else if (line) {
    current = null;
    turnStart = true;
    shown = false;
    try {
      const { text, fallback, stopReason, usage, calls, decision, costUsd } = await chat.send(line);
      if (fallback) {
        // Our own reply (refusal, empty or cut-off tool call): it wasn't streamed.
        endLine();
        emit('agent', text);
      }
      endLine();
      if (stopReason === 'max_tokens' && !fallback) console.log(dim('(The reply was cut off.)'));
      if (decision) {
        showDecision(decision);
        await logDecision(decision);
      }
      // Output tokens include the thinking, so they rise with effort. A cache write costs ~1.25x
      // normal input price; a cache read costs ~10% of it - this is where the savings become visible.
      const cacheRead = usage.cache_read_input_tokens;
      const cacheWrite = usage.cache_creation_input_tokens;
      // costUsd: the Agent SDK's running estimate for the whole conversation, not this turn.
      const costPart = costUsd !== undefined ? ` · conversation so far ~$${costUsd.toFixed(4)}` : '';
      const cachePart = cacheRead || cacheWrite ? ` · cache: ${n(cacheRead)} read / ${n(cacheWrite)} write` : '';
      console.log(dim(`[${n(usage.input_tokens)} in / ${n(usage.output_tokens)} out${cachePart} · ${calls} API call${calls > 1 ? 's' : ''} · ${stopReason}${costPart}]\n`));
    } catch (err) {
      endLine(); // the error may arrive mid-reply
      console.error(`\n${describeError(err)}\n`);
    }
  }
  if (!closed) rl.prompt(); // input may have ended (Ctrl+D or piped input)
}
rl.close();
chat.close?.(); // the Agent SDK's Claude Code process (and the MCP server it started)
await mcp.close(); // ends the server process

function n(x = 0) {
  return x.toLocaleString('en-IN');
}

// One dim line per tool call, so you can watch the loop. It shows the customer's email and card
// digits, which is fine in your own terminal (redacting them in logs is a later step).
function showToolCall({ name, input, isError, text, agent }) {
  let outcome = isError ? 'error' : 'ok';
  try {
    const { error } = JSON.parse(text);
    if (error) outcome = `error: ${error}`;
  } catch {
    // not JSON, e.g. an input validation message from the MCP SDK
  }
  endLine();
  startBlock();
  // A specialist's own tool calls (multi-agent) are indented under it.
  const prefix = agent ? `    ↳ ${agent}: ` : '  ↳ ';
  console.log(dim(`${prefix}${name} ${JSON.stringify(input)} → ${outcome}`));
  shown = false; // that call's output is kept; a later discard only concerns the next call
}

// Multi-agent only: a specialist starting (its own tool calls follow, indented). Its finish shows
// up as the orchestrator's tool call line.
function showAgent({ agent, phase }) {
  if (phase !== 'start') return;
  endLine();
  startBlock();
  console.log(dim(`  ↳ ${agent} working…`));
}

// Agent SDK only: what the Claude Code process says the agent really has, from its system/init
// message at the start of each conversation. It should be the customer tools and nothing else.
function showInit({ tools, mcpServers }) {
  endLine();
  startBlock();
  const servers = mcpServers.map((s) => `${s.name} (${s.status})`).join(', ');
  console.log(dim(`  ↳ agent SDK session · ${tools.length} tools: ${tools.join(', ')} · MCP: ${servers}`));
}

// The structured decision extracted after the reply (step 14): a forced second API call, so it
// gets its own dim line rather than looking like part of the conversation.
function showDecision({ decision, amount, reason, needs_human }) {
  const amountPart = amount ? ` ${formatInr(amount)}` : '';
  console.log(dim(`  ↳ decision: ${decision}${amountPart} · needs_human: ${needs_human} · ${reason}`));
}

// Step 19: logs the decision to the audit log directly - bypassing the LLM entirely, since
// whether this gets logged must not be something the model decides. A logging failure must
// never break the turn, so this only reports it quietly rather than throwing.
async function logDecision(decision) {
  try {
    const { isError, text } = await mcp.callTool('log_decision', decision);
    if (isError) console.log(dim(`  ↳ (decision logging failed: ${text})`));
  } catch (err) {
    console.log(dim(`  ↳ (decision logging failed: ${err.message})`));
  }
}

// Lists the tools and what their definitions would add to each request, using the token counting
// endpoint (free, but a real API call). The gateway might not support it.
async function showTools() {
  for (const t of agentTools) console.log(`  ${t.name}: ${t.description}`);
  try {
    const messages = [{ role: 'user', content: 'Hi' }];
    const [without, withTools] = await Promise.all([
      client.messages.countTokens({ model, system, messages }),
      client.messages.countTokens({ model, system, messages, tools: agentTools }),
    ]);
    console.log(dim(`  (tool definitions: about ${withTools.input_tokens - without.input_tokens} input tokens per request)\n`));
  } catch (err) {
    console.log(dim(`  (token count unavailable: ${describeError(err)})\n`));
  }
}

// Most specific first: APIConnectionError and the status errors all extend APIError.
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Authentication failed: check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited: wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ''}: ${err.message}`;
  return `Unexpected error: ${err.message}`;
}
