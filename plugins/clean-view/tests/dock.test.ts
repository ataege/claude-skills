// Agent Dock's behaviour, run with `claude plugin test <plugin folder>`.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptSubmitInput, RenderPropsOf, ToolCallResult, UiPane } from 'claude-code'

import { jobName, parseSize, restoreSize, summaryLine, taskName } from '../hooks/dock-logic'

const PLUGIN = 'clean-view'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'
const PANE_ID = 'agent-dock'
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }

// The pane's props as the engine hands them over.
function paneProps(bodyColumns = 96): RenderPropsOf['Pane'] {
  return {
    title: 'Agent Dock',
    isFocused: false,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  }
}

type World = {
  openPanes: UiPane[]
  statusLines: (string | undefined)[]
  submitted: PromptSubmitInput[]
  agentAnswers: Map<string, () => void>
  agentCallCount: number
  agentCalls: { description: string; model?: string; effort?: string }[]
}

// Stands in for the engine beneath the plugin, recording what the dock asks of it.
function standInForEngine(on: On, store: Record<string, unknown> = {}, holdAgents = false) {
  const world: World = { openPanes: [], statusLines: [], submitted: [], agentAnswers: new Map(), agentCallCount: 0, agentCalls: [] }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  mock.env(on, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '20' })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    world.statusLines.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    if (!world.openPanes.some(pane => pane.id === e.id)) {
      world.openPanes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    }
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    world.openPanes = world.openPanes.filter(pane => pane.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.openPanes }))
  on('fs.list', () => ({ value: [] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    world.submitted.push(e)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: e.props.hint })
  })
  on('tool.call', { tool: 'Agent' }, ($, e) => {
    world.agentCallCount += 1
    world.agentCalls.push({ description: String(e.description), model: e.model, effort: e.effort })
    if (!holdAgents) return { result: { agentId: `agent-${world.agentCallCount}` } as never }
    // Held until the test lets this helper finish.
    return new Promise<ToolCallResult>(resolve => {
      world.agentAnswers.set(String(e.description), () => resolve({ result: { agentId: 'done' } as never }))
    })
  })
  return { world, clock }
}

// A session with Clean View's plan in place, so its plan-first rule lets Agent calls through.
async function startSession($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Split the work', 'Combine the results'] })
}

async function typeCommand($: Engine, args: string) {
  return $.command.run({ command: 'dock', args, ...TYPED })
}

async function sendRequest($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

// One helper call as Claude writes it; on Auto, Claude names the model. 'none' leaves the model out.
async function agentCall($: Engine, description: string, model: 'haiku' | 'sonnet' | 'opus' | 'none' = 'haiku') {
  return $.tool.call({ tool: 'Agent', description, prompt: `Do: ${description}`, ...(model === 'none' ? {} : { model }) })
}

// Every text the dock pane draws.
async function dockTexts($: Engine, bodyColumns = 96) {
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps(bodyColumns) })
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  await pane.unmount()
  return { texts, all: texts.join('\n') }
}

test('1. parseSize takes whole numbers from 1 to 100 only', () => {
  expect(parseSize('10')).toBe(10)
  expect(parseSize(' 25 ')).toBe(25)
  for (const bad of ['0', '101', 'abc', '2.5', '', '-3']) expect(parseSize(bad)).toBeNull()
  expect(restoreSize(50)).toBe(1)
  expect(restoreSize(10)).toBe(10)
  expect(jobName('Please research bakery pricing in Brooklyn, then compare chains')).toBe('Research bakery pricing in Brooklyn')
  expect(taskName('price check: Panera bread cafe locations nationwide')).toBe('Price check: Panera bread cafe')
})

test('2. a saved size of 50 comes back as 1 in a new session; 10 stays 10', async ($, on) => {
  standInForEngine(on, { 'dock.teamSize': 50 })
  await startSession($)
  expect((await dockTexts($)).all).toMatch(/Claude decides how many helpers/)
})

test('2b. a saved size of 10 stays 10', async ($, on) => {
  standInForEngine(on, { 'dock.teamSize': 10 })
  await startSession($)
  expect((await dockTexts($)).all).toMatch(/Splits each request across 10 helpers {2}· {2}20 at a time {2}· {2}Auto per agent/)
})

test('3. at size 5 a request carries the exactly-5 instruction; at size 1 nothing', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)

  await sendRequest($, 'Research bakery pricing')
  expect(world.submitted.at(-1)?.context).toBeUndefined()

  await typeCommand($, '5')
  await clock.settle()
  await sendRequest($, 'Research bakery pricing')
  const instruction = (world.submitted.at(-1)?.context ?? []).join('\n')
  expect(instruction).toMatch(/Split this request into exactly 5 independent pieces/)
  expect(instruction).toMatch(/all 5 in one message/)
  expect(instruction).toMatch(/report_progress/)
  expect(instruction).toMatch(/Pick each helper's model and effort for its own task/)
  expect(instruction).toMatch(/Never above this session's model \(opus\)/)
  expect(instruction).not.toMatch(/On every helper set model "haiku"/)

  // A prompt another mod sends as the person's own words (Prompt Upgrade's Run) gets the same instruction.
  await $.prompt.submit({ text: 'Research bakery pricing in Leeds', wait: false, origin: { kind: 'plugin', name: 'prompt-upgrade', asUser: true } })
  expect((world.submitted.at(-1)?.context ?? []).join('\n')).toMatch(/exactly 5 independent pieces/)
})

