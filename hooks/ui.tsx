// Drawing for session-pilot: the band above the prompt and the side pane.
// Pure functions of a Snapshot; every press goes through Actions.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Controls, Gate, HandoffDraft, Plan, PlanNode, ResumeOffer, UsageSample, View } from '../types'
import {
  GLYPH,
  bar,
  basename,
  childrenOf,
  clip,
  depth,
  fmtDuration,
  fmtUntil,
  nodeProgress,
  ordered,
  round1,
} from './logic'
import { bandSvg, paneSvg } from './pictures'
import type {
  Factor,
  Health,
  ModelAdvice,
  Progress,
  Provenance,
  Recommendation,
  StopPoint,
  WindowForecast,
} from './logic'

type Table = Elements['terminal'] | Elements['desktop'] | Elements['vscode'] | Elements['mobile']
export type Els = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Markdown'> & {
  Svg?: Elements['desktop']['Svg']
}

/** The elements to draw with; pictures only where the surface paints them (the terminal draws none). */
export function pickEls(table: Table, surface: RenderSurface): Els {
  const t = table as Elements['desktop']
  const hasPictures = surface !== 'terminal' && 'Svg' in table && t.Svg !== undefined
  return { Box: t.Box, Text: t.Text, Button: t.Button, Markdown: t.Markdown, Svg: hasPictures ? t.Svg : undefined }
}

export type Snapshot = {
  now: number
  plan: Plan | null
  gate: Gate | null
  controls: Controls
  sample: UsageSample | undefined
  handoff: HandoffDraft | null
  resume: ResumeOffer | null
  view: View
  progress: Progress
  current: PlanNode | undefined
  next: PlanNode[]
  health: Health
  five: WindowForecast
  seven: WindowForecast
  advice: ModelAdvice
  stop: StopPoint | undefined
  recs: Recommendation[]
  model?: string
  effort?: string
}

export type Actions = {
  openPane: (view?: View['pane']) => void
  togglePane: (view?: View['pane']) => void
  setPane: (view: View['pane']) => void
  select: (id: string | undefined) => void
  toggleCollapse: (id: string) => void
  toggleCheckpoint: (id: string) => void
  setLimit: (id: string | undefined) => void
  togglePause: () => void
  toggleFocus: () => void
  handoff: () => void
  continueRun: (limitId?: string) => void
  dismissGate: () => void
  newSession: () => void
  quickHandoff: () => void
  reloadHandoff: () => void
  discardHandoff: () => void
  resume: () => void
  dismissResume: () => void
  act: (rec: Recommendation) => void
  stopNow: () => void
  clearPlan: () => void
}

const STATUS_COLOR: Record<PlanNode['status'], string> = {
  done: 'success',
  active: 'claude',
  pending: 'inactive',
  blocked: 'error',
  skipped: 'subtle',
}

const STATUS_HEX: Record<PlanNode['status'], string> = {
  done: '#3fb950',
  active: '#d97757',
  pending: '#8b949e55',
  blocked: '#f85149',
  skipped: '#8b949e30',
}

const GRADE_COLOR = { good: 'success', fair: 'suggestion', degraded: 'warning', poor: 'error' } as const
const RISK_COLOR = { low: 'success', medium: 'warning', high: 'error', unknown: 'inactive' } as const
const SEVERITY_COLOR = { info: 'suggestion', warn: 'warning', urgent: 'error' } as const
const PROV_LABEL: Record<Provenance, string> = {
  official: 'official',
  estimate: 'estimate',
  heuristic: 'heuristic',
  unavailable: 'n/a',
}

function pctText(n: number | undefined): string {
  return n === undefined ? '—' : `${round1(n)}%`
}

