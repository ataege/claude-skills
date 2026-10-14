// Agent Dock: splits each request across a chosen team of helpers and shows each one live.
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, Elements, EngineInterface, On, RenderElement, RenderInput, TextProps, Timer } from 'claude-code'

import type { DockCard, DockHelperModel, DockMission, DockSettings } from '../types'
import {
  BAD_COMMAND_SIZE,
  BAD_CUSTOM_SIZE,
  COLORS,
  DEFAULT_DOCK_SETTINGS,
  HELPERS_SKIP_PLAN,
  MAX_SEATS,
  NARROW_WINDOW,
  PRESET_SIZES,
  STOPPED_MESSAGE,
  badgeText,
  bigTeamQuestion,
  blend,
  capMessage,
  cardElapsed,
  cardLayout,
  clampPercent,
  countCards,
  dockCommand,
  dropCard,
  removeCard,
  endTurn,
  finishCard,
  formatClock,
  HELPER_MODELS,
  autoModelMessage,
  defaultEffortFor,
  helperModelLabel,
  helperRules,
  helpersAtOnce,
  infoLine,
  instructionText,
  isLive,
  linkAgent,
  meterCells,
  missionElapsed,
  missionPercent,
  missionShares,
  needsConfirmation,
  nudgeText,
  parseSize,
  queueCard,
  reportHelper,
  restoreHelperModel,
  restoreSize,
  seatColor,
  shouldNudge,
  startCard,
  startMission,
  summaryLine,
  sweepStart,
} from './dock-logic'

// ---------------------------------------------------------------------------
// Names and timings
// ---------------------------------------------------------------------------

const PANE_ID = 'agent-dock'
const PANE_TITLE = 'Agent Dock'
// Wide enough for two cards a row when docked beside the transcript.
const PANE_COLUMNS = 80
const STORE_TEAM_SIZE = 'dock.teamSize'
const STORE_HELPER_MODEL = 'panel.helperModel'
const STORE_HELPER_MODEL_CHOSEN = 'panel.helperModelChosen'
// Agent types with no model of their own: Auto asks Claude to name one for them.
const UNPINNED_AGENT_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'claude'])
const DOCK_TICK_MS = 500
const HEADSHOT_FOLDER = 'employee-headshots'

const dockRef = { plugin: 'clean-view', key: 'dock' } as const
const settingsAtom = atom(dockRef, DEFAULT_DOCK_SETTINGS)
const missionAtom = atom({ plugin: 'clean-view', key: 'dockMission' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'dockTick' } as const, 0)
const headshotsAtom = atom({ plugin: 'clean-view', key: 'dockHeadshots' } as const, [])

// Module-only bookkeeping: none of it is drawn, so a reload may reset it.
let dockClock: Timer | undefined
let runningHelpers = 0

type Engine = EngineInterface
type TextElement = ElementConstructor<TextProps>

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

/** The session's model as an Agent tool alias, or null when it names none. */
async function sessionModelAlias($: Engine): Promise<string | null> {
  try {
    return (await $.session.model()).toLowerCase().match(/haiku|sonnet|opus|fable/)?.[0] ?? null
  } catch {
    return null
  }
}

/** How many helpers run at once, from the engine's two limits. */
async function atOnceOf($: Engine): Promise<number> {
  try {
    const maxSubagents = await $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS')
    const maxToolConcurrency = await $.env.get('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY')
    return helpersAtOnce(maxSubagents, maxToolConcurrency)
  } catch {
    return helpersAtOnce(undefined, undefined)
  }
}

function showToast($: Engine, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // A toast that cannot show is no reason to fail.
  }
}

/** Applies a change to the mission (made when missing) and keeps clock and badge in step. */
async function changeMission(
  $: Engine,
  change: (mission: DockMission) => DockMission,
): Promise<DockMission | null> {
  const now = await $.clock.now()
  const { teamSize } = await read($, settingsAtom)
  const changed = await update($, missionAtom, mission =>
    change(mission ?? startMission(0, 'Your request', teamSize, now)),
  )
  await afterMissionChange($)

  return changed
}

