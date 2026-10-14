// Prompt Upgrade's pure logic: which prompts are caught, reading model text, numbers, row fitting.
import type {
  PromptUpgradeAnswer,
  PromptUpgradeDetail,
  PromptUpgradeEntry,
  PromptUpgradeFlow,
  PromptUpgradeQa,
  PromptUpgradeQuestion,
  PromptUpgradeSource,
  PromptUpgradeStage,
  PromptUpgradeStep,
} from '../types'

// ---------------------------------------------------------------------------
// Names, colors and limits
// ---------------------------------------------------------------------------

export const PLUGIN_NAME = 'prompt-upgrade'
export const PANE_ID = 'prompt-upgrade'
export const PANE_TITLE = 'Prompt Upgrade'
export const TITLE_TEXT = 'PROMPT UPGRADE'
export const STORE_AUTO = 'prompt-upgrade.auto'
export const STORE_HISTORY = 'prompt-upgrade.history'
export const STORE_DETAIL = 'prompt-upgrade.detail'

export const COLORS = {
  gold: '#F2C46D',
  hairline: '#262B33',
  muted: '#7D8590',
  text: '#E6EDF3',
  green: '#3DD68C',
  amber: '#E3B341',
  ink: '#0D1117',
  slate: '#262B33',
} as const

export const MIN_OPTIONS = 2
export const MAX_ADDED = 8
/** How much of Claude's last reply the prompt check gets to see. */
export const LAST_REPLY_LENGTH = 1500
/** How long the "sent as typed" line stays on screen. */
export const SENT_STATUS_MS = 3000
/** How long Auto waits for answers before it fills the rest and sends. */
export const AUTO_SEND_MS = 30_000
export const HISTORY_LIMIT = 20
export const OPTION_MAX_LENGTH = 48
/** Below this many columns the two review cards stack. */
export const STACK_BELOW = 70
/** The narrowest width the pane draws for; anything less is drawn as this. */
export const MIN_WIDTH = 30
/** A card shows at most this many lines; Copy and Run always use the full text. */
export const CARD_MAX_LINES = 60

// The default is 1024 tokens; the check's JSON and long rewrites need more room.
export const QUESTIONS_MODEL = { model: 'haiku', effort: 'low', timeoutMs: 20_000, maxTokens: 1500 } as const
export const REWRITE_MODEL = { model: 'sonnet', effort: 'medium', timeoutMs: 60_000 } as const

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------

export const DEFAULT_DETAIL: PromptUpgradeDetail = 'medium'
export const DETAIL_LEVELS: readonly PromptUpgradeDetail[] = ['auto', 'low', 'medium', 'high']

type DetailSpec = {
  label: string
  /** The dropdown's option text. */
  optionLabel: string
  /** The short tag in the history. */
  tag: string
  maxQuestions: number
  maxOptions: number
  rewriteMaxTokens: number
  /** The level's rules, added after the four rewrite rules. */
  rewriteRules: readonly string[]
  /** An extra line for the check, after its own question limits. */
  checkRule?: string
}

