// Model routing: each delegated agent runs on the cheapest tier whose judgment is enough, at an explicit effort.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { ModelRoutingAgent, ModelTier } from '../types'

// ---------------------------------------------------------------------------
// Tiers, defaults and limits
// ---------------------------------------------------------------------------

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const TIER_RANK: Readonly<Record<ModelTier, number>> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }

// The effort a tier runs at when Claude names the tier but not the effort (the skill's routing table).
export const DEFAULT_EFFORT: Readonly<Record<ModelTier, Effort>> = {
  haiku: 'low',
  sonnet: 'medium',
  opus: 'high',
  fable: 'xhigh',
}

// Agent types with no model of their own: without `model` they run on the session's model.
const UNPINNED_AGENT_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'claude'])

// Agents nest at most this deep: the main conversation's agents are depth 1.
const MAX_SPAWN_DEPTH = 2
// The agent table keeps the most recent spawns only.
const MAX_TRACKED_AGENTS = 300

const agentsAtom = atom({ plugin: 'model-routing', key: 'agents' } as const, {})
const typeTiersAtom = atom({ plugin: 'model-routing', key: 'typeTiers' } as const, {})

type Engine = EngineInterface

/** The tier a model alias or id names: "claude-haiku-5-5" and "haiku" are both haiku. */
export function tierOf(model: unknown): ModelTier | null {
  if (typeof model !== 'string') return null
  const family = model.toLowerCase().match(/haiku|sonnet|opus|fable/)?.[0]

  return (family as ModelTier | undefined) ?? null
}

function isAboveCeiling(requested: ModelTier, sessionTier: ModelTier | null): boolean {
  return sessionTier !== null && TIER_RANK[requested] > TIER_RANK[sessionTier]
}

// ---------------------------------------------------------------------------
// What Claude reads: the always-on guide and the fixes for refused calls
// ---------------------------------------------------------------------------

/** The routing guide added to Claude's instructions whenever agent tools are available. */
export function routingGuide(sessionTier: ModelTier | null): string {
  const session = sessionTier ?? 'the session model'
  return `# Model routing
Delegated work runs on the cheapest tier whose judgment is enough. This session runs on ${session}, which is the ceiling for delegated work, not the default. Effectiveness comes first: never pick a tier too weak for the task to save money.

On every Agent call, set \`model\` and \`effort\` yourself as this table says. This is the explicit instruction the Agent tool's effort field asks for. Before a task's first spawn, state the routing in one line, like \`Routing: 6 × haiku/low (rename batches), 1 × opus/high (JWT design).\`

| Subtask | model | effort |
|---|---|---|
| Deterministic: count, sort, grep, a sed-able rename | no agent, use the shell | – |
| Output fixed by the input plus a template, a wrong result is cheap to spot: renames, short summaries, extracting fields, formatting, run a command and report | haiku | low |
| Must decide what matters: scoped research, locating code, explaining a subsystem, drafting, a contained change with a clear spec | sonnet | medium |
| Judging or verifying findings, design tradeoffs, migrations, auth, payments, data changes | opus | high, or xhigh when regressions are costly |
| Final synthesis that must hold everything in view | ${session} | leave effort out |
| Core of a long-horizon problem, only when the session is on fable | fable | xhigh or max |

Prices in $ per million tokens in / out: haiku 0.10 / 0.50, sonnet 2 / 10, opus 4 / 20, fable 10 / 50. Judge cost per finished task, not per call.

- Split a task that mixes tiers into one agent per tier and fan out. Never send it whole to the strongest tier.
- A fork always runs on your own model and effort: fork only when the agent truly needs your full context, never for cheap work.
- Workflow scripts: set model and effort on every agent() call and leave both out only for the final synthesis. Finders over auth, crypto, payments, migrations or raw data access run on opus, because a miss there is never caught downstream.
- Haiku agents never spawn agents, and agents nest at most two levels deep. The model-routing mod refuses these spawns.
- A subagent that needs more judgment returns to its parent to re-scope instead of escalating itself. A haiku stage that fails twice moves to sonnet instead of a third try.
- If the session's own model looks mismatched to the task, say so once and let the user switch with /model.`
}

/** The fix for an Agent call that names no model. */
export function missingModelMessage(sessionTier: ModelTier | null): string {
  const session = sessionTier ?? 'the session model'
  return `Model routing: set \`model\` and \`effort\` on this Agent call, then call again. Without \`model\` it runs on the session's own model (${session}), the most expensive choice. Pick the cheapest tier whose judgment is enough:
- haiku, effort low: output fixed by the input plus a template, a wrong result is cheap to spot (renames, short summaries, extracting fields, formatting, run a command and report)
- sonnet, effort medium: must decide what matters (scoped research, locating code, explaining a subsystem, drafting, a contained change with a clear spec)
- opus, effort high (xhigh when regressions are costly): judging or verifying findings, design tradeoffs, migrations, auth, payments, data changes
- ${session} with effort left out: final synthesis that must hold everything in view
Split a task that mixes tiers into one call per tier.`
}

