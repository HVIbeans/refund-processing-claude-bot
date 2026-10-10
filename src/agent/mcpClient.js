// The agent's MCP client: connects to the refund-tools server, lists its tools and converts them
// into Claude tool definitions. The agent reaches data only through these tools.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pkg from '../../package.json' with { type: 'json' };

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

// An MCP tool has name, title, description, inputSchema (JSON Schema), annotations and execution.
// A Claude tool definition only has name, description and input_schema. The annotations
// (e.g. destructiveHint) are for our own code to act on, not for the API.
export function toClaudeTool({ name, title, description, inputSchema }) {
  const { $schema, ...input_schema } = inputSchema; // the draft-07 marker zod adds isn't needed
  return { name, description: description ?? title ?? '', input_schema };
}

// Our server only returns text content (JSON). Anything else is noted rather than dropped silently.
const resultText = ({ content = [] }) =>
  content.map((b) => (b.type === 'text' ? b.text : `[unsupported ${b.type} content]`)).join('\n') || '(no output)';

// Runs the server as a child process over stdio, the same command as .mcp.json, so it uses the
// real data/refunds.db. With no `env` given, the SDK passes only a short allow-list of variables
// (PATH, HOME and the like) to the child, so ANTHROPIC_API_KEY never reaches the server.
export function stdioTransport() {
  return new StdioClientTransport({
    command: process.execPath,
    // No --reviewer: the agent's server has only the customer tools and log_decision.
    args: ['--disable-warning=ExperimentalWarning', 'src/mcp/stdio.js'], // node:sqlite's warning
    cwd: projectRoot,
    stderr: 'inherit', // the server logs to stderr; show it in the terminal
  });
}

// Connects one Client to one transport and tracks whether it's still alive, via the SDK's
// own onclose/onerror hooks (confirmed: onclose fires synchronously when the other side
// closes, and a call afterward throws "Not connected" rather than hanging).
async function connectOnce(transport) {
  const client = new Client({ name: 'refund-agent', version: pkg.version });
  let connected = true;
  client.onclose = () => { connected = false; };
  client.onerror = () => { connected = false; };
  await client.connect(transport);
  return { client, isConnected: () => connected };
}

// The transport is a parameter so tests can pass an in-memory pair instead of a subprocess.
// `reconnect`, if given, is a factory (e.g. stdioTransport itself) called again to build a
// fresh transport if the connection is later found dead - e.g. the server process crashed.
// Not used for the *initial* connect, which still fails immediately on startup as before.
export async function connectMcp(transport, { reconnect } = {}) {
  let { client, isConnected } = await connectOnce(transport);
  let mcpTools;
  try {
    ({ tools: mcpTools } = await client.listTools());
  } catch (err) {
    await client.close();
    throw err;
  }
  const server = client.getServerVersion();
  const instructions = client.getInstructions();

  async function reestablish() {
    if (!reconnect) {
      throw new Error('The refund-tools MCP connection was lost and no reconnect transport is configured.');
    }
    ({ client, isConnected } = await connectOnce(await reconnect()));
  }

  async function attemptCall(name, input) {
    const result = await client.callTool({ name, arguments: input });
    return { text: resultText(result), isError: Boolean(result.isError) };
  }

  // Runs a tool for the agent loop. Policy failures and invalid input come back as isError
  // results (not exceptions); only a protocol or connection failure throws. A thrown error
  // only triggers a reconnect-and-retry when the connection is actually the problem (isError
  // results never reach the catch block at all, since they resolve normally).
  async function callTool(name, input) {
    if (!isConnected()) await reestablish();
    try {
      return await attemptCall(name, input);
    } catch (err) {
      if (isConnected() || !reconnect) throw err;
      await reestablish();
      return await attemptCall(name, input);
    }
  }

  return {
    get client() { return client; }, // a getter, not a snapshot: reestablish() reassigns client
    server,
    instructions,
    mcpTools,
    tools: mcpTools.map(toClaudeTool),
    callTool,
    close: () => client.close(),
  };
}
