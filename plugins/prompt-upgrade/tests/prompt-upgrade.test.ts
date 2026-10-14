// Prompt Upgrade's behaviour, run with `claude plugin test <plugin folder>`.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, PromptOrigin, PromptSubmitInput, RenderPropsOf } from 'claude-code'

import {
  AUTO_SENT_STATUS,
  CHOOSE_FOR_UNANSWERED,
  DETAIL_SPECS,
  DROP_TEXT,
  BAD_LEVEL_TEXT,
  CHECKING_STATUS,
  NARROW_WINDOW,
  SELECT_WIDTH,
  SENT_STATUS,
  bigNumber,
  decideSubmit,
  extractJson,
  isShortReply,
  normalizePrompt,
  packRows,
  parseBetterArgs,
  parseQuestions,
  parseRewrite,
  restoreHistory,
  statLayout,
  trimHistory,
  wrapText,
} from '../hooks/prompt-upgrade-logic'
import type { SubmitFacts } from '../hooks/prompt-upgrade-logic'
import type { PromptUpgradeEntry } from '../types'

const PLUGIN = 'prompt-upgrade'
const PANE_ID = 'prompt-upgrade'
const STORE_AUTO = 'prompt-upgrade.auto'
const STORE_DETAIL = 'prompt-upgrade.detail'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
const ROUGH = 'write something about bees for my newsletter'

const THREE_QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Who is it for?', options: ['Beginners', 'Experts', 'Kids'] },
    { question: 'How long should it be?', options: ['One paragraph', 'Two pages'] },
    { question: 'Which tone?', options: ['Warm', 'Formal'] },
  ],
})
// The old reply shape: no "ready" field, and no questions means ready.
const NO_QUESTIONS = '{"questions":[]}'
const READY_REPLY = '{"ready":true,"missing":[],"questions":[]}'
// Not ready, but nothing to ask: the flow goes straight to the rewrite.
const NOT_READY_NO_QUESTIONS = '{"ready":false,"missing":["the format"],"questions":[]}'
const TWO_QUESTIONS = JSON.stringify({
  ready: false,
  missing: ['who it is for', 'the format'],
  questions: [
    { question: 'Who is it for?', options: ['Beginners', 'Experts'] },
    { question: 'How long should it be?', options: ['One paragraph', 'Two pages'] },
  ],
})
const GOOD_REWRITE = JSON.stringify({
  prompt: 'Write a two-page guide about bees for experts, in a warm tone. It is done when it covers [the main species].',
  added: ['A clear goal', 'The audience', 'The format', 'What done looks like'],
})

type ModelAnswer =
  | { isAnswered: true; text: string; usage: typeof USAGE }
  | { isAnswered: false; reason: 'aborted'; usage: typeof USAGE }

function answered(text: string): ModelAnswer {
  return { isAnswered: true, text, usage: USAGE }
}

type ModelCall = { model: string; effort?: string; timeoutMs?: number; maxTokens?: number; system?: string; prompt: string }

type Script = {
  /** What the fast model answers; a function sees the prompt it was sent. */
  questions: string | ModelAnswer | ((prompt: string) => string | Promise<string>)
  rewrite: string | ModelAnswer | ((prompt: string) => string | Promise<string>)
  isPlaced: boolean
}

type World = {
  modelCalls: ModelCall[]
  submitted: PromptSubmitInput[]
  filled: { text: string; mode?: string }[]
  /** What the prompt box holds; `prompt.fill` sets it and `prompt.read` answers it. */
  box: string
  toasts: string[]
  /** Every `$.ui.status` call, in order; undefined is a clear. */
  statuses: (string | undefined)[]
  opened: string[]
  closed: string[]
  copied: string[]
  script: Script
}

// Stands in for the engine beneath the plugin, recording what Prompt Upgrade asks of it.
function standInForEngine(on: On, store: Record<string, unknown> | null = {}, script: Partial<Script> = {}) {
  const world: World = {
    modelCalls: [],
    submitted: [],
    filled: [],
    box: '',
    toasts: [],
    statuses: [],
    opened: [],
    closed: [],
    copied: [],
    script: { questions: NOT_READY_NO_QUESTIONS, rewrite: GOOD_REWRITE, isPlaced: true, ...script },
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  if (store !== null) mock.store(on, store)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', ($, e) => {
    world.opened.push(e.id)
    return { value: world.script.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.close', ($, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    world.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('prompt.fill', ($, e) => {
    world.filled.push({ text: e.text, mode: e.mode })
    world.box = e.text
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: world.box, cursor: world.box.length } }))
  on('prompt.submit', ($, e) => {
    world.submitted.push(e)
    return { text: e.text }
  })
  on('model.complete', async ($, e) => {
    world.modelCalls.push({ model: e.model, effort: e.effort, timeoutMs: e.timeoutMs, maxTokens: e.maxTokens, system: e.system, prompt: e.prompt })
    const answer = e.model === 'haiku' ? world.script.questions : world.script.rewrite
    const value = typeof answer === 'function' ? answered(await answer(e.prompt)) : typeof answer === 'string' ? answered(answer) : answer
    return { value }
  })
  return { world, clock }
}

type Clock = ReturnType<typeof standInForEngine>['clock']

async function startSession($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

async function better($: Engine, args: string, clock: Clock) {
  const ran = await $.command.run({ command: 'better', args, ...TYPED })
  await clock.settle()
  return ran
}

async function sendTyped($: Engine, text: string, extra: Partial<PromptSubmitInput> = {}, origin: PromptOrigin = { kind: 'composer' }) {
  return $.prompt.submit({ text, wait: false, origin, ...extra })
}

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Prompt Upgrade', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

async function mountPane($: Engine, bodyColumns = 100) {
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps(bodyColumns) })
}

async function paneText(pane: Mounted<'terminal', 'Pane'>) {
  return (await pane.findAll({ type: 'Text' })).map(found => found.text).join('\n')
}

/** Draws the pane once and returns everything it shows. */
async function paneNow($: Engine, bodyColumns = 100) {
  const pane = await mountPane($, bodyColumns)
  const text = await paneText(pane)
  await pane.unmount()
  return text
}

// A drawn element as `drawn()` returns it.
type Drawn = string | { type: string; props: Record<string, unknown>; children?: Drawn[] }

/** How many cells wide a drawn element is; every row that is wider than the room it was given is listed. */
function measure(node: Drawn, tooWide: string[]): number {
  if (typeof node === 'string') return node.length
  const children = (node.children ?? []).filter(child => child !== null && child !== undefined)
  if (node.type === 'Input') return 0
  // The dropdown draws on one row; its width is planned for, not measured.
  if (node.type === 'Select') return SELECT_WIDTH
  if (node.type !== 'Box') return children.reduce((sum, child) => sum + measure(child, tooWide), 0)

  const props = node.props
  const gap = typeof props.gap === 'number' ? props.gap : 0
  const border = typeof props.borderStyle === 'string' ? 2 : 0
  const paddingX = typeof props.paddingX === 'number' ? props.paddingX * 2 : 0
  const paddingLeft = typeof props.paddingLeft === 'number' ? props.paddingLeft : 0
  const sizes = children.map(child => measure(child, tooWide))
  const content =
    props.flexDirection === 'row'
      ? sizes.reduce((sum, size) => sum + size, 0) + gap * Math.max(0, sizes.length - 1)
      : Math.max(0, ...sizes)
  const natural = content + border + paddingX + paddingLeft
  if (typeof props.width === 'number') {
    if (natural > props.width) tooWide.push(`${String(props.key ?? 'box')}: ${natural} > ${props.width}`)
    return props.width
  }
  return natural
}

async function expectFits($: Engine, columns: number) {
  const pane = await mountPane($, columns)
  const tooWide: string[] = []
  const total = measure((await pane.drawn()) as Drawn, tooWide)
  await pane.unmount()
  expect(tooWide).toEqual([])
  expect(total).toBeLessThanOrEqual(columns)
}

const FACTS: SubmitFacts = {
  text: 'Write a detailed guide about keeping bees on a rooftop',
  originKind: 'composer',
  hasCommand: false,
  isMeta: false,
  attachmentCount: 0,
  hasTurn: false,
}

// ---------------------------------------------------------------------------
// Which prompts are caught
// ---------------------------------------------------------------------------

test('1. the rules: only a long typed prompt is caught, with automatic mode on', () => {
  expect(decideSubmit(FACTS, true).kind).toBe('intercept')
  expect(decideSubmit(FACTS, false).kind).toBe('pass')
  expect(decideSubmit({ ...FACTS, text: '/review the diff' }, true).kind).toBe('pass')
  expect(decideSubmit({ ...FACTS, hasCommand: true }, true).kind).toBe('pass')
  expect(decideSubmit({ ...FACTS, isMeta: true }, true).kind).toBe('pass')
  expect(decideSubmit({ ...FACTS, attachmentCount: 1 }, true).kind).toBe('pass')
  expect(decideSubmit({ ...FACTS, hasTurn: true }, true).kind).toBe('pass')
  for (const originKind of ['plugin', 'bridge', 'sdk', 'task-notification', 'scheduled-trigger', 'peer']) {
    expect(decideSubmit({ ...FACTS, originKind }, true).kind).toBe('pass')
  }
  expect(decideSubmit({ ...FACTS, text: '> send this exactly as written please' }, true)).toEqual({
    kind: 'strip',
    text: 'send this exactly as written please',
  })
  expect(decideSubmit({ ...FACTS, text: '>no space after the sign here' }, true)).toEqual({ kind: 'strip', text: 'no space after the sign here' })
  expect(decideSubmit({ ...FACTS, text: '>' }, true).kind).toBe('pass')
})

