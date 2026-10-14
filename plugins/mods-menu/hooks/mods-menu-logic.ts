// Mods Menu's pure logic: the catalog, the command mapping and the tree helpers.
import type { RenderNode } from 'claude-code'

import type { AvailableCommand } from '../types'

export const COLORS = {
  coral: '#F0806A',
  muted: '#8B949E',
  hairline: '#3A3F44',
} as const

export const MENU_WIDTH = 46
/** Width of the icon and name column, so every row's buttons line up. */
export const NAME_COLUMN_WIDTH = 16
export const KEY_PREFIX = 'mods-menu:'

/** One button in a mod's row: what it says and the slash command it runs. */
export type ModButton = {
  label: string
  command: string
  args: string
  /** True for buttons that leave the menu open (the dock sizes). */
  keepsMenuOpen?: boolean
}

/** One mod in the menu. */
export type ModEntry = {
  id: string
  icon: string
  name: string
  /** The plugin that owns this mod's commands. */
  plugin: string
  buttons: ModButton[]
}

// Adding a mod is one line here.
export const CATALOG: ModEntry[] = [
  {
    id: 'clean-view',
    icon: '◆',
    name: 'Clean View',
    plugin: 'clean-view',
    buttons: [
      { label: 'On', command: 'simple', args: 'on' },
      { label: 'Off', command: 'simple', args: 'off' },
    ],
  },
  {
    id: 'agent-dock',
    icon: '◆',
    name: 'Agent Dock',
    plugin: 'clean-view',
    buttons: [
      { label: 'Open', command: 'dock', args: '' },
      ...['1', '3', '5', '10'].map(size => ({ label: size, command: 'dock', args: size, keepsMenuOpen: true })),
    ],
  },
  {
    id: 'prompt-upgrade',
    icon: '◇',
    name: 'Prompt Upgrade',
    plugin: 'prompt-upgrade',
    buttons: [
      { label: 'Upgrade', command: 'better', args: '' },
      { label: 'Auto on', command: 'better', args: 'on' },
      { label: 'Auto off', command: 'better', args: 'off' },
      { label: 'History', command: 'better', args: 'history' },
      // The detail level; the menu stays open so the pick can be changed again.
      ...(['Auto', 'Low', 'Medium', 'High'] as const).map(level => ({
        label: level,
        command: 'better',
        args: `level ${level.toLowerCase()}`,
        keepsMenuOpen: true,
      })),
    ],
  },
  { id: 'status-bar', icon: '▣', name: 'Status Bar', plugin: 'status-bar', buttons: [] },
  { id: 'model-routing', icon: '◎', name: 'Model Routing', plugin: 'model-routing', buttons: [] },
]

/** A button ready to draw: the catalog's, or one made for an extra command. */
export type ResolvedButton = ModButton & { key: string }

/** One menu row after matching the catalog against the commands that exist. */
export type ResolvedRow = {
  entry: ModEntry
  buttons: ResolvedButton[]
  /** 'ready' draws buttons, 'always-on' has none by design, 'not-loaded' lost its commands. */
  status: 'ready' | 'always-on' | 'not-loaded'
}

/** The plugin name without any `@marketplace` suffix. */
export function pluginBaseName(plugin: string | null | undefined): string {
  return (plugin ?? '').split('@')[0] ?? ''
}

/** Matches the catalog against the commands that exist right now. */
export function resolveRows(available: readonly AvailableCommand[], catalog: readonly ModEntry[] = CATALOG): ResolvedRow[] {
  const availableNames = new Set(available.map(command => command.name))
  const catalogCommands = new Set(catalog.flatMap(entry => entry.buttons.map(button => button.command)))
  const catalogPlugins = new Set(catalog.map(entry => entry.plugin))

  // Commands of a catalog plugin that no button covers yet get a /name button on that plugin's first row.
  const extraByPlugin = new Map<string, ResolvedButton[]>()
  for (const command of available) {
    const owner = pluginBaseName(command.plugin)
    if (!catalogPlugins.has(owner) || catalogCommands.has(command.name)) continue
    const extras = extraByPlugin.get(owner) ?? []
    if (!extras.some(extra => extra.command === command.name)) {
      extras.push({ key: `${KEY_PREFIX}run:${command.name}`, label: `/${command.name}`, command: command.name, args: '' })
    }
    extraByPlugin.set(owner, extras)
  }

  const claimedPlugins = new Set<string>()
  return catalog.map(entry => {
    const catalogButtons: ResolvedButton[] = entry.buttons
      .filter(button => availableNames.has(button.command))
      .map(button => ({ ...button, key: `${KEY_PREFIX}run:${entry.id}:${button.label}` }))
    const isFirstOfPlugin = !claimedPlugins.has(entry.plugin)
    claimedPlugins.add(entry.plugin)
    const extras = isFirstOfPlugin ? (extraByPlugin.get(entry.plugin) ?? []) : []
    const buttons = [...catalogButtons, ...extras]

    if (entry.buttons.length === 0) return { entry, buttons, status: buttons.length > 0 ? 'ready' : 'always-on' }
    return { entry, buttons, status: buttons.length > 0 ? 'ready' : 'not-loaded' }
  })
}

/** The slash command text a button runs, for toasts: `/dock 3`. */
export function commandText(button: Pick<ModButton, 'command' | 'args'>): string {
  return button.args === '' ? `/${button.command}` : `/${button.command} ${button.args}`
}

// ---------------------------------------------------------------------------
// Tree helpers. A RenderNode is a string or an element whose children sit in `children`.
// ---------------------------------------------------------------------------

type ElementLike = Exclude<RenderNode, string>

function childrenOf(node: ElementLike): RenderNode[] {
  const children = (node as { children?: RenderNode[] }).children
  return Array.isArray(children) ? children : []
}

function keyOf(node: ElementLike): unknown {
  return (node as { props?: { key?: unknown } }).props?.key
}

/** True when the tree holds a non-blank string or a Button anywhere. */
export function hasVisibleContent(tree: RenderNode | null | undefined): boolean {
  if (tree === null || tree === undefined) return false
  if (typeof tree === 'string') return tree.trim() !== ''
  if (tree.type === 'Button') return true
  return childrenOf(tree).some(hasVisibleContent)
}

/** The first element in the tree whose `props.key` matches, or undefined. */
export function findKeyed(tree: RenderNode | null | undefined, key: string): ElementLike | undefined {
  if (tree === null || tree === undefined || typeof tree === 'string') return undefined
  if (keyOf(tree) === key) return tree
  for (const child of childrenOf(tree)) {
    const found = findKeyed(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

/** A copy of the tree with `item` appended to the first keyed element's children. The input is never changed. */
export function appendToKeyed(tree: RenderNode, key: string, item: RenderNode): RenderNode {
  if (typeof tree === 'string') return tree
  if (keyOf(tree) === key) {
    return { ...tree, children: [...childrenOf(tree), item] } as ElementLike
  }
  const children = childrenOf(tree)
  const holderIndex = children.findIndex(child => findKeyed(child, key) !== undefined)
  if (holderIndex === -1) return tree
  const copiedChildren = children.map((child, index) => (index === holderIndex ? appendToKeyed(child, key, item) : child))
  return { ...tree, children: copiedChildren } as ElementLike
}
