// UserPromptSubmit hook: reviews each prompt in the background with a headless `claude -p` run.
// Hook mode reads the hook JSON on stdin, starts a detached worker, and exits at once so the session isn't blocked.
// The hook prints nothing, so the review never enters the main session's context. Results go to .claude/prompt-coach/feedback.md.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, '..', '..');
const logFile = join(projectDir, '.claude', 'prompt-coach', 'feedback.md');

// The child `claude -p` fires this same hook. This guard stops it from recursing.
if (process.env.PROMPT_COACH_CHILD) process.exit(0);

if (process.argv.includes('--worker')) {
  runWorker(process.env.PROMPT_COACH_PROMPT);
} else {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const prompt = input.prompt ?? input.prompt_text ?? '';
  if (prompt.trim()) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PROMPT_COACH_PROMPT: prompt, PROMPT_COACH_TRANSCRIPT: input.transcript_path ?? '' },
    }).unref();
  }
}

// Returns the last few user prompts and assistant replies before `prompt`, from the session's JSONL transcript.
// Tool calls, tool results and thinking are skipped; only what the user and Claude said to each other is kept.
function recentConversation(transcriptPath, prompt, maxTurns = 6, maxChars = 600) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
  } catch {
    return '';
  }

  const turns = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isMeta || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    const content = entry.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    if (text.trim()) turns.push({ role: entry.type, text: text.trim() });
  }

  // The worker can start after Claude has begun replying, so cut at the prompt under review.
  const cut = turns.findLastIndex((t) => t.role === 'user' && t.text === prompt.trim());
  const before = cut === -1 ? turns : turns.slice(0, cut);
  return before
    .slice(-maxTurns)
    .map((t) => `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text.length > maxChars ? t.text.slice(0, maxChars) + '…' : t.text}`)
    .join('\n\n');
}

function runWorker(prompt) {
  // Reuse the subagent's instructions so the hook and @prompt-coach behave the same.
  const agentFile = readFileSync(join(projectDir, '.claude', 'agents', 'prompt-coach.md'), 'utf8');
  const instructions = agentFile.replace(/^---[\s\S]*?---\s*/, '');

  const context = recentConversation(process.env.PROMPT_COACH_TRANSCRIPT, prompt);
  const contextBlock = context ? `Recent conversation (for context only, don't review it):\n<conversation>\n${context}\n</conversation>\n\n` : '';

  // Send everything on stdin so no long or quoted text passes through the shell.
  const result = spawnSync('claude', ['-p', '--model', 'haiku', '--max-turns', '1'], {
    input: `${instructions}\n\n${contextBlock}Review this prompt:\n<prompt>\n${prompt}\n</prompt>`,
    encoding: 'utf8',
    shell: true, // `claude` is a .cmd shim on Windows
    windowsHide: true,
    cwd: projectDir,
    env: { ...process.env, PROMPT_COACH_CHILD: '1' },
    timeout: 120_000,
  });

  const review = result.stdout?.trim() || `(coach failed: ${result.error?.message ?? result.stderr?.trim() ?? 'no output'})`;
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `\n---\n### ${new Date().toLocaleString()}\n> ${prompt.replace(/\n/g, '\n> ')}\n\n${review}\n`);
}
