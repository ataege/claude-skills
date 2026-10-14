// Agent Dock's logic: everything that needs no engine, so tests can call it directly.
import type { DockCard, DockCardStatus, DockHelperModel, DockMission, DockSettings } from '../types'

// ---------------------------------------------------------------------------
// Sizes and limits
// ---------------------------------------------------------------------------

export const MIN_TEAM_SIZE = 1
export const MAX_TEAM_SIZE = 100
// Sizes above this need a confirmation and never carry over to a new session.
export const BIG_TEAM_SIZE = 20
export const PRESET_SIZES: readonly number[] = [1, 3, 5, 10, 20, 50, 100]
// Up to this many helpers show as full cards; more become small tiles.
export const CARD_LIMIT = 12
// Idle seats shown at most.
export const MAX_SEATS = 25
// Claude Code's own defaults when the settings name no limit.
export const DEFAULT_MAX_SUBAGENTS = 20
export const DEFAULT_MAX_TOOL_CONCURRENCY = 10

export const DEFAULT_DOCK_SETTINGS: DockSettings = {
  teamSize: 1,
  pendingSize: null,
  helperModel: 'auto',
  hasChosenHelperModel: false,
  isCustomOpen: false,
  isFolded: false,
}

/** A Team Size typed by the person: a whole number from 1 to 100, else null. */
export function parseSize(text: unknown): number | null {
  if (typeof text !== 'string' && typeof text !== 'number') return null
  const trimmed = String(text).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const size = Number(trimmed)

  return size >= MIN_TEAM_SIZE && size <= MAX_TEAM_SIZE ? size : null
}

/** The size a new session starts with: a big team never carries over. */
export function restoreSize(saved: unknown): number {
  const size = parseSize(typeof saved === 'number' ? String(saved) : saved)
  if (size === null) return MIN_TEAM_SIZE

  return size > BIG_TEAM_SIZE ? MIN_TEAM_SIZE : size
}

export function needsConfirmation(size: number): boolean {
  return size > BIG_TEAM_SIZE
}

function positiveWholeNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(String(value).trim()) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** How many helpers run at once: the lower of the two engine limits. */
export function helpersAtOnce(maxSubagents: unknown, maxToolConcurrency: unknown): number {
  const subagentLimit = positiveWholeNumber(maxSubagents) ?? DEFAULT_MAX_SUBAGENTS
  const toolLimit = positiveWholeNumber(maxToolConcurrency) ?? DEFAULT_MAX_TOOL_CONCURRENCY

  return Math.min(subagentLimit, toolLimit)
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

// Openers that carry no meaning in a job name.
const LEADING_FILLER =
  /^(please|pls|kindly|hey|hi|ok|okay|so|now|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|help me|let's|lets)\b[\s,]*/i

/** Cuts text at a word boundary so it, with its "…", fits in `maxLength`. */
export function trimWords(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const room = maxLength - 1
  let cut = text.slice(0, room)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > room / 3) cut = cut.slice(0, lastSpace)

  return cut.replace(/[\s,;:\-–—.]+$/, '') + '…'
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The job's name: the first clause of the request, about 40 characters. */
export function jobName(prompt: string): string {
  const firstLine = prompt.split('\n').find(line => line.trim() !== '') ?? ''
  let clause = firstLine.split(/[.!?;](?:\s|$)|,\s|:\s|\s[-–—]\s/)[0] ?? ''
  let previous = ''
  while (clause !== previous) {
    previous = clause
    clause = clause.trim().replace(LEADING_FILLER, '')
  }
  clause = clause.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim().replace(/[\s,;:.!?]+$/, '')
  if (clause === '') return 'Your request'

  return trimWords(capitalise(clause), 40)
}

/** A helper's task name: the first 3 to 5 words of its description. */
export function taskName(description: unknown): string {
  const words = String(description ?? '')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 5)
  if (words.length === 0) return 'Helper'

  return trimWords(capitalise(words.join(' ')), 30)
}

/** Two letters for a helper's badge: its task's first and last words. */
export function initials(task: string): string {
  const words = task.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  const first = words[0]
  const last = words[words.length - 1]
  if (first === undefined || last === undefined) return '··'
  const pair = words.length === 1 ? first.slice(0, 2) : (first[0] ?? '') + (last[0] ?? '')

  return pair.toUpperCase().padEnd(2, '·')
}

// The helper model choices, in the order the dock shows them.
export const HELPER_MODELS: readonly DockHelperModel[] = ['auto', 'fast', 'same']

export function helperModelLabel(model: DockHelperModel): string {
  if (model === 'fast') return 'Fast & Cheap'
  if (model === 'same') return 'Same as you'

  return 'Auto per agent'
}

/** The helper model a session starts with: the person's own pick, else Auto. */
export function restoreHelperModel(savedModel: unknown, savedChosen: unknown): DockHelperModel {
  const isKnown = typeof savedModel === 'string' && (HELPER_MODELS as readonly string[]).includes(savedModel)
  return savedChosen === true && isKnown ? (savedModel as DockHelperModel) : 'auto'
}

// The effort a tier runs at when its helper names none.
const TIER_EFFORT: Readonly<Record<string, 'low' | 'medium' | 'high' | 'xhigh'>> = {
  haiku: 'low',
  sonnet: 'medium',
  opus: 'high',
  fable: 'xhigh',
}

export function defaultEffortFor(model: string): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  return TIER_EFFORT[model]
}

