// Status bar: one colored line under the prompt with plan, model, effort, context, 7-day usage and agents.
import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  Color,
  ElementConstructor,
  EngineInterface,
  On,
  RenderElement,
  SessionRateLimit,
  TextProps,
} from 'claude-code'

import type { StatusBarRoute, StatusBarSnapshot } from '../types'

// ---------------------------------------------------------------------------
// Limits and thresholds
// ---------------------------------------------------------------------------

const CONTEXT_CELLS = 10
const SEPARATOR = ' │ '
// Between the routes of the agents segment, like 3 haiku/low · 1 opus/high.
const ROUTE_SEPARATOR = ' · '

// One single-width symbol per segment, safe in Windows Terminal and most fonts.
export const ICONS = {
  plan: '◆',
  model: '✻',
  context: '▣',
  limits: '◷',
  agents: '◎',
} as const

// The effort symbol fills up with the level: ◔ low, ◑ medium, ◕ high, ● xhigh, ◉ max.
const EFFORT_ICONS: Readonly<Record<string, string>> = {
  low: '◔',
  medium: '◑',
  high: '◕',
  xhigh: '●',
  max: '◉',
}
// Usage share at which the plan turns amber, then red.
const NEAR_LIMIT_PERCENT = 75
const AT_LIMIT_PERCENT = 95
// A finished subagent can still read as running for a moment: look again after this.
const AGENT_RECHECK_MS = 1500
const ACTIVE_AGENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

const EMPTY_SNAPSHOT: StatusBarSnapshot = {
  planName: null,
  model: null,
  effort: null,
  contextPercent: null,
  fiveHourUsedPercent: null,
  sevenDayUsedPercent: null,
  isRateLimited: false,
  activeAgents: 0,
  agentRoutes: [],
}

const snapshotAtom = atom({ plugin: 'status-bar', key: 'snapshot' } as const, EMPTY_SNAPSHOT)
const routesAtom = atom({ plugin: 'status-bar', key: 'routes' } as const, {})
// The route table keeps the most recent agents only.
const MAX_TRACKED_ROUTES = 300

type Engine = EngineInterface
type TextElement = ElementConstructor<TextProps>

// ---------------------------------------------------------------------------
// Turning raw figures into words
// ---------------------------------------------------------------------------

const PLAN_NAMES: Readonly<Record<string, string>> = {
  claude_free: 'Free',
  claude_pro: 'Pro',
  claude_max: 'Max',
  claude_team: 'Team',
  claude_enterprise: 'Enterprise',
}

/** The plan name from the login record's account fields: "Max 20x", "Pro", "API"... */
export function planLabel(account: unknown): string {
  if (account === null || typeof account !== 'object') return 'API'
  const { organizationType, organizationRateLimitTier, userRateLimitTier } = account as Record<string, unknown>
  const planType = typeof organizationType === 'string' ? organizationType : ''
  const baseName = PLAN_NAMES[planType] ?? (planType === '' ? 'Subscription' : titleCase(planType.replace(/^claude_/, '')))

  // The tier names the Max multiplier, like "default_claude_max_20x".
  const tier = [organizationRateLimitTier, userRateLimitTier].find(value => typeof value === 'string') as string | undefined
  const multiplier = tier?.match(/(\d+)x\b/)?.[1]

  return multiplier !== undefined && baseName === 'Max' ? `Max ${multiplier}x` : baseName
}

function titleCase(text: string): string {
  return text
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** "claude-opus-5-5" becomes "Opus 5.5"; an alias like "opus" becomes "Opus". */
export function formatModel(modelId: string): string {
  const withoutContextTag = modelId.replace(/\[[^\]]*\]$/, '')
  const hasMillionContext = /\[1m\]$/i.test(modelId)
  const versioned = withoutContextTag.match(/(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:$|[-@:])/i)
  const name = versioned
    ? `${titleCase(versioned[1] ?? '')} ${versioned[2]}${versioned[3] !== undefined ? `.${versioned[3]}` : ''}`
    : titleCase(withoutContextTag.replace(/^claude-/, ''))

  return hasMillionContext ? `${name} 1M` : name
}