async function afterMissionChange($: Engine): Promise<void> {
  await syncDockClock($)
  await refreshBadge($)
}

/** One clock, running only while helpers are queued or working. */
async function syncDockClock($: Engine): Promise<void> {
  const shouldRun = isLive(await read($, missionAtom))
  if (shouldRun && dockClock === undefined) {
    dockClock = $.clock.every(DOCK_TICK_MS, () => {
      void update($, tickAtom, frame => frame + 1)
    })
  } else if (!shouldRun && dockClock !== undefined) {
    dockClock.cancel()
    dockClock = undefined
  }
}

/** The status-bar badge, shown only while the dock is folded. */
async function refreshBadge($: Engine): Promise<void> {
  const settings = await read($, settingsAtom)
  try {
    $.ui.status(settings.isFolded ? badgeText(await read($, missionAtom), settings.teamSize) : undefined)
  } catch {
    // The badge is a nicety.
  }
}

async function saveSettings($: Engine, settings: DockSettings): Promise<void> {
  try {
    await $.store.set(STORE_TEAM_SIZE, settings.teamSize)
    await $.store.set(STORE_HELPER_MODEL, settings.helperModel)
    await $.store.set(STORE_HELPER_MODEL_CHOSEN, settings.hasChosenHelperModel)
  } catch {
    // The choice still holds for this session.
  }
}

async function changeSettings($: Engine, change: (settings: DockSettings) => DockSettings): Promise<DockSettings> {
  const changed = await update($, settingsAtom, change)
  await saveSettings($, changed)
  await refreshBadge($)

  return changed
}

/** Picks a size: small ones apply at once, big ones wait for Continue. */
async function chooseSize($: Engine, size: number): Promise<void> {
  await changeSettings($, settings =>
    needsConfirmation(size)
      ? { ...settings, pendingSize: size, isCustomOpen: false }
      : { ...settings, teamSize: size, pendingSize: null, isCustomOpen: false },
  )
}

async function confirmPendingSize($: Engine): Promise<void> {
  await changeSettings($, settings =>
    settings.pendingSize === null ? settings : { ...settings, teamSize: settings.pendingSize, pendingSize: null },
  )
}

/** Opens the dock beside the transcript, or says why it cannot. */
async function openDock($: Engine): Promise<void> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  if (!opened.isPlaced) showToast($, NARROW_WINDOW)
  await changeSettings($, settings => ({ ...settings, isFolded: false }))
}

/** Folds an open dock to its badge, or opens a folded or closed one. */
async function toggleDock($: Engine): Promise<void> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE_ID)
  if (!isOpen) {
    await openDock($)
    return
  }
  await $.ui.close({ id: PANE_ID })
  await changeSettings($, settings => ({ ...settings, isFolded: true }))
}

/** Loads the headshots the plugin ships, if any. */
async function loadHeadshots($: Engine): Promise<void> {
  try {
    const entries = await $.fs.list(`${$.plugin.root}/${HEADSHOT_FOLDER}`)
    const pictures = entries
      .map(entry => entry.name)
      .filter(name => name.toLowerCase().endsWith('.png'))
      .sort()
    await update($, headshotsAtom, () => pictures)
  } catch {
    await update($, headshotsAtom, () => [])
  }
}

// ---------------------------------------------------------------------------
// Drawing: small pieces
// ---------------------------------------------------------------------------

/** Spaced capitals, like "A G E N T". */
function spaced(text: string): string {
  return text.split('').join(' ')
}

/** Text drawn letter by letter from coral to gold. */
function gradientText(Text: TextElement, text: string, weight?: TextProps['weight']): RenderElement[] {
  const letters = text.split('')
  return letters.map((letter, index) => (
    <Text color={blend(COLORS.coral, COLORS.gold, letters.length <= 1 ? 0 : index / (letters.length - 1))} weight={weight}>
      {letter}
    </Text>
  ))
}