test('2. short replies pass: three words or fewer, and known replies', () => {
  for (const reply of ['yes', 'No.', 'ok', 'Sure!', 'thanks', 'keep going', 'go on', 'do it', 'sounds good', 'LGTM', 'stop', 'fix the bug', '']) {
    expect(isShortReply(reply)).toBe(true)
  }
  for (const text of ['Write a detailed guide about bees', 'please explain how the sync works']) expect(isShortReply(text)).toBe(false)
})

test('3. in automatic mode a typed prompt is dropped from the send and sent to the pane', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true })
  await startSession($)

  const result = await sendTyped($, ROUGH)
  expect(result.drop).toBe(DROP_TEXT)
  expect(world.submitted).toHaveLength(0)
  await clock.settle()
  expect(world.opened).toEqual([PANE_ID])
  expect(world.modelCalls[0]?.prompt).toContain(ROUGH)
})

test('4. everything else passes through untouched', async ($, on) => {
  const { world } = standInForEngine(on, { [STORE_AUTO]: true })
  await startSession($)
  const long = 'Write a detailed guide about keeping bees on a rooftop'

  await sendTyped($, '/review the diff', { command: { name: 'review', args: 'the diff' } })
  await sendTyped($, long, { isMeta: true })
  await sendTyped($, long, { attachments: [{ type: 'image' }] })
  await sendTyped($, long, { turnId: 'turn-7' })
  await sendTyped($, 'yes')
  await sendTyped($, 'keep going')
  await sendTyped($, 'fix the bug')
  await sendTyped($, long, {}, { kind: 'task-notification' })
  await sendTyped($, long, {}, { kind: 'bridge' })
  expect(world.submitted.map(sent => sent.text)).toEqual([
    '/review the diff',
    long,
    long,
    long,
    'yes',
    'keep going',
    'fix the bug',
    long,
    long,
  ])
  expect(world.opened).toHaveLength(0)
})

test('5. a ">" is stripped and the prompt is sent as typed', async ($, on) => {
  const { world } = standInForEngine(on, { [STORE_AUTO]: true })
  await startSession($)
  await sendTyped($, '> write something about bees for my newsletter')
  expect(world.submitted.at(-1)?.text).toBe('write something about bees for my newsletter')
  expect(world.opened).toHaveLength(0)
})

test('6. loop guard: the mod\'s own asUser submission passes untouched, with automatic mode on', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true })
  await startSession($)
  const own: PromptOrigin = { kind: 'plugin', name: PLUGIN, asUser: true }
  const result = await sendTyped($, ROUGH, {}, own)
  await clock.settle()
  expect(result.drop).toBeUndefined()
  expect(world.submitted.map(sent => sent.text)).toEqual([ROUGH])
  expect(world.opened).toHaveLength(0)
  expect(world.modelCalls).toHaveLength(0)
})

test('7. automatic mode is off by default; /better on and off flip it and the store keeps the switch', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)

  await sendTyped($, ROUGH)
  expect(world.submitted).toHaveLength(1)
  expect(world.opened).toHaveLength(0)

  const turnedOn = await better($, 'on', clock)
  expect(turnedOn.text).toMatch(/Automatic mode is on/)
  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.opened).toEqual([PANE_ID])

  const turnedOff = await better($, 'off', clock)
  expect(turnedOff.text).toMatch(/Automatic mode is off/)
  await sendTyped($, ROUGH)
  expect(world.submitted).toHaveLength(2)
})

test('8. /better arguments are read as on, off, history, empty or a prompt', () => {
  expect(parseBetterArgs('on')).toEqual({ kind: 'on' })
  expect(parseBetterArgs(' OFF ')).toEqual({ kind: 'off' })
  expect(parseBetterArgs('history')).toEqual({ kind: 'history' })
  expect(parseBetterArgs('  ')).toEqual({ kind: 'empty' })
  expect(parseBetterArgs('write about on and off')).toEqual({ kind: 'prompt', text: 'write about on and off' })
})

// ---------------------------------------------------------------------------
// Reading what the model said
// ---------------------------------------------------------------------------

test('9. reading the questions: plain, fenced, in prose, none, malformed, capped', () => {
  const plain = parseQuestions(THREE_QUESTIONS)
  expect(plain.isOk && plain.questions.map(question => question.question)).toEqual(['Who is it for?', 'How long should it be?', 'Which tone?'])

  const fenced = parseQuestions('```json\n' + THREE_QUESTIONS + '\n```')
  expect(fenced.isOk && fenced.questions).toHaveLength(3)

  const prose = parseQuestions('Sure! Here you go:\n' + THREE_QUESTIONS + '\nHope that helps.')
  expect(prose.isOk && prose.questions).toHaveLength(3)

  const none = parseQuestions(NO_QUESTIONS)
  expect(none.isOk && none.questions).toHaveLength(0)

  expect(parseQuestions('I have no questions.').isOk).toBe(false)
  expect(parseQuestions('{"questions": "none"}').isOk).toBe(false)
  expect(parseQuestions('').isOk).toBe(false)

  const many = JSON.stringify({
    questions: [1, 2, 3, 4, 5, 6, 7, 8].map(number => ({ question: `Question ${number}?`, options: ['a', 'b', 'c', 'd', 'e', 'f'] })),
  })
  const capped = parseQuestions(many)
  expect(capped.isOk && capped.questions).toHaveLength(5)
  expect(capped.isOk && capped.questions.every(question => question.options.length === 4)).toBe(true)

  // A question with fewer than two options is left out.
  const thin = parseQuestions(JSON.stringify({ questions: [{ question: 'Why?', options: ['only one'] }, { question: 'Who?', options: ['me', 'you'] }] }))
  expect(thin.isOk && thin.questions.map(question => question.question)).toEqual(['Who?'])
})

test('10. reading the rewrite: plain, fenced, in prose, and the failures', () => {
  const plain = parseRewrite(GOOD_REWRITE)
  expect(plain.isOk && plain.prompt).toMatch(/^Write a two-page guide about bees/)
  expect(plain.isOk && plain.added).toHaveLength(4)

  const fenced = parseRewrite('```\n' + GOOD_REWRITE + '\n```')
  expect(fenced.isOk).toBe(true)
  const prose = parseRewrite('Here is the upgrade: ' + GOOD_REWRITE + ' Enjoy!')
  expect(prose.isOk).toBe(true)

  const noList = parseRewrite('{"prompt":"Just this."}')
  expect(noList.isOk && noList.added).toEqual([])
  expect(parseRewrite('{"prompt":"   "}').isOk).toBe(false)
  expect(parseRewrite('not json at all').isOk).toBe(false)
  expect(extractJson('{"a":1} trailing')).toEqual({ a: 1 })
})

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

test('11. the full flow: /better, answer, Other, skip the rest, rewrite, review, Run', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: THREE_QUESTIONS })
  await startSession($)

  const ran = await better($, ROUGH, clock)
  expect(ran.text).toBe('Prompt Upgrade is reading your prompt.')
  expect(world.opened).toEqual([PANE_ID])
  expect(world.modelCalls[0]).toMatchObject({ model: 'haiku', effort: 'low', timeoutMs: 20_000 })

  const pane = await mountPane($)
  expect(await paneText(pane)).toMatch(/Who is it for\?/)
  expect(await paneText(pane)).toMatch(/0 of 3 answered/)

  // Answer the first question: the badge becomes a check and the count moves.
  await pane.press({ key: 'q0-opt-1' })
  expect(await paneText(pane)).toMatch(/1 of 3 answered/)
  expect(await paneText(pane)).toMatch(/→ Experts/)
  expect((await pane.find({ type: 'Text', text: /^ ✓ $/ }))?.props.backgroundColor).toBe('#3DD68C')

  // Other (type it) opens a box; Enter saves the answer.
  await pane.press({ key: 'q1-other' })
  await pane.input({ key: 'q1-other-input', text: 'Two pages with pictures' })
  expect(await paneText(pane)).toMatch(/2 of 3 answered/)

  await pane.press({ key: 'skip-rest' })
  await clock.settle()
  expect(world.modelCalls[1]).toMatchObject({ model: 'sonnet', effort: 'medium', timeoutMs: 60_000 })
  const rewriteRequest = world.modelCalls[1]?.prompt ?? ''
  expect(rewriteRequest).toContain(ROUGH)
  expect(rewriteRequest).toContain('Q: Who is it for?\nA: Experts')
  expect(rewriteRequest).toContain('A: Two pages with pictures')
  expect(rewriteRequest).not.toContain('Which tone?')
  expect(world.modelCalls[1]?.system).toContain('Never invent facts, names, numbers or prices. Where something is unknown, leave a [placeholder] in square brackets.')

  const review = await paneText(pane)
  expect(review).toMatch(/Write a two-page guide about bees for\s+experts/)
  expect(review).toMatch(/\+ A clear goal/)
  for (const key of ['run', 'edit', 'copy', 'cancel']) expect((await pane.find({ type: 'Button', key })) !== undefined).toBe(true)

  // Copy shows a short note in the pane.
  await pane.press({ key: 'copy' })
  expect(world.copied[0]).toMatch(/^Write a two-page guide/)
  expect(await paneText(pane)).toMatch(/Copied the upgrade\./)

  await pane.press({ key: 'run' })
  await clock.settle()
  await pane.unmount()
  expect(world.submitted).toHaveLength(1)
  expect(world.submitted[0]?.text).toMatch(/^Write a two-page guide about bees for experts/)
  expect(world.submitted[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(world.closed).toEqual([PANE_ID])
  expect(world.filled).toHaveLength(0)
})

