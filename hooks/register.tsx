// session-pilot: a session dashboard and execution controller.
//
// Sees: the plan (its own plan tools, or TodoWrite / Task* mirrored), the
// engine's usage figures (context, rate-limit windows, cost), tool outcomes.
// Steers: denies tool calls past an engaged gate, refuses to start new work
// while wrapping up, sends the model back once at Stop until the handoff is
// written, keeps the plan through compaction, and hands context to a new
// session through SessionStart's additionalContext.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Activity, Controls, Gate, HandoffDraft, Plan, PlanNode, ResumeOffer, UsageSample, View } from '../types'
import * as L from './logic'
import type { Effort, HandoffInput, PlanSetInput, PlanUpdateInput, Recommendation } from './logic'
import { band, pane, pickEls } from './ui'
import type { Actions, Snapshot } from './ui'

type $T = EngineInterface

const P = 'session-pilot'
const PANE = 'session-pilot'
const PREFIX = 'mcp__session-pilot__'
const HANDOFF_WRITE = `${PREFIX}handoff_write`

const CONTROLS: Controls = { pauseAtNext: false, focusUnit: false, handoffRequested: false, stopBlocks: 0 }
const freshActivity = (t: number): Activity => ({
  edits: {},
  tests: [],
  recentErrors: [],
  failingRepeats: {},
  compactions: 0,
  turns: 0,
  startedAt: t,
})

const planA = atom({ plugin: 'session-pilot', key: 'plan' } as const, null)
const gateA = atom({ plugin: 'session-pilot', key: 'gate' } as const, null)
const controlsA = atom({ plugin: 'session-pilot', key: 'controls' } as const, CONTROLS)
const samplesA = atom({ plugin: 'session-pilot', key: 'samples' } as const, [])
const activityA = atom({ plugin: 'session-pilot', key: 'activity' } as const, freshActivity(0))
const handoffA = atom({ plugin: 'session-pilot', key: 'handoff' } as const, null)
const resumeA = atom({ plugin: 'session-pilot', key: 'resume' } as const, null)
const viewA = atom({ plugin: 'session-pilot', key: 'view' } as const, { pane: 'plan', collapsed: [], isBandHidden: false } as View)
const commandsA = atom({ plugin: 'session-pilot', key: 'commands' } as const, [])

/** Tools that only read: allowed while a gate holds the run. */
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'TaskList', 'TaskGet', 'ToolSearch', 'TodoWrite', 'WebFetch', 'WebSearch'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PERSON = new Set(['composer', 'bridge', 'sdk'])

// The running main-loop turn. A module variable: a reload mid-turn only loses
// "stop now" and the mid-turn notice route until the next turn starts.
let runningTurn: string | undefined
let seenModel: string | undefined
let seenEffort: string | undefined

// ---------------------------------------------------------------- prompts the mod sends

const HANDOFF_BRIEF =
  'Keep the handoff SHORT: a summary someone reads in one minute, not a report. One line per item, at most 6 items per list, no code, no logs, no file contents. Leave out what the next session can read from the code or git.'
const HANDOFF_STEPS = [
  'Stop at the nearest consistent point of the current task. Do not start new work; record what remains instead of doing it.',
  'Run only quick checks for what changed, if any exist (one test file, a type-check). Skip long suites and note what was not run.',
  `Call ${HANDOFF_WRITE}. ${HANDOFF_BRIEF} Then stop.`,
]
const QUICK_HANDOFF_PROMPT =
  `[session-pilot] Write a handoff now from what you already know. Do no more work and run nothing: call ${HANDOFF_WRITE} directly. ${HANDOFF_BRIEF}`
const HANDOFF_PROMPT =
  '[session-pilot] Finish current task, reach a safe checkpoint, and prepare handoff.\n' +
  HANDOFF_STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')
const HANDOFF_NOTICE =
  'session-pilot: the user asked to wrap up for a handoff. ' + HANDOFF_STEPS.join(' ')
const PAUSE_NOTICE =
  'session-pilot: the user asked to pause at the next safe checkpoint. Finish the current task, mark it done (plan_update or TodoWrite), leave the working tree consistent, then end your turn with a short status. Do not start the next task.'

function gateNotice(gate: Gate): string {
  if (gate.kind === 'handoff') {
    return `session-pilot: ${gate.reason}. Do not start another task. Run the relevant checks now, then call ${HANDOFF_WRITE}.`
  }
  return `session-pilot: ${gate.reason}. Execution is paused for the user's review. Do not call more tools that change anything. End your turn now with: what was completed, the state of the working tree, the result of the last checks, and the proposed next step.`
}

// ---------------------------------------------------------------- state helpers

async function now($: $T): Promise<number> {
  return $.clock.now()
}

function windowOf(limits: readonly SessionRateLimit[], kind: string) {
  return limits.find(l => l.kind === kind)
}

