---
name: model-routing
description: Use when about to delegate work to another model or pick a model for the session - calling the Agent tool, writing a Workflow script with agent() stages, defining a subagent in .claude/agents, or choosing which Claude model or effort level a task should run on. Also use when the user asks which model to use, whether a task needs a stronger model, or how to cut token cost. Trigger even if the user never mentions models - any fan-out, parallel agents, subagent, or workflow creation counts. Skip for trivial one-line edits with no delegation.
---

# Model & effort routing

## Overview

Route each unit of work to the cheapest tier whose judgment is sufficient, and set effort explicitly. The session model is the ceiling for delegated work, not the default: a Fable 5.1 session that spawns Fable subagents for renames pays 100x what Haiku would charge for the same diff.

Two levers, set both every time you spawn:

- **Model tier** sets price per token (table below).
- **Effort** (`low` → `max`) sets how much a model thinks and how many tool calls it makes. A subagent inherits the session's effort unless you override it, so a Haiku formatter spawned from an `xhigh` session runs at `xhigh` by default — pure waste.

## Current ladder (as of 2026-10)

| Alias | Model | API id | $/MTok in / out | Suits |
|---|---|---|---|---|
| `haiku` | Haiku 5.5 | `claude-haiku-5-5` | 0.10 / 0.50 | mechanical bulk work |
| `sonnet` | Sonnet 5.5 | `claude-sonnet-5-5` | 2 / 10 | scoped research, drafting, contained changes |
| `opus` | Opus 5.5 | `claude-opus-5-5` | 4 / 20 | design, verification, correctness-critical work |
| `fable` | Fable 5.1 | `claude-fable-5-1` | 10 / 50 | hardest long-horizon reasoning |

Use the aliases in Claude Code — they always resolve to the current generation, so stale names (Opus 4.x, Sonnet 5, Haiku 4.5) cannot creep in. Haiku's price applies to prompts up to 100K tokens; beyond that it is 5x. Prices shift as Anthropic reshuffles tiers — if a figure here looks off, check the `claude-api` skill rather than guessing.

## Routing by subtask shape

| Subtask looks like | Model | Effort |
|---|---|---|
| Deterministic: concatenate, sort, count, grep, a sed-able rename | none — run it in shell, zero model tokens | — |
| Output is fixed by the input plus a template, and a wrong result is cheap to spot and redo: rename across files, two-line summaries of many files, extract fields, format, dedup, run a command and report | `haiku` | `low` |
| Must decide what matters: scoped research, locate code, explain a subsystem, draft a section, contained code change with a clear spec | `sonnet` | `medium` |
| Judge or verify findings, adversarial refute, weigh design tradeoffs, migration / auth / data change where a wrong answer is expensive | `opus` | `high` (`xhigh` when regressions are costly) |
| Final synthesis that must hold everything in view | inherit (omit `model`) | inherit |
| Core of a multi-day, long-horizon problem, and the session itself is on `fable` | `fable` | `xhigh` / `max` — rare |

A task that mixes tiers gets split, not sent whole to the strongest tier. Before the first spawn, state the routing in one line so it is auditable:
`Routing: 6 × haiku/low (rename batches), 1 × opus/high (JWT design).`

## Where the choice goes

- **Agent tool**: pass `model` and `effort` on every call. `subagent_type: "fork"` always inherits the parent model, so never fork for cheap work — use `general-purpose` or `Explore` with `model: "haiku"`.
- **Workflow scripts**: set `model` and `effort` on each `agent()` call; when a whole phase shares one tier, also note it on that phase's `meta.phases` entry. Scan / transform stages → haiku, find / draft → sonnet, verify / judge → opus, synthesis → omit. In a find → verify pipeline the verifier removes false positives, so finders run on sonnet; a finder over auth, crypto, payments, migrations or raw data access runs on opus, because a miss there is never caught downstream.
- **Custom agents** (`.claude/agents/*.md`): the frontmatter `model:` pins a tier — check it before overriding.

```js
// One pipeline, three tiers: cheap scan, mid-tier reasoning, strong verification.
const verified = await pipeline(changedFiles,
  file => agent(`List exported symbols in ${file}`, {model: 'haiku', effort: 'low', phase: 'Scan'}),
  (symbols, file) => agent(`Find callers of ${file} exports broken by this diff: ${symbols}`, {model: 'sonnet', effort: 'medium', phase: 'Find'}),
  finding => agent(`Try to refute: ${finding}`, {model: 'opus', effort: 'high', phase: 'Verify', schema: VERDICT}),
)
```

## Guardrails

- Haiku agents do not spawn further agents. Max spawn depth is 2.
- A subagent that discovers it needs more judgment returns to the parent to re-scope; it does not self-escalate.
- Judge cost per completed task, not per call. A Haiku stage that fails twice moves to Sonnet instead of a third retry.

## Main session

- Everyday feature work, moderate refactors, triage: Sonnet 5.5 or Opus 5.5 at `medium` / `high`.
- Correctness-critical or large multi-file change: Opus 5.5 at `high` / `xhigh`, with cheap subagents for the mechanical parts.
- Fable 5.1 only for genuinely long-horizon reasoning where task length itself is the differentiator; it costs 2.5x Opus, so pair it with aggressive downward routing of subtasks.
- If the session model looks mismatched to the task, say so once and let the user switch with `/model`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Omitting `effort` on a cheap agent | It inherits the session's effort; set `low` explicitly |
| Forking to save prompt-writing | Fork inherits the parent tier; write the prompt and pick the tier |
| Naming a model version from memory | Use aliases; full ids only from the table above |
| Sending a mixed task to one strong agent | Split by tier, then fan out |