/** The full-width mission bar: progress coral to gold, work in flight shimmering green, the rest a hairline. */
function missionBar(Text: TextElement, cards: readonly DockCard[], width: number, frame: number): RenderElement {
  const { progress, inFlight } = missionShares(cards)
  const progressCells = Math.round(progress * width)
  const flightCells = Math.min(width - progressCells, Math.round(inFlight * width))
  const restCells = width - progressCells - flightCells
  const pieces: RenderElement[] = []

  // The progress part in up to ten color steps, so the tree stays small.
  const steps = Math.min(10, progressCells)
  for (let step = 0; step < steps; step += 1) {
    const from = Math.round((step / steps) * progressCells)
    const to = Math.round(((step + 1) / steps) * progressCells)
    pieces.push(<Text color={blend(COLORS.coral, COLORS.gold, steps <= 1 ? 1 : step / (steps - 1))}>{'━'.repeat(to - from)}</Text>)
  }
  // The work in flight shimmers: a lighter pair of cells walks along it.
  for (let cell = 0; cell < flightCells; cell += 2) {
    const isBright = Math.floor(cell / 2) % 4 === frame % 4
    pieces.push(<Text color={isBright ? COLORS.green : COLORS.greenDim}>{'━'.repeat(Math.min(2, flightCells - cell))}</Text>)
  }
  if (restCells > 0) pieces.push(<Text color={COLORS.hairline}>{'─'.repeat(restCells)}</Text>)

  return <Text wrap="truncate-end">{pieces}</Text>
}

/** A card's meter: filled to its percent, or a moving sweep before its first report. */
function cardMeter(Text: TextElement, card: DockCard, width: number, frame: number): RenderElement {
  if (card.status === 'working' && !card.hasReported) {
    const start = sweepStart(frame, width)
    return (
      <Text>
        <Text color={COLORS.hairline}>{'─'.repeat(start)}</Text>
        <Text color={COLORS.green}>{'━'.repeat(Math.min(3, width))}</Text>
        <Text color={COLORS.hairline}>{'─'.repeat(Math.max(0, width - start - 3))}</Text>
      </Text>
    )
  }
  const { filled, empty } = meterCells(card.status === 'done' ? 100 : card.percent, width)
  const fillColor = card.status === 'stuck' ? COLORS.red : card.status === 'done' ? COLORS.gold : COLORS.coral

  return (
    <Text>
      <Text color={fillColor} dimColor={card.status === 'queued'}>{'━'.repeat(filled)}</Text>
      <Text color={COLORS.hairline}>{'─'.repeat(empty)}</Text>
    </Text>
  )
}

function percentLabel(card: DockCard): string {
  if (card.status === 'done') return '100%'
  if (card.status === 'stuck') return 'stuck'
  if (card.status === 'queued') return 'queued'

  return card.hasReported ? `${card.percent}%` : '…'
}

// ---------------------------------------------------------------------------
// Drawing: the pane
// ---------------------------------------------------------------------------

type PaneInput = RenderInput<'Pane'>

