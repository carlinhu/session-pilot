// Pure logic of session-pilot: the plan, health, forecasts, recommendations
// and the handoff document. No `$` here, so every function is testable alone.

import type {
  Activity,
  Controls,
  Gate,
  NodeKind,
  Plan,
  PlanNode,
  PlanSource,
  StartMark,
  UsageSample,
} from '../types'

// ---------------------------------------------------------------- plan input

export type PlanItemInput = {
  id?: string
  title: string
  checkpoint?: boolean
  deps?: string[]
  status?: PlanNode['status']
  items?: PlanItemInput[]
}

export type PlanSetInput = {
  title: string
  goal?: string
  milestones: PlanItemInput[]
}

export type PlanUpdateInput = {
  start?: string
  done?: string[]
  block?: { id: string; reason: string }
  skip?: string[]
  note?: { id: string; text: string }
  add?: { parent?: string; items: PlanItemInput[] }
}

const KINDS: NodeKind[] = ['milestone', 'task', 'subtask']

/** Builds a plan from the nested input; finished work of `previous` is kept by id, then by title. */
export function buildPlan(
  input: PlanSetInput,
  now: number,
  source: PlanSource,
  previous: Plan | null,
): Plan {
  const nodes: PlanNode[] = []
  const usedIds = new Set<string>()
  const walk = (items: PlanItemInput[], depth: number, parent: PlanNode | undefined) => {
    items.forEach((item, index) => {
      const kind = KINDS[Math.min(depth, 2)] as NodeKind
      const fallback = parent ? `${parent.id}.${index + 1}` : `M${index + 1}`
      let id = (item.id ?? fallback).trim() || fallback
      while (usedIds.has(id)) id = `${id}'`
      usedIds.add(id)
      const old =
        previous?.nodes.find(n => n.id === id && n.title === item.title) ??
        previous?.nodes.find(n => n.title === item.title)
      const node: PlanNode = {
        id,
        title: item.title,
        kind,
        status: item.status ?? old?.status ?? 'pending',
        parent: parent?.id,
        deps: item.deps ?? [],
        checkpoint: item.checkpoint ?? old?.checkpoint,
        note: old?.note,
        startedAt: old?.startedAt,
        doneAt: old?.doneAt,
        startMark: old?.startMark,
        cost: old?.cost,
      }
      nodes.push(node)
      if (item.items?.length) walk(item.items, depth + 1, node)
    })
  }
  walk(input.milestones, 0, undefined)
  return rollUp({ title: input.title, goal: input.goal, nodes, source, updatedAt: now }, now)
}

export function childrenOf(plan: Plan, id: string | undefined): PlanNode[] {
  return plan.nodes.filter(n => n.parent === id)
}

export function findNode(plan: Plan, id: string): PlanNode | undefined {
  return plan.nodes.find(n => n.id === id) ?? plan.nodes.find(n => n.id.toLowerCase() === id.toLowerCase())
}

/** Depth-first order, as the plan reads top to bottom. */
export function ordered(plan: Plan): PlanNode[] {
  const out: PlanNode[] = []
  const visit = (parent: string | undefined) => {
    for (const n of childrenOf(plan, parent)) {
      out.push(n)
      visit(n.id)
    }
  }
  visit(undefined)
  return out
}

export function leaves(plan: Plan): PlanNode[] {
  return ordered(plan).filter(n => !plan.nodes.some(c => c.parent === n.id))
}

export function depth(plan: Plan, node: PlanNode): number {
  let d = 0
  let p = node.parent
  while (p !== undefined && d < 8) {
    d += 1
    p = plan.nodes.find(n => n.id === p)?.parent
  }
  return d
}

export function ancestors(plan: Plan, node: PlanNode): PlanNode[] {
  const out: PlanNode[] = []
  let p = node.parent
  while (p !== undefined && out.length < 8) {
    const parent = plan.nodes.find(n => n.id === p)
    if (!parent) break
    out.push(parent)
    p = parent.parent
  }
  return out
}

