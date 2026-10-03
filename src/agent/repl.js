// npm run chat: talk to the refund agent in the terminal.
// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment (.env).
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, createChat } from './chat.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
const client = new Anthropic();
const chat = createChat({ client, model });
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log(`Refund agent · model ${model} · endpoint ${new URL(client.baseURL).host}`);
console.log(dim('Type a message. /reset starts over, /exit quits.\n'));

const rl = readline.createInterface({ input, output, prompt: 'you> ' });
let closed = false;
rl.on('close', () => { closed = true; });
rl.prompt();

// Lines are read one at a time; the next prompt appears only after the reply. Ctrl+D ends input.
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/exit') break;
  if (line === '/reset') {
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

// Most specific first: APIConnectionError and the status errors all extend APIError.
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Authentication failed: check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited: wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ''}: ${err.message}`;
  return `Unexpected error: ${err.message}`;
}
