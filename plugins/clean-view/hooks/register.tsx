import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'
import { registerAgentDock } from './dock'

// Each mod registers itself here. The dock goes first, so its hook answers
// helpers' report_progress calls before Clean View's would.
export const register: Register = on => {
  registerAgentDock(on)
  registerCleanView(on)
}