/** A parent is done when every child is done or skipped, active when any child is. */
export function rollUp(plan: Plan, now: number): Plan {
  const nodes = plan.nodes.map(n => ({ ...n }))
  const byId = new Map(nodes.map(n => [n.id, n]))
  const order = ordered({ ...plan, nodes }).reverse()
  for (const node of order) {
    const kids = nodes.filter(c => c.parent === node.id)
    if (kids.length === 0) continue
    const isFinished = kids.every(k => k.status === 'done' || k.status === 'skipped')
    const isMoving = kids.some(k => k.status === 'active' || k.status === 'done')
    const target = byId.get(node.id)!
    if (isFinished && target.status !== 'done') {
      target.status = 'done'
      target.doneAt = now
    } else if (!isFinished && target.status === 'done') {
      target.status = 'active'
      target.doneAt = undefined
    } else if (!isFinished && isMoving && target.status === 'pending') {
      target.status = 'active'
      target.startedAt = target.startedAt ?? now
    }
  }
  return { ...plan, nodes }
}

export type UpdateOutcome = {
  plan: Plan
  /** Ids that became done in this update, parents rolled up included. */
  finished: string[]
  errors: string[]
}

export function applyUpdate(
  plan: Plan,
  input: PlanUpdateInput,
  now: number,
  sample: UsageSample | undefined,
): UpdateOutcome {
  const errors: string[] = []
  const nodes = plan.nodes.map(n => ({ ...n }))
  const wasDone = new Set(nodes.filter(n => n.status === 'done').map(n => n.id))
  const get = (id: string) => {
    const found = nodes.find(n => n.id === id) ?? nodes.find(n => n.id.toLowerCase() === id.toLowerCase())
    if (!found) errors.push(`unknown id "${id}" (valid: ${nodes.map(n => n.id).join(', ')})`)
    return found
  }

  if (input.add) {
    const parent = input.add.parent ? get(input.add.parent) : undefined
    if (!input.add.parent || parent) {
      const base = parent ? depth({ ...plan, nodes }, parent) + 1 : 0
      const existing = nodes.filter(n => n.parent === parent?.id).length
      const used = new Set(nodes.map(n => n.id))
      const walk = (items: PlanItemInput[], d: number, par: PlanNode | undefined, offset: number) => {
        items.forEach((item, i) => {
          const fallback = par ? `${par.id}.${offset + i + 1}` : `M${offset + i + 1}`
          let id = (item.id ?? fallback).trim() || fallback
          while (used.has(id)) id = `${id}'`
          used.add(id)
          const node: PlanNode = {
            id,
            title: item.title,
            kind: KINDS[Math.min(d, 2)] as NodeKind,
            status: item.status ?? 'pending',
            parent: par?.id,
            deps: item.deps ?? [],
            checkpoint: item.checkpoint,
          }
          nodes.push(node)
          if (item.items?.length) walk(item.items, d + 1, node, 0)
        })
      }
      walk(input.add.items, base, parent, existing)
    }
  }

  if (input.start) {
    const node = get(input.start)
    if (node) {
      const open = node.deps.filter(d => nodes.find(n => n.id === d)?.status !== 'done')
      if (open.length) errors.push(`${node.id} depends on unfinished ${open.join(', ')}`)
      node.status = 'active'
      node.startedAt = now
      node.cost = undefined
      node.startMark = markOf(sample)
    }
  }

  for (const id of input.done ?? []) {
    const node = get(id)
    if (!node) continue
    node.status = 'done'
    node.doneAt = now
    node.cost = costBetween(node, now, sample)
  }

  for (const id of input.skip ?? []) {
    const node = get(id)
    if (node) node.status = 'skipped'
  }

  if (input.block) {
    const node = get(input.block.id)
    if (node) {
      node.status = 'blocked'
      node.note = input.block.reason
    }
  }

  if (input.note) {
    const node = get(input.note.id)
    if (node) node.note = input.note.text
  }

  const rolled = rollUp({ ...plan, nodes, updatedAt: now }, now)
  const finished = rolled.nodes.filter(n => n.status === 'done' && !wasDone.has(n.id)).map(n => n.id)
  return { plan: rolled, finished, errors }
}

export function markOf(sample: UsageSample | undefined): StartMark | undefined {
  if (!sample) return undefined
  return { fiveHour: sample.fiveHour, fiveHourResets: sample.fiveHourResets, contextTokens: sample.contextTokens }
}

