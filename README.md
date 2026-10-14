# claude-skills

A Claude Code plugin marketplace.

| Plugin | What it does |
| --- | --- |
| `clean-view` | Hides tool calls, diffs and command output, and shows a calm checklist of Claude's plan above the prompt, with a row for each helper Claude starts. `/simple on` or `/simple off` switches it. Also holds **Agent Dock**: pick a Team Size from 1 to 100 and every request is split across that many helpers, each shown live in a pane. `/dock` opens or folds it, `/dock 10` sets the size. |
| `status-bar` | One colored line under the prompt: plan, model, effort, context, 7-day and 5-hour limits, and running agents by model and effort. |
| `model-routing` | Routes every delegated agent to the cheapest model tier that can do the job well, at an explicit effort. Refuses agents with no model, fills in effort by tier, blocks spawns from haiku agents and past two levels, and keeps a routing guide in Claude's instructions. |
| `mods-menu` | A ☰ Mods button beside the Clean View toggle. It opens a small menu listing your mods with their controls: Clean View on or off, the Agent Dock and its Team Size, and the mods that are always on. `/mods` opens or closes it. |
| `prompt-upgrade` | Turns a rough prompt into a great one before it is sent. `/better <prompt>` opens a pane that asks a few quick multiple-choice questions, rewrites the prompt, and shows your original and the upgrade side by side; nothing runs until you press Run. `/better on` checks every typed prompt first: one that already has what it needs is sent as typed, one that falls short opens the pane, and the same prompt sent twice goes straight through. Press Enter twice to send a prompt as typed. A Detail setting (Auto, Low, Medium or High; `/better level auto`) sets the questions and how long and deep the upgrade is: Low, Medium and High ask up to 3, 5 or 7; Auto also turns automatic mode on, asks as many questions as needed (up to 9) and, if you don't answer within 30 seconds or press Do it for me, fills in the rest and sends the upgrade itself. `/better history` shows the last 20. |

## Install

At the prompt of a terminal session:

```
/plugin install clean-view --marketplace ataege/claude-skills
/plugin install status-bar --marketplace ataege/claude-skills
/plugin install model-routing --marketplace ataege/claude-skills
/plugin install mods-menu --marketplace ataege/claude-skills
/plugin install prompt-upgrade --marketplace ataege/claude-skills
```

Answer `y` to add the marketplace, then pick a scope with Enter.

From a shell:

```
claude plugin install clean-view --marketplace ataege/claude-skills
claude plugin install status-bar --marketplace ataege/claude-skills
claude plugin install model-routing --marketplace ataege/claude-skills
claude plugin install mods-menu --marketplace ataege/claude-skills
claude plugin install prompt-upgrade --marketplace ataege/claude-skills
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ataege/claude-skills`, then Add plugin.

## Developing

Each plugin lives in `plugins/<name>`. Check one with:

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```
