import type { Register } from 'claude-code'

import { registerModelRouting } from './model-routing'

// Each mod registers itself here, so more can sit beside model routing later.
export const register: Register = on => {
  registerModelRouting(on)
}