function costBetween(node: PlanNode, now: number, end: UsageSample | undefined) {
  const begin = node.startMark
  const ms = node.startedAt ? Math.max(0, now - node.startedAt) : 0
  const sameWindow = begin?.fiveHourResets !== undefined && begin.fiveHourResets === end?.fiveHourResets
  return {
    ms,
    fiveHourPct:
      sameWindow && begin?.fiveHour !== undefined && end?.fiveHour !== undefined
        ? Math.max(0, round1(end.fiveHour - begin.fiveHour))
        : undefined,
    contextTokens:
      begin?.contextTokens !== undefined && end?.contextTokens !== undefined
        ? end.contextTokens - begin.contextTokens
        : undefined,
  }
}

export type Progress = { done: number; total: number; pct: number }

export function progress(plan: Plan | null): Progress {
  if (!plan) return { done: 0, total: 0, pct: 0 }
  const ls = leaves(plan).filter(n => n.status !== 'skipped')
  const done = ls.filter(n => n.status === 'done').length
  return { done, total: ls.length, pct: ls.length ? Math.round((done / ls.length) * 100) : 0 }
}

/** The deepest active node, the work under way. */
export function current(plan: Plan | null): PlanNode | undefined {
  if (!plan) return undefined
  const active = ordered(plan).filter(n => n.status === 'active')
  return active.sort((a, b) => depth(plan, b) - depth(plan, a))[0]
}

/** Pending leaves whose dependencies are done, in plan order. */
export function upNext(plan: Plan | null, count: number): PlanNode[] {
  if (!plan) return []
  const isDone = (id: string) => plan.nodes.find(n => n.id === id)?.status === 'done'
  return leaves(plan)
    .filter(n => n.status === 'pending' && n.deps.every(isDone))
    .slice(0, count)
}

export function milestoneOf(plan: Plan, node: PlanNode): PlanNode {
  return ancestors(plan, node).at(-1) ?? node
}

export function nodeProgress(plan: Plan, node: PlanNode): Progress {
  const ids = new Set<string>()
  const visit = (id: string) => {
    for (const c of plan.nodes.filter(n => n.parent === id)) {
      ids.add(c.id)
      visit(c.id)
    }
  }
  visit(node.id)
  const ls = leaves(plan).filter(n => ids.has(n.id) && n.status !== 'skipped')
  if (ls.length === 0) return { done: node.status === 'done' ? 1 : 0, total: 1, pct: node.status === 'done' ? 100 : 0 }
  const done = ls.filter(n => n.status === 'done').length
  return { done, total: ls.length, pct: Math.round((done / ls.length) * 100) }
}

export const GLYPH: Record<PlanNode['status'], string> = {
  done: '✓',
  active: '●',
  pending: '○',
  blocked: '⊘',
  skipped: '–',
}

export function planText(plan: Plan): string {
  const lines = [`Plan: ${plan.title}${plan.goal ? ` — ${plan.goal}` : ''}`]
  for (const n of ordered(plan)) {
    const pad = '  '.repeat(depth(plan, n))
    const extra = [
      n.checkpoint ? 'checkpoint' : '',
      n.deps.length ? `after ${n.deps.join(',')}` : '',
      n.note ? `note: ${n.note}` : '',
    ].filter(Boolean)
    lines.push(`${pad}${GLYPH[n.status]} ${n.id} ${n.title}${extra.length ? ` (${extra.join('; ')})` : ''}`)
  }
  return lines.join('\n')
}

/** Mirrors a TodoWrite list into a flat plan, keeping costs of matching titles. */
export function planFromTodos(
  todos: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[],
  previous: Plan | null,
  now: number,
  sample: UsageSample | undefined,
): Plan {
  const nodes: PlanNode[] = todos.map((t, i) => {
    const old = previous?.nodes.find(n => n.title === t.content)
    const status = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending'
    const isStarting = status === 'active' && old?.status !== 'active'
    const isFinishing = status === 'done' && old !== undefined && old.status !== 'done'
    const node: PlanNode = {
      id: `T${i + 1}`,
      title: t.content,
      kind: 'task',
      status,
      deps: [],
      checkpoint: old?.checkpoint,
      startedAt: isStarting ? now : old?.startedAt,
      doneAt: old?.doneAt ?? (status === 'done' ? now : undefined),
      startMark: isStarting ? markOf(sample) : old?.startMark,
      cost: old?.cost,
    }
    if (isFinishing) node.cost = costBetween(node, now, sample)
    return node
  })
  return { title: previous?.source === 'todo' ? previous.title : 'Todo list', nodes, source: 'todo', updatedAt: now }
}

