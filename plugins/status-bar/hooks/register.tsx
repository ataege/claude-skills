import type { Register } from 'claude-code'

import { registerStatusBar } from './status-bar'

// Each mod registers itself here, so more can sit beside the status bar later.
export const register: Register = on => {
  registerStatusBar(on)
}
