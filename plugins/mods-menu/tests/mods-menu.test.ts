// Mods Menu's behaviour, run with `claude plugin test <mod folder>`.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandInfo, EngineInterface, On, RenderInput, RenderNode, RenderPropsOf } from 'claude-code'

import { appendToKeyed, findKeyed, hasVisibleContent, resolveRows } from '../hooks/mods-menu-logic'

type HookEngine = EngineInterface
type HookRender = RenderInput<'AbovePrompt'>

const PLUGIN = 'mods-menu'
const TYPED = { args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

// The band's props as the engine hands them over.
function bandProps(overrides: { hasSurvey?: boolean; bodyColumns?: number } = {}): RenderPropsOf['AbovePrompt'] {
  return {
    hasSurvey: overrides.hasSurvey ?? false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: overrides.bodyColumns ?? 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  }
}

function command(name: string, plugin?: string): CommandInfo {
  return { name, description: name, source: 'plugin', ...(plugin === undefined ? {} : { plugin }) }
}

const ALL_COMMANDS: CommandInfo[] = [command('simple', 'clean-view'), command('dock', 'clean-view')]

// Clean View's band in miniature: a header with a toggle and the two slots.
function cleanViewStandIn($: HookEngine, e: HookRender): RenderNode {
  const { Box, Button } = $.ui.resolve(e)
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Button({ key: 'toggle', label: 'Clean View: ON', onPress: () => undefined }),
          Box({ key: 'band-corner', flexDirection: 'row' }),
        ],
      }),
      Box({ key: 'band-body', flexDirection: 'column', alignItems: 'flex-end' }),
    ],
  } as never) as RenderNode
}

// Answers what the plugin asks of the engine; `beneath` stands for whatever the band chain below returns.
function standInForEngine(on: On, options: { commands?: CommandInfo[]; beneath?: ($: HookEngine, e: HookRender) => RenderNode } = {}) {
  const world = {
    ran: [] as { command: string; args: string }[],
    toasts: [] as string[],
    registered: [] as string[],
    runFails: false,
  }
  mock.store(on)
  on('command.list', () => ({ value: options.commands ?? ALL_COMMANDS }))
  on('command.register', ($, e) => {
    world.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.run', ($, e) => {
    if (world.runFails) throw new Error('refused')
    world.ran.push({ command: e.command, args: e.args })
    return { text: 'ok' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return (options.beneath === undefined ? Box({}) : options.beneath($, e)) as never
  })
  return world
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

async function mountBand($: Engine, props = bandProps()) {
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props })
}

async function openMenu($: Engine, band: Awaited<ReturnType<typeof mountBand>>) {
  await band.press({ key: 'mods-menu:toggle' })
}

// True when a found element holds an element with this key anywhere below it.
function holdsKey(found: { children: unknown[] } | undefined, key: string): boolean {
  const visit = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null) return false
    const element = node as { key?: unknown; props?: { key?: unknown }; children?: unknown[] }
    if (element.key === key || element.props?.key === key) return true
    return (element.children ?? []).some(visit)
  }
  return found !== undefined && found.children.some(visit)
}

async function hasKey(band: Awaited<ReturnType<typeof mountBand>>, key: string) {
  return (await band.find({ key })) !== undefined
}

test('1. the pure helpers find, append to and read a tree without changing it', () => {
  const tree = JSON.parse('{"type":"Box","children":[{"type":"Button","props":{"key":"toggle","label":"x"}},{"type":"Box","props":{"key":"band-corner"},"children":[]}]}') as RenderNode
  expect(hasVisibleContent(tree)).toBe(true)
  expect(hasVisibleContent({ type: 'Box', children: [' ', { type: 'Box', children: [] }] } as RenderNode)).toBe(false)
  expect(hasVisibleContent('hi')).toBe(true)
  expect(hasVisibleContent(null)).toBe(false)
  expect(findKeyed(tree, 'band-corner')?.type).toBe('Box')
  expect(findKeyed(tree, 'missing')).toBeUndefined()

  const before = JSON.stringify(tree)
  const frozen = JSON.parse(before) as RenderNode
  const item = { type: 'Text', children: ['x'] } as RenderNode
  const next = appendToKeyed(Object.freeze(frozen), 'band-corner', item)
  expect((findKeyed(next, 'band-corner') as { children: RenderNode[] }).children).toEqual([item])
  expect(JSON.stringify(tree)).toBe(before)
  expect(appendToKeyed(tree, 'missing', item)).toBe(tree)
})

