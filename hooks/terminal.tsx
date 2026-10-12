// The band and the pane on the terminal: character bars and colored runs in
// place of pictures, chips drawn as text on a colored background, cards as
// rounded boxes. Every action is a Button, keyed as on the other surfaces.

import type { RenderElement } from 'claude-code'

import type { PlanNode, View } from '../types'
import { GLYPH, basename, childrenOf, depth, fmtDuration, fmtUntil, leaves, milestoneOf, nodeProgress, ordered, round1 } from './logic'
import type { Provenance, Recommendation, WindowForecast } from './logic'
import type { Actions, Els, Snapshot } from './ui'

type Run = { text: string; color?: string; dim?: boolean; bold?: boolean; bg?: string }

const STATUS_COLOR: Record<PlanNode['status'], string> = {
  done: 'success',
  active: 'claude',
  pending: 'inactive',
  blocked: 'error',
  skipped: 'subtle',
}
const GRADE_COLOR = { good: 'success', fair: 'suggestion', degraded: 'warning', poor: 'error' } as const
const GRADE_WORD = { good: 'Healthy', fair: 'Fair', degraded: 'Degrading', poor: 'Poor' } as const
const RISK_COLOR = { low: 'success', medium: 'warning', high: 'error', unknown: 'inactive' } as const
const SEVERITY_COLOR = { info: 'suggestion', warn: 'warning', urgent: 'error' } as const
const PROV_COLOR: Record<Provenance, string> = { official: 'success', estimate: 'suggestion', heuristic: 'permission', unavailable: 'inactive' }
const PROV_LABEL: Record<Provenance, string> = { official: 'official', estimate: 'estimate', heuristic: 'heuristic', unavailable: 'n/a' }

const ACTION_LABEL: Record<NonNullable<Recommendation['action']>, string> = {
  compact: 'Compact now',
  handoff: 'Finish & handoff',
  pause: 'Pause',
  model: 'Apply',
  continue: 'Continue',
  limit: 'Set as stop',
  review: 'Review',
  replan: 'Ask to re-plan',
}

const clip = (text: string, width: number) => (width <= 1 ? '' : text.length <= width ? text : text.slice(0, width - 1) + '…')

/** Adjacent runs of one style merged, so a bar is a handful of Text elements, not one per cell. */
function merge(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    const last = out.at(-1)
    if (last && last.color === r.color && last.dim === r.dim && last.bold === r.bold && last.bg === r.bg) last.text += r.text
    else out.push({ ...r })
  }
  return out
}

function texts(els: Els, runs: Run[]): RenderElement[] {
  const { Text } = els
  return merge(runs).map(r => (
    <Text color={r.color} dimColor={r.dim} bold={r.bold} backgroundColor={r.bg}>
      {r.text}
    </Text>
  ))
}

/** A meter: filled cells, an optional lighter projection, the rest as a thin track. */
function meter(pct: number, width: number, color: string, projected?: number): Run[] {
  const w = Math.max(3, width)
  const fill = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)
  const proj = projected === undefined ? fill : Math.max(fill, Math.round((Math.min(100, projected) / 100) * w))
  return [
    { text: '━'.repeat(fill), color },
    { text: '━'.repeat(proj - fill), color, dim: true },
    { text: '─'.repeat(w - proj), color: 'inactive', dim: true },
  ]
}

/** The plan as one line of cells: a run per task, a space between milestones, ◆ at a checkpoint, ┃ at the stop. */
function track(s: Snapshot, width: number): Run[] {
  const plan = s.plan!
  const ls = leaves(plan).filter(n => n.status !== 'skipped')
  if (ls.length === 0) return [{ text: '─'.repeat(width), color: 'inactive', dim: true }]
  const groups = new Set(ls.map(n => milestoneOf(plan, n).id)).size
  const unit = Math.max(1, Math.floor((width - (groups - 1)) / ls.length))
  const isComplete = s.progress.done === s.progress.total
  const runs: Run[] = []
  let lastMs: string | undefined
  for (const n of ls) {
    const ms = milestoneOf(plan, n).id
    if (lastMs !== undefined && ms !== lastMs) runs.push({ text: ' ' })
    lastMs = ms
    const style: Run =
      n.status === 'done'
        ? { text: '', color: isComplete ? 'success' : 'merged' }
        : n.status === 'active'
          ? { text: '', color: 'claude', bold: true }
          : n.status === 'blocked'
            ? { text: '', color: 'error' }
            : { text: '', color: 'inactive', dim: true }
    const glyph = n.status === 'pending' ? '─' : '━'
    const body = glyph.repeat(n.checkpoint ? Math.max(0, unit - 1) : unit)
    runs.push({ ...style, text: body })
    if (n.checkpoint) runs.push({ text: '◆', color: 'warning' })
    if (n.id === s.controls.limitTaskId) runs.push({ text: '┃', color: 'error', bold: true })
  }
  return runs
}