/** Auto: how Claude picks each helper's model and effort for its own task. */
function autoModelRule(sessionModel: string | null): string {
  const ceiling = sessionModel ?? 'this session\'s model'
  return [
    '- Pick each helper\'s model and effort for its own task: the cheapest tier whose judgment is enough. Set both on every helper.',
    '  - haiku, effort low: mechanical work fixed by its input, like a lookup, a price check, extracting fields, a short summary or formatting.',
    '  - sonnet, effort medium: work that must decide what matters, like research, a comparison, drafting a section or a contained change.',
    '  - opus, effort high: judging or verifying, design tradeoffs, or risky changes to migrations, auth, payments or data.',
    `  - Never above this session's model (${ceiling}). Helpers of one request may differ: mix tiers when the pieces differ.`,
  ].join('\n')
}

/** The fix for an Auto helper that names no model. */
export function autoModelMessage(sessionModel: string | null): string {
  const ceiling = sessionModel ?? "this session's model"
  return (
    'Agent Dock: helper agents are on Auto, so set model and effort on this helper for its own task, then call again: ' +
    'haiku with effort low for mechanical work, sonnet with effort medium for research or drafting, ' +
    `opus with effort high for judging or risky changes, never above ${ceiling}.`
  )
}

// ---------------------------------------------------------------------------
// What Claude reads
// ---------------------------------------------------------------------------

/** The rules every helper call follows, for the first wave and for a nudge. */
export function helperRules(helperModel: DockHelperModel, sessionModel: string | null): string {
  const modelRule =
    helperModel === 'auto'
      ? autoModelRule(sessionModel)
      : helperModel === 'fast'
        ? '- On every helper set model "haiku" and effort "low".'
        : sessionModel !== null
          ? `- On every helper set model "${sessionModel}", the same model as this session.`
          : '- On every helper set model to the same model as this session.'

  return [
    '- Give each helper a short plain-English description of 3 to 5 words, like "Price check: Panera".',
    modelRule,
    '- In each helper\'s prompt add: "As you work, call report_progress (mcp__clean-view__report_progress) with your task name and a percent at about 25, 50, 75 and 100. Do not call plan_steps."',
    '- When they finish, combine their results into one answer.',
  ].join('\n')
}

/** The split instruction added to a request when Team Size is above 1. */
export function instructionText(size: number, helperModel: DockHelperModel, sessionModel: string | null): string {
  return [
    `Agent Dock: Team Size is ${size}.`,
    `- Split this request into exactly ${size} independent pieces and launch one helper (the Agent tool) per piece, all ${size} in one message so they run in parallel.`,
    '- Find a real split, one helper per item (per store, per task, per file, per section). Never argue that it cannot be split, and never pad with useless work.',
    helperRules(helperModel, sessionModel),
  ].join('\n')
}