test('2. the catalog maps commands to buttons, hides missing ones and adds extras', () => {
  const rows = resolveRows([command('simple', 'clean-view'), command('dock', 'clean-view'), command('tidy', 'clean-view@market')])
  const labelsOf = (id: string) => rows.find(row => row.entry.id === id)?.buttons.map(button => button.label)
  expect(labelsOf('clean-view')).toEqual(['On', 'Off', '/tidy'])
  expect(labelsOf('agent-dock')).toEqual(['Open', '1', '3', '5', '10'])
  expect(rows.find(row => row.entry.id === 'status-bar')?.status).toBe('always-on')

  const withoutDock = resolveRows([command('simple', 'clean-view')])
  expect(withoutDock.find(row => row.entry.id === 'agent-dock')?.status).toBe('not-loaded')
  // Commands of unrelated plugins never appear.
  expect(resolveRows([command('other', 'someone-else')]).flatMap(row => row.buttons)).toEqual([])
})

test('3. case b: nothing beneath gives band-slots with the button; the rectangle only while open', async ($, on) => {
  standInForEngine(on)
  await startSession($)
  const band = await mountBand($)
  expect(await hasKey(band, 'band-slots')).toBe(true)
  expect(await hasKey(band, 'mods-menu:toggle')).toBe(true)
  expect(await hasKey(band, 'mods-menu:menu')).toBe(false)
  expect((await band.find({ type: 'Text', text: /☰ Mods ▾/ })) !== undefined).toBe(true)

  await openMenu($, band)
  expect(await hasKey(band, 'mods-menu:menu')).toBe(true)
  expect((await band.find({ type: 'Text', text: /☰ Mods ▴/ })) !== undefined).toBe(true)
  expect((await band.find({ type: 'Text', text: /Your mods/ })) !== undefined).toBe(true)
  await band.press({ key: 'mods-menu:close' })
  expect(await hasKey(band, 'mods-menu:menu')).toBe(false)
  await band.unmount()
})

test('4. case a: the button joins band-corner and the rectangle band-body of the tree beneath', async ($, on) => {
  standInForEngine(on, { beneath: cleanViewStandIn })
  await startSession($)
  const band = await mountBand($)
  // The stand-in's own toggle stays, and ours sits inside band-corner.
  expect(await hasKey(band, 'toggle')).toBe(true)
  const corner = await band.find({ key: 'band-corner' })
  expect(holdsKey(corner, 'mods-menu:toggle')).toBe(true)
  expect(await hasKey(band, 'band-slots')).toBe(false)

  const closedBody = await band.find({ key: 'band-body' })
  expect(holdsKey(closedBody, 'mods-menu:menu')).toBe(false)
  await openMenu($, band)
  const body = await band.find({ key: 'band-body' })
  expect(holdsKey(body, 'mods-menu:menu')).toBe(true)
  await band.unmount()
})

test('5. case c: visible content beneath without slots gets band-slots under it', async ($, on) => {
  standInForEngine(on, { beneath: ($, e) => $.ui.resolve(e).Text({ children: 'Hello from below' }) as RenderNode })
  await startSession($)
  const band = await mountBand($)
  expect((await band.find({ type: 'Text', text: /Hello from below/ })) !== undefined).toBe(true)
  expect(await hasKey(band, 'band-slots')).toBe(true)
  expect(await hasKey(band, 'mods-menu:toggle')).toBe(true)
  await band.unmount()
})

test('6. a survey passes the band through untouched', async ($, on) => {
  standInForEngine(on, { beneath: cleanViewStandIn })
  await startSession($)
  const band = await mountBand($, bandProps({ hasSurvey: true }))
  expect(await hasKey(band, 'toggle')).toBe(true)
  expect(await hasKey(band, 'mods-menu:toggle')).toBe(false)
  await band.unmount()
})

