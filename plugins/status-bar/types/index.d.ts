// The status bar's shared state: other mods can read its figures from here.

/** Running agents that share one model and effort, like 3 on "haiku/low". */
export type StatusBarRoute = { label: string; count: number }

/** What the status bar under the prompt shows; null where nothing is known yet. */
export type StatusBarSnapshot = {
  /** The plan, like "Max 20x" or "Pro"; "API" for a key. */
  planName: string | null
  /** The model in plain words, like "Opus 5.5". */
  model: string | null
  /** The reasoning effort, like "high". */
  effort: string | null
  /** How full the context window is, 0 to 100. */
  contextPercent: number | null
  /** How much of the 5-hour and 7-day usage windows is used, 0 to 100. */
  fiveHourUsedPercent: number | null
  sevenDayUsedPercent: number | null
  /** True after a turn ended on a usage-limit error, until usage moves again. */
  isRateLimited: boolean
  /** Subagents and teammates that are starting, running or waiting. */
  activeAgents: number
  /** The running agents grouped by model and effort, most first. */
  agentRoutes: StatusBarRoute[]
}

declare module 'claude-code' {
  interface PluginState {
    'status-bar': {
      snapshot: StatusBarSnapshot
      /** Each agent's route, like "haiku/low", by agent id, from its own requests. */
      routes: Record<string, string>
    }
  }
}
