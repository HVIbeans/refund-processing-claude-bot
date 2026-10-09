// PreToolUse hook (Edit|Write): asks for confirmation before any edit to src/policy.js,
// even under acceptEdits/auto mode. src/policy.js is the single source of truth for the
// refund policy (limits, window, valid reasons) - this mirrors the project's own
// human-in-the-loop pattern from step 17: the file holding the limits gets the same
// "a human must consciously approve this" treatment as a refund above the auto-approve limit.
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
const filePath = input.tool_input?.file_path ?? '';

if (/(^|[\\/])src[\\/]policy\.js$/.test(filePath)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'src/policy.js holds the refund policy (limits, window, valid reasons) - confirm this change is intentional.',
    },
  }));
}
// No match: no output at all, so the hook expresses no opinion and normal permission rules apply.
