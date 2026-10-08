# Refund Processing Agent — Learning Roadmap

Goal: build a payment refund processing agent (customer lookup, order/payment lookup, refunds, human escalation) while getting hands-on exposure to as many Claude Code and Claude API features as possible.

Tick items off as you go (`- [x]`).

## Phase 0 — Project setup with Claude Code
- [x] 1. Pick a language and scaffold the project — **plain JavaScript (ES modules, Node 24)**, no TypeScript; built-in `node:test` for tests
- [x] 2. Run `/init` to generate `CLAUDE.md`; add goals, conventions, and "never call real payment APIs"
- [x] 3. Initialize git; commit often and practise `/code-review` on diffs
- [x] 3a. (Bonus) Prompt-coach subagent + `UserPromptSubmit` hook, with a live viewer at `/prompt-feedback`
- [x] 4. Configure permissions in `.claude/settings.json` (e.g. allow test commands)

## Phase 1 — Mock backend + MCP server
- [x] 5. Mock data layer (SQLite/JSON): customers, orders, payments, refunds — seed edge cases (partial refunds, already-refunded, outside refund window, high-value, flagged accounts)
- [x] 6. Plain functions + unit tests: `get_customer`, `get_order`, `get_payment`, `initiate_refund`, `escalate_to_human`
- [x] 7. Expose those functions as tools on a local **MCP server** (stdio, `@modelcontextprotocol/sdk`); poke at it with the MCP Inspector
- [x] 8. Connect the server to Claude Code with `claude mcp add` and query the mock data from the CLI

## Phase 2 — Claude API agent (hand-built, tools via MCP)
- [x] 9. Basic Messages API call with a system prompt containing the refund policy
- [x] 10. **MCP client** in the agent: connect to the server, list its tools, convert them to Claude tool definitions
- [x] 11. Write the agent loop yourself (`tool_use` → call the MCP tool → `tool_result` → repeat until `end_turn`)
- [x] 12. Streaming responses
- [x] 13. Extended thinking for policy edge cases
- [x] 14. Structured outputs for the final decision (`{decision, amount, reason, needs_human}`)
- [x] 15. Prompt caching on system prompt / policy / tools; measure savings via `usage` and token counting
- [x] 16. Replace the manual loop with the SDK's Tool Runner and compare

## Phase 3 — Production-shaped
- [x] 17. Human-in-the-loop approval above an amount threshold
- [x] 18. Code-enforced guardrails in the MCP tools: refund ≤ amount paid, no duplicates, idempotency keys
- [x] 19. Audit log of every tool call and decision
- [ ] 20. Error handling: tool failures, MCP server disconnects, API retries, rate limits

## Phase 4 — Claude Code power features
- [ ] 21. **Hooks** (e.g. `PreToolUse` protecting the policy file, `PostToolUse` running tests)
- [ ] 22. Custom **subagents** in `.claude/agents/` (policy-reviewer, test-writer)
- [ ] 23. **Skills / slash commands** (e.g. `/new-test-scenario`)
- [ ] 24. Run `/security-review` on the refund code

## Phase 5 — Agent SDK & multi-agent
- [ ] 25. Rebuild on the **Claude Agent SDK** (it can use the same MCP server)
- [ ] 26. Multi-agent: triage → refund specialist → fraud checker, with an orchestrator
- [ ] 27. (Optional) Try Managed Agents and compare to self-hosting

## Phase 6 — Evaluation (start around step 17)
- [ ] 28. Eval set of 30–50 scenarios with expected outcomes (approve / deny / partial / escalate)
- [ ] 29. LLM-as-judge for tone and policy compliance
- [ ] 30. Run evals via the **Batch API**
- [ ] 31. Compare models (Haiku vs Sonnet vs Opus) on accuracy, latency, cost

## Phase 7 — Interface & extras
- [ ] 32. Barebones chat UI: a small Node HTTP backend + a static HTML chat page
- [ ] 33. **Files API / vision**: receipt or damaged-item photo verification
- [ ] 34. **Citations**: quote the exact policy clause behind each decision

## Domain features to include
- [ ] Identity verification before revealing data or taking action
- [ ] Refund policy engine: time windows, non-refundable items, partial refunds, restocking fees, refund to original payment method
- [ ] Amount-based approval tiers (auto-approve < $X, escalate > $Y)
- [ ] Fraud signals: refund frequency, new account + high value, existing chargebacks
- [ ] Idempotency / duplicate-refund protection
- [ ] Prompt-injection defense (customer messages are untrusted input)
- [ ] PII redaction in logs
- [ ] Multi-currency and tax handling
- [ ] Customer notifications (mock email tool)
- [ ] Escalation with a context summary for the human
- [ ] Conversation memory for returning customers
