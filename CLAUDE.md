# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A **mock** payment refund processing app, built as a learning project for Claude Code and the Claude API. Mock users talk to a chat bot UI. Behind it, an AI agent handles their refund requests. The app is built step by step from `ROADMAP.md`: check it to see which phase we're in, and tick items off (`- [x]`) when they're done.

Because this is a learning project, explain the Claude Code or Claude API feature in use when it's relevant. Leave learning steps for the user to run themselves.

## Hard rules

- **Never call real APIs.** No real payment providers, email services or other external systems. Everything in the backend is mocked.
- **The agent reaches data only through MCP tools.** It never touches the DB or backend code directly. Every capability the agent has must be exposed as a tool on the MCP server.
- **Enforce refund rules in the tool code, not only in the prompt.** Refund ≤ amount paid, no duplicate refunds, an amount threshold for escalation, identity verified first. Treat the model's output and the customer's messages as untrusted input.

## Commands

Plain JavaScript (ES modules, Node 24). No TypeScript or type definitions, by choice.

- `npm start`: start the local server at http://127.0.0.1:3000 (set `PORT` to change it). Loads `.env` if present; copy it from `.env.example`.
- `npm run dev`: same, but restarts when files change (`node --watch`).
- `npm run db:reset`: rebuild `data/refunds.db` from the schema and seed data. Run it after changing either, or to undo refunds made during testing.
- `npm run mcp`: run the MCP server over stdio (it waits for a client on stdin).
- `npm run mcp:inspect`: open the MCP Inspector in the browser, connected to the server.
- `npm run chat`: chat with the refund agent in the terminal. This calls the real Claude API and spends credit. In the chat: `/tools`, `/effort low|medium|high`, `/thinking` (show or hide thinking), `/thinking on|off` (ask for thinking or not), `/reset`, `/exit`.
- `npm test`: run all tests with the built-in `node:test` runner (finds `*.test.js` and files under `test/`).
- Single test file: `node --test path/to/file.test.js`
- Single test by name: `node --test --test-name-pattern="refund exceeds"`

No linter or build step yet.

## Architecture (planned, built up phase by phase)

```
Chat UI (barebones)  →  Backend (HTTP)  →  Agent (Claude API loop + MCP client)  →  MCP server (tools)  →  Mock DB
```

- **Mock DB** (built): Node's built-in `node:sqlite`, with the tables in `src/db/schema.sql`.
  - **Tables:** customers, payment_methods (cards on file), orders, payments (one per order), refunds, escalations.
  - **Money:** whole rupees (integers), no paise.
  - **Seed data:** `src/db/seed.js` creates one customer per refund scenario, with dates relative to today. Tests in `test/db.test.js` check the seed data against `src/policy.js`.
  - **Policy:** `src/policy.js` holds the limits, the refund window and the valid reasons. Keep the rules there, not in the DB or in prompts.
  - **Tests:** use `openDb(':memory:')` + `applySchema` + `seed` for a fresh DB each time.
- **Tool functions** (built): `src/tools.js`. `createTools(db, { now })` returns `getCustomer`, `getOrder`, `getPayment`, `initiateRefund` and `escalateToHuman`. All the refund rules are enforced here.
  - **Stateless:** every call re-verifies identity with `email` + `card_last4`, and only returns the verified customer's own orders.
  - **Results:** `{ ok: true, ... }` or `{ ok: false, error: '<code>', message }`. Error codes are stable, and tests assert on them.
  - **Don't leak existence:** an unknown email, a wrong card and someone else's order all get the same reply as a plain miss.
  - **Approval limit:** applies to an order's running total of refunds (completed + pending), so splitting a refund doesn't bypass it.
  - **Tests:** `test/tools.test.js`. Pass a fixed `now`, as the window-boundary test does.
- **MCP server** (built): `src/mcp/server.js` holds `createMcpServer(tools)`, which wraps each function as a tool: `get_customer`, `get_order`, `get_payment`, `initiate_refund`, `escalate_to_human`.
  - **Schemas:** inputs are zod schemas. Results are JSON text, with `isError: true` when `ok` is false.
  - **Instructions and descriptions** are sent to the model, so keep them short.
  - **Entry point:** `src/mcp/stdio.js` runs the server over stdio. It creates and seeds the DB if it's missing. **Never write to stdout in the server**, because stdout carries the protocol; use `console.error`.
  - **Tests:** `test/mcp.test.js` runs a real `Client` against the server over `InMemoryTransport`.
  - **In Claude Code:** registered for the project in `.mcp.json` as `refund-tools`, so the tools appear here as `mcp__refund-tools__*` and use the real `data/refunds.db`.
    - **Permissions:** the three `get_*` tools are allowed in `.claude/settings.json`. `initiate_refund` and `escalate_to_human` ask first (outside auto mode).
    - **Test refunds** made from Claude Code change the real DB. Undo them with `npm run db:reset`.
