// npm run bench: compare token usage, latency and outcomes of the agent loops (manual, sdk, multi)
// on the same scripted customer conversations.
//
// This calls the real Claude API (through ANTHROPIC_BASE_URL) and spends credit. Without --yes it
// only prints the plan and exits. It resets the seed tables in data/refunds.db before every run
// (like npm run db:reset), so refunds from earlier runs or manual testing are wiped.
//
//   npm run bench                                   # dry run: show the plan
//   npm run bench -- --yes                          # all loops, all scenarios, 1 run each
//   npm run bench -- --yes --runs 3 --loops manual,multi --scenarios happy,over-limit
//   npm run bench -- --yes --prices <in>,<out>,<cacheWrite>,<cacheRead>   # $ per million tokens,
//                                                   # from the pricing page for your model
//
// Each turn is written as one JSON line ("type": "turn") to data/bench/<timestamp>.jsonl, plus one
// "type": "outcome" line per conversation; a summary per loop and scenario is printed at the end. Medians, not means: one slow retry shouldn't skew a small sample.
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createChat } from '../src/agent/chat.js';
import { createSdkChat } from '../src/agent/sdkChat.js';
import { createMultiAgentChat } from '../src/agent/multiAgent.js';
import { NOT_FOR_AGENT_TOOLS, SetupError, setupAgent } from '../src/agent/setup.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { POLICY } from '../src/policy.js';
import { defaultDbPath, openDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';

const LOOPS = { manual: createChat, sdk: createSdkChat, multi: createMultiAgentChat };

// Scripted customer turns. `expect` is the outcome the refund rules call for, judged from the real
// tool results (see outcomeOf), not from what the model says it did.
const SCENARIOS = {
  happy: {
    expect: 'refunded',
    turns: ["Hi, I'm priya.shah@example.com, card ending 4242. My wireless earbuds (ORD-5001) arrived damaged, the left one doesn't charge. Please refund the full amount."],
  },
  'over-limit': {
    expect: 'pending_approval',
    turns: ["Hello, priya.shah@example.com here, card 4242. The smartwatch from order ORD-5002 has a cracked screen out of the box. I'd like a full refund."],
  },
  'out-of-window': {
    expect: 'none',
    turns: ["Hi, this is priya.shah@example.com (card 4242). The phone case in ORD-5003 is damaged, can I get my money back?"],
  },
  'two-turn-vip': {
    expect: 'refunded',
    turns: [
      'Hi, my espresso machine stopped working after two days and I want a refund.',
      "Sure: arjun.mehta@example.com, card ending 5454, order ORD-5004. It's damaged, please refund the full amount.",
    ],
  },
  'fraud-signals': {
    expect: 'escalated',
    turns: ["Hey, kabir.malhotra@example.com, card 8080. The noise-cancelling headphones from ORD-5018 aren't as described, the ANC barely works. Full refund please."],
  },
};

const { values: args } = parseArgs({
  options: {
    loops: { type: 'string', default: Object.keys(LOOPS).join(',') },
    scenarios: { type: 'string', default: Object.keys(SCENARIOS).join(',') },
    runs: { type: 'string', default: '1' },
    prices: { type: 'string' }, // in,out,cacheWrite,cacheRead in $ per million tokens
    yes: { type: 'boolean', default: false },
  },
});

const loopNames = list(args.loops, LOOPS, 'loop');
const scenarioNames = list(args.scenarios, SCENARIOS, 'scenario');
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) fail(`--runs must be a whole number of at least 1 (got "${args.runs}").`);
const prices = args.prices ? parsePrices(args.prices) : null;

const totalTurns = loopNames.length * runs * scenarioNames.reduce((n, s) => n + SCENARIOS[s].turns.length, 0);
console.log(`Plan: loops ${loopNames.join(', ')} · scenarios ${scenarioNames.join(', ')} · ${runs} run(s) each`);
console.log(`      ${totalTurns} customer turns (multi made about 2.7× the API calls of manual in the first benchmark).`);
if (!args.yes) {
  console.log('Dry run: nothing was sent. Add --yes to run it (real API calls; resets data/refunds.db).');
  process.exit(0);
}

let agent;
try {
  agent = await setupAgent();
} catch (err) {
  fail(err instanceof SetupError ? err.message : `Could not start: ${err.message}`);
}
const { client, model, effort, support, mcp, agentTools } = agent;

const outDir = join(import.meta.dirname, '..', 'data', 'bench');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
console.log(`Model ${model} · effort ${effort ?? 'default'} · thinking ${support.adaptiveThinking ? 'adaptive' : 'off'} · cache on · decision extraction off`);
console.log(`Writing ${outFile}\n`);

