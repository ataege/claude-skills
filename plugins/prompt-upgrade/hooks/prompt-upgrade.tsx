// Prompt Upgrade: turns a rough prompt into a great one, in a pane, before anything is sent.
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, Elements, EngineInterface, On, RenderElement, RenderInput, TextProps } from 'claude-code'

import type { PromptUpgradeDetail, PromptUpgradeEntry, PromptUpgradeFlow, PromptUpgradeSource, PromptUpgradeStep } from '../types'
import {
  AUTO_SENT_STATUS,
  AUTO_SEND_MS,
  BAD_LEVEL_TEXT,
  CHECKING_STATUS,
  COLORS,
  COMMAND_TEXT,
  DETAIL_LEVELS,
  DETAIL_SPECS,
  DROP_TEXT,
  NARROW_WINDOW,
  PANE_ID,
  PANE_TITLE,
  QUESTIONS_MODEL,
  SENT_STATUS,
  SENT_STATUS_MS,
  STORE_AUTO,
  STORE_DETAIL,
  STORE_HISTORY,
  TITLE_TEXT,
  ageLabel,
  answeredCount,
  answeredPairs,
  buildStats,
  cardLayout,
  cardLines,
  chipText,
  currentStep,
  decideSubmit,
  detailOrDefault,
  headingParts,
  isSelectInline,
  idleFlow,
  MIN_WIDTH,
  normalizePrompt,
  openCount,
  packRows,
  padEnd,
  parseBetterArgs,
  parseDetail,
  parseQuestions,
  parseRewrite,
  questionsPrompt,
  questionsSystem,
  readingFlow,
  replyTail,
  restoreHistory,
  rewriteModel,
  rewritePrompt,
  rewriteSystem,
  shorten,
  statLayout,
  stepStates,
  titleRuleParts,
  trackerPieces,
  trimHistory,
  truncate,
  unansweredQuestions,
  center,
  wrapText,
} from './prompt-upgrade-logic'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const flowAtom = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, idleFlow(0))
const historyAtom = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [])
const autoAtom = atom({ plugin: 'prompt-upgrade', key: 'isAutoOn' } as const, false)
const detailAtom = atom({ plugin: 'prompt-upgrade', key: 'detailLevel' } as const, 'medium' as PromptUpgradeDetail)
const lastReplyAtom = atom({ plugin: 'prompt-upgrade', key: 'lastReply' } as const, '')
const lastInterceptedAtom = atom({ plugin: 'prompt-upgrade', key: 'lastIntercepted' } as const, '')

type Engine = EngineInterface
type TextElement = ElementConstructor<TextProps>
type BoxElement = Elements['terminal']['Box']
type ButtonElement = Elements['terminal']['Button']
type InputElement = Elements['terminal']['Input']
type SelectElement = Elements['terminal']['Select']
type PaneInput = RenderInput<'Pane'>

const PROBLEM_TEXT = 'Prompt Upgrade hit a problem. Your prompt is safe. Try /better again.'
const PANE_COLUMNS = 100
const PANE_ROWS = 30

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

function showToast($: Engine, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // A toast that cannot show is no reason to fail.
  }
}

/** Sets the status line, or clears it with undefined. */
function setStatus($: Engine, text: string | undefined): void {
  try {
    $.ui.status(text)
  } catch {
    // A status line that cannot show is no reason to fail.
  }
}

/** Runs slow work after the current dispatch ends, so a model call is not tied to a hook's budget. */
function runInBackground($: Engine, task: () => Promise<void>): void {
  $.clock.after(0, () => {
    void task().catch(() => undefined)
  })
}

async function changeFlow($: Engine, change: (flow: PromptUpgradeFlow) => PromptUpgradeFlow): Promise<PromptUpgradeFlow> {
  return update($, flowAtom, change)
}

/** Applies a change only while the flow is still the call that asked for it. */
async function changeIfCurrent(
  $: Engine,
  requestId: number,
  change: (flow: PromptUpgradeFlow) => PromptUpgradeFlow,
): Promise<boolean> {
  let isApplied = false
  await update($, flowAtom, flow => {
    isApplied = flow.requestId === requestId
    return isApplied ? change(flow) : flow
  })
  return isApplied
}

async function openPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open({
    id: PANE_ID,
    title: PANE_TITLE,
    focus: true,
    closeOnEscape: true,
    columns: PANE_COLUMNS,
    rows: PANE_ROWS,
  })
  return opened.isPlaced
}

async function closePane($: Engine): Promise<void> {
  try {
    await $.ui.close({ id: PANE_ID })
  } catch {
    // Already closed.
  }
}

/** What the prompt box holds now; empty when it cannot be read. */
async function readPromptBox($: Engine): Promise<string> {
  try {
    return (await $.prompt.read()).text
  } catch {
    return ''
  }
}

/** Puts the person's words back in the prompt box, unless they are already there. */
async function restorePrompt($: Engine, text: string): Promise<void> {
  if (text.trim() === '' || (await readPromptBox($)) === text) return
  try {
    await $.prompt.fill({ text, mode: 'replace' })
  } catch {
    // The words are still in the history and the pane.
  }
}

/** Refills the box with the person's words after a drop, but only when the box is empty. */
async function refillIfEmpty($: Engine, text: string): Promise<void> {
  if ((await readPromptBox($)).trim() !== '') return
  try {
    await $.prompt.fill({ text, mode: 'replace' })
  } catch {
    // The check goes on without the words in the box.
  }
}

/** Empties the box before a send, but only when it still holds the original, so new typing is never wiped. */
async function emptyIfHolding($: Engine, original: string): Promise<void> {
  if (original.trim() === '' || (await readPromptBox($)) !== original) return
  try {
    await $.prompt.fill({ text: '', mode: 'replace' })
  } catch {
    // A box that cannot be emptied is no reason to stop the send.
  }
}

async function saveHistory($: Engine, history: readonly PromptUpgradeEntry[]): Promise<void> {
  try {
    await $.store.set(STORE_HISTORY, history)
  } catch {
    // The history still holds for this session.
  }
}

