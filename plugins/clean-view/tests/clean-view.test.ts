// Clean View's behaviour, run with `claude plugin test <mod folder>`.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { cleanStepName } from '../hooks/clean-view'

const PLUGIN = 'clean-view'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const START_TIME = 1_000_000
// How a typed slash command reaches command.run.
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

// The band's props as the engine hands them over.
function bandProps(bodyColumns = 80): RenderPropsOf['AbovePrompt'] {
  return {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  }
}

// Answers what the plugin asks of the engine: clock, store, registrations, toasts, Haiku.
function standInForEngine(on: On, haikuTitle = 'Build my landing page') {
  const clock = mock.clock(on, { now: START_TIME })
  mock.store(on)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  // The engine's own answers to the events the plugin passes on.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('tool.call', { tool: 'ToolSearch' }, () => ({ result: 'Loaded.' as never }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: haikuTitle,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  return clock
}

// Starts the session and a job, as typing a prompt does.
async function startJob($: Engine, prompt = 'Please build my landing page') {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: prompt, turnId: 'turn-1' })
}

// Every line of text the band draws, one string per Text element.
async function bandTexts($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 80) {
  const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(bodyColumns) })
  const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
  const toggle = await band.find({ type: 'Button', key: 'toggle' })
  await band.unmount()
  return { texts, all: texts.join('\n'), toggleLabel: String(toggle?.props.label ?? '') }
}

// The outer Text of the row whose name matches, which holds marker, name, meter and label.
function rowText(texts: readonly string[], name: string): string {
  const candidates = texts.filter(text => text.includes(name))
  return candidates.reduce((longest, text) => (text.length > longest.length ? text : longest), '')
}

test('1. the cleaner keeps step names plain and short', () => {
  expect(cleanStepName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanStepName('Update src/components/Header.tsx with the new logo')).toBe('Update with the new logo')
  expect(cleanStepName('fix the bug in index.ts now')).toBe('Fix the bug in now')
  expect(cleanStepName('   lots    of   space   ')).toBe('Lots of space')
  expect(cleanStepName('`npm run build`')).toBe('Working on it')

  const eightyCharacters = 'Rewrite the onboarding flow so all new visitors can understand the pricing tiers'
  expect(eightyCharacters.length).toBe(80)
  const trimmed = cleanStepName(eightyCharacters)
  expect(trimmed.length <= 40).toBe(true)
  expect(trimmed.endsWith('…')).toBe(true)
  expect(trimmed).toBe('Rewrite the onboarding flow so all new…')
})

test('2. a to-do list and a 60% report draw done, current, next and later rows', async ($, on) => {
  standInForEngine(on)
  on('tool.call', { tool: 'TodoWrite' }, ($, e) => ({ result: { oldTodos: [], newTodos: e.todos } as never }))
  await startJob($)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading your brand notes' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building the pricing section' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding the contact form' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing the footer' },
    ],
  })
  const reported = await $.tool.call({ tool: REPORT_TOOL, task: 'Build the pricing section', percent: 60 })
  expect(reported.result).toBe('Progress noted: 60%.')

  for (const surface of SURFACES) {
    const { texts } = await bandTexts($, surface)
    const doneRow = rowText(texts, 'Read your brand notes')
    expect(doneRow).toMatch(/✓/)
    expect(doneRow).toMatch(/██████████/)
    expect(doneRow).toMatch(/Done/)
    const currentRow = rowText(texts, 'Build the pricing section')
    expect(currentRow).toMatch(/▶/)
    expect(currentRow).toMatch(/██████░░░░/)
    expect(currentRow).toMatch(/60%/)
    expect(rowText(texts, 'Add the contact form')).toMatch(/○.*Next$/)
    expect(rowText(texts, 'Polish the footer')).toMatch(/○.*Up next$/)
  }
})

test('3. a permission prompt shows Needs you', async ($, on) => {
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })

  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

  for (const surface of SURFACES) {
    const { all } = await bandTexts($, surface)
    expect(all).toMatch(/Needs you/)
    expect(all).toMatch(/Claude needs your OK to continue/)
    expect(all).toMatch(/‖/)
  }
})

test('4. /simple off hides the band and brings tool rows back', async ($, on) => {
  standInForEngine(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'Bash(ls)' })
  })
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })
  const toolRow = { tool_use_id: 'call-1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false }

  const hiddenRow = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolUse', props: toolRow })
  expect(await hiddenRow.find({ text: /Bash/ })).toBeUndefined()
  await hiddenRow.unmount()

  const answer = await $.command.run({ command: 'simple', args: 'off', ...TYPED })
  expect(answer.text).toBe('Clean View is off.')

  for (const surface of SURFACES) {
    const { all, toggleLabel } = await bandTexts($, surface)
    expect(all).not.toMatch(/▶|Build the pricing section/)
    expect(toggleLabel).toMatch(/OFF/)
  }
  const shownRow = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolUse', props: toolRow })
  expect(await shownRow.find({ text: /Bash/ })).toBeDefined()
  await shownRow.unmount()

  // The button turns it back on, and the plain command flips it.
  await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
  await $.ui.press({ plugin: PLUGIN, key: 'toggle' })
  expect((await bandTexts($, 'terminal')).toggleLabel).toMatch(/ON/)
  expect((await $.command.run({ command: 'simple', args: '', ...TYPED })).text).toBe('Clean View is off.')
})