// ---------------------------------------------------------------- gates

/** Which gate the completion of `finished` engages, if any. Handoff wins, then limit, checkpoint, pause. */
export function gateFor(plan: Plan, finished: string[], controls: Controls, now: number): Gate | null {
  if (finished.length === 0) return null
  const nodes = finished.map(id => plan.nodes.find(n => n.id === id)).filter(n => n !== undefined)
  const title = (n: PlanNode) => `${n.id} ${n.title}`
  if (controls.handoffRequested) {
    return { kind: 'handoff', taskId: nodes[0]?.id, reason: `${title(nodes[0]!)} finished; handoff requested`, at: now }
  }
  const limit = nodes.find(n => n.id === controls.limitTaskId)
  if (limit) return { kind: 'limit', taskId: limit.id, reason: `Execution limit reached: ${title(limit)}`, at: now }
  const checkpoint = nodes.find(n => n.checkpoint)
  if (checkpoint) return { kind: 'checkpoint', taskId: checkpoint.id, reason: `Checkpoint: ${title(checkpoint)}`, at: now }
  if (controls.pauseAtNext) {
    return { kind: 'pause', taskId: nodes[0]!.id, reason: `Paused after ${title(nodes[0]!)}`, at: now }
  }
  return null
}

/** Whether starting `id` breaks "finish the functional unit first". */
export function breaksFocus(plan: Plan, id: string): string | undefined {
  const node = findNode(plan, id)
  if (!node) return undefined
  const target = milestoneOf(plan, node)
  const open = plan.nodes.filter(
    n => n.kind === 'milestone' && n.status === 'active' && n.id !== target.id && nodeProgress(plan, n).pct < 100,
  )
  return open.length ? `milestone ${open[0]!.id} "${open[0]!.title}" is not finished` : undefined
}

// ---------------------------------------------------------------- usage & health

export type Provenance = 'official' | 'estimate' | 'heuristic' | 'unavailable'

export type WindowForecast = {
  kind: 'five_hour' | 'seven_day'
  used?: number
  resetsAt?: string
  /** points per hour over the observed basis; estimate. */
  perHour?: number
  basisMin?: number
  /** ms until 100% at the observed pace; estimate. */
  etaMs?: number
  risk: 'low' | 'medium' | 'high' | 'unknown'
  provenance: Provenance
}

export function latest(samples: UsageSample[]): UsageSample | undefined {
  return samples.at(-1)
}

export function forecastWindow(
  samples: UsageSample[],
  kind: 'five_hour' | 'seven_day',
  now: number,
): WindowForecast {
  const pick = (s: UsageSample) => (kind === 'five_hour' ? s.fiveHour : s.sevenDay)
  const resetOf = (s: UsageSample) => (kind === 'five_hour' ? s.fiveHourResets : s.sevenDayResets)
  const last = [...samples].reverse().find(s => pick(s) !== undefined)
  if (!last) return { kind, risk: 'unknown', provenance: 'unavailable' }
  const used = pick(last)!
  const resetsAt = resetOf(last)
  const lookback = kind === 'five_hour' ? 90 * 60_000 : 24 * 3_600_000
  const basis = samples.filter(
    s => pick(s) !== undefined && resetOf(s) === resetsAt && last.t - s.t <= lookback,
  )
  const first = basis[0]
  let perHour: number | undefined
  let basisMin: number | undefined
  if (first && last.t - first.t >= 5 * 60_000) {
    const hours = (last.t - first.t) / 3_600_000
    perHour = Math.max(0, (used - pick(first)!) / hours)
    basisMin = Math.round((last.t - first.t) / 60_000)
  }
  const etaMs = perHour && perHour > 0 ? ((100 - used) / perHour) * 3_600_000 : undefined
  const untilReset = resetsAt ? Date.parse(resetsAt) - now : undefined
  let risk: WindowForecast['risk'] = 'low'
  if (used >= 95) risk = 'high'
  else if (etaMs !== undefined && untilReset !== undefined && etaMs < untilReset) {
    risk = etaMs < 45 * 60_000 ? 'high' : 'medium'
  } else if (used >= 80) risk = 'medium'
  return { kind, used, resetsAt, perHour, basisMin, etaMs, risk, provenance: 'official' }
}

