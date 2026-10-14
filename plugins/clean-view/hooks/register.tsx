import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'

// Each mod registers itself here, so more can sit beside Clean View later.
export const register: Register = on => {
  registerCleanView(on)
}
