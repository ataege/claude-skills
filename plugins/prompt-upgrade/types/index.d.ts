// Prompt Upgrade's shared state: the step the pane is on, and the saved upgrades.

/** Where the upgrade flow stands; drives which screen the pane draws. */
export type PromptUpgradeStage =
  | 'idle'
  | 'typing'
  | 'reading'
  /** Automatic mode's check, run before the pane opens. */
  | 'checking'
  | 'asking'
  /** The check found the prompt already good. */
  | 'ready'
  | 'questions'
  | 'rewriting'
  | 'review'
  | 'editing'
  | 'error'
  | 'history'

/** How much the upgrade adds: auto (decides for itself), low, medium (the default) or high. */
export type PromptUpgradeDetail = 'auto' | 'low' | 'medium' | 'high'

/** What started the flow: a prompt caught by automatic mode, or the /better command. */
export type PromptUpgradeSource = 'auto' | 'command'

/** One multiple-choice question the fast model asked. */
export type PromptUpgradeQuestion = {
  question: string
  /** Two to four short options. */
  options: string[]
}

/** How one question was handled. `text` is the chosen or typed answer. */
export type PromptUpgradeAnswer = {
  status: 'open' | 'answered' | 'skipped'
  text: string
}

/** A short inline message in the pane (for example after Copy). */
export type PromptUpgradeNote = {
  text: string
  tone: 'good' | 'warn'
}

/** The model call that failed, so Try again knows what to repeat. */
export type PromptUpgradeStep = 'asking' | 'rewriting'

/** Everything the pane draws from. Written only by presses, commands and events. */
export type PromptUpgradeFlow = {
  stage: PromptUpgradeStage
  /** Bumped on every new call, so a stale model answer is ignored. */
  requestId: number
  /** The person's words, exactly as typed (without a leading ">"). */
  original: string
  /** The detail level this upgrade was started at; a change in the dropdown never touches it. */
  detailLevel: PromptUpgradeDetail
  startedBy: PromptUpgradeSource
  questions: PromptUpgradeQuestion[]
  /** One entry per question, same order. */
  answers: PromptUpgradeAnswer[]
  /** Index of the question whose "Other" box is open, or null. */
  typingFor: number | null
  upgraded: string
  added: string[]
  /** The text in the edit box while editing. */
  draft: string
  /** The history entry of the review on screen, or null. */
  entryId: string | null
  failedStep: PromptUpgradeStep
  note: PromptUpgradeNote | null
  /** When the Auto countdown ends (milliseconds since the epoch), or null when none is running. */
  autoSendAt: number | null
  /** True while the rewrite is for "fill the rest and send it", so it is sent with no review. */
  isSendingAutomatically: boolean
}

/** One question and the answer given, as kept in the history. */
export type PromptUpgradeQa = {
  question: string
  answer: string
}

/** One finished upgrade, as kept in the history (the last 20). */
export type PromptUpgradeEntry = {
  id: string
  original: string
  upgraded: string
  added: string[]
  wordsBefore: number
  wordsAfter: number
  detailsAdded: number
  answers: PromptUpgradeQa[]
  /** The detail level it was written at; older entries have none and read as medium. */
  detailLevel: PromptUpgradeDetail
  /** True when the upgrade was sent on its own (Auto's countdown or "Do it for me"), with no review. */
  sentAutomatically?: boolean
  /** Milliseconds since the epoch, from the engine's clock. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: PromptUpgradeFlow
      history: PromptUpgradeEntry[]
      /** True while automatic mode is on; other mods (the status bar) read it. */
      isAutoOn: boolean
      /** The detail level picked in the dropdown. */
      detailLevel: PromptUpgradeDetail
      /** The end of Claude's last main-loop reply, kept as context for the prompt check. */
      lastReply: string
      /** The last prompt automatic mode caught, normalized; sending it again passes it through. */
      lastIntercepted: string
    }
  }
}