function aboveCeilingMessage(requested: ModelTier, sessionTier: ModelTier): string {
  return `Model routing: this session runs on ${sessionTier}, which caps delegated work. Use ${sessionTier} or a cheaper tier for this agent. If it truly needs ${requested}, tell the user and let them switch the session with /model.`
}

const HAIKU_SPAWN_MESSAGE =
  'Model routing: haiku agents do not spawn agents. Finish what you can, and return to your parent with ' +
  'whatever needs more judgment so it can re-scope.'

const DEPTH_MESSAGE =
  'Model routing: agents nest at most two levels deep. Do this part yourself, or return to your parent so it ' +
  'can spawn the work.'

function workflowMessage(sessionTier: ModelTier | null): string {
  const session = sessionTier ?? 'the session model'
  return (
    `Model routing: none of this script's agent() calls set \`model\`, so every agent would run on ${session}. ` +
    'Set model and effort on each agent() call: scan or transform stages on haiku/low, find or draft stages on ' +
    'sonnet/medium, verify or judge stages on opus/high. Leave both out only for the final synthesis. Finders ' +
    'over auth, crypto, payments, migrations or raw data access run on opus.'
  )
}

/** True when a workflow script spawns agents but never names a model for any of them. */
export function workflowLacksModels(script: unknown): boolean {
  if (typeof script !== 'string') return false
  return /\bagent\s*\(/.test(script) && !/\bmodel\s*:/.test(script)
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

async function sessionTierOf($: Engine): Promise<ModelTier | null> {
  try {
    return tierOf(await $.session.model())
  } catch {
    return null
  }
}

/** Records a spawned agent, keeping the table to its most recent entries. */
async function rememberAgent($: Engine, agentId: string, agent: ModelRoutingAgent): Promise<void> {
  await update($, agentsAtom, agents => {
    const entries = Object.entries({ ...agents, [agentId]: agent })
    return Object.fromEntries(entries.slice(-MAX_TRACKED_AGENTS))
  })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function registerModelRouting(on: On): void {
  // The routing guide, whenever Claude can spawn agents.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const offersAgents = e.tools.includes('Agent') || e.tools.includes('Workflow')
    if (!offersAgents || e.traits.includes('teammate')) return composed

    return {
      sections: [
        ...composed.sections,
        { id: 'model-routing:guide', text: routingGuide(tierOf(e.model)), scope: 'session' },
      ],
    }
  })

  // Every Agent call: a model for agents that have none, an effort for every tier, nothing above the session.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const agentType = e.subagent_type ?? 'general-purpose'
    // Forks always run on the caller's model and effort: nothing to route.
    if (agentType === 'fork') return next(e)

    const sessionTier = await sessionTierOf($)
    const requestedTier = tierOf(e.model)

    if (requestedTier === null) {
      // An agent type with no model of its own would run on the session's model.
      if (UNPINNED_AGENT_TYPES.has(agentType)) return { deny: missingModelMessage(sessionTier) }

      // A typed agent may pin its model: fill the effort only once its tier is known.
      if (e.effort !== undefined) return next(e)
      const typeTier = (await read($, typeTiersAtom))[agentType]
      if (typeTier === undefined || typeTier === sessionTier) return next(e)
      return next({ ...e, effort: DEFAULT_EFFORT[typeTier] })
    }

    if (sessionTier !== null && isAboveCeiling(requestedTier, sessionTier)) {
      return { deny: aboveCeilingMessage(requestedTier, sessionTier) }
    }

    // A cheaper tier with no effort would inherit the session's: give it its own.
    // The session's own tier without effort is the final-synthesis case, so it inherits.
    if (e.effort === undefined && requestedTier !== sessionTier) {
      return next({ ...e, effort: DEFAULT_EFFORT[requestedTier] })
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // Never block work on a fault of this mod.

  // Workflow scripts whose agents would all run on the session's model.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (workflowLacksModels(e.script)) return { deny: workflowMessage(await sessionTierOf($)) }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every spawn, from any source: haiku agents never spawn, and nesting stops at two levels.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume !== undefined) return next(e)

    const agents = await read($, agentsAtom)
    const parent = e.parentAgentId === undefined ? undefined : agents[e.parentAgentId]
    // An agent spawned before this mod loaded is taken to sit at depth 1.
    const parentDepth = e.parentAgentId === undefined ? 0 : (parent?.depth ?? 1)

    if (parent?.tier === 'haiku') return { deny: HAIKU_SPAWN_MESSAGE }
    if (parentDepth + 1 > MAX_SPAWN_DEPTH) return { deny: DEPTH_MESSAGE }

    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      const tier = tierOf(spawned.model)
      await rememberAgent($, spawned.agentId, { tier, depth: parentDepth + 1, type: e.subagentType })
      // The tier a type runs on when no model is named: its pinned model, or the caller's.
      if (tier !== null && e.model === undefined && !e.fork) {
        await update($, typeTiersAtom, typeTiers => ({ ...typeTiers, [e.subagentType]: tier }))
      }
    }

    return spawned
  }).catch(($, e, next) => next(e))
}
