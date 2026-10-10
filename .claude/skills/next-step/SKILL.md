---
name: next-step
description: Plan the next unticked step in ROADMAP.md, or finish the current one (tick it off and add its CLAUDE.md note). Use when the user asks to plan the next step or roadmap item, or with "done" when a step is finished.
arguments: [mode]
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git status:*), Bash(git diff:*), Bash(grep:*), Bash(head:*)
---

You are helping with a learning project that is built step by step from `ROADMAP.md`. The user wants hands-on exposure to Claude Code and Claude API features, and does the learning steps themselves unless they ask you to.

## Current state

Next unticked items in ROADMAP.md:
!`grep -n "\- \[ \]" ROADMAP.md | head -5`

Branch and sync state (as of the last fetch):
!`git status -sb | head -1`

Uncommitted changes:
!`git status --short`

Recent commits:
!`git log --oneline -5`

## Mode

The mode is: "$mode". If it is empty or "plan", follow **Plan**. If it is "done", follow **Done**. Otherwise ask which one the user meant.

## Plan

1. **Pick the step.** It is the first unticked numbered step above (ignore the unnumbered "Domain features" list unless the user names one). Read its line in `ROADMAP.md` and the related parts of `CLAUDE.md`. If the code shows the step is already partly done, say what exists.
2. **Check the feature against current docs** before planning around it. For Claude Code features, ask the `claude-code-guide` agent; for the Claude API, use the `claude-api` skill. Features get removed or renamed (the `/agents` wizard was), so don't plan from memory.
3. **Write the plan**, short and concrete:
   - **What it adds**, and which files it touches.
   - **The feature it teaches**, in one or two sentences: what it is and when you'd use it.
   - **Design choices** worth the user's attention, each with your recommendation.
   - **How to test it.** Prefer a test with a known answer, such as running a reviewer on a diff with bugs planted in it, or writing a failing test first.
   - **Done when:** checkable criteria, ending with ticking the step and adding a `CLAUDE.md` note.
4. **Mention open follow-ups** only if they bear on this step. You can find them in the "known gap" notes in `CLAUDE.md` and recent conversation.
5. **Stop and ask** whether the user wants to build it themselves (you review) or have you build it. Don't start building.

## Done

1. **Check the done-when criteria** from the plan. Run `npm test` and report the result. If anything isn't met, list it and stop.
2. **Tick the step** in `ROADMAP.md` (`- [ ]` → `- [x]`), and reword the line if what was built differs from what it names.
3. **Add a `CLAUDE.md` note** for what was built, matching the style of the existing sections: what it is, where it lives, and anything a later session must know. Update any existing section the step made out of date.
4. **Show the diff** (`git diff`) and summarise it. Commit only if the user asks.
