// npm run chat: talk to the refund agent in the terminal.
// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment (.env).
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, createChat } from './chat.js';
import { connectMcp, stdioTransport } from './mcpClient.js';
import { modelSupport } from './capabilities.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { POLICY } from '../policy.js';

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
let mcp;
try {
  mcp = await connectMcp(stdioTransport());
} catch (err) {
  console.error(`Could not start the refund-tools MCP server: ${err.message}`);
  process.exit(1);
}

// Only ask for thinking and effort if the model accepts them; otherwise every request would 400.
const support = await modelSupport(client, model);
const supportsEffort = (level) => support.effortLevels.includes(level);

// Only controls what's printed: hidden thinking is still generated, kept in the history and billed.
let showThinking = true;

// The server's instructions go into the system prompt, as MCP clients usually do.
const system = buildSystemPrompt(POLICY, { toolInstructions: mcp.instructions });
const chat = createChat({
  client, model, system,
  thinking: support.adaptiveThinking,
  effort: supportsEffort(effort) ? effort : undefined,
  tools: mcp.tools, callTool: mcp.callTool,
  onText: (text) => emit('agent', text),
  onThinking: (text) => {
    if (showThinking) emit('thinking', text);
  },
  onToolCall: showToolCall, onDiscard: withdraw,
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

console.log(`Refund agent · model ${model} · endpoint ${new URL(client.baseURL).host}`);
console.log(`Connected to ${mcp.server.name} v${mcp.server.version} · ${mcp.tools.length} tools`);
console.log(`Thinking: ${thinkingLabel()} · effort: ${effortLabel()} ${dim(`(capabilities from the ${support.source})`)}`);
console.log(dim('Tools are live: refunds change data/refunds.db (npm run db:reset undoes them).'));
console.log(dim('Commands: /tools, /effort [low|medium|high], /thinking (show/hide), /thinking on|off, /reset, /exit.\n'));

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
  } else if (line === '/reset') {
    chat.reset();
    console.log(dim('(conversation cleared)\n'));
  } else if (line) {
    current = null;
    turnStart = true;
    shown = false;
    try {
      const { text, fallback, stopReason, usage, rounds } = await chat.send(line);
      if (fallback) {
        // Our own reply (refusal, empty or cut-off tool call): it wasn't streamed.
        endLine();
        emit('agent', text);
      }
      endLine();
      if (stopReason === 'max_tokens' && !fallback) console.log(dim('(The reply was cut off.)'));
      const calls = rounds + 1;
      // Output tokens include the thinking, so they rise with effort.
      console.log(dim(`[${n(usage.input_tokens)} in / ${n(usage.output_tokens)} out · ${calls} API call${calls > 1 ? 's' : ''} · ${stopReason}]\n`));
    } catch (err) {
      endLine(); // the error may arrive mid-reply
      console.error(`\n${describeError(err)}\n`);
    }
  }
  if (!closed) rl.prompt(); // input may have ended (Ctrl+D or piped input)
}
rl.close();
await mcp.close(); // ends the server process

function n(x = 0) {
  return x.toLocaleString('en-IN');
}

// One dim line per tool call, so you can watch the loop. It shows the customer's email and card
// digits, which is fine in your own terminal (redacting them in logs is a later step).
function showToolCall({ name, input, isError, text }) {
  let outcome = isError ? 'error' : 'ok';
  try {
    const { error } = JSON.parse(text);
    if (error) outcome = `error: ${error}`;
  } catch {
    // not JSON, e.g. an input validation message from the MCP SDK
  }
  endLine();
  startBlock();
  console.log(dim(`  ↳ ${name} ${JSON.stringify(input)} → ${outcome}`));
  shown = false; // that call's output is kept; a later discard only concerns the next call
}

// Lists the tools and what their definitions would add to each request, using the token counting
// endpoint (free, but a real API call). The gateway might not support it.
async function showTools() {
  for (const t of mcp.tools) console.log(`  ${t.name}: ${t.description}`);
  try {
    const messages = [{ role: 'user', content: 'Hi' }];
    const [without, withTools] = await Promise.all([
      client.messages.countTokens({ model, system, messages }),
      client.messages.countTokens({ model, system, messages, tools: mcp.tools }),
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
