// Clean View: hides tool rows and shows a calm checklist of Claude's plan above the prompt.
import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ElementConstructor,
  EngineInterface,
  On,
  RenderElement,
  RenderInput,
  RenderNode,
  TextProps,
  Timer,
} from 'claude-code'

import type { CleanViewChecklist, CleanViewHelper, CleanViewTask, CleanViewTaskStatus } from '../types'

// ---------------------------------------------------------------------------
// Names, limits and wording
// ---------------------------------------------------------------------------

const PLAN_TOOL_NAME = 'plan_steps'
const REPORT_TOOL_NAME = 'report_progress'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'
const STORE_KEY = 'cleanViewEnabled'

const MAX_NAME_LENGTH = 40
const MAX_PLAN_STEPS = 8
const METER_CELLS = 10
const LABEL_CELLS = 7 // fits "Working" and "Up next"
const ROW_CHROME_CELLS = 2 + 1 + METER_CELLS + 2 + LABEL_CELLS // marker, gaps, meter, label
const BOX_CHROME_COLUMNS = 4 // border and padding on both sides
const MAX_HELPER_ROWS = 5 // per step; the rest fold into one line
const TICK_MS = 250
const COLLAPSE_AFTER_MS = 5000
const FAILS_BEFORE_STUCK = 3

const FALLBACK_NAME = 'Working on it'
const DEFAULT_TITLE = 'Working on your request'
const PLACEHOLDER_STEPS = ['Understand your request', 'Plan the steps']

// Tools the plan-first gate always lets through.
const ALWAYS_ALLOWED_TOOLS = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
  REPORT_TOOL,
])

// Plain sentences the header shows.
export const REASONS = {
  permission: 'Claude needs your OK to continue',
  question: 'Claude has a question for you',
  waitingForReply: 'Claude is waiting for your reply',
  saidNo: 'you said no to a step, so Claude paused',
  keepsFailing: 'a step keeps failing, Claude is trying another way',
  refusal: "Claude couldn't help with that request",
  rateLimit: 'you hit your usage limit, try again a little later',
  busy: "Claude's servers are busy, try again in a minute",
  tooLong: 'type /compact and try again',
  network: 'the internet connection dropped',
  login: 'type /login',
  billing: 'your account needs attention, check your plan',
  unknownError: 'something went wrong, try again in a moment',
} as const

// Stuck reasons that came from an API error, so a late error detail may refine them.
const API_ERROR_REASONS: ReadonlySet<string> = new Set([
  REASONS.rateLimit,
  REASONS.busy,
  REASONS.tooLong,
  REASONS.network,
  REASONS.login,
  REASONS.billing,
  REASONS.unknownError,
])

const GATE_MESSAGE =
  `Clean View: call ${PLAN_TOOL} first to lay out 2 to 8 plain-English steps for this request ` +
  '(load it with ToolSearch if it is deferred), then try this tool again.'

const CHECKLIST_PROMPT = `# Clean View checklist
The person is using Clean View: tool calls are hidden from them and they follow your work through a simple checklist above the prompt. Keep that checklist accurate.
- For every request, even a quick question, call ${PLAN_TOOL} first, before any other tool, with 2 to 8 short step names in order. If it is deferred, load it with ToolSearch first.
- Then call ${REPORT_TOOL} with the current step's name and a percent as real progress happens, and with 100 the moment a step finishes.
- If this session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead.
- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- When you start agents, add to each agent's prompt: 'As you work, call ${REPORT_TOOL} with your task name and a percent at about 25, 50, 75 and 100. Do not call ${PLAN_TOOL}.'`

// Text a tool result carries when the person turned down a permission prompt.
// Where a new request comes from; helpers' reports, peers' messages and plugins' prompts carry on the current job.
const NEW_JOB_ORIGINS: ReadonlySet<string> = new Set([
  'composer',
  'bridge',
  'sdk',
  'unclassified',
  'scheduled-trigger',
  'channel',
  'slack-ping',
])

const USER_SAID_NO = /user doesn't want to (proceed|take this action)|tool use was rejected|the user (rejected|denied|declined)/i

// File names with a code or config extension, which never belong in a step name.
const CODE_FILE_NAME =
  /^[\w.@-]*\w\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|css|scss|sass|less|html?|json|jsonc|ya?ml|toml|md|mdx|sh|bash|zsh|ps1|sql|vue|svelte|astro|xml|lock|env|ini|cfg|conf|txt|csv|ipynb|dart|lua|scala|exs?|hs|gradle|tf|graphql|proto|prisma)$/i

const BORDER_COLOR = '#3A3A46' // the muted frame around the band

// ---------------------------------------------------------------------------
// Shared state (declared in types/index.d.ts)
// ---------------------------------------------------------------------------

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// Module-only bookkeeping: none of it is drawn, so a reload may reset it.
let animationTimer: Timer | undefined
let areToolsRegistered = false
let failedCallsInRow = 0
let lastApiErrorText = ''
let lastSubmitKind: 'prompt' | 'command' | undefined
let isMainTurnRunning = false

// ---------------------------------------------------------------------------
// The one name cleaner
// ---------------------------------------------------------------------------

