// Clean View's behaviour, run with `claude plugin test <mod folder>`.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput, RenderPropsOf } from 'claude-code'

import { cleanStepName, hasVisibleContent, settleHelpers, startJob as startChecklist, stepPercent } from '../hooks/clean-view'

const PLUGIN = 'clean-view'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'
const BORDER_COLOR = '#3A3A46'
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

// What another mod's hook beneath Clean View draws into the band.
type BeneathBand = ($: EngineInterface, e: RenderInput<'AbovePrompt'>) => RenderElement

// Answers what the plugin asks of the engine: clock, store, registrations, toasts, Haiku.
function standInForEngine(on: On, haikuTitle = 'Build my landing page', drawBeneath?: BeneathBand) {
  const clock = mock.clock(on, { now: START_TIME })
  mock.store(on)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  // The band beneath Clean View: the engine's own, which is empty, unless a test stands in another mod.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => drawBeneath?.($, e) ?? $.ui.resolve(e).Box({}))
  // The engine's own answers to the events the plugin passes on.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
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
  await typePrompt($, prompt, 'turn-1')
}

// A typed prompt: the submit the engine raises, then its turn.
async function typePrompt($: Engine, text: string, turnId: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}

// What the band draws: its texts, its root box, each step row and a mounted-tree finder.
async function bandTexts($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 80) {
  const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(bodyColumns) })
  const textNodes = await band.findAll({ type: 'Text' })
  const texts = textNodes.map(found => found.text)
  const boxes = await band.findAll({ type: 'Box' })
  const keyedParts = new Map(boxes.flatMap(box => (box.key === undefined ? [] : [[box.key, box] as const])))
  const rows = boxes.filter(box => box.key?.startsWith('row-'))
  const toggle = await band.find({ type: 'Button', key: 'toggle' })
  const found = {
    texts,
    all: texts.join('\n'),
    rootBox: keyedParts.get('band-frame'),
    wrapper: boxes[0],
    textNodes,
    rowTexts: rows.map(row => row.text),
    helperRows: boxes.filter(box => box.key?.startsWith('helper-') && box.key !== 'helper-more'),
    moreText: keyedParts.get('helper-more')?.text,
    toggleLabel: String(toggle?.props.label ?? ''),
    part: (key: string) => keyedParts.get(key),
  }
  await band.unmount()
  return found
}

// The row whose step name matches: marker, name, meter and label run together.
function rowText(rowTexts: readonly string[], name: string): string {
  return rowTexts.find(text => text.includes(name)) ?? ''
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
    const { rowTexts } = await bandTexts($, surface)
    const doneRow = rowText(rowTexts, 'Read your brand notes')
    expect(doneRow).toMatch(/✓/)
    expect(doneRow).toMatch(/█{10}/)
    expect(doneRow).toMatch(/Done$/)
    const currentRow = rowText(rowTexts, 'Build the pricing section')
    expect(currentRow).toMatch(/▶/)
    expect(currentRow).toMatch(/██████░░░░/)
    expect(currentRow).toMatch(/60%$/)
    expect(rowText(rowTexts, 'Add the contact form')).toMatch(/○.*Next$/)
    expect(rowText(rowTexts, 'Polish the footer')).toMatch(/○.*Up next$/)
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
    const { rowTexts } = await bandTexts($, surface)
    expect(rowText(rowTexts, 'Read your brand notes')).toMatch(/✓.*Done/)
    expect(rowText(rowTexts, 'Build the pricing section')).toMatch(/▶.*Working/)
    expect(rowText(rowTexts, 'Add the contact form')).toMatch(/Next$/)
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
  expect((await bandTexts($, 'terminal', 120)).all).toMatch(/⚠ Stuck: a step keeps failing, Claude is trying another way/)

  shouldFail = false
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' })
  expect((await bandTexts($, 'terminal', 120)).all).not.toMatch(/Stuck/)

  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 'turn-1', reason: 'aborted' })
  expect((await bandTexts($, 'terminal', 120)).all).toMatch(/■ Stopped.*you pressed Esc/)

  await clock.advance(1000)
  await typePrompt($, 'try again please', 'turn-2')
  await $.classic.StopFailure({ error: 'rate_limit', error_details: '429' })
  await $.turn.complete({ answer: 'API Error: 429', durationMs: 1000, isAborted: false, turnId: 'turn-2', reason: 'error' })
  expect((await bandTexts($, 'terminal', 120)).all).toMatch(/Stuck: you hit your usage limit, try again a little later/)

  await typePrompt($, 'something else', 'turn-3')
  await $.turn.complete({
    answer: '',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn-3',
    reason: 'refusal',
    refusal: { category: null, explanation: null },
  })
  expect((await bandTexts($, 'terminal', 120)).all).toMatch(/Stuck: Claude couldn't help with that request/)
})