async function drawDock($: Engine, e: PaneInput): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = (elements as Partial<Elements['terminal']>).Input
  const Image = e.surface === 'terminal' ? (elements as Partial<Elements['terminal']>).Image : undefined

  const settings = await read($, settingsAtom)
  const mission = await read($, missionAtom)
  const frame = await read($, tickAtom)
  const headshots = await read($, headshotsAtom)
  const now = await $.clock.now()
  const atOnce = await atOnceOf($)
  const width = Math.max(40, e.props.bodyColumns)

  const live = isLive(mission)
  const hasCards = mission !== null && mission.cards.length > 0
  const isComplete = hasCards && mission.finishedAt !== null

  // Masthead: the wordmark and the live state.
  const stateLabel = live ? (
    <Text color={frame % 2 === 0 ? COLORS.green : COLORS.greenDim}>● {spaced('LIVE')}</Text>
  ) : isComplete ? (
    <Text color={COLORS.gold}>{spaced('COMPLETE')}</Text>
  ) : (
    <Text color={COLORS.muted}>{spaced('STANDING BY')}</Text>
  )
  const masthead = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text>
        <Text color={COLORS.coral}>◆  </Text>
        {gradientText(Text, `${spaced('AGENT')}   ${spaced('DOCK')}`, 'bold')}
      </Text>
      {stateLabel}
    </Box>
  )

  // Team Size: one segmented control.
  const chips = PRESET_SIZES.map(size => {
    const isPicked = settings.teamSize === size && settings.pendingSize === null
    return (
      <Button key={`size-${size}`} plain onPress={() => void chooseSize($, size)}>
        {isPicked ? (
          <Text backgroundColor={COLORS.coral} color={COLORS.ink} weight="bold">{` ${size} `}</Text>
        ) : (
          <Text color={COLORS.muted}>{` ${size} `}</Text>
        )}
      </Button>
    )
  })
  const isCustomSize = !PRESET_SIZES.includes(settings.teamSize)
  const sizeControl = (
    <Box flexDirection="row" flexWrap="wrap">
      <Text color={COLORS.muted}>{`${spaced('TEAM')}  ${spaced('SIZE')}   `}</Text>
      <Text color={COLORS.hairline}>╭</Text>
      {chips}
      <Text color={COLORS.hairline}> │ </Text>
      <Button key="size-custom" plain onPress={() => void changeSettings($, s => ({ ...s, isCustomOpen: !s.isCustomOpen }))}>
        {isCustomSize ? (
          <Text backgroundColor={COLORS.coral} color={COLORS.ink} weight="bold">{` Custom ${settings.teamSize} `}</Text>
        ) : (
          <Text color={COLORS.muted}>Custom</Text>
        )}
      </Button>
      <Text color={COLORS.hairline}> ╮</Text>
    </Box>
  )
  const customBox =
    settings.isCustomOpen && Input !== undefined ? (
      <Box flexDirection="row">
        <Input
          key="custom-size"
          label="How many helpers?"
          placeholder="1 to 100"
          submitLabel="Set"
          autoFocus
          onSubmit={value => {
            const size = parseSize(value)
            if (size === null) {
              showToast($, BAD_CUSTOM_SIZE)
              return
            }
            void chooseSize($, size)
          }}
        />
      </Box>
    ) : null

  // Helper model: Auto per agent (the default), Fast & Cheap, or the session's own model.
  const modelChoice = (choice: DockHelperModel) => {
    const isPicked = settings.helperModel === choice
    return (
      <Button key={`model-${choice}`} plain onPress={() => void changeSettings($, s => ({ ...s, helperModel: choice, hasChosenHelperModel: true }))}>
        {isPicked ? (
          <Text backgroundColor={COLORS.coral} color={COLORS.ink} weight="bold">{` ${helperModelLabel(choice)} `}</Text>
        ) : (
          <Text color={COLORS.muted}>{` ${helperModelLabel(choice)} `}</Text>
        )}
      </Button>
    )
  }
  const modelRow = (
    <Box flexDirection="row" flexWrap="wrap">
      <Text color={COLORS.muted}>Helper agents  </Text>
      {HELPER_MODELS.map((choice, index) => [
        index > 0 ? <Text color={COLORS.hairline}> / </Text> : null,
        modelChoice(choice),
      ])}
    </Box>
  )

  // A big team waits for Continue.
  const bigTeamBox =
    settings.pendingSize !== null ? (
      <Box key="big-team" borderStyle="round" borderColor={COLORS.gold} paddingX={1} flexDirection="column" width={width}>
        <Text color={COLORS.gold}>{bigTeamQuestion()}</Text>
        <Box flexDirection="row" gap={2}>
          <Button key="big-team-continue" variant="primary" onPress={() => void confirmPendingSize($)}>
            {`Continue with ${settings.pendingSize}`}
          </Button>
          <Button key="big-team-cancel" onPress={() => void changeSettings($, s => ({ ...s, pendingSize: null }))}>
            Cancel
          </Button>
        </Box>
      </Box>
    ) : null

  const header = (
    <Box flexDirection="column" width={width}>
      {masthead}
      <Text color={COLORS.hairline}>{'─'.repeat(width)}</Text>
      {sizeControl}
      {customBox}
      <Text color={COLORS.muted} wrap="truncate-end">
        {infoLine(settings.teamSize, atOnce, settings.helperModel)}
      </Text>
      {modelRow}
      {bigTeamBox}
    </Box>
  )

  if (!hasCards || mission === null) {
    return (
      <Box flexDirection="column" width={width} gap={1}>
        {header}
        {drawIdle(Text, Box, settings.teamSize)}
      </Box>
    )
  }

  // Mission: name, percent, time, the bar and the counts.
  const counts = countCards(mission.cards)
  const missionRow = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text wrap="truncate-end">
        <Text color={COLORS.muted}>{`${spaced('MISSION')}   `}</Text>
        <Text weight="bold">{mission.title}</Text>
      </Text>
      <Text>
        <Text weight="bold">{`${missionPercent(mission.cards)}%`}</Text>
        <Text color={COLORS.muted}>{`   ${formatClock(missionElapsed(mission, now))}`}</Text>
      </Text>
    </Box>
  )
  const countsRow = (
    <Text wrap="truncate-end">
      <Text color={COLORS.green}>{`● ${counts.working} working`}</Text>
      <Text color={COLORS.muted}>{`    ○ ${counts.queued} queued`}</Text>
      <Text color={COLORS.gold}>{`    ✓ ${counts.done} done`}</Text>
      <Text color={counts.stuck > 0 ? COLORS.red : COLORS.muted}>{`    ✕ ${counts.stuck} stuck`}</Text>
    </Text>
  )
  const summary =
    mission.finishedAt !== null ? (
      <Box key="summary" borderStyle="round" borderColor={COLORS.green} paddingX={1} width={width}>
        <Text wrap="truncate-end">
          <Text color={COLORS.green}>✓ </Text>
          {summaryLine(mission, now)}
        </Text>
      </Box>
    ) : null

  const layout = cardLayout(width, mission.cards.length)
  const faceOf = (card: DockCard) => {
    const picture = headshots.length > 0 ? headshots[card.seat % headshots.length] : undefined
    if (Image !== undefined && picture !== undefined) {
      return (
        <Image
          key={`face-${card.id}`}
          source={{ file: `${$.plugin.root}/${HEADSHOT_FOLDER}/${picture}`, format: 'png' }}
          columns={2}
          rows={1}
          alt={card.initials}
        />
      )
    }
    return (
      <Text backgroundColor={card.status === 'stuck' ? COLORS.red : seatColor(card.seat)} color={COLORS.ink} weight="bold">
        {card.initials}
      </Text>
    )
  }

  const helpers =
    layout.mode === 'cards'
      ? mission.cards.map(card => drawCard(Text, Box, card, faceOf(card), layout.width, frame, now))
      : mission.cards.map(card => drawTile(Text, Box, card, layout.width, frame))

  return (
    <Box flexDirection="column" width={width}>
      {header}
      <Text> </Text>
      {missionRow}
      {missionBar(Text, mission.cards, width, frame)}
      {countsRow}
      <Text> </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={width}>
        {helpers}
      </Box>
      {summary}
    </Box>
  )
}