/** Turns any step or job name into plain words: no code, paths or file names, at most 40 characters. */
export function cleanStepName(rawName: unknown): string {
  const withoutCode = String(rawName ?? '').replace(/`[^`]*`?/g, ' ')

  const keptWords = withoutCode.split(/\s+/).filter(word => {
    if (word.includes('/') || word.includes('\\')) return false
    const bareWord = word.replace(/^[("'[{<]+|[)"'\]}>,.;:!?]+$/g, '')
    return !CODE_FILE_NAME.test(bareWord)
  })

  const tidied = keptWords
    .join(' ')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}|"\s*"/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.;:!?\-–—]+\s*/, '')
    .replace(/[\s,;:\-–—(]+$/, '')

  if (tidied === '') return FALLBACK_NAME
  const capitalised = tidied.charAt(0).toUpperCase() + tidied.slice(1)

  return trimToLength(capitalised, MAX_NAME_LENGTH)
}

/** Cuts text at a word boundary so it, with its "…", fits in `maxLength`. */
function trimToLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const room = maxLength - 1
  let cut = text.slice(0, room)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > room / 3) cut = cut.slice(0, lastSpace)

  return cut.replace(/[\s,;:\-–—.]+$/, '') + '…'
}

/** Haiku's job name: its first line, cleaned, at most six words. */
export function cleanJobTitle(rawTitle: string): string {
  const firstLine = rawTitle.split('\n').find(line => line.trim() !== '') ?? ''
  const unquoted = firstLine.replace(/^[\s"'*#>-]+|[\s"'*.!]+$/g, '')
  const shortened = unquoted.split(/\s+/).slice(0, 6).join(' ')

  return cleanStepName(shortened)
}

// ---------------------------------------------------------------------------
// Checklist changes: pure functions over the shared value
// ---------------------------------------------------------------------------

function makeTask(id: string, name: string, status: CleanViewTaskStatus): CleanViewTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: false }
}

function isSameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function clampPercent(rawPercent: unknown): number {
  const percent = Number(rawPercent)
  if (!Number.isFinite(percent)) return 0

  return Math.round(Math.min(100, Math.max(0, percent)))
}

/** A fresh job with placeholder steps, shown until the real plan arrives. */
export function startJob(previousJobId: number, now: number): CleanViewChecklist {
  return {
    jobId: previousJobId + 1,
    title: DEFAULT_TITLE,
    phase: 'working',
    tasks: PLACEHOLDER_STEPS.map((name, index) =>
      makeTask(`placeholder-${index + 1}`, name, index === 0 ? 'active' : 'upcoming'),
    ),
    hasPlan: false,
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
    helpers: [],
  }
}

/** Keeps exactly one step active while any step is unfinished. */
export function settleActiveStep(tasks: readonly CleanViewTask[]): CleanViewTask[] {
  let hasActive = false
  const withOneActive = tasks.map(task => {
    if (task.status !== 'active') return task
    if (hasActive) return { ...task, status: 'upcoming' as const }
    hasActive = true
    return task
  })
  if (hasActive) return withOneActive

  const firstOpenIndex = withOneActive.findIndex(task => task.status === 'upcoming')
  return withOneActive.map((task, index) =>
    index === firstOpenIndex ? { ...task, status: 'active' as const } : task,
  )
}

/** Brings a finished job back to life when Claude keeps working on it. */
function reopen(checklist: CleanViewChecklist): CleanViewChecklist {
  const isFinished = checklist.phase === 'done' || checklist.phase === 'stopped' || checklist.phase === 'idle'
  return isFinished ? { ...checklist, phase: 'working', finishedAt: null, isCollapsed: false } : checklist
}

export function clearNeedsYou(checklist: CleanViewChecklist): CleanViewChecklist {
  return checklist.phase === 'needsYou' ? { ...checklist, phase: 'working', needsYouReason: null } : checklist
}

export function clearStuck(checklist: CleanViewChecklist): CleanViewChecklist {
  return checklist.phase === 'stuck' ? { ...checklist, phase: 'working', stuckReason: null } : checklist
}

export function markNeedsYou(checklist: CleanViewChecklist, reason: string): CleanViewChecklist {
  const isRunning = checklist.phase === 'working' || checklist.phase === 'needsYou' || checklist.phase === 'stuck'
  return isRunning ? { ...checklist, phase: 'needsYou', needsYouReason: reason, stuckReason: null } : checklist
}

export function markStuck(checklist: CleanViewChecklist, reason: string): CleanViewChecklist {
  const isRunning = checklist.phase === 'working' || checklist.phase === 'needsYou' || checklist.phase === 'stuck'
  return isRunning ? { ...checklist, phase: 'stuck', stuckReason: reason, needsYouReason: null } : checklist
}

/** `plan_steps`: the plan replaces whatever was there; the first step starts. */
export function applyPlan(checklist: CleanViewChecklist, rawNames: readonly unknown[]): CleanViewChecklist {
  const names: string[] = []
  for (const rawName of rawNames) {
    const name = cleanStepName(rawName)
    if (!names.some(existing => isSameName(existing, name))) names.push(name)
  }
  if (names.length === 0) return checklist

  const tasks = names
    .slice(0, MAX_PLAN_STEPS)
    .map((name, index) => makeTask(`step-${index + 1}`, name, index === 0 ? 'active' : 'upcoming'))

  return { ...checklist, tasks, hasPlan: true }
}

/** A step id no other row holds. */
function freshStepId(tasks: readonly CleanViewTask[]): string {
  let counter = tasks.length + 1
  while (tasks.some(task => task.id === `step-${counter}`)) counter += 1

  return `step-${counter}`
}

/** `report_progress`: earlier steps are checked off; 100 finishes the step and starts the next. */
export function applyProgress(
  checklist: CleanViewChecklist,
  rawTaskName: unknown,
  rawPercent: unknown,
): CleanViewChecklist {
  const name = cleanStepName(rawTaskName)
  const percent = clampPercent(rawPercent)
  let tasks = checklist.hasPlan ? [...checklist.tasks] : []
  let reportedIndex = tasks.findIndex(task => isSameName(task.name, name))

  if (reportedIndex === -1) {
    // A step that isn't in the plan: slot it in where the work is happening now.
    const activeIndex = tasks.findIndex(task => task.status === 'active')
    const firstOpenIndex = tasks.findIndex(task => task.status !== 'done')
    const insertAt = activeIndex !== -1 ? activeIndex : firstOpenIndex !== -1 ? firstOpenIndex : tasks.length
    const newTask = makeTask(freshStepId(tasks), name, 'active')
    tasks = tasks.map(task => (task.status === 'active' ? { ...task, status: 'upcoming' as const } : task))
    tasks.splice(insertAt, 0, newTask)
    reportedIndex = insertAt
  }

  tasks = tasks.map((task, index) => {
    if (index < reportedIndex) {
      return task.status === 'done' ? task : { ...task, status: 'done' as const, percent: 100 }
    }
    if (index === reportedIndex) {
      return percent >= 100
        ? { ...task, status: 'done' as const, percent: 100, hasReported: true }
        : { ...task, status: 'active' as const, percent, hasReported: true }
    }
    return task.status === 'active' ? { ...task, status: 'upcoming' as const } : task
  })

  return { ...checklist, tasks: settleActiveStep(tasks), hasPlan: true }
}

type TodoItem = { readonly content: string; readonly status: string }

/** TodoWrite: the to-do list becomes the plan, keeping progress already reported. */
export function applyTodos(checklist: CleanViewChecklist, todos: readonly TodoItem[]): CleanViewChecklist {
  if (todos.length === 0) return checklist
  const previousByName = new Map(checklist.tasks.map(task => [task.name.toLowerCase(), task]))

  const tasks = todos.map((todo, index): CleanViewTask => {
    const name = cleanStepName(todo.content)
    const status = todoStatus(todo.status)
    const previous = previousByName.get(name.toLowerCase())
    const keepsProgress = previous !== undefined && status === 'active' && previous.hasReported
    return {
      id: `todo-${index + 1}`,
      name,
      status,
      percent: status === 'done' ? 100 : keepsProgress ? previous.percent : 0,
      hasReported: keepsProgress,
    }
  })

  return { ...checklist, tasks: settleActiveStep(tasks), hasPlan: true }
}

function todoStatus(status: string | undefined): CleanViewTaskStatus {
  if (status === 'completed') return 'done'
  if (status === 'in_progress') return 'active'

  return 'upcoming'
}

/** TaskCreate: one more row; the first task created replaces any other kind of plan. */
export function applyTaskCreate(checklist: CleanViewChecklist, taskId: string, subject: string): CleanViewChecklist {
  const existingTasks = checklist.tasks.filter(task => task.id.startsWith('task-'))
  const tasks = [...existingTasks, makeTask(`task-${taskId}`, cleanStepName(subject), 'upcoming')]

  return { ...checklist, tasks: settleActiveStep(tasks), hasPlan: true }
}

/** TaskUpdate: moves, renames or removes a task row. */
export function applyTaskUpdate(
  checklist: CleanViewChecklist,
  taskId: string,
  status: string | undefined,
  subject: string | undefined,
): CleanViewChecklist {
  const rowId = `task-${taskId}`
  if (!checklist.tasks.some(task => task.id === rowId)) return checklist
  if (status === 'deleted') {
    return { ...checklist, tasks: settleActiveStep(checklist.tasks.filter(task => task.id !== rowId)) }
  }

  const tasks = checklist.tasks.map((task): CleanViewTask => {
    if (task.id !== rowId) {
      return status === 'in_progress' && task.status === 'active' ? { ...task, status: 'upcoming' } : task
    }
    const name = subject ? cleanStepName(subject) : task.name
    if (status === 'completed') return { ...task, name, status: 'done', percent: 100 }
    if (status === 'in_progress') return { ...task, name, status: 'active' }
    if (status === 'pending') return { ...task, name, status: 'upcoming' }
    return { ...task, name }
  })

  return { ...checklist, tasks: settleActiveStep(tasks) }
}

// ---------------------------------------------------------------------------
// Helpers (the main chat's subagents): pure changes over the shared value
// ---------------------------------------------------------------------------

/** The checklist's helpers; state saved before helpers existed has none. */
function helpersOf(checklist: CleanViewChecklist): readonly CleanViewHelper[] {
  return checklist.helpers ?? []
}

function changeHelpers(
  checklist: CleanViewChecklist,
  isTarget: (helper: CleanViewHelper) => boolean,
  change: (helper: CleanViewHelper) => CleanViewHelper,
): CleanViewChecklist {
  const helpers = helpersOf(checklist)
  if (!helpers.some(isTarget)) return checklist

  return { ...checklist, helpers: helpers.map(helper => (isTarget(helper) ? change(helper) : helper)) }
}

/** An Agent call started: a working row under the step that is active now. */
export function addHelper(checklist: CleanViewChecklist, toolUseId: string, description: unknown, now: number): CleanViewChecklist {
  const helpers = helpersOf(checklist)
  if (helpers.some(helper => helper.id === toolUseId)) return checklist

  const helper: CleanViewHelper = {
    id: toolUseId,
    agentId: null,
    name: cleanStepName(description),
    stepId: checklist.tasks.find(task => task.status === 'active')?.id ?? null,
    status: 'working',
    percent: 0,
    hasReported: false,
    startedAt: now,
    finishedAt: null,
  }

  return { ...checklist, helpers: [...helpers, helper] }
}

/** An Agent call that was refused never became a helper. */
export function removeHelper(checklist: CleanViewChecklist, toolUseId: string): CleanViewChecklist {
  const helpers = helpersOf(checklist)
  return helpers.some(helper => helper.id === toolUseId)
    ? { ...checklist, helpers: helpers.filter(helper => helper.id !== toolUseId) }
    : checklist
}

export function markHelperStuck(checklist: CleanViewChecklist, toolUseId: string, now: number): CleanViewChecklist {
  return changeHelpers(checklist, helper => helper.id === toolUseId, helper => ({ ...helper, status: 'stuck', finishedAt: now }))
}

/** Links the Agent call to the agent that runs it; a link already made stays. */
export function linkHelperAgent(checklist: CleanViewChecklist, toolUseId: string, agentId: string): CleanViewChecklist {
  return changeHelpers(
    checklist,
    helper => helper.id === toolUseId && helper.agentId === null,
    helper => ({ ...helper, agentId }),
  )
}

/** A helper's own report_progress, found by its agent id. */
export function reportHelperProgress(checklist: CleanViewChecklist, agentId: string, percent: number): CleanViewChecklist {
  return changeHelpers(checklist, helper => helper.agentId === agentId, helper => ({ ...helper, percent, hasReported: true }))
}

/** A helper's turn began (or a message woke it again): it is working. */
export function startHelperTurn(checklist: CleanViewChecklist, agentId: string): CleanViewChecklist {
  return changeHelpers(
    checklist,
    helper => helper.agentId === agentId,
    helper => ({ ...helper, status: 'working', finishedAt: null }),
  )
}

/** A helper's turn ended: done at 100%, or stuck. */
export function endHelperTurn(checklist: CleanViewChecklist, agentId: string, isStuck: boolean, now: number): CleanViewChecklist {
  return changeHelpers(
    checklist,
    helper => helper.agentId === agentId,
    helper =>
      isStuck
        ? { ...helper, status: 'stuck', finishedAt: now }
        : { ...helper, status: 'done', percent: 100, finishedAt: now },
  )
}

export function workingHelperCount(checklist: CleanViewChecklist): number {
  return helpersOf(checklist).filter(helper => helper.status === 'working').length
}

/** After a reload: settle rows from what the engine says about each agent. */
export function settleHelpers(
  checklist: CleanViewChecklist,
  agents: readonly { id: string; status: string }[],
  now: number,
): CleanViewChecklist {
  const statusByAgent = new Map(agents.map(agent => [agent.id, agent.status]))

  return changeHelpers(
    checklist,
    helper => helper.agentId !== null && helper.status === 'working' && statusByAgent.has(helper.agentId),
    helper => {
      const agentStatus = statusByAgent.get(helper.agentId ?? '')
      if (agentStatus === 'completed') return { ...helper, status: 'done', percent: 100, finishedAt: now }
      if (agentStatus === 'failed' || agentStatus === 'killed') return { ...helper, status: 'stuck', finishedAt: now }
      return agentStatus === 'idle' ? { ...helper, status: 'idle' } : helper
    },
  )
}

/** The helpers' combined progress, 0 to 100, or null until one has reported or finished. */
export function helperProgress(helpers: readonly CleanViewHelper[]): number | null {
  const hasNews = helpers.some(helper => helper.hasReported || helper.status === 'done')
  if (!hasNews || helpers.length === 0) return null
  const percentSum = helpers.reduce((sum, helper) => {
    if (helper.status === 'done') return sum + 100
    return helper.hasReported ? sum + helper.percent : sum
  }, 0)

  return Math.round(percentSum / helpers.length)
}

/** The percent a step's meter shows: its own report, else its helpers' combined progress. */
export function stepPercent(task: CleanViewTask, helpers: readonly CleanViewHelper[]): { percent: number; hasProgress: boolean } {
  if (task.hasReported || task.status === 'done') return { percent: task.percent, hasProgress: true }
  const combined = helperProgress(helpers.filter(helper => helper.stepId === task.id))

  return combined === null ? { percent: task.percent, hasProgress: false } : { percent: combined, hasProgress: true }
}

export type TurnOutcome =
  | { kind: 'error'; reason: string }
  | { kind: 'refusal' }
  | { kind: 'aborted' }
  | { kind: 'answer' }

/** The end of a turn: an error, a refusal, Esc, unfinished steps, or all done. */
export function finishTurn(checklist: CleanViewChecklist, outcome: TurnOutcome, now: number): CleanViewChecklist {
  if (checklist.finishedAt !== null || checklist.phase === 'idle') return checklist

  if (outcome.kind === 'error') return { ...markStuckAlways(checklist, outcome.reason), finishedAt: now }
  if (outcome.kind === 'refusal') return { ...markStuckAlways(checklist, REASONS.refusal), finishedAt: now }
  // The person turned a step down: keep saying so rather than "Stopped".
  if (checklist.phase === 'stuck' && checklist.stuckReason === REASONS.saidNo) return checklist
  if (outcome.kind === 'aborted') {
    return { ...checklist, phase: 'stopped', needsYouReason: null, stuckReason: null, finishedAt: now }
  }

  const hasUnfinishedSteps = checklist.hasPlan && checklist.tasks.some(task => task.status !== 'done')
  if (hasUnfinishedSteps) {
    return { ...checklist, phase: 'needsYou', needsYouReason: REASONS.waitingForReply, stuckReason: null }
  }

  return {
    ...checklist,
    phase: 'done',
    tasks: checklist.tasks.map(task => ({ ...task, status: 'done' as const, percent: 100 })),
    needsYouReason: null,
    stuckReason: null,
    finishedAt: now,
    isCollapsed: false,
  }
}

function markStuckAlways(checklist: CleanViewChecklist, reason: string): CleanViewChecklist {
  return { ...checklist, phase: 'stuck', stuckReason: reason, needsYouReason: null }
}

/** One calm sentence for an API error, from its kind, details and message. */
export function describeApiError(errorText: string): string {
  const text = errorText.toLowerCase()
  if (/rate.?limit|usage limit|\b429\b|quota/.test(text)) return REASONS.rateLimit
  if (/overload|\b529\b|server.?error|\b50[0234]\b|unavailable/.test(text)) return REASONS.busy
  if (/prompt is too long|too many tokens|context (window|length|limit)|exceeds? the (model'?s )?context/.test(text)) {
    return REASONS.tooLong
  }
  if (/billing|credit balance|payment/.test(text)) return REASONS.billing
  if (/auth|oauth|log ?in\b|\b401\b|\b403\b|credential|api.?key|verification_required|account_on_hold/.test(text)) {
    return REASONS.login
  }
  if (/network|connect|econn|enotfound|etimedout|socket|fetch failed|offline|dns/.test(text)) return REASONS.network

  return REASONS.unknownError
}

/** Which "Needs you" reason a notification means, if any. */
export function notificationReason(notificationType: string, message: string): string | null {
  if (/idle|auth_success/i.test(notificationType)) return null
  const combined = `${notificationType} ${message}`.toLowerCase()
  if (combined.includes('permission')) return REASONS.permission
  if (/elicitation|question/.test(combined)) return REASONS.question

  return null
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** "45s", "1m 12s", "1h 3m". */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`

  return `${seconds}s`
}