export function nudgeText(used: number, size: number): string {
  return `You used ${used} of ${size} helpers. Split the remaining work across the other ${size - used}, one helper per piece, all in parallel.`
}

export function capMessage(size: number): string {
  return `Team Size is ${size}: this request already has ${size} helpers. Finish with the helpers you have.`
}

export const STOPPED_MESSAGE = 'Stopped before this helper started.'
export const HELPERS_SKIP_PLAN = 'Helpers skip the plan. Just call report_progress as you work.'
export const BAD_CUSTOM_SIZE = 'Type a whole number from 1 to 100'
export const BAD_COMMAND_SIZE = 'Team Size is a whole number from 1 to 100, e.g. /dock 10.'
export const NARROW_WINDOW =
  'The window is too narrow to show the Agent Dock. Widen it or watch the status bar.'

export function bigTeamQuestion(): string {
  return 'Big team: this uses your plan quickly. Continue?'
}

/** The info line under the size control. */
export function infoLine(size: number, atOnce: number, helperModel: DockHelperModel): string {
  const split = size <= 1 ? 'Claude decides how many helpers' : `Splits each request across ${size} helpers`
  return `${split}  ·  ${atOnce} at a time  ·  ${helperModelLabel(helperModel)}`
}

/** What `/dock <args>` asks for. */
export type DockCommand =
  | { kind: 'toggle' }
  | { kind: 'set'; size: number }
  | { kind: 'confirm'; size: number }
  | { kind: 'invalid' }

export function dockCommand(args: string): DockCommand {
  if (args.trim() === '') return { kind: 'toggle' }
  const size = parseSize(args)
  if (size === null) return { kind: 'invalid' }

  return needsConfirmation(size) ? { kind: 'confirm', size } : { kind: 'set', size }
}

// ---------------------------------------------------------------------------
// The mission and its cards: pure changes over the shared value
// ---------------------------------------------------------------------------

export function clampPercent(rawPercent: unknown): number {
  const percent = Number(rawPercent)
  if (!Number.isFinite(percent)) return 0

  return Math.round(Math.min(100, Math.max(0, percent)))
}

/** A fresh mission for a new request. */
export function startMission(previousId: number, prompt: string, teamSize: number, now: number): DockMission {
  return {
    id: previousId + 1,
    title: jobName(prompt),
    teamSize,
    startedAt: now,
    finishedAt: null,
    cards: [],
    admittedCalls: 0,
    hasNudged: false,
  }
}

function isFinished(status: DockCardStatus): boolean {
  return status === 'done' || status === 'stuck'
}

function makeCard(id: string, description: unknown, seat: number, now: number): DockCard {
  const task = taskName(description)
  return {
    id,
    task,
    initials: initials(task),
    seat,
    status: 'queued',
    percent: 0,
    hasReported: false,
    agentId: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
  }
}

/** Sets `finishedAt` once every card has finished, and clears it when work comes back. */
export function settleMission(mission: DockMission, now: number): DockMission {
  const isAllFinished = mission.cards.length > 0 && mission.cards.every(card => isFinished(card.status))
  if (isAllFinished) return mission.finishedAt === null ? { ...mission, finishedAt: now } : mission

  return mission.finishedAt === null ? mission : { ...mission, finishedAt: null }
}

/** A card for an Agent call Claude just wrote, before it runs. */
export function queueCard(mission: DockMission, toolUseId: string, description: unknown, now: number): DockMission {
  if (mission.cards.some(card => card.id === toolUseId)) return mission
  const card = makeCard(toolUseId, description, mission.cards.length, now)

  return settleMission({ ...mission, cards: [...mission.cards, card] }, now)
}

/** The Agent call started: its card goes working, adopting a waiting card of the same task, else made now. */
export function startCard(mission: DockMission, toolUseId: string, description: unknown, now: number): DockMission {
  const wantedTask = taskName(description).toLowerCase()
  const waiting = mission.cards.findIndex(
    card => card.status === 'queued' && card.task.toLowerCase() === wantedTask,
  )
  const hasOwnCard = mission.cards.some(card => card.id === toolUseId)
  const adopted =
    !hasOwnCard && waiting !== -1
      ? { ...mission, cards: mission.cards.map((card, index) => (index === waiting ? { ...card, id: toolUseId } : card)) }
      : mission
  const queued = queueCard(adopted, toolUseId, description, now)
  const cards = queued.cards.map(card =>
    card.id === toolUseId ? { ...card, status: 'working' as const, startedAt: now } : card,
  )

  return settleMission({ ...queued, cards }, now)
}