test('12. no questions: it goes straight to the rewrite', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await better($, ROUGH, clock)
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku', 'sonnet'])
  const text = await paneNow($)
  expect(text).toMatch(/THE UPGRADE/)
  expect(text).toMatch(/WORDS BEFORE/)
})

test('13. the review: numbers, buttons above the cards, the upgrade card has the gold outline', async ($, on) => {
  const { clock } = standInForEngine(on)
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($, 100)
  const tree = JSON.stringify(await pane.drawn())
  expect(tree.indexOf('"key":"run"')).toBeLessThan(tree.indexOf('"key":"original-card"'))
  expect(tree.indexOf('"key":"run"')).toBeLessThan(tree.indexOf('"key":"upgrade-card"'))
  expect(tree.indexOf('"key":"stat-0"')).toBeLessThan(tree.indexOf('"key":"run"'))
  expect(tree.indexOf('WHAT I ADDED')).toBeLessThan(tree.indexOf('"key":"original-card"'))

  const cards = await pane.findAll({ type: 'Box' })
  expect(cards.find(card => card.key === 'upgrade-card')?.props.borderColor).toBe('#F2C46D')
  expect(cards.find(card => card.key === 'original-card')?.props.borderColor).toBe('#262B33')
  const gold = await pane.find({ type: 'Text', text: ' Run it ' })
  expect(gold?.props.backgroundColor).toBe('#F2C46D')
  expect(gold?.props.color).toBe('#0D1117')
  expect((await pane.find({ type: 'Text', text: ' Edit ' }))?.props.backgroundColor).toBe('#262B33')
  await pane.unmount()
})

test('14. the tracker: done steps green, the current one gold, the rest muted', async ($, on) => {
  const { clock } = standInForEngine(on, {}, { questions: THREE_QUESTIONS })
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  expect((await pane.find({ type: 'Text', text: /^✓ Your prompt$/ }))?.props.color).toBe('#3DD68C')
  expect((await pane.find({ type: 'Text', text: /^● Questions$/ }))?.props.color).toBe('#F2C46D')
  expect((await pane.find({ type: 'Text', text: /^○ Rewrite$/ }))?.props.color).toBe('#7D8590')
  expect((await pane.find({ type: 'Text', text: /^○ Review$/ }))?.props.color).toBe('#7D8590')
  await pane.unmount()
})

test('15. Edit changes the upgrade and Enter runs it', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  await pane.press({ key: 'edit' })
  expect((await pane.find({ type: 'Input', key: 'edit-input' }))?.props.value).toMatch(/^Write a two-page guide/)
  await pane.input({ key: 'edit-input', text: 'My own edited prompt about bees.' })
  await clock.settle()
  await pane.unmount()
  expect(world.submitted.map(sent => sent.text)).toEqual(['My own edited prompt about bees.'])
  expect(world.closed).toEqual([PANE_ID])
})

test('16. Cancel closes the pane and puts the original back in the prompt box', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: THREE_QUESTIONS })
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  await pane.press({ key: 'cancel' })
  await clock.settle()
  expect(world.filled).toEqual([{ text: ROUGH, mode: 'replace' }])
  expect(world.closed).toEqual([PANE_ID])
  expect(world.submitted).toHaveLength(0)
  expect(await paneText(pane)).toMatch(/Nothing to upgrade right now/)
  await pane.unmount()
})

test('17. a model answer that arrives after Cancel is ignored', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: THREE_QUESTIONS })
  await startSession($)
  await $.command.run({ command: 'better', args: ROUGH, ...TYPED })
  // Cancel before the background call has run.
  const pane = await mountPane($)
  await pane.press({ key: 'cancel' })
  await clock.settle()
  expect(await paneText(pane)).toMatch(/Nothing to upgrade right now/)
  expect(world.modelCalls).toHaveLength(0)
  await pane.unmount()
})

// ---------------------------------------------------------------------------
// When a model call fails
// ---------------------------------------------------------------------------

test('18. malformed questions show the calm error card; Try again repeats the step', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: 'Sorry, I cannot do that.' })
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  expect(await paneText(pane)).toMatch(/Something went wrong while reading your prompt\./)
  expect(await paneText(pane)).toMatch(/Your prompt is safe\./)
  for (const key of ['retry', 'send-original', 'cancel']) expect((await pane.find({ type: 'Button', key })) !== undefined).toBe(true)

  world.script.questions = THREE_QUESTIONS
  await pane.press({ key: 'retry' })
  await clock.settle()
  expect(world.modelCalls.filter(call => call.model === 'haiku')).toHaveLength(2)
  expect(await paneText(pane)).toMatch(/Who is it for\?/)
  await pane.unmount()
})

test('19. a timed out rewrite shows the error card; Send my original sends the original as the person', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { rewrite: { isAnswered: false, reason: 'aborted', usage: USAGE } })
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  expect(await paneText(pane)).toMatch(/Something went wrong while writing the upgrade\./)
  await pane.press({ key: 'send-original' })
  await clock.settle()
  await pane.unmount()
  expect(world.submitted.map(sent => sent.text)).toEqual([ROUGH])
  expect(world.submitted[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(world.closed).toEqual([PANE_ID])
})

test('20. a rewrite that is not JSON also shows the error card', async ($, on) => {
  const { clock } = standInForEngine(on, {}, { rewrite: 'Here is a nicer prompt, enjoy.' })
  await startSession($)
  await better($, ROUGH, clock)
  expect(await paneNow($)).toMatch(/Something went wrong while writing the upgrade\./)
})

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('21. the history keeps 20 and clicking one reopens its review', async ($, on) => {
  const upgradeOf = (prompt: string) => {
    const original = prompt.match(/"""\n([\s\S]*?)\n"""/)?.[1] ?? ''
    return JSON.stringify({ prompt: `Upgraded: ${original}`, added: ['A goal'] })
  }
  const { clock } = standInForEngine(on, {}, { rewrite: upgradeOf })
  await startSession($)
  for (let number = 1; number <= 22; number += 1) await better($, `rough prompt number ${number}`, clock)

  await better($, 'history', clock)
  const pane = await mountPane($)
  const rows = (await pane.findAll({ type: 'Button' })).filter(button => (button.key ?? '').startsWith('history-'))
  expect(rows).toHaveLength(20)
  expect(rows[0]?.text).toMatch(/rough prompt number 22/)
  expect(rows[19]?.text).toMatch(/rough prompt number 3\b/)

  await pane.press({ key: rows[5]?.key ?? '' })
  const text = await paneText(pane)
  expect(text).toMatch(/Upgraded: rough prompt number 17/)
  expect((await pane.find({ type: 'Button', key: 'run' })) !== undefined).toBe(true)
  await pane.unmount()
})

test('21b. trimHistory keeps the newest 20 and replaces an entry with the same id', () => {
  const entry = (id: string): PromptUpgradeEntry => ({ id, original: id, upgraded: id, added: [], wordsBefore: 1, wordsAfter: 1, detailsAdded: 0, answers: [], detailLevel: 'medium', at: 0 })
  let list: PromptUpgradeEntry[] = []
  for (let number = 0; number < 25; number += 1) list = trimHistory(list, entry(String(number)))
  expect(list).toHaveLength(20)
  expect(list[0]?.id).toBe('24')
  expect(trimHistory(list, entry('10')).filter(saved => saved.id === '10')).toHaveLength(1)
})

test('22. saved history comes back in a new session', async ($, on) => {
  const saved = [{ id: 'a-1', original: 'an old rough prompt', upgraded: 'Old upgrade', added: ['A goal'], wordsBefore: 4, wordsAfter: 2, detailsAdded: 1, answers: [], at: 900_000 }]
  const { clock } = standInForEngine(on, { 'prompt-upgrade.history': saved })
  await startSession($)
  await better($, 'history', clock)
  const text = await paneNow($)
  expect(text).toMatch(/an old rough prompt/)
  expect(text).toMatch(/1m ago/)
})

// ---------------------------------------------------------------------------
// Reloads, narrow windows, typing
// ---------------------------------------------------------------------------

test('23. after a reload mid-step the in-flight call runs again and the old answer is ignored', async ($, on) => {
  let releaseFirst: (() => void) | undefined
  let questionCalls = 0
  // The first questions call hangs, as if the mod reloaded while it ran.
  const { world, clock } = standInForEngine(on, {}, {
    questions: () => {
      questionCalls += 1
      if (questionCalls > 1) return THREE_QUESTIONS
      return new Promise<string>(resolve => {
        releaseFirst = () => resolve(NO_QUESTIONS)
      })
    },
  })
  await startSession($)
  await $.command.run({ command: 'better', args: ROUGH, ...TYPED })
  await clock.advance(1)
  expect(await paneNow($)).toMatch(/Checking your prompt\./)

  // Reload: session.start runs again with the stage left at asking.
  await startSession($)
  await clock.advance(1)
  releaseFirst?.()
  await clock.settle()
  expect(world.modelCalls.filter(call => call.model === 'haiku')).toHaveLength(2)
  // The first answer (no questions) was stale; the second one's questions are on screen.
  expect(await paneNow($)).toMatch(/Who is it for\?/)
})

