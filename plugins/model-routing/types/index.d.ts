// Model routing's shared state: other mods can read which tier each agent runs on.

/** The four model tiers, cheapest first. */
export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** One spawned agent as the mod tracks it. */
export type ModelRoutingAgent = {
  /** The tier it runs on; null when the model named no known tier. */
  tier: ModelTier | null
  /** 1 for an agent the main conversation spawned, 2 for one an agent spawned. */
  depth: number
  /** The agent type, like "general-purpose" or "Explore". */
  type: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-routing': {
      /** Every agent spawned this session, by agent id. */
      agents: Record<string, ModelRoutingAgent>
      /** The tier each agent type ran on when no model was named, by type. */
      typeTiers: Record<string, ModelTier>
    }
  }
}