test('4. the 6th Agent call at size 5 is refused with the Team Size message', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await typeCommand($, '5')
  await clock.settle()
  await sendRequest($, 'Price check five bakeries')

  for (let helper = 1; helper <= 5; helper += 1) {
    const ran = await agentCall($, `Price check: bakery ${helper}`)
    expect(ran.deny).toBeUndefined()
  }
  const sixth = await agentCall($, 'Price check: bakery 6')
  expect(sixth.deny).toBe('Team Size is 5: this request already has 5 helpers. Finish with the helpers you have.')
  expect(world.agentCallCount).toBe(5)
})

test('5. a request that used 3 of 10 gets exactly one nudge', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await typeCommand($, '10')
  await clock.settle()
  await sendRequest($, 'Price check ten bakeries')
  for (const name of ['Panera', 'Crumbl', 'Levain']) await agentCall($, `Price check: ${name}`)

  const ending = { answer: 'Here are three.', durationMs: 1000, isAborted: false, reason: 'answer' as const }
  await $.turn.complete({ ...ending, turnId: 'turn-1' })
  await clock.settle()
  await $.turn.complete({ ...ending, turnId: 'turn-2' })
  await clock.settle()

  const nudges = world.submitted.filter(prompt => prompt.origin.kind === 'plugin')
  expect(nudges).toHaveLength(1)
  expect(nudges[0]?.text).toBe('You used 3 of 10 helpers. Split the remaining work across the other 7, one helper per piece, all in parallel.')
})

test('6 and 7. three helpers go queued, working, done; a report moves its card; the summary line shows', async ($, on) => {
  const { world, clock } = standInForEngine(on, {}, true)
  await startSession($)
  await typeCommand($, '3')
  await clock.settle()
  await sendRequest($, 'Research bakery pricing')

  const names = ['Price check: Panera', 'Price check: Crumbl', 'Price check: Levain']
  await $.session.append({
    door: 'response',
    message: {
      type: 'assistant',
      role: 'assistant',
      content: names.map((name, index) => ({ type: 'tool_use', id: `toolu_${index + 1}`, name: 'Agent', input: { description: name, prompt: name } })),
    },
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'response-1',
  })
  const queued = await dockTexts($)
  expect(queued.texts.filter(text => text.includes('queued')).length >= 3).toBe(true)
  expect(queued.all).toMatch(/○ 3 queued/)

  // All three start; they are held until released.
  const running = names.map(name => agentCall($, name))
  await clock.settle()
  const working = await dockTexts($)
  expect(working.all).toMatch(/● 3 working/)
  expect(working.all).toMatch(/○ 0 queued/)

  // A helper's own report moves its card.
  const reported = await $.tool.call({ tool: REPORT_TOOL, task: 'Price check: Panera', percent: 60, agentId: 'agent-panera' } as never)
  expect(reported.result).toBe('Progress noted: 60%.')
  const moved = await dockTexts($)
  expect(moved.texts.some(text => text.includes('60%'))).toBe(true)

  await clock.advance(134_000)
  for (const name of names) world.agentAnswers.get(name)?.()
  await Promise.all(running)
  const done = await dockTexts($)
  expect(done.all).toMatch(/✓ 3 done/)
  expect(done.all).toMatch(/3 agents finished Research bakery pricing in 2m 14s/)
  expect(done.all).toMatch(/C O M P L E T E/)
})

test('8. /dock folds to the badge and back', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)

  const opened = await typeCommand($, '')
  expect(opened.text).toMatch(/Agent Dock toggled/)
  await clock.settle()
  expect(world.openPanes.map(pane => pane.id)).toEqual([PANE_ID])

  await typeCommand($, '')
  await clock.settle()
  expect(world.openPanes).toHaveLength(0)
  expect(world.statusLines.at(-1)).toMatch(/Agent Dock · team of 1 standing by/)

  await typeCommand($, '')
  await clock.settle()
  expect(world.openPanes.map(pane => pane.id)).toEqual([PANE_ID])
  expect(world.statusLines.at(-1)).toBeUndefined()
})

test('a big team waits for Continue, and bad sizes get a plain answer', async ($, on) => {
  const { clock } = standInForEngine(on)
  await startSession($)

  expect((await typeCommand($, 'abc')).text).toBe('Team Size is a whole number from 1 to 100, e.g. /dock 10.')
  expect((await typeCommand($, '50')).text).toBe('Confirm the team of 50 in the Agent Dock.')
  await clock.settle()

  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
  expect((await pane.find({ type: 'Text', text: /Big team: this uses your plan quickly/ })) !== undefined).toBe(true)
  await pane.press({ key: 'big-team-continue' })
  expect((await pane.find({ type: 'Text', text: /Splits each request across 50 helpers/ })) !== undefined).toBe(true)
  await pane.unmount()
})