function sampleFrom(
  u: { context: { tokens?: number; window: number; percent?: number }; rateLimits: SessionRateLimit[]; cost?: { usd: number } },
  t: number,
): UsageSample {
  const five = windowOf(u.rateLimits, 'five_hour')
  const seven = windowOf(u.rateLimits, 'seven_day')
  return {
    t,
    contextPct: u.context.percent,
    contextTokens: u.context.tokens,
    window: u.context.window,
    fiveHour: five?.percentUsed,
    fiveHourResets: five?.resetsAt,
    sevenDay: seven?.percentUsed,
    sevenDayResets: seven?.resetsAt,
    usd: u.cost?.usd,
  }
}

async function addSample($: $T, s: UsageSample) {
  await update($, samplesA, list => {
    const last = list.at(-1)
    const same =
      last &&
      last.contextPct === s.contextPct &&
      last.fiveHour === s.fiveHour &&
      last.sevenDay === s.sevenDay &&
      s.t - last.t < 60_000
    const next = same ? [...list.slice(0, -1), { ...s, t: last.t }] : [...list, s]
    return next.slice(-600)
  })
}

async function latestSample($: $T): Promise<UsageSample | undefined> {
  return L.latest(await read($, samplesA))
}

async function planKey($: $T): Promise<string> {
  return `plan:${await $.session.root()}`
}

async function handoffKey($: $T): Promise<string> {
  return `handoff:${await $.session.root()}`
}

async function savePlan($: $T, plan: Plan | null) {
  await update($, planA, () => plan)
  const key = await planKey($)
  if (plan) await $.store.set(key, plan)
  else await $.store.delete(key)
}

/** Engages the gate the finished nodes call for; returns it so the caller can tell the model. */
async function engage($: $T, plan: Plan, finished: string[]): Promise<Gate | null> {
  const controls = await read($, controlsA)
  const gate = L.gateFor(plan, finished, controls, await now($))
  if (!gate) return null
  await update($, gateA, () => gate)
  if (gate.kind !== 'handoff') {
    $.ui.toast(`⏸ ${gate.reason}`, { timeoutMs: 8000 })
    void $.ui.notify(`${gate.reason}. Review and decide whether to continue.`, { title: 'session-pilot' }).catch(() => undefined)
  }
  return gate
}

// ---------------------------------------------------------------- snapshot & actions

async function snapshot($: $T): Promise<Snapshot> {
  const [plan, gate, controls, samples, activity, handoff, resume, view, t] = await Promise.all([
    read($, planA),
    read($, gateA),
    read($, controlsA),
    read($, samplesA),
    read($, activityA),
    read($, handoffA),
    read($, resumeA),
    read($, viewA),
    now($),
  ])
  const sample = L.latest(samples)
  const five = L.forecastWindow(samples, 'five_hour', t)
  const seven = L.forecastWindow(samples, 'seven_day', t)
  const health = L.health(sample, activity)
  const cur = L.current(plan)
  const advice = L.modelAdvice(cur?.title, activity.model, controls.effortOverride ?? activity.effort, five.risk)
  const stop = L.stopPoint(plan, five)
  const recs = L.recommend({ sample, activity, five, seven, health, plan, gate, advice, stop, controls })
  return {
    now: t,
    plan,
    gate,
    controls,
    sample,
    handoff,
    resume,
    view,
    progress: L.progress(plan),
    current: cur,
    next: L.upNext(plan, 3),
    health,
    five,
    seven,
    advice,
    stop,
    recs,
    model: activity.model,
    effort: controls.effortOverride ?? activity.effort,
  }
}

async function openPane($: $T, view?: View['pane']) {
  if (view) await update($, viewA, v => ({ ...v, pane: view }))
  await $.ui.open({ id: PANE, title: 'Session pilot', columns: 72 })
}

/** Closes the pane when it shows `view` (or any view, with none named); opens it on `view` otherwise. */
async function togglePane($: $T, view?: View['pane']) {
  const [panes, current] = await Promise.all([$.ui.panes(), read($, viewA)])
  const isOpen = panes.some(p => p.id === PANE && p.isShown)
  if (isOpen && (view === undefined || current.pane === view)) return $.ui.close({ id: PANE })
  return openPane($, view)
}

async function say($: $T, text: string) {
  try {
    await $.prompt.submit({ text })
  } catch {
    $.ui.toast('session-pilot: could not submit the prompt; type it yourself.')
  }
}

async function requestHandoff($: $T) {
  const t = await now($)
  await update($, controlsA, c => ({
    ...c,
    handoffRequested: true,
    handoffRequestedAt: t,
    stopBlocks: 0,
    pauseAtNext: false,
    notice: runningTurn ? HANDOFF_NOTICE : undefined,
  }))
  await update($, gateA, g => (g && g.kind !== 'handoff' ? null : g))
  if (!runningTurn) await say($, HANDOFF_PROMPT)
  $.ui.toast('Wrapping up: Claude stops at a consistent point, runs quick checks, then writes a short handoff.', { timeoutMs: 6000 })
}