const chip = (label: string, bg: string): Run => ({ text: ` ${label} `, bg, color: 'inverseText', bold: true })

// ---------------------------------------------------------------- band

export function bandTerm(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Text, Button } = els
  const rows: RenderElement[] = []
  const alert = (key: string, label: string, bg: string, title: string, buttons: { key: string; label: string; primary?: boolean; onPress: () => void }[]) => {
    const room = Math.max(10, cols - label.length - 4 - buttons.reduce((n, b) => n + b.label.length + 5, 0))
    rows.push(
      <Box key={key} flexDirection="row" gap={1}>
        {texts(els, [chip(label, bg)])}
        <Text bold wrap="truncate-end">{clip(title, room)}</Text>
        <Box flexGrow={1} />
        {buttons.map(b => (
          <Button key={b.key} variant={b.primary ? 'primary' : 'secondary'} onPress={b.onPress}>
            {b.label}
          </Button>
        ))}
      </Box>,
    )
  }

  if (s.stale) {
    alert('row-stale', '⟳ UPDATE', 'suggestion', `session-pilot ${s.stale} installed: open a new session to use it`, [])
  }
  if (s.resume && !s.plan?.nodes.some(n => n.status === 'active')) {
    alert('row-resume', '↩ RESUME', 'suggestion', `Handoff from ${fmtDuration(s.now - s.resume.createdAt)} ago${s.resume.nextStep ? ` · next ${s.resume.nextStep}` : ''}`, [
      { key: 'resume', label: 'Resume', primary: true, onPress: a.resume },
      { key: 'resume-dismiss', label: 'Dismiss', onPress: a.dismissResume },
    ])
  }
  if (s.gate && s.gate.kind !== 'handoff' && !s.handoff) {
    const buttons = [{ key: 'gate-continue', label: 'Continue', primary: true, onPress: () => a.continueRun() }]
    if (s.stop && s.stop.id !== s.gate.taskId) buttons.push({ key: 'gate-continue-to', label: `Continue to ${s.stop.id}`, primary: false, onPress: () => a.continueRun(s.stop!.id) })
    buttons.push({ key: 'gate-handoff', label: 'Handoff', primary: false, onPress: a.handoff })
    buttons.push({ key: 'gate-dismiss', label: 'Dismiss', primary: false, onPress: a.dismissGate })
    alert('row-gate', '⏸ REVIEW', 'warning', s.gate.reason, buttons)
  }
  if (s.handoff) {
    alert('row-handoff', '✎ HANDOFF', 'success', `ready: ${basename(s.handoff.path)}`, [
      { key: 'handoff-review', label: 'Review', onPress: () => a.openPane('handoff') },
      { key: 'handoff-new', label: 'Continue in a new session', primary: true, onPress: a.newSession },
    ])
  } else if (s.controls.handoffRequested) {
    alert('row-wrap', '⏭ WRAPPING UP', 'permission', 'stopping at a consistent point, quick checks, then a short handoff', [])
  }

  if (s.plan) {
    const title = clip(s.plan.title, 22)
    const trackW = Math.max(10, Math.min(40, Math.floor(cols * 0.3)))
    const figures = ` ${s.progress.done}/${s.progress.total} ${s.progress.pct}% `
    const isPaused = s.gate !== null && s.gate.kind !== 'handoff'
    const cur = isPaused
      ? 'paused for review'
      : s.current
        ? `${s.current.id} ${s.current.title}`
        : s.progress.pct === 100
          ? 'complete'
          : 'nothing running'
    const nextIds = s.next.filter(n => n.id !== s.current?.id).slice(0, 2).map(n => n.id).join(', ')
    const room = Math.max(8, cols - title.length - trackW - figures.length - 8)
    const tail = clip(cur + (nextIds && !isPaused ? `  · next ${nextIds}` : ''), room)
    rows.push(
      <Box key="row-plan" flexDirection="row">
        <Button key="plan" plain onPress={() => a.togglePane('plan')}>
          <Text color={isPaused ? 'warning' : 'claude'} bold>{`◆ ${title} `}</Text>
          {texts(els, track(s, trackW))}
          <Text dimColor>{figures}</Text>
          <Text color={isPaused ? 'warning' : 'claude'}>{'▸ '}</Text>
          <Text>{tail}</Text>
        </Button>
      </Box>,
    )
  }

  const ctx = s.sample?.contextPct
  const isWide = cols >= 100
  const meterRuns: Run[] = [
    { text: '● ', color: GRADE_COLOR[s.health.grade] },
    { text: `${s.health.score}`, bold: true },
    { text: ` ${GRADE_WORD[s.health.grade]}`, dim: true },
    { text: '   ctx ', dim: true },
    ...meter(ctx ?? 0, 6, ctx === undefined ? 'inactive' : ctx >= 85 ? 'error' : ctx >= 70 ? 'warning' : 'success'),
    { text: ` ${ctx === undefined ? 'n/a' : `${ctx}%`}` },
    { text: '   5h ', dim: true },
    ...meter(s.five.used ?? 0, 6, RISK_COLOR[s.five.risk] === 'inactive' ? 'success' : RISK_COLOR[s.five.risk]),
    { text: ` ${s.five.used === undefined ? 'n/a' : `${Math.round(s.five.used)}%`}` },
    ...(isWide && s.five.resetsAt ? [{ text: ` ↻${fmtUntil(s.five.resetsAt, s.now)}`, dim: true }] : []),
    ...(isWide
      ? [
          { text: '   wk ', dim: true },
          ...meter(s.seven.used ?? 0, 6, RISK_COLOR[s.seven.risk] === 'inactive' ? 'success' : RISK_COLOR[s.seven.risk]),
          { text: ` ${s.seven.used === undefined ? 'n/a' : `${Math.round(s.seven.used)}%`}` },
        ]
      : []),
  ]
  const top = s.recs.find(r => r.id !== 'gate' && r.id !== 'ok')
  const buttons = (
    <Box flexDirection="row" gap={1}>
      <Button key="pause" plain dimColor={!s.controls.pauseAtNext} onPress={a.togglePause}>
        <Text color={s.controls.pauseAtNext ? 'warning' : undefined}>{s.controls.pauseAtNext ? '⏸ Pausing' : '⏸ Pause'}</Text>
      </Button>
      <Button key="finish" plain onPress={a.handoff}>
        <Text color={s.controls.handoffRequested ? 'warning' : 'claude'} bold>
          {s.controls.handoffRequested ? '⏭ Wrapping up' : '⏭ Finish & handoff'}
        </Text>
      </Button>
      <Button key="open" plain dimColor onPress={() => a.togglePane()}>☰</Button>
    </Box>
  )
  const meters = (
    <Button key="health" plain onPress={() => a.togglePane('health')}>
      {texts(els, meterRuns)}
    </Button>
  )
  // Narrow terminals give the controls a row of their own rather than squeezing them.
  if (cols < 90) {
    rows.push(<Box key="row-meters" flexDirection="row">{meters}</Box>)
    rows.push(
      <Box key="row-controls" flexDirection="row">
        <Box flexGrow={1} />
        {buttons}
      </Box>,
    )
  } else {
    rows.push(
      <Box key="row-meters" flexDirection="row">
        {meters}
        {top && cols >= 120 && (
          <Button key="rec-top" plain onPress={() => a.act(top)}>
            <Text color={SEVERITY_COLOR[top.severity]}>{`   ● ${clip(top.title, 28)}`}</Text>
          </Button>
        )}
        <Box flexGrow={1} />
        {buttons}
      </Box>,
    )
  }
  return <Box flexDirection="column">{rows}</Box>
}

