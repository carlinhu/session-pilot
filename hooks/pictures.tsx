// The band and the pane on surfaces that draw pictures (desktop, vscode,
// mobile): every visual is an SVG from draw.ts, every action a native button.

import type { RenderElement } from 'claude-code'

import type { View } from '../types'
import * as D from './draw'
import { childrenOf, depth, fmtDuration, nodeProgress, ordered } from './logic'
import type { Recommendation } from './logic'
import type { Actions, Els, Snapshot } from './ui'

type SvgEl = NonNullable<Els['Svg']>

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

/** What a native button takes across, estimated: its label and the button's own padding. */
const buttonPx = (label: string) => Math.round(label.length * 7.6 + 34)

function stripInput(s: Snapshot): D.StripInput {
  return {
    plan: s.plan!,
    current: s.current,
    pct: s.progress.pct,
    done: s.progress.done,
    total: s.progress.total,
    limitId: s.controls.limitTaskId,
    isPaused: s.gate !== null && s.gate.kind !== 'handoff',
  }
}

type AlertButton = { key: string; label: string; primary?: boolean; onPress: () => void }

// ---------------------------------------------------------------- band

export function bandSvg(els: Els, Svg: SvgEl, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Button } = els
  const W = Math.max(360, cols * D.PX_PER_COL)
  const rows: RenderElement[] = []

  const alert = (key: string, kind: D.BannerKind, title: string, detail: string, buttons: AlertButton[]) => {
    const used = buttons.reduce((sum, b) => sum + buttonPx(b.label) + 8, 0)
    // The banner is as wide as its words; the buttons go beside it, or under it where the row is short.
    const isStacked = W - used - 8 < 280
    const w = Math.min(isStacked ? W : W - used - 8, Math.max(240, D.bannerWidth(title, detail)))
    const buttonRow = buttons.map(b => (
      <Button key={b.key} variant={b.primary ? 'primary' : 'secondary'} onPress={b.onPress}>
        {b.label}
      </Button>
    ))
    rows.push(
      <Box key={key} flexDirection={isStacked ? 'column' : 'row'} alignItems={isStacked ? 'flex-start' : 'center'} gap={1}>
        <Svg source={D.banner(kind, title, detail, w)} alt={`${title}. ${detail}`} width={w} height={30} />
        {isStacked ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {buttonRow}
          </Box>
        ) : (
          buttonRow
        )}
      </Box>,
    )
  }

  if (s.stale) {
    alert('row-stale', 'resume', `session-pilot ${s.stale} is installed`, 'this session runs an older copy: open a new session to use it', [])
  }

  if (s.gate && s.gate.kind !== 'handoff' && !s.handoff) {
    const buttons: AlertButton[] = [{ key: 'gate-continue', label: 'Continue', primary: true, onPress: () => a.continueRun() }]
    if (s.stop && s.stop.id !== s.gate.taskId) {
      buttons.push({ key: 'gate-continue-to', label: `Continue to ${s.stop.id}`, onPress: () => a.continueRun(s.stop!.id) })
    }
    buttons.push({ key: 'gate-handoff', label: 'Handoff', onPress: a.handoff })
    buttons.push({ key: 'gate-dismiss', label: 'Dismiss', onPress: a.dismissGate })
    alert('row-gate', 'pause', 'Waiting for your review', s.gate.reason, buttons)
  }
  if (s.handoff) {
    alert('row-handoff', 'handoff', 'Handoff ready', `written ${fmtDuration(s.now - s.handoff.createdAt)} ago`, [
      { key: 'handoff-review', label: 'Review', onPress: () => a.openPane('handoff') },
      { key: 'handoff-copy', label: 'Copy handoff', primary: true, onPress: () => a.copyHandoff() },
    ])
  } else if (s.controls.handoffRequested) {
    alert('row-wrap', 'wrap', 'Wrapping up', 'finishing the current unit, running checks, then writing the handoff', [])
  }

  if (s.plan) {
    const w = W - buttonPx('Plan') - 10
    rows.push(
      <Box key="row-plan" flexDirection="row" alignItems="center" gap={1}>
        <Svg
          source={D.planStrip(stripInput(s), w)}
          alt={`${s.plan.title}: ${s.progress.done} of ${s.progress.total} tasks, ${s.progress.pct}%${s.current ? `, now ${s.current.id} ${s.current.title}` : ''}`}
          width={w}
          height={30}
          isInteractive
        />
        <Button key="plan" plain dimColor onPress={() => a.togglePane('plan')}>
          Plan
        </Button>
      </Box>,
    )
  }

  const pause = s.controls.pauseAtNext ? 'Pausing at checkpoint' : 'Pause'
  const finish = s.controls.handoffRequested ? 'Wrapping up…' : 'Finish & handoff'
  const mw = Math.max(200, W - buttonPx(pause) - buttonPx(finish) - buttonPx('Dashboard') - 30)
  const top = s.recs.find(r => r.id !== 'gate' && r.id !== 'ok')
  rows.push(
    <Box key="row-meters" flexDirection="row" alignItems="center" gap={1}>
      <Svg
        source={D.meterStrip({ health: s.health, contextPct: s.sample?.contextPct, five: s.five, seven: s.seven, now: s.now, top }, mw)}
        alt={`Health ${s.health.score}. Context ${s.sample?.contextPct ?? 'n/a'}%. Five-hour window ${s.five.used ?? 'n/a'}%. Week ${s.seven.used ?? 'n/a'}%.${top ? ` ${top.title}.` : ''}`}
        width={mw}
        height={24}
      />
      <Box flexGrow={1} />
      <Button key="pause" plain dimColor={!s.controls.pauseAtNext} onPress={a.togglePause}>
        {pause}
      </Button>
      <Button key="finish" variant={s.controls.handoffRequested ? 'secondary' : 'primary'} onPress={a.handoff}>
        {finish}
      </Button>
      <Button key="open" plain dimColor onPress={() => a.togglePane()}>
        Dashboard
      </Button>
    </Box>,
  )
  return <Box flexDirection="column" gap={1}>{rows}</Box>
}