export type Factor = { label: string; delta: number; provenance: Provenance }
export type Health = { score: number; grade: 'good' | 'fair' | 'degraded' | 'poor'; factors: Factor[] }

export function health(sample: UsageSample | undefined, activity: Activity): Health {
  const factors: Factor[] = []
  const p = sample?.contextPct
  if (p === undefined) {
    factors.push({ label: 'Context fill not reported yet', delta: 0, provenance: 'unavailable' })
  } else {
    const delta = p < 40 ? 0 : p < 60 ? -(p - 40) * 0.5 : p < 80 ? -10 - (p - 60) : -30 - (p - 80) * 1.5
    factors.push({ label: `Context ${p}% full`, delta: Math.round(delta), provenance: 'official' })
  }
  if (activity.compactions > 0) {
    factors.push({
      label: `${activity.compactions} compaction${activity.compactions > 1 ? 's' : ''}: summaries drop detail`,
      delta: -Math.min(24, activity.compactions * 8),
      provenance: 'heuristic',
    })
  }
  if (activity.turns > 60) {
    factors.push({ label: `${activity.turns} prompts in this session`, delta: activity.turns > 120 ? -10 : -5, provenance: 'heuristic' })
  }
  const recent = activity.recentErrors.slice(-20)
  if (recent.length >= 8) {
    const rate = recent.filter(Boolean).length / recent.length
    if (rate > 0.3) {
      factors.push({
        label: `${Math.round(rate * 100)}% of the last ${recent.length} tool calls failed`,
        delta: rate > 0.5 ? -15 : -10,
        provenance: 'heuristic',
      })
    }
  }
  const churned = Object.entries(activity.edits).filter(([, n]) => n >= 8)
  if (churned.length) {
    factors.push({
      label: `Repeated edits: ${churned.map(([f, n]) => `${basename(f)}×${n}`).join(', ')}`,
      delta: -Math.min(12, churned.length * 4),
      provenance: 'heuristic',
    })
  }
  const looping = Object.entries(activity.failingRepeats).filter(([, n]) => n >= 3)
  if (looping.length) {
    factors.push({
      label: `Same command failing repeatedly: ${looping[0]![0].slice(0, 40)}`,
      delta: -10,
      provenance: 'heuristic',
    })
  }
  const score = Math.max(0, Math.min(100, 100 + factors.reduce((s, f) => s + f.delta, 0)))
  const grade = score >= 80 ? 'good' : score >= 60 ? 'fair' : score >= 40 ? 'degraded' : 'poor'
  return { score, grade, factors }
}

// ---------------------------------------------------------------- model & effort

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export type ModelAlias = 'opus' | 'sonnet' | 'haiku'

export type ModelAdvice = {
  model: ModelAlias
  effort: Effort
  reason: string
  isChange: boolean
}

const HARD = /architect|design|refactor|debug|investigat|race|concurren|deadlock|security|migrat|perf|optimi[sz]|algorithm|root cause|flaky|protocol|schema/i
const LIGHT = /rename|typo|format|lint|docs?\b|readme|comment|bump|changelog|translate|copy|wording|cleanup|delete unused/i

export function familyOf(model: string | undefined): ModelAlias | undefined {
  if (!model) return undefined
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  if (/haiku/i.test(model)) return 'haiku'
  return undefined
}