const rows = [];
try {
  // Run-major order (all loops for run 1, then run 2, ...), so a slow patch on the gateway hits
  // every loop rather than one.
  for (let run = 1; run <= runs; run++) {
    for (const scenario of scenarioNames) {
      for (const loop of loopNames) {
        resetDb();
        rows.push(...(await runConversation({ loop, scenario, run })));
      }
    }
  }
} finally {
  await mcp.close();
}

printSummary(rows);

// One scripted conversation on one loop. Returns one row per customer turn.
async function runConversation({ loop, scenario, run }) {
  const { turns, expect } = SCENARIOS[scenario];
  // Same settings for every loop. Decision extraction is off (the SDK loop doesn't have it, and it
  // adds a call per turn); caching is on (the SDK always caches).
  const system = buildSystemPrompt(POLICY, { toolInstructions: loop === 'sdk' ? undefined : mcp.instructions });
  let firstText = null;
  let toolCalls = [];
  const created = performance.now();
  const chat = LOOPS[loop]({
    client, model, system,
    thinking: support.adaptiveThinking,
    effort,
    decide: false,
    cache: true,
    tools: agentTools,
    callTool: mcp.callTool,
    hiddenToolNames: [...NOT_FOR_AGENT_TOOLS], // sdk only
    toolInstructions: mcp.instructions, // multi only
    onText: () => { firstText ??= performance.now(); },
    onToolCall: ({ name, isError, text, agent: by }) => toolCalls.push({ name, isError, text, by }),
  });

  const result = [];
  const allCalls = [];
  try {
    for (const [i, message] of turns.entries()) {
      firstText = null;
      toolCalls = [];
      const start = performance.now();
      let reply;
      let error;
      try {
        reply = await chat.send(message);
      } catch (err) {
        error = err.message;
      }
      const end = performance.now();
      allCalls.push(...toolCalls);
      const usage = reply?.usage ?? {};
      const row = {
        type: 'turn', loop, scenario, run, turn: i + 1,
        // On the sdk loop the first turn includes starting the Claude Code process (the session
        // starts on the first send). Compare turn 1 and later turns separately to see that cost.
        latencyMs: Math.round(end - start),
        ttftMs: firstText === null ? null : Math.round(firstText - start),
        sinceCreateMs: i === 0 ? Math.round(end - created) : undefined,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        apiCalls: reply?.calls ?? 0,
        // In multi mode this also lists the orchestrator's specialist calls (triage_request, ...);
        // the specialists' own MCP calls are prefixed with the specialist's name.
        toolCalls: toolCalls.map((c) => (c.by ? `${c.by}:${c.name}` : c.name)),
        stopReason: reply?.stopReason,
        fallback: reply?.fallback ?? false,
        error,
        sdkCostUsd: reply?.costUsd, // the SDK's running estimate for the conversation; not used for comparison
      };
      // input_tokens counts only what's after the last cache breakpoint. The sdk loop caches the
      // whole conversation, so its input_tokens is near zero; the request size is all three summed.
      row.totalInputTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
      row.costUsd = prices ? cost(row) : undefined;
      appendFileSync(outFile, `${JSON.stringify(row)}\n`);
      result.push(row);
      const status = error ? `error: ${error}` : `${row.latencyMs} ms · ${row.apiCalls} calls · ${row.totalInputTokens} in / ${row.outputTokens} out`;
      console.log(`run ${run} · ${scenario} · ${loop} · turn ${i + 1}: ${status}`);
      if (error) break;
    }
  } finally {
    chat.close?.();
  }

  // The conversation's outcome, from the real tool results. Stored on the last row.
  const outcome = outcomeOf(allCalls);
  const last = result.at(-1);
  last.outcome = outcome;
  last.expected = expect;
  last.correct = outcome === expect;
  appendFileSync(outFile, `${JSON.stringify({ type: 'outcome', loop, scenario, run, outcome, expected: expect, correct: last.correct })}\n`);
  console.log(`  → outcome ${outcome} (expected ${expect})${last.correct ? '' : '  ✗'}\n`);
  return result;
}