test('24. a pane that cannot open puts the words back: one toast when intercepted', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { isPlaced: false })
  await startSession($)
  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.filled).toEqual([{ text: ROUGH, mode: 'replace' }])
  expect(world.toasts).toEqual([NARROW_WINDOW])
  expect(world.closed).toEqual([PANE_ID])
  // The prompt is checked first; the pane is tried only when there is something to show.
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku'])
  expect(world.statuses.at(-1)).toBeUndefined()
})

test('25. /better alone opens a box to type in; Enter starts the flow', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  const ran = await better($, '', clock)
  expect(ran.text).toMatch(/Type your prompt/)

  const pane = await mountPane($)
  expect((await pane.find({ type: 'Input', key: 'typed-prompt' })) !== undefined).toBe(true)
  await pane.input({ key: 'typed-prompt', text: ROUGH })
  await clock.settle()
  expect(world.modelCalls[0]?.prompt).toContain(ROUGH)
  expect(await paneText(pane)).toMatch(/Write a two-page guide/)
  await pane.unmount()
})

test('26. a command that fails answers with a plain sentence', async ($, on) => {
  const { clock } = standInForEngine(on, null)
  on('store.set', () => {
    throw new Error('store is down')
  })
  await startSession($)
  const ran = await $.command.run({ command: 'better', args: 'on', ...TYPED })
  await clock.settle()
  expect(ran.text).toMatch(/Prompt Upgrade hit a problem/)
})

// ---------------------------------------------------------------------------
// The look
// ---------------------------------------------------------------------------

test('27. the title is bold capitals over a gold rule as wide as the title, then a hairline', async ($, on) => {
  const { clock } = standInForEngine(on)
  await startSession($)
  await better($, ROUGH, clock)
  const pane = await mountPane($, 80)
  const title = await pane.find({ type: 'Text', text: 'PROMPT UPGRADE' })
  expect(title?.props.weight).toBe('bold')
  const goldRule = await pane.find({ type: 'Text', text: /^━+$/ })
  expect(goldRule?.text).toHaveLength('PROMPT UPGRADE'.length)
  expect(goldRule?.props.color).toBe('#F2C46D')
  const hairline = (await pane.findAll({ type: 'Text', text: /^─+$/ }))[0]
  expect(hairline?.props.color).toBe('#262B33')
  await pane.unmount()
})

test('28. big numbers are three rows of heavy digits', () => {
  const rows = bigNumber(1205)
  expect(rows).toHaveLength(3)
  expect(new Set(rows.map(row => row.length)).size).toBe(1)
  expect(rows[0]).toBe('╺┓  ╺━┓ ┏━┓ ┏━╸')
  expect(rows.join('')).toMatch(/^[╺╸╻╹┏┓┗┛┃┣┫┻━ ]+$/)
  expect(bigNumber(0)).toEqual(['┏━┓', '┃ ┃', '┗━┛'])

  const wide = statLayout({ wordsBefore: 120, wordsAfter: 310, detailsAdded: 5 }, 100)
  expect(wide.mode).toBe('tiles')
  expect(statLayout({ wordsBefore: 120, wordsAfter: 310, detailsAdded: 5 }, 24).mode).toBe('line')
})

test('29. rows are packed and wrapped to the width', () => {
  expect(packRows([10, 10, 10], 1, 22)).toEqual([[0, 1], [2]])
  expect(packRows([30], 1, 10)).toEqual([[0]])
  for (const line of wrapText('a short sentence with averyveryverylongwordinsideit that must wrap', 12)) expect(line.length).toBeLessThanOrEqual(12)
})

test('30. no row is wider than the pane, at 36, 60 and 140 columns, on every screen', async ($, on) => {
  const longPrompt =
    'write something about bees for my newsletter, about rooftop hives and honey and how the neighbours feel about them, with a supercalifragilisticexpialidocious-sized-word-that-never-breaks-anywhere-at-all inside'
  const longRewrite = JSON.stringify({
    prompt: `${longPrompt}. Goal: a friendly guide. Reader: curious neighbours. Format: five short paragraphs and a list. Done: when it covers [the main species] and [the local rules].`,
    added: ['A clear goal for the whole piece, said in one sentence that is quite long indeed', 'Who it is for', 'The format', 'What done looks like'],
  })
  const manyOptions = JSON.stringify({
    questions: [
      { question: 'Which of these long and winding audiences should the writing be aimed at?', options: ['Complete beginners with no time', 'Experts', 'Kids aged eight to ten years', 'Neighbours'] },
      { question: 'How long?', options: ['One paragraph', 'Two pages'] },
      { question: 'Tone?', options: ['Warm', 'Formal'] },
    ],
  })
  const { world, clock } = standInForEngine(on, {}, { questions: manyOptions, rewrite: longRewrite })
  await startSession($)

  // Typing box.
  await better($, '', clock)
  for (const columns of [36, 60, 140]) await expectFits($, columns)

  // Questions, with an Other box open and one answer made.
  await better($, longPrompt, clock)
  const pane = await mountPane($, 60)
  await pane.press({ key: 'q0-opt-0' })
  await pane.press({ key: 'q1-other' })
  await pane.unmount()
  for (const columns of [36, 60, 140]) await expectFits($, columns)

  // Review and Edit.
  const review = await mountPane($, 60)
  await review.press({ key: 'skip-rest' })
  await clock.settle()
  await review.unmount()
  for (const columns of [36, 60, 69, 70, 140]) await expectFits($, columns)
  const editing = await mountPane($, 60)
  await editing.press({ key: 'edit' })
  await editing.unmount()
  for (const columns of [36, 60, 140]) await expectFits($, columns)

  // The error card.
  world.script.questions = 'nope'
  await better($, longPrompt, clock)
  for (const columns of [36, 60, 140]) await expectFits($, columns)

  // The history.
  await better($, 'history', clock)
  for (const columns of [36, 60, 140]) await expectFits($, columns)
})