/** A handoff from what the model already knows: no more work, no checks. */
async function quickHandoff($: $T) {
  if (runningTurn) return requestHandoff($)
  const t = await now($)
  await update($, controlsA, c => ({ ...c, handoffRequested: true, handoffRequestedAt: t, stopBlocks: 0, notice: undefined }))
  await update($, gateA, g => (g && g.kind !== 'handoff' ? null : g))
  await say($, QUICK_HANDOFF_PROMPT)
  $.ui.toast('Writing a short handoff now.', { timeoutMs: 5000 })
}

async function continueRun($: $T, limitId?: string) {
  const gate = await read($, gateA)
  await update($, gateA, () => null)
  await update($, controlsA, c => ({
    ...c,
    pauseAtNext: false,
    limitTaskId: limitId ?? (gate?.kind === 'limit' ? undefined : c.limitTaskId),
  }))
  await say($, `[session-pilot] Reviewed${gate ? ` (${gate.reason})` : ''}: continue with the plan.${limitId ? ` Stop after ${limitId}.` : ''}`)
}

async function applyModel($: $T, arg: string) {
  const [model, effort] = arg.split(':') as [string, Effort]
  const commands = await read($, commandsA)
  const done: string[] = []
  try {
    if (commands.includes('model')) {
      await $.command.run({ command: 'model', args: model })
      done.push(`model ${model}`)
    }
    if (commands.includes('effort')) {
      await $.command.run({ command: 'effort', args: effort })
      done.push(`effort ${effort}`)
    } else {
      // No /effort command in this build: set it on each request instead.
      await update($, controlsA, c => ({ ...c, effortOverride: effort }))
      done.push(`effort ${effort} (per request)`)
    }
    $.ui.toast(`session-pilot: ${done.join(', ')}`)
  } catch (err) {
    $.ui.toast(`session-pilot: could not switch (${String(err).slice(0, 80)}). Use /model ${model}.`)
  }
}

async function startNewSession($: $T) {
  const draft = await read($, handoffA)
  if (!draft) return
  const plan = await read($, planA)
  const nextStep = L.upNext(plan, 1)[0]
  const offer: ResumeOffer = { path: draft.path, createdAt: draft.createdAt, nextStep: nextStep ? `${nextStep.id} ${nextStep.title}` : undefined }
  // This session is never cleared: the next session opened in this project offers to resume.
  await $.store.set(await handoffKey($), { ...offer, isConsumed: false })
  $.ui.toast('Handoff queued. Open a new session in this project: it offers to resume from it. This session stays as it is.', { timeoutMs: 12000 })
}