// What actually happened, from the tool results: a refund (completed or waiting for approval), an
// escalation, or nothing. The orchestrator's specialist calls in multi mode return plain text and
// are skipped; the specialists' own initiate_refund/escalate_to_human calls count.
function outcomeOf(calls) {
  let outcome = 'none';
  const rank = { none: 0, escalated: 1, pending_approval: 2, refunded: 3 };
  for (const { name, text } of calls) {
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      continue;
    }
    if (!result?.ok) continue;
    let found = null;
    if (name === 'initiate_refund') found = result.refund?.status === 'completed' ? 'refunded' : 'pending_approval';
    else if (name === 'escalate_to_human') found = 'escalated';
    if (found && rank[found] > rank[outcome]) outcome = found;
  }
  return outcome;
}

// Puts the seed data back without deleting the file: the MCP server processes keep it open, and
// Windows won't delete an open file. The audit logs (tool_call_log, decision_log) are kept.
function resetDb() {
  const db = openDb(defaultDbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['escalations', 'refunds', 'payments', 'orders', 'payment_methods', 'customers']) {
        db.exec(`DELETE FROM ${table}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    seed(db);
  } finally {
    db.close();
  }
}

function cost({ inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }) {
  const [pin, pout, pwrite, pread] = prices;
  return (inputTokens * pin + outputTokens * pout + cacheWriteTokens * pwrite + cacheReadTokens * pread) / 1e6;
}

function printSummary(all) {
  const turns = all.filter((r) => !r.error);
  const groups = new Map();
  for (const r of all) {
    const key = `${r.scenario}\u0000${r.loop}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log('\nPer scenario and loop (medians per conversation, summed over its turns):');
  const table = [];
  for (const [key, rs] of groups) {
    const [scenario, loop] = key.split('\u0000');
    const convos = byConversation(rs);
    const ends = rs.filter((r) => r.outcome !== undefined);
    table.push({
      scenario, loop,
      runs: convos.length,
      'latency ms': median(convos.map((c) => sum(c, 'latencyMs'))),
      'ttft ms (turn 1)': median(rs.filter((r) => r.turn === 1).map((r) => r.ttftMs).filter((x) => x !== null)),
      'api calls': median(convos.map((c) => sum(c, 'apiCalls'))),
      'total input': median(convos.map((c) => sum(c, 'totalInputTokens'))),
      'uncached in': median(convos.map((c) => sum(c, 'inputTokens'))),
      'cache read': median(convos.map((c) => sum(c, 'cacheReadTokens'))),
      'cache write': median(convos.map((c) => sum(c, 'cacheWriteTokens'))),
      'output tok': median(convos.map((c) => sum(c, 'outputTokens'))),
      ...(prices && { 'cost $': round4(median(convos.map((c) => sum(c, 'costUsd')))) }),
      correct: `${ends.filter((r) => r.correct).length}/${ends.length}`,
      errors: rs.filter((r) => r.error).length,
    });
  }
  console.table(table);

  console.log('Per loop (all scenarios):');
  console.table(loopNames.map((loop) => {
    const rs = all.filter((r) => r.loop === loop);
    const ok = turns.filter((r) => r.loop === loop);
    const ends = rs.filter((r) => r.outcome !== undefined);
    return {
      loop,
      turns: rs.length,
      'median turn ms': median(ok.map((r) => r.latencyMs)),
      'slowest turn ms': Math.max(0, ...ok.map((r) => r.latencyMs)),
      'avg api calls/turn': round2(avg(ok.map((r) => r.apiCalls))),
      'avg total input/turn': Math.round(avg(ok.map((r) => r.totalInputTokens))),
      'avg out tok/turn': Math.round(avg(ok.map((r) => r.outputTokens))),
      ...(prices && { 'total cost $': round4(sum(ok, 'costUsd')) }),
      correct: `${ends.filter((r) => r.correct).length}/${ends.length}`,
      errors: rs.filter((r) => r.error).length,
    };
  }));
  if (!prices) console.log('(Pass --prices in,out,cacheWrite,cacheRead in $ per million tokens to add costs.)');
  console.log(`Raw rows: ${outFile}`);
}

function byConversation(rs) {
  const m = new Map();
  for (const r of rs) {
    if (!m.has(r.run)) m.set(r.run, []);
    m.get(r.run).push(r);
  }
  return [...m.values()];
}

function sum(rs, field) {
  return rs.reduce((n, r) => n + (r[field] ?? 0), 0);
}
function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function list(value, known, what) {
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !known[n]);
  if (!names.length || unknown.length) fail(`Unknown ${what}: ${unknown.join(', ') || '(none given)'}. Choose from ${Object.keys(known).join(', ')}.`);
  return names;
}

function parsePrices(value) {
  const p = value.split(',').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x) || x < 0)) {
    fail('--prices needs four numbers: input,output,cacheWrite,cacheRead in $ per million tokens.');
  }
  return p;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
