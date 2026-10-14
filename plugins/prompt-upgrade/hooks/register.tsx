import type { Register } from 'claude-code'

import { registerPromptUpgrade } from './prompt-upgrade'

// Each mod registers itself here.
export const register: Register = on => {
  registerPromptUpgrade(on)
}