/** True when a tree shows any non-blank text or any Button. Never changes the tree. */
export function hasVisibleContent(tree: RenderNode | null | undefined): boolean {
  if (tree === null || tree === undefined) return false
  if (typeof tree === 'string') return tree.trim() !== ''
  if (tree.type === 'Button') return true

  return childrenOf(tree).some(hasVisibleContent)
}

/** A tree's children; elements without any (the engine's own marker) give none. */
function childrenOf(tree: RenderElement): readonly RenderNode[] {
  return 'children' in tree ? (tree.children ?? []) : []
}

/** The direct child of a tree whose key matches, if any. */
function childWithKey(tree: RenderElement, key: string): RenderNode | undefined {
  return childrenOf(tree).find(
    child => typeof child !== 'string' && 'props' in child && (child.props as { key?: unknown } | undefined)?.key === key,
  )
}

/** A 10-cell meter filled to `percent`. */
function filledMeter(percent: number): string {
  const filledCells = Math.round((clampPercent(percent) / 100) * METER_CELLS)
  return '█'.repeat(filledCells) + '░'.repeat(METER_CELLS - filledCells)
}

/** A 10-cell meter with a 3-cell block bouncing across it. */
function sweepMeter(frame: number): string {
  const blockCells = 3
  const travel = METER_CELLS - blockCells
  const step = frame % (travel * 2)
  const start = step <= travel ? step : travel * 2 - step
  let meter = ''
  for (let cell = 0; cell < METER_CELLS; cell += 1) {
    meter += cell >= start && cell < start + blockCells ? '█' : '░'
  }

  return meter
}

