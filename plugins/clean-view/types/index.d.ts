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
  /** False until Claude reports a percent, so the label says Working instead of a percent. */
  hasReported: boolean
}

/** Where one of the main chat's helpers stands. */
export type CleanViewHelperStatus = 'working' | 'idle' | 'done' | 'stuck'

/** One helper (subagent) the main chat started, shown under the step it began in. */
export type CleanViewHelper = {
  /** The Agent call's tool_use id. */
  id: string
  /** The helper's agent id once known. */
  agentId: string | null
  /** The Agent call's description, cleaned. */
  name: string
  /** The step that was active when it started, or null. */
  stepId: string | null
  status: CleanViewHelperStatus
  /** 0 to 100, as the helper last reported. */
  percent: number
  /** False until the helper reports, so its meter sweeps. */
  hasReported: boolean
  startedAt: number
  finishedAt: number | null
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
  /** The main chat's helpers; older saved state may lack it. */
  helpers: CleanViewHelper[]
}

/** Agent Dock: where one helper stands. */
export type DockCardStatus = 'queued' | 'working' | 'done' | 'stuck'

/** Agent Dock: one helper's card. */
export type DockCard = {
  /** The Agent call's tool_use id. */
  id: string
  /** Its 3 to 5 word task name. */
  task: string
  /** Two letters for its badge. */
  initials: string
  /** Its place in the team, which picks its badge color and headshot. */
  seat: number
  status: DockCardStatus
  /** 0 to 100, as the helper last reported. */
  percent: number
  /** False until the helper reports, so its meter sweeps. */
  hasReported: boolean
  /** The helper's agent id once it started. */
  agentId: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** Agent Dock: one request and its helpers. */
export type DockMission = {
  id: number
  /** The job's name, from the request's first clause. */
  title: string
  /** The Team Size when the request was sent. */
  teamSize: number
  startedAt: number
  /** Set once every card has finished. */
  finishedAt: number | null
  cards: DockCard[]
  /** Agent calls let through for this request: the Team Size cap counts these. */
  admittedCalls: number
  /** True once the request got its one follow-up. */
  hasNudged: boolean
}

/** Agent Dock: which model helpers run on; Auto lets Claude pick per helper. */
export type DockHelperModel = 'auto' | 'fast' | 'same'

/** Agent Dock: the person's choices. */
export type DockSettings = {
  teamSize: number
  /** A size above 20 waiting for Continue or Cancel. */
  pendingSize: number | null
  helperModel: DockHelperModel
  /** True once the person picked a helper model; until then it follows the default, Auto. */
  hasChosenHelperModel: boolean
  /** True while the Custom size box is open. */
  isCustomOpen: boolean
  /** True while the dock is folded to its status-bar badge. */
  isFolded: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      /** Animation frame counter, advanced every 250ms while a job runs. */
      tick: number
      /** Agent Dock: Team Size, helper model and pane choices. */
      dock: DockSettings
      /** Agent Dock: the current request's helpers. */
      dockMission: DockMission | null
      /** Agent Dock: animation frame, advanced only while helpers are live. */
      dockTick: number
      /** Agent Dock: headshot file names found in employee-headshots. */
      dockHeadshots: string[]
    }
  }
}