// ---------------------------------------------------------------- pane

export function paneSvg(els: Els, Svg: SvgEl, s: Snapshot, a: Actions, cols: number): RenderElement {
  const { Box, Button } = els
  const W = Math.max(300, cols * D.PX_PER_COL - 16)
  const tab = (id: View['pane'], label: string) => (
    <Button key={`tab-${id}`} variant={s.view.pane === id ? 'primary' : 'secondary'} onPress={() => a.setPane(id)}>
      {label}
    </Button>
  )
  const body =
    s.view.pane === 'health'
      ? healthView(els, Svg, s, a, W)
      : s.view.pane === 'handoff'
        ? handoffView(els, Svg, s, a, W)
        : planView(els, Svg, s, a, W)
  return (
    <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
      <Box flexDirection="row" gap={1}>
        {tab('plan', 'Plan')}
        {tab('health', 'Health')}
        {tab('handoff', s.handoff ? 'Handoff •' : 'Handoff')}
      </Box>
      {body}
    </Box>
  )
}

function section(Svg: SvgEl, key: string, label: string, W: number, right?: string): RenderElement {
  return <Svg key={key} source={D.sectionLabel(label, W, right)} alt={label} width={W} height={18} />
}

function noteSvg(Svg: SvgEl, key: string, content: string, W: number, maxLines: number): RenderElement {
  return <Svg key={key} source={D.note(content, W, maxLines)} alt={content} width={W} />
}

function executionControls(els: Els, Svg: SvgEl, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Button } = els
  return (
    <Box flexDirection="column" gap={1}>
      {section(Svg, 'sec-exec', 'Execution control', W)}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="c-pause" variant={s.controls.pauseAtNext ? 'primary' : 'secondary'} onPress={a.togglePause}>
          {s.controls.pauseAtNext ? '✓ Pause at next checkpoint' : 'Pause at next checkpoint'}
        </Button>
        <Button key="c-focus" variant={s.controls.focusUnit ? 'primary' : 'secondary'} onPress={a.toggleFocus}>
          {s.controls.focusUnit ? '✓ Finish unit first' : 'Finish unit first'}
        </Button>
        {s.controls.limitTaskId && (
          <Button key="c-limit" onPress={() => a.setLimit(undefined)}>
            {`Stop after ${s.controls.limitTaskId}  ✕`}
          </Button>
        )}
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <Button key="c-handoff" variant="primary" onPress={a.handoff}>
          {s.controls.handoffRequested ? 'Wrapping up for handoff…' : 'Finish task, checkpoint & handoff'}
        </Button>
        <Button key="c-quick" onPress={a.quickHandoff}>
          Handoff now
        </Button>
        <Button key="c-stop" plain dimColor onPress={a.stopNow}>
          Stop now
        </Button>
      </Box>
      {s.stop &&
        noteSvg(
          Svg,
          'stop-note',
          `Suggested stop: after ${s.stop.id} ${s.stop.title}${s.stop.isMilestoneEnd ? ' (end of a milestone)' : ''}. ${s.stop.tasks} more task${s.stop.tasks === 1 ? '' : 's'} fit the 5-hour window (estimate; ${s.stop.basis}).`,
          W,
          3,
        )}
    </Box>
  )
}

