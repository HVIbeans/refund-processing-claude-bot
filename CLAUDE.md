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

- `npm start`: run `src/index.js`. Loads `.env` if present; copy it from `.env.example`.
- `npm run dev`: same, but restarts when files change (`node --watch`).
- `npm test`: run all tests with the built-in `node:test` runner (finds `*.test.js` and files under `test/`).
- Single test file: `node --test path/to/file.test.js`
- Single test by name: `node --test --test-name-pattern="refund exceeds"`

No linter or build step yet.

## Architecture (planned, built up phase by phase)

```
Chat UI (barebones)  →  Backend (HTTP)  →  Agent (Claude API loop + MCP client)  →  MCP server (tools)  →  Mock DB
```

- **Mock DB**: customers, orders, payments, refunds. Seeded with edge cases (partial or already-refunded orders, orders outside the refund window, high-value orders, flagged accounts).
- **MCP server**: exposes the agent's abilities as tools:
  1. Look up users to establish identity and their valid orders
  2. Look up orders for payment details
  3. Process refunds for valid reasons
  4. Escalate to a human: for user-management requests and refunds above the value threshold
- **Agent**: runs the Claude API tool-use loop and calls the MCP server's tools through an MCP client. Holds the refund policy in its system prompt.
- **Backend + Chat UI**: a minimal chat interface. The backend relays messages to the agent and returns its replies.

Update this section when the real structure differs from the plan.