test('31. the cards sit side by side when wide and stack when narrow', async ($, on) => {
  const { clock } = standInForEngine(on)
  await startSession($)
  await better($, ROUGH, clock)

  const findNode = (node: Drawn, matches: (candidate: Exclude<Drawn, string>) => boolean): Exclude<Drawn, string> | undefined => {
    if (typeof node === 'string') return undefined
    if (matches(node)) return node
    for (const child of node.children ?? []) {
      const found = findNode(child, matches)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [columns, expectedDirection] of [[140, 'row'], [69, 'column']] as const) {
    const pane = await mountPane($, columns)
    const cards = findNode((await pane.drawn()) as Drawn, node => (node.children ?? []).some(child => typeof child !== 'string' && child.props.key === 'original-column'))
    expect(cards?.props.flexDirection).toBe(expectedDirection)
    await pane.unmount()
  }
})

test('automatic mode is published for other mods: the saved switch at start, then each /better on and off', async ($, on) => {
  // Every value Prompt Upgrade publishes for the status bar to read.
  const published: unknown[] = []
  on('state.set', { plugin: 'prompt-upgrade', key: 'isAutoOn' }, async ($, e, next) => {
    published.push(e.value)
    return next(e)
  })
  const { clock } = standInForEngine(on, { [STORE_AUTO]: true })
  await startSession($)
  expect(published).toEqual([true])

  await better($, 'off', clock)
  await better($, 'on', clock)
  expect(published).toEqual([true, false, true])
})

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------

/** Every value Prompt Upgrade publishes for one state key. */
function watchState(on: On, key: 'detailLevel' | 'lastReply' | 'lastIntercepted' | 'isAutoOn') {
  const published: unknown[] = []
  on('state.set', { plugin: 'prompt-upgrade' }, async ($, e, next) => {
    if (e.key === key) published.push(e.value)
    return next(e)
  })
  return published
}

/** A store that remembers what was saved, and every key written, in place of the kit's. */
function recordingStore(on: On, initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const writes: string[] = []
  on('store.get', ($, e) => ({ value: data[e.key] }))
  on('store.set', ($, e) => {
    writes.push(e.key)
    data[e.key] = e.value
    return { value: undefined }
  })
  return { data, writes }
}

const MANY_QUESTIONS = JSON.stringify({
  ready: false,
  missing: ['a', 'b'],
  questions: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(number => ({
    question: `Question ${number}?`,
    options: ['one', 'two', 'three', 'four', 'five'],
  })),
})

test('32. each level caps the questions and the options', () => {
  const expected = { low: [3, 3], medium: [5, 4], high: [7, 4] } as const
  for (const level of ['low', 'medium', 'high'] as const) {
    const parsed = parseQuestions(MANY_QUESTIONS, level)
    expect(parsed.isOk && parsed.questions).toHaveLength(expected[level][0])
    expect(parsed.isOk && parsed.questions.every(question => question.options.length === expected[level][1])).toBe(true)
  }
  // Medium is the level when none is given.
  const unspecified = parseQuestions(MANY_QUESTIONS)
  expect(unspecified.isOk && unspecified.questions).toHaveLength(5)
})

test('33. the check reads ready, missing and questions, and the old shapes', () => {
  const ready = parseQuestions(READY_REPLY)
  expect(ready).toEqual({ isOk: true, isReady: true, missing: [], questions: [] })

  // A ready reply asks nothing, whatever it carries.
  const readyWithQuestions = parseQuestions(JSON.stringify({ ready: true, questions: [{ question: 'Why?', options: ['a', 'b'] }] }))
  expect(readyWithQuestions.isOk && readyWithQuestions.questions).toEqual([])

  const notReady = parseQuestions(TWO_QUESTIONS)
  expect(notReady.isOk && notReady.isReady).toBe(false)
  expect(notReady.isOk && notReady.missing).toEqual(['who it is for', 'the format'])
  expect(notReady.isOk && notReady.questions).toHaveLength(2)

  // No "ready" field: as before, no questions means ready.
  const oldNone = parseQuestions(NO_QUESTIONS)
  expect(oldNone.isOk && oldNone.isReady).toBe(true)
  const oldThree = parseQuestions(THREE_QUESTIONS)
  expect(oldThree.isOk && oldThree.isReady).toBe(false)
})

test('34. medium is the default; the saved level is published at start', async ($, on) => {
  const published = watchState(on, 'detailLevel')
  standInForEngine(on)
  await startSession($)
  expect(published).toEqual(['medium'])
})

test('35. a saved level is read at start', async ($, on) => {
  const published = watchState(on, 'detailLevel')
  standInForEngine(on, { [STORE_DETAIL]: 'high' })
  await startSession($)
  expect(published).toEqual(['high'])
})

test('36. /better level saves and publishes the level; a bad value gets the plain answer', async ($, on) => {
  const published = watchState(on, 'detailLevel')
  const { data: store } = recordingStore(on)
  const { clock } = standInForEngine(on, null)
  await startSession($)

  const low = await better($, 'level low', clock)
  expect(low.text).toMatch(/Detail is now Low/)
  expect(store[STORE_DETAIL]).toBe('low')
  expect(published).toEqual(['medium', 'low'])

  for (const args of ['level extreme', 'level']) {
    expect((await better($, args, clock)).text).toBe(BAD_LEVEL_TEXT)
  }
  expect(BAD_LEVEL_TEXT).toBe('Detail is auto, low, medium or high, e.g. /better level auto.')
  expect(store[STORE_DETAIL]).toBe('low')
  expect(published).toEqual(['medium', 'low'])

  // A longer sentence that starts with "level" is still a prompt.
  expect(parseBetterArgs('level up my newsletter')).toEqual({ kind: 'prompt', text: 'level up my newsletter' })
  expect(parseBetterArgs('level HIGH')).toEqual({ kind: 'level', level: 'high' })
})

test('37. the dropdown is on the typing, questions and review screens; a pick saves and publishes, a draw never writes', async ($, on) => {
  const published = watchState(on, 'detailLevel')
  const { data: store, writes } = recordingStore(on)
  const { world, clock } = standInForEngine(on, null, { questions: TWO_QUESTIONS })
  await startSession($)
  writes.length = 0

  await better($, '', clock)
  const typing = await mountPane($)
  const select = await typing.find({ type: 'Select', key: 'detail-level' })
  expect(select?.props.label).toBe('Detail')
  expect(select?.props.value).toBe('medium')
  expect(select?.props.options).toEqual([
    { value: 'auto', label: 'Auto: decides for you' },
    { value: 'low', label: 'Low: quick and short' },
    { value: 'medium', label: 'Medium: balanced' },
    { value: 'high', label: 'High: thorough' },
  ])
  // Drawing again changes nothing.
  await paneText(typing)
  expect(writes).toEqual([])

  await typing.select({ key: 'detail-level', value: 'high' })
  expect(writes).toEqual([STORE_DETAIL])
  expect(store[STORE_DETAIL]).toBe('high')
  expect(published).toEqual(['medium', 'high'])
  expect((await typing.find({ type: 'Select', key: 'detail-level' }))?.props.value).toBe('high')

  // Questions screen.
  await typing.input({ key: 'typed-prompt', text: ROUGH })
  await clock.settle()
  expect(await typing.find({ type: 'Select', key: 'detail-level' })).toBeDefined()
  expect(await paneText(typing)).toMatch(/Who is it for\?/)

  // Review screen.
  await typing.press({ key: 'skip-rest' })
  await clock.settle()
  expect(await typing.find({ type: 'Select', key: 'detail-level' })).toBeDefined()
  expect(await paneText(typing)).toMatch(/THE UPGRADE/)

  // Not on a screen that is only working or showing an error.
  world.script.questions = 'nope'
  await better($, ROUGH, clock)
  expect(await typing.find({ type: 'Select' })).toBeUndefined()
  await typing.unmount()
})

test('38. the level is fixed per upgrade; Rewrite at <Level> reruns only the rewrite with the same answers', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: TWO_QUESTIONS })
  await startSession($)
  await better($, 'level high', clock)
  await better($, ROUGH, clock)

  // A change partway through does not touch this upgrade.
  await better($, 'level low', clock)
  const pane = await mountPane($)
  await pane.press({ key: 'q0-opt-1' })
  await pane.press({ key: 'skip-rest' })
  await clock.settle()
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku', 'sonnet'])
  expect(world.modelCalls[1]?.system).toContain('Detail level: High.')
  expect(world.modelCalls[1]?.maxTokens).toBe(6000)

  // Review: written at High, the dropdown says Low, so the chip offers Rewrite at Low.
  expect(await paneText(pane)).toMatch(/Written at High detail/)
  expect((await pane.find({ type: 'Text', text: ' Rewrite at Low ' }))?.props.backgroundColor).toBe('#F2C46D')
  await pane.press({ key: 'rewrite-level' })
  await clock.settle()
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku', 'sonnet', 'sonnet'])
  expect(world.modelCalls[2]?.system).toContain('Detail level: Low.')
  expect(world.modelCalls[2]?.maxTokens).toBe(1500)
  expect(world.modelCalls[2]?.prompt).toContain('Q: Who is it for?\nA: Experts')
  expect(world.modelCalls[2]?.prompt).not.toContain('How long should it be?')
  expect(await paneText(pane)).toMatch(/Written at Low detail/)
  // Now the levels match, so the chip is gone.
  expect(await pane.find({ type: 'Button', key: 'rewrite-level' })).toBeUndefined()
  await pane.unmount()
})

test('39. the rewrite text and tokens per level, with the four rules word for word', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  const expected = { low: 1500, medium: 3000, high: 6000 } as const
  const rules = [
    '- Keep exactly what I meant. Add a clear goal, who it is for, the format, and what "done" looks like.',
    '- Use what I answered. Leave out what I skipped.',
    '- Never invent facts, names, numbers or prices. Where something is unknown, leave a [placeholder] in square brackets.',
    '- Write it as one request I could have typed myself, in plain language.',
  ]
  for (const level of ['low', 'medium', 'high'] as const) {
    await better($, `level ${level}`, clock)
    await better($, ROUGH, clock)
  }
  const rewrites = world.modelCalls.filter(call => call.model === 'sonnet')
  expect(rewrites.map(call => call.maxTokens)).toEqual([1500, 3000, 6000])
  for (const call of rewrites) {
    const system = call.system ?? ''
    for (const rule of rules) expect(system).toContain(rule)
    // The level's block comes after the rules.
    expect(system.indexOf('Detail level:')).toBeGreaterThan(system.indexOf(rules[3] ?? ''))
  }
  expect(rewrites[0]?.system).toContain('about 40 to 80 words')
  expect(rewrites[1]?.system).toContain('about 80 to 150 words')
  expect(rewrites[2]?.system).toContain('about 150 to 300 words')
  expect(rewrites[2]?.system).toContain('[placeholder] for every unknown')
  expect(expected.high).toBe(6000)
  // The check keeps its own room, and the caps follow the level.
  const checks = world.modelCalls.filter(call => call.model === 'haiku')
  expect(checks.every(call => call.maxTokens === 1500)).toBe(true)
  expect(checks[0]?.system).toContain('at most 3')
  expect(checks[1]?.system).toContain('at most 5')
  expect(checks[2]?.system).toContain('at most 7')
})

test('40. the history stores the level and shows it; old entries read as medium', async ($, on) => {
  const old = { id: 'a-1', original: 'an old rough prompt', upgraded: 'Old upgrade', added: ['A goal'], wordsBefore: 4, wordsAfter: 2, detailsAdded: 1, answers: [], at: 900_000 }
  expect(restoreHistory([old])[0]?.detailLevel).toBe('medium')
  expect(restoreHistory([{ ...old, detailLevel: 'nonsense' }])[0]?.detailLevel).toBe('medium')
  expect(restoreHistory([{ ...old, detailLevel: 'high' }])[0]?.detailLevel).toBe('high')

  const { data: store } = recordingStore(on, { 'prompt-upgrade.history': [old] })
  const { clock } = standInForEngine(on, null)
  await startSession($)
  await better($, 'level high', clock)
  await better($, ROUGH, clock)

  const saved = store['prompt-upgrade.history'] as PromptUpgradeEntry[]
  expect(saved.map(entry => entry.detailLevel)).toEqual(['high', 'medium'])
  await better($, 'history', clock)
  const rows = (await (await mountPane($)).findAll({ type: 'Button' })).filter(button => (button.key ?? '').startsWith('history-'))
  expect(rows[0]?.text).toMatch(/HIGH\s+write something about bees/)
  expect(rows[1]?.text).toMatch(/MED\s+an old rough prompt/)
})

// ---------------------------------------------------------------------------
// The prompt check
// ---------------------------------------------------------------------------