// ---------------------------------------------------------------- pane

function heading(els: Els, label: string, right?: string): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold dimColor>{label.toUpperCase()}</Text>
      <Box flexGrow={1} />
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
}

const prov = (p: Provenance): Run => ({ text: ` ${PROV_LABEL[p]}`, color: PROV_COLOR[p], dim: true })

export function paneTerm(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Button } = els
  const W = Math.max(30, cols)
  const tab = (id: View['pane'], label: string) => (
    <Button key={`tab-${id}`} variant={s.view.pane === id ? 'primary' : 'secondary'} onPress={() => a.setPane(id)}>
      {label}
    </Button>
  )
  const body = s.view.pane === 'health' ? healthView(els, s, a, W) : s.view.pane === 'handoff' ? handoffView(els, s, a, W) : planView(els, s, a, W)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {tab('plan', `Plan ${s.plan ? `${s.progress.pct}%` : ''}`.trim())}
        {tab('health', `Health ${s.health.score}`)}
        {tab('handoff', s.handoff ? 'Handoff •' : 'Handoff')}
      </Box>
      {body}
    </Box>
  )
}

function controls(els: Els, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Button, Text } = els
  return (
    <Box flexDirection="column">
      {heading(els, 'Execution control')}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="c-pause" variant={s.controls.pauseAtNext ? 'primary' : 'secondary'} onPress={a.togglePause}>
          {s.controls.pauseAtNext ? '✓ Pause at checkpoint' : 'Pause at checkpoint'}
        </Button>
        <Button key="c-focus" variant={s.controls.focusUnit ? 'primary' : 'secondary'} onPress={a.toggleFocus}>
          {s.controls.focusUnit ? '✓ Finish unit first' : 'Finish unit first'}
        </Button>
        {s.controls.limitTaskId && (
          <Button key="c-limit" onPress={() => a.setLimit(undefined)}>{`Stop after ${s.controls.limitTaskId} ✕`}</Button>
        )}
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="c-handoff" variant="primary" onPress={a.handoff}>
          {s.controls.handoffRequested ? 'Wrapping up…' : 'Finish task & handoff'}
        </Button>
        <Button key="c-quick" onPress={a.quickHandoff}>Handoff now</Button>
        <Button key="c-stop" plain dimColor onPress={a.stopNow}>■ Stop now</Button>
      </Box>
      {s.stop && (
        <Text dimColor wrap="wrap">
          {clip(`Suggested stop after ${s.stop.id} ${s.stop.title}${s.stop.isMilestoneEnd ? ' (end of milestone)' : ''}: ${s.stop.tasks} more task${s.stop.tasks === 1 ? '' : 's'} fit the 5h window (estimate)`, W * 3)}
        </Text>
      )}
    </Box>
  )
}

