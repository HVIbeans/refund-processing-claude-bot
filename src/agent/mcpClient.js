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

// Runs the server as a child process over stdio, the same command as .mcp.json, so it uses the
// real data/refunds.db. With no `env` given, the SDK passes only a short allow-list of variables
// (PATH, HOME and the like) to the child, so ANTHROPIC_API_KEY never reaches the server.
export function stdioTransport() {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', 'src/mcp/stdio.js'], // node:sqlite's warning
    cwd: projectRoot,
    stderr: 'inherit', // the server logs to stderr; show it in the terminal
  });
}

// The transport is a parameter so tests can pass an in-memory pair instead of a subprocess.
export async function connectMcp(transport) {
  const client = new Client({ name: 'refund-agent', version: pkg.version });
  await client.connect(transport);
  try {
    const { tools: mcpTools } = await client.listTools();
    return {
      client,
      server: client.getServerVersion(),
      instructions: client.getInstructions(),
      mcpTools,
      tools: mcpTools.map(toClaudeTool),
      close: () => client.close(),
    };
  } catch (err) {
    await client.close();
    throw err;
  }
}
