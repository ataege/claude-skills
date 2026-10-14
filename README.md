# claude-skills

A Claude Code plugin marketplace.

| Plugin | What it does |
| --- | --- |
| `clean-view` | Hides tool calls, diffs and command output, and shows a calm checklist of Claude's plan above the prompt. `/simple on` or `/simple off` switches it. |
| `status-bar` | One colored line under the prompt: plan, model, effort, context, 7-day and 5-hour limits, and running agents by model and effort. |
| `model-routing` | Routes every delegated agent to the cheapest model tier that can do the job well, at an explicit effort. Refuses agents with no model, fills in effort by tier, blocks spawns from haiku agents and past two levels, and keeps a routing guide in Claude's instructions. |

## Install

At the prompt of a terminal session:

```
/plugin install clean-view --marketplace ataege/claude-skills
/plugin install status-bar --marketplace ataege/claude-skills
/plugin install model-routing --marketplace ataege/claude-skills
```

Answer `y` to add the marketplace, then pick a scope with Enter.

From a shell:

```
claude plugin install clean-view --marketplace ataege/claude-skills
claude plugin install status-bar --marketplace ataege/claude-skills
claude plugin install model-routing --marketplace ataege/claude-skills
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ataege/claude-skills`, then Add plugin.

## Developing

Each plugin lives in `plugins/<name>`. Check one with:

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```