function planView(els: Els, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Text, Button } = els
  if (!s.plan) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="inactive" paddingX={1} marginTop={1}>
          <Text dimColor wrap="wrap">
            No plan yet. Claude records one by itself for work of three or more steps (plan_set); TodoWrite and Task lists are mirrored here.
          </Text>
        </Box>
        {controls(els, s, a, W)}
      </Box>
    )
  }
  const plan = s.plan
  const inner = W - 4
  const hidden = new Set<string>()
  for (const id of s.view.collapsed) {
    const hide = (pid: string) => {
      for (const c of childrenOf(plan, pid)) {
        hidden.add(c.id)
        hide(c.id)
      }
    }
    hide(id)
  }
  // Milestones side by side, each as wide as its share of tasks.
  const ms = childrenOf(plan, undefined)
  const total = Math.max(1, leaves(plan).filter(n => n.status !== 'skipped').length)
  const msRuns: Run[] = []
  ms.forEach((m, i) => {
    const p = nodeProgress(plan, m)
    const w = Math.max(2, Math.floor(((inner - (ms.length - 1)) * p.total) / total))
    if (i > 0) msRuns.push({ text: ' ' })
    msRuns.push(...meter(p.pct, w, p.pct === 100 ? 'success' : 'merged'))
  })
  const cur = s.current ? `now ${s.current.id}` : s.progress.pct === 100 ? 'all done' : 'nothing running'
  const nextIds = s.next.filter(n => n.id !== s.current?.id).slice(0, 2).map(n => n.id).join(', ')
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={s.progress.pct === 100 ? 'success' : 'claude'} paddingX={1} marginTop={1}>
        <Box flexDirection="row">
          <Text bold wrap="truncate-end">{clip(plan.title, inner - 6)}</Text>
          <Box flexGrow={1} />
          <Text bold color={s.progress.pct === 100 ? 'success' : 'claude'}>{`${s.progress.pct}%`}</Text>
        </Box>
        {plan.goal && <Text dimColor wrap="wrap">{plan.goal}</Text>}
        <Box flexDirection="row">{texts(els, msRuns)}</Box>
        <Text dimColor wrap="truncate-end">{`${s.progress.done} of ${s.progress.total} tasks · ${cur}${nextIds ? ` · next ${nextIds}` : ''}`}</Text>
      </Box>
      {controls(els, s, a, W)}
      {heading(els, 'Plan', plan.source === 'tool' ? undefined : `from ${plan.source === 'todo' ? 'TodoWrite' : 'Tasks'}`)}
      <Box flexDirection="column">
        {ordered(plan)
          .filter(n => !hidden.has(n.id))
          .map(n => {
            const d = depth(plan, n)
            const hasKids = plan.nodes.some(c => c.parent === n.id)
            const isSelected = s.view.selected === n.id
            const isCollapsed = s.view.collapsed.includes(n.id)
            const p = hasKids ? nodeProgress(plan, n) : undefined
            const chips: Run[] = []
            if (n.checkpoint) chips.push({ text: ' ' }, chip('review', 'warning'))
            if (s.controls.limitTaskId === n.id) chips.push({ text: ' ' }, chip('stop', 'error'))
            if (n.status === 'blocked') chips.push({ text: ' ' }, chip('blocked', 'error'))
            const right: Run[] = [
              ...(n.deps.length && n.status === 'pending' ? [{ text: ` after ${n.deps.join(',')}`, dim: true }] : []),
              ...(p ? [{ text: ' ' }, ...meter(p.pct, 6, p.pct === 100 ? 'success' : 'merged'), { text: ` ${p.done}/${p.total}`, dim: true }] : []),
              ...(n.cost ? [{ text: ` ${fmtDuration(n.cost.ms)}`, dim: true }] : []),
            ]
            const lead = `${'  '.repeat(d)}${hasKids ? (isCollapsed ? '▸ ' : '▾ ') : '  '}`
            const extra = chips.reduce((k, r) => k + r.text.length, 0) + right.reduce((k, r) => k + r.text.length, 0)
            const room = Math.max(6, W - lead.length - n.id.length - extra - 5)
            const isMilestone = n.kind === 'milestone'
            return (
              <Box key={`row-${n.id}`} flexDirection="column">
                <Button key={`n:${n.id}`} plain onPress={() => a.select(isSelected ? undefined : n.id)}>
                  <Text dimColor>{lead}</Text>
                  <Text color={STATUS_COLOR[n.status]} bold={n.status === 'active'}>{GLYPH[n.status]}</Text>
                  <Text dimColor>{` ${n.id} `}</Text>
                  <Text
                    bold={isMilestone || n.status === 'active'}
                    dimColor={n.status === 'done' || n.status === 'skipped'}
                    inverse={isSelected}
                    strikethrough={n.status === 'skipped'}
                  >
                    {clip(n.title, room)}
                  </Text>
                  {texts(els, [...chips, ...right])}
                </Button>
                {isSelected && (
                  <Box flexDirection="column" marginLeft={d * 2 + 4}>
                    {n.note && <Text dimColor wrap="wrap">{n.note}</Text>}
                    <Box flexDirection="row" gap={1} flexWrap="wrap">
                      <Button key={`cp:${n.id}`} onPress={() => a.toggleCheckpoint(n.id)}>
                        {n.checkpoint ? 'Remove review' : 'Review after this'}
                      </Button>
                      <Button key={`lim:${n.id}`} onPress={() => a.setLimit(s.controls.limitTaskId === n.id ? undefined : n.id)}>
                        {s.controls.limitTaskId === n.id ? 'Clear stop' : 'Stop after this'}
                      </Button>
                      {hasKids && (
                        <Button key={`fold:${n.id}`} plain dimColor onPress={() => a.toggleCollapse(n.id)}>
                          {isCollapsed ? 'Expand' : 'Collapse'}
                        </Button>
                      )}
                    </Box>
                  </Box>
                )}
              </Box>
            )
          })}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text dimColor>✓ done  ● active  ○ pending  ⊘ blocked</Text>
        <Box flexGrow={1} />
        <Button key="clear-plan" plain dimColor onPress={a.clearPlan}>clear plan</Button>
      </Box>
    </Box>
  )
}