/** The plan as one strip of segments, one per leaf, gaps between milestones. */
function planSvg(plan: Plan, width: number): string {
  const all = ordered(plan)
  const leafNodes = all.filter(n => !plan.nodes.some(c => c.parent === n.id) && n.status !== 'skipped')
  if (leafNodes.length === 0) return ''
  const gap = 2
  const h = 8
  const unit = Math.max(2, (width - gap * (leafNodes.length - 1)) / leafNodes.length)
  let x = 0
  let lastMilestone: string | undefined
  const rects: string[] = []
  for (const n of leafNodes) {
    let top: PlanNode = n
    while (top.parent) top = plan.nodes.find(p => p.id === top.parent) ?? top
    if (lastMilestone !== undefined && top.id !== lastMilestone) x += 3
    lastMilestone = top.id
    const title = `${n.id} ${n.title} — ${n.status}${n.cost ? ` · ${fmtDuration(n.cost.ms)}` : ''}`
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
    rects.push(
      `<rect x="${x.toFixed(1)}" y="0" width="${unit.toFixed(1)}" height="${h}" rx="2" fill="${STATUS_HEX[n.status]}"><title>${title}</title></rect>`,
    )
    if (n.checkpoint) {
      rects.push(`<circle cx="${(x + unit - 2).toFixed(1)}" cy="2" r="1.6" fill="#a371f7"/>`)
    }
    x += unit + gap
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(x)}" height="${h}" viewBox="0 0 ${Math.ceil(x)} ${h}">${rects.join('')}</svg>`
}

// ---------------------------------------------------------------- band

function bandText(els: Els, s: Snapshot, a: Actions, cols: number, surface: RenderSurface): RenderElement {
  const { Box, Text, Button } = els
  const rows: RenderElement[] = []

  if (s.resume && !s.plan?.nodes.some(n => n.status === 'active')) {
    rows.push(
      <Box flexDirection="row" gap={1}>
        <Text color="suggestion">↩</Text>
        <Text wrap="truncate-end">
          {clip(`Handoff from ${fmtDuration(s.now - s.resume.createdAt)} ago${s.resume.nextStep ? ` · next: ${s.resume.nextStep}` : ''}`, Math.max(20, cols - 28))}
        </Text>
        <Button key="resume" variant="primary" onPress={a.resume}>Resume</Button>
        <Button key="resume-dismiss" plain dimColor onPress={a.dismissResume}>dismiss</Button>
      </Box>,
    )
  }

  if (s.gate && s.gate.kind !== 'handoff') {
    rows.push(
      <Box flexDirection="row" gap={1}>
        <Text color="warning" bold>⏸</Text>
        <Text bold wrap="truncate-end">{clip(s.gate.reason, Math.max(16, cols - 60))}</Text>
        <Button key="gate-continue" variant="primary" hotkey="c" onPress={() => a.continueRun()}>Continue</Button>
        {s.stop && s.stop.id !== s.gate.taskId && (
          <Button key="gate-continue-to" onPress={() => a.continueRun(s.stop!.id)}>{`Continue to ${s.stop.id}`}</Button>
        )}
        <Button key="gate-handoff" hotkey="h" onPress={a.handoff}>Handoff</Button>
        <Button key="gate-dismiss" plain dimColor onPress={a.dismissGate}>dismiss</Button>
      </Box>,
    )
  }

  if (s.handoff) {
    rows.push(
      <Box flexDirection="row" gap={1}>
        <Text color="success">✎</Text>
        <Text wrap="truncate-end">{clip(`Handoff ready: ${basename(s.handoff.path)}`, Math.max(16, cols - 44))}</Text>
        <Button key="handoff-review" onPress={() => a.openPane('handoff')}>Review</Button>
        <Button key="handoff-new" variant="primary" onPress={a.newSession}>Continue in a new session</Button>
      </Box>,
    )
  }

  // Plan line: the click target that opens the pane.
  if (s.plan) {
    const head = `${s.progress.done}/${s.progress.total}`
    const barWidth = Math.max(6, Math.min(16, Math.floor(cols / 10)))
    const svg = s.plan && els.Svg && surface !== 'terminal' ? planSvg(s.plan, Math.min(320, cols * 4)) : ''
    const cur = s.current ? `${s.current.id} ${s.current.title}` : s.progress.pct === 100 ? 'all done' : 'idle'
    const nextText = s.next.filter(n => n.id !== s.current?.id).slice(0, 2).map(n => n.id).join(', ')
    const room = Math.max(10, cols - (s.plan.title.length > 24 ? 24 : s.plan.title.length) - barWidth - head.length - 14)
    rows.push(
      <Box flexDirection="row" gap={1}>
        <Button key="plan" plain onPress={() => a.togglePane('plan')}>
          <Text color="claude" bold>{`◆ ${clip(s.plan.title, 24)}`}</Text>
          {' '}
          <Text color={s.progress.pct === 100 ? 'success' : 'claude'}>{svg ? '' : bar(s.progress.pct, barWidth)}</Text>
          {svg ? '' : ' '}
          <Text dimColor>{`${head} · ${s.progress.pct}%`}</Text>
        </Button>
        {svg && els.Svg && <els.Svg source={svg} alt={`Plan progress ${s.progress.pct}%`} isInteractive />}
        <Text color="claude">▸</Text>
        <Text wrap="truncate-end">
          {clip(cur + (nextText ? `  · next ${nextText}` : ''), room)}
        </Text>
      </Box>,
    )
  }

  // Health line: the state of the session, the top recommendation, the controls.
  const ctx = s.sample?.contextPct
  const top = s.recs.find(r => r.id !== 'gate' && r.id !== 'ok')
  rows.push(
    <Box flexDirection="row" gap={1}>
      <Button key="health" plain onPress={() => a.openPane('health')}>
        <Text color={GRADE_COLOR[s.health.grade]}>{`♥ ${s.health.score}`}</Text>
        {' '}
        <Text dimColor>ctx</Text>
        {` ${ctx === undefined ? '—' : `${ctx}%`} `}
        <Text dimColor>5h</Text>
        <Text color={RISK_COLOR[s.five.risk]}>{` ${pctText(s.five.used)}`}</Text>
        {s.five.resetsAt ? <Text dimColor>{` ↻${fmtUntil(s.five.resetsAt, s.now)}`}</Text> : ''}
        {' '}
        <Text dimColor>wk</Text>
        <Text color={RISK_COLOR[s.seven.risk]}>{` ${pctText(s.seven.used)}`}</Text>
      </Button>
      {top && cols >= 90 && (
        <Button key="rec-top" plain onPress={() => a.act(top)}>
          <Text color={SEVERITY_COLOR[top.severity]}>{`● ${clip(top.title, Math.max(12, cols - 100))}`}</Text>
        </Button>
      )}
      <Box flexGrow={1} />
      <Button key="pause" plain dimColor={!s.controls.pauseAtNext} onPress={a.togglePause}>
        <Text color={s.controls.pauseAtNext ? 'warning' : undefined}>{s.controls.pauseAtNext ? '⏸ pausing' : '⏸ pause'}</Text>
      </Button>
      <Button key="finish" plain dimColor={!s.controls.handoffRequested} onPress={a.handoff}>
        <Text color={s.controls.handoffRequested ? 'warning' : undefined}>
          {s.controls.handoffRequested ? '⏭ wrapping up' : '⏭ finish & handoff'}
        </Text>
      </Button>
      <Button key="open" plain dimColor onPress={() => a.togglePane()}>☰</Button>
    </Box>,
  )

  return <Box flexDirection="column">{rows}</Box>
}