export const DETAIL_SPECS: Readonly<Record<PromptUpgradeDetail, DetailSpec>> = {
  auto: {
    label: 'Auto',
    optionLabel: 'Auto: decides for you',
    tag: 'AUTO',
    maxQuestions: 9,
    maxOptions: 4,
    rewriteMaxTokens: 6000,
    rewriteRules: [
      '- Match the length and depth to the size and risk of the task: a small, clear task gets one short paragraph; a large or risky one gets short labeled sections with constraints, what is out of scope and what done looks like.',
      '- The "added" list has 1 to 8 items.',
    ],
    checkRule: 'Ask only as many questions as the gaps need, at most 9.',
  },
  low: {
    label: 'Low',
    optionLabel: 'Low: quick and short',
    tag: 'LOW',
    maxQuestions: 3,
    maxOptions: 3,
    rewriteMaxTokens: 1500,
    rewriteRules: [
      '- Length: one short paragraph, about 40 to 80 words.',
      '- At this level the first rule adds only the goal and the format.',
      '- The "added" list has 1 to 3 items.',
    ],
  },
  medium: {
    label: 'Medium',
    optionLabel: 'Medium: balanced',
    tag: 'MED',
    maxQuestions: 5,
    maxOptions: 4,
    rewriteMaxTokens: 3000,
    rewriteRules: [
      '- Length: one or two paragraphs, about 80 to 150 words.',
      '- At this level the first rule adds the goal, the audience, the format and what "done" looks like.',
      '- The "added" list has 3 to 5 items.',
    ],
  },
  high: {
    label: 'High',
    optionLabel: 'High: thorough',
    tag: 'HIGH',
    maxQuestions: 7,
    maxOptions: 4,
    rewriteMaxTokens: 6000,
    rewriteRules: [
      '- Length: short labeled sections, about 150 to 300 words.',
      '- At this level the first rule adds everything in the medium level, plus constraints, tone, must-haves and what is out of scope.',
      '- Leave a [placeholder] for every unknown.',
      '- The "added" list has 5 to 8 items.',
    ],
  },
}

/** Reads a level from anything; undefined when it is not auto, low, medium or high. */
export function parseDetail(value: unknown): PromptUpgradeDetail | undefined {
  if (typeof value !== 'string') return undefined
  const word = value.trim().toLowerCase()
  return DETAIL_LEVELS.find(level => level === word)
}

/** A level that may be missing (an old save) read as a level; medium when unknown. */
export function detailOrDefault(value: unknown): PromptUpgradeDetail {
  return parseDetail(value) ?? DEFAULT_DETAIL
}

export function rewriteModel(level: PromptUpgradeDetail) {
  return { ...REWRITE_MODEL, maxTokens: DETAIL_SPECS[level].rewriteMaxTokens }
}

export const BAD_LEVEL_TEXT = 'Detail is auto, low, medium or high, e.g. /better level auto.'

export const CHECKING_STATUS = 'Checking your prompt… Press Enter again to send it as typed.'
export const SENT_STATUS = 'Sent as typed: it already looked good'
export const AUTO_SENT_STATUS = 'Sent the upgrade.'

export const DROP_TEXT = 'Prompt Upgrade is reading your prompt.'
export const COMMAND_TEXT = 'Prompt Upgrade is reading your prompt.'
export const NARROW_WINDOW =
  'The window is too narrow for Prompt Upgrade, so your words are back in the prompt box.'

// ---------------------------------------------------------------------------
// Which prompts are caught
// ---------------------------------------------------------------------------

/** Replies that are never worth upgrading. */
const KNOWN_REPLIES: ReadonlySet<string> = new Set([
  'yes',
  'no',
  'ok',
  'okay',
  'sure',
  'thanks',
  'thank you',
  'continue',
  'keep going',
  'go on',
  'go ahead',
  'do it',
  'sounds good',
  'lgtm',
  'stop',
])

/** The facts about a submission that decide whether it is caught. */
export type SubmitFacts = {
  text: string
  /** `e.origin.kind`. */
  originKind: string
  hasCommand: boolean
  isMeta: boolean
  attachmentCount: number
  /** True when typed while Claude was working. */
  hasTurn: boolean
}

export type SubmitDecision =
  | { kind: 'pass' }
  /** Goes on with the ">" taken off. */
  | { kind: 'strip'; text: string }
  | { kind: 'intercept'; text: string }

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(word => word !== '')
  return words.length
}

/** A very short answer such as "yes" or "keep going". */
export function isShortReply(text: string): boolean {
  const plain = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
  if (plain === '') return true

  return wordCount(plain) <= 3 || KNOWN_REPLIES.has(plain)
}