export function modelAdvice(
  taskTitle: string | undefined,
  model: string | undefined,
  effort: string | undefined,
  budgetRisk: WindowForecast['risk'],
): ModelAdvice {
  const family = familyOf(model) ?? 'sonnet'
  const currentEffort = (EFFORTS.includes(effort as Effort) ? effort : 'medium') as Effort
  let want: ModelAlias = family
  let wantEffort: Effort = currentEffort
  let reason = 'No signal to change: keep the current setup.'
  if (taskTitle && HARD.test(taskTitle)) {
    want = 'opus'
    wantEffort = 'high'
    reason = 'Current task reads as design/debugging work: deeper reasoning pays off.'
  } else if (taskTitle && LIGHT.test(taskTitle)) {
    want = family === 'haiku' ? 'haiku' : 'sonnet'
    wantEffort = 'low'
    reason = 'Current task reads as mechanical: a lighter setup is enough.'
  }
  if (budgetRisk === 'high') {
    if (want === 'opus') want = 'sonnet'
    wantEffort = EFFORTS[Math.max(0, EFFORTS.indexOf(wantEffort) - 1)]!
    reason += ' Usage window at risk: one step lighter to stretch it.'
  }
  return { model: want, effort: wantEffort, reason, isChange: want !== family || wantEffort !== currentEffort }
}

// ---------------------------------------------------------------- stop point

export type StopPoint = {
  id: string
  title: string
  tasks: number
  isMilestoneEnd: boolean
  basis: string
}

/** How far the plan can go in the five-hour window, leaving `marginPct` for verification and handoff. */
export function stopPoint(plan: Plan | null, five: WindowForecast, marginPct = 6): StopPoint | undefined {
  if (!plan || five.used === undefined) return undefined
  const doneLeaves = leaves(plan).filter(n => n.status === 'done' && n.cost?.fiveHourPct !== undefined)
  if (doneLeaves.length < 2) return undefined
  const avg = doneLeaves.reduce((s, n) => s + (n.cost!.fiveHourPct ?? 0), 0) / doneLeaves.length
  const budget = 100 - five.used - marginPct
  const remaining = leaves(plan).filter(n => n.status === 'pending' || n.status === 'active')
  if (remaining.length === 0) return undefined
  if (avg <= 0) {
    const last = remaining.at(-1)!
    return { id: last.id, title: last.title, tasks: remaining.length, isMilestoneEnd: true, basis: 'tasks so far cost <1 pt each' }
  }
  let spent = 0
  let fitCount = 0
  let milestoneCount = 0
  for (const [i, n] of remaining.entries()) {
    spent += n.status === 'active' ? avg / 2 : avg
    if (spent > budget) break
    fitCount = i + 1
    const next = remaining[i + 1]
    if (!next || milestoneOf(plan, next).id !== milestoneOf(plan, n).id) milestoneCount = i + 1
  }
  const basis = `avg ${round1(avg)} pt of the 5h window per task over ${doneLeaves.length} finished`
  if (fitCount === 0) {
    return { id: remaining[0]!.id, title: remaining[0]!.title, tasks: 0, isMilestoneEnd: false, basis }
  }
  // A milestone boundary at most two tasks short of the furthest fit is the safer place to stop.
  const isMilestoneEnd = milestoneCount > 0 && milestoneCount >= fitCount - 2
  const count = isMilestoneEnd ? milestoneCount : fitCount
  const node = remaining[count - 1]!
  return { id: node.id, title: node.title, tasks: count, isMilestoneEnd, basis }
}

// ---------------------------------------------------------------- recommendations

export type Action = 'compact' | 'handoff' | 'pause' | 'model' | 'continue' | 'limit' | 'review' | 'replan'
export type Recommendation = {
  id: string
  severity: 'info' | 'warn' | 'urgent'
  title: string
  detail: string
  action?: Action
  arg?: string
  provenance: Provenance
}