// ---------------------------------------------------------------- pane

function paneText(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Button } = els
  const tab = (id: View['pane'], label: string) => (
    <Button key={`tab-${id}`} variant={s.view.pane === id ? 'primary' : 'secondary'} onPress={() => a.setPane(id)}>
      {label}
    </Button>
  )
  const body =
    s.view.pane === 'health' ? healthView(els, s, a, cols) : s.view.pane === 'handoff' ? handoffView(els, s, a, cols) : planView(els, s, a, cols)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        {tab('plan', s.plan ? `Plan ${s.progress.pct}%` : 'Plan')}
        {tab('health', `Health ${s.health.score}`)}
        {tab('handoff', s.handoff ? 'Handoff ✎' : 'Handoff')}
      </Box>
      {body}
    </Box>
  )
}

function controlsRow(els: Els, s: Snapshot, a: Actions): RenderElement {
  const { Box, Button, Text } = els
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="c-pause" onPress={a.togglePause}>
          {s.controls.pauseAtNext ? '⏸ Pause at next checkpoint: ON' : '⏸ Pause at next checkpoint'}
        </Button>
        <Button key="c-focus" onPress={a.toggleFocus}>
          {s.controls.focusUnit ? '◎ Finish unit first: ON' : '◎ Finish unit first'}
        </Button>
        {s.controls.limitTaskId && (
          <Button key="c-limit" onPress={() => a.setLimit(undefined)}>{`⤓ Limit ${s.controls.limitTaskId} ✕`}</Button>
        )}
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="c-handoff" variant="primary" onPress={a.handoff}>
          {s.controls.handoffRequested ? 'Wrapping up for handoff…' : 'Finish current task, reach a safe checkpoint, and prepare handoff'}
        </Button>
        <Button key="c-quick" onPress={a.quickHandoff}>Handoff now</Button>
        <Button key="c-stop" plain dimColor onPress={a.stopNow}>■ stop now</Button>
      </Box>
      {s.stop && (
        <Text dimColor wrap="wrap">
          {`Suggested stop: after ${s.stop.id} ${s.stop.title} (${s.stop.tasks} task${s.stop.tasks === 1 ? '' : 's'}${s.stop.isMilestoneEnd ? ', end of a milestone' : ''}; ${s.stop.basis}; estimate)`}
        </Text>
      )}
    </Box>
  )
}

