# Refund processing agent

A **mock** payment-refund chat bot, built as a learning project for Claude Code and the Claude API. Customers chat with an AI agent that looks up their orders and issues refunds, escalating to a human when the policy requires. Everything behind the agent is mocked: no real payments, emails or external systems.

```
Chat UI  →  HTTP backend  →  Agent (Claude API loop + MCP client)  →  MCP server (tools)  →  SQLite
```

- The agent reaches data **only through MCP tools**. It never touches the database directly.
- **Refund rules are enforced in the tool code**, not just the prompt: identity check first, refund ≤ amount paid, no duplicates, an approval limit, and fraud signals.
- Large refunds wait for a **human reviewer**, using tools the agent itself doesn't have.

## Quick start

Requires Node 22.13+ (developed on Node 24).

```sh
npm install
cp .env.example .env    # then set ANTHROPIC_API_KEY
npm run chat            # chat with the agent in the terminal
```

**The terminal chat is the standard way to use this bot.** It's the only place you get the full range of settings:
- **Choose the agent loop** with `ANTHROPIC_LOOP`.
- **See what the agent does:** each tool call it makes, the decision it reached, its thinking, and the tokens and API calls for each turn.
- **Change settings mid-conversation** with these commands:
  - `/effort low|medium|high`
  - `/thinking` shows or hides the thinking; `/thinking on|off` asks for it or not
  - `/decision on|off`
  - `/cache on|off`
  - `/tools`, `/reset`, `/exit`

The web chat (`npm start`, http://127.0.0.1:3000) is what a customer would see. It shows only the replies, with the default `manual` loop and settings.

Both chats call the real Claude API and spend credit. Refunds you make change `data/refunds.db`; undo them with `npm run db:reset`.

## Try it

Each seed customer in `src/db/seed.js` exists to exercise one case. To prove who they are, a customer gives their email and the last 4 digits of a card on file. Some messages to paste in:

| Message | What should happen |
|---|---|
| Hi, I'm priya.shah@example.com, card ending 4242. My wireless earbuds (ORD-5001) arrived damaged. Please refund the full amount. | Refunded straight away |
| priya.shah@example.com, card 4242. The smartwatch from ORD-5002 has a cracked screen. I'd like a full refund. | Above the approval limit, so it waits for a human |
| priya.shah@example.com, card 4242. The phone case in ORD-5003 is damaged, can I get my money back? | Declined: outside the 30-day window |
| I want a refund for my espresso machine. | The agent asks for details first. Then reply: *arjun.mehta@example.com, card 5454, order ORD-5004, it's damaged.* VIP, so refunded within the higher limit |
| neha.kapoor@example.com, card 1881. Please refund my yoga mat, ORD-5007. | Declined: already fully refunded |
| vikram.rao@example.com, card 6521. Refund my backpack, ORD-5010. | Declined: not delivered yet |
| kabir.malhotra@example.com, card 8080. The headphones from ORD-5018 aren't as described. Full refund please. | Escalated: too many recent refunds |
| priya.shah@example.com, card 1111. Refund ORD-5001 please. | Not verified: no order details are shared, and the account is escalated to a human |

Run `npm run db:reset` between tries so each one starts from the same data.

## Commands

| Command | What it does |
|---|---|
| `npm run chat` | **Standard:** chat in the terminal, with every setting and the tool calls and token usage shown |
| `npm start` / `npm run dev` | Customer-facing web chat (`dev` restarts on file changes) |
| `npm test` | Run the tests (no API calls) |
| `npm run db:reset` | Rebuild the mock database from the schema and seed data |
| `npm run mcp:inspect` | Explore the MCP tools in the MCP Inspector |
| `npm run bench` | Compare the agent loops on scripted conversations (prints a plan; add `--yes` to run) |

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the chat |
| `ANTHROPIC_BASE_URL` | Anthropic API | Optional gateway in front of the Claude API |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model to use |
| `ANTHROPIC_EFFORT` | `medium` | Thinking effort: `low`, `medium` or `high` |
| `ANTHROPIC_LOOP` | `manual` | Terminal chat only: `manual`, `runner`, `sdk` or `multi` |

## Agent loops

The terminal chat can run four interchangeable designs, chosen with `ANTHROPIC_LOOP`. The web chat always uses `manual`.

- **`manual`**: a hand-written tool loop with streaming, caching and failure recovery (`src/agent/chat.js`).
- **`runner`**: the SDK's Tool Runner.
- **`sdk`**: the Claude Agent SDK.
- **`multi`**: an orchestrator plus triage, fraud-check and refund specialist agents.

The benchmark (ROADMAP step 41) found all of them made the correct decision in every test case. The hand-written loop was the fastest, at about the cost of the Agent SDK. Multi-agent cost 2.7× as much and was 3.7× slower.

## More

- [`ROADMAP.md`](ROADMAP.md): the step-by-step plan and its progress.
- [`CLAUDE.md`](CLAUDE.md): detailed architecture and conventions.