/** The Agent call returned: done, or stuck when it errored. */
export function finishCard(mission: DockMission, toolUseId: string, isStuck: boolean, now: number): DockMission {
  const cards = mission.cards.map(card =>
    card.id === toolUseId
      ? {
          ...card,
          status: isStuck ? ('stuck' as const) : ('done' as const),
          percent: isStuck ? card.percent : 100,
          startedAt: card.startedAt ?? now,
          finishedAt: now,
        }
      : card,
  )

  return settleMission({ ...mission, cards }, now)
}

/** Takes a card away, as when its call is refused over the Team Size cap. */
export function removeCard(mission: DockMission, toolUseId: string, now: number): DockMission {
  const cards = mission.cards.filter(card => card.id !== toolUseId).map((card, seat) => ({ ...card, seat }))
  return settleMission({ ...mission, cards }, now)
}

/** A call the dock let through but that never became a helper (refused below the dock): no card, no count. */
export function dropCard(mission: DockMission, toolUseId: string, now: number): DockMission {
  const removed = removeCard(mission, toolUseId, now)
  return { ...removed, admittedCalls: Math.max(0, mission.admittedCalls - 1) }
}

/** Links a running helper's agent id to its card. */
export function linkAgent(mission: DockMission, toolUseId: string, agentId: string): DockMission {
  const cards = mission.cards.map(card => (card.id === toolUseId ? { ...card, agentId } : card))
  return { ...mission, cards }
}

/** A helper's own report: by its agent id, else by its task name among working cards. */
export function reportHelper(mission: DockMission, agentId: string, task: unknown, percent: number): DockMission {
  const byAgent = mission.cards.findIndex(card => card.agentId === agentId)
  const wantedTask = taskName(task).toLowerCase()
  const byTask = mission.cards.findIndex(
    card => card.status === 'working' && card.agentId === null && card.task.toLowerCase() === wantedTask,
  )
  const index = byAgent !== -1 ? byAgent : byTask
  if (index === -1) return mission

  const cards = mission.cards.map((card, position) =>
    position === index && !isFinished(card.status)
      ? { ...card, agentId, percent: clampPercent(percent), hasReported: true }
      : card,
  )
  return { ...mission, cards }
}

/** The main turn ended: helpers that never started are stuck, so nothing waits forever. */
export function endTurn(mission: DockMission, now: number): DockMission {
  const cards = mission.cards.map(card =>
    card.status === 'queued' ? { ...card, status: 'stuck' as const, finishedAt: now } : card,
  )
  return settleMission({ ...mission, cards }, now)
}

export function shouldNudge(mission: DockMission, size: number): boolean {
  return size > 1 && !mission.hasNudged && mission.admittedCalls < size
}

export type DockCounts = { working: number; queued: number; done: number; stuck: number; total: number }

export function countCards(cards: readonly DockCard[]): DockCounts {
  const counts: DockCounts = { working: 0, queued: 0, done: 0, stuck: 0, total: cards.length }
  for (const card of cards) counts[card.status] += 1

  return counts
}

export function isLive(mission: DockMission | null): boolean {
  return mission !== null && mission.cards.some(card => card.status === 'working' || card.status === 'queued')
}

/** The mission's overall percent: finished cards count as whole. */
export function missionPercent(cards: readonly DockCard[]): number {
  if (cards.length === 0) return 0
  const total = cards.reduce((sum, card) => sum + (isFinished(card.status) ? 100 : card.percent), 0)

  return Math.round(total / cards.length)
}

/** The mission bar's shares: progress made, work in flight, and the rest. */
export function missionShares(cards: readonly DockCard[]): { progress: number; inFlight: number } {
  if (cards.length === 0) return { progress: 0, inFlight: 0 }
  const progress = missionPercent(cards) / 100
  const inFlight =
    cards.filter(card => card.status === 'working').reduce((sum, card) => sum + (100 - card.percent) / 100, 0) /
    cards.length

  return { progress, inFlight }
}