/** Decides what the automatic mode does with one submission. */
export function decideSubmit(facts: SubmitFacts, isAuto: boolean): SubmitDecision {
  if (!isAuto) return { kind: 'pass' }
  // Only the person's own Enter in the prompt box. This also keeps the mod's own sends from looping back.
  if (facts.originKind !== 'composer') return { kind: 'pass' }
  if (facts.hasCommand || facts.isMeta || facts.attachmentCount > 0 || facts.hasTurn) return { kind: 'pass' }

  const text = facts.text.trim()
  if (text === '' || text.startsWith('/')) return { kind: 'pass' }
  if (text.startsWith('>')) {
    const stripped = text.replace(/^>\s?/, '')
    return stripped.trim() === '' ? { kind: 'pass' } : { kind: 'strip', text: stripped }
  }
  if (isShortReply(text)) return { kind: 'pass' }

  return { kind: 'intercept', text }
}

/** A prompt as compared for "the same prompt twice": trimmed, spaces collapsed, lowercase. */
export function normalizePrompt(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The end of a reply, kept as context for the prompt check. */
export function replyTail(answer: string): string {
  const trimmed = answer.trim()
  return trimmed.length <= LAST_REPLY_LENGTH ? trimmed : trimmed.slice(trimmed.length - LAST_REPLY_LENGTH)
}

export type BetterAction =
  | { kind: 'empty' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'history' }
  /** `level` is the detail level, or undefined when the value is not one. */
  | { kind: 'level'; level: PromptUpgradeDetail | undefined }
  | { kind: 'prompt'; text: string }

/** Reads what was typed after /better. */
export function parseBetterArgs(args: string): BetterAction {
  const text = args.trim()
  const word = text.toLowerCase()
  if (text === '') return { kind: 'empty' }
  if (word === 'on') return { kind: 'on' }
  if (word === 'off') return { kind: 'off' }
  if (word === 'history') return { kind: 'history' }
  // "level" alone or with one word is the setting; a longer sentence is still a prompt.
  const words = text.split(/\s+/)
  if (words[0]?.toLowerCase() === 'level' && words.length <= 2) return { kind: 'level', level: parseDetail(words[1]) }

  return { kind: 'prompt', text }
}

// ---------------------------------------------------------------------------
// Reading what the model said
// ---------------------------------------------------------------------------

/** Finds JSON in model text: bare, in a code fence, or inside stray prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]

  const fenced = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1))

  const firstBracket = trimmed.indexOf('[')
  const lastBracket = trimmed.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) candidates.push(trimmed.slice(firstBracket, lastBracket + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next reading.
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A short single-line label. */
export function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

export type ParsedQuestions =
  | { isOk: true; isReady: boolean; missing: string[]; questions: PromptUpgradeQuestion[] }
  | { isOk: false }

/** Reads the prompt check's reply, capped at the level's questions and options. */
export function parseQuestions(text: string, level: PromptUpgradeDetail = DEFAULT_DETAIL): ParsedQuestions {
  const { maxQuestions, maxOptions } = DETAIL_SPECS[level]
  const json = extractJson(text)
  const rawList = Array.isArray(json) ? json : isRecord(json) ? json.questions : undefined
  if (!Array.isArray(rawList)) return { isOk: false }

  const questions: PromptUpgradeQuestion[] = []
  for (const raw of rawList) {
    if (!isRecord(raw) || typeof raw.question !== 'string' || !Array.isArray(raw.options)) continue
    const question = raw.question.replace(/\s+/g, ' ').trim()
    const seen = new Set<string>()
    const options: string[] = []
    for (const option of raw.options) {
      if (typeof option !== 'string') continue
      const label = shorten(option, OPTION_MAX_LENGTH)
      if (label === '' || seen.has(label.toLowerCase())) continue
      seen.add(label.toLowerCase())
      options.push(label)
    }
    if (question === '' || options.length < MIN_OPTIONS) continue
    questions.push({ question, options: options.slice(0, maxOptions) })
    if (questions.length === maxQuestions) break
  }

  const missing =
    isRecord(json) && Array.isArray(json.missing)
      ? json.missing
          .filter((gap): gap is string => typeof gap === 'string')
          .map(gap => shorten(gap, OPTION_MAX_LENGTH))
          .filter(gap => gap !== '')
      : []
  // A reply with no "ready" field is the old shape: no questions means ready.
  const isReady = isRecord(json) && typeof json.ready === 'boolean' ? json.ready : questions.length === 0
  return { isOk: true, isReady, missing, questions: isReady ? [] : questions }
}

export type ParsedRewrite = { isOk: true; prompt: string; added: string[] } | { isOk: false }

/** Reads the rewrite reply: the upgraded prompt and the short list of what was added. */
export function parseRewrite(text: string): ParsedRewrite {
  const json = extractJson(text)
  if (!isRecord(json) || typeof json.prompt !== 'string') return { isOk: false }

  const prompt = json.prompt.trim()
  if (prompt === '') return { isOk: false }

  const rawAdded = Array.isArray(json.added) ? json.added : []
  const added = rawAdded
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(item => item !== '')
    .slice(0, MAX_ADDED)

  return { isOk: true, prompt, added }
}

// ---------------------------------------------------------------------------
// What the model is asked
// ---------------------------------------------------------------------------

export function questionsSystem(level: PromptUpgradeDetail): string {
  const { maxQuestions, maxOptions, checkRule } = DETAIL_SPECS[level]
  return [
    'You check a rough prompt before it is sent to an AI assistant, and find out what it is missing.',
    'A prompt is ready when it already has what its task needs: a goal, who it is for, the format, what done looks like, and any inputs or constraints the task depends on.',
    "You also get Claude's last message. A short reply that answers or approves what Claude just asked counts as ready: \"yes do it\" after \"Shall I build it?\" is ready, while \"fix it\" with nothing before it is not.",
    'If the prompt is ready, reply with ready true and no questions.',
    `If it is not, list each gap in "missing" in a few words, then ask only as many multiple-choice questions as the gaps need: at least 1 and at most ${maxQuestions}.`,
    `Each question has ${MIN_OPTIONS} to ${maxOptions} short options of a few words each.`,
    ...(checkRule === undefined ? [] : [checkRule]),
    'Never ask something the prompt already says. Never invent facts.',
    'Reply with strict JSON only, with no prose and no code fences, in this shape:',
    '{"ready":false,"missing":["short gap","..."],"questions":[{"question":"...","options":["...","..."]}]}',
    'When ready, reply {"ready":true,"missing":[],"questions":[]}.',
  ].join('\n')
}

export function rewriteSystem(level: PromptUpgradeDetail): string {
  return [
    'You rewrite a rough prompt into a great one before it is sent to an AI assistant.',
    'The rules below are written by the person whose prompt it is: "I", "my" and "me" mean that person.',
    '',
    'Rules:',
    '- Keep exactly what I meant. Add a clear goal, who it is for, the format, and what "done" looks like.',
    '- Use what I answered. Leave out what I skipped.',
    '- Never invent facts, names, numbers or prices. Where something is unknown, leave a [placeholder] in square brackets.',
    '- Write it as one request I could have typed myself, in plain language.',
    '',
    `Detail level: ${DETAIL_SPECS[level].label}.`,
    ...DETAIL_SPECS[level].rewriteRules,
    '',
    'Reply with strict JSON only, with no prose and no code fences, in this shape:',
    '{"prompt":"the upgraded prompt","added":["short note on one detail you added","..."]}',
    'The "added" list names, in a few words each, the details you added that the rough prompt did not have.',
  ].join('\n')
}

/** The check's request: Claude's last message (when there is one) and the rough prompt. */
export function questionsPrompt(original: string, lastReply = ''): string {
  const context = lastReply.trim() === '' ? '(none: this starts the conversation)' : `"""\n${lastReply.trim()}\n"""`
  return `Claude's last message:\n${context}\n\nRough prompt:\n"""\n${original}\n"""`
}

/** The answered questions only; skipped ones are left out. */
export function answeredPairs(
  questions: readonly PromptUpgradeQuestion[],
  answers: readonly PromptUpgradeAnswer[],
): PromptUpgradeQa[] {
  const pairs: PromptUpgradeQa[] = []
  questions.forEach((question, index) => {
    const answer = answers[index]
    if (answer !== undefined && answer.status === 'answered' && answer.text.trim() !== '') {
      pairs.push({ question: question.question, answer: answer.text.trim() })
    }
  })
  return pairs
}

/** The questions still open: not answered and not skipped. */
export function unansweredQuestions(
  questions: readonly PromptUpgradeQuestion[],
  answers: readonly PromptUpgradeAnswer[],
): PromptUpgradeQuestion[] {
  return questions.filter((_, index) => answers[index]?.status === 'open')
}

/** Added to the rewrite when the rest is filled in for the person. */
export const CHOOSE_FOR_UNANSWERED =
  'For each question I did not answer, choose the option that best fits the task. If choosing would mean inventing a fact, leave a [placeholder] instead.'

export function rewritePrompt(
  original: string,
  pairs: readonly PromptUpgradeQa[],
  unanswered: readonly PromptUpgradeQuestion[] = [],
): string {
  const answered =
    pairs.length === 0
      ? 'No questions were answered.'
      : pairs.map(pair => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n')
  const request = `Rough prompt:\n"""\n${original}\n"""\n\nWhat I answered:\n${answered}`
  if (unanswered.length === 0) return request

  const open = unanswered.map(question => `Q: ${question.question}\nOptions: ${question.options.join(' / ')}`).join('\n\n')
  return `${request}\n\nQuestions I did not answer:\n${open}\n\n${CHOOSE_FOR_UNANSWERED}`
}

// ---------------------------------------------------------------------------
// Flow state helpers
// ---------------------------------------------------------------------------

export function idleFlow(requestId: number): PromptUpgradeFlow {
  return {
    stage: 'idle',
    requestId,
    original: '',
    detailLevel: DEFAULT_DETAIL,
    startedBy: 'command',
    questions: [],
    answers: [],
    typingFor: null,
    upgraded: '',
    added: [],
    draft: '',
    entryId: null,
    failedStep: 'asking',
    note: null,
    autoSendAt: null,
    isSendingAutomatically: false,
  }
}

/** A flow that starts on a prompt, fixed at the given detail level. Automatic mode starts at the check. */
export function readingFlow(
  requestId: number,
  original: string,
  detailLevel: PromptUpgradeDetail,
  startedBy: PromptUpgradeSource,
): PromptUpgradeFlow {
  return { ...idleFlow(requestId), stage: startedBy === 'auto' ? 'checking' : 'reading', original, detailLevel, startedBy }
}

export function openCount(answers: readonly PromptUpgradeAnswer[]): number {
  return answers.filter(answer => answer.status === 'open').length
}

export function answeredCount(answers: readonly PromptUpgradeAnswer[]): number {
  return answers.filter(answer => answer.status === 'answered').length
}

export type Stats = { wordsBefore: number; wordsAfter: number; detailsAdded: number }

export function buildStats(original: string, upgraded: string, added: readonly string[]): Stats {
  return { wordsBefore: wordCount(original), wordsAfter: wordCount(upgraded), detailsAdded: added.length }
}

/** Newest first, at most 20; an entry with an existing id replaces that one. */
export function trimHistory(list: readonly PromptUpgradeEntry[], entry: PromptUpgradeEntry): PromptUpgradeEntry[] {
  return [entry, ...list.filter(other => other.id !== entry.id)].slice(0, HISTORY_LIMIT)
}

/** Keeps only well-formed entries from whatever the store held. */
export function restoreHistory(saved: unknown): PromptUpgradeEntry[] {
  if (!Array.isArray(saved)) return []
  const entries = saved.filter(
    (item): item is PromptUpgradeEntry =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.original === 'string' &&
      typeof item.upgraded === 'string' &&
      Array.isArray(item.added),
  )
  // Entries saved before levels existed read as medium.
  return entries.map(entry => ({ ...entry, detailLevel: detailOrDefault(entry.detailLevel) })).slice(0, HISTORY_LIMIT)
}

/** "just now", "5m ago", "3h ago" or "2d ago". */
export function ageLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// The tracker across the top
// ---------------------------------------------------------------------------

export type StepState = 'done' | 'current' | 'upcoming'

const STEP_NAMES = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const
const STEP_SHORT_NAMES = ['Prompt', 'Ask', 'Write', 'Review'] as const

/** Which of the four steps the stage is on, or null for screens without a tracker. */
export function currentStep(stage: PromptUpgradeStage, failedStep: PromptUpgradeStep): number | null {
  switch (stage) {
    case 'typing':
    case 'reading':
    case 'checking':
    case 'ready':
      return 0
    case 'asking':
    case 'questions':
      return 1
    case 'rewriting':
      return 2
    case 'review':
    case 'editing':
      return 3
    case 'error':
      return failedStep === 'asking' ? 1 : 2
    default:
      return null
  }
}

export function stepStates(current: number): StepState[] {
  return STEP_NAMES.map((_, index) => (index < current ? 'done' : index === current ? 'current' : 'upcoming'))
}

export type TrackerPiece = { text: string; kind: StepState | 'separator' }

/** The tracker as colored pieces, in the longest form that fits the width. */
export function trackerPieces(states: readonly StepState[], width: number): TrackerPiece[] {
  const build = (names: readonly string[], separator: string): TrackerPiece[] => {
    const pieces: TrackerPiece[] = []
    names.forEach((name, index) => {
      if (index > 0) pieces.push({ text: separator, kind: 'separator' })
      const state = states[index] ?? 'upcoming'
      pieces.push({ text: `${state === 'done' ? '✓' : state === 'current' ? '●' : '○'} ${name}`, kind: state })
    })
    return pieces
  }
  const length = (pieces: readonly TrackerPiece[]) => pieces.reduce((total, piece) => total + piece.text.length, 0)

  for (const [names, separator] of [
    [STEP_NAMES, '  ─  '],
    [STEP_NAMES, ' ─ '],
    [STEP_SHORT_NAMES, ' ─ '],
    [STEP_SHORT_NAMES, ' '],
  ] as const) {
    const pieces = build(names, separator)
    if (length(pieces) <= width) return pieces
  }
  return build(STEP_SHORT_NAMES, ' ')
}

// ---------------------------------------------------------------------------
// Fitting rows to the pane's width
// ---------------------------------------------------------------------------

/** Cuts a line to the width, ending with an ellipsis when it was cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return width === 1 ? '…' : `${text.slice(0, width - 1)}…`
}

/** Pads a line with spaces at the end up to the width. */
export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** Centers a line in the width. */
export function center(text: string, width: number): string {
  if (text.length >= width) return text
  const left = Math.floor((width - text.length) / 2)
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left)
}

/** Breaks text into lines no wider than the width, keeping its own line breaks. */
export function wrapText(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const lines: string[] = []

  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      let rest = word
      // A word longer than the row is broken across rows.
      while (rest.length > room) {
        if (line !== '') {
          lines.push(line)
          line = ''
        }
        lines.push(rest.slice(0, room))
        rest = rest.slice(room)
      }
      if (line === '') line = rest
      else if (line.length + 1 + rest.length <= room) line = `${line} ${rest}`
      else {
        lines.push(line)
        line = rest
      }
    }
    if (line !== '') lines.push(line)
  }
  return lines
}

