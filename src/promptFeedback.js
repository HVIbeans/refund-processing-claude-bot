// Reads the prompt-coach log written by .claude/hooks/prompt-coach.js and watches it for new reviews.
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const logFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'prompt-coach', 'feedback.md');

// Each log entry looks like:
//   ---
//   ### <timestamp>
//   > <prompt line>
//   > <prompt line>
//
//   **Score:** 3/5
//   **Good:** ...
export function parseFeedback(text) {
  return text
    .split(/\n?---\n(?=### )/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('### '))
    .map((chunk) => {
      const [heading, ...rest] = chunk.split('\n');
      const promptLines = [];
      while (rest.length && rest[0].startsWith('>')) promptLines.push(rest.shift().replace(/^> ?/, ''));
      const review = rest.join('\n').trim();

      // Gather "**Label:** value" lines, folding any following lines into the field above.
      const fields = [];
      for (const line of review.split('\n')) {
        const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
        if (match) fields.push({ label: match[1], value: match[2] });
        else if (fields.length && line.trim()) fields.at(-1).value += `\n${line}`;
      }

      const scoreField = fields.find((f) => f.label === 'Score');
      const score = scoreField ? Number(scoreField.value.match(/(\d)\s*\/\s*5/)?.[1]) || null : null;

      return {
        time: heading.slice(4).trim(),
        prompt: promptLines.join('\n').trim(),
        score,
        fields: fields.filter((f) => f !== scoreField),
        review,
      };
    });
}

export function readFeedback() {
  try {
    return parseFeedback(readFileSync(logFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Calls onChange(entries) whenever the log changes. The directory is watched instead of the file
// because the file may not exist yet, and appends on Windows can fire several events at once.
export function watchFeedback(onChange) {
  const dir = dirname(logFile);
  mkdirSync(dir, { recursive: true });
  let timer;
  const watcher = watch(dir, (_event, name) => {
    if (name && name !== basename(logFile)) return;
    clearTimeout(timer);
    timer = setTimeout(() => onChange(readFeedback()), 150);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