/** The effort level as a word; a numeric budget stays a number. */
export function formatEffort(effort: unknown): string | null {
  if (typeof effort === 'string' && effort !== '') return effort
  if (typeof effort === 'number' && Number.isFinite(effort)) return String(effort)

  return null
}

/** An agent's route as the line shows it: "haiku/low", or the tier alone when it has no effort. */
export function routeLabel(modelId: string, effort: unknown): string {
  const tier = modelId.toLowerCase().match(/haiku|sonnet|opus|fable/)?.[0] ?? formatModel(modelId).toLowerCase()
  const effortWord = formatEffort(effort)

  return effortWord === null ? tier : `${tier}/${effortWord}`
}

/** Running agents grouped by route, most first; agents not yet seen making a request count as "agent". */
export function groupRoutes(agentIds: readonly string[], routes: Readonly<Record<string, string>>): StatusBarRoute[] {
  const counts = new Map<string, number>()
  for (const agentId of agentIds) {
    const label = routes[agentId] ?? 'agent'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

/** The effort symbol for a level; a numeric budget or an unknown level shows half full. */
export function effortIcon(effort: string | null): string {
  return (effort !== null ? EFFORT_ICONS[effort] : undefined) ?? '◑'
}

function percentOf(windows: readonly SessionRateLimit[], kind: string): number | null {
  const window = windows.find(candidate => candidate.kind === kind)
  return window === undefined ? null : Math.max(0, window.percentUsed)
}

/** How close the account is to a usage limit, from the busiest window. */
export function limitStatus(snapshot: StatusBarSnapshot): 'unknown' | 'ok' | 'near' | 'limited' {
  if (snapshot.isRateLimited) return 'limited'
  const readings = [snapshot.fiveHourUsedPercent, snapshot.sevenDayUsedPercent].filter(
    (value): value is number => value !== null,
  )
  if (readings.length === 0) return 'unknown'
  const busiest = Math.max(...readings)
  if (busiest >= AT_LIMIT_PERCENT) return 'limited'
  if (busiest >= NEAR_LIMIT_PERCENT) return 'near'

  return 'ok'
}

const PLAN_COLORS: Readonly<Record<ReturnType<typeof limitStatus>, Color>> = {
  unknown: 'text',
  ok: 'success',
  near: 'warning',
  limited: 'error',
}

/** Green while there is room, amber past half, red when nearly full. */
export function contextColor(percent: number): Color {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'

  return 'success'
}

/** Green with plenty left, amber when it gets low, red when nearly gone. */
export function remainingColor(remainingPercent: number): Color {
  if (remainingPercent < 20) return 'error'
  if (remainingPercent < 50) return 'warning'

  return 'success'
}

/** Ten parallelograms, filled to the context share. */
export function contextMeter(percent: number): { filled: string; empty: string } {
  const filledCells = Math.min(CONTEXT_CELLS, Math.max(0, Math.round(percent / 10)))
  return { filled: '▰'.repeat(filledCells), empty: '▱'.repeat(CONTEXT_CELLS - filledCells) }
}

// ---------------------------------------------------------------------------
// Keeping the snapshot current
// ---------------------------------------------------------------------------

async function patchSnapshot($: Engine, patch: Partial<StatusBarSnapshot>): Promise<void> {
  await update($, snapshotAtom, snapshot => ({ ...snapshot, ...patch }))
}

/** Reads the plan's name from the login record; only the plan fields are kept. */
async function refreshPlan($: Engine): Promise<void> {
  try {
    const homeDirectory = await $.env.get('HOME')
    if (homeDirectory === undefined) return
    const loginRecord = JSON.parse(await $.fs.read(`${homeDirectory}/.claude.json`)) as Record<string, unknown>
    await patchSnapshot($, { planName: planLabel(loginRecord.oauthAccount) })
  } catch {
    // No login record: the plan segment reads "Subscription" until one is found.
  }
}

async function refreshModelAndEffort($: Engine): Promise<void> {
  try {
    const [modelId, settings] = await Promise.all([$.session.model(), $.settings.read()])
    const patch: Partial<StatusBarSnapshot> = { model: formatModel(modelId) }
    const configuredEffort = formatEffort(settings.effortLevel)
    if (configuredEffort !== null) patch.effort = configuredEffort
    await patchSnapshot($, patch)
  } catch {
    // Keep what the line showed before.
  }
}

async function refreshUsage(
  $: Engine,
  usage?: { context: { percent?: number }; rateLimits: readonly SessionRateLimit[] },
): Promise<void> {
  try {
    const figures = usage ?? (await $.session.usage())
    const patch: Partial<StatusBarSnapshot> = {}
    if (figures.context.percent !== undefined) patch.contextPercent = figures.context.percent
    if (figures.rateLimits.length > 0) {
      patch.fiveHourUsedPercent = percentOf(figures.rateLimits, 'five_hour')
      patch.sevenDayUsedPercent = percentOf(figures.rateLimits, 'seven_day')
      patch.isRateLimited = false
    }
    await patchSnapshot($, patch)
  } catch {
    // Keep what the line showed before.
  }
}

async function refreshAgents($: Engine): Promise<void> {
  try {
    const agents: readonly AgentInfo[] = await $.agent.list()
    const activeIds = agents.filter(agent => ACTIVE_AGENT_STATUSES.has(agent.status)).map(agent => agent.id)
    const routes = await read($, routesAtom)
    await patchSnapshot($, { activeAgents: activeIds.length, agentRoutes: groupRoutes(activeIds, routes) })
  } catch {
    // Keep what the line showed before.
  }
}

function refreshAgentsSoon($: Engine): void {
  $.clock.after(AGENT_RECHECK_MS, () => {
    void refreshAgents($)
  })
}

/** Records an agent's route from its own request; recounts when the route is new. */
async function recordRoute($: Engine, agentId: string, label: string): Promise<void> {
  const routes = await read($, routesAtom)
  if (routes[agentId] === label) return
  await update($, routesAtom, current => {
    const entries = Object.entries({ ...current, [agentId]: label })
    return Object.fromEntries(entries.slice(-MAX_TRACKED_ROUTES))
  })
  await refreshAgents($)
}

async function refreshEverything($: Engine): Promise<void> {
  await Promise.all([refreshPlan($), refreshModelAndEffort($), refreshUsage($), refreshAgents($)])
}

// ---------------------------------------------------------------------------
// Drawing the line
// ---------------------------------------------------------------------------

/** What is left of a usage window, as a whole percent; null with no reading. */
export function remainingPercent(usedPercent: number | null): number | null {
  return usedPercent === null ? null : Math.max(0, Math.round(100 - usedPercent))
}

/** A dim window label ("7d") and its remaining percent, colored by how much is left. */
function drawLimit(Text: TextElement, label: string, remaining: number | null): RenderElement[] {
  return [
    <Text dimColor>{`${label} `}</Text>,
    remaining === null ? <Text dimColor>–</Text> : <Text color={remainingColor(remaining)}>{`${remaining}%`}</Text>,
  ]
}

/** The status line as one Text: ◆ plan │ ✻ model │ ◕ effort │ ▣ ctx │ ◷ 7d 5h │ ◎ agents. */
function drawStatusLine(Text: TextElement, snapshot: StatusBarSnapshot): RenderElement {
  const separator = <Text dimColor>{SEPARATOR}</Text>
  const planName = snapshot.planName ?? 'Subscription'
  const contextPercent = snapshot.contextPercent ?? 0
  const meter = contextMeter(contextPercent)
  const sevenDayRemaining = remainingPercent(snapshot.sevenDayUsedPercent)
  const fiveHourRemaining = remainingPercent(snapshot.fiveHourUsedPercent)
  // The symbol takes the color of whichever window has less left.
  const knownRemaining = [sevenDayRemaining, fiveHourRemaining].filter((value): value is number => value !== null)
  const agentWord = snapshot.activeAgents === 1 ? 'agent' : 'agents'
  const hasKnownRoutes = snapshot.activeAgents > 0 && snapshot.agentRoutes.some(route => route.label !== 'agent')

  const planColor = PLAN_COLORS[limitStatus(snapshot)]
  const contextTone = snapshot.contextPercent === null ? 'subtle' : contextColor(contextPercent)
  const limitsTone = knownRemaining.length === 0 ? 'subtle' : remainingColor(Math.min(...knownRemaining))
  const agentTone = snapshot.activeAgents > 0 ? 'claude' : 'subtle'

  return (
    <Text wrap="truncate-end">
      <Text color={planColor}>{`${ICONS.plan} `}</Text>
      <Text color={planColor} weight="bold">
        {planName}
      </Text>
      {separator}
      <Text color="claude">{`${ICONS.model} `}</Text>
      <Text color="claude">{snapshot.model ?? '…'}</Text>
      {separator}
      <Text color="suggestion">{`${effortIcon(snapshot.effort)} `}</Text>
      <Text dimColor>effort </Text>
      <Text>{snapshot.effort ?? '…'}</Text>
      {separator}
      <Text color={contextTone}>{`${ICONS.context} `}</Text>
      <Text dimColor>ctx </Text>
      <Text color={contextTone}>{meter.filled}</Text>
      <Text dimColor>{meter.empty}</Text>
      <Text> {snapshot.contextPercent === null ? '–' : `${contextPercent}%`}</Text>
      {separator}
      <Text color={limitsTone}>{`${ICONS.limits} `}</Text>
      {drawLimit(Text, '7d', sevenDayRemaining)}
      {separator}
      {drawLimit(Text, '5h', fiveHourRemaining)}
      {separator}
      <Text color={agentTone}>{`${ICONS.agents} `}</Text>
      {hasKnownRoutes ? (
        snapshot.agentRoutes.map((route, index) => [
          index > 0 ? <Text dimColor>{ROUTE_SEPARATOR}</Text> : null,
          <Text color="claude">{`${route.count} ${route.label}`}</Text>,
        ])
      ) : (
        <Text color={snapshot.activeAgents > 0 ? 'claude' : undefined} dimColor={snapshot.activeAgents === 0}>
          {`${snapshot.activeAgents} ${agentWord}`}
        </Text>
      )}
    </Text>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function registerStatusBar(on: On): void {
  // Session start (and each reload): read every figure once.
  on('session.start', async ($, e, next) => {
    await refreshEverything($)
    return next(e)
  })

  // Usage figures pushed by the engine after each turn and as limits move.
  on('session.measure', async ($, e, next) => {
    await refreshUsage($, e)
    return next(e)
  })

  // Each request names the model and effort actually used: the main thread's for the line, an agent's for its route.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = formatEffort(e.effort)
      const patch = effort === null ? { model: formatModel(e.model) } : { model: formatModel(e.model), effort }
      // Never hold up or break the model's stream over a display update.
      void patchSnapshot($, patch).catch(() => undefined)
    } else {
      void recordRoute($, e.agentId, routeLabel(e.model, e.effort)).catch(() => undefined)
    }
    return yield* next(e)
  })

  // A new turn: pick up a changed model or effort setting.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await refreshModelAndEffort($)
    return next(e)
  })

  // A subagent's run ended: recount, now and once its task settles.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      await refreshAgents($)
      refreshAgentsSoon($)
    }
    return result
  })

  // An agent started: count it.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await refreshAgents($)
    return result
  }).catch(($, e, next) => next(e))

  // A usage-limit error turns the plan red until usage moves again.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') await patchSnapshot($, { isRateLimited: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  // /model, /effort, /clear and the like: read the figures again afterwards.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([refreshModelAndEffort($), refreshUsage($), refreshAgents($)])
    return result
  }).catch(($, e, next) => next(e))

  // The line sits right under the prompt, above the engine's own hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const snapshot = await read($, snapshotAtom)
    const engineHint = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {drawStatusLine(Text, snapshot)}
        {engineHint}
      </Box>
    )
  })
}