function actions($: $T): Actions {
  const run = (f: () => Promise<unknown>) => () => {
    void f().catch(err => $.ui.toast(`session-pilot: ${String(err).slice(0, 120)}`))
  }
  return {
    openPane: view => run(() => openPane($, view))(),
    togglePane: view => run(() => togglePane($, view))(),
    setPane: view => run(() => update($, viewA, v => ({ ...v, pane: view })))(),
    select: id => run(() => update($, viewA, v => ({ ...v, selected: id })))(),
    toggleCollapse: id =>
      run(() =>
        update($, viewA, v => ({
          ...v,
          collapsed: v.collapsed.includes(id) ? v.collapsed.filter(c => c !== id) : [...v.collapsed, id],
        })),
      )(),
    toggleCheckpoint: id =>
      run(async () => {
        const plan = await read($, planA)
        if (!plan) return
        await savePlan($, { ...plan, nodes: plan.nodes.map(n => (n.id === id ? { ...n, checkpoint: !n.checkpoint } : n)) })
      })(),
    setLimit: id =>
      run(async () => {
        await update($, controlsA, c => ({ ...c, limitTaskId: id }))
        if (id) $.ui.toast(`session-pilot: execution stops after ${id}.`)
        if (id && runningTurn) {
          await update($, controlsA, c => ({ ...c, notice: `session-pilot: the user set ${id} as the last task of this run. Stop after it is done.` }))
        }
      })(),
    togglePause: run(async () => {
      const c = await update($, controlsA, c => ({ ...c, pauseAtNext: !c.pauseAtNext }))
      if (c.pauseAtNext && runningTurn) await update($, controlsA, c => ({ ...c, notice: PAUSE_NOTICE }))
      $.ui.toast(c.pauseAtNext ? 'session-pilot: pausing at the next safe checkpoint.' : 'session-pilot: pause cancelled.')
    }),
    toggleFocus: run(() => update($, controlsA, c => ({ ...c, focusUnit: !c.focusUnit }))),
    handoff: run(() => requestHandoff($)),
    quickHandoff: run(() => quickHandoff($)),
    continueRun: limitId => run(() => continueRun($, limitId))(),
    dismissGate: run(() => update($, gateA, () => null)),
    newSession: run(() => startNewSession($)),
    reloadHandoff: run(async () => {
      const draft = await read($, handoffA)
      if (!draft) return
      const markdown = await $.fs.read(draft.path)
      await update($, handoffA, d => (d ? { ...d, markdown } : d))
    }),
    discardHandoff: run(async () => {
      await update($, handoffA, () => null)
      await update($, gateA, g => (g?.kind === 'pause' && g.reason.startsWith('Handoff') ? null : g))
    }),
    resume: run(async () => {
      const offer = await read($, resumeA)
      if (!offer) return
      await update($, resumeA, () => null)
      await $.store.set(await handoffKey($), { ...offer, isConsumed: true })
      await say(
        $,
        `[session-pilot] Resume from the handoff in ${offer.path}. Read it, compare its "Observed state" with the working tree (git status), then continue with the first next step.`,
      )
    }),
    dismissResume: run(async () => {
      const offer = await read($, resumeA)
      await update($, resumeA, () => null)
      if (offer) await $.store.set(await handoffKey($), { ...offer, isConsumed: true })
    }),
    act: (rec: Recommendation) =>
      run(async () => {
        switch (rec.action) {
          case 'compact': {
            const plan = await read($, planA)
            const out = await $.session.compact({ instructions: plan ? `Keep the plan state:\n${L.planText(plan)}` : undefined })
            if ('skip' in out && out.skip) $.ui.toast(`session-pilot: compaction skipped: ${out.skip}`)
            return
          }
          case 'handoff':
            return requestHandoff($)
          case 'pause':
            return update($, controlsA, c => ({ ...c, pauseAtNext: true }))
          case 'model':
            return applyModel($, rec.arg ?? 'sonnet:medium')
          case 'limit':
            return update($, controlsA, c => ({ ...c, limitTaskId: rec.arg }))
          case 'review':
            return openPane($, 'plan')
          case 'replan':
            return say(
              $,
              `[session-pilot] Possible loop: ${rec.detail} Step back before more edits: summarize what is failing, list hypotheses, and propose a revised plan.`,
            )
          default:
            return openPane($, 'health')
        }
      })(),
    stopNow: run(async () => {
      if (!runningTurn) return void $.ui.toast('session-pilot: nothing is running.')
      await $.turn.abort({ turnId: runningTurn })
      $.ui.toast('session-pilot: stopped mid-turn; check the working tree before continuing.', { timeoutMs: 8000 })
    }),
    clearPlan: run(async () => {
      await savePlan($, null)
      await update($, controlsA, c => ({ ...c, limitTaskId: undefined }))
    }),
  }
}

// ---------------------------------------------------------------- tool specs

const ITEM_SCHEMA = (depthLeft: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short stable id, e.g. "M1", "M1.2", "M1.2.a". Defaults to a positional id.' },
    title: { type: 'string' },
    checkpoint: { type: 'boolean', description: 'Pause for the user\'s review when this finishes. Only when the user asked for it.' },
    deps: { type: 'array', items: { type: 'string' }, description: 'Ids that must be done first.' },
    ...(depthLeft > 0 ? { items: { type: 'array', items: ITEM_SCHEMA(depthLeft - 1) } } : {}),
  },
  required: ['title'],
})

const PLAN_SET_SPEC = {
  name: 'plan_set',
  description:
    'Record the plan of the work in the session dashboard: milestones, each with tasks, each with optional subtasks. ' +
    'Use it for any work of three or more steps, before starting, and again when the plan changes (finished work is kept by id or title). ' +
    'Then report progress with plan_update.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short name for the work.' },
      goal: { type: 'string', description: 'The objective in one sentence.' },
      milestones: { type: 'array', items: ITEM_SCHEMA(2), description: 'Milestones; items are tasks; their items are subtasks.' },
    },
    required: ['title', 'milestones'],
  },
  isDeferred: false,
} as const

const PLAN_UPDATE_SPEC = {
  name: 'plan_update',
  description:
    'Report progress on the plan: `start` the task or subtask you begin, `done` the ones you finished (parents complete themselves), ' +
    '`block` one with a reason, `skip` ones no longer needed, `add` new items. Call it as each task starts and ends. ' +
    'Its answer can tell you to stop at a checkpoint the user set: obey it.',
  inputSchema: {
    type: 'object',
    properties: {
      start: { type: 'string' },
      done: { type: 'array', items: { type: 'string' } },
      block: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
      skip: { type: 'array', items: { type: 'string' } },
      note: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
      add: {
        type: 'object',
        properties: { parent: { type: 'string' }, items: { type: 'array', items: ITEM_SCHEMA(1) } },
        required: ['items'],
      },
    },
  },
  isDeferred: false,
} as const