test('unfinished steps at the end of a turn wait for a reply, and narrow bands never wrap', async ($, on) => {
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.turn.complete({ answer: 'Which color?', durationMs: 1000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Needs you.*Claude is waiting for your reply/s)

  const narrow = await bandTexts($, 'terminal', 34)
  expect(narrow.rowTexts.length).toBe(2)
  for (const row of narrow.rowTexts) expect(row.length <= 34 - 4).toBe(true)
  // The header leaves room for the toggle button and the box.
  expect(narrow.texts.every(text => text.length <= 34 - 4)).toBe(true)
})

test('the whole band sits in one round gray box that hugs its content, in every state', async ($, on) => {
  standInForEngine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const isHuggingBox = (band: Awaited<ReturnType<typeof bandTexts>>) => {
    expect(band.rootBox?.props).toMatchObject({ borderStyle: 'round', borderColor: BORDER_COLOR, paddingX: 1 })
    // No width of its own, and a wrapper that lets it shrink to its rows.
    expect(band.rootBox?.props.width).toBeUndefined()
    expect(band.wrapper?.props).toMatchObject({ alignItems: 'flex-start' })
  }

  // Idle: nothing running, so the header says Ready.
  const idle = await bandTexts($, 'terminal')
  isHuggingBox(idle)
  expect(idle.all).toMatch(/Ready/)

  await typePrompt($, 'Please build my landing page', 'turn-1')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })
  const working = await bandTexts($, 'terminal', 60)
  isHuggingBox(working)
  // Every row is as wide as its columns: marker, longest name, meter, label.
  expect(working.part('row-step-1')?.props.width).toBe(2 + 25 + 1 + 10 + 2 + 7)

  await $.tool.call({ tool: REPORT_TOOL, task: 'Build the pricing section', percent: 100 })
  await $.tool.call({ tool: REPORT_TOOL, task: 'Read your brand notes', percent: 100 })
  await $.turn.complete({ answer: 'Done!', durationMs: 1000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  isHuggingBox(await bandTexts($, 'terminal'))

  await $.command.run({ command: 'simple', args: 'off', ...TYPED })
  const off = await bandTexts($, 'terminal')
  isHuggingBox(off)
  expect(off.toggleLabel).toMatch(/OFF/)
})

test('"Step X of N" shows one parallelogram per step, filled for done steps', async ($, on) => {
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build the page', 'Add the form', 'Polish it', 'Ship it'] })
  await $.tool.call({ tool: REPORT_TOOL, task: 'Read notes', percent: 100 })
  await $.tool.call({ tool: REPORT_TOOL, task: 'Build the page', percent: 100 })

  const band = await bandTexts($, 'terminal')
  expect(band.part('band-progress')?.text).toBe('Step 3 of 5  ▰▰▱▱▱')
  const filled = band.textNodes.find(node => node.text === '▰▰')
  expect(filled?.props.color).toBe('claude')
  const empty = band.textNodes.find(node => node.text === '▱▱▱')
  expect(empty?.props.dimColor).toBe(true)
})

test('the active meter sweeps each tick while working, and just stops when paused', async ($, on) => {
  const clock = standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })

  const meterNow = async () => rowText((await bandTexts($, 'terminal')).rowTexts, 'Read your brand notes').match(/[█░]{10}/)?.[0]
  expect(await meterNow()).toBe('███░░░░░░░')
  await clock.advance(250)
  expect(await meterNow()).toBe('░███░░░░░░')

  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  const paused = await meterNow()
  await clock.advance(2000)
  expect(await meterNow()).toBe(paused)
})

test('the shared slots: a band-slots box beneath fills the corner and body', async ($, on) => {
  standInForEngine(on, 'Build my landing page', ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      key: 'band-slots',
      children: [
        Box({ key: 'corner', children: [Button({ key: 'mods', label: '☰ Mods', onPress: () => {} })] }),
        Box({ key: 'body', children: [Text({ children: 'Mods menu body' })] }),
      ],
    })
  })
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })

  const band = await bandTexts($, 'terminal')
  const corner = band.part('band-corner')
  const body = band.part('band-body')
  expect(corner?.text).toBe('☰ Mods')
  expect(body?.text).toBe('Mods menu body')
  expect(body?.props).toMatchObject({ flexDirection: 'column', alignItems: 'flex-end' })
  expect(corner?.props).toMatchObject({ flexDirection: 'row', flexShrink: 0 })
  // The slots themselves are not drawn a second time under the rows.
  expect(band.all.split('Mods menu body').length).toBe(2)
  expect(band.all.indexOf('Mods menu body') < band.all.indexOf('Step 1 of 2')).toBe(true)
})