test('5. plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  standInForEngine(on)
  await startJob($)

  const planned = await $.tool.call({
    tool: PLAN_TOOL,
    steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'],
  })
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const reported = await $.tool.call({ tool: REPORT_TOOL, task: 'Read your brand notes', percent: 100 })
  expect(reported.result).toBe('Progress noted: 100%.')

  for (const surface of SURFACES) {
    const { texts } = await bandTexts($, surface)
    expect(rowText(texts, 'Read your brand notes')).toMatch(/✓.*Done/)
    expect(rowText(texts, 'Build the pricing section')).toMatch(/▶.*Working/)
    expect(rowText(texts, 'Add the contact form')).toMatch(/Next$/)
  }
})

test('6. tools are denied before a plan exists and allowed after', async ($, on) => {
  standInForEngine(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'file text' as never }))
  await startJob($)

  const before = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.md' })
  expect(before.deny).toMatch(/plan_steps/)

  const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:plan_steps', max_results: 1 })
  expect(search.deny).toBeUndefined()

  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your notes', 'Write the summary'] })
  const after = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.md' })
  expect(after.deny).toBeUndefined()
  expect(after.result).toBe('file text')
})

test('a finished job says All done, then shrinks to one line after 5 seconds', async ($, on) => {
  const clock = standInForEngine(on, 'Build my landing page')
  await startJob($)
  await clock.advance(10) // lets the background naming run
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })
  await clock.advance(71_990)
  expect((await bandTexts($, 'terminal')).all).toMatch(/Build my landing page · 1m 12s/)
  await $.tool.call({ tool: REPORT_TOOL, task: 'Build the pricing section', percent: 100 })
  await clock.advance(62_000)
  await $.turn.complete({ answer: 'Done!', durationMs: 134_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  const finished = await bandTexts($, 'terminal')
  expect(finished.all).toMatch(/✓ All done/)
  expect(finished.all).toMatch(/Build my landing page/)
  expect(finished.all).toMatch(/took 2m 14s/)
  expect(finished.all).toMatch(/Read your brand notes/)

  await clock.advance(5_000)
  const collapsed = await bandTexts($, 'terminal')
  expect(collapsed.all).toMatch(/✓ All done/)
  expect(collapsed.all).not.toMatch(/Read your brand notes/)
})

test('failures, refusals, Esc and API errors read as plain sentences', async ($, on) => {
  const clock = standInForEngine(on)
  let shouldFail = true
  on('tool.call', { tool: 'Read' }, () =>
    shouldFail ? ({ isError: true, result: 'boom', text: 'File does not exist.' } as never) : ({ result: 'ok' } as never),
  )
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your notes', 'Write the summary'] })

  for (let attempt = 0; attempt < 3; attempt += 1) await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/⚠ Stuck: a step keeps failing, Claude is trying another way/)

  shouldFail = false
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' })
  expect((await bandTexts($, 'terminal')).all).not.toMatch(/Stuck/)

  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 'turn-1', reason: 'aborted' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/■ Stopped.*you pressed Esc/)

  await clock.advance(1000)
  await $.turn.start({ text: 'try again please', turnId: 'turn-2' })
  await $.classic.StopFailure({ error: 'rate_limit', error_details: '429' })
  await $.turn.complete({ answer: 'API Error: 429', durationMs: 1000, isAborted: false, turnId: 'turn-2', reason: 'error' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Stuck: you hit your usage limit, try again a little later/)

  await $.turn.start({ text: 'something else', turnId: 'turn-3' })
  await $.turn.complete({
    answer: '',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn-3',
    reason: 'refusal',
    refusal: { category: null, explanation: null },
  })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Stuck: Claude couldn't help with that request/)
})

test('unfinished steps at the end of a turn wait for a reply, and narrow bands never wrap', async ($, on) => {
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.turn.complete({ answer: 'Which color?', durationMs: 1000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Needs you.*Claude is waiting for your reply/s)

  const narrow = await bandTexts($, 'terminal', 34)
  const rowTexts = narrow.texts.filter(text => /[✓▶‖○]/.test(text) && text.length > 2)
  expect(rowTexts.length >= 2).toBe(true)
  for (const row of rowTexts) expect(row.length <= 34).toBe(true)
})