type BoxElement = Elements['terminal']['Box']

/** One helper's card: face, task, timer and meter. */
function drawCard(
  Text: TextElement,
  Box: BoxElement,
  card: DockCard,
  face: RenderElement,
  cardWidth: number,
  frame: number,
  now: number,
): RenderElement {
  const isQueued = card.status === 'queued'
  const innerWidth = Math.max(10, cardWidth - 4)
  const meterWidth = Math.max(4, innerWidth - 4 - 7)
  const clock = isQueued ? '–:––' : formatClock(cardElapsed(card, now))

  return (
    <Box
      key={`card-${card.id}`}
      borderStyle="round"
      borderColor={card.status === 'stuck' ? COLORS.red : COLORS.hairline}
      hover={{ borderColor: COLORS.coral }}
      width={cardWidth}
      paddingX={1}
      flexDirection="column"
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1}>
          {face}
          <Text dimColor={isQueued} weight="bold" wrap="truncate-end">{`  ${card.task}`}</Text>
        </Box>
        <Text color={COLORS.muted} dimColor={isQueued}>{` ${clock}`}</Text>
      </Box>
      <Text wrap="truncate-end">
        {'    '}
        {cardMeter(Text, card, meterWidth, frame)}
        <Text dimColor={isQueued} color={card.status === 'stuck' ? COLORS.red : undefined}>{` ${percentLabel(card).padStart(6)}`}</Text>
      </Text>
    </Box>
  )
}