/** Pads or cuts a name to exactly `width` cells so rows never wrap. */
function fitToWidth(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width)
  return text.slice(0, Math.max(0, width - 1)) + '…'
}

// ---------------------------------------------------------------------------
// Engine-facing helpers
// ---------------------------------------------------------------------------

type Engine = EngineInterface

/** Applies a change to the current job (if any) and keeps the animation timer in step. */
async function changeChecklist(
  $: Engine,
  change: (checklist: CleanViewChecklist) => CleanViewChecklist,
): Promise<CleanViewChecklist | null> {
  const changed = await update($, checklistAtom, checklist => (checklist === null ? null : change(checklist)))
  await syncAnimationTimer($)

  return changed
}

/** Runs the 250ms frame clock only while a step is working; a paused sweep just stops. */
async function syncAnimationTimer($: Engine): Promise<void> {
  const isEnabled = await read($, enabledAtom)
  const checklist = await read($, checklistAtom)
  const shouldAnimate = isEnabled && checklist !== null && checklist.phase === 'working'

  if (shouldAnimate && animationTimer === undefined) {
    animationTimer = $.clock.every(TICK_MS, () => {
      void update($, tickAtom, frame => frame + 1)
    })
  } else if (!shouldAnimate && animationTimer !== undefined) {
    animationTimer.cancel()
    animationTimer = undefined
  }
}

/** Shrinks a finished job to one line after five seconds. */
function scheduleCollapse($: Engine, jobId: number, delayMs: number): void {
  $.clock.after(Math.max(1, delayMs), () => {
    void update($, checklistAtom, checklist =>
      checklist !== null && checklist.jobId === jobId && checklist.phase === 'done'
        ? { ...checklist, isCollapsed: true }
        : checklist,
    )
  })
}

/** When the last helper ends after the main turn did, the job finishes as an answered turn does. */
async function finishJobIfHelpersDone($: Engine): Promise<void> {
  if (isMainTurnRunning) return
  const now = await $.clock.now()
  let wasWaiting = false
  const finished = await changeChecklist($, checklist => {
    wasWaiting = checklist.phase === 'working' && workingHelperCount(checklist) === 0
    return wasWaiting ? finishTurn(checklist, { kind: 'answer' }, now) : checklist
  })
  if (wasWaiting && finished !== null && finished.phase === 'done' && !finished.isCollapsed) {
    scheduleCollapse($, finished.jobId, COLLAPSE_AFTER_MS)
  }
}

/** Asks Haiku for a short job name in the background; a newer job wins. */
function scheduleJobNaming($: Engine, jobId: number, promptText: string): void {
  $.clock.after(1, () => {
    void nameJob($, jobId, promptText)
  })
}

