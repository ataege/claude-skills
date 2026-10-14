// Model routing's behaviour, run with `claude plugin test <mod folder>`.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import { routingGuide, tierOf, workflowLacksModels } from '../hooks/model-routing'

type Seen = { model?: string; effort?: string; subagent_type?: string }

// Answers what the mod asks of the engine; records the Agent calls that got through.
function standInForEngine(on: On, sessionModel = 'claude-opus-5-5') {
  const agentCalls: Seen[] = []
  const workflowCalls: string[] = []
  let spawnCount = 0
  on('session.model', () => ({ value: sessionModel }))
  on('tool.call', { tool: 'Agent' }, ($, e) => {
    agentCalls.push({ model: e.model, effort: e.effort, subagent_type: e.subagent_type })
    return { result: { agentId: `agent-${agentCalls.length}` } as never }
  })
  on('tool.call', { tool: 'Workflow' }, ($, e) => {
    workflowCalls.push(String(e.script))
    return { result: 'started' as never }
  })
  on('agent.spawn', ($, e) => {
    spawnCount += 1
    const model = e.fork || e.model === undefined ? (e.subagentType === 'Explore' ? 'claude-haiku-5-5' : e.parentModel) : e.model
    return { model, agentId: `spawned-${spawnCount}` }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  return { agentCalls, workflowCalls }
}

const BASE_CALL = { tool: 'Agent' as const, description: 'Rename files', prompt: 'Rename the files.' }

// A spawn as the engine raises it, with the parts a test varies.
function spawnInput(overrides: Partial<AgentSpawnInput>): AgentSpawnInput {
  return {
    tool_use_id: 'call-1',
    prompt: 'Do the task.',
    description: 'Task',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...overrides,
  }
}

async function spawn($: Engine, overrides: Partial<AgentSpawnInput>) {
  return $.agent.spawn(spawnInput(overrides))
}

test('an agent with no model is refused with the routing table as the fix', async ($, on) => {
  const { agentCalls } = standInForEngine(on)

  const refused = await $.tool.call({ ...BASE_CALL })
  expect(refused.deny).toMatch(/set `model` and `effort`/)
  expect(refused.deny).toMatch(/session's own model \(opus\)/)
  expect(refused.deny).toMatch(/haiku, effort low/)
  expect(refused.deny).toMatch(/sonnet, effort medium/)
  expect(agentCalls).toHaveLength(0)

  const explicitGeneral = await $.tool.call({ ...BASE_CALL, subagent_type: 'general-purpose', effort: 'low' })
  expect(explicitGeneral.deny).toMatch(/set `model`/)
})

test('a missing effort is filled from the tier, and the session tier inherits', async ($, on) => {
  const { agentCalls } = standInForEngine(on)

  await $.tool.call({ ...BASE_CALL, model: 'haiku' })
  await $.tool.call({ ...BASE_CALL, model: 'sonnet' })
  await $.tool.call({ ...BASE_CALL, model: 'opus' })
  await $.tool.call({ ...BASE_CALL, model: 'haiku', effort: 'medium' })

  expect(agentCalls).toEqual([
    { model: 'haiku', effort: 'low', subagent_type: undefined },
    { model: 'sonnet', effort: 'medium', subagent_type: undefined },
    // Opus is this session's model: the final-synthesis case keeps the session's effort.
    { model: 'opus', effort: undefined, subagent_type: undefined },
    // An effort Claude chose is kept.
    { model: 'haiku', effort: 'medium', subagent_type: undefined },
  ])
})

test('nothing runs above the session model', async ($, on) => {
  const { agentCalls } = standInForEngine(on, 'claude-sonnet-5-5')

  const refused = await $.tool.call({ ...BASE_CALL, model: 'opus', effort: 'high' })
  expect(refused.deny).toMatch(/this session runs on sonnet/)
  expect(refused.deny).toMatch(/\/model/)

  await $.tool.call({ ...BASE_CALL, model: 'sonnet', effort: 'high' })
  expect(agentCalls).toEqual([{ model: 'sonnet', effort: 'high', subagent_type: undefined }])
})

test('forks pass untouched, and typed agents get an effort once their tier is known', async ($, on) => {
  const { agentCalls } = standInForEngine(on)

  await $.tool.call({ ...BASE_CALL, subagent_type: 'fork' })
  // Explore may pin its own model: the first call passes as it is.
  await $.tool.call({ ...BASE_CALL, subagent_type: 'Explore' })
  // Its spawn shows Explore runs on haiku when no model is named.
  await spawn($, { subagentType: 'Explore' })
  await $.tool.call({ ...BASE_CALL, subagent_type: 'Explore' })

  expect(agentCalls).toEqual([
    { model: undefined, effort: undefined, subagent_type: 'fork' },
    { model: undefined, effort: undefined, subagent_type: 'Explore' },
    { model: undefined, effort: 'low', subagent_type: 'Explore' },
  ])
})

test('haiku agents never spawn, and nesting stops at two levels', async ($, on) => {
  standInForEngine(on)

  const haikuAgent = await spawn($, { model: 'haiku' })
  const fromHaiku = await spawn($, { parentAgentId: haikuAgent.agentId })
  expect(fromHaiku.deny).toMatch(/haiku agents do not spawn agents/)

  const sonnetAgent = await spawn($, { model: 'sonnet' })
  const secondLevel = await spawn($, { model: 'sonnet', parentAgentId: sonnetAgent.agentId })
  expect(secondLevel.deny).toBeUndefined()

  const thirdLevel = await spawn($, { model: 'haiku', parentAgentId: secondLevel.agentId })
  expect(thirdLevel.deny).toMatch(/at most two levels/)

  // Resuming an agent is no new spawn.
  const resumed = await spawn($, { parentAgentId: secondLevel.agentId, resume: { agentId: 'old-agent' } })
  expect(resumed.deny).toBeUndefined()
})

test('a workflow that names no model for any agent is refused', async ($, on) => {
  const { workflowCalls } = standInForEngine(on)
  const unrouted = "export const meta = { name: 'scan' }\nawait agent('List exports', { phase: 'Scan' })"
  const routed = "export const meta = { name: 'scan' }\nawait agent('List exports', { model: 'haiku', effort: 'low' })"

  const refused = await $.tool.call({ tool: 'Workflow', script: unrouted })
  expect(refused.deny).toMatch(/none of this script's agent\(\) calls set `model`/)

  const allowed = await $.tool.call({ tool: 'Workflow', script: routed })
  expect(allowed.deny).toBeUndefined()
  expect(workflowCalls).toEqual([routed])
})

test('the routing guide joins Claude instructions only when agent tools are there', async ($, on) => {
  standInForEngine(on)
  const request = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], outputStyle: null, traits: [] }

  const withAgents = await $.prompt.compose({ ...request, tools: ['Read', 'Agent'] })
  const guide = withAgents.sections.find(section => section.id === 'model-routing:guide')
  expect(guide?.scope).toBe('session')
  expect(guide?.text).toMatch(/This session runs on opus/)

  const withoutAgents = await $.prompt.compose({ ...request, tools: ['Read', 'Edit'] })
  expect(withoutAgents.sections.some(section => section.id === 'model-routing:guide')).toBe(false)
})

test('helpers read tiers and scripts plainly', () => {
  expect(tierOf('claude-haiku-5-5')).toBe('haiku')
  expect(tierOf('opus')).toBe('opus')
  expect(tierOf('gpt-x')).toBeNull()
  expect(workflowLacksModels("await agent('x')")).toBe(true)
  expect(workflowLacksModels("await agent('x', { model: 'sonnet' })")).toBe(false)
  expect(workflowLacksModels('no agents here')).toBe(false)
  expect(routingGuide('sonnet')).toMatch(/This session runs on sonnet/)
})
