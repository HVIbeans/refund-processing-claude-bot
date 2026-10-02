import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedback } from '../src/promptFeedback.js';

const log = `
---
### 02/10/2026, 22:14:01
> first line
>
> second line

**Score:** 2/5

**Good:** Asks a follow-up.

**Missing:** Unclear "this".
Needs the actual lines.

**Learnings:** none

---
### 02/10/2026, 22:33:40
> ok, let's move to step 3

(coach failed: timeout)
`;

test('parses each entry with its prompt, score and fields', () => {
  const [first] = parseFeedback(log);
  assert.equal(first.time, '02/10/2026, 22:14:01');
  assert.equal(first.prompt, 'first line\n\nsecond line');
  assert.equal(first.score, 2);
  assert.deepEqual(first.fields.map((f) => f.label), ['Good', 'Missing', 'Learnings']);
  assert.equal(first.fields[1].value, 'Unclear "this".\nNeeds the actual lines.');
});

test('keeps entries without fields, such as failed reviews', () => {
  const entries = parseFeedback(log);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].score, null);
  assert.deepEqual(entries[1].fields, []);
  assert.equal(entries[1].review, '(coach failed: timeout)');
});

test('returns nothing for an empty log', () => {
  assert.deepEqual(parseFeedback(''), []);
});
