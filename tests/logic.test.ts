import { describe, expect, test } from 'claude-code/testing'

import type { Activity, Controls, UsageSample } from '../types'
import * as L from '../hooks/logic'

const T0 = Date.parse('2026-10-11T12:00:00Z')
const CONTROLS: Controls = { pauseAtNext: false, focusUnit: false, handoffRequested: false, stopBlocks: 0 }
const ACTIVITY: Activity = {
  edits: {},
  tests: [],
  recentErrors: [],
  failingRepeats: {},
  compactions: 0,
  turns: 3,
  startedAt: T0,
}

const PLAN_INPUT: L.PlanSetInput = {
  title: 'Auth',
  milestones: [
    { id: 'M1', title: 'Backend', items: [{ id: 'M1.1', title: 'Routes' }, { id: 'M1.2', title: 'Tokens', checkpoint: true }] },
    { id: 'M2', title: 'Frontend', items: [{ id: 'M2.1', title: 'Login form', deps: ['M1.2'] }] },
  ],
}

const sample = (t: number, fiveHour: number, extra: Partial<UsageSample> = {}): UsageSample => ({
  t,
  fiveHour,
  fiveHourResets: '2026-10-11T15:00:00Z',
  ...extra,
})

describe('plan', () => {
  test('builds a hierarchy and rolls progress up', () => {
    const plan = L.buildPlan(PLAN_INPUT, T0, 'tool', null)
    expect(plan.nodes.map(n => `${n.id}:${n.kind}`)).toEqual(['M1:milestone', 'M1.1:task', 'M1.2:task', 'M2:milestone', 'M2.1:task'])
    expect(L.progress(plan)).toEqual({ done: 0, total: 3, pct: 0 })

    const started = L.applyUpdate(plan, { start: 'M1.1' }, T0 + 1, sample(T0, 10)).plan
    expect(L.current(started)?.id).toBe('M1.1')
    expect(started.nodes.find(n => n.id === 'M1')?.status).toBe('active')

    const out = L.applyUpdate(started, { done: ['M1.1', 'M1.2'] }, T0 + 60_000, sample(T0 + 60_000, 14))
    expect(out.finished).toEqual(['M1', 'M1.1', 'M1.2'])
    expect(out.plan.nodes.find(n => n.id === 'M1.1')?.cost?.fiveHourPct).toBe(4)
    expect(L.progress(out.plan).pct).toBe(67)
    expect(L.upNext(out.plan, 2).map(n => n.id)).toEqual(['M2.1'])
  })

  test('reports unknown ids and unmet dependencies', () => {
    const plan = L.buildPlan(PLAN_INPUT, T0, 'tool', null)
    const out = L.applyUpdate(plan, { start: 'M2.1', done: ['nope'] }, T0, undefined)
    expect(out.errors.join(' ')).toMatch(/depends on unfinished M1\.2/)
    expect(out.errors.join(' ')).toMatch(/unknown id "nope"/)
  })

  test('re-planning keeps finished work by title', () => {
    const plan = L.applyUpdate(L.buildPlan(PLAN_INPUT, T0, 'tool', null), { done: ['M1.1'] }, T0, undefined).plan
    const again = L.buildPlan({ ...PLAN_INPUT, milestones: [{ title: 'Backend', items: [{ title: 'Routes' }, { title: 'Tokens' }, { title: 'Docs' }] }] }, T0, 'tool', plan)
    expect(again.nodes.find(n => n.title === 'Routes')?.status).toBe('done')
  })

  test('mirrors TodoWrite', () => {
    const first = L.planFromTodos([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }], null, T0, sample(T0, 10))
    const second = L.planFromTodos([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }], first, T0 + 5, sample(T0 + 5, 13))
    expect(second.nodes.map(n => n.status)).toEqual(['done', 'active'])
    expect(second.nodes[0]?.cost?.fiveHourPct).toBe(3)
  })
})

describe('gates', () => {
  const plan = L.buildPlan(PLAN_INPUT, T0, 'tool', null)
  test('checkpoint, limit, pause and handoff', () => {
    expect(L.gateFor(plan, ['M1.1'], CONTROLS, T0)).toBeNull()
    expect(L.gateFor(plan, ['M1.2'], CONTROLS, T0)?.kind).toBe('checkpoint')
    expect(L.gateFor(plan, ['M1.1'], { ...CONTROLS, limitTaskId: 'M1.1' }, T0)?.kind).toBe('limit')
    expect(L.gateFor(plan, ['M1.1'], { ...CONTROLS, pauseAtNext: true }, T0)?.kind).toBe('pause')
    expect(L.gateFor(plan, ['M1.2'], { ...CONTROLS, handoffRequested: true }, T0)?.kind).toBe('handoff')
  })
  test('focus refuses a task of another open milestone', () => {
    const active = L.applyUpdate(plan, { start: 'M1.1' }, T0, undefined).plan
    expect(L.breaksFocus(active, 'M2.1')).toMatch(/M1/)
    expect(L.breaksFocus(active, 'M1.2')).toBeUndefined()
  })
})