/** The lines a card shows: wrapped, and cut with a note past the limit. */
export function cardLines(text: string, width: number, limit: number = CARD_MAX_LINES): string[] {
  const lines = wrapText(text, width)
  if (lines.length <= limit) return lines

  return [...lines.slice(0, limit), truncate(`… ${lines.length - limit} more lines`, width)]
}

/** Groups items into rows so each row (items plus gaps) fits the width. Returns indexes. */
export function packRows(widths: readonly number[], gap: number, width: number): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0

  widths.forEach((itemWidth, index) => {
    const needed = row.length === 0 ? itemWidth : used + gap + itemWidth
    if (row.length > 0 && needed > width) {
      rows.push(row)
      row = [index]
      used = itemWidth
    } else {
      row.push(index)
      used = needed
    }
  })
  if (row.length > 0) rows.push(row)

  return rows
}

/** A chip's text: the label with one space on each side. */
export function chipText(label: string): string {
  return ` ${label} `
}

/** A section heading as its label and the hairline that fills the rest of the row. */
export function headingParts(label: string, width: number): { label: string; rule: string } {
  const shown = truncate(label.toUpperCase(), Math.max(1, width - 2))
  return { label: shown, rule: '─'.repeat(Math.max(0, width - shown.length - 1)) }
}

