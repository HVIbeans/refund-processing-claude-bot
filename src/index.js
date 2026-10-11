// npm start: the web chat at / (step 32) and the prompt-coach viewer.
// The chat runs the hand-written agent loop (chat.js): the production shape, with tools run in order
// and defined recovery from failed turns. ANTHROPIC_LOOP only applies to the terminal chat.
import { startServer } from './server.js';
import { createChat } from './agent/chat.js';
import { SetupError, setupAgent } from './agent/setup.js';
import { buildSystemPrompt } from './agent/systemPrompt.js';
import { POLICY } from './policy.js';

let agent;
try {
  agent = await setupAgent();
} catch (err) {
  // The prompt-coach viewer still works without the agent; the chat answers 503.
  console.error(err instanceof SetupError ? `Chat disabled: ${err.message}` : err);
}

// One MCP connection serves every conversation: the tools keep no state, and every call
// re-verifies the customer's identity.
const createConversation = agent && (({ onText, onDiscard, onWorking }) => {
  const chat = createChat({
    client: agent.client,
    model: agent.model,
    system: buildSystemPrompt(POLICY, { toolInstructions: agent.mcp.instructions }),
    thinking: agent.support.adaptiveThinking,
    effort: agent.effort,
    decide: true, // logged to the audit log below, never shown to the customer
    cache: true,
    tools: agent.agentTools,
    callTool: agent.mcp.callTool,
    onText,
    onDiscard,
    onToolCall: ({ name, isError }) => {
      onWorking();
      if (isError) console.error(`[chat] tool ${name} returned an error`);
    },
  });
  return {
    async send(message) {
      const reply = await chat.send(message);
      if (reply.decision) {
        const failure = await agent.logDecision(reply.decision);
        if (failure) console.error(`[chat] decision logging failed: ${failure}`);
      }
      return reply;
    },
  };
});

const server = await startServer({ createConversation });
const { address, port } = server.address();
console.log(`Refund chat running at http://${address}:${port}${agent ? '' : ' (chat disabled, see above)'}`);
console.log(`Prompt coach feedback:  http://${address}:${port}/prompt-feedback`);

// Ctrl+C: stop the MCP server child process too.
process.on('SIGINT', async () => {
  server.close();
  await agent?.close();
  process.exit(0);
});