function planView(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Text, Button } = els
  if (!s.plan) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor wrap="wrap">
          No plan yet. Ask Claude to plan the work: it records milestones, tasks and subtasks with the plan_set tool, and
          TodoWrite / Task lists are mirrored here automatically.
        </Text>
        {controlsRow(els, s, a)}
      </Box>
    )
  }
  const plan = s.plan
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
  const rows = ordered(plan).filter(n => !hidden.has(n.id))
  const width = Math.max(20, cols - 2)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold wrap="wrap">{plan.title}</Text>
        {plan.goal && <Text dimColor wrap="wrap">{plan.goal}</Text>}
        <Box flexDirection="row" gap={1}>
          <Text color={s.progress.pct === 100 ? 'success' : 'claude'}>{bar(s.progress.pct, Math.min(30, width - 22))}</Text>
          <Text dimColor>{`${s.progress.done}/${s.progress.total} · ${s.progress.pct}%${plan.source !== 'tool' ? ` · from ${plan.source === 'todo' ? 'TodoWrite' : 'Tasks'}` : ''}`}</Text>
        </Box>
      </Box>
      {controlsRow(els, s, a)}
      <Box flexDirection="column">
        {rows.map(n => {
          const d = depth(plan, n)
          const hasKids = plan.nodes.some(c => c.parent === n.id)
          const prog = hasKids ? nodeProgress(plan, n) : undefined
          const chips = [
            n.checkpoint ? '⚑' : '',
            s.controls.limitTaskId === n.id ? '⤓limit' : '',
            n.deps.length ? `⤳${n.deps.join(',')}` : '',
            prog ? `${prog.done}/${prog.total}` : '',
            n.cost ? fmtDuration(n.cost.ms) + (n.cost.fiveHourPct !== undefined ? ` ${n.cost.fiveHourPct}pt` : '') : '',
          ].filter(Boolean)
          const fold = hasKids ? (s.view.collapsed.includes(n.id) ? '▸ ' : '▾ ') : '  '
          const label = `${'  '.repeat(d)}${fold}`
          const chipText = chips.length ? `  ${chips.join(' ')}` : ''
          const room = Math.max(8, width - label.length - n.id.length - chipText.length - 4)
          const isSelected = s.view.selected === n.id
          return (
            <Box flexDirection="column">
              <Button key={`n:${n.id}`} plain onPress={() => a.select(isSelected ? undefined : n.id)}>
                {label}
                <Text color={STATUS_COLOR[n.status]}>{GLYPH[n.status]}</Text>
                {' '}
                <Text dimColor>{n.id}</Text>
                {' '}
                <Text bold={n.kind === 'milestone' || n.status === 'active'} dimColor={n.status === 'done' || n.status === 'skipped'} inverse={isSelected}>
                  {clip(n.title, room)}
                </Text>
                <Text color={n.checkpoint ? 'planMode' : undefined} dimColor={!n.checkpoint}>{chipText}</Text>
              </Button>
              {isSelected && (
                <Box flexDirection="column" marginLeft={d * 2 + 4}>
                  {n.note && <Text dimColor wrap="wrap">{`note: ${n.note}`}</Text>}
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    <Button key={`cp:${n.id}`} onPress={() => a.toggleCheckpoint(n.id)}>
                      {n.checkpoint ? '⚑ Remove checkpoint' : '⚑ Pause for review here'}
                    </Button>
                    <Button key={`lim:${n.id}`} onPress={() => a.setLimit(s.controls.limitTaskId === n.id ? undefined : n.id)}>
                      {s.controls.limitTaskId === n.id ? '⤓ Clear limit' : '⤓ Stop after this'}
                    </Button>
                    {hasKids && (
                      <Button key={`fold:${n.id}`} plain dimColor onPress={() => a.toggleCollapse(n.id)}>
                        {s.view.collapsed.includes(n.id) ? 'expand' : 'collapse'}
                      </Button>
                    )}
                  </Box>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>✓ done  ● active  ○ pending  ⊘ blocked  ⚑ checkpoint  ⤳ depends on</Text>
        <Box flexGrow={1} />
        <Button key="clear-plan" plain dimColor onPress={a.clearPlan}>clear plan</Button>
      </Box>
    </Box>
  )
}

function provTag(els: Els, p: Provenance): RenderElement {
  const { Text } = els
  return <Text color={p === 'official' ? 'success' : p === 'unavailable' ? 'inactive' : 'suggestion'} dimColor>{`[${PROV_LABEL[p]}]`}</Text>
}

function windowRow(els: Els, label: string, w: WindowForecast, now: number, width: number): RenderElement {
  const { Box, Text } = els
  if (w.used === undefined) {
    return (
      <Box flexDirection="row" gap={1}>
        <Text>{label}</Text>
        <Text dimColor>no reading (subscription windows only, after the first response)</Text>
        {provTag(els, 'unavailable')}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text>{label.padEnd(8)}</Text>
        <Text color={RISK_COLOR[w.risk]}>{bar(w.used, Math.min(24, width - 30))}</Text>
        <Text>{pctText(w.used)}</Text>
        <Text dimColor>{w.resetsAt ? `resets in ${fmtUntil(w.resetsAt, now)}` : ''}</Text>
        {provTag(els, 'official')}
      </Box>
      <Box flexDirection="row" gap={1} marginLeft={9}>
        <Text dimColor>
          {w.perHour !== undefined
            ? `pace ${round1(w.perHour)} pt/h over ${w.basisMin}m · ${w.etaMs !== undefined ? `full in ~${fmtDuration(w.etaMs)}` : 'not rising'} · risk ${w.risk}`
            : `pace: not enough readings yet · risk ${w.risk}`}
        </Text>
        {provTag(els, 'estimate')}
      </Box>
    </Box>
  )
}

function healthView(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Text, Button } = els
  const width = Math.max(30, cols - 2)
  const ctx = s.sample
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color={GRADE_COLOR[s.health.grade]}>{`Session health ${s.health.score}/100 · ${s.health.grade}`}</Text>
        </Box>
        {s.health.factors.length === 0 && <Text dimColor>No factor lowers the score.</Text>}
        {s.health.factors.map((f: Factor) => (
          <Box flexDirection="row" gap={1}>
            <Text color={f.delta < 0 ? 'warning' : 'inactive'}>{f.delta < 0 ? String(f.delta).padStart(4) : '   ·'}</Text>
            <Text wrap="truncate-end">{clip(f.label, width - 22)}</Text>
            {provTag(els, f.provenance)}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>Context window</Text>
        {ctx?.contextPct !== undefined ? (
          <Box flexDirection="row" gap={1}>
            <Text color={ctx.contextPct >= 85 ? 'error' : ctx.contextPct >= 70 ? 'warning' : 'success'}>
              {bar(ctx.contextPct, Math.min(24, width - 30))}
            </Text>
            <Text>{`${ctx.contextPct}%`}</Text>
            <Text dimColor>{`${Math.round((ctx.contextTokens ?? 0) / 1000)}k / ${Math.round((ctx.window ?? 0) / 1000)}k tokens`}</Text>
            {provTag(els, 'official')}
          </Box>
        ) : (
          <Text dimColor>Not reported until the first response of this window.</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>Usage limits</Text>
        {windowRow(els, '5-hour', s.five, s.now, width)}
        {windowRow(els, 'Weekly', s.seven, s.now, width)}
        {s.sample?.usd !== undefined && (
          <Box flexDirection="row" gap={1}>
            <Text>{'Cost'.padEnd(8)}</Text>
            <Text>{`$${s.sample.usd.toFixed(2)} this session`}</Text>
            {provTag(els, 'official')}
          </Box>
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>Model & effort</Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>now</Text>
          <Text>{`${s.model ?? '—'} · effort ${s.effort ?? 'default'}`}</Text>
          {provTag(els, s.model ? 'official' : 'unavailable')}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>fits</Text>
          <Text>{`${s.advice.model} · ${s.advice.effort}`}</Text>
          {provTag(els, 'heuristic')}
          {s.advice.isChange && (
            <Button key="apply-model" onPress={() => a.act({ id: 'model', severity: 'info', title: '', detail: '', action: 'model', arg: `${s.advice.model}:${s.advice.effort}`, provenance: 'heuristic' })}>
              Apply
            </Button>
          )}
        </Box>
        <Text dimColor wrap="wrap">{s.advice.reason}</Text>
      </Box>

      <Box flexDirection="column">
        <Text bold>Recommendations</Text>
        {s.recs.map(r => (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={SEVERITY_COLOR[r.severity]}>●</Text>
              <Text bold wrap="truncate-end">{clip(r.title, width - 34)}</Text>
              {provTag(els, r.provenance)}
              {r.action && r.action !== 'continue' && (
                <Button key={`rec:${r.id}`} onPress={() => a.act(r)}>
                  {ACTION_LABEL[r.action]}
                </Button>
              )}
            </Box>
            <Text dimColor wrap="wrap">{r.detail}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor wrap="wrap">
        official = reported by Claude Code · estimate = projected from readings this session · heuristic = rule of thumb · n/a = not reported
      </Text>
    </Box>
  )
}

const ACTION_LABEL: Record<NonNullable<Recommendation['action']>, string> = {
  compact: 'Compact now',
  handoff: 'Finish & handoff',
  pause: 'Pause',
  model: 'Apply',
  continue: 'Continue',
  limit: 'Set limit',
  review: 'Review',
  replan: 'Ask to re-plan',
}

function handoffView(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Text, Button, Markdown } = els
  if (!s.handoff) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text wrap="wrap">
          No handoff yet. Handoff now: Claude writes a short summary from what it already knows. Finish & handoff: it first
          stops at a consistent point and runs quick checks. This session is never cleared: a new session in this project
          offers to resume from the handoff.
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="h-quick" variant="primary" onPress={a.quickHandoff}>Handoff now</Button>
          <Button key="h-start" onPress={a.handoff}>
            {s.controls.handoffRequested ? 'Wrapping up…' : 'Finish & prepare handoff'}
          </Button>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="wrap">{`${s.handoff.path} · written ${fmtDuration(s.now - s.handoff.createdAt)} ago · edit the file freely, then Reload`}</Text>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="h-new" variant="primary" onPress={a.newSession}>Continue in a new session</Button>
        <Button key="h-reload" onPress={a.reloadHandoff}>Reload</Button>
        <Button key="h-discard" plain dimColor onPress={a.discardHandoff}>discard</Button>
      </Box>
      <Markdown text={s.handoff.markdown} />
    </Box>
  )
}

// ---------------------------------------------------------------- per surface

/** Pictures where the surface draws them (desktop, vscode, mobile), text on the terminal. */
export function band(els: Els, s: Snapshot, a: Actions, cols: number, surface: RenderSurface): RenderElement {
  return els.Svg ? bandSvg(els, els.Svg, s, a, cols) : bandText(els, s, a, cols, surface)
}

export function pane(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  return els.Svg ? paneSvg(els, els.Svg, s, a, cols) : paneText(els, s, a, cols)
}
