// Everything a front end needs before it can run the agent: the Claude client, the model's
// capabilities, the MCP connection and the agent's tools. Shared by the terminal chat (repl.js)
// and the web chat (src/index.js), so both behave the same way.
// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment (.env).
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL } from './chat.js';
import { connectMcp, stdioTransport } from './mcpClient.js';
import { modelSupport } from './capabilities.js';

export const EFFORTS = ['low', 'medium', 'high'];

// log_decision is harness-only: front ends call it directly after a turn, never the model
// (whether a decision gets logged isn't the model's call). The reviewer tools aren't on the
// agent's server at all: stdioTransport() starts it without --reviewer.
export const NOT_FOR_AGENT_TOOLS = new Set(['log_decision']);

// A configuration problem, with a message meant for the person starting the app.
export class SetupError extends Error {}

export async function setupAgent({ env = process.env } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new SetupError('ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).');
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const effort = env.ANTHROPIC_EFFORT || 'medium';
  if (!EFFORTS.includes(effort)) {
    throw new SetupError(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')} (got "${effort}").`);
  }
  const client = new Anthropic();

  // Start the MCP server as a child process and list its tools. The agent reaches data only through
  // them. If it dies mid-conversation, callTool respawns it and retries once (see mcpClient.js).
  let mcp;
  try {
    mcp = await connectMcp(stdioTransport(), { reconnect: stdioTransport });
  } catch (err) {
    throw new SetupError(`Could not start the refund-tools MCP server: ${err.message}`);
  }

  // Only ask for thinking and effort if the model accepts them; otherwise every request would 400.
  const support = await modelSupport(client, model);
  const supportsEffort = (level) => support.effortLevels.includes(level);

  // Logs a turn's decision to the audit log (step 19). Never throws: a logging failure must not
  // break the turn. Returns an error message, or null when it was logged.
  async function logDecision(decision) {
    try {
      const { isError, text } = await mcp.callTool('log_decision', decision);
      return isError ? text : null;
    } catch (err) {
      return err.message;
    }
  }

  return {
    client,
    model,
    effort: supportsEffort(effort) ? effort : undefined,
    support,
    supportsEffort,
    mcp,
    agentTools: mcp.tools.filter((t) => !NOT_FOR_AGENT_TOOLS.has(t.name)),
    logDecision,
    close: () => mcp.close(), // ends the server process
  };
}