test('41. automatic mode, ready: sent untouched as the person, no pane, status set then cleared', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: READY_REPLY })
  await startSession($)

  const result = await sendTyped($, `  ${ROUGH}  `)
  expect(result.drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku'])
  expect(world.opened).toHaveLength(0)
  expect(world.toasts).toHaveLength(0)
  expect(world.submitted).toHaveLength(1)
  expect(world.submitted[0]?.text).toBe(ROUGH)
  expect(world.submitted[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(world.statuses).toEqual([CHECKING_STATUS, undefined, SENT_STATUS])

  // The note clears itself.
  await clock.advance(3000)
  expect(world.statuses.at(-1)).toBeUndefined()
  expect(world.opened).toHaveLength(0)
})

test('42. automatic mode, not ready: the pane opens on the questions, only as many as were asked', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: TWO_QUESTIONS })
  await startSession($)

  await sendTyped($, ROUGH)
  // The check runs first; nothing is open yet.
  expect(world.opened).toHaveLength(0)
  await clock.settle()
  expect(world.opened).toEqual([PANE_ID])
  expect(world.submitted).toHaveLength(0)
  expect(world.statuses).toEqual([CHECKING_STATUS, undefined])

  const pane = await mountPane($)
  expect(await paneText(pane)).toMatch(/0 of 2 answered/)
  expect(await pane.find({ type: 'Text', text: 'Question 3?' })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: /^✓ Your prompt$/ }))?.props.color).toBe('#3DD68C')
  expect((await pane.find({ type: 'Text', text: /^● Questions$/ }))?.props.color).toBe('#F2C46D')
  await pane.unmount()
})

test('43. automatic mode, the check fails: the pane opens on the error card and the status clears', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: 'Sorry, no.' })
  await startSession($)
  await sendTyped($, ROUGH)
  await clock.settle()
  expect(world.opened).toEqual([PANE_ID])
  expect(world.statuses).toEqual([CHECKING_STATUS, undefined])
  expect(world.submitted).toHaveLength(0)
  const text = await paneNow($)
  expect(text).toMatch(/Something went wrong while reading your prompt\./)
  expect(text).toMatch(/Your prompt is safe\./)
})

test('44. /better, ready: the "already looks good" card; Send as typed sends, Upgrade anyway rewrites', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: READY_REPLY })
  await startSession($)
  await better($, ROUGH, clock)
  expect(world.opened).toEqual([PANE_ID])
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku'])

  const pane = await mountPane($)
  expect(await paneText(pane)).toMatch(/This already looks good/)
  expect((await pane.find({ type: 'Text', text: ' Send as typed ' }))?.props.backgroundColor).toBe('#F2C46D')
  expect((await pane.find({ type: 'Text', text: ' Upgrade anyway ' }))?.props.backgroundColor).toBe('#262B33')
  expect(await pane.find({ type: 'Button', key: 'cancel' })).toBeDefined()

  // Upgrade anyway: the rewrite with no questions.
  await pane.press({ key: 'upgrade-anyway' })
  await clock.settle()
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku', 'sonnet'])
  expect(world.modelCalls[1]?.prompt).toContain('No questions were answered.')
  expect(await paneText(pane)).toMatch(/THE UPGRADE/)
  await pane.unmount()

  // Send as typed.
  await better($, ROUGH, clock)
  const again = await mountPane($)
  await again.press({ key: 'send-as-typed' })
  await clock.settle()
  await again.unmount()
  expect(world.submitted.map(sent => sent.text)).toEqual([ROUGH])
  expect(world.submitted[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(world.closed).toEqual([PANE_ID])
})

test('45. the typing stage behaves the same when the prompt is ready', async ($, on) => {
  const { clock } = standInForEngine(on, {}, { questions: READY_REPLY })
  await startSession($)
  await better($, '', clock)
  const pane = await mountPane($)
  await pane.input({ key: 'typed-prompt', text: ROUGH })
  await clock.settle()
  expect(await paneText(pane)).toMatch(/This already looks good/)
  await pane.unmount()
})

test("46. Claude's last reply is given to the check, from the main loop only, cut to its end", async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: READY_REPLY })
  const published = watchState(on, 'lastReply')
  await startSession($)
  const turn = { durationMs: 5, isAborted: false, reason: 'answer' as const }

  const reply = `${'x'.repeat(2000)}Shall I build it now?`
  await $.turn.complete({ ...turn, turnId: 't1', answer: reply })
  // A subagent's report is not Claude's reply to the person.
  await $.turn.complete({ ...turn, turnId: 't2', agentId: 'sub-1', answer: 'a subagent report' })
  expect(published).toHaveLength(1)
  expect((published[0] as string).length).toBe(1500)

  await better($, 'yes do it', clock)
  const prompt = world.modelCalls[0]?.prompt ?? ''
  expect(prompt).toContain("Claude's last message:")
  expect(prompt).toContain('Shall I build it now?')
  expect(prompt).not.toContain('a subagent report')
  expect(prompt).toContain('yes do it')
  // The system text tells the model what to do with a short reply.
  expect(world.modelCalls[0]?.system).toContain('"yes do it" after "Shall I build it?" is ready')
  expect(world.modelCalls[0]?.system).toContain('"fix it" with nothing before it is not')
})

test('47. without a last reply the check says the conversation is new', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await better($, ROUGH, clock)
  expect(world.modelCalls[0]?.prompt).toContain('(none: this starts the conversation)')
})

// ---------------------------------------------------------------------------
// The same prompt twice
// ---------------------------------------------------------------------------

test('48. the same prompt twice goes through the second time; a different one is still caught', async ($, on) => {
  const published = watchState(on, 'lastIntercepted')
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: TWO_QUESTIONS })
  await startSession($)

  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.modelCalls).toHaveLength(1)

  // Cancel puts the words back; sending them again passes untouched, with no check.
  const pane = await mountPane($)
  await pane.press({ key: 'cancel' })
  await clock.settle()
  await pane.unmount()
  expect(world.filled).toEqual([{ text: ROUGH, mode: 'replace' }])

  const second = await sendTyped($, `  ${ROUGH.toUpperCase()}   `)
  expect(second.drop).toBeUndefined()
  await clock.settle()
  expect(world.submitted.map(sent => sent.text)).toEqual([`  ${ROUGH.toUpperCase()}   `])
  expect(world.modelCalls).toHaveLength(1)
  expect(world.opened).toEqual([PANE_ID])
  expect(published.at(-1)).toBe('')

  // The memory is cleared: the same prompt a third time is caught again.
  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.modelCalls).toHaveLength(2)
  // A different prompt is caught too.
  expect((await sendTyped($, 'write a different thing about wasps for my blog')).drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.modelCalls).toHaveLength(3)
  expect(world.modelCalls[2]?.prompt).toContain('wasps')
  expect(normalizePrompt('  Hello   WORLD \n there ')).toBe('hello world there')
})

test('49. /better <prompt> is unaffected by the memory', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: TWO_QUESTIONS })
  await startSession($)
  await sendTyped($, ROUGH)
  await clock.settle()
  await better($, ROUGH, clock)
  expect(world.modelCalls.filter(call => call.model === 'haiku')).toHaveLength(2)
})

// ---------------------------------------------------------------------------
// Reloads
// ---------------------------------------------------------------------------

test('50. a reload during automatic mode\'s check runs the check again', async ($, on) => {
  let releaseFirst: (() => void) | undefined
  let checkCalls = 0
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, {
    questions: () => {
      checkCalls += 1
      if (checkCalls > 1) return TWO_QUESTIONS
      return new Promise<string>(resolve => {
        releaseFirst = () => resolve(READY_REPLY)
      })
    },
  })
  await startSession($)
  await sendTyped($, ROUGH)
  await clock.advance(1)
  expect(world.opened).toHaveLength(0)

  // Reload with the check in flight.
  await startSession($)
  await clock.advance(1)
  releaseFirst?.()
  await clock.settle()
  expect(world.modelCalls.filter(call => call.model === 'haiku')).toHaveLength(2)
  // The stale "ready" answer did not send the prompt; the second answer's questions are showing.
  expect(world.submitted).toHaveLength(0)
  expect(world.opened).toEqual([PANE_ID])
  expect(await paneNow($)).toMatch(/Who is it for\?/)
  expect(world.statuses.at(-1)).toBeUndefined()
})

test('51. the dropdown fits at 36, 60 and 140 columns, and sits on its own line when narrow', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, { questions: TWO_QUESTIONS })
  await startSession($)
  await better($, '', clock)

  const findNode = (node: Drawn, matches: (candidate: Exclude<Drawn, string>) => boolean): Exclude<Drawn, string> | undefined => {
    if (typeof node === 'string') return undefined
    if (matches(node)) return node
    for (const child of node.children ?? []) {
      const found = findNode(child, matches)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const columns of [36, 60, 140]) {
    await expectFits($, columns)
    const pane = await mountPane($, columns)
    const titleRow = findNode((await pane.drawn()) as Drawn, node => node.props.key === 'title-row')
    // On the title's row from 60 columns; on its own line below.
    expect(titleRow !== undefined).toBe(columns >= 60)
    expect(await pane.find({ type: 'Select', key: 'detail-level' })).toBeDefined()
    await pane.unmount()
  }

  // Questions, the ready card and a review with the Rewrite chip fit too.
  await better($, ROUGH, clock)
  for (const columns of [36, 60, 140]) await expectFits($, columns)
  const pane = await mountPane($, 60)
  await pane.press({ key: 'skip-rest' })
  await clock.settle()
  await pane.select({ key: 'detail-level', value: 'high' })
  expect(await pane.find({ type: 'Button', key: 'rewrite-level' })).toBeDefined()
  await pane.unmount()
  for (const columns of [36, 60, 69, 70, 140]) await expectFits($, columns)

  world.script.questions = READY_REPLY
  await better($, ROUGH, clock)
  for (const columns of [36, 60, 140]) await expectFits($, columns)
})

// ---------------------------------------------------------------------------
// Auto: the detail level that decides for you
// ---------------------------------------------------------------------------

