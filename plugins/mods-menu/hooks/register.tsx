import type { Register } from 'claude-code'

import { registerModsMenu } from './mods-menu'

// Each mod registers itself here.
export const register: Register = on => {
  registerModsMenu(on)
}