// Short by construction: each list holds a few one-line items; logic.ts cuts anything longer.
const LIST = { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } }
const LINE = (description: string) => ({ type: 'string', maxLength: 400, description })
const HANDOFF_SPEC = {
  name: 'handoff_write',
  description:
    'Write a SHORT session handoff (a one-minute read) so another session can continue. Call it only when the user asked for a handoff ' +
    '(session-pilot says so). One line per item, at most 6 items per list; no code, logs or file contents. Saved under .claude/handoffs/; ' +
    'session-pilot appends the git state, files edited and check results it observed.',
  inputSchema: {
    type: 'object',
    properties: {
      objective: LINE('The goal in one or two sentences.'),
      requirements: LIST,
      decisions: { ...LIST, description: 'Key technical decisions, one line each.' },
      constraints: LIST,
      progress: LINE('What is finished, in two or three sentences.'),
      pending: { ...LIST, description: 'Pending work and its dependencies, one line each.' },
      files: {
        type: 'array',
        maxItems: 8,
        items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string', maxLength: 120 } }, required: ['path'] },
      },
      unfinished_changes: LINE('Changes left incomplete, and how to finish or revert them; "none" if clean.'),
      tests: {
        type: 'array',
        maxItems: 4,
        items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string', maxLength: 120 } }, required: ['command', 'result'] },
      },
      known_issues: LIST,
      next_steps: { ...LIST, description: 'The next steps, in order.' },
      resume: LINE('How to resume: what to read or run first.'),
    },
    required: ['objective', 'next_steps'],
  },
  isDeferred: false,
} as const

function planStatusLine(plan: Plan): string {
  const p = L.progress(plan)
  const cur = L.current(plan)
  const next = L.upNext(plan, 3).filter(n => n.id !== cur?.id)
  return `Plan ${p.done}/${p.total} (${p.pct}%). Current: ${cur ? `${cur.id} ${cur.title}` : 'none'}. Next: ${next.map(n => n.id).join(', ') || 'none'}.`
}

async function gitState($: $T, root: string) {
  try {
    const opts = { cwd: root, timeoutMs: 10_000 }
    const [branch, status, last] = await Promise.all([
      $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], opts),
      $.process.run(['git', 'status', '--porcelain'], opts),
      $.process.run(['git', 'log', '-1', '--format=%h %s'], opts),
    ])
    if (branch.exitCode !== 0) return undefined
    return {
      branch: branch.stdout.trim(),
      status: status.stdout.split('\n').map(l => l.trimEnd()).filter(Boolean),
      lastCommit: last.stdout.trim(),
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- mirroring the built-in task tools

function mirrorTasks(
  plan: Plan | null,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  t: number,
  sample: UsageSample | undefined,
): Plan | null | undefined {
  if (plan?.source === 'tool') return undefined
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return L.planFromTodos(input.todos as Parameters<typeof L.planFromTodos>[0], plan, t, sample)
  }
  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id: string; subject: string } } | undefined)?.task
    if (!task) return undefined
    const base: Plan = plan ?? { title: 'Tasks', nodes: [], source: 'tasks', updatedAt: t }
    const node: PlanNode = { id: `#${task.id}`, title: task.subject, kind: 'task', status: 'pending', deps: [] }
    return { ...base, source: 'tasks', nodes: [...base.nodes.filter(n => n.id !== node.id), node], updatedAt: t }
  }
  if (tool === 'TaskUpdate' && plan && typeof input.taskId === 'string') {
    const id = `#${input.taskId}`
    const status = input.status as string | undefined
    if (status === 'deleted') return { ...plan, nodes: plan.nodes.filter(n => n.id !== id), updatedAt: t }
    const update: PlanUpdateInput = {
      start: status === 'in_progress' ? id : undefined,
      done: status === 'completed' ? [id] : undefined,
    }
    let next = L.applyUpdate(plan, update, t, sample).plan
    next = {
      ...next,
      nodes: next.nodes.map(n =>
        n.id === id
          ? {
              ...n,
              title: typeof input.subject === 'string' ? input.subject : n.title,
              deps: Array.isArray(input.addBlockedBy) ? [...n.deps, ...(input.addBlockedBy as string[]).map(d => `#${d}`)] : n.deps,
            }
          : n,
      ),
    }
    return next
  }
  return undefined
}