const STORE_HISTORY = 'prompt-upgrade.history'
const TEN_QUESTIONS = JSON.stringify({
  ready: false,
  missing: ['a'],
  questions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(number => ({
    question: `Question ${number}?`,
    options: ['one', 'two', 'three', 'four', 'five'],
  })),
})
const AUTO_LEVEL = { [STORE_DETAIL]: 'auto' }
const COUNTDOWN_LINE = "I'll fill in the rest and send it in 30 seconds unless you answer."

/** A rewrite that waits until the test lets it go, to look at the screen while it writes. */
function heldRewrite() {
  const gate: { release?: () => void } = {}
  const rewrite = () =>
    new Promise<string>(resolve => {
      gate.release = () => resolve(GOOD_REWRITE)
    })
  return { gate, rewrite }
}

test('52. Auto is first in the dropdown, /better level auto sets it, and the default is still Medium', async ($, on) => {
  const published = watchState(on, 'detailLevel')
  const { data: store } = recordingStore(on)
  const { clock } = standInForEngine(on, null)
  await startSession($)
  expect(published).toEqual(['medium'])

  await better($, '', clock)
  const typing = await mountPane($)
  const select = await typing.find({ type: 'Select', key: 'detail-level' })
  expect((select?.props.options as { value: string }[]).map(option => option.value)).toEqual(['auto', 'low', 'medium', 'high'])
  expect(select?.props.value).toBe('medium')
  await typing.unmount()

  const ran = await better($, 'level auto', clock)
  expect(ran.text).toBe('Detail is now Auto, and automatic mode is on: prompts you type are checked first.')
  expect(store[STORE_DETAIL]).toBe('auto')
  expect(published).toEqual(['medium', 'auto'])
  expect((await better($, 'level extreme', clock)).text).toBe('Detail is auto, low, medium or high, e.g. /better level auto.')
  expect(parseBetterArgs('level AUTO')).toEqual({ kind: 'level', level: 'auto' })
})

test('53. at Auto up to 9 questions are kept and a tenth is cut; the rewrite and check texts follow Auto', async ($, on) => {
  const parsed = parseQuestions(TEN_QUESTIONS, 'auto')
  expect(parsed.isOk && parsed.questions).toHaveLength(9)
  expect(parsed.isOk && parsed.questions.at(-1)?.question).toBe('Question 9?')
  expect(parsed.isOk && parsed.questions.every(question => question.options.length === 4)).toBe(true)
  expect(DETAIL_SPECS.auto).toMatchObject({ maxQuestions: 9, maxOptions: 4, rewriteMaxTokens: 6000 })

  const { world, clock } = standInForEngine(on, AUTO_LEVEL)
  await startSession($)
  await better($, ROUGH, clock)
  const check = world.modelCalls.find(call => call.model === 'haiku')
  expect(check?.system).toContain('Ask only as many questions as the gaps need, at most 9.')
  expect(check?.system).toContain('at least 1 and at most 9')
  const rewrite = world.modelCalls.find(call => call.model === 'sonnet')
  expect(rewrite?.maxTokens).toBe(6000)
  expect(rewrite?.system).toContain('Detail level: Auto.')
  expect(rewrite?.system).toContain(
    '- Match the length and depth to the size and risk of the task: a small, clear task gets one short paragraph; a large or risky one gets short labeled sections with constraints, what is out of scope and what done looks like.',
  )
  expect(rewrite?.system).toContain('The "added" list has 1 to 8 items.')
})

test('54. the countdown: 30 s later the rest is chosen, the upgrade is sent with no review, and it is saved as automatic', async ($, on) => {
  const { data: store } = recordingStore(on, AUTO_LEVEL)
  const { world, clock } = standInForEngine(on, null, { questions: TWO_QUESTIONS })
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  const screen = await paneText(pane)
  expect(screen).toContain(COUNTDOWN_LINE)
  expect((await pane.find({ type: 'Text', text: ' Do it for me ' }))?.props.backgroundColor).toBe('#F2C46D')
  expect((await pane.find({ type: 'Text', text: ' Skip the rest, upgrade now ' }))?.props.backgroundColor).toBe('#262B33')
  // Do it for me comes before Skip the rest.
  expect(screen.indexOf('Do it for me')).toBeLessThan(screen.indexOf('Skip the rest'))

  // Nothing is answered, so the countdown runs to its end.
  await clock.advance(29_999)
  expect(world.submitted).toHaveLength(0)
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku'])

  await clock.advance(1)
  await clock.settle()
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku', 'sonnet'])
  const request = world.modelCalls[1]?.prompt ?? ''
  expect(request).toContain(CHOOSE_FOR_UNANSWERED)
  expect(request).toContain('Questions I did not answer:\nQ: Who is it for?\nOptions: Beginners / Experts')
  expect(request).toContain('Q: How long should it be?')
  expect(world.submitted).toHaveLength(1)
  expect(world.submitted[0]?.text).toMatch(/^Write a two-page guide about bees/)
  expect(world.submitted[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(world.closed).toEqual([PANE_ID])
  expect(world.statuses).toEqual([AUTO_SENT_STATUS])

  // No review stage: the flow is idle and the upgrade card never showed.
  const after = await paneText(pane)
  expect(after).toMatch(/Nothing to upgrade right now/)
  expect(after).not.toMatch(/THE UPGRADE/)
  await pane.unmount()

  // The status clears itself after about 3 s.
  await clock.advance(3000)
  expect(world.statuses).toEqual([AUTO_SENT_STATUS, undefined])
  const saved = store[STORE_HISTORY] as PromptUpgradeEntry[]
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ sentAutomatically: true, detailLevel: 'auto', original: ROUGH })
})

test('55. "Do it for me" does the same at once, and the rewrite screen says it sends on its own', async ($, on) => {
  const held = heldRewrite()
  const { world, clock } = standInForEngine(on, AUTO_LEVEL, { questions: TWO_QUESTIONS, rewrite: held.rewrite })
  await startSession($)
  await better($, ROUGH, clock)

  const pane = await mountPane($)
  await pane.press({ key: 'q0-opt-1' })
  await pane.press({ key: 'do-it-for-me' })
  await clock.settle()
  expect(await paneText(pane)).toMatch(/Writing the upgrade\. It sends on its own\./)
  expect(world.submitted).toHaveLength(0)
  // The answered question is sent as an answer; only the open one is left to the model.
  const request = world.modelCalls[1]?.prompt ?? ''
  expect(request).toContain('Q: Who is it for?\nA: Experts')
  expect(request).toContain('Questions I did not answer:\nQ: How long should it be?')
  expect(request).not.toContain('Questions I did not answer:\nQ: Who is it for?')

  held.gate.release?.()
  await clock.settle()
  expect(world.submitted).toHaveLength(1)
  expect(world.submitted[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(world.closed).toEqual([PANE_ID])
  expect(await paneText(pane)).not.toMatch(/THE UPGRADE/)
  await pane.unmount()

  // The countdown that was running does nothing more.
  await clock.advance(30_000)
  expect(world.submitted).toHaveLength(1)
  expect(world.modelCalls.filter(call => call.model === 'sonnet')).toHaveLength(1)
})

test('56. an answer, Other, Skip or the dropdown cancels the countdown; the normal review follows', async ($, on) => {
  const { world, clock } = standInForEngine(on, AUTO_LEVEL, { questions: TWO_QUESTIONS })
  await startSession($)

  for (const press of ['q0-opt-0', 'q0-other', 'q0-skip']) {
    await better($, ROUGH, clock)
    const pane = await mountPane($)
    expect(await paneText(pane)).toContain(COUNTDOWN_LINE)
    await pane.press({ key: press })
    expect(await paneText(pane)).not.toContain(COUNTDOWN_LINE)
    await pane.unmount()
  }

  // The dropdown counts too.
  await better($, ROUGH, clock)
  const pane = await mountPane($)
  await pane.select({ key: 'detail-level', value: 'high' })
  expect(await paneText(pane)).not.toContain(COUNTDOWN_LINE)

  // Thirty seconds later nothing was sent.
  await clock.advance(30_000)
  expect(world.submitted).toHaveLength(0)
  expect(world.modelCalls.filter(call => call.model === 'sonnet')).toHaveLength(0)

  // Answering the rest is the normal flow: a rewrite, then the review, then Run.
  await pane.press({ key: 'q0-opt-0' })
  await pane.press({ key: 'q1-opt-0' })
  await clock.settle()
  expect(world.modelCalls.filter(call => call.model === 'sonnet')).toHaveLength(1)
  expect(world.modelCalls.at(-1)?.prompt).not.toContain('Questions I did not answer')
  expect(await paneText(pane)).toMatch(/THE UPGRADE/)
  expect(world.submitted).toHaveLength(0)
  await pane.press({ key: 'run' })
  await clock.settle()
  expect(world.submitted).toHaveLength(1)
  await pane.unmount()
})

test('57. a reload during the countdown reschedules the time that is left', async ($, on) => {
  const { world, clock } = standInForEngine(on, AUTO_LEVEL, { questions: TWO_QUESTIONS })
  await startSession($)
  await better($, ROUGH, clock)
  await clock.advance(10_000)

  await startSession($)
  await clock.advance(19_999)
  expect(world.submitted).toHaveLength(0)
  await clock.advance(1)
  await clock.settle()
  // Exactly one send, even though the timer from before the reload may also have run.
  expect(world.submitted).toHaveLength(1)
  expect(world.modelCalls.filter(call => call.model === 'sonnet')).toHaveLength(1)
})

test('58. a rewrite that fails during fill-and-send shows the error card and sends nothing', async ($, on) => {
  const { world, clock } = standInForEngine(on, AUTO_LEVEL, { questions: TWO_QUESTIONS, rewrite: 'Sorry, no.' })
  await startSession($)
  await better($, ROUGH, clock)
  const pane = await mountPane($)
  await pane.press({ key: 'do-it-for-me' })
  await clock.settle()
  const text = await paneText(pane)
  expect(text).toMatch(/Something went wrong while writing the upgrade\./)
  expect(text).toMatch(/Your prompt is safe\./)
  expect(world.submitted).toHaveLength(0)
  expect(world.closed).toHaveLength(0)

  // Try again goes on to the normal review: it does not send on its own.
  world.script.rewrite = GOOD_REWRITE
  await pane.press({ key: 'retry' })
  await clock.settle()
  expect(await paneText(pane)).toMatch(/THE UPGRADE/)
  expect(world.submitted).toHaveLength(0)
  await pane.unmount()
})

test('59. Enter twice during the check: the second passes untouched and the late answer is ignored', async ($, on) => {
  const gate: { release?: () => void } = {}
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, {
    questions: () =>
      new Promise<string>(resolve => {
        gate.release = () => resolve(TWO_QUESTIONS)
      }),
  })
  await startSession($)
  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)
  await clock.settle()
  expect(world.statuses).toEqual([CHECKING_STATUS])

  const second = await sendTyped($, ROUGH)
  expect(second.drop).toBeUndefined()
  expect(world.submitted.map(sent => sent.text)).toEqual([ROUGH])
  expect(world.statuses.at(-1)).toBeUndefined()

  // The check answers late: no second submit and no pane.
  gate.release?.()
  await clock.settle()
  expect(world.submitted).toHaveLength(1)
  expect(world.opened).toHaveLength(0)
  expect(await paneNow($)).toMatch(/Nothing to upgrade right now/)
})