test('more than 12 helpers draw as tiles; the summary counts stuck helpers', async ($, on) => {
  const { clock } = standInForEngine(on)
  await startSession($)
  await typeCommand($, '20')
  await clock.settle()
  await sendRequest($, 'Survey twenty shops')
  for (let helper = 1; helper <= 14; helper += 1) await agentCall($, `Survey shop ${helper}`)
  const { all } = await dockTexts($, 120)
  expect(all).toMatch(/✓ 14 done/)
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps(120) })
  const boxKeys = (await pane.findAll({ type: 'Box' })).map(found => found.key ?? '')
  await pane.unmount()
  expect(boxKeys.filter(key => key.startsWith('tile-'))).toHaveLength(14)
  expect(boxKeys.some(key => key.startsWith('card-'))).toBe(false)
  expect(all).toMatch(/14 agents finished Survey twenty shops in/)

  const mission = {
    id: 1, title: 'Survey shops', teamSize: 3, startedAt: 0, finishedAt: 5000, admittedCalls: 3, hasNudged: false,
    cards: ['done', 'stuck', 'done'].map((status, seat) => ({
      id: `t${seat}`, task: 'Survey', initials: 'SU', seat, status: status as 'done' | 'stuck', percent: 100,
      hasReported: true, agentId: null, queuedAt: 0, startedAt: 0, finishedAt: 5000,
    })),
  }
  expect(summaryLine(mission, 5000)).toBe('3 agents finished Survey shops in 5s (1 got stuck)')
})

test('a ◆ Dock button sits beside the line under the prompt and opens the dock', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  const hint = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
  })
  expect((await hint.find({ type: 'Text', text: /auto mode on/ })) !== undefined).toBe(true)
  expect((await hint.find({ type: 'Button', key: 'open-dock' })) !== undefined).toBe(true)
  await hint.press({ key: 'open-dock' })
  await clock.settle()
  await hint.unmount()
  expect(world.openPanes.map(pane => pane.id)).toEqual([PANE_ID])
})

test('Auto is the default: a helper with no model is sent back, and the tier picks the effort', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await typeCommand($, '5')
  await clock.settle()
  await sendRequest($, 'Compare five bakeries')

  const unnamed = await agentCall($, 'Price check: Panera', 'none')
  expect(unnamed.deny).toMatch(/helper agents are on Auto, so set model and effort on this helper/)
  expect(world.agentCallCount).toBe(0)

  await agentCall($, 'Price check: Panera', 'haiku')
  await agentCall($, 'Compare menu trends', 'sonnet')
  await agentCall($, 'Judge the best value', 'opus')
  expect(world.agentCalls).toEqual([
    { description: 'Price check: Panera', model: 'haiku', effort: 'low' },
    { description: 'Compare menu trends', model: 'sonnet', effort: 'medium' },
    // Opus is the session's own model here, so it keeps the session's effort.
    { description: 'Judge the best value', model: 'opus', effort: undefined },
  ])
  // The refused call did not use up a place on the team.
  for (const name of ['One', 'Two']) expect((await agentCall($, `Price check: ${name}`)).deny).toBeUndefined()
  expect((await agentCall($, 'Price check: Six')).deny).toMatch(/Team Size is 5/)
})

test('Fast & Cheap fills in Haiku when picked, and the pick is saved', async ($, on) => {
  const { world, clock } = standInForEngine(on)
  await startSession($)
  await typeCommand($, '3')
  await clock.settle()

  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
  expect((await pane.find({ type: 'Text', text: / Auto per agent / }))?.props.backgroundColor).toBe('#F0806A')
  await pane.press({ key: 'model-fast' })
  expect((await pane.find({ type: 'Text', text: / Fast & Cheap / }))?.props.backgroundColor).toBe('#F0806A')
  await pane.unmount()

  await sendRequest($, 'Check three prices')
  expect((world.submitted.at(-1)?.context ?? []).join('\n')).toMatch(/On every helper set model "haiku" and effort "low"/)
  await agentCall($, 'Price check: Panera', 'none')
  expect(world.agentCalls.at(-1)).toEqual({ description: 'Price check: Panera', model: 'haiku', effort: 'low' })
})

test('a picked helper model carries over; an old saved default moves to Auto', async ($, on) => {
  standInForEngine(on, { 'panel.helperModel': 'same', 'panel.helperModelChosen': true, 'dock.teamSize': 3 })
  await startSession($)
  expect((await dockTexts($)).all).toMatch(/Splits each request across 3 helpers {2}· {2}20 at a time {2}· {2}Same as you/)
})

test('an old saved Fast & Cheap that was never picked becomes Auto', async ($, on) => {
  standInForEngine(on, { 'panel.helperModel': 'fast', 'dock.teamSize': 3 })
  await startSession($)
  expect((await dockTexts($)).all).toMatch(/· {2}Auto per agent/)
})