test('an empty band beneath is ignored and another visible one is drawn under the rows', async ($, on) => {
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })
  const plain = await bandTexts($, 'terminal')
  expect(plain.all).not.toMatch(/Extra note/)
  expect(plain.part('band-corner')?.text).toBe('')
  expect(plain.part('band-body')?.text).toBe('')
  expect(plain.part('band-beneath')).toBeUndefined()
})

test('another visible band beneath shows under the step rows', async ($, on) => {
  standInForEngine(on, 'Build my landing page', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ children: [Text({ children: 'Extra note from another mod' })] })
  })
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section'] })

  const band = await bandTexts($, 'terminal')
  const lastRow = band.all.indexOf('Build the pricing section')
  expect(lastRow >= 0 && band.all.indexOf('Extra note from another mod') > lastRow).toBe(true)
  expect(band.part('band-corner')?.text).toBe('')
})

test('hasVisibleContent sees text and Buttons, skips blanks, and leaves the tree alone', () => {
  const frozen = <T extends object>(tree: T): T => Object.freeze(tree)
  const blank = frozen({ type: 'Box' as const, children: frozen([' ', frozen({ type: 'Text' as const, children: frozen(['  ']) })]) })
  const withText = frozen({ type: 'Box' as const, children: frozen([frozen({ type: 'Text' as const, children: frozen(['hi']) })]) })
  const withButton = frozen({
    type: 'Box' as const,
    children: frozen([frozen({ type: 'Button' as const, props: { key: 'go', label: 'Go' }, press: { plugin: 'x', handle: 1 } })]),
  })

  expect(hasVisibleContent(blank as RenderElement)).toBe(false)
  expect(hasVisibleContent({ type: 'Box' })).toBe(false)
  expect(hasVisibleContent(withText as RenderElement)).toBe(true)
  expect(hasVisibleContent(withButton as RenderElement)).toBe(true)
  expect(hasVisibleContent('plain words')).toBe(true)
  expect(hasVisibleContent(undefined)).toBe(false)
})

// Starts a helper the way Claude does and links its agent id the way the engine's spawn does.
async function startHelper($: Engine, description: string): Promise<{ toolUseId: string; agentId: string }> {
  const before = new Set((await bandTexts($, 'terminal')).helperRows.map(row => row.key))
  await $.tool.call({ tool: 'Agent', description, prompt: `Do: ${description}` })
  const added = (await bandTexts($, 'terminal')).helperRows.find(row => !before.has(row.key))
  const toolUseId = String(added?.key).replace('helper-', '')
  const agentId = `agent-${toolUseId}`
  await $.agent.spawn({
    tool_use_id: toolUseId,
    prompt: description,
    description,
    subagentType: 'general-purpose',
    provider: { kind: 'model', model: 'claude-opus-5-5' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as never)
  return { toolUseId, agentId }
}

// The engine's side of helpers: Agent calls come back at once and spawns answer an agent id.
function standInForHelpers(on: On) {
  mock.env(on, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '20' })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched' } as never }))
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: `agent-${e.tool_use_id}` }) as never)
}

async function helperReport($: Engine, agentId: string, task: string, percent: number) {
  return $.tool.call({ tool: REPORT_TOOL, task, percent, agentId } as never)
}

async function helperTurn($: Engine, agentId: string, turnId: string, reason: 'answer' | 'error' = 'answer') {
  await $.turn.start({ text: 'task', turnId, agentId })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId, reason, agentId } as never)
}

test('an Agent call adds a working row under the active step, and the spawn links its agent id', async ($, on) => {
  standInForEngine(on)
  standInForHelpers(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })

  const { agentId } = await startHelper($, 'Check bakery prices')
  const band = await bandTexts($, 'terminal')
  expect(band.helperRows.length).toBe(1)
  const helperRow = band.helperRows[0]?.text ?? ''
  expect(helperRow).toMatch(/^ +└ Check bakery prices +[█░]{10} +Working$/)
  // Under the active step 1, above step 2.
  expect(band.all.indexOf('Read notes') < band.all.indexOf('Check bakery prices')).toBe(true)
  expect(band.all.indexOf('Check bakery prices') < band.all.indexOf('Build page')).toBe(true)

  // The link is real: the helper's own report lands on its row.
  const reported = await helperReport($, agentId, 'Check bakery prices', 60)
  expect(reported.result).toBe('Progress noted: 60%.')
  expect((await bandTexts($, 'terminal')).helperRows[0]?.text).toMatch(/60%$/)
})