/** Ends the flow: the next model answer for it is ignored. */
async function resetFlow($: Engine): Promise<PromptUpgradeFlow> {
  return changeFlow($, flow => idleFlow(flow.requestId + 1))
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Starts on a rough prompt at the current detail level. A command opens the pane and checks the prompt;
 * automatic mode checks first and opens the pane only if there is something to show.
 * Returns false when the pane could not open.
 */
async function beginPrompt($: Engine, original: string, startedBy: PromptUpgradeSource = 'command'): Promise<boolean> {
  const requestId = (await read($, flowAtom)).requestId + 1
  const detailLevel = await read($, detailAtom)
  await changeFlow($, () => readingFlow(requestId, original, detailLevel, startedBy))

  if (startedBy === 'auto') {
    setStatus($, CHECKING_STATUS)
    // Once the drop is done: the words go back in the box, then the check runs.
    runInBackground($, async () => {
      if ((await read($, flowAtom)).requestId !== requestId) return
      await refillIfEmpty($, original)
      await runCheck($, requestId)
    })
    return true
  }
  if (!(await openPane($))) {
    await resetFlow($)
    await closePane($)
    await restorePrompt($, original)
    return false
  }
  await enterAsking($, requestId)
  return true
}

/** The prompt check: moves to Asking and runs it in the background. */
async function enterAsking($: Engine, requestId: number): Promise<void> {
  const isApplied = await changeIfCurrent($, requestId, flow => ({ ...flow, stage: 'asking', note: null }))
  if (isApplied) runInBackground($, () => runCheck($, requestId))
}

async function failStep($: Engine, requestId: number, step: PromptUpgradeStep): Promise<boolean> {
  return changeIfCurrent($, requestId, flow => ({
    ...flow,
    stage: 'error',
    failedStep: step,
    typingFor: null,
    autoSendAt: null,
    // After a failure, Try again goes on to the normal review.
    isSendingAutomatically: false,
  }))
}

/** Automatic mode, after its check: clears the status line and opens the pane. Puts the words back when it cannot open. */
async function openAfterCheck($: Engine, requestId: number): Promise<boolean> {
  setStatus($, undefined)
  const flow = await read($, flowAtom)
  if (flow.requestId !== requestId) return false
  if (await openPane($)) return true

  await resetFlow($)
  await closePane($)
  await restorePrompt($, flow.original)
  showToast($, NARROW_WINDOW)
  return false
}

/** Automatic mode, prompt already good: sends the original as typed, with no pane. */
async function sendCheckedOriginal($: Engine, requestId: number): Promise<void> {
  const flow = await read($, flowAtom)
  setStatus($, undefined)
  const isApplied = await changeIfCurrent($, requestId, current => idleFlow(current.requestId + 1))
  if (!isApplied) return

  await emptyIfHolding($, flow.original)
  submitAsUser($, flow.original)
  // A short note that clears itself.
  setStatus($, SENT_STATUS)
  $.clock.after(SENT_STATUS_MS, () => setStatus($, undefined))
}

/** The prompt check: is it ready, and if not, which questions fill the gaps. */
async function runCheck($: Engine, requestId: number): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.requestId !== requestId || (flow.stage !== 'asking' && flow.stage !== 'checking')) return
  // Automatic mode checks with the pane closed; a command or a retry has it open.
  const isAutoCheck = flow.stage === 'checking'
  const level = detailOrDefault(flow.detailLevel)

  try {
    const reply = await $.model.complete({
      ...QUESTIONS_MODEL,
      system: questionsSystem(level),
      prompt: questionsPrompt(flow.original, await read($, lastReplyAtom)),
    })
    if ((await read($, flowAtom)).requestId !== requestId) return

    const parsed = reply.isAnswered ? parseQuestions(reply.text, level) : undefined
    if (parsed === undefined || !parsed.isOk) return await failCheck($, requestId, isAutoCheck)

    if (parsed.isReady) {
      if (isAutoCheck) return await sendCheckedOriginal($, requestId)
      await changeIfCurrent($, requestId, current => ({ ...current, stage: 'ready', questions: [], answers: [] }))
      return
    }

    // Not ready but nothing to ask: go straight to the rewrite.
    if (parsed.questions.length === 0) {
      const isApplied = await changeIfCurrent($, requestId, current => ({ ...current, stage: 'rewriting', questions: [], answers: [] }))
      if (!isApplied || (isAutoCheck && !(await openAfterCheck($, requestId)))) return
      await runRewrite($, requestId)
      return
    }
    // At Auto, a countdown to "fill the rest and send" starts with the questions.
    const autoSendAt = level === 'auto' ? (await $.clock.now()) + AUTO_SEND_MS : null
    const isApplied = await changeIfCurrent($, requestId, current => ({
      ...current,
      stage: 'questions',
      questions: parsed.questions,
      answers: parsed.questions.map(() => ({ status: 'open' as const, text: '' })),
      typingFor: null,
      autoSendAt,
    }))
    if (isApplied && autoSendAt !== null) scheduleAutoSend($, requestId, autoSendAt)
    if (isApplied && isAutoCheck) await openAfterCheck($, requestId)
  } catch {
    await failCheck($, requestId, isAutoCheck)
  }
}

/** The check failed: the calm error card, with the pane opened first in automatic mode. */
async function failCheck($: Engine, requestId: number, isAutoCheck: boolean): Promise<void> {
  const isApplied = await failStep($, requestId, 'asking')
  if (isApplied && isAutoCheck) await openAfterCheck($, requestId)
}

/** The rewrite call: moves to Rewriting and runs it in the background. */
async function enterRewriting($: Engine, requestId: number): Promise<void> {
  const isApplied = await changeIfCurrent($, requestId, flow =>
    flow.stage === 'questions' ? { ...flow, stage: 'rewriting', typingFor: null, note: null, autoSendAt: null } : flow,
  )
  if (isApplied) runInBackground($, () => runRewrite($, requestId))
}

async function runRewrite($: Engine, requestId: number): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.requestId !== requestId || flow.stage !== 'rewriting') return

  try {
    const pairs = answeredPairs(flow.questions, flow.answers)
    const level = detailOrDefault(flow.detailLevel)
    const reply = await $.model.complete({
      ...rewriteModel(level),
      system: rewriteSystem(level),
      // Questions left open are chosen by the model (only "fill the rest" leaves any open).
      prompt: rewritePrompt(flow.original, pairs, unansweredQuestions(flow.questions, flow.answers)),
    })
    if ((await read($, flowAtom)).requestId !== requestId) return

    const parsed = reply.isAnswered ? parseRewrite(reply.text) : undefined
    if (parsed === undefined || !parsed.isOk) {
      await failStep($, requestId, 'rewriting')
      return
    }

    const now = await $.clock.now()
    const stats = buildStats(flow.original, parsed.prompt, parsed.added)
    const entry: PromptUpgradeEntry = {
      id: `${now}-${requestId}`,
      original: flow.original,
      upgraded: parsed.prompt,
      added: parsed.added,
      ...stats,
      answers: pairs,
      detailLevel: level,
      ...(flow.isSendingAutomatically ? { sentAutomatically: true } : {}),
      at: now,
    }
    if (flow.isSendingAutomatically) {
      await sendAutomatically($, requestId, entry)
      return
    }
    const isApplied = await changeIfCurrent($, requestId, current => ({
      ...current,
      stage: 'review',
      upgraded: parsed.prompt,
      added: parsed.added,
      entryId: entry.id,
      note: null,
    }))
    if (!isApplied) return

    const history = await update($, historyAtom, list => trimHistory(list, entry))
    await saveHistory($, history)
  } catch {
    await failStep($, requestId, 'rewriting')
  }
}

