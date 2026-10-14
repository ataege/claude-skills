// The status bar's behaviour, run with `claude plugin test <mod folder>`.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'
import type { AgentInfo, On, RenderPropsOf, SessionRateLimit } from 'claude-code'

import { contextMeter, effortIcon, formatModel, groupRoutes, planLabel, routeLabel } from '../hooks/status-bar'

const PLUGIN = 'status-bar'
const SURFACES = ['terminal', 'desktop'] as const
const AUTO_MODE_HINT = '⏵⏵ auto mode on (shift+tab to cycle)'

// The hint line's props as the engine hands them over.
const HINT_PROPS: RenderPropsOf['PromptHint'] = { isDraft: false, isWorking: false, hint: AUTO_MODE_HINT }

type World = {
  agents: AgentInfo[]
  rateLimits: SessionRateLimit[]
  contextPercent: number
  modelId: string
  effortLevel: string
}

// Answers everything the mod asks of the engine, from a world the test can change.
function standInForEngine(on: On): World {
  const world: World = {
    agents: [
      { id: 'a1', description: 'Research', type: 'general-purpose', status: 'running' },
      { id: 'a2', description: 'Review', type: 'general-purpose', status: 'waiting' },
      { id: 'a3', description: 'Old task', type: 'general-purpose', status: 'completed' },
    ],
    rateLimits: [
      { kind: 'five_hour', percentUsed: 12 },
      { kind: 'seven_day', percentUsed: 36 },
    ],
    contextPercent: 30,
    modelId: 'claude-opus-5-5',
    effortLevel: 'high',
  }
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/tester' })
  on('fs.read', () => ({
    value: JSON.stringify({
      oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
    }),
  }))
  on('session.model', () => ({ value: world.modelId }))
  on('settings.read', () => ({ value: { effortLevel: world.effortLevel } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: world.contextPercent * 2000, percent: world.contextPercent },
      rateLimits: world.rateLimits,
    },
  }))
  on('agent.list', () => ({ value: world.agents }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('classic.StopFailure', () => ({}))
  on('command.run', () => ({ text: '' }))
  // The engine's own hint line, so the test can see the bar sits above it.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: e.props.hint })
  })
  return world
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

// The bar's outer Text and every inner piece, as one surface draws them.
async function drawBar($: Engine, surface: (typeof SURFACES)[number]) {
  const drawing = await $.ui.mount({ plugin: PLUGIN, surface, component: 'PromptHint', props: HINT_PROPS })
  const texts = await drawing.findAll({ type: 'Text' })
  await drawing.unmount()
  const line = texts.reduce<FoundElement | undefined>(
    (longest, found) => (found.text.includes(' │ ') && found.text.length > (longest?.text.length ?? 0) ? found : longest),
    undefined,
  )
  const pieceColor = (text: string | RegExp) =>
    texts.find(found => (typeof text === 'string' ? found.text === text : text.test(found.text)) && found !== line)?.props
      .color
  return { texts, line: line?.text ?? '', pieceColor }
}

test('the line reads ◆ plan │ ✻ model │ ◕ effort │ ▣ ctx │ ◷ 7d 5h │ ◎ agents, above the auto mode text', async ($, on) => {
  standInForEngine(on)
  await startSession($)

  for (const surface of SURFACES) {
    const { texts, line } = await drawBar($, surface)
    expect(line).toBe('◆ Max 20x │ ✻ Opus 5.5 │ ◕ effort high │ ▣ ctx ▰▰▰▱▱▱▱▱▱▱ 30% │ ◷ 7d 64% │ 5h 88% │ ◎ 2 agents')
    const lineIndex = texts.findIndex(found => found.text === line)
    const hintIndex = texts.findIndex(found => found.text === AUTO_MODE_HINT)
    expect(lineIndex >= 0 && hintIndex > lineIndex).toBe(true)
  }
})