function planView(els: Els, Svg: SvgEl, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Button } = els
  if (!s.plan) {
    return (
      <Box flexDirection="column" gap={1}>
        {noteSvg(
          Svg,
          'empty',
          'No plan yet. Ask Claude to plan the work: it records milestones, tasks and subtasks with plan_set. TodoWrite and Task lists are mirrored here automatically.',
          W,
          4,
        )}
        {executionControls(els, Svg, s, a, W)}
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
  const rowW = W - 40
  const rows = ordered(plan).filter(n => !hidden.has(n.id))
  return (
    <Box flexDirection="column" gap={1}>
      <Svg
        key="summary"
        source={D.summaryCard({ ...stripInput(s), next: s.next, goal: plan.goal }, W)}
        alt={`${plan.title}: ${s.progress.done} of ${s.progress.total} tasks, ${s.progress.pct}%`}
        width={W}
      />
      {executionControls(els, Svg, s, a, W)}
      {section(Svg, 'sec-plan', 'Plan', W, plan.source === 'tool' ? undefined : `mirrored from ${plan.source === 'todo' ? 'TodoWrite' : 'Tasks'}`)}
      <Box flexDirection="column">
        {rows.map(n => {
          const d = depth(plan, n)
          const hasKids = plan.nodes.some(c => c.parent === n.id)
          const isSelected = s.view.selected === n.id
          const isCollapsed = s.view.collapsed.includes(n.id)
          const input: D.RowInput = {
            node: n,
            depth: d,
            isSelected,
            isLimit: s.controls.limitTaskId === n.id,
            isCollapsed,
            progress: hasKids ? nodeProgress(plan, n) : undefined,
          }
          const isHeader = n.kind === 'milestone' && hasKids
          return (
            <Box key={`row-${n.id}`} flexDirection="column">
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Svg
                  source={isHeader ? D.milestoneRow(input, rowW) : D.taskRow(input, rowW)}
                  alt={`${n.id} ${n.title}: ${n.status}`}
                  width={rowW}
                  height={isHeader ? 34 : 28}
                />
                <Button key={`n:${n.id}`} plain dimColor onPress={() => a.select(isSelected ? undefined : n.id)}>
                  {isSelected ? '✕' : '⋯'}
                </Button>
              </Box>
              {isSelected && n.note && noteSvg(Svg, `note:${n.id}`, n.note, rowW, 3)}
              {isSelected && (
                <Box flexDirection="row" gap={1} flexWrap="wrap" marginLeft={2 + d * 2} marginBottom={1}>
                  <Button key={`cp:${n.id}`} onPress={() => a.toggleCheckpoint(n.id)}>
                    {n.checkpoint ? 'Remove review checkpoint' : 'Pause for review after this'}
                  </Button>
                  <Button key={`lim:${n.id}`} onPress={() => a.setLimit(s.controls.limitTaskId === n.id ? undefined : n.id)}>
                    {s.controls.limitTaskId === n.id ? 'Clear stop' : 'Stop the run after this'}
                  </Button>
                  {hasKids && (
                    <Button key={`fold:${n.id}`} plain dimColor onPress={() => a.toggleCollapse(n.id)}>
                      {isCollapsed ? 'Expand' : 'Collapse'}
                    </Button>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="clear-plan" plain dimColor onPress={a.clearPlan}>
          Clear plan
        </Button>
      </Box>
    </Box>
  )
}

function healthView(els: Els, Svg: SvgEl, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Button } = els
  const top = s.recs.find(r => r.id !== 'ok') ?? s.recs[0]
  const verdict = top ? `${top.title}. ${top.detail}` : 'No sign that anything needs to change.'
  const ctx = s.sample
  const meterW = W < 560 ? W : Math.floor((W - 8) / 2)
  return (
    <Box flexDirection="column" gap={1}>
      <Svg key="score" source={D.scoreCard(s.health, verdict, W)} alt={`Session health ${s.health.score} of 100, ${s.health.grade}`} width={W} height={92} />

      {section(Svg, 'sec-why', 'Why this score', W)}
      <Box flexDirection="column">
        {s.health.factors.length === 0
          ? noteSvg(Svg, 'nofactor', 'Nothing lowers the score.', W, 1)
          : s.health.factors.map((f, i) => (
              <Svg key={`f${i}`} source={D.factorRow(f, W)} alt={`${f.delta} ${f.label} (${f.provenance})`} width={W} height={24} />
            ))}
      </Box>

      {section(Svg, 'sec-usage', 'Context & usage limits', W)}
      <Svg
        key="m-ctx"
        source={D.meterCard(
          'Context window',
          {
            used: ctx?.contextPct,
            provenance: 'official',
            sub: ctx?.contextTokens !== undefined ? `${Math.round(ctx.contextTokens / 1000)}k of ${Math.round((ctx.window ?? 0) / 1000)}k tokens` : undefined,
          },
          s.now,
          W,
        )}
        alt={`Context window ${ctx?.contextPct ?? 'n/a'}% full`}
        width={W}
        height={82}
      />
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Svg key="m-5h" source={D.meterCard('5-hour window', s.five, s.now, meterW)} alt={`5-hour window ${s.five.used ?? 'n/a'}% used, risk ${s.five.risk}`} width={meterW} height={82} />
        <Svg key="m-wk" source={D.meterCard('Weekly quota', s.seven, s.now, meterW)} alt={`Weekly quota ${s.seven.used ?? 'n/a'}% used`} width={meterW} height={82} />
      </Box>
      {ctx?.usd !== undefined && noteSvg(Svg, 'cost', `Session cost so far: $${ctx.usd.toFixed(2)} (official).`, W, 1)}

      {section(Svg, 'sec-model', 'Model & effort', W)}
      <Svg
        key="model"
        source={D.modelCard(`${s.model ?? 'unknown'} · ${s.effort ?? 'default'}`, `${s.advice.model} · ${s.advice.effort}`, s.advice.reason, s.advice.isChange, W)}
        alt={`Now ${s.model ?? 'unknown'}, suggested ${s.advice.model} ${s.advice.effort}`}
        width={W}
      />
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

      {section(Svg, 'sec-recs', 'Recommendations', W)}
      {s.recs.map(r => (
        <Box key={`rec-${r.id}`} flexDirection="column" gap={1}>
          <Svg source={D.recCard(r, W)} alt={`${r.title}. ${r.detail}`} width={W} />
          {r.action && r.action !== 'continue' && (
            <Box flexDirection="row">
              <Button key={`rec:${r.id}`} onPress={() => a.act(r)}>
                {ACTION_LABEL[r.action]}
              </Button>
            </Box>
          )}
        </Box>
      ))}
      {noteSvg(Svg, 'legend', 'official: reported by Claude Code · estimate: projected from this session’s readings · heuristic: rule of thumb · n/a: not reported', W, 3)}
    </Box>
  )
}

function handoffView(els: Els, Svg: SvgEl, s: Snapshot, a: Actions, W: number): RenderElement {
  const { Box, Button, Markdown } = els
  if (!s.handoff) {
    return (
      <Box flexDirection="column" gap={1}>
        {noteSvg(
          Svg,
          'h-about',
          'Handoff now: Claude writes a short summary from what it already knows, no more work. Finish & handoff: Claude first stops at a consistent point of the current task and runs quick checks. Either way the handoff is a one-minute read, copied to the clipboard and shown here: paste it into a new session. Nothing is stored or sent on its own, and this session is never cleared.',
          W,
          7,
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="h-quick" variant="primary" onPress={a.quickHandoff}>
            Handoff now
          </Button>
          <Button key="h-start" onPress={a.handoff}>
            {s.controls.handoffRequested ? 'Wrapping up…' : 'Finish task, checkpoint & handoff'}
          </Button>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Svg
        key="h-ready"
        source={D.banner('handoff', 'Handoff ready', `written ${fmtDuration(s.now - s.handoff.createdAt)} ago`, W)}
        alt="Handoff ready"
        width={W}
        height={30}
      />
      {noteSvg(Svg, 'h-where', 'Copied to the clipboard: open a new session and paste it (Ctrl+V). Nothing is stored or sent on its own; it goes when this session closes.', W, 3)}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="h-copy" variant="primary" onPress={e => a.copyHandoff(e.surface)}>
          Copy handoff
        </Button>
        <Button key="h-discard" plain dimColor onPress={a.discardHandoff}>
          Discard
        </Button>
      </Box>
      <Markdown text={s.handoff.markdown} />
    </Box>
  )
}