/** Fill and send, after the rewrite: sends the upgrade with no review, keeps it in the history and closes the pane. */
async function sendAutomatically($: Engine, requestId: number, entry: PromptUpgradeEntry): Promise<void> {
  const flow = await read($, flowAtom)
  const isApplied = await changeIfCurrent($, requestId, current => idleFlow(current.requestId + 1))
  if (!isApplied) return

  const history = await update($, historyAtom, list => trimHistory(list, entry))
  await saveHistory($, history)
  await closePane($)
  await emptyIfHolding($, flow.original)
  submitAsUser($, entry.upgraded)
  // A short note that clears itself.
  setStatus($, AUTO_SENT_STATUS)
  $.clock.after(SENT_STATUS_MS, () => setStatus($, undefined))
}

/** Schedules the end of the Auto countdown; a timer for an old request or an answered countdown does nothing. */
function scheduleAutoSend($: Engine, requestId: number, dueAt: number): void {
  void (async () => {
    const remaining = Math.max(0, dueAt - (await $.clock.now()))
    $.clock.after(remaining, () => {
      void (async () => {
        const flow = await read($, flowAtom)
        if (flow.requestId !== requestId || flow.autoSendAt !== dueAt || flow.stage !== 'questions') return
        await fillAndSend($)
      })().catch(() => undefined)
    })
  })().catch(() => undefined)
}

/** The Auto countdown ending, or "Do it for me": the rewrite chooses for the open questions, then it sends. */
async function fillAndSend($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.stage !== 'questions') return

  await changeIfCurrent($, flow.requestId, current => ({
    ...current,
    stage: 'rewriting',
    typingFor: null,
    note: null,
    autoSendAt: null,
    isSendingAutomatically: true,
  }))
  runInBackground($, () => runRewrite($, flow.requestId))
}

/** The person's first press in the pane ends the Auto countdown; the flow goes on as a normal upgrade. */
async function cancelCountdown($: Engine): Promise<void> {
  if ((await read($, flowAtom)).autoSendAt === null) return
  await changeFlow($, flow => (flow.autoSendAt === null ? flow : { ...flow, autoSendAt: null }))
}

/** Try again after an error: repeats the call that failed. */
async function tryAgain($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.stage !== 'error') return

  const requestId = flow.requestId + 1
  if (flow.failedStep === 'asking') {
    await changeFlow($, current => ({ ...current, requestId, stage: 'asking' }))
    runInBackground($, () => runCheck($, requestId))
  } else {
    await changeFlow($, current => ({ ...current, requestId, stage: 'rewriting' }))
    runInBackground($, () => runRewrite($, requestId))
  }
}

/** The "already looks good" card's Upgrade anyway: the rewrite with no questions. */
async function upgradeAnyway($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.stage !== 'ready') return

  const requestId = flow.requestId + 1
  await changeFlow($, current => ({ ...current, requestId, stage: 'rewriting', questions: [], answers: [], note: null }))
  runInBackground($, () => runRewrite($, requestId))
}

/** Review's Rewrite at <Level>: the same answers, rewritten at the level now picked. */
async function rewriteAtNewLevel($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  const pickedLevel = await read($, detailAtom)
  if (flow.stage !== 'review' || pickedLevel === detailOrDefault(flow.detailLevel)) return

  const requestId = flow.requestId + 1
  await changeFlow($, current => ({ ...current, requestId, stage: 'rewriting', detailLevel: pickedLevel, note: null }))
  runInBackground($, () => runRewrite($, requestId))
}

/** Saves a detail level in the store and publishes it for drawing. Returns false for a bad value. */
async function setDetail($: Engine, value: string): Promise<boolean> {
  const level = parseDetail(value)
  if (level === undefined) return false
  await $.store.set(STORE_DETAIL, level)
  await update($, detailAtom, () => level)
  return true
}

/** Sets one question's answer; when none are left open the rewrite starts. */
async function answerQuestion($: Engine, index: number, status: 'answered' | 'skipped', text: string): Promise<void> {
  const flow = await changeFlow($, current =>
    current.stage !== 'questions' || current.answers[index] === undefined
      ? current
      : {
          ...current,
          typingFor: current.typingFor === index ? null : current.typingFor,
          autoSendAt: null,
          answers: current.answers.map((answer, position) => (position === index ? { status, text } : answer)),
        },
  )
  if (flow.stage === 'questions' && openCount(flow.answers) === 0) await enterRewriting($, flow.requestId)
}

/** "Skip the rest, upgrade now". */
async function skipTheRest($: Engine): Promise<void> {
  const flow = await changeFlow($, current =>
    current.stage !== 'questions'
      ? current
      : {
          ...current,
          autoSendAt: null,
          answers: current.answers.map(answer => (answer.status === 'open' ? { status: 'skipped' as const, text: '' } : answer)),
        },
  )
  if (flow.stage === 'questions') await enterRewriting($, flow.requestId)
}

async function toggleOther($: Engine, index: number): Promise<void> {
  await changeFlow($, flow =>
    flow.stage === 'questions' ? { ...flow, typingFor: flow.typingFor === index ? null : index, autoSendAt: null } : flow,
  )
}

/** Submits text as the person's own words; if that fails the text goes back in the prompt box. */
function submitAsUser($: Engine, text: string): void {
  void $.prompt.submit({ text, asUser: true }).catch(async () => {
    await restorePrompt($, text)
    showToast($, "Couldn't send that. Your text is back in the prompt box.")
  })
}

/** Sends text as the person's own words, closing the pane first. */
async function sendText($: Engine, text: string): Promise<void> {
  const { original } = await read($, flowAtom)
  await resetFlow($)
  await closePane($)
  await emptyIfHolding($, original)
  submitAsUser($, text)
}