function usageRow(els: Els, label: string, w: WindowForecast, now: number, W: number): RenderElement {
  const { Box, Text } = els
  const barW = Math.max(8, Math.min(30, W - 26))
  if (w.used === undefined) {
    return (
      <Box flexDirection="row">
        {texts(els, [{ text: label.padEnd(8), bold: true }, { text: 'n/a — subscription windows only, after the first response', dim: true }])}
      </Box>
    )
  }
  const color = RISK_COLOR[w.risk] === 'inactive' ? 'success' : RISK_COLOR[w.risk]
  const atReset =
    w.perHour !== undefined && w.resetsAt ? w.used + (w.perHour * (Date.parse(w.resetsAt) - now)) / 3_600_000 : undefined
  const sub = [
    w.resetsAt ? `resets in ${fmtUntil(w.resetsAt, now)}` : '',
    w.perHour !== undefined ? `${round1(w.perHour)} pt/h` : '',
    w.etaMs !== undefined ? `full in ~${fmtDuration(w.etaMs)}` : '',
    `risk ${w.risk}`,
  ].filter(Boolean)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {texts(els, [{ text: label.padEnd(8), bold: true }, ...meter(w.used, barW, color, atReset), { text: ` ${round1(w.used)}%`, bold: true }, prov('official')])}
      </Box>
      <Box flexDirection="row" marginLeft={8}>
        <Text dimColor wrap="truncate-end">{clip(sub.join(' · '), W - 20)}</Text>
        {w.perHour !== undefined ? texts(els, [prov('estimate')]) : null}
      </Box>
    </Box>
  )
}

