export type NodeStatus = 'pending' | 'active' | 'done' | 'blocked' | 'skipped'
export type NodeKind = 'milestone' | 'task' | 'subtask'

/** What one finished node cost, measured between its start and its end. */
export type NodeCost = {
  ms: number
  /** five_hour window points spent; absent when no rate-limit reading existed. */
  fiveHourPct?: number
  /** context tokens grown; absent when no context reading existed. */
  contextTokens?: number
}

export type PlanNode = {
  id: string
  title: string
  kind: NodeKind
  status: NodeStatus
  parent?: string
  deps: string[]
  checkpoint?: boolean
  note?: string
  startedAt?: number
  doneAt?: number
  /** The usage reading when the node started, to measure its cost at the end. */
  startMark?: StartMark
  cost?: NodeCost
}

export type StartMark = { fiveHour?: number; fiveHourResets?: string; contextTokens?: number }

/** `tool`: the model's own plan tool; `todo`/`tasks`: mirrored from TodoWrite / Task* tools. */
export type PlanSource = 'tool' | 'todo' | 'tasks'

export type Plan = {
  title: string
  goal?: string
  nodes: PlanNode[]
  source: PlanSource
  updatedAt: number
}

export type GateKind = 'checkpoint' | 'limit' | 'pause' | 'handoff'

/** An engaged stop: the run reached a point where the person decides. */
export type Gate = {
  kind: GateKind
  taskId?: string
  reason: string
  at: number
}

export type Controls = {
  /** Stop when the current task (or turn, with no plan) completes. */
  pauseAtNext: boolean
  /** Stop once this node is done. */
  limitTaskId?: string
  /** Do not start a task outside the active milestone until it is complete. */
  focusUnit: boolean
  /** Finish the smallest useful unit, verify, then write a handoff. */
  handoffRequested: boolean
  handoffRequestedAt?: number
  /** How many times the Stop hook already sent the model back for the handoff. */
  stopBlocks: number
  /** A message for the model, delivered with the next tool result or prompt. */
  notice?: string
  /** Effort sent on each main-loop request, where no /effort command exists. */
  effortOverride?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type UsageSample = {
  t: number
  contextPct?: number
  contextTokens?: number
  window?: number
  fiveHour?: number
  fiveHourResets?: string
  sevenDay?: number
  sevenDayResets?: string
  usd?: number
}

export type TestRun = { command: string; ok: boolean; at: number }

export type Activity = {
  /** Edit/Write counts per file this session. */
  edits: Record<string, number>
  tests: TestRun[]
  /** Outcome of the last tool calls, newest last (true = error). */
  recentErrors: boolean[]
  /** Commands that failed, with how many times in a row. */
  failingRepeats: Record<string, number>
  compactions: number
  turns: number
  model?: string
  effort?: string
  startedAt: number
}

export type Provenance = 'official' | 'estimate' | 'heuristic' | 'unavailable'

export type DerivedForecast = {
  kind: 'five_hour' | 'seven_day'
  used?: number
  resetsAt?: string
  perHour?: number
  basisMin?: number
  etaMs?: number
  risk: 'low' | 'medium' | 'high' | 'unknown'
  provenance: Provenance
}

export type DerivedHealth = {
  score: number
  grade: 'good' | 'fair' | 'degraded' | 'poor'
  factors: { label: string; delta: number; provenance: Provenance }[]
}

/**
 * What the drawings read about usage and health, computed from the raw samples
 * and activity and written only when it changes, so a tool call that changes
 * nothing visible redraws nothing.
 */
export type Derived = {
  sample?: UsageSample
  five: DerivedForecast
  seven: DerivedForecast
  health: DerivedHealth
  model?: string
  effort?: string
  /** The activity the recommendations look at: compactions, commands failing in a loop, files edited over and over. */
  signals: Pick<Activity, 'compactions' | 'failingRepeats' | 'edits'>
}

export type HandoffDraft = { path: string; markdown: string; createdAt: number }

export type ResumeOffer = { path: string; createdAt: number; nextStep?: string }

export type PaneView = 'plan' | 'health' | 'handoff'

export type View = {
  pane: PaneView
  selected?: string
  collapsed: string[]
  /** Band hidden by the person. */
  isBandHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-pilot': {
      plan: Plan | null
      gate: Gate | null
      controls: Controls
      samples: UsageSample[]
      activity: Activity
      handoff: HandoffDraft | null
      resume: ResumeOffer | null
      view: View
      commands: string[]
      derived: Derived
    }
  }
}