async function runUpgrade($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  const text = (flow.stage === 'editing' ? flow.draft : flow.upgraded).trim()
  if (flow.stage !== 'review' && flow.stage !== 'editing') return
  if (text === '') {
    await changeFlow($, current => ({ ...current, note: { text: 'There is nothing to run yet.', tone: 'warn' } }))
    return
  }
  await sendText($, text)
}

async function sendOriginal($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.original.trim() === '') return
  await sendText($, flow.original)
}

/** Cancel, or the pane's own close: the original goes back in the prompt box and the flow resets. */
async function cancelFlow($: Engine, isClosing: boolean): Promise<void> {
  const flow = await read($, flowAtom)
  await resetFlow($)
  if (flow.stage !== 'idle' && flow.stage !== 'history') await restorePrompt($, flow.original)
  if (isClosing) await closePane($)
}

/** Keeps edited text as the upgrade, in the flow and in the history. */
async function applyEdit($: Engine, text: string): Promise<void> {
  const flow = await read($, flowAtom)
  const upgraded = text.trim() === '' ? flow.upgraded : text
  await changeFlow($, current => ({ ...current, upgraded, draft: upgraded }))

  const stats = buildStats(flow.original, upgraded, flow.added)
  const history = await update($, historyAtom, list =>
    list.map(entry => (entry.id === flow.entryId ? { ...entry, upgraded, ...stats } : entry)),
  )
  await saveHistory($, history)
}

async function finishEdit($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.stage !== 'editing') return
  await applyEdit($, flow.draft)
  await changeFlow($, current => ({ ...current, stage: 'review' }))
}

async function copyUpgrade($: Engine, surface: PaneInput['surface']): Promise<void> {
  const flow = await read($, flowAtom)
  const result = await $.ui.copy({ text: flow.upgraded, surface })
  await changeFlow($, current => ({
    ...current,
    note: result.isCopied ? { text: 'Copied the upgrade.', tone: 'good' } : { text: 'Could not copy here.', tone: 'warn' },
  }))
}

/** Opens a saved upgrade's review. */
async function reopenEntry($: Engine, entryId: string): Promise<void> {
  const entry = (await read($, historyAtom)).find(saved => saved.id === entryId)
  if (entry === undefined) return
  await changeFlow($, flow => ({
    ...idleFlow(flow.requestId + 1),
    stage: 'review',
    original: entry.original,
    detailLevel: detailOrDefault(entry.detailLevel),
    // The saved answers come back, so Rewrite at <Level> can use them.
    questions: entry.answers.map(pair => ({ question: pair.question, options: [pair.answer] })),
    answers: entry.answers.map(pair => ({ status: 'answered' as const, text: pair.answer })),
    upgraded: entry.upgraded,
    added: entry.added,
    entryId: entry.id,
  }))
}

async function showHistory($: Engine): Promise<boolean> {
  await changeFlow($, flow => ({ ...idleFlow(flow.requestId + 1), stage: 'history' }))
  if (await openPane($)) return true
  await resetFlow($)
  await closePane($)
  return false
}

async function showTyping($: Engine): Promise<boolean> {
  await changeFlow($, flow => ({ ...idleFlow(flow.requestId + 1), stage: 'typing' }))
  if (await openPane($)) return true
  await resetFlow($)
  await closePane($)
  return false
}

