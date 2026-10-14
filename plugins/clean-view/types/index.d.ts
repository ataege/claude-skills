// Clean View's shared state: other mods can read the checklist from here.

/** Where the current job stands; drives the band's header. */
export type CleanViewPhase = 'idle' | 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

/** One checklist row's state. */
export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

/** One step of the plan, as the checklist shows it. */
export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  /** 0 to 100, as last reported. */
  percent: number
  /** False until Claude reports a percent, so the meter sweeps instead. */
  hasReported: boolean
}

/** The job the band describes: its name, plan and timing. */
export type CleanViewChecklist = {
  /** Grows by one per job, so late answers for an older job are ignored. */
  jobId: number
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  /** True once a real plan replaced the placeholder steps. */
  hasPlan: boolean
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  /** True once a finished job has shrunk to one line. */
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      /** Animation frame counter, advanced every 250ms while a job runs. */
      tick: number
    }
  }
}