async function nameJob($: Engine, jobId: number, promptText: string): Promise<void> {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 32,
      timeoutMs: 15000,
      system:
        'You name jobs for a progress checklist. Reply with the name only: 2 to 6 plain English words, ' +
        'starting with a verb, with no quotes, file names, code or ending punctuation.',
      prompt: `Name this request:\n\n${promptText.slice(0, 2000)}`,
    })
    if (!reply.isAnswered) return

    const title = cleanJobTitle(reply.text)
    if (title === FALLBACK_NAME) return
    await update($, checklistAtom, checklist =>
      checklist !== null && checklist.jobId === jobId ? { ...checklist, title } : checklist,
    )
  } catch {
    // Naming is a nicety: the placeholder title stays.
  }
}

/** Turns Clean View on, off or over; saves the choice and says so. */
async function setCleanView($: Engine, wanted: boolean | 'flip'): Promise<boolean> {
  const isEnabled = await update($, enabledAtom, current => (wanted === 'flip' ? !current : wanted))
  try {
    await $.store.set(STORE_KEY, isEnabled)
  } catch {
    // The choice still holds for this session.
  }
  showToast($, isEnabled ? 'Clean View is on. Tool details are hidden.' : 'Clean View is off. Showing everything.')
  await syncAnimationTimer($)

  return isEnabled
}

function showToast($: Engine, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // A toast that cannot show is no reason to fail the toggle.
  }
}

function readStepList(rawSteps: unknown): string[] {
  return Array.isArray(rawSteps) ? rawSteps.filter((step): step is string => typeof step === 'string') : []
}

// ---------------------------------------------------------------------------
// Drawing the band
// ---------------------------------------------------------------------------

type BandInput = RenderInput<'AbovePrompt'>

type TextElement = ElementConstructor<TextProps>
type BoxElement = ElementConstructor<BoxProps>

/** What a row needs to line its columns up. */
type RowLayout = { nameWidth: number; rowWidth: number; frame: number }

/** A piece of the header line; the cuttable one gives way when the line is too long. */
type HeaderSegment = {
  text: string
  weight?: 'bold'
  color?: string
  backgroundColor?: string
  isDim?: boolean
  isCuttable?: boolean
}

/** The header line for each state of the job, as pieces. */
function headerSegments(checklist: CleanViewChecklist, now: number, waitingHelpers: number): HeaderSegment[] {
  switch (checklist.phase) {
    case 'needsYou':
      return [
        { text: ' Needs you ', backgroundColor: 'warning', color: 'inverseText', weight: 'bold' },
        { text: ' ' },
        { text: checklist.needsYouReason ?? REASONS.waitingForReply, isCuttable: true },
      ]
    case 'stuck':
      return [
        { text: '⚠ Stuck:', color: 'warning', weight: 'bold' },
        { text: ' ' },
        { text: checklist.stuckReason ?? REASONS.unknownError, isCuttable: true },
      ]
    case 'stopped':
      return [
        { text: '■ Stopped', weight: 'bold' },
        { text: ` · ${checklist.title} · you pressed Esc`, isDim: true, isCuttable: true },
      ]
    case 'done':
      return [
        { text: '✓ All done', color: 'success', weight: 'bold' },
        {
          text: ` · ${checklist.title} · took ${formatDuration((checklist.finishedAt ?? now) - checklist.startedAt)}`,
          isDim: true,
          isCuttable: true,
        },
      ]
    default:
      return [
        { text: checklist.title, weight: 'bold', isCuttable: true },
        ...(waitingHelpers > 0
          ? [{ text: ` · Waiting for ${waitingHelpers} ${waitingHelpers === 1 ? 'helper' : 'helpers'}`, isDim: true }]
          : []),
        { text: ` · ${formatDuration(now - checklist.startedAt)}`, isDim: true },
      ]
  }
}

/** Cuts the cuttable piece with … so the whole line fits in `maxCells`. */
function fitSegments(segments: readonly HeaderSegment[], maxCells: number): HeaderSegment[] {
  const totalCells = segments.reduce((sum, segment) => sum + segment.text.length, 0)
  const excessCells = totalCells - maxCells
  if (excessCells <= 0) return [...segments]

  return segments.map(segment =>
    segment.isCuttable === true
      ? { ...segment, text: segment.text.slice(0, Math.max(1, segment.text.length - excessCells - 1)).trimEnd() + '…' }
      : segment,
  )
}

function drawSegments(Text: TextElement, segments: readonly HeaderSegment[]): RenderElement {
  return (
    <Text>
      {segments.map(segment => {
        const style: TextProps = {}
        if (segment.color !== undefined) style.color = segment.color
        if (segment.backgroundColor !== undefined) style.backgroundColor = segment.backgroundColor
        if (segment.weight !== undefined) style.weight = segment.weight
        if (segment.isDim === true) style.dimColor = true
        return <Text {...style}>{segment.text}</Text>
      })}
    </Text>
  )
}

/** How many cells a tree takes in a row: its text, and a Button's label with its brackets. */
function contentWidth(tree: RenderNode | undefined): number {
  if (tree === undefined) return 0
  if (typeof tree === 'string') return tree.length
  if (tree.type === 'Button') return String((tree.props as { label?: unknown }).label ?? '').length + 4

  return childrenOf(tree).reduce((sum, child) => sum + contentWidth(child), 0)
}

/** How many helpers the job waits on once the main turn has ended. */
function waitingHelperCount(checklist: CleanViewChecklist): number {
  return checklist.phase === 'working' && !isMainTurnRunning ? workingHelperCount(checklist) : 0
}

/** Up to five helper rows for one step, then one dim line for the rest. */
function drawHelperRows(
  Box: BoxElement,
  Text: TextElement,
  stepHelpers: readonly CleanViewHelper[],
  { nameWidth, rowWidth, frame }: RowLayout,
): RenderElement[] {
  // Helpers still needing a look come first, finished ones after.
  const isFinished = (helper: CleanViewHelper) => helper.status === 'done'
  const ordered = [...stepHelpers.filter(helper => !isFinished(helper)), ...stepHelpers.filter(isFinished)]
  const shown = ordered.slice(0, MAX_HELPER_ROWS)
  const hidden = ordered.slice(MAX_HELPER_ROWS)

  const rows: RenderElement[] = shown.map((helper, index) => {
    const isLastRow = index === shown.length - 1 && hidden.length === 0
    const name = fitToWidth(helper.name, nameWidth - 2)
    const glyph = <Text dimColor>{`  ${isLastRow ? '└' : '├'} `}</Text>
    let nameText: RenderElement = <Text>{name}</Text>
    let meter: RenderElement = <Text color="claude">{helper.hasReported ? filledMeter(helper.percent) : sweepMeter(frame)}</Text>
    let label: RenderElement = <Text>{helper.hasReported ? `${helper.percent}%` : 'Working'}</Text>
    if (helper.status === 'done') {
      nameText = <Text dimColor>{name}</Text>
      meter = <Text color="success">{filledMeter(100)}</Text>
      label = <Text dimColor>Done</Text>
    } else if (helper.status === 'stuck') {
      meter = <Text color="warning">{filledMeter(helper.percent)}</Text>
      label = <Text color="warning">Stuck</Text>
    } else if (helper.status === 'idle') {
      meter = <Text dimColor>{filledMeter(helper.percent)}</Text>
      label = <Text dimColor>Idle</Text>
    }

    return (
      <Box key={`helper-${helper.id}`} width={rowWidth}>
        <Text wrap="truncate-end">
          {glyph}
          {nameText} {meter}
          {'  '}
          {label}
        </Text>
      </Box>
    )
  })

  if (hidden.length > 0) {
    const hiddenDoneCount = hidden.filter(isFinished).length
    rows.push(
      <Box key="helper-more" width={rowWidth}>
        <Text dimColor wrap="truncate-end">
          {'  '}└ +{hidden.length} more helpers · {hiddenDoneCount} done
        </Text>
      </Box>,
    )
  }

  return rows
}