function newlyDone(before: Plan | null, after: Plan): string[] {
  const was = new Set(before?.nodes.filter(n => n.status === 'done').map(n => n.id) ?? [])
  return after.nodes.filter(n => n.status === 'done' && !was.has(n.id)).map(n => n.id)
}

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register(PLAN_SET_SPEC),
      $.tool.register(PLAN_UPDATE_SPEC),
      $.tool.register(HANDOFF_SPEC),
      $.command.register({ name: 'pilot', description: 'Session pilot: open the dashboard (plan, health, handoff)', argumentHint: '[plan|health|handoff|band]' }),
      $.command.register({ name: 'pilot-pause', description: 'Pause at the next safe checkpoint (toggle)', immediate: true }),
      $.command.register({ name: 'pilot-handoff', description: 'Finish current task, reach a safe checkpoint, and prepare handoff', immediate: true }),
      $.command.register({ name: 'pilot-limit', description: 'Stop after this plan item (no id clears the limit)', argumentHint: '[id]', immediate: true }),
      $.command.register({ name: 'pilot-checkpoint', description: 'Toggle a review checkpoint on a plan item', argumentHint: '<id>', immediate: true }),
    ])
    const t = await now($)
    const [stored, offer, commands, usage, model] = await Promise.all([
      $.store.get(await planKey($)),
      $.store.get(await handoffKey($)),
      $.command.list().catch(() => []),
      $.session.usage().catch(() => undefined),
      $.session.model().catch(() => undefined),
    ])
    const plan = stored as Plan | undefined
    if (plan && (await read($, planA)) === null && plan.nodes.some(n => n.status !== 'done' && n.status !== 'skipped')) {
      await update($, planA, () => plan)
    }
    const pending = offer as (ResumeOffer & { isConsumed?: boolean }) | undefined
    if (pending && !pending.isConsumed && t - pending.createdAt < 7 * 86_400_000) {
      await update($, resumeA, () => ({ path: pending.path, createdAt: pending.createdAt, nextStep: pending.nextStep }))
    }
    await update($, commandsA, () => commands.map(c => c.name).filter(n => n === 'model' || n === 'effort'))
    await update($, activityA, a => (a.startedAt === 0 ? { ...freshActivity(t), model } : { ...a, model: model ?? a.model }))
    seenModel = model
    if (usage) await addSample($, sampleFrom(usage, t))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await addSample($, sampleFrom(e, await now($)))
    return next(e)
  })

  // A /clear begins a new conversation in this process: reset what belongs to the old one.
  // A queued handoff is offered by the band (Resume), never loaded unasked.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'clear') return result
    const t = await now($)
    runningTurn = undefined
    await Promise.all([
      update($, gateA, () => null),
      update($, controlsA, c => ({ ...CONTROLS, focusUnit: c.focusUnit, effortOverride: c.effortOverride })),
      update($, activityA, a => ({ ...freshActivity(t), model: a.model, effort: a.effort })),
      update($, handoffA, () => null),
    ])
    const pending = (await $.store.get(await handoffKey($))) as (ResumeOffer & { isConsumed?: boolean }) | undefined
    if (pending && !pending.isConsumed && t - pending.createdAt < 7 * 86_400_000) {
      await update($, resumeA, () => ({ path: pending.path, createdAt: pending.createdAt, nextStep: pending.nextStep }))
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    runningTurn = e.turnId
    const turns = await $.session.turns()
    await update($, activityA, a => (a.turns === turns ? a : { ...a, turns }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    runningTurn = undefined
    const [controls, gate] = await Promise.all([read($, controlsA), read($, gateA)])
    if (controls.pauseAtNext && !gate && !e.isAborted) {
      const at = await now($)
      await update($, gateA, () => ({ kind: 'pause', reason: 'Paused at the end of the turn', at }))
    }
    if (controls.notice) await update($, controlsA, c => ({ ...c, notice: undefined }))
    return next(e)
  })

  // Watch the model and effort each request is sent with; apply the effort override.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const controls = await read($, controlsA)
    const effort = controls.effortOverride ?? (e.effort === undefined ? undefined : String(e.effort))
    if (e.model !== seenModel || effort !== seenEffort) {
      seenModel = e.model
      seenEffort = effort
      await update($, activityA, a => ({ ...a, model: e.model, effort }))
    }
    return yield* next(controls.effortOverride ? { ...e, effort: controls.effortOverride } : e)
  })

  // The person's own prompt is their decision at a gate: it releases it.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
    const [gate, controls] = await Promise.all([read($, gateA), read($, controlsA)])
    if (gate && gate.kind !== 'handoff') {
      await update($, gateA, () => null)
      await update($, controlsA, c => ({
        ...c,
        pauseAtNext: gate.kind === 'pause' ? false : c.pauseAtNext,
        limitTaskId: gate.kind === 'limit' ? undefined : c.limitTaskId,
      }))
    }
    if (controls.notice && e.turnId === undefined) {
      await update($, controlsA, c => ({ ...c, notice: undefined }))
      return next({ ...e, context: [...(e.context ?? []), controls.notice] })
    }
    return next(e)
  })

  // Keep the plan through compaction, and count compactions.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const plan = await read($, planA)
    const extra = plan
      ? `Keep this plan state in the summary verbatim (session-pilot), with ids and statuses:\n${L.planText(plan)}`
      : undefined
    const result = await next(extra ? { ...e, instructions: [e.instructions, extra].filter(Boolean).join('\n\n') } : e)
    if (e.trigger !== 'precompute' && !('skip' in result && result.skip)) {
      await update($, activityA, a => ({ ...a, compactions: a.compactions + 1 }))
    }
    return result
  })

  // Send the model back, at most twice, while a requested handoff is not written.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const controls = await read($, controlsA)
    if (!controls.handoffRequested || controls.stopBlocks >= 2 || result.block) return result
    await update($, controlsA, c => ({ ...c, stopBlocks: c.stopBlocks + 1 }))
    return {
      ...result,
      block: `session-pilot: the user asked for a handoff and it is not written yet. Finish the current unit if needed, run the relevant checks, then call ${HANDOFF_WRITE}.`,
    }
  })

  // ---- the plan tools

  on('tool.call', { tool: 'mcp__session-pilot__plan_set' }, async ($, e) => {
    const input = e as unknown as PlanSetInput
    if (!input.title || !Array.isArray(input.milestones)) return { deny: 'plan_set needs title and milestones.' }
    const t = await now($)
    const previous = await read($, planA)
    const plan = L.buildPlan(input, t, 'tool', previous?.source === 'tool' ? previous : null)
    await savePlan($, plan)
    return {
      result: `Plan recorded. ${planStatusLine(plan)} Report each task's start and end with plan_update.${
        plan.nodes.some(n => n.checkpoint) ? ' Items marked checkpoint pause the run for the user\'s review.' : ''
      }`,
    }
  })

  on('tool.call', { tool: 'mcp__session-pilot__plan_update' }, async ($, e) => {
    const input = { ...(e as unknown as PlanUpdateInput) }
    const plan = await read($, planA)
    if (!plan) return { deny: 'No plan recorded: call plan_set first.' }
    const [gate, controls] = await Promise.all([read($, gateA), read($, controlsA)])
    const refusals: string[] = []
    if (input.start) {
      const startId = input.start
      const focus = controls.focusUnit ? L.breaksFocus(plan, startId) : undefined
      if (gate && gate.kind !== 'handoff') refusals.push(`not started ${startId}: ${gate.reason}; wait for the user`)
      else if (controls.handoffRequested) refusals.push(`not started ${startId}: wrapping up for a handoff, start nothing new`)
      else if (focus) refusals.push(`not started ${startId}: finish the current unit first (${focus}); the user asked for that`)
      if (refusals.length) input.start = undefined
    }
    const t = await now($)
    const outcome = L.applyUpdate(plan, input, t, await latestSample($))
    await savePlan($, outcome.plan)
    const engaged = await engage($, outcome.plan, outcome.finished)
    const parts = [planStatusLine(outcome.plan)]
    if (outcome.errors.length) parts.push(`Problems: ${outcome.errors.join('; ')}.`)
    if (refusals.length) parts.push(`Refused: ${refusals.join('; ')}.`)
    if (engaged) parts.push(gateNotice(engaged))
    else if (controls.handoffRequested && outcome.finished.length) parts.push(HANDOFF_NOTICE)
    return { result: parts.join(' ') }
  })

  on('tool.call', { tool: 'mcp__session-pilot__handoff_write' }, async ($, e) => {
    const input = e as unknown as HandoffInput
    if (!input.objective || !Array.isArray(input.next_steps)) return { deny: 'handoff_write needs objective and next_steps.' }
    const [t, root, plan, activity, sample, model] = await Promise.all([
      now($),
      $.session.root(),
      read($, planA),
      read($, activityA),
      latestSample($),
      $.session.model().catch(() => undefined),
    ])
    const git = await gitState($, root)
    const markdown = L.handoffMarkdown(input, { now: t, root, git, activity, plan, sample, model })
    const stamp = new Date(t).toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const dir = `${root}/.claude/handoffs`
    const path = `${dir}/handoff-${stamp}.md`
    await $.fs.write(path, markdown)
    await $.fs.write(`${dir}/latest.md`, markdown)
    const draft: HandoffDraft = { path, markdown, createdAt: t }
    await update($, handoffA, () => draft)
    await update($, controlsA, c => ({ ...c, handoffRequested: false, notice: undefined, stopBlocks: 0 }))
    await update($, gateA, () => ({ kind: 'pause', reason: 'Handoff written: review it, then start a new session', at: t }))
    await update($, viewA, v => ({ ...v, pane: 'handoff' as const }))
    void $.ui.open({ id: PANE, title: 'Session pilot', columns: 72 }).catch(() => undefined)
    void $.ui.notify('Handoff ready for review.', { title: 'session-pilot' }).catch(() => undefined)
    return {
      result: `Handoff saved to ${path} (also .claude/handoffs/latest.md). Stop now: start no more work. Tell the user in one or two sentences that the handoff is ready for review in the session-pilot pane.`,
    }
  })

  // ---- every other tool: enforce the gate, record activity, mirror task tools

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(PREFIX)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const [gate, controls] = await Promise.all([read($, gateA), read($, controlsA)])
    if (gate && gate.kind !== 'handoff' && !READ_ONLY.has(tool)) {
      return { deny: gateNotice(gate) }
    }
    if ((gate?.kind === 'handoff' || controls.handoffRequested) && (tool === 'TaskCreate' || tool === 'Agent' || tool === 'Task')) {
      return { deny: 'session-pilot: wrapping up for a handoff; start no new work. Finish the current unit, run checks, then write the handoff.' }
    }

    const ran = await next(e)
    const isError = ran.deny !== undefined || ran.isError === true
    const t = await now($)

    await update($, activityA, a => {
      const edits = { ...a.edits }
      const failingRepeats = { ...a.failingRepeats }
      let tests = a.tests
      if (EDITS.has(tool) && !isError) {
        const file = String(input.file_path ?? input.notebook_path ?? '')
        if (file) edits[file] = (edits[file] ?? 0) + 1
      }
      if (tool === 'Bash' && typeof input.command === 'string') {
        const command = input.command.trim()
        if (L.isCheckCommand(command)) tests = [...tests, { command, ok: !isError, at: t }].slice(-30)
        if (isError) failingRepeats[command] = (failingRepeats[command] ?? 0) + 1
        else delete failingRepeats[command]
      }
      return { ...a, edits, failingRepeats, tests, recentErrors: [...a.recentErrors, isError].slice(-40) }
    })

    const context: string[] = []
    if (!isError && (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate')) {
      const before = await read($, planA)
      const after = mirrorTasks(before, tool, input, ran.result, t, await latestSample($))
      if (after !== undefined) {
        await savePlan($, after)
        if (after) {
          const engaged = await engage($, after, newlyDone(before, after))
          if (engaged) context.push(gateNotice(engaged))
        }
      }
    }
    const fresh = await read($, controlsA)
    if (fresh.notice && e.agentId === undefined) {
      context.push(fresh.notice)
      await update($, controlsA, c => ({ ...c, notice: undefined }))
    }
    if (context.length === 0 || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), ...context] }
  })

  // ---- commands

  on('command.run', { command: 'pilot' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'band') {
      const v = await update($, viewA, v => ({ ...v, isBandHidden: !v.isBandHidden }))
      return { text: v.isBandHidden ? 'Band hidden.' : 'Band shown.' }
    }
    const view = arg === 'health' || arg === 'handoff' ? arg : 'plan'
    await openPane($, view)
    return { text: `Session pilot opened (${view}).` }
  })

  on('command.run', { command: 'pilot-pause' }, async $ => {
    actions($).togglePause()
    return { text: 'Toggled pause at the next safe checkpoint.' }
  })

  on('command.run', { command: 'pilot-handoff' }, async $ => {
    await requestHandoff($)
    return { text: 'Wrap-up requested: finish current task, verify, write handoff.' }
  })

  on('command.run', { command: 'pilot-limit' }, async ($, e) => {
    const id = e.args.trim() || undefined
    const plan = await read($, planA)
    if (id && plan && !L.findNode(plan, id)) return { text: `No plan item "${id}".` }
    const real = id && plan ? L.findNode(plan, id)!.id : id
    await update($, controlsA, c => ({ ...c, limitTaskId: real }))
    return { text: real ? `Execution stops after ${real}.` : 'Limit cleared.' }
  })

  on('command.run', { command: 'pilot-checkpoint' }, async ($, e) => {
    const plan = await read($, planA)
    const node = plan && L.findNode(plan, e.args.trim())
    if (!plan || !node) return { text: `No plan item "${e.args.trim()}".` }
    await savePlan($, { ...plan, nodes: plan.nodes.map(n => (n.id === node.id ? { ...n, checkpoint: !n.checkpoint } : n)) })
    return { text: `${node.checkpoint ? 'Removed' : 'Set'} checkpoint on ${node.id}.` }
  })

  // ---- drawing

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const view = await read($, viewA)
    if (view.isBandHidden) return next(e)
    const s = await snapshot($)
    return band(pickEls($.ui.resolve(e), e.surface), s, actions($), e.props.bodyColumns, e.surface)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await snapshot($)
    return pane(pickEls($.ui.resolve(e), e.surface), s, actions($), e.props.bodyColumns)
  })
}
