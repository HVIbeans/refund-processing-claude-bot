// PostToolUse hook (Edit|Write): runs `npm test` after an edit to a src/ or test/ file, and
// reports a failure straight back to Claude in the same turn - automating the "run tests
// after changes" discipline this project already follows by hand.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
const filePath = input.tool_input?.file_path ?? '';

// Doc-only edits (CLAUDE.md, ROADMAP.md, ...) never trigger a test run.
if (!/[\\/](src|test)[\\/].*\.(js|sql)$/.test(filePath)) process.exit(0);

// A single command string (not a separate args array) avoids Node's DEP0190 warning about
// shell:true + args being concatenated unescaped - moot here (no untrusted input), but free to avoid.
// Timeout stays well under settings.json's 60s outer hook timeout, so a hang still reports
// back as a block instead of being silently killed by the outer timeout first.
const result = spawnSync('npm test', {
  cwd: projectDir,
  encoding: 'utf8',
  shell: true, // npm is a .cmd shim on Windows
  windowsHide: true,
  timeout: 45_000,
});

if (result.status !== 0) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || (result.error?.message ?? '(no output)');
  console.log(JSON.stringify({
    decision: 'block',
    reason: `npm test failed after editing ${filePath}:\n\n${output.slice(-4000)}`,
  }));
}
// On success: exit 0 silently, same as a passing CI check needs no comment.