/** The title's gold rule (as wide as the title) and the hairline that carries on to the edge. */
export function titleRuleParts(title: string, width: number): { gold: string; hairline: string } {
  const goldWidth = Math.min(title.length, width)
  return { gold: '━'.repeat(goldWidth), hairline: '─'.repeat(Math.max(0, width - goldWidth)) }
}

// ---------------------------------------------------------------------------
// The detail dropdown
// ---------------------------------------------------------------------------

/** Columns the dropdown is planned for: its label, the longest option and its arrow and padding. */
export const SELECT_LABEL = 'Detail'
export const SELECT_WIDTH =
  SELECT_LABEL.length + 2 + Math.max(...DETAIL_LEVELS.map(level => DETAIL_SPECS[level].optionLabel.length)) + 4

/** The dropdown sits on the title's row when both fit with room to spare, else on its own line. */
export function isSelectInline(width: number): boolean {
  return width >= Math.max(60, TITLE_TEXT.length + 1 + SELECT_WIDTH)
}

export type CardLayout = { isStacked: boolean; cardWidth: number }

/** Two cards side by side, or stacked below about 70 columns. */
export function cardLayout(width: number): CardLayout {
  if (width < STACK_BELOW) return { isStacked: true, cardWidth: width }
  return { isStacked: false, cardWidth: Math.floor((width - 1) / 2) }
}