/** Starts a rough prompt in the background and says so in one toast when the window is too narrow. */
function startInBackground($: Engine, original: string, startedBy: PromptUpgradeSource = 'command'): void {
  void (async () => {
    if (!(await beginPrompt($, original, startedBy))) showToast($, NARROW_WINDOW)
  })().catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Drawing: small pieces
// ---------------------------------------------------------------------------

type Ui = {
  Box: BoxElement
  Text: TextElement
  Button: ButtonElement
  Input: InputElement | undefined
  Select: SelectElement | undefined
  width: number
  /** The level picked in the dropdown right now. */
  detailLevel: PromptUpgradeDetail
}

type ChipKind = 'gold' | 'slate' | 'quiet'
type ChipSpec = { key: string; label: string; kind: ChipKind; onPress: () => void }

function chipElement(ui: Ui, spec: ChipSpec, room: number): RenderElement {
  const { Button, Text } = ui
  const text = chipText(truncate(spec.label, Math.max(1, room - 2)))
  const face =
    spec.kind === 'gold' ? (
      <Text backgroundColor={COLORS.gold} color={COLORS.ink} weight="bold">{text}</Text>
    ) : spec.kind === 'slate' ? (
      <Text backgroundColor={COLORS.slate} color={COLORS.text}>{text}</Text>
    ) : (
      <Text color={COLORS.muted}>{text}</Text>
    )

  return (
    <Button key={spec.key} plain onPress={spec.onPress}>
      {face}
    </Button>
  )
}

/** Chips in as many rows as the width needs, so none wraps. */
function chipRows(ui: Ui, specs: readonly ChipSpec[], room: number, indent = 0): RenderElement[] {
  const { Box } = ui
  const widths = specs.map(spec => Math.min(room, spec.label.length + 2))
  return packRows(widths, 1, room).map((row, rowIndex) => (
    <Box key={`chips-${indent}-${rowIndex}-${row.join('-')}`} flexDirection="row" gap={1} paddingLeft={indent}>
      {row.map(index => {
        const spec = specs[index]
        return spec === undefined ? null : chipElement(ui, spec, room)
      })}
    </Box>
  ))
}

function headingRow(ui: Ui, label: string, width: number = ui.width): RenderElement {
  const { Text } = ui
  const parts = headingParts(label, width)
  return (
    <Text wrap="truncate-end">
      <Text color={COLORS.muted}>{`${parts.label} `}</Text>
      <Text color={COLORS.hairline}>{parts.rule}</Text>
    </Text>
  )
}

function plainRow(ui: Ui, text: string, color: string = COLORS.text, width: number = ui.width): RenderElement {
  const { Text } = ui
  return <Text color={color} wrap="truncate-end">{truncate(text, width) || ' '}</Text>
}

/** A framed card holding wrapped lines. */
function cardBox(ui: Ui, name: string, text: string, outerWidth: number, borderColor: string): RenderElement {
  const { Box, Text } = ui
  const lines = cardLines(text, Math.max(1, outerWidth - 4))
  return (
    <Box key={name} borderStyle="round" borderColor={borderColor} width={outerWidth} paddingX={1} flexDirection="column">
      {lines.map(line => (
        <Text color={COLORS.text} wrap="truncate-end">{line === '' ? ' ' : line}</Text>
      ))}
    </Box>
  )
}

/** The detail dropdown: Low, Medium or High. A pick is saved; drawing it saves nothing. */
function detailSelect($: Engine, ui: Ui): RenderElement | null {
  const { Select } = ui
  if (Select === undefined) return null
  return (
    <Select
      key="detail-level"
      label="Detail"
      value={ui.detailLevel}
      options={DETAIL_LEVELS.map(level => ({ value: level, label: DETAIL_SPECS[level].optionLabel }))}
      onSelect={value => void (async () => {
        await cancelCountdown($)
        await setDetail($, value)
      })().catch(() => undefined)}
    />
  )
}

/** The title and its gold rule; the dropdown sits on the title's row, or under it when narrow. */
function masthead($: Engine, ui: Ui, hasDetail: boolean): RenderElement[] {
  const { Box, Text } = ui
  const rule = titleRuleParts(TITLE_TEXT, ui.width)
  const title = <Text weight="bold" color={COLORS.text}>{TITLE_TEXT}</Text>
  const select = hasDetail ? detailSelect($, ui) : null
  const ruleRow = (
    <Text wrap="truncate-end">
      <Text color={COLORS.gold}>{rule.gold}</Text>
      <Text color={COLORS.hairline}>{rule.hairline}</Text>
    </Text>
  )
  if (select === null) return [title, ruleRow]
  if (!isSelectInline(ui.width)) return [title, select, ruleRow]

  return [
    <Box key="title-row" flexDirection="row" justifyContent="space-between" width={ui.width}>
      {title}
      {select}
    </Box>,
    ruleRow,
  ]
}

function tracker(ui: Ui, flow: PromptUpgradeFlow): RenderElement | null {
  const { Text } = ui
  const step = currentStep(flow.stage, flow.failedStep)
  if (step === null) return null

  const pieces = trackerPieces(stepStates(step), ui.width)
  return (
    <Text wrap="truncate-end">
      {pieces.map(piece => (
        <Text
          color={
            piece.kind === 'done'
              ? COLORS.green
              : piece.kind === 'current'
                ? COLORS.gold
                : piece.kind === 'separator'
                  ? COLORS.hairline
                  : COLORS.muted
          }
          weight={piece.kind === 'current' ? 'bold' : undefined}
        >
          {piece.text}
        </Text>
      ))}
    </Text>
  )
}

/** Under the tracker, when automatic mode left the words in the prompt box: a second Enter there sends them as typed. */
function enterHint(ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  const isShownOn = flow.stage === 'questions' || flow.stage === 'ready' || flow.stage === 'error'
  if (flow.startedBy !== 'auto' || !isShownOn) return []
  return [plainRow(ui, 'Press Enter in the prompt box to send it as typed.', COLORS.muted)]
}

function cancelChip(onCancel: () => void): ChipSpec {
  return { key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: onCancel }
}

// ---------------------------------------------------------------------------
// Drawing: the screens
// ---------------------------------------------------------------------------

/** Step 1, and the quiet part of steps 2 and 3: the prompt in a frame and a line on what is happening. */
function drawWorking($: Engine, ui: Ui, flow: PromptUpgradeFlow, statusLine: string): RenderElement[] {
  const rows: RenderElement[] = [
    headingRow(ui, 'Your prompt'),
    cardBox(ui, 'original-card', flow.original, ui.width, COLORS.hairline),
    plainRow(ui, statusLine, COLORS.muted),
  ]
  const answered = answeredPairs(flow.questions, flow.answers)
  if (answered.length > 0) {
    rows.push(headingRow(ui, 'What you told me'))
    for (const pair of answered) rows.push(plainRow(ui, `${pair.question}  →  ${pair.answer}`, COLORS.text))
  }
  rows.push(...chipRows(ui, [cancelChip(() => void cancelFlow($, true))], ui.width))

  return rows
}

function drawTyping($: Engine, ui: Ui): RenderElement[] {
  const { Input, Box } = ui
  const rows: RenderElement[] = [headingRow(ui, 'Your prompt'), plainRow(ui, 'Type a rough prompt. Press Enter and I will upgrade it.', COLORS.muted)]
  if (Input !== undefined) {
    rows.push(
      <Box flexDirection="row">
        <Input
          key="typed-prompt"
          label="Prompt"
          placeholder="what you want"
          submitLabel="Upgrade"
          autoFocus
          onSubmit={value => {
            if (value.trim() === '') return
            void beginPrompt($, value.trim()).then(isPlaced => {
              if (!isPlaced) showToast($, NARROW_WINDOW)
            }).catch(() => undefined)
          }}
        />
      </Box>,
    )
  }
  rows.push(...chipRows(ui, [cancelChip(() => void cancelFlow($, true))], ui.width))

  return rows
}

function drawQuestions($: Engine, ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  const { Text, Box, Input } = ui
  const total = flow.questions.length
  const answered = answeredCount(flow.answers)
  const isAutoLevel = detailOrDefault(flow.detailLevel) === 'auto'
  const rows: RenderElement[] = [
    headingRow(ui, 'A few quick questions'),
    plainRow(ui, `${answered} of ${total} answered`, COLORS.muted),
  ]
  // The countdown is quiet and static: no digits, no redraw each second.
  if (flow.autoSendAt !== null) {
    rows.push(plainRow(ui, "I'll fill in the rest and send it in 30 seconds unless you answer.", COLORS.muted))
  }

  flow.questions.forEach((question, index) => {
    const answer = flow.answers[index] ?? { status: 'open' as const, text: '' }
    const badge =
      answer.status === 'answered' ? (
        <Text backgroundColor={COLORS.green} color={COLORS.ink} weight="bold">{' ✓ '}</Text>
      ) : answer.status === 'skipped' ? (
        <Text backgroundColor={COLORS.hairline} color={COLORS.muted}>{' – '}</Text>
      ) : (
        <Text backgroundColor={COLORS.gold} color={COLORS.ink} weight="bold">{` ${index + 1} `}</Text>
      )
    const lines = wrapText(question.question, Math.max(1, ui.width - 4))
    rows.push(<Text> </Text>)
    rows.push(
      <Text wrap="truncate-end">
        {badge}
        <Text color={COLORS.text} weight="bold">{` ${lines[0] ?? ''}`}</Text>
      </Text>,
    )
    for (const line of lines.slice(1)) rows.push(plainRow(ui, `    ${line}`, COLORS.text))
    if (answer.status === 'answered') rows.push(plainRow(ui, `    → ${answer.text}`, COLORS.green))
    if (answer.status === 'skipped') rows.push(plainRow(ui, '    skipped', COLORS.muted))

    const isOptionPicked = (option: string) => answer.status === 'answered' && answer.text === option
    const isOtherPicked = answer.status === 'answered' && !question.options.includes(answer.text)
    const specs: ChipSpec[] = [
      ...question.options.map((option, position): ChipSpec => ({
        key: `q${index}-opt-${position}`,
        label: option,
        kind: isOptionPicked(option) ? 'gold' : 'slate',
        onPress: () => void answerQuestion($, index, 'answered', option).catch(() => undefined),
      })),
      {
        key: `q${index}-other`,
        label: isOtherPicked ? truncate(answer.text, 30) : 'Other (type it)',
        kind: isOtherPicked || flow.typingFor === index ? 'gold' : 'slate',
        onPress: () => void toggleOther($, index).catch(() => undefined),
      },
      {
        key: `q${index}-skip`,
        label: 'Skip',
        kind: 'quiet',
        onPress: () => void answerQuestion($, index, 'skipped', '').catch(() => undefined),
      },
    ]
    rows.push(...chipRows(ui, specs, Math.max(8, ui.width - 4), 4))

    if (flow.typingFor === index && Input !== undefined) {
      rows.push(
        <Box flexDirection="row" paddingLeft={4}>
          <Input
            key={`q${index}-other-input`}
            label="Answer"
            placeholder="type it"
            submitLabel="Save"
            autoFocus
            onSubmit={value => {
              const text = value.trim()
              if (text !== '') void answerQuestion($, index, 'answered', text).catch(() => undefined)
            }}
          />
        </Box>,
      )
    }
  })

  rows.push(<Text> </Text>)
  rows.push(
    ...chipRows(
      ui,
      [
        ...(isAutoLevel
          ? [{ key: 'do-it-for-me', label: 'Do it for me', kind: 'gold' as const, onPress: () => void fillAndSend($).catch(() => undefined) }]
          : []),
        {
          key: 'skip-rest',
          label: 'Skip the rest, upgrade now',
          kind: isAutoLevel ? ('slate' as const) : ('gold' as const),
          onPress: () => void skipTheRest($).catch(() => undefined),
        },
        cancelChip(() => void cancelFlow($, true)),
      ],
      ui.width,
    ),
  )
  return rows
}

/** The review's numbers: three rounded tiles of heavy digits, or one line when the pane is narrow. */
function drawStats(ui: Ui, flow: PromptUpgradeFlow): RenderElement {
  const { Box, Text } = ui
  const layout = statLayout(buildStats(flow.original, flow.upgraded, flow.added), ui.width)
  if (layout.mode === 'line') return plainRow(ui, layout.text, COLORS.text)

  return (
    <Box flexDirection="row" gap={1}>
      {layout.tiles.map((tile, index) => (
        <Box key={`stat-${index}`} borderStyle="round" borderColor={COLORS.hairline} paddingX={1} flexDirection="column">
          {tile.rows.map(row => (
            <Text color={tile.tone === 'good' ? COLORS.green : COLORS.text} weight="bold">{center(row, tile.innerWidth)}</Text>
          ))}
          <Text color={COLORS.muted}>{center(tile.label, tile.innerWidth)}</Text>
        </Box>
      ))}
    </Box>
  )
}

function drawNote(ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  if (flow.note === null) return []
  return [plainRow(ui, flow.note.text, flow.note.tone === 'good' ? COLORS.green : COLORS.amber)]
}

function drawAdded(ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  const { Text } = ui
  const rows: RenderElement[] = [headingRow(ui, 'What I added')]
  if (flow.added.length === 0) {
    rows.push(plainRow(ui, 'Nothing new was needed.', COLORS.muted))
    return rows
  }
  for (const item of flow.added) {
    const lines = wrapText(item, Math.max(1, ui.width - 2))
    lines.forEach((line, index) => {
      rows.push(
        <Text wrap="truncate-end">
          <Text color={COLORS.green}>{index === 0 ? '+ ' : '  '}</Text>
          <Text color={COLORS.text}>{line}</Text>
        </Text>,
      )
    })
  }
  return rows
}

/** My prompt on the left, the upgrade on the right with a gold outline; stacked when narrow. */
function drawCards(ui: Ui, flow: PromptUpgradeFlow): RenderElement {
  const { Box } = ui
  const layout = cardLayout(ui.width)
  const mine = (
    <Box key="original-column" flexDirection="column" width={layout.cardWidth}>
      {headingRow(ui, 'Your prompt', layout.cardWidth)}
      {cardBox(ui, 'original-card', flow.original, layout.cardWidth, COLORS.hairline)}
    </Box>
  )
  const upgrade = (
    <Box key="upgrade-column" flexDirection="column" width={layout.cardWidth}>
      {headingRow(ui, 'The upgrade', layout.cardWidth)}
      {cardBox(ui, 'upgrade-card', flow.upgraded, layout.cardWidth, COLORS.gold)}
    </Box>
  )
  return layout.isStacked ? (
    <Box flexDirection="column" width={ui.width}>
      {upgrade}
      {mine}
    </Box>
  ) : (
    <Box flexDirection="row" gap={1} width={ui.width}>
      {mine}
      {upgrade}
    </Box>
  )
}

function drawReview($: Engine, ui: Ui, e: PaneInput, flow: PromptUpgradeFlow): RenderElement[] {
  const usedLevel = detailOrDefault(flow.detailLevel)
  // The picked level differs from the one this upgrade was written at: offer a rewrite.
  const rewriteChips: ChipSpec[] =
    ui.detailLevel === usedLevel
      ? []
      : [
          {
            key: 'rewrite-level',
            label: `Rewrite at ${DETAIL_SPECS[ui.detailLevel].label}`,
            kind: 'gold',
            onPress: () => void rewriteAtNewLevel($).catch(() => undefined),
          },
        ]
  return [
    drawStats(ui, flow),
    ...chipRows(
      ui,
      [
        { key: 'run', label: 'Run it', kind: 'gold', onPress: () => void runUpgrade($).catch(() => undefined) },
        ...rewriteChips,
        {
          key: 'edit',
          label: 'Edit',
          kind: 'slate',
          onPress: () => void changeFlow($, current => ({ ...current, stage: 'editing', draft: current.upgraded, note: null })).catch(() => undefined),
        },
        { key: 'copy', label: 'Copy', kind: 'slate', onPress: () => void copyUpgrade($, e.surface).catch(() => undefined) },
        cancelChip(() => void cancelFlow($, true)),
      ],
      ui.width,
    ),
    plainRow(ui, `Written at ${DETAIL_SPECS[usedLevel].label} detail`, COLORS.muted),
    ...drawNote(ui, flow),
    ...drawAdded(ui, flow),
    drawCards(ui, flow),
  ]
}

function drawEditing($: Engine, ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  const { Box, Input } = ui
  const rows: RenderElement[] = [
    ...chipRows(
      ui,
      [
        { key: 'run', label: 'Run it', kind: 'gold', onPress: () => void runUpgrade($).catch(() => undefined) },
        { key: 'edit-back', label: 'Back', kind: 'slate', onPress: () => void finishEdit($).catch(() => undefined) },
        cancelChip(() => void cancelFlow($, true)),
      ],
      ui.width,
    ),
    ...drawNote(ui, flow),
    headingRow(ui, 'Edit the upgrade'),
    plainRow(ui, 'Change the text, then press Enter to run it.', COLORS.muted),
  ]
  if (Input !== undefined) {
    rows.push(
      <Box flexDirection="row">
        <Input
          key="edit-input"
          label="Upgrade"
          value={flow.draft}
          placeholder="the upgraded prompt"
          submitLabel="Run"
          autoFocus
          onInput={value => {
            void changeFlow($, current => (current.stage === 'editing' ? { ...current, draft: value } : current)).catch(() => undefined)
          }}
          onSubmit={value => {
            void (async () => {
              await changeFlow($, current => (current.stage === 'editing' ? { ...current, draft: value } : current))
              await runUpgrade($)
            })().catch(() => undefined)
          }}
        />
      </Box>,
    )
  }
  rows.push(headingRow(ui, 'Your prompt'))
  rows.push(cardBox(ui, 'original-card', flow.original, ui.width, COLORS.hairline))

  return rows
}

function drawError($: Engine, ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  const { Box, Text } = ui
  const doing = flow.failedStep === 'asking' ? 'reading your prompt' : 'writing the upgrade'
  const lines = wrapText(`Something went wrong while ${doing}.`, Math.max(1, ui.width - 4))

  return [
    <Box key="error-card" borderStyle="round" borderColor={COLORS.amber} width={ui.width} paddingX={1} flexDirection="column">
      {lines.map(line => (
        <Text color={COLORS.amber} wrap="truncate-end">{line}</Text>
      ))}
      <Text color={COLORS.green}>Your prompt is safe.</Text>
    </Box>,
    ...chipRows(
      ui,
      [
        { key: 'retry', label: 'Try again', kind: 'gold', onPress: () => void tryAgain($).catch(() => undefined) },
        { key: 'send-original', label: 'Send my original', kind: 'slate', onPress: () => void sendOriginal($).catch(() => undefined) },
        cancelChip(() => void cancelFlow($, true)),
      ],
      ui.width,
    ),
    headingRow(ui, 'Your prompt'),
    cardBox(ui, 'original-card', flow.original, ui.width, COLORS.hairline),
  ]
}

/** The prompt check found nothing missing: a calm card with the choice to send it or upgrade anyway. */
function drawReady($: Engine, ui: Ui, flow: PromptUpgradeFlow): RenderElement[] {
  const { Box, Text } = ui
  const lines = wrapText('This already looks good. It has what it needs, so it can go as typed.', Math.max(1, ui.width - 4))
  return [
    <Box key="ready-card" borderStyle="round" borderColor={COLORS.green} width={ui.width} paddingX={1} flexDirection="column">
      {lines.map(line => (
        <Text color={COLORS.green} wrap="truncate-end">{line}</Text>
      ))}
    </Box>,
    ...chipRows(
      ui,
      [
        { key: 'send-as-typed', label: 'Send as typed', kind: 'gold', onPress: () => void sendOriginal($).catch(() => undefined) },
        { key: 'upgrade-anyway', label: 'Upgrade anyway', kind: 'slate', onPress: () => void upgradeAnyway($).catch(() => undefined) },
        cancelChip(() => void cancelFlow($, true)),
      ],
      ui.width,
    ),
    headingRow(ui, 'Your prompt'),
    cardBox(ui, 'original-card', flow.original, ui.width, COLORS.hairline),
  ]
}

function drawHistory($: Engine, ui: Ui, history: readonly PromptUpgradeEntry[], now: number): RenderElement[] {
  const { Button, Text } = ui
  const rows: RenderElement[] = [headingRow(ui, 'Your last upgrades')]
  if (history.length === 0) {
    rows.push(plainRow(ui, 'No upgrades yet. Type /better and a rough prompt.', COLORS.muted))
  }
  const ageWidth = 9
  const tagWidth = 5
  for (const entry of history) {
    const age = padEnd(ageLabel(now - entry.at), ageWidth)
    const tag = padEnd(DETAIL_SPECS[detailOrDefault(entry.detailLevel)].tag, tagWidth)
    const snippet = truncate(shorten(entry.original, 200), Math.max(1, ui.width - ageWidth - tagWidth))
    rows.push(
      <Button key={`history-${entry.id}`} plain onPress={() => void reopenEntry($, entry.id).catch(() => undefined)}>
        <Text color={COLORS.muted}>{age}</Text>
        <Text color={COLORS.gold}>{tag}</Text>
        <Text color={COLORS.text}>{snippet}</Text>
      </Button>,
    )
  }
  rows.push(<Text> </Text>)
  rows.push(...chipRows(ui, [{ key: 'close', label: 'Close', kind: 'slate', onPress: () => void cancelFlow($, true).catch(() => undefined) }], ui.width))

  return rows
}

function drawIdle(ui: Ui): RenderElement[] {
  return [plainRow(ui, 'Nothing to upgrade right now.', COLORS.muted), plainRow(ui, 'Type /better and a rough prompt.', COLORS.muted)]
}

// ---------------------------------------------------------------------------
// Drawing: the pane
// ---------------------------------------------------------------------------

async function drawPane($: Engine, e: PaneInput): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = (elements as Partial<Elements['terminal']>).Input
  const Select = (elements as Partial<Elements['terminal']>).Select
  const width = Math.max(MIN_WIDTH, e.props.bodyColumns)
  const flow = await read($, flowAtom)
  const ui: Ui = { Box, Text, Button, Input, Select, width, detailLevel: await read($, detailAtom) }
  // The dropdown shows while typing, answering questions and reviewing.
  const hasDetail = flow.stage === 'typing' || flow.stage === 'questions' || flow.stage === 'review'
  const header = [...masthead($, ui, hasDetail), tracker(ui, flow), ...enterHint(ui, flow)]
  let body: RenderElement[]

  switch (flow.stage) {
    case 'typing':
      body = drawTyping($, ui)
      break
    case 'reading':
      body = drawWorking($, ui, flow, 'Reading your prompt.')
      break
    case 'checking':
    case 'asking':
      body = drawWorking($, ui, flow, 'Checking your prompt.')
      break
    case 'ready':
      body = drawReady($, ui, flow)
      break
    case 'questions':
      body = drawQuestions($, ui, flow)
      break
    case 'rewriting':
      body = drawWorking($, ui, flow, flow.isSendingAutomatically ? 'Writing the upgrade. It sends on its own.' : 'Writing the upgrade.')
      break
    case 'review':
      body = drawReview($, ui, e, flow)
      break
    case 'editing':
      body = drawEditing($, ui, flow)
      break
    case 'error':
      body = drawError($, ui, flow)
      break
    case 'history':
      body = drawHistory($, ui, await read($, historyAtom), await $.clock.now())
      break
    default:
      body = drawIdle(ui)
  }

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Box flexDirection="column" width={width}>
        {header}
      </Box>
      <Box flexDirection="column" width={width}>
        {body}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function registerPromptUpgrade(on: On): void {
  // Session start (and each reload): the command, the saved history, and any step a reload cut short.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt before it is sent',
        argumentHint: '<prompt> | on | off | level auto|low|medium|high | history',
        immediate: true,
      })
      const saved = restoreHistory(await $.store.get(STORE_HISTORY))
      await update($, historyAtom, () => saved)
      // Publish the saved automatic mode for other mods to show.
      const isAutoSaved = (await $.store.get(STORE_AUTO)) === true
      await update($, autoAtom, () => isAutoSaved)
      // Publish the saved detail level (medium until one is picked) for drawing.
      const savedLevel = detailOrDefault(await $.store.get(STORE_DETAIL))
      await update($, detailAtom, () => savedLevel)
      await resumeFlow($)
    } catch {
      // The mod still works without its saved history.
    }
    return next(e)
  })

  // /better <prompt>, /better, /better on, /better off, /better history.
  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const action = parseBetterArgs(e.args)
      switch (action.kind) {
        case 'on':
          await $.store.set(STORE_AUTO, true)
          await update($, autoAtom, () => true)
          return { text: 'Automatic mode is on. Prompts you type go to Prompt Upgrade first.' }
        case 'off':
          await $.store.set(STORE_AUTO, false)
          await update($, autoAtom, () => false)
          return { text: 'Automatic mode is off. Prompts are sent as you type them.' }
        case 'level':
          if (action.level === undefined || !(await setDetail($, action.level))) return { text: BAD_LEVEL_TEXT }
          return { text: `Detail is now ${DETAIL_SPECS[action.level].label}. New upgrades use it.` }
        case 'history':
          void showHistory($).then(isPlaced => {
            if (!isPlaced) showToast($, NARROW_WINDOW)
          }).catch(() => undefined)
          return { text: 'Opening your last upgrades.' }
        case 'empty':
          void showTyping($).then(isPlaced => {
            if (!isPlaced) showToast($, NARROW_WINDOW)
          }).catch(() => undefined)
          return { text: 'Type your prompt in the Prompt Upgrade pane.' }
        default:
          startInBackground($, action.text)
          return { text: COMMAND_TEXT }
      }
    } catch {
      return { text: PROBLEM_TEXT }
    }
  }).catch(() => ({ text: PROBLEM_TEXT }))

  // Automatic mode: a typed prompt goes to the pane first. Everything else passes untouched.
  on('prompt.submit', async ($, e, next) => {
    const isAuto = (await $.store.get(STORE_AUTO)) === true
    const decision = decideSubmit(
      {
        text: e.text,
        originKind: e.origin.kind,
        hasCommand: e.command !== undefined,
        isMeta: e.isMeta === true,
        attachmentCount: e.attachments?.length ?? 0,
        hasTurn: e.turnId !== undefined,
      },
      isAuto,
    )
    if (decision.kind === 'pass') return next(e)
    if (decision.kind === 'strip') return next({ ...e, text: decision.text })

    // The same prompt sent again (a second Enter, or after Cancel) goes through as typed.
    const typedPrompt = normalizePrompt(decision.text)
    if (typedPrompt === (await read($, lastInterceptedAtom))) {
      await update($, lastInterceptedAtom, () => '')
      await dropPendingUpgrade($, typedPrompt)
      return next(e)
    }
    await update($, lastInterceptedAtom, () => typedPrompt)

    startInBackground($, decision.text, 'auto')
    return { drop: DROP_TEXT }
  }).catch(($, e, next) => next(e))

  // Keeps the end of Claude's last main-loop reply as context for the prompt check.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await update($, lastReplyAtom, () => replyTail(e.answer))
      } catch {
        // The check still works without it.
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The person closing the pane (Esc or its close mark) puts their words back, like Cancel.
  on('ui.close', { id: 'prompt-upgrade' }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      try {
        await cancelFlow($, false)
      } catch {
        // The pane closes either way.
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'prompt-upgrade' }, async ($, e) => drawPane($, e))
}