describe('usage', () => {
  test('pace and risk come from readings in one window', () => {
    const samples = [sample(T0, 40), sample(T0 + 30 * 60_000, 55)]
    const f = L.forecastWindow(samples, 'five_hour', T0 + 30 * 60_000)
    expect(f.perHour).toBe(30)
    expect(f.provenance).toBe('official')
    // 45 points left at 30/h is 1h30, before the reset 2h30 away.
    expect(f.risk).toBe('medium')
    expect(L.forecastWindow([], 'seven_day', T0).risk).toBe('unknown')
  })

  test('health explains every deduction', () => {
    const h = L.health({ t: T0, contextPct: 82 }, { ...ACTIVITY, compactions: 2, failingRepeats: { 'npm test': 3 } })
    expect(h.factors.map(f => f.provenance)).toEqual(['official', 'heuristic', 'heuristic'])
    expect(h.score).toBeLessThan(50)
    expect(L.health(undefined, ACTIVITY).factors[0]?.provenance).toBe('unavailable')
  })

  test('recommends a new session when the context is nearly full', () => {
    const s = { t: T0, contextPct: 90 }
    const five = L.forecastWindow([], 'five_hour', T0)
    const recs = L.recommend({
      sample: s,
      activity: ACTIVITY,
      five,
      seven: five,
      health: L.health(s, ACTIVITY),
      plan: null,
      gate: null,
      advice: L.modelAdvice(undefined, 'claude-opus-5-5', 'high', 'low'),
      stop: undefined,
      controls: CONTROLS,
    })
    expect(recs[0]?.action).toBe('handoff')
  })

  test('model advice follows the task and the budget', () => {
    expect(L.modelAdvice('Debug the race in the cache', 'claude-sonnet-5-5', 'medium', 'low')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(L.modelAdvice('Fix typo in README', 'claude-opus-5-5', 'high', 'low')).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(L.modelAdvice('Debug the race', 'claude-opus-5-5', 'high', 'high')).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })

  test('stop point prefers a milestone boundary within budget', () => {
    let plan = L.buildPlan(
      {
        title: 'x',
        milestones: [
          { id: 'A', title: 'A', items: [{ title: 'a1' }, { title: 'a2' }, { title: 'a3' }] },
          { id: 'B', title: 'B', items: [{ title: 'b1' }, { title: 'b2' }, { title: 'b3' }] },
        ],
      },
      T0,
      'tool',
      null,
    )
    plan = L.applyUpdate(plan, { start: 'A.1' }, T0, sample(T0, 70)).plan
    plan = L.applyUpdate(plan, { done: ['A.1'] }, T0 + 1, sample(T0 + 1, 75)).plan
    plan = L.applyUpdate(plan, { start: 'A.2' }, T0 + 2, sample(T0 + 2, 75)).plan
    plan = L.applyUpdate(plan, { done: ['A.2'] }, T0 + 3, sample(T0 + 3, 80)).plan
    // 20 left, 6 margin: 14 at 5 per task fits a3 and b1, b2 would not.
    const stop = L.stopPoint(plan, L.forecastWindow([sample(T0 + 3, 80)], 'five_hour', T0 + 3))
    expect(stop).toMatchObject({ id: 'A.3', isMilestoneEnd: true })
  })
})

test('handoff document separates what the model said from what was observed', () => {
  const md = L.handoffMarkdown(
    { objective: 'Ship auth', next_steps: ['Write login form'], tests: [{ command: 'npm test', result: '12 passed' }] },
    {
      now: T0,
      root: '/proj',
      git: { branch: 'main', status: [' M src/a.ts'], lastCommit: 'abc fix' },
      activity: { ...ACTIVITY, edits: { 'src/a.ts': 2 }, tests: [{ command: 'npm test', ok: true, at: T0 }] },
      plan: L.buildPlan(PLAN_INPUT, T0, 'tool', null),
      sample: { t: T0, contextPct: 40 },
    },
  )
  expect(md).toContain('## Objective\nShip auth')
  expect(md).toContain('1. Write login form')
  expect(md).toContain('## Observed state (recorded by session-pilot)')
  expect(md).toContain('Uncommitted: 1 file (`M src/a.ts`)')
  expect(md).toContain('pass `npm test`')
  expect(md).toContain('○ M1 Backend (0/2)')
  expect(md).toContain('Next: M1.1 Routes')
})

test('a handoff stays short whatever the model sends', () => {
  const long = 'x'.repeat(2000)
  const many = Array.from({ length: 40 }, (_, i) => `item ${i} ${'y'.repeat(300)}`)
  const md = L.handoffMarkdown(
    { objective: long, next_steps: many, decisions: many, pending: many, known_issues: many, progress: long },
    { now: T0, root: '/proj', activity: { ...ACTIVITY, edits: Object.fromEntries(many.map(m => [m, 1])) }, plan: L.buildPlan(PLAN_INPUT, T0, 'tool', null), sample: undefined },
  )
  expect(md.split('\n').length).toBeLessThan(70)
  expect(md.length).toBeLessThan(9000)
  expect(md).toContain('34 more left out')
})

test('a session on an older cached copy learns a newer one is installed', () => {
  // Windows spells the record's paths with backslashes; the comparison must not care.
  const winPath = (p: string) => p.replace(/\//g, '\\')
  const record = { plugins: { 'session-pilot@session-pilot': [{ installPath: winPath('C:/Users/x/.claude/plugins/cache/session-pilot/session-pilot/0.5.0'), version: '0.5.0' }] } }
  expect(L.staleVersion('C:/Users/x/.claude/plugins/cache/session-pilot/session-pilot/0.4.1', record, 'session-pilot')).toBe('0.5.0')
  expect(L.staleVersion(winPath('c:/users/x/.claude/plugins/cache/session-pilot/session-pilot/0.5.0/'), record, 'session-pilot')).toBeNull()
  expect(L.staleVersion('/dev/session-pilot', { plugins: {} }, 'session-pilot')).toBeNull()
})