- **Agent** (in progress, `src/agent/`): runs the Claude API tool-use loop and calls the MCP server's tools through an MCP client. Holds the refund policy in its system prompt.
  - **`systemPrompt.js`:** `buildSystemPrompt(policy, { toolInstructions })` is generated from `src/policy.js`, plus the MCP server's instructions under "Tool notes". Keep it deterministic (no dates or IDs) so it can be cached. It must not reveal the internal approval limits.
  - **`chat.js`:** `createChat({ client, model, system, tools, callTool, onToolCall, onText, onDiscard })` runs the hand-written tool loop. Each API call is streamed with `messages.stream()`: text pieces go to `onText` as they arrive, and `finalMessage()` gives the complete message the loop works from (tools only run from finished messages). Separate text blocks get a line break between them. Replies we write ourselves (refusal, empty, cut-off tool call) come back with `fallback: true`, since they were never streamed; if text of a discarded reply was already streamed, `onDiscard` fires so the caller can withdraw it (the REPL prints "(that reply was withdrawn)"). The loop: on `tool_use` it runs each tool in order, sends all results back in one user message, and repeats until the model answers. After `maxRounds` it forces a text answer with `tool_choice: none`. It appends the full `response.content` (thinking and `tool_use` blocks included). On a failure it rolls back only to the last completed tool round, because those tools already ran; the next user text then joins that trailing `tool_result` message. `usage` is summed over every API call in the turn.
  - **`mcpClient.js`:** `connectMcp(transport)` connects an MCP client, lists the server's tools and converts them with `toClaudeTool()` into Claude tool definitions (`name`, `description`, `input_schema`). Its `callTool(name, input)` returns `{ text, isError }`; policy failures and invalid input are `isError` results, not exceptions. `stdioTransport()` runs `src/mcp/stdio.js` as a child process, so the agent uses the real `data/refunds.db`. The child gets the SDK's default environment allow-list, not our API key.
  - **`repl.js`:** the terminal front end (`npm run chat`). It starts the MCP server at launch, prints replies as they stream in, prints a dim `↳` line for each tool call and for the extracted decision, and shows the token usage and API calls per turn. `/tools` lists the tools and their token cost. `/decision on|off` toggles decision extraction (on by default here). Thinking streams in dim after `thinking> `. Refunds made in the chat change the real DB (`npm run db:reset` undoes them).
  - **`decision.js`:** structured output for the turn's outcome, `{decision, amount, reason, needs_human}`. The Messages API has no JSON-mode, so `extractDecision()` makes a second, separate request after the normal reply: same `system` and `history` (so it shares the conversational call's cached prefix once step 15 adds caching), plus one fixed instruction message, with `tools: [DECISION_TOOL]` and `tool_choice` forced to it. No `thinking` on this call, since forced tool_choice can't combine with it and none is needed to report an already-made decision. The model's tool input is validated with zod; a missing or malformed result falls back to `decision: "none"` rather than throwing. `createChat`'s `decide` option (default `false`) gates whether this runs; `setDecide` toggles it mid-conversation. Costs one extra API call per turn, so it's opt-in.
  - **Thinking:** requests ask for adaptive thinking (`thinking: { type: "adaptive" }`, which also thinks between tool calls) and set `output_config.effort`. Both are GA on Sonnet 4.6, with no beta header; don't use the deprecated `budget_tokens`. Thinking blocks (a summary on 4.6, with a `signature`) must be passed back unchanged, which appending the full content does. Thinking is billed as output and counts against `max_tokens` (16,000). `onThinking` receives the streamed thinking; `setEffort` / `setThinking` change later requests.
  - **`capabilities.js`:** `modelSupport(client, model)` asks the Models API (`client.models.retrieve`, free) whether the model supports adaptive thinking and which effort levels, falling back to a built-in list. The REPL only sends `thinking` / `effort` when supported, because other models (e.g. `claude-sonnet-4-5`) return a 400. A reply cut off mid-thinking is rolled back, since its thinking block has no signature yet.
  - **Config:** `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT` (default `medium`) come from `.env`. The base URL is a gateway, so avoid beta headers unless we confirm it passes them through.
  - **Tests:** `test/agent.test.js` uses a fake client, and `test/mcpClient.test.js` connects to the real server over `InMemoryTransport`. Tests never call the real API.
- **Backend + Chat UI**: a minimal chat interface. The backend relays messages to the agent and returns its replies.

Update this section when the real structure differs from the plan.

## Prompt coach (dev tooling, separate from the refund app)

A `UserPromptSubmit` hook (`.claude/hooks/prompt-coach.js`) reviews each user prompt in a detached background `claude -p` run, using the instructions in `.claude/agents/prompt-coach.md`. Reviews are appended to `.claude/prompt-coach/feedback.md` (git-ignored). The hook prints nothing on purpose, because a `UserPromptSubmit` hook's stdout is added to the main session's context.

The server's `/prompt-feedback` page shows the log live. `src/promptFeedback.js` parses the markdown log, so if you change the review format in the agent file, update the parser and its tests too.