export function recommend(args: {
  sample: UsageSample | undefined
  activity: Activity
  five: WindowForecast
  seven: WindowForecast
  health: Health
  plan: Plan | null
  gate: Gate | null
  advice: ModelAdvice
  stop: StopPoint | undefined
  controls: Controls
}): Recommendation[] {
  const { sample, activity, five, seven, plan, gate, advice, stop, controls } = args
  const out: Recommendation[] = []
  const ctx = sample?.contextPct
  if (gate) {
    out.push({
      id: 'gate',
      severity: 'warn',
      title: gate.kind === 'handoff' ? 'Handoff in progress' : 'Review before continuing',
      detail: gate.reason,
      action: 'review',
      provenance: 'official',
    })
  }
  if (ctx !== undefined && (ctx >= 85 || (activity.compactions >= 2 && ctx >= 60))) {
    out.push({
      id: 'new-session',
      severity: 'urgent',
      title: 'Start a new session with a handoff',
      detail: `Context ${ctx}% full${activity.compactions ? ` after ${activity.compactions} compactions` : ''}: a clean session with a handoff keeps decisions intact.`,
      action: 'handoff',
      provenance: 'heuristic',
    })
  } else if (ctx !== undefined && ctx >= 70) {
    out.push({
      id: 'compact',
      severity: 'warn',
      title: 'Compact at the next task boundary',
      detail: `Context ${ctx}% full. Compacting between tasks keeps the plan; session-pilot adds it to the summary instructions.`,
      action: 'compact',
      provenance: 'heuristic',
    })
  }
  if (five.risk === 'high') {
    out.push({
      id: 'five-risk',
      severity: 'urgent',
      title: 'Five-hour limit close',
      detail:
        five.etaMs !== undefined
          ? `At the observed pace the window runs out in ~${fmtDuration(five.etaMs)} (estimate). Finish the current task and hand off.`
          : `${five.used}% of the five-hour window used. Finish the current task and hand off.`,
      action: controls.handoffRequested ? undefined : 'handoff',
      provenance: 'estimate',
    })
  } else if (five.risk === 'medium' && stop) {
    out.push({
      id: 'stop-point',
      severity: 'info',
      title: `Plan to stop after ${stop.id}`,
      detail: `${stop.tasks} more task${stop.tasks === 1 ? '' : 's'} fit before the window runs out (${stop.basis}; estimate).`,
      action: controls.limitTaskId === stop.id ? undefined : 'limit',
      arg: stop.id,
      provenance: 'estimate',
    })
  }
  if (seven.used !== undefined && seven.used >= 85) {
    out.push({
      id: 'seven',
      severity: seven.used >= 95 ? 'urgent' : 'warn',
      title: 'Weekly quota running low',
      detail: `${seven.used}% of the weekly quota used. Prefer lighter models for routine work.`,
      provenance: 'official',
    })
  }
  if (advice.isChange) {
    out.push({
      id: 'model',
      severity: 'info',
      title: `Switch to ${advice.model} · ${advice.effort}`,
      detail: advice.reason,
      action: 'model',
      arg: `${advice.model}:${advice.effort}`,
      provenance: 'heuristic',
    })
  }
  const looping = Object.entries(activity.failingRepeats).find(([, n]) => n >= 3)
  const churned = Object.entries(activity.edits).find(([, n]) => n >= 10)
  if (looping || churned) {
    out.push({
      id: 'thrash',
      severity: 'warn',
      title: 'Possible loop: step back',
      detail: looping
        ? `"${looping[0].slice(0, 50)}" failed ${looping[1]} times in a row.`
        : `${basename(churned![0])} edited ${churned![1]} times.`,
      action: 'replan',
      provenance: 'heuristic',
    })
  }
  if (out.length === 0 && plan) {
    out.push({ id: 'ok', severity: 'info', title: 'Healthy: continue', detail: 'No sign that a change is needed.', action: 'continue', provenance: 'heuristic' })
  }
  return out
}

// ---------------------------------------------------------------- handoff document

export type HandoffInput = {
  objective: string
  requirements?: string[]
  decisions?: string[]
  constraints?: string[]
  progress?: string
  pending?: string[]
  files?: { path: string; note?: string }[]
  unfinished_changes?: string
  tests?: { command: string; result: string }[]
  known_issues?: string[]
  next_steps: string[]
  resume?: string
}

export type Observed = {
  now: number
  root: string
  git?: { branch: string; status: string[]; lastCommit: string }
  activity: Activity
  plan: Plan | null
  sample: UsageSample | undefined
  model?: string
}