/** A second Enter: whatever the first one started for this prompt is cancelled, with nothing restored. */
async function dropPendingUpgrade($: Engine, typedPrompt: string): Promise<void> {
  try {
    const flow = await read($, flowAtom)
    if (flow.startedBy !== 'auto' || flow.stage === 'idle' || normalizePrompt(flow.original) !== typedPrompt) return

    // Resetting bumps the request, so a check or rewrite still in flight and the countdown are ignored.
    await resetFlow($)
    await closePane($)
    setStatus($, undefined)
  } catch {
    // The prompt goes through as typed either way.
  }
}

/** After a reload: a model call that was in flight is run again. */
async function resumeFlow($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.stage === 'checking') {
    // Automatic mode's check, cut short before the pane opened.
    const requestId = flow.requestId + 1
    await changeFlow($, current => ({ ...current, requestId }))
    setStatus($, CHECKING_STATUS)
    runInBackground($, () => runCheck($, requestId))
  } else if (flow.stage === 'reading' || flow.stage === 'asking') {
    const requestId = flow.requestId + 1
    await changeFlow($, current => ({ ...current, requestId, stage: 'asking' }))
    runInBackground($, () => runCheck($, requestId))
  } else if (flow.stage === 'rewriting') {
    const requestId = flow.requestId + 1
    await changeFlow($, current => ({ ...current, requestId }))
    runInBackground($, () => runRewrite($, requestId))
  } else if (flow.stage === 'questions' && flow.autoSendAt !== null) {
    // The Auto countdown goes on with whatever time is left.
    scheduleAutoSend($, flow.requestId, flow.autoSendAt)
  }
}