test('a helper report goes through the dock first and on to Clean View, and plan_steps from a helper is skipped', async ($, on) => {
  standInForEngine(on)
  standInForHelpers(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })
  const { agentId } = await startHelper($, 'Check bakery prices')

  const reported = await helperReport($, agentId, 'Check bakery prices', 40)
  expect(reported.result).toBe('Progress noted: 40%.')
  expect((await bandTexts($, 'terminal')).helperRows[0]?.text).toMatch(/40%$/)
  // A nested agent that has no row gets the same answer and changes nothing.
  expect((await helperReport($, 'agent-unknown', 'Something', 70)).result).toBe('Progress noted: 70%.')
  expect((await bandTexts($, 'terminal')).helperRows.length).toBe(1)
  const planned = await $.tool.call({ tool: PLAN_TOOL, steps: ['A', 'B'], agentId } as never)
  expect(String(planned.result)).toBeTruthy()
  expect((await bandTexts($, 'terminal')).rowTexts.length).toBe(2)
})

test("a helper's turn ending marks it done, a failed one stuck, and a new turn revives it", async ($, on) => {
  standInForEngine(on)
  standInForHelpers(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })
  const first = await startHelper($, 'Check bakery prices')
  const second = await startHelper($, 'Compare the chains')

  await helperTurn($, first.agentId, 'h1')
  await helperTurn($, second.agentId, 'h2', 'error')
  let band = await bandTexts($, 'terminal')
  expect(band.helperRows.find(row => row.text.includes('Check bakery prices'))?.text).toMatch(/Done$/)
  expect(band.helperRows.find(row => row.text.includes('Compare the chains'))?.text).toMatch(/Stuck$/)

  await $.turn.start({ text: 'one more thing', turnId: 'h3', agentId: first.agentId })
  band = await bandTexts($, 'terminal')
  expect(band.helperRows.find(row => row.text.includes('Check bakery prices'))?.text).toMatch(/Working$/)
})

test('a main turn that ends while helpers work keeps the job going until the last helper ends', async ($, on) => {
  const clock = standInForEngine(on)
  standInForHelpers(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })
  const first = await startHelper($, 'Check bakery prices')
  const second = await startHelper($, 'Compare the chains')
  await $.tool.call({ tool: REPORT_TOOL, task: 'Read notes', percent: 100 })
  await $.tool.call({ tool: REPORT_TOOL, task: 'Build page', percent: 100 })

  await $.turn.complete({ answer: 'Started helpers.', durationMs: 1000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  await clock.advance(6000)
  let band = await bandTexts($, 'terminal')
  expect(band.all).toMatch(/Waiting for 2 helpers/)
  expect(band.all).not.toMatch(/All done/)
  expect(band.all).toMatch(/Read notes/)

  await helperTurn($, first.agentId, 'h1')
  band = await bandTexts($, 'terminal')
  expect(band.all).toMatch(/Waiting for 1 helper(?!s)/)

  await helperTurn($, second.agentId, 'h2')
  band = await bandTexts($, 'terminal')
  expect(band.all).toMatch(/✓ All done/)
  // The finished job shows no helper rows, and shrinks to one line after 5 seconds.
  expect(band.helperRows.length).toBe(0)
  await clock.advance(5000)
  expect((await bandTexts($, 'terminal')).all).not.toMatch(/Read notes/)
})

test('a meta turn carries on the current job; only a typed prompt starts a new one', async ($, on) => {
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })

  await $.prompt.submit({ text: '<task-notification>helper finished</task-notification>', isMeta: true, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: '<task-notification>helper finished</task-notification>', turnId: 'turn-2' })
  let band = await bandTexts($, 'terminal')
  expect(band.all).toMatch(/Read notes/)
  expect(band.all).not.toMatch(/Understand your request/)

  // An engine-made turn with no submit at all carries on too.
  await $.turn.start({ text: 'A helper reported back.', turnId: 'turn-3' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Read notes/)

  // So does another session's message, which is not marked meta.
  await $.prompt.submit({ text: 'Another Claude session sent a message: done', wait: false, origin: { kind: 'peer' } })
  await $.turn.start({ text: 'Another Claude session sent a message: done', turnId: 'turn-3b' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Read notes/)

  // A plugin sending the person's own words (Prompt Upgrade's Run) starts a new job.
  await $.prompt.submit({ text: 'Plan a picnic for six people', wait: false, origin: { kind: 'plugin', name: 'prompt-upgrade', asUser: true } })
  await $.turn.start({ text: 'Plan a picnic for six people', turnId: 'turn-3c' })
  band = await bandTexts($, 'terminal')
  expect(band.all).toMatch(/Understand your request/)
  expect(band.all).not.toMatch(/Read notes/)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })

  await typePrompt($, 'Now make it blue please', 'turn-4')
  band = await bandTexts($, 'terminal')
  expect(band.all).toMatch(/Understand your request/)
  expect(band.all).not.toMatch(/Read notes/)
})