export function handoffMarkdown(input: HandoffInput, seen: Observed): string {
  const list = (items: string[] | undefined) =>
    items && items.length ? items.map(i => `- ${i}`).join('\n') : '- (none recorded)'
  const out: string[] = []
  out.push(`# Session handoff`)
  out.push(`_Written ${new Date(seen.now).toISOString()} by session-pilot in \`${seen.root}\`._`)
  out.push(`\n## How to resume\n${input.resume ?? 'Read this file, check the working tree against "Observed state", then continue with the first next step.'}`)
  out.push(`\n## Objective\n${input.objective}`)
  out.push(`\n## Requirements\n${list(input.requirements)}`)
  out.push(`\n## Technical decisions\n${list(input.decisions)}`)
  out.push(`\n## Constraints\n${list(input.constraints)}`)
  out.push(`\n## Progress\n${input.progress ?? '(not summarized)'}`)
  if (seen.plan) out.push('\n```text\n' + planText(seen.plan) + '\n```')
  out.push(`\n## Pending work and dependencies\n${list(input.pending)}`)
  out.push(
    `\n## Relevant files\n${
      input.files?.length ? input.files.map(f => `- \`${f.path}\`${f.note ? ` — ${f.note}` : ''}`).join('\n') : '- (none listed)'
    }`,
  )
  out.push(`\n## Unfinished changes\n${input.unfinished_changes ?? 'None reported.'}`)
  out.push(
    `\n## Tests and checks (reported by the model)\n${
      input.tests?.length ? input.tests.map(t => `- \`${t.command}\`: ${t.result}`).join('\n') : '- (none reported)'
    }`,
  )
  out.push(`\n## Known issues\n${list(input.known_issues)}`)
  out.push(`\n## Next steps\n${input.next_steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)

  out.push(`\n---\n## Observed state (recorded by session-pilot, not by the model)`)
  if (seen.git) {
    out.push(`- Branch: \`${seen.git.branch}\` · last commit: ${seen.git.lastCommit || '(none)'}`)
    out.push(
      seen.git.status.length
        ? `- Uncommitted (git status):\n${seen.git.status.slice(0, 40).map(l => `  - \`${l}\``).join('\n')}`
        : '- Working tree clean.',
    )
  } else {
    out.push('- Not a git repository, or git unavailable.')
  }
  const edited = Object.entries(seen.activity.edits).sort((a, b) => b[1] - a[1])
  out.push(
    edited.length
      ? `- Files edited this session:\n${edited.slice(0, 30).map(([f, n]) => `  - \`${f}\` (${n}×)`).join('\n')}`
      : '- No files edited this session.',
  )
  const tests = seen.activity.tests.slice(-8)
  out.push(
    tests.length
      ? `- Check commands run (exit status seen by the engine):\n${tests.map(t => `  - ${t.ok ? 'pass' : 'FAIL'} \`${t.command.slice(0, 120)}\``).join('\n')}`
      : '- No test or check command was observed.',
  )
  const s = seen.sample
  if (s) {
    const parts = [
      s.contextPct !== undefined ? `context ${s.contextPct}%` : undefined,
      s.fiveHour !== undefined ? `5h window ${s.fiveHour}%` : undefined,
      s.sevenDay !== undefined ? `weekly ${s.sevenDay}%` : undefined,
      s.usd !== undefined ? `cost $${s.usd.toFixed(2)}` : undefined,
      seen.model ? `model ${seen.model}` : undefined,
    ].filter(Boolean)
    out.push(`- Usage at handoff: ${parts.join(' · ')}`)
  }
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------- checks

const CHECK = /\b(test|tests|pytest|jest|vitest|mocha|cargo (test|check|build|clippy)|go (test|vet|build)|dotnet (test|build)|tsc\b|eslint|ruff|mypy|npm run (test|build|lint|check|typecheck)|pnpm (test|build|lint)|yarn (test|build|lint)|make( test| check)?$|gradle(w)? (test|build)|mvn (test|verify))/i

export function isCheckCommand(command: string): boolean {
  return CHECK.test(command)
}

// ---------------------------------------------------------------- format

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h${String(min % 60).padStart(2, '0')}`
  return `${Math.round(h / 24)}d`
}

export function fmtUntil(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  return fmtDuration(Date.parse(iso) - now)
}

export function bar(pct: number, width: number): string {
  const w = Math.max(4, width)
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

export function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

export function clip(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text : text.slice(0, width - 1) + '…'
}