test('60. Enter twice with the pane open on the questions: the second passes and the pane closes', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true, ...AUTO_LEVEL }, { questions: TWO_QUESTIONS })
  await startSession($)
  await sendTyped($, ROUGH)
  await clock.settle()
  expect(world.opened).toEqual([PANE_ID])

  const second = await sendTyped($, ROUGH)
  expect(second.drop).toBeUndefined()
  expect(world.submitted.map(sent => sent.text)).toEqual([ROUGH])
  expect(world.closed).toEqual([PANE_ID])
  // Closing from the plugin restores nothing beyond the refill made when the prompt was caught.
  expect(world.filled).toEqual([{ text: ROUGH, mode: 'replace' }])
  expect(await paneNow($)).toMatch(/Nothing to upgrade right now/)

  // The countdown that was running does nothing, and the memory is cleared.
  await clock.advance(30_000)
  expect(world.submitted).toHaveLength(1)
  expect(world.modelCalls.map(call => call.model)).toEqual(['haiku'])
  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)
})

test('61. on intercept the box is refilled when empty and left alone when it holds text', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: TWO_QUESTIONS })
  await startSession($)
  expect(CHECKING_STATUS).toBe('Checking your prompt… Press Enter again to send it as typed.')

  await sendTyped($, `  ${ROUGH}  `)
  await clock.settle()
  expect(world.filled).toEqual([{ text: ROUGH, mode: 'replace' }])
  expect(world.statuses[0]).toBe(CHECKING_STATUS)

  // The box already holds text (the person kept typing): it is not touched.
  world.filled.length = 0
  world.box = 'something the person is still typing'
  await sendTyped($, 'write a different thing about wasps for my blog')
  await clock.settle()
  expect(world.filled).toEqual([])
  expect(world.box).toBe('something the person is still typing')
})

test('62. the box is emptied before a send only when it still holds the original', async ($, on) => {
  const gate: { release?: () => void } = {}
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, {
    questions: () =>
      new Promise<string>(resolve => {
        gate.release = () => resolve(READY_REPLY)
      }),
  })
  await startSession($)

  // Ready, box untouched: refilled on intercept, emptied, then sent.
  await sendTyped($, ROUGH)
  await clock.settle()
  expect(world.box).toBe(ROUGH)
  gate.release?.()
  await clock.settle()
  expect(world.submitted.map(sent => sent.text)).toEqual([ROUGH])
  expect(world.filled.at(-1)).toEqual({ text: '', mode: 'replace' })
  expect(world.box).toBe('')

  // Ready, but the person typed more in the box meanwhile: their typing stays.
  await sendTyped($, 'write a different thing about wasps for my blog')
  await clock.settle()
  world.filled.length = 0
  world.box = 'write a different thing about wasps for my blog, and more'
  gate.release?.()
  await clock.settle()
  expect(world.submitted).toHaveLength(2)
  expect(world.filled).toEqual([])
  expect(world.box).toBe('write a different thing about wasps for my blog, and more')
})

test('63. Run and fill-and-send empty the box only when it holds the original', async ($, on) => {
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true, ...AUTO_LEVEL }, { questions: TWO_QUESTIONS })
  await startSession($)

  // Run from the review, the box untouched.
  await sendTyped($, ROUGH)
  await clock.settle()
  const pane = await mountPane($)
  await pane.press({ key: 'q0-opt-0' })
  await pane.press({ key: 'q1-opt-0' })
  await clock.settle()
  world.filled.length = 0
  await pane.press({ key: 'run' })
  await clock.settle()
  expect(world.filled).toEqual([{ text: '', mode: 'replace' }])
  expect(world.box).toBe('')

  // Fill-and-send, with the person's own text in the box: it stays.
  await sendTyped($, 'write a different thing about wasps for my blog')
  await clock.settle()
  world.filled.length = 0
  world.box = 'my own new words'
  await pane.press({ key: 'do-it-for-me' })
  await clock.settle()
  await pane.unmount()
  expect(world.submitted).toHaveLength(2)
  expect(world.filled).toEqual([])
  expect(world.box).toBe('my own new words')
})

test('64. the "press Enter" line shows on the questions, ready and error screens of a caught prompt only', async ($, on) => {
  const hint = 'Press Enter in the prompt box to send it as typed.'
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true }, { questions: TWO_QUESTIONS })
  await startSession($)

  await sendTyped($, ROUGH)
  await clock.settle()
  expect(await paneNow($)).toContain(hint)
  const pane = await mountPane($)
  const hintRow = await pane.find({ type: 'Text', text: hint })
  expect(hintRow?.props.color).toBe('#7D8590')
  await pane.unmount()

  // A prompt from /better does not keep its words in the box, so it has no such line.
  await better($, ROUGH, clock)
  expect(await paneNow($)).not.toContain(hint)

  world.script.questions = 'nope'
  await sendTyped($, 'write a different thing about wasps for my blog')
  await clock.settle()
  expect(await paneNow($)).toContain(hint)
  world.script.questions = READY_REPLY
  await better($, 'write a third thing about ants for my garden', clock)
  expect(await paneNow($)).not.toContain(hint)
})

test('65. the Auto screens fit at 36, 60 and 140 columns: countdown, chips, hints and the rewrite screen', async ($, on) => {
  const held = heldRewrite()
  const { world, clock } = standInForEngine(on, { [STORE_AUTO]: true, ...AUTO_LEVEL }, { questions: TWO_QUESTIONS, rewrite: held.rewrite })
  await startSession($)

  // Questions at Auto, from a caught prompt: the countdown line, both chips and the hint.
  await sendTyped($, ROUGH)
  await clock.settle()
  expect(await paneNow($)).toContain(COUNTDOWN_LINE)
  for (const columns of [36, 60, 140]) await expectFits($, columns)

  // The rewrite screen that sends on its own.
  const pane = await mountPane($, 60)
  await pane.press({ key: 'do-it-for-me' })
  await clock.settle()
  await pane.unmount()
  for (const columns of [36, 60, 140]) await expectFits($, columns)
  held.gate.release?.()
  await clock.settle()

  // The ready card and the error card with the hint.
  world.script.questions = READY_REPLY
  await better($, ROUGH, clock)
  for (const columns of [36, 60, 140]) await expectFits($, columns)
  world.script.questions = 'nope'
  await sendTyped($, 'write a different thing about wasps for my blog')
  await clock.settle()
  for (const columns of [36, 60, 140]) await expectFits($, columns)
})

test('picking Auto also turns automatic mode on, so typed prompts are checked; Low, Medium and High leave it alone', async ($, on) => {
  const publishedAuto = watchState(on, 'isAutoOn')
  const { data: store } = recordingStore(on, { [STORE_AUTO]: false })
  const { world, clock } = standInForEngine(on, null)
  await startSession($)

  // Automatic mode off: a typed prompt goes straight through.
  await sendTyped($, ROUGH)
  expect(world.submitted).toHaveLength(1)

  await better($, 'level auto', clock)
  expect(store[STORE_AUTO]).toBe(true)
  expect(publishedAuto.at(-1)).toBe(true)
  expect((await sendTyped($, ROUGH)).drop).toBe(DROP_TEXT)

  // The dropdown's Auto does the same; other levels keep whatever automatic mode is.
  await better($, 'off', clock)
  await better($, 'level high', clock)
  expect(store[STORE_AUTO]).toBe(false)
  await better($, '', clock)
  const typing = await mountPane($)
  await typing.select({ key: 'detail-level', value: 'auto' })
  expect(store[STORE_AUTO]).toBe(true)
  await typing.unmount()
})