test("helpers' progress fills their step's meter until the step reports its own", async ($, on) => {
  standInForEngine(on)
  standInForHelpers(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })
  const first = await startHelper($, 'Check bakery prices')
  await startHelper($, 'Compare the chains')

  // No report yet: the sweep and "Working".
  let band = await bandTexts($, 'terminal')
  expect(rowText(band.rowTexts, 'Read notes')).toMatch(/▶.*███░░░░░░░ +Working$/)

  await helperReport($, first.agentId, 'Check bakery prices', 50)
  band = await bandTexts($, 'terminal')
  // 50 and an unreported 0 average to 25%, which fills 3 of the 10 cells.
  expect(rowText(band.rowTexts, 'Read notes')).toMatch(/███░░░░░░░ +25%$/)
  expect(stepPercent({ id: 'a', name: 'A', status: 'active', percent: 0, hasReported: false }, [])).toEqual({
    percent: 0,
    hasProgress: false,
  })
})

test('at most five helper rows show per step, then one line counts the rest', async ($, on) => {
  standInForEngine(on)
  standInForHelpers(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })
  const helpers = []
  for (let count = 1; count <= 7; count += 1) helpers.push(await startHelper($, `Check shop number ${count}`))
  await helperTurn($, helpers[0]!.agentId, 'h1')

  const band = await bandTexts($, 'terminal')
  expect(band.helperRows.length).toBe(5)
  expect(band.moreText?.trim()).toBe('└ +2 more helpers · 1 done')
  // The five shown still working come first; the done one folded away.
  expect(band.helperRows.every(row => !/Done$/.test(row.text))).toBe(true)
})

test('after a reload, rows settle from the engine list and old saved state counts as no helpers', () => {
  const base = startChecklist(0, 1000)
  const makeRow = (id: string, agentId: string) => ({
    id, agentId, name: id, stepId: null, status: 'working' as const, percent: 0, hasReported: false, startedAt: 1000, finishedAt: null,
  })
  const withRows = { ...base, helpers: [makeRow('a', 'ag-a'), makeRow('b', 'ag-b'), makeRow('c', 'ag-c'), makeRow('d', 'ag-d')] }
  const settled = settleHelpers(
    withRows,
    [{ id: 'ag-a', status: 'completed' }, { id: 'ag-b', status: 'failed' }, { id: 'ag-c', status: 'running' }],
    2000,
  )
  expect(settled.helpers.map(helper => helper.status)).toEqual(['done', 'stuck', 'working', 'working'])
  expect(settled.helpers[0]?.percent).toBe(100)

  const oldState = { ...base } as Partial<typeof base>
  delete oldState.helpers
  expect(settleHelpers(oldState as typeof base, [], 2000)).toBe(oldState)
})

test('a prompt another mod held back does not make the next engine turn a new job', async ($, on) => {
  // A mod beneath drops one typed prompt (Prompt Upgrade taking it to its pane), ahead of the engine's answer.
  on('prompt.submit', { text: /^Make it better/ }, () => ({ drop: 'Prompt Upgrade is reading your prompt.' }))
  standInForEngine(on)
  await startJob($)
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Read notes', 'Build page'] })

  const heldBack = await $.prompt.submit({ text: 'Make it better please', wait: false, origin: { kind: 'composer' } })
  expect(heldBack.drop).toBeDefined()

  // The next turn is a helper's report: it carries on the job instead of starting one.
  await $.turn.start({ text: 'A helper reported back.', turnId: 'turn-2' })
  expect((await bandTexts($, 'terminal')).all).toMatch(/Read notes/)
})
