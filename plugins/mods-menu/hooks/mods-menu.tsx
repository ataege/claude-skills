// Mods Menu: a Mods button beside the Clean View toggle that opens a small rectangle of mod buttons.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { AvailableCommand } from '../types'
import {
  COLORS,
  KEY_PREFIX,
  MENU_WIDTH,
  NAME_COLUMN_WIDTH,
  appendToKeyed,
  commandText,
  findKeyed,
  hasVisibleContent,
  resolveRows,
} from './mods-menu-logic'
import type { ResolvedButton, ResolvedRow } from './mods-menu-logic'

type Engine = EngineInterface
type BandInput = RenderInput<'AbovePrompt'>

const isOpenAtom = atom({ plugin: 'mods-menu', key: 'isOpen' } as const, false)
const availableAtom = atom({ plugin: 'mods-menu', key: 'availableCommands' } as const, [])

function showToast($: Engine, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // A toast that cannot show is no reason to fail.
  }
}

/** Asks the engine which slash commands exist now and keeps the answer in state. */
async function refreshCommands($: Engine): Promise<void> {
  try {
    const commands = await $.command.list()
    const available: AvailableCommand[] = commands.map(command => ({ name: command.name, plugin: command.plugin ?? null }))
    await update($, availableAtom, () => available)
  } catch {
    // Keep the last known list.
  }
}

/** Opens or closes the menu; opening refreshes the command list. */
async function setMenuOpen($: Engine, mode: 'flip' | boolean): Promise<boolean> {
  const wasOpen = await read($, isOpenAtom)
  const willOpen = mode === 'flip' ? !wasOpen : mode
  await update($, isOpenAtom, () => willOpen)
  if (willOpen) await refreshCommands($)
  return willOpen
}

/** Runs a button's slash command without blocking the press; a failure becomes a toast. */
function runButton($: Engine, button: ResolvedButton, isSessionBusy: boolean): void {
  void (async () => {
    try {
      if (isSessionBusy) showToast($, 'Runs when Claude finishes')
      await $.command.run(button.args === '' ? { command: button.command } : { command: button.command, args: button.args })
    } catch {
      showToast($, `Couldn't run ${commandText(button)}`)
    }
  })()
}

function drawRow($: Engine, e: BandInput, row: ResolvedRow): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { entry } = row

  const buttons = row.buttons.map(button => (
    <Box key={`${button.key}:box`} marginRight={1}>
      <Button
        key={button.key}
        plain
        onPress={() => {
          runButton($, button, e.props.isWorking)
          if (button.keepsMenuOpen !== true) void setMenuOpen($, false).catch(() => undefined)
        }}
      >
        <Text color={COLORS.coral}>{button.label}</Text>
      </Button>
    </Box>
  ))

  return (
    <Box key={`${KEY_PREFIX}row:${entry.id}`} flexDirection="row">
      <Box width={NAME_COLUMN_WIDTH} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text color={COLORS.coral}>{entry.icon}</Text> <Text>{entry.name}</Text>
        </Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1}>
        {row.status === 'not-loaded' ? <Text dimColor>not loaded</Text> : null}
        {row.status === 'always-on' ? <Text dimColor>always on</Text> : null}
        {buttons}
      </Box>
    </Box>
  )
}

/** The small rectangle drawn under the Mods button. */
async function drawMenu($: Engine, e: BandInput): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const available = await read($, availableAtom)
  const rows = resolveRows(available)
  const width = Math.max(24, Math.min(MENU_WIDTH, e.props.bodyColumns))

  return (
    <Box
      key={`${KEY_PREFIX}menu`}
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.hairline}
      paddingX={1}
      width={width}
    >
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Text color={COLORS.muted}>Your mods</Text>
        </Box>
        <Button key={`${KEY_PREFIX}close`} plain onPress={() => void setMenuOpen($, false).catch(() => undefined)}>
          <Text color={COLORS.muted}>×</Text>
        </Button>
      </Box>
      {rows.map(row => drawRow($, e, row))}
    </Box>
  )
}

/** The Mods button: a muted label and an arrow that shows whether the menu is open. */
function drawToggle($: Engine, e: BandInput, isOpen: boolean): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box key={`${KEY_PREFIX}corner-item`} marginLeft={1} flexShrink={0}>
      <Button key={`${KEY_PREFIX}toggle`} plain onPress={() => void setMenuOpen($, 'flip').catch(() => undefined)}>
        <Text color={COLORS.muted}>{`☰ Mods ${isOpen ? '▴' : '▾'}`}</Text>
      </Button>
    </Box>
  )
}

async function drawBand($: Engine, e: BandInput, next: (e: BandInput) => Promise<RenderElement>): Promise<RenderElement> {
  const { Box } = $.ui.resolve(e)
  const beneath = await next(e)
  const isOpen = await read($, isOpenAtom)
  const cornerItem = drawToggle($, e, isOpen)
  const bodyItem = isOpen ? await drawMenu($, e) : null

  // Case a: Clean View is above us in the chain and left its two slots in the tree.
  if (findKeyed(beneath, 'band-corner') !== undefined && findKeyed(beneath, 'band-body') !== undefined) {
    const withCorner = appendToKeyed(beneath, 'band-corner', cornerItem)
    return (bodyItem === null ? withCorner : appendToKeyed(withCorner, 'band-body', bodyItem)) as RenderElement
  }

  const slots = (
    <Box key="band-slots" flexDirection="column">
      <Box key="corner">{cornerItem}</Box>
      <Box key="body" alignItems="flex-end">{bodyItem}</Box>
    </Box>
  )

  // Case b: nothing visible beneath, so the slots stand alone.
  if (!hasVisibleContent(beneath)) return slots

  // Case c: something visible beneath, so the slots go under it.
  return (
    <Box flexDirection="column">
      {beneath}
      {slots}
    </Box>
  )
}

export function registerModsMenu(on: On): void {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'mods', description: 'Open or close the Mods menu', immediate: true })
    } catch {
      // The Mods button still works without the slash command.
    }
    await refreshCommands($)
    return next(e)
  })

  // /mods toggles the menu.
  on('command.run', { command: 'mods' }, async $ => {
    const isOpen = await setMenuOpen($, 'flip')
    return { text: isOpen ? 'Mods menu opened.' : 'Mods menu closed.' }
  })

  // The Mods button and menu join the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    return drawBand($, e, next)
  })
}
