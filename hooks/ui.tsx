// Drawing for session-pilot: what a drawing reads (Snapshot), what it can do
// (Actions), and which renderer draws it: pictures where the surface paints
// them (pictures.tsx), character art on the terminal (terminal.tsx).

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Controls, Gate, HandoffDraft, Plan, PlanNode, ResumeOffer, UsageSample, View } from '../types'
import { bandSvg, paneSvg } from './pictures'
import { bandTerm, paneTerm } from './terminal'
import type { Health, ModelAdvice, Progress, Recommendation, StopPoint, WindowForecast } from './logic'

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
  /** A newer installed version than the one this session runs. */
  stale?: string | null
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

// ---------------------------------------------------------------- per surface

/** Pictures where the surface draws them (desktop, vscode, mobile), text on the terminal. */
export function band(els: Els, s: Snapshot, a: Actions, cols: number, _surface: RenderSurface): RenderElement {
  return els.Svg ? bandSvg(els, els.Svg, s, a, cols) : bandTerm(els, s, a, cols)
}

export function pane(els: Els, s: Snapshot, a: Actions, cols: number): RenderElement {
  return els.Svg ? paneSvg(els, els.Svg, s, a, cols) : paneTerm(els, s, a, cols)
}
