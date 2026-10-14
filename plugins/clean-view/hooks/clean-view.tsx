// Clean View: hides tool rows and shows a calm checklist of Claude's plan above the prompt.
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, On, RenderElement, RenderInput, TextProps, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask, CleanViewTaskStatus } from '../types'

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
- Never put file paths, file names, commands, code or tool names in a step name.`

// Text a tool result carries when the person turned down a permission prompt.
const USER_SAID_NO = /user doesn't want to (proceed|take this action)|tool use was rejected|the user (rejected|denied|declined)/i

// File names with a code or config extension, which never belong in a step name.
const CODE_FILE_NAME =
  /^[\w.@-]*\w\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|css|scss|sass|less|html?|json|jsonc|ya?ml|toml|md|mdx|sh|bash|zsh|ps1|sql|vue|svelte|astro|xml|lock|env|ini|cfg|conf|txt|csv|ipynb|dart|lua|scala|exs?|hs|gradle|tf|graphql|proto|prisma)$/i

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

/** Runs the 250ms frame clock only while a job is working or waiting on the person. */
async function syncAnimationTimer($: Engine): Promise<void> {
  const isEnabled = await read($, enabledAtom)
  const checklist = await read($, checklistAtom)
  const shouldAnimate =
    isEnabled && checklist !== null && (checklist.phase === 'working' || checklist.phase === 'needsYou')

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

async function drawBand($: Engine, e: BandInput): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isEnabled = await read($, enabledAtom)
  const checklist = await read($, checklistAtom)
  const frame = await read($, tickAtom)
  const bodyColumns = Math.max(24, e.props.bodyColumns)

  const toggleButton = (
    <Button
      key="toggle"
      label={isEnabled ? '● Clean View: ON' : '○ Clean View: OFF'}
      onPress={() => {
        void setCleanView($, 'flip')
      }}
    />
  )

  const showsJob = isEnabled && checklist !== null && checklist.phase !== 'idle'
  const header = showsJob ? drawHeader(Text, checklist, await $.clock.now()) : <Text> </Text>
  const headerRow = (
    <Box flexDirection="row" width={bodyColumns}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {header}
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        {toggleButton}
      </Box>
    </Box>
  )
  if (!showsJob || checklist.isCollapsed) return <Box flexDirection="column">{headerRow}</Box>

  // Size the name column to the longest name that fits beside the meter.
  const longestName = Math.max(...checklist.tasks.map(task => task.name.length), 8)
  const nameWidth = Math.max(6, Math.min(longestName, MAX_NAME_LENGTH, bodyColumns - ROW_CHROME_CELLS))
  const firstUpcomingId = checklist.tasks.find(task => task.status === 'upcoming')?.id

  const rows = checklist.tasks.map(task => {
    const name = fitToWidth(task.name, nameWidth)
    if (task.status === 'done') {
      return (
        <Box key={`row-${task.id}`}>
          <Text wrap="truncate-end">
            <Text color="success">✓</Text> <Text dimColor>{name}</Text>{' '}
            <Text color="success">{filledMeter(100)}</Text>{'  '}
            <Text dimColor>Done</Text>
          </Text>
        </Box>
      )
    }
    if (task.status === 'active') {
      const isPaused = checklist.phase === 'needsYou'
      const meter = task.hasReported
        ? filledMeter(task.percent)
        : sweepMeter(checklist.phase === 'working' ? frame : 0)
      return (
        <Box key={`row-${task.id}`}>
          <Text wrap="truncate-end">
            <Text color={isPaused ? 'warning' : 'claude'}>{isPaused ? '‖' : '▶'}</Text>{' '}
            <Text weight="bold">{name}</Text> <Text color="claude">{meter}</Text>{'  '}
            <Text>{task.hasReported ? `${task.percent}%` : 'Working'}</Text>
          </Text>
        </Box>
      )
    }
    return (
      <Box key={`row-${task.id}`}>
        <Text wrap="truncate-end" dimColor>
          ○ {name} {'░'.repeat(METER_CELLS)}
          {'  '}
          {task.id === firstUpcomingId ? 'Next' : 'Up next'}
        </Text>
      </Box>
    )
  })

  return (
    <Box flexDirection="column">
      {headerRow}
      {rows}
    </Box>
  )
}

type TextElement = ElementConstructor<TextProps>

/** The header line for each state of the job. */
function drawHeader(Text: TextElement, checklist: CleanViewChecklist, now: number): RenderElement {
  switch (checklist.phase) {
    case 'needsYou':
      return (
        <Text wrap="truncate-end">
          <Text backgroundColor="warning" color="inverseText" weight="bold">
            {' Needs you '}
          </Text>{' '}
          {checklist.needsYouReason ?? REASONS.waitingForReply}
        </Text>
      )
    case 'stuck':
      return (
        <Text wrap="truncate-end">
          <Text color="warning" weight="bold">
            ⚠ Stuck:
          </Text>{' '}
          {checklist.stuckReason ?? REASONS.unknownError}
        </Text>
      )
    case 'stopped':
      return (
        <Text wrap="truncate-end">
          <Text weight="bold">■ Stopped</Text>
          <Text dimColor> · {checklist.title} · you pressed Esc</Text>
        </Text>
      )
    case 'done':
      return (
        <Text wrap="truncate-end">
          <Text color="success" weight="bold">
            ✓ All done
          </Text>
          <Text dimColor>
            {' '}
            · {checklist.title} · took {formatDuration((checklist.finishedAt ?? now) - checklist.startedAt)}
          </Text>
        </Text>
      )
    default:
      return (
        <Text wrap="truncate-end">
          <Text weight="bold">{checklist.title}</Text>
          <Text dimColor> · {formatDuration(now - checklist.startedAt)}</Text>
        </Text>
      )
  }
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
  on('prompt.submit', ($, e, next) => {
    lastSubmitKind = e.command !== undefined ? 'command' : e.isMeta ? undefined : 'prompt'
    return next(e)
  }).catch(($, e, next) => next(e))

  // A real prompt while nothing is running starts a new job; a reply resumes a waiting one.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const submitKind = lastSubmitKind
    lastSubmitKind = undefined
    failedCallsInRow = 0
    lastApiErrorText = ''

    const promptText = e.text.trim()
    const isRealPrompt = promptText !== '' && !promptText.startsWith('/') && submitKind !== 'command'
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
      if (e.agentId !== undefined) {
        return { result: 'Only the main conversation keeps the checklist. Carry on with your task.' }
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

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
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
    await changeChecklist($, checklist => {
      const resumed = clearStuck(clearNeedsYou(checklist))
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
    if (e.agentId !== undefined) return next(e)

    const outcome: TurnOutcome =
      e.reason === 'error'
        ? { kind: 'error', reason: describeApiError(`${lastApiErrorText} ${e.answer}`) }
        : e.reason === 'refusal'
          ? { kind: 'refusal' }
          : e.isAborted || e.reason === 'aborted'
            ? { kind: 'aborted' }
            : { kind: 'answer' }
    const now = await $.clock.now()
    const finished = await changeChecklist($, checklist => finishTurn(checklist, outcome, now))
    if (finished !== null && finished.phase === 'done' && !finished.isCollapsed) {
      scheduleCollapse($, finished.jobId, COLLAPSE_AFTER_MS)
    }

    return next(e)
  })

  // The band above the prompt: the checklist and the on/off button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    return drawBand($, e)
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