async function drawBand($: Engine, e: BandInput, beneath: RenderElement | undefined): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isEnabled = await read($, enabledAtom)
  const checklist = await read($, checklistAtom)
  const frame = await read($, tickAtom)
  const bodyColumns = Math.max(24, e.props.bodyColumns)

  const toggleLabel = isEnabled ? '● Clean View: ON' : '○ Clean View: OFF'
  const toggleButton = (
    <Button
      key="toggle"
      label={toggleLabel}
      onPress={() => {
        void setCleanView($, 'flip')
      }}
    />
  )

  // What a hook beneath offers: its corner and body slots, or a whole tree to show under the rows.
  const slots = beneath !== undefined && beneath.type === 'Box' && beneath.props?.key === 'band-slots' ? beneath : undefined
  const cornerContent = slots === undefined ? undefined : childWithKey(slots, 'corner')
  const bodyContent = slots === undefined ? undefined : childWithKey(slots, 'body')
  const extraTree = slots === undefined && hasVisibleContent(beneath) ? beneath : undefined
  const beneathRows = extraTree === undefined ? [] : [<Box key="band-beneath">{extraTree}</Box>]

  // The header never outgrows the band: it leaves room for the toggle, the corner and the box.
  const toggleCells = toggleLabel.length + 4
  const cornerCells = cornerContent === undefined ? 0 : contentWidth(cornerContent) + 1
  const headerCells = Math.max(10, bodyColumns - BOX_CHROME_COLUMNS - toggleCells - cornerCells - 2)

  const showsJob = isEnabled && checklist !== null && checklist.phase !== 'idle'
  const header = showsJob
    ? drawSegments(Text, fitSegments(headerSegments(checklist, await $.clock.now(), waitingHelperCount(checklist)), headerCells))
    : <Text dimColor>Ready</Text>

  // The box hugs its widest row; the spacer pushes the toggle and corner to its right edge.
  const headerRow = (
    <Box key="band-header" flexDirection="row">
      <Box flexShrink={0}>{header}</Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} flexDirection="row" marginLeft={2}>
        {toggleButton}
        <Box key="band-corner" flexDirection="row" flexShrink={0} marginLeft={cornerContent === undefined ? 0 : 1}>
          {cornerContent}
        </Box>
      </Box>
    </Box>
  )
  const bodySlot = (
    <Box key="band-body" flexDirection="column" alignItems="flex-end">
      {bodyContent}
    </Box>
  )
  const drawFrame = (children: RenderNode[]) => (
    <Box flexDirection="column" alignItems="flex-start">
      <Box key="band-frame" flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
        {children}
      </Box>
    </Box>
  )
  if (!showsJob || checklist.isCollapsed) return drawFrame([headerRow, bodySlot, ...beneathRows])

  // "Step 3 of 5" and one parallelogram per step: filled for done steps.
  const helpers = helpersOf(checklist)
  const stepCount = checklist.tasks.length
  const doneCount = checklist.tasks.filter(task => task.status === 'done').length
  const stepLabel = `Step ${Math.min(stepCount, doneCount + 1)} of ${stepCount}`
  const progressRow = (
    <Box key="band-progress" width={stepLabel.length + 2 + stepCount}>
      <Text>
        {stepLabel}
        {'  '}
        <Text color="claude">{'▰'.repeat(doneCount)}</Text>
        <Text dimColor>{'▱'.repeat(stepCount - doneCount)}</Text>
      </Text>
    </Box>
  )

  // Size the name column to the longest name (helpers sit two cells further in) that fits beside the meter.
  const longestName = Math.max(
    ...checklist.tasks.map(task => task.name.length),
    ...helpers.map(helper => helper.name.length + 2),
    8,
  )
  const nameWidth = Math.max(6, Math.min(longestName, MAX_NAME_LENGTH, bodyColumns - BOX_CHROME_COLUMNS - ROW_CHROME_CELLS))
  const rowWidth = 2 + nameWidth + 1 + METER_CELLS + 2 + LABEL_CELLS
  const rowLayout: RowLayout = { nameWidth, rowWidth, frame }
  const isWorking = checklist.phase === 'working'
  const isPaused = checklist.phase === 'needsYou'
  const firstUpcomingId = checklist.tasks.find(task => task.status === 'upcoming')?.id
  const stepIds = new Set(checklist.tasks.map(task => task.id))

  const rows = checklist.tasks.flatMap((task, taskIndex) => {
    const name = fitToWidth(task.name, nameWidth)
    let stepRow: RenderElement
    if (task.status === 'done') {
      stepRow = (
        <Box key={`row-${task.id}`} width={rowWidth}>
          <Text wrap="truncate-end">
            <Text color="success">✓</Text> <Text dimColor>{name}</Text>{' '}
            <Text color="success">{filledMeter(100)}</Text>{'  '}
            <Text dimColor>Done</Text>
          </Text>
        </Box>
      )
    } else if (task.status === 'active') {
      // Helpers' combined progress fills the meter until the step reports its own.
      const stepProgress = stepPercent(task, helpers)
      const meter = stepProgress.hasProgress ? filledMeter(stepProgress.percent) : sweepMeter(isWorking ? frame : 0)
      stepRow = (
        <Box key={`row-${task.id}`} width={rowWidth}>
          <Text wrap="truncate-end">
            <Text color={isPaused ? 'warning' : 'claude'}>{isPaused ? '‖' : '▶'}</Text>{' '}
            <Text weight="bold">{name}</Text> <Text color="claude">{meter}</Text>{'  '}
            <Text>{stepProgress.hasProgress ? `${stepProgress.percent}%` : 'Working'}</Text>
          </Text>
        </Box>
      )
    } else {
      stepRow = (
        <Box key={`row-${task.id}`} width={rowWidth}>
          <Text wrap="truncate-end" dimColor>
            ○ {name} {'░'.repeat(METER_CELLS)}
            {'  '}
            {task.id === firstUpcomingId ? 'Next' : 'Up next'}
          </Text>
        </Box>
      )
    }

    // Helper rows hang under their step while it is active or a helper still works; none once done.
    const isLastStep = taskIndex === checklist.tasks.length - 1
    const stepHelpers = helpers.filter(
      helper => helper.stepId === task.id || (isLastStep && (helper.stepId === null || !stepIds.has(helper.stepId))),
    )
    const showsHelpers =
      checklist.phase !== 'done' &&
      stepHelpers.length > 0 &&
      (task.status === 'active' || stepHelpers.some(helper => helper.status === 'working'))
    if (!showsHelpers) return [stepRow]

    return [stepRow, ...drawHelperRows(Box, Text, stepHelpers, { ...rowLayout, frame: isWorking ? frame : 0 })]
  })

  return drawFrame([
    headerRow,
    bodySlot,
    progressRow,
    <Box key="band-rows" flexDirection="column">
      {rows}
    </Box>,
    ...beneathRows,
  ])
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function registerCleanView(on: On): void {
  // Session start: restore the saved choice, register the tools and /simple, resume timers.
  on('session.start', async ($, e, next) => {
    try {
      const savedChoice = await $.store.get(STORE_KEY)
      if (typeof savedChoice === 'boolean') await update($, enabledAtom, () => savedChoice)
    } catch {
      // No saved choice: Clean View starts on.
    }

    await $.tool.register({
      name: PLAN_TOOL_NAME,
      description:
        'Lay out every step of the current job up front, before any other tool: 2 to 8 short plain-English ' +
        'names in order, each under 40 characters and starting with a verb (like "Build the pricing section"). ' +
        'Never put file paths, file names, commands, code or tool names in a step. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: MAX_PLAN_STEPS,
            description: 'Every step of the job, in order.',
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: REPORT_TOOL_NAME,
      description:
        "Report progress on the current step of the plan: the step's name and a percent from 0 to 100. " +
        'Reporting a step checks off every step before it; 100 finishes it and starts the next one. ' +
        'A name that is not in the plan becomes a new step.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name, as planned.' },
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'How far along the step is.' },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    areToolsRegistered = true

    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (no argument switches it)',
      argumentHint: 'on|off',
      immediate: true,
    })

    // A reload drops timers: pick the animation and any pending collapse back up.
    await syncAnimationTimer($)
    const checklist = await read($, checklistAtom)
    if (checklist !== null && checklist.phase === 'done' && !checklist.isCollapsed && checklist.finishedAt !== null) {
      const elapsedSinceDone = (await $.clock.now()) - checklist.finishedAt
      scheduleCollapse($, checklist.jobId, COLLAPSE_AFTER_MS - elapsedSinceDone)
    }

    // Helpers that ended while the plugin was away settle from the engine's list.
    try {
      const agents = await $.agent.list()
      const now = await $.clock.now()
      await changeChecklist($, current => settleHelpers(current, agents, now))
    } catch {
      // Rows stay as they were.
    }

    return next(e)
  })

  // Tell Claude to plan in plain English while Clean View is on.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const offersPlanTool = e.tools.includes(PLAN_TOOL) || e.tools.includes('ToolSearch')
    if (!areToolsRegistered || !offersPlanTool || e.traits.includes('teammate')) return composed
    if (!(await read($, enabledAtom))) return composed

    return {
      sections: [...composed.sections, { id: 'clean-view:checklist', text: CHECKLIST_PROMPT, scope: 'session' }],
    }
  })

  // Note whether the next turn comes from a typed prompt or a slash command.
  on('prompt.submit', async ($, e, next) => {
    // A plugin that sends the person's own words (asUser), like Prompt Upgrade's Run, starts a job too.
    const isSentAsPerson = e.origin.kind === 'plugin' && e.origin.asUser === true
    const isPersonsRequest = !e.isMeta && (NEW_JOB_ORIGINS.has(e.origin.kind) || isSentAsPerson)
    lastSubmitKind = e.command !== undefined ? 'command' : isPersonsRequest ? 'prompt' : undefined

    const submitted = await next(e)
    // A prompt another mod held back never starts a turn, so it must not mark the next one.
    if (submitted.drop !== undefined) lastSubmitKind = undefined
    return submitted
  }).catch(($, e, next) => next(e))

  // A real prompt while nothing is running starts a new job; a reply resumes a waiting one.
  on('turn.start', async ($, e, next) => {
    // A helper's turn: its row is working again.
    const helperAgentId = e.agentId
    if (helperAgentId !== undefined) {
      await changeChecklist($, checklist => startHelperTurn(checklist, helperAgentId))
      return next(e)
    }
    isMainTurnRunning = true

    const submitKind = lastSubmitKind
    lastSubmitKind = undefined
    failedCallsInRow = 0
    lastApiErrorText = ''

    const promptText = e.text.trim()
    // Only a typed prompt starts a job; a meta or engine-made turn (a helper's report) carries on the current one.
    const isRealPrompt = promptText !== '' && !promptText.startsWith('/') && submitKind === 'prompt'
    const current = await read($, checklistAtom)
    const isWaitingOnPerson =
      current !== null &&
      (current.phase === 'needsYou' || (current.phase === 'stuck' && current.stuckReason === REASONS.saidNo))

    if (!isRealPrompt || isWaitingOnPerson) {
      await changeChecklist($, checklist =>
        isWaitingOnPerson
          ? { ...checklist, phase: 'working', needsYouReason: null, stuckReason: null, finishedAt: null }
          : checklist,
      )
      return next(e)
    }

    const job = startJob(current?.jobId ?? 0, await $.clock.now())
    await update($, checklistAtom, () => job)
    await syncAnimationTimer($)
    if (await read($, enabledAtom)) scheduleJobNaming($, job.jobId, promptText)

    return next(e)
  })

  // Every tool call: answer our own tools, gate on a plan, track waits, failures and to-dos.
  on('tool.call', async ($, e, next) => {
    const toolName = String(e.tool)
    const callInput = e as unknown as Record<string, unknown>

    if (toolName === PLAN_TOOL || toolName === REPORT_TOOL) {
      const reportingAgentId = e.agentId
      if (reportingAgentId !== undefined) {
        if (toolName === PLAN_TOOL) {
          return { result: 'Only the main conversation keeps the checklist. Carry on with your task.' }
        }
        // A helper's report lands on its row; one with no row gets the same answer.
        const helperPercent = clampPercent(callInput.percent)
        await changeChecklist($, checklist => reportHelperProgress(checklist, reportingAgentId, helperPercent))
        return { result: `Progress noted: ${helperPercent}%.` }
      }
      const now = await $.clock.now()
      if (toolName === PLAN_TOOL) {
        const steps = readStepList(callInput.steps)
        if (steps.length === 0) return { deny: `${PLAN_TOOL} needs "steps": a list of 2 to 8 short step names.` }
        const planned = await update($, checklistAtom, checklist =>
          applyPlan(reopen(clearStuck(clearNeedsYou(checklist ?? startJob(0, now)))), steps),
        )
        await syncAnimationTimer($)
        return { result: `Planned ${planned?.tasks.length ?? 0} steps. The first one has started.` }
      }
      const percent = clampPercent(callInput.percent)
      await update($, checklistAtom, checklist =>
        applyProgress(reopen(clearStuck(clearNeedsYou(checklist ?? startJob(0, now)))), callInput.task, percent),
      )
      await syncAnimationTimer($)
      return { result: `Progress noted: ${percent}%.` }
    }

    // Subagents and other plugins' calls pass untouched.
    if (e.agentId !== undefined) return next(e)
    const isModelCall = next.origin.plugin === 'engine'

    // Plan first: until a real plan exists, only the planning tools run.
    if (isModelCall && areToolsRegistered && !ALWAYS_ALLOWED_TOOLS.has(toolName)) {
      const isEnabled = await read($, enabledAtom)
      const checklist = await read($, checklistAtom)
      if (isEnabled && checklist?.hasPlan !== true) return { deny: GATE_MESSAGE }
    }

    // A tool running means any earlier ask was answered; a question asks again.
    await changeChecklist($, checklist =>
      toolName === 'AskUserQuestion' ? markNeedsYou(checklist, REASONS.question) : clearNeedsYou(checklist),
    )

    // An Agent call from the main chat is a helper: a working row before it runs.
    const helperCallId = e.tool === 'Agent' ? e.tool_use_id : undefined
    if (e.tool === 'Agent') {
      const startedAt = await $.clock.now()
      await changeChecklist($, checklist => addHelper(checklist, e.tool_use_id, e.description, startedAt))
    }

    const ran = await next(e)
    if (ran.deny !== undefined) {
      if (helperCallId !== undefined) await changeChecklist($, checklist => removeHelper(checklist, helperCallId))
      return ran
    }

    if (ran.isError === true) {
      if (helperCallId !== undefined) {
        const failedAt = await $.clock.now()
        await changeChecklist($, checklist => markHelperStuck(checklist, helperCallId, failedAt))
      }
      const errorText = `${ran.text ?? ''} ${typeof ran.result === 'string' ? ran.result : ''}`
      if (USER_SAID_NO.test(errorText)) {
        failedCallsInRow = 0
        await changeChecklist($, checklist => markStuck(checklist, REASONS.saidNo))
      } else {
        failedCallsInRow += 1
        if (failedCallsInRow >= FAILS_BEFORE_STUCK) {
          await changeChecklist($, checklist => markStuck(checklist, REASONS.keepsFailing))
        } else if (toolName === 'AskUserQuestion') {
          await changeChecklist($, clearNeedsYou)
        }
      }
      return ran
    }

    // A success clears Stuck and Needs you, and to-do tools become checklist rows.
    failedCallsInRow = 0
    const launched = ran.result as { agentId?: unknown; agent_id?: unknown } | undefined
    const launchedAgentId = launched?.agentId ?? launched?.agent_id
    await changeChecklist($, checklist => {
      const resumed = clearStuck(clearNeedsYou(checklist))
      if (helperCallId !== undefined && typeof launchedAgentId === 'string') {
        return linkHelperAgent(resumed, helperCallId, launchedAgentId)
      }
      if (e.tool === 'TodoWrite') return applyTodos(resumed, e.todos)
      if (e.tool === 'TaskCreate') {
        const created = ran.result as { task?: { id?: unknown } } | undefined
        const taskId = created?.task?.id
        const rowId = typeof taskId === 'string' || typeof taskId === 'number' ? String(taskId) : `new-${resumed.tasks.length + 1}`
        return applyTaskCreate(resumed, rowId, e.subject)
      }
      if (e.tool === 'TaskUpdate') return applyTaskUpdate(resumed, e.taskId, e.status, e.subject)
      return resumed
    })

    return ran
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const toolName = String(e.tool)
    // Never strand Claude: our own tools still answer, other tools still run.
    if (toolName === PLAN_TOOL) return { result: 'Planned the steps. The first one has started.' }
    if (toolName === REPORT_TOOL) return { result: 'Progress noted.' }
    return next(e)
  })

  // Permission prompts and questions: Needs you, right away.
  on('classic.PermissionRequest', async ($, e, next) => {
    await changeChecklist($, checklist => markNeedsYou(checklist, REASONS.permission))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const reason = notificationReason(e.notification_type, e.message)
    if (reason !== null) await changeChecklist($, checklist => markNeedsYou(checklist, reason))
    return next(e)
  }).catch(($, e, next) => next(e))

  // API errors: remember the kind; refine a stuck reason if the details arrive late.
  on('classic.StopFailure', async ($, e, next) => {
    lastApiErrorText = `${e.error} ${e.error_details ?? ''}`
    const refinedReason = describeApiError(lastApiErrorText)
    await changeChecklist($, checklist =>
      checklist.phase === 'stuck' && API_ERROR_REASONS.has(checklist.stuckReason ?? '')
        ? { ...checklist, stuckReason: refinedReason }
        : checklist,
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  // The end of a turn: error, refusal, Esc, waiting for a reply, or all done.
  on('turn.complete', async ($, e, next) => {
    // A helper's turn ended: its row is done or stuck, and the last one may finish the job.
    const helperAgentId = e.agentId
    if (helperAgentId !== undefined) {
      const isStuck = e.reason !== 'answer' || e.isAborted
      const helperEndedAt = await $.clock.now()
      await changeChecklist($, checklist => endHelperTurn(checklist, helperAgentId, isStuck, helperEndedAt))
      await finishJobIfHelpersDone($)
      return next(e)
    }
    isMainTurnRunning = false

    const outcome: TurnOutcome =
      e.reason === 'error'
        ? { kind: 'error', reason: describeApiError(`${lastApiErrorText} ${e.answer}`) }
        : e.reason === 'refusal'
          ? { kind: 'refusal' }
          : e.isAborted || e.reason === 'aborted'
            ? { kind: 'aborted' }
            : { kind: 'answer' }
    // An answer while helpers still work does not end the job; the last helper's end does.
    if (outcome.kind === 'answer') {
      const current = await read($, checklistAtom)
      if (current !== null && current.phase === 'working' && workingHelperCount(current) > 0) {
        await syncAnimationTimer($)
        return next(e)
      }
    }

    const now = await $.clock.now()
    const finished = await changeChecklist($, checklist => finishTurn(checklist, outcome, now))
    if (finished !== null && finished.phase === 'done' && !finished.isCollapsed) {
      scheduleCollapse($, finished.jobId, COLLAPSE_AFTER_MS)
    }

    return next(e)
  })

  // A helper the main chat spawned: link its agent id to its row.
  on('agent.spawn', { subagentType: /^/ }, async ($, e, next) => {
    const spawned = await next(e)
    const spawnedAgentId = spawned.agentId
    if (spawned.deny === undefined && spawnedAgentId !== undefined && e.parentAgentId === undefined && e.workflow === undefined) {
      await changeChecklist($, checklist => linkHelperAgent(checklist, e.tool_use_id, spawnedAgentId))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  // The band above the prompt: the checklist and the on/off button, with room for what a hook beneath adds.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const beneath = await next(e)
    return drawBand($, e, beneath ?? undefined)
  })

  // Hide the technical rows while Clean View is on.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // /simple on|off, or /simple alone to switch.
  on('command.run', { command: 'simple' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    if (wanted !== '' && wanted !== 'on' && wanted !== 'off') {
      return { text: 'Type /simple on, /simple off, or just /simple to switch.' }
    }
    const isEnabled = await setCleanView($, wanted === '' ? 'flip' : wanted === 'on')
    return { text: isEnabled ? 'Clean View is on.' : 'Clean View is off.' }
  })
}