export function missionElapsed(mission: DockMission, now: number): number {
  return (mission.finishedAt ?? now) - mission.startedAt
}

export function cardElapsed(card: DockCard, now: number): number {
  if (card.startedAt === null) return 0
  return (card.finishedAt ?? now) - card.startedAt
}

// ---------------------------------------------------------------------------
// Words and numbers on screen
// ---------------------------------------------------------------------------

/** "0:41", "1:12", "1:02:03". */
export function formatClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** "45s", "2m 14s", "1h 3m". */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`

  return `${seconds}s`
}

/** "50 agents finished Research bakery pricing in 2m 14s (2 got stuck)". */
export function summaryLine(mission: DockMission, now: number): string {
  const counts = countCards(mission.cards)
  const agentWord = counts.total === 1 ? 'agent' : 'agents'
  const stuckNote = counts.stuck > 0 ? ` (${counts.stuck} got stuck)` : ''

  return `${counts.total} ${agentWord} finished ${mission.title} in ${formatDuration(missionElapsed(mission, now))}${stuckNote}`
}

/** The folded dock's status-bar badge. */
export function badgeText(mission: DockMission | null, teamSize: number): string {
  if (mission === null || mission.cards.length === 0) return `◆ Agent Dock · team of ${teamSize} standing by`
  const counts = countCards(mission.cards)
  const stuckPart = counts.stuck > 0 ? ` · ${counts.stuck} stuck` : ''

  return `◆ ${counts.working} working · ${counts.queued} queued · ${counts.done} done${stuckPart}`
}

/** A meter `width` cells wide, filled to `percent`. */
export function meterCells(percent: number, width: number): { filled: number; empty: number } {
  const filled = Math.min(width, Math.max(0, Math.round((clampPercent(percent) / 100) * width)))
  return { filled, empty: width - filled }
}

/** Where a 3-cell sweep sits on frame `frame` of a meter `width` cells wide. */
export function sweepStart(frame: number, width: number): number {
  const travel = Math.max(0, width - 3)
  if (travel === 0) return 0
  const step = frame % (travel * 2)

  return step <= travel ? step : travel * 2 - step
}

/** How cards are laid out for this many helpers in this width. */
export function cardLayout(bodyColumns: number, helperCount: number): { mode: 'cards' | 'tiles'; perRow: number; width: number } {
  if (helperCount > CARD_LIMIT) {
    const tileWidth = 16
    return { mode: 'tiles', perRow: Math.max(1, Math.floor((bodyColumns + 1) / (tileWidth + 1))), width: tileWidth }
  }
  const perRow = bodyColumns >= 100 ? 3 : bodyColumns >= 56 ? 2 : 1
  const width = Math.floor((bodyColumns - (perRow - 1)) / perRow)

  return { mode: 'cards', perRow, width }
}

// ---------------------------------------------------------------------------
// Colors: dark, minimal, coral to gold
// ---------------------------------------------------------------------------

export const COLORS = {
  coral: '#F0806A',
  gold: '#E5B85C',
  green: '#4CC38A',
  greenDim: '#2F7D5A',
  red: '#E5534B',
  hairline: '#3A3F44',
  muted: '#8B949E',
  ink: '#16181C',
} as const

// Muted seat colors for badges and idle seats: no rainbow.
const SEAT_COLORS = ['#E8836B', '#D9B26A', '#8FB39A', '#7F9CC4', '#B08CB5', '#C9A98A', '#6FB3B0', '#C98C99'] as const

export function seatColor(seat: number): string {
  return SEAT_COLORS[((seat % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length] ?? COLORS.coral
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** A color `t` of the way from `from` to `to`, as hex. */
export function blend(from: string, to: string, t: number): string {
  const share = Math.min(1, Math.max(0, t))
  const start = hexToRgb(from)
  const end = hexToRgb(to)
  const mixed = start.map((channel, index) => Math.round(channel + ((end[index] ?? channel) - channel) * share))

  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}
