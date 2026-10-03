// npm run chat: talk to the refund agent in the terminal.
// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment (.env).
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, createChat } from './chat.js';
import { connectMcp, stdioTransport } from './mcpClient.js';
import { buildSystemPrompt } from './systemPrompt.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
const client = new Anthropic();
const system = buildSystemPrompt();
const chat = createChat({ client, model, system });
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Start the MCP server as a child process and list its tools. They aren't sent to the API until
// step 11, when the agent loop can run them.
let mcp;
try {
  mcp = await connectMcp(stdioTransport());
} catch (err) {
  console.error(`Could not start the refund-tools MCP server: ${err.message}`);
  process.exit(1);
}

console.log(`Refund agent · model ${model} · endpoint ${new URL(client.baseURL).host}`);
console.log(`Connected to ${mcp.server.name} v${mcp.server.version} · ${mcp.tools.length} tools`);
console.log(dim("Type a message. /tools lists the agent's tools, /reset starts over, /exit quits.\n"));

const rl = readline.createInterface({ input, output, prompt: 'you> ' });
let closed = false;
rl.on('close', () => { closed = true; });
rl.prompt();

// Lines are read one at a time; the next prompt appears only after the reply. Ctrl+D ends input.
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/exit') break;
  if (line === '/tools') {
    await showTools();
  } else if (line === '/reset') {
    chat.reset();
    console.log(dim('(conversation cleared)\n'));
  } else if (line) {
    try {
      const { text, stopReason, usage } = await chat.send(line);
      console.log(`\nagent> ${text}`);
      console.log(dim(`[${usage.input_tokens} in / ${usage.output_tokens} out · ${stopReason}]\n`));
    } catch (err) {
      console.error(`\n${describeError(err)}\n`);
    }
  }
  if (!closed) rl.prompt(); // input may have ended (Ctrl+D or piped input)
}
rl.close();
await mcp.close(); // ends the server process

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