function healthView(els: Els, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Text, Button } = els
  const top = s.recs.find(r => r.id !== 'ok') ?? s.recs[0]
  const color = GRADE_COLOR[s.health.grade]
  const ctx = s.sample
  const barW = Math.max(8, Math.min(30, W - 26))
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
        <Box flexDirection="row">
          {texts(els, [
            { text: '♥ ', color },
            { text: `${s.health.score}`, bold: true, color },
            { text: ' / 100   ', dim: true },
            { text: `${GRADE_WORD[s.health.grade]} session`, bold: true },
          ])}
        </Box>
        <Text dimColor wrap="wrap">{top ? `${top.title}. ${top.detail}` : 'No sign that anything needs to change.'}</Text>
      </Box>

      {heading(els, 'Why this score')}
      {s.health.factors.length === 0 ? (
        <Text dimColor>Nothing lowers the score.</Text>
      ) : (
        s.health.factors.map(f => (
          <Box flexDirection="row">
            {texts(els, [
              { text: (f.delta < 0 ? String(f.delta) : '·').padStart(4), color: f.delta <= -10 ? 'error' : f.delta < 0 ? 'warning' : 'inactive', bold: true },
              { text: `  ${clip(f.label, W - 18)}` },
              prov(f.provenance),
            ])}
          </Box>
        ))
      )}

      {heading(els, 'Context & usage')}
      {ctx?.contextPct !== undefined ? (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {texts(els, [
              { text: 'Context'.padEnd(8), bold: true },
              ...meter(ctx.contextPct, barW, ctx.contextPct >= 85 ? 'error' : ctx.contextPct >= 70 ? 'warning' : 'success'),
              { text: ` ${ctx.contextPct}%`, bold: true },
              prov('official'),
            ])}
          </Box>
          <Box marginLeft={8}>
            <Text dimColor>{`${Math.round((ctx.contextTokens ?? 0) / 1000)}k of ${Math.round((ctx.window ?? 0) / 1000)}k tokens`}</Text>
          </Box>
        </Box>
      ) : (
        <Text dimColor>Context: reported after the first response.</Text>
      )}
      {usageRow(els, '5-hour', s.five, s.now, W)}
      {usageRow(els, 'Weekly', s.seven, s.now, W)}
      {ctx?.usd !== undefined && (
        <Box flexDirection="row">
          {texts(els, [{ text: 'Cost'.padEnd(8), bold: true }, { text: `$${ctx.usd.toFixed(2)} this session` }, prov('official')])}
        </Box>
      )}

      {heading(els, 'Model & effort')}
      <Box flexDirection="row">
        {texts(els, [
          { text: `${s.model ?? 'unknown'} · ${s.effort ?? 'default'}` },
          { text: '  →  ', dim: true },
          { text: `${s.advice.model} · ${s.advice.effort}`, bold: true, color: s.advice.isChange ? 'claude' : undefined },
          prov('heuristic'),
        ])}
      </Box>
      <Text dimColor wrap="wrap">{s.advice.reason}</Text>
      {s.advice.isChange && (
        <Box flexDirection="row">
          <Button
            key="apply-model"
            onPress={() => a.act({ id: 'model', severity: 'info', title: '', detail: '', action: 'model', arg: `${s.advice.model}:${s.advice.effort}`, provenance: 'heuristic' })}
          >
            {`Switch to ${s.advice.model} · ${s.advice.effort}`}
          </Button>
        </Box>
      )}

      {heading(els, 'Recommendations')}
      {s.recs.map(r => (
        <Box key={`rec-${r.id}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            {texts(els, [{ text: '▌ ', color: SEVERITY_COLOR[r.severity] }, { text: clip(r.title, W - 16), bold: true }, prov(r.provenance)])}
          </Box>
          <Box marginLeft={2} flexDirection="column">
            <Text dimColor wrap="wrap">{r.detail}</Text>
            {r.action && r.action !== 'continue' && (
              <Box flexDirection="row">
                <Button key={`rec:${r.id}`} onPress={() => a.act(r)}>{ACTION_LABEL[r.action]}</Button>
              </Box>
            )}
          </Box>
        </Box>
      ))}
      <Text dimColor wrap="wrap">official: reported by Claude Code · estimate: projected from this session · heuristic: rule of thumb</Text>
    </Box>
  )
}

function handoffView(els: Els, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Text, Button, Markdown } = els
  if (!s.handoff) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="inactive" paddingX={1} marginTop={1} flexDirection="column">
          <Text wrap="wrap">
            Handoff now: a short summary from what Claude already knows. Finish & handoff: it first stops at a consistent point and runs quick checks.
          </Text>
          <Text dimColor wrap="wrap">This session is never cleared: a new session in this project continues from the handoff.</Text>
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="h-quick" variant="primary" onPress={a.quickHandoff}>Handoff now</Button>
          <Button key="h-start" onPress={a.handoff}>
            {s.controls.handoffRequested ? 'Wrapping up…' : 'Finish task & handoff'}
          </Button>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="success" paddingX={1} marginTop={1} flexDirection="column">
        {texts(els, [chip('✎ READY', 'success'), { text: ` ${basename(s.handoff.path)}`, bold: true }, { text: ` · ${fmtDuration(s.now - s.handoff.createdAt)} ago`, dim: true }])}
        <Text dimColor wrap="truncate-middle">{clip(s.handoff.path, W * 2)}</Text>
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        <Button key="h-new" variant="primary" onPress={a.newSession}>Continue in a new session</Button>
        <Button key="h-reload" onPress={a.reloadHandoff}>Reload</Button>
        <Button key="h-discard" plain dimColor onPress={a.discardHandoff}>Discard</Button>
      </Box>
      <Markdown text={s.handoff.markdown} />
    </Box>
  )
}