test('7. pressing catalog buttons runs the right commands and closes the menu, except sizes', async ($, on) => {
  const world = standInForEngine(on)
  await startSession($)
  const band = await mountBand($)
  await openMenu($, band)

  await band.press({ key: 'mods-menu:run:clean-view:Off' })
  expect(world.ran).toEqual([{ command: 'simple', args: 'off' }])
  expect(await hasKey(band, 'mods-menu:menu')).toBe(false)

  await openMenu($, band)
  await band.press({ key: 'mods-menu:run:agent-dock:3' })
  expect(world.ran.at(-1)).toEqual({ command: 'dock', args: '3' })
  expect(await hasKey(band, 'mods-menu:menu')).toBe(true)

  await band.press({ key: 'mods-menu:run:agent-dock:Open' })
  expect(world.ran.at(-1)).toEqual({ command: 'dock', args: '' })
  expect(await hasKey(band, 'mods-menu:menu')).toBe(false)
  await band.unmount()
})

test('8. a command missing from the list shows "not loaded" and no buttons', async ($, on) => {
  standInForEngine(on, { commands: [command('simple', 'clean-view')] })
  await startSession($)
  const band = await mountBand($)
  await openMenu($, band)
  expect(await hasKey(band, 'mods-menu:run:clean-view:On')).toBe(true)
  expect(await hasKey(band, 'mods-menu:run:agent-dock:Open')).toBe(false)
  expect((await band.find({ type: 'Text', text: /not loaded/ })) !== undefined).toBe(true)
  expect((await band.find({ type: 'Text', text: /always on/ })) !== undefined).toBe(true)
  await band.unmount()
})

test('9. a command of a catalog plugin with no button gets a /name button', async ($, on) => {
  const world = standInForEngine(on, { commands: [...ALL_COMMANDS, command('tidy', 'clean-view')] })
  await startSession($)
  const band = await mountBand($)
  await openMenu($, band)
  expect(await hasKey(band, 'mods-menu:run:tidy')).toBe(true)
  await band.press({ key: 'mods-menu:run:tidy' })
  expect(world.ran).toEqual([{ command: 'tidy', args: '' }])
  await band.unmount()
})

test('10. a refused run toasts instead of throwing', async ($, on) => {
  const world = standInForEngine(on)
  world.runFails = true
  await startSession($)
  const band = await mountBand($)
  await openMenu($, band)
  await band.press({ key: 'mods-menu:run:agent-dock:Open' })
  expect(world.toasts).toContain("Couldn't run /dock")
  await band.unmount()
})

test('11. /mods is registered and toggles the menu', async ($, on) => {
  const world = standInForEngine(on)
  await startSession($)
  expect(world.registered).toEqual(['mods'])

  const band = await mountBand($)
  const opened = await $.command.run({ command: 'mods', ...TYPED })
  expect(opened.text).toBe('Mods menu opened.')
  expect(await hasKey(band, 'mods-menu:menu')).toBe(true)
  const closed = await $.command.run({ command: 'mods', ...TYPED })
  expect(closed.text).toBe('Mods menu closed.')
  expect(await hasKey(band, 'mods-menu:menu')).toBe(false)
  await band.unmount()
})

test("Prompt Upgrade's row has its commands and the four detail choices, which keep the menu open", () => {
  const rows = resolveRows([command('better', 'prompt-upgrade')])
  const promptUpgrade = rows.find(row => row.entry.id === 'prompt-upgrade')
  expect(promptUpgrade?.status).toBe('ready')
  expect(promptUpgrade?.buttons.map(button => `${button.label}=${button.args}`)).toEqual([
    'Upgrade=',
    'Auto on=on',
    'Auto off=off',
    'History=history',
    'Auto=level auto',
    'Low=level low',
    'Medium=level medium',
    'High=level high',
  ])
  const levelButtons = promptUpgrade?.buttons.filter(button => button.args.startsWith('level ')) ?? []
  expect(levelButtons.every(button => button.keepsMenuOpen === true)).toBe(true)
})