test('colors follow the figures: green, then amber and red as limits near', async ($, on) => {
  standInForEngine(on)
  await startSession($)

  const healthy = await drawBar($, 'terminal')
  expect(healthy.pieceColor('Max 20x')).toBe('success')
  expect(healthy.pieceColor('▰▰▰')).toBe('success')
  expect(healthy.pieceColor('64%')).toBe('success')
  expect(healthy.pieceColor('88%')).toBe('success')
  expect(healthy.line).not.toMatch(/left/)
  expect(healthy.pieceColor('◆ ')).toBe('success')
  expect(healthy.pieceColor('◷ ')).toBe('success')

  // The engine reports a fuller context and a busier week.
  await $.session.measure({
    context: { window: 200_000, tokens: 170_000, percent: 85 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85 },
      { kind: 'seven_day', percentUsed: 82 },
    ],
    changed: ['context', 'rateLimits'],
  })
  const busy = await drawBar($, 'terminal')
  expect(busy.line).toMatch(/ctx ▰▰▰▰▰▰▰▰▰▱ 85%/)
  expect(busy.pieceColor('▰▰▰▰▰▰▰▰▰')).toBe('error')
  expect(busy.pieceColor('Max 20x')).toBe('warning')
  expect(busy.line).toMatch(/◷ 7d 18% │ 5h 15% │/)
  expect(busy.pieceColor('18%')).toBe('error')
  expect(busy.pieceColor('15%')).toBe('error')
  expect(busy.pieceColor('◷ ')).toBe('error')
  expect(busy.pieceColor('◆ ')).toBe('warning')
  expect(busy.pieceColor('▣ ')).toBe('error')

  // A usage-limit error turns the plan red.
  await $.classic.StopFailure({ error: 'rate_limit', error_details: '429' })
  expect((await drawBar($, 'terminal')).pieceColor('Max 20x')).toBe('error')
})

test('the agent count drops when a subagent finishes', async ($, on) => {
  const world = standInForEngine(on)
  await startSession($)
  expect((await drawBar($, 'terminal')).line).toMatch(/◎ 2 agents$/)

  world.agents = world.agents.map(agent => (agent.id === 'a1' ? { ...agent, status: 'completed' } : agent))
  await $.turn.complete({ answer: 'Found it', durationMs: 900, isAborted: false, turnId: 't-a1', reason: 'answer', agentId: 'a1' })
  expect((await drawBar($, 'terminal')).line).toMatch(/◎ 1 agent$/)
})