// ---------------------------------------------------------------------------
// Big numbers: three rows tall, in heavy box-drawing characters
// ---------------------------------------------------------------------------

const BIG_DIGITS: Readonly<Record<string, readonly [string, string, string]>> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', '╺━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

const BIGGEST_NUMBER = 99_999

/** A number as three rows of heavy digits, one space between digits. */
export function bigNumber(value: number): [string, string, string] {
  const digits = String(Math.max(0, Math.min(BIGGEST_NUMBER, Math.floor(value))))
  const rows: [string, string, string] = ['', '', '']
  digits.split('').forEach((digit, index) => {
    const glyph = BIG_DIGITS[digit] ?? BIG_DIGITS['0']!
    for (let row = 0; row < 3; row += 1) rows[row] += (index > 0 ? ' ' : '') + glyph[row]
  })
  return rows
}

export type StatTile = { label: string; rows: [string, string, string]; innerWidth: number; tone: 'text' | 'good' }

export type StatLayout = { mode: 'tiles'; tiles: StatTile[] } | { mode: 'line'; text: string }

/** The review's numbers as three tiles, or one plain line when the pane is too narrow for tiles. */
export function statLayout(stats: Stats, width: number): StatLayout {
  const build = (labels: readonly [string, string, string]): StatTile[] => {
    const values = [stats.wordsBefore, stats.wordsAfter, stats.detailsAdded]
    return values.map((value, index): StatTile => {
      const rows = bigNumber(value)
      const label = labels[index] ?? ''
      return {
        label,
        rows,
        innerWidth: Math.max(label.length, rows[0].length),
        tone: index === 2 ? 'good' : 'text',
      }
    })
  }
  // Each tile is its content plus a border and one space on each side; tiles sit one space apart.
  const total = (tiles: readonly StatTile[]) => tiles.reduce((sum, tile) => sum + tile.innerWidth + 4, 0) + tiles.length - 1

  for (const labels of [
    ['WORDS BEFORE', 'WORDS AFTER', 'DETAILS ADDED'],
    ['BEFORE', 'AFTER', 'ADDED'],
  ] as const) {
    const tiles = build(labels)
    if (total(tiles) <= width) return { mode: 'tiles', tiles }
  }
  return {
    mode: 'line',
    text: truncate(
      `${stats.wordsBefore} words → ${stats.wordsAfter} words, ${stats.detailsAdded} details added`,
      width,
    ),
  }
}
