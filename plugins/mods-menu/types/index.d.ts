// Mods Menu's shared state: other mods can read whether the menu is open.

declare module 'claude-code' {
  interface PluginState {
    'mods-menu': {
      /** True while the menu rectangle is drawn under the Mods button. */
      isOpen: boolean
      /** Names of the slash commands that exist now, from `$.command.list()`. */
      availableCommands: AvailableCommand[]
    }
  }
}

/** One slash command as the menu needs it: its name and the plugin that owns it. */
export type AvailableCommand = { name: string; plugin?: string | null }