test('a command like /model refreshes the model and effort', async ($, on) => {
  const world = standInForEngine(on)
  await startSession($)
  expect((await drawBar($, 'terminal')).line).toMatch(/^◆ Max 20x │ ✻ Opus 5\.5 │ ◕ effort high │/)

  world.modelId = 'claude-fable-5-1'
  world.effortLevel = 'max'
  await $.command.run({
    command: 'model',
    args: 'fable',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect((await drawBar($, 'terminal')).line).toMatch(/^◆ Max 20x │ ✻ Fable 5\.1 │ ◉ effort max │/)
})

test('names, plans and meters read plainly', () => {
  expect(formatModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(formatModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(formatModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(formatModel('claude-opus-4-6[1m]')).toBe('Opus 4.6 1M')
  expect(formatModel('opus')).toBe('Opus')

  expect(planLabel({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' })).toBe('Max 5x')
  expect(planLabel({ organizationType: 'claude_pro' })).toBe('Pro')
  expect(planLabel(undefined)).toBe('API')

  expect(['low', 'medium', 'high', 'xhigh', 'max'].map(effortIcon).join('')).toBe('◔◑◕●◉')
  expect(effortIcon(null)).toBe('◑')
  expect(effortIcon('31999')).toBe('◑')

  expect(contextMeter(0)).toEqual({ filled: '', empty: '▱▱▱▱▱▱▱▱▱▱' })
  expect(contextMeter(100)).toEqual({ filled: '▰▰▰▰▰▰▰▰▰▰', empty: '' })
})

// One model request inside an agent, as the engine streams it.
async function agentRequest($: Engine, agentId: string, model: string, effort?: 'low' | 'medium' | 'high') {
  for await (const _chunk of $.turn.step({ turnId: `t-${agentId}`, index: 0, model, effort, messageCount: 1, agentId })) {
    // Drain the stream.
  }
}

test('running agents show their real model and effort, grouped', async ($, on) => {
  const world = standInForEngine(on)
  world.agents = [
    { id: 'a1', description: 'Rename', type: 'general-purpose', status: 'running' },
    { id: 'a2', description: 'Rename', type: 'general-purpose', status: 'running' },
    { id: 'a3', description: 'Rename', type: 'general-purpose', status: 'running' },
    { id: 'a4', description: 'Verify', type: 'general-purpose', status: 'waiting' },
    { id: 'a5', description: 'Done', type: 'general-purpose', status: 'completed' },
  ]
  await startSession($)
  // Before any agent has made a request, the plain count shows.
  expect((await drawBar($, 'terminal')).line).toMatch(/◎ 4 agents$/)

  await agentRequest($, 'a1', 'claude-haiku-5-5', 'low')
  await agentRequest($, 'a2', 'claude-haiku-5-5', 'low')
  await agentRequest($, 'a3', 'claude-haiku-5-5', 'low')
  await agentRequest($, 'a4', 'claude-opus-5-5', 'high')
  await agentRequest($, 'a5', 'claude-sonnet-5-5', 'medium')

  for (const surface of SURFACES) {
    const { line, pieceColor } = await drawBar($, surface)
    expect(line).toMatch(/◎ 3 haiku\/low · 1 opus\/high$/)
    expect(pieceColor('3 haiku/low')).toBe('claude')
  }
})

test('routes read plainly and group most first', () => {
  expect(routeLabel('claude-haiku-5-5', 'low')).toBe('haiku/low')
  expect(routeLabel('claude-opus-5-5', undefined)).toBe('opus')
  expect(groupRoutes(['a', 'b', 'c'], { a: 'opus/high', b: 'haiku/low', c: 'haiku/low' })).toEqual([
    { label: 'haiku/low', count: 2 },
    { label: 'opus/high', count: 1 },
  ])
  expect(groupRoutes(['a', 'z'], { a: 'sonnet/medium' })).toEqual([
    { label: 'agent', count: 1 },
    { label: 'sonnet/medium', count: 1 },
  ])
})

test("Prompt Upgrade's automatic mode shows as ◇ Better Prompt On at the end, only while it is on", async ($, on) => {
  // Prompt Upgrade's published value, which the test flips; read through the engine as the bar reads it.
  let isAutoOn = false
  on('state.get', { plugin: 'prompt-upgrade' }, () => ({ value: { value: isAutoOn, version: isAutoOn ? 2 : 1 } }))
  standInForEngine(on)
  await startSession($)

  const off = await drawBar($, 'terminal')
  expect(off.line).toBe('◆ Max 20x │ ✻ Opus 5.5 │ ◕ effort high │ ▣ ctx ▰▰▰▱▱▱▱▱▱▱ 30% │ ◷ 7d 64% │ 5h 88% │ ◎ 2 agents')

  isAutoOn = true
  for (const surface of SURFACES) {
    const withAuto = await drawBar($, surface)
    expect(withAuto.line).toBe(
      '◆ Max 20x │ ✻ Opus 5.5 │ ◕ effort high │ ▣ ctx ▰▰▰▱▱▱▱▱▱▱ 30% │ ◷ 7d 64% │ 5h 88% │ ◎ 2 agents │ ◇ Better Prompt On',
    )
    expect(withAuto.pieceColor('◇ Better Prompt On')).toBe('#F2C46D')
  }
})