/** One helper as a small tile, for teams above 12. */
function drawTile(Text: TextElement, Box: BoxElement, card: DockCard, tileWidth: number, frame: number): RenderElement {
  const isQueued = card.status === 'queued'
  const badgeColor = card.status === 'stuck' ? COLORS.red : seatColor(card.seat)
  const label = card.status === 'done' ? ' ✓  ' : card.status === 'stuck' ? ' ✕  ' : isQueued ? ' ·  ' : card.hasReported ? `${String(card.percent).padStart(3)}%` : ' …  '

  return (
    <Box key={`tile-${card.id}`} width={tileWidth}>
      <Text wrap="truncate-end" dimColor={isQueued}>
        <Text backgroundColor={badgeColor} color={COLORS.ink} weight="bold">{card.initials}</Text>
        {' '}
        {cardMeter(Text, card, 7, frame)}
        <Text color={card.status === 'done' ? COLORS.gold : card.status === 'stuck' ? COLORS.red : undefined}>{` ${label}`}</Text>
      </Text>
    </Box>
  )
}

/** The idle dock: one seat per team member, and what a request will do. */
function drawIdle(Text: TextElement, Box: BoxElement, teamSize: number): RenderElement {
  const seats = Array.from({ length: Math.min(teamSize, MAX_SEATS) }, (_, seat) => (
    <Text color={seatColor(seat)}>{'● '}</Text>
  ))
  const more = teamSize > MAX_SEATS ? <Text color={COLORS.muted}>{`+${teamSize - MAX_SEATS}`}</Text> : null
  const promise =
    teamSize <= 1 ? 'Send a request and Claude decides how many helpers.' : `Send a request and it splits across ${teamSize} helpers.`

  return (
    <Box flexDirection="column" gap={0}>
      <Text>
        {seats}
        {more}
      </Text>
      <Text weight="bold">{`Your team of ${teamSize} is standing by`}</Text>
      <Text color={COLORS.muted}>{promise}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function registerAgentDock(on: On): void {
  // Session start (and each reload): settings from the store once a session, /dock, headshots, clock.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    try {
      const held = await $.state.get(dockRef)
      if (held.version === 0) {
        const savedSize = await $.store.get(STORE_TEAM_SIZE)
        const savedModel = await $.store.get(STORE_HELPER_MODEL)
        const savedChosen = await $.store.get(STORE_HELPER_MODEL_CHOSEN)
        const teamSize = restoreSize(savedSize)
        const helperModel = restoreHelperModel(savedModel, savedChosen)
        await update($, settingsAtom, () => ({
          ...DEFAULT_DOCK_SETTINGS,
          teamSize,
          helperModel,
          hasChosenHelperModel: savedChosen === true,
        }))
        if (savedSize !== undefined && savedSize !== teamSize) await $.store.set(STORE_TEAM_SIZE, teamSize)
      } else {
        // A model the person never picked follows the default, Auto (this also moves older sessions over).
        await update($, settingsAtom, (settings): DockSettings =>
          settings.hasChosenHelperModel === true
            ? settings
            : { ...settings, helperModel: 'auto', hasChosenHelperModel: false },
        )
      }
    } catch {
      // Defaults stand: a team of 1.
    }
    await $.command.register({
      name: 'dock',
      description: 'Open or fold the Agent Dock, or set its Team Size (/dock 10)',
      argumentHint: '[size]',
      immediate: true,
    })
    await loadHeadshots($)
    await afterMissionChange($)

    return next(e)
  })

  // Every request at a Team Size above 1 carries the split instruction.
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || e.turnId !== undefined) return next(e)

    const settings = await read($, settingsAtom)
    // A plugin sending the person's own words (Prompt Upgrade's Run) counts as the person's request.
    const isSentAsPerson = e.origin.kind === 'plugin' && e.origin.asUser === true
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk' || isSentAsPerson
    const isOwnNudge = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name

    if (isPerson) {
      const now = await $.clock.now()
      await update($, missionAtom, mission => startMission(mission?.id ?? 0, e.text, settings.teamSize, now))
      await afterMissionChange($)
    }
    if (settings.teamSize <= 1 || (!isPerson && !isOwnNudge)) return next(e)

    const sessionModel = await sessionModelAlias($)
    const instruction = isOwnNudge
      ? helperRules(settings.helperModel, sessionModel)
      : instructionText(settings.teamSize, settings.helperModel, sessionModel)

    return next({ ...e, context: [...(e.context ?? []), instruction] })
  }).catch(($, e, next) => next(e))

  // Cards appear as soon as Claude writes its Agent calls.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const agentCalls = e.message.content.filter(block => block.type === 'tool_use' && block.name === 'Agent')
        if (agentCalls.length > 0) {
          const now = await $.clock.now()
          await changeMission($, mission =>
            agentCalls.reduce((current, block) => {
              const input = (block.input ?? {}) as { description?: unknown }
              return queueCard(current, String(block.id), input.description, now)
            }, mission),
          )
        }
      }
    } catch {
      // Cards are a view: the row is stored either way.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each Agent call: the Team Size cap, the queue past the engine's limit, the helper model, the card.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // Helpers' own agents pass untouched.
    if (e.agentId !== undefined) return next(e)

    const settings = await read($, settingsAtom)
    const size = settings.teamSize
    const isFork = e.subagent_type === 'fork'

    // Auto: Claude names each helper's model for its own task; a helper with none is sent back with the fix.
    const agentType = e.subagent_type ?? 'general-purpose'
    if (size > 1 && settings.helperModel === 'auto' && e.model === undefined && !isFork && UNPINNED_AGENT_TYPES.has(agentType)) {
      return { deny: autoModelMessage(await sessionModelAlias($)) }
    }

    // The cap: at most Team Size helpers per request.
    let isOverCap = false
    await changeMission($, mission => {
      isOverCap = size > 1 && mission.admittedCalls >= size
      return isOverCap ? mission : { ...mission, admittedCalls: mission.admittedCalls + 1 }
    })
    if (isOverCap) {
      const now = await $.clock.now()
      await changeMission($, mission => removeCard(mission, e.tool_use_id, now))
      return { deny: capMessage(size) }
    }

    // The queue: hold the call while the engine's limit is full; a held call does not burn the hook's budget.
    const limit = await atOnceOf($)
    while (runningHelpers >= limit) {
      if (next.signal.aborted) {
        const now = await $.clock.now()
        await changeMission($, mission => finishCard(mission, e.tool_use_id, true, now))
        return { deny: STOPPED_MESSAGE }
      }
      try {
        await $.process.run(['/bin/sleep', '1'])
      } catch {
        break
      }
    }
    if (next.signal.aborted) {
      const now = await $.clock.now()
      await changeMission($, mission => finishCard(mission, e.tool_use_id, true, now))
      return { deny: STOPPED_MESSAGE }
    }

    // The helper model: Fast & Cheap and Same as you fill in a model Claude left out;
    // Auto fills only the effort of the tier Claude picked, unless that tier is the session's own.
    let call = e
    if (size > 1 && !isFork) {
      const sessionModel = await sessionModelAlias($)
      if (e.model === undefined && settings.helperModel !== 'auto') {
        const model = settings.helperModel === 'fast' ? 'haiku' : sessionModel
        if (model === 'haiku' || model === 'sonnet' || model === 'opus' || model === 'fable') {
          call = { ...e, model, ...(model === 'haiku' && e.effort === undefined ? { effort: 'low' as const } : {}) }
        }
      } else if (e.model !== undefined && e.effort === undefined && e.model !== sessionModel) {
        const effort = defaultEffortFor(e.model)
        if (effort !== undefined) call = { ...e, effort }
      }
    }

    const startedAt = await $.clock.now()
    await changeMission($, mission => startCard(mission, e.tool_use_id, e.description, startedAt))
    runningHelpers += 1
    const ran = await next(call).finally(() => {
      runningHelpers = Math.max(0, runningHelpers - 1)
    })

    const finishedAt = await $.clock.now()
    if (ran.deny !== undefined) {
      // Refused below the dock: it never became a helper.
      await changeMission($, mission => dropCard(mission, e.tool_use_id, finishedAt))
    } else {
      await changeMission($, mission => finishCard(mission, e.tool_use_id, ran.isError === true, finishedAt))
    }

    return ran
  }).catch(($, e, next) => next(e)) // Never block work on a fault of the dock.

  // Link each helper's agent id to its card.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId !== undefined && e.parentAgentId === undefined && e.workflow === undefined) {
      const agentId = spawned.agentId
      await update($, missionAtom, mission => (mission === null ? null : linkAgent(mission, e.tool_use_id, agentId)))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  // Helpers report progress onto their own card, then the report goes on to Clean View; they skip the plan.
  on('tool.call', { tool: /^mcp__clean-view__(report_progress|plan_steps)$/, agentId: /./ }, async ($, e, next) => {
    const toolName = String(e.tool)
    if (toolName.endsWith('plan_steps')) return { result: HELPERS_SKIP_PLAN }

    const callInput = e as unknown as Record<string, unknown>
    const percent = clampPercent(callInput.percent)
    const agentId = String(callInput.agentId ?? '')
    await update($, missionAtom, mission => (mission === null ? null : reportHelper(mission, agentId, callInput.task, percent)))
    await afterMissionChange($)

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'Progress noted.' }))

  // The end of the main turn: unstarted helpers are stuck; a short-handed request gets one nudge.
  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    try {
      const now = await $.clock.now()
      const settings = await read($, settingsAtom)
      let nudge: string | null = null
      await update($, missionAtom, mission => {
        nudge = null
        if (mission === null) return null
        const ended = endTurn(mission, now)
        const isAnswered = e.reason === 'answer' && !e.isAborted
        if (!isAnswered || !shouldNudge(ended, settings.teamSize)) return ended
        nudge = nudgeText(ended.admittedCalls, settings.teamSize)
        return { ...ended, hasNudged: true }
      })
      await afterMissionChange($)
      const nudgeToSend: string | null = nudge
      if (nudgeToSend !== null) void $.prompt.submit({ text: nudgeToSend }).catch(() => undefined)
    } catch {
      // The answer stands either way.
    }
    return result
  })

  // /dock folds or opens the pane; /dock N sets the Team Size.
  on('command.run', { command: 'dock' }, ($, e) => {
    try {
      const action = dockCommand(e.args)
      if (action.kind === 'invalid') return { text: BAD_COMMAND_SIZE }
      if (action.kind === 'toggle') {
        void toggleDock($).catch(() => undefined)
        return { text: 'Agent Dock toggled. Type /dock again to switch back.' }
      }
      if (action.kind === 'confirm') {
        void (async () => {
          await changeSettings($, settings => ({ ...settings, pendingSize: action.size, isCustomOpen: false }))
          await openDock($)
        })().catch(() => undefined)
        return { text: `Confirm the team of ${action.size} in the Agent Dock.` }
      }
      void (async () => {
        await chooseSize($, action.size)
        await openDock($)
      })().catch(() => undefined)
      return { text: `Team Size is now ${action.size}.` }
    } catch {
      return { text: 'The Agent Dock hit a problem. Try /dock again.' }
    }
  })

  // The dock pane.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => drawDock($, e))

  // A small ◆ Dock button beside the line under the prompt.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const settings = await read($, settingsAtom)

    return (
      <Box flexDirection="row" alignItems="flex-start">
        {engineLine}
        <Box marginLeft={2} flexShrink={0}>
          <Button key="open-dock" plain onPress={() => void toggleDock($).catch(() => undefined)}>
            <Text color={COLORS.coral}>◆</Text>
            <Text color={COLORS.muted}>{settings.teamSize > 1 ? ` Dock ${settings.teamSize}` : ' Dock'}</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
