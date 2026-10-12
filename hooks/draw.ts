// SVG pictures for the surfaces that draw them (desktop, vscode, mobile).
// Pure string builders: every picture carries its own dark and light palette
// (the surface draws it as an image over a background no event reports), and
// sizes come in CSS pixels, about 8 per column the surface reports.

import type { Plan, PlanNode } from '../types'
import { GLYPH, fmtDuration, leaves, milestoneOf, nodeProgress, ordered, round1 } from './logic'
import type { Factor, Health, Provenance, Recommendation, WindowForecast } from './logic'

export const PX_PER_COL = 8

const SANS = `'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif`
const MONO = `ui-monospace,'Cascadia Mono','SF Mono',Consolas,monospace`

const STYLE = `<style>
svg{--ink:#ECEAE4;--dim:#A6A39B;--faint:#75736C;--track:rgba(255,255,255,.09);--seg:rgba(255,255,255,.13);--card:rgba(255,255,255,.045);--line:rgba(255,255,255,.10);--page:#1F1E1D;
--acc:#9C85D8;--ok:#5DB075;--warn:#D4A04C;--bad:#E07A80;--info:#7AA7E0;--on:#FFFFFF}
@media (prefers-color-scheme:light){svg{--ink:#1F1E1D;--dim:#5B5A56;--faint:#8A8880;--track:rgba(0,0,0,.07);--seg:rgba(0,0,0,.10);--card:rgba(0,0,0,.035);--line:rgba(0,0,0,.10);--page:#FFFFFF;
--acc:#6A4DB2;--ok:#1F8A45;--warn:#A86A00;--bad:#B13038;--info:#2F6DB5;--on:#FFFFFF}}
.ink{fill:var(--ink)}.dim{fill:var(--dim)}.faint{fill:var(--faint)}.track{fill:var(--track)}.seg{fill:var(--seg)}.card{fill:var(--card)}
.acc{fill:var(--acc)}.ok{fill:var(--ok)}.warn{fill:var(--warn)}.bad{fill:var(--bad)}.info{fill:var(--info)}.on{fill:var(--on)}.page{fill:var(--page)}
.sacc{stroke:var(--acc)}.sok{stroke:var(--ok)}.swarn{stroke:var(--warn)}.sbad{stroke:var(--bad)}.sinfo{stroke:var(--info)}.sline{stroke:var(--line)}.sfaint{stroke:var(--faint)}.strack{stroke:var(--track)}.spage{stroke:var(--page)}
.h1{font:600 15px ${SANS}}.h{font:600 13px ${SANS}}.b{font:500 12px ${SANS}}.r{font:400 12px ${SANS}}.s{font:500 11px ${SANS}}.cap{font:600 10px ${SANS};letter-spacing:.06em}
.m{font:500 11px ${MONO}}.big{font:600 22px ${SANS}}.pill{font:600 11px ${SANS}}
.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.5}}
</style>`

export type Tone = 'acc' | 'ok' | 'warn' | 'bad' | 'info' | 'faint'

// ---------------------------------------------------------------- helpers

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Approximate width of `text` in px at a font size (proportional sans). */
export function textW(text: string, size: number, weight = 500): number {
  return text.length * size * (weight >= 600 ? 0.58 : 0.55)
}

export function fit(text: string, maxPx: number, size: number, weight = 500): string {
  if (maxPx <= 0) return ''
  if (textW(text, size, weight) <= maxPx) return text
  const n = Math.max(0, Math.floor(maxPx / (size * (weight >= 600 ? 0.58 : 0.55))) - 1)
  return n <= 0 ? '' : text.slice(0, n).trimEnd() + '…'
}

/** Word wrap to `maxPx`, at most `maxLines` lines, the last one ellipsized. */
export function wrap(text: string, maxPx: number, size: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (textW(next, size) <= maxPx) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = w
    if (lines.length === maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = fit(lines[maxLines - 1]! + ' …………', maxPx, size)
  }
  return lines.map(l => fit(l, maxPx, size))
}

function svg(w: number, h: number, body: string): string {
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${STYLE}${body}</svg>`
}

function text(x: number, y: number, cls: string, content: string, extra = ''): string {
  return `<text x="${round1(x)}" y="${round1(y)}" class="${cls}"${extra}>${esc(content)}</text>`
}

function bar(x: number, y: number, w: number, h: number, pct: number, tone: Tone): string {
  const fw = Math.max(0, Math.min(w, (w * pct) / 100))
  return (
    `<rect x="${round1(x)}" y="${round1(y)}" width="${round1(w)}" height="${h}" rx="${h / 2}" class="track"/>` +
    (fw > 0 ? `<rect x="${round1(x)}" y="${round1(y)}" width="${round1(Math.max(h, fw))}" height="${h}" rx="${h / 2}" class="${tone}"/>` : '')
  )
}

function badge(x: number, y: number, label: string, tone: Tone, anchorEnd = false): { svg: string; w: number } {
  const w = textW(label, 10, 600) + 12
  const bx = anchorEnd ? x - w : x
  return {
    w,
    svg:
      `<rect x="${round1(bx)}" y="${round1(y)}" width="${round1(w)}" height="16" rx="8" class="${tone}" fill-opacity=".16"/>` +
      text(bx + 6, y + 11.5, `s ${tone}`, label),
  }
}

const PROV_TONE: Record<Provenance, Tone> = { official: 'ok', estimate: 'info', heuristic: 'acc', unavailable: 'faint' }
const PROV_LABEL: Record<Provenance, string> = { official: 'official', estimate: 'estimate', heuristic: 'heuristic', unavailable: 'n/a' }
export const provBadge = (x: number, y: number, p: Provenance, anchorEnd = false) => badge(x, y, PROV_LABEL[p], PROV_TONE[p], anchorEnd)

export const RISK_TONE: Record<WindowForecast['risk'], Tone> = { low: 'ok', medium: 'warn', high: 'bad', unknown: 'faint' }
export const GRADE_TONE: Record<Health['grade'], Tone> = { good: 'ok', fair: 'info', degraded: 'warn', poor: 'bad' }
export const GRADE_WORD: Record<Health['grade'], string> = { good: 'Healthy', fair: 'Fair', degraded: 'Degrading', poor: 'Poor' }
export const SEVERITY_TONE: Record<Recommendation['severity'], Tone> = { info: 'info', warn: 'warn', urgent: 'bad' }

function levelTone(pct: number | undefined): Tone {
  if (pct === undefined) return 'faint'
  return pct >= 85 ? 'bad' : pct >= 70 ? 'warn' : 'ok'
}

/** A status mark for a plan node: check, pulsing dot, ring, slash. */
function statusIcon(cx: number, cy: number, status: PlanNode['status'], r = 6): string {
  switch (status) {
    case 'done':
      return (
        `<circle cx="${cx}" cy="${cy}" r="${r}" class="ok"/>` +
        `<path d="M${cx - r * 0.45} ${cy + 0.2}l${r * 0.32} ${r * 0.32} ${r * 0.6}-${r * 0.68}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      )
    case 'active':
      return `<circle cx="${cx}" cy="${cy}" r="${r}" class="acc" fill-opacity=".22"/><circle cx="${cx}" cy="${cy}" r="${r * 0.5}" class="acc pulse"/>`
    case 'blocked':
      return `<circle cx="${cx}" cy="${cy}" r="${r - 0.7}" fill="none" class="sbad" stroke-width="1.4"/><path d="M${cx - r * 0.45} ${cy + r * 0.45}L${cx + r * 0.45} ${cy - r * 0.45}" class="sbad" stroke-width="1.4"/>`
    case 'skipped':
      return `<circle cx="${cx}" cy="${cy}" r="${r - 0.7}" fill="none" class="sfaint" stroke-width="1.2" stroke-dasharray="2 2"/>`
    default:
      return `<circle cx="${cx}" cy="${cy}" r="${r - 0.7}" fill="none" class="sfaint" stroke-width="1.4"/>`
  }
}

// ---------------------------------------------------------------- the band

export type StripInput = {
  plan: Plan
  current: PlanNode | undefined
  pct: number
  done: number
  total: number
  limitId?: string
  isPaused: boolean
}

/** One row: state dot, title and count, the plan as segments grouped by milestone, the current task as a pill, percent. */
export function planStrip(s: StripInput, W: number): string {
  const H = 30
  const mid = H / 2
  const isDone = s.total > 0 && s.done === s.total
  const tone: Tone = s.isPaused ? 'warn' : isDone ? 'ok' : s.current ? 'acc' : 'faint'
  const title = fit(s.plan.title, Math.min(W * 0.24, 200), 13, 600)
  const count = `${s.done}/${s.total}`
  const titleW = textW(title, 13, 600)
  let body = `<circle cx="8" cy="${mid}" r="4" class="${tone}${s.current && !s.isPaused && !isDone ? ' pulse' : ''}"/>`
  body += text(20, mid + 4.5, 'h ink', title)
  body += text(20 + titleW + 7, mid + 4, 's faint', count)

  const trackX = 20 + titleW + 7 + textW(count, 11) + 14
  const pctW = 42
  const trackW = Math.max(80, W - trackX - pctW)
  const trackY = mid - 6
  const trackH = 12
  const ls = leaves(s.plan).filter(n => n.status !== 'skipped')
  const groups: PlanNode[][] = []
  for (const n of ls) {
    const ms = milestoneOf(s.plan, n).id
    const last = groups.at(-1)
    if (last && milestoneOf(s.plan, last[0]!).id === ms) last.push(n)
    else groups.push([n])
  }
  const gapLeaf = ls.length > 40 ? 1 : 2
  const gapGroup = 6
  const unit = ls.length
    ? Math.max(1, (trackW - gapGroup * (groups.length - 1) - gapLeaf * (ls.length - groups.length)) / ls.length)
    : trackW
  let x = trackX
  let pillCenter: number | undefined
  let segs = ''
  const marks: string[] = []
  groups.forEach((g, gi) => {
    if (gi > 0) x += gapGroup - gapLeaf
    for (const n of g) {
      const cls = n.status === 'done' ? (isDone ? 'ok' : 'acc') : n.status === 'active' ? 'acc pulse' : n.status === 'blocked' ? 'bad' : 'seg'
      const tip = `${n.id} ${n.title} · ${n.status}${n.cost ? ` · ${fmtDuration(n.cost.ms)}` : ''}${n.checkpoint ? ' · review checkpoint' : ''}`
      segs += `<rect x="${round1(x)}" y="${trackY}" width="${round1(unit)}" height="${trackH}" rx="1.5" class="${cls}"><title>${esc(tip)}</title></rect>`
      if (n.id === s.current?.id) pillCenter = x + unit / 2
      if (n.checkpoint) {
        const cx = x + unit - Math.min(5, unit / 2)
        marks.push(`<path d="M${round1(cx)} ${mid - 3.5}l3.5 3.5-3.5 3.5-3.5-3.5z" class="warn spage" stroke-width="1.2"><title>${esc(`Review checkpoint after ${n.id}`)}</title></path>`)
      }
      if (n.id === s.limitId) {
        marks.push(`<rect x="${round1(x + unit - 1)}" y="${trackY - 4}" width="2.5" height="${trackH + 8}" rx="1.2" class="bad"><title>${esc(`Execution stops after ${n.id}`)}</title></rect>`)
      }
      x += unit + gapLeaf
    }
  })
  body += `<defs><clipPath id="t"><rect x="${round1(trackX)}" y="${trackY}" width="${round1(trackW)}" height="${trackH}" rx="${trackH / 2}"/></clipPath></defs>`
  body += `<g clip-path="url(#t)">${segs}</g>${marks.join('')}`

  // The pill names what runs now, or the stop.
  const pillText = s.isPaused ? 'Paused for review' : isDone ? 'Complete' : s.current ? `${s.current.id}  ${s.current.title}` : ''
  if (pillText) {
    const pillTone: Tone = s.isPaused ? 'warn' : isDone ? 'ok' : 'acc'
    const pw = Math.min(textW(pillText, 11, 600) + 22, trackW * 0.62, 300)
    const center = pillCenter ?? trackX + trackW / 2
    const px = Math.max(trackX, Math.min(trackX + trackW - pw, center - pw / 2))
    body +=
      `<rect x="${round1(px)}" y="${mid - 10}" width="${round1(pw)}" height="20" rx="10" class="${pillTone} spage" stroke-width="2"/>` +
      text(px + 11, mid + 4, 'pill on', fit(pillText, pw - 20, 11, 600))
  }
  body += text(W - 2, mid + 4.5, 'b dim', `${s.pct}%`, ' text-anchor="end"')
  return svg(W, H, body)
}

export type MeterInput = {
  health: Health
  contextPct?: number
  five: WindowForecast
  seven: WindowForecast
  now: number
  top?: Recommendation
}

/** One row of gauges: health, context, five-hour and weekly windows, and the most pressing advice. */
export function meterStrip(m: MeterInput, W: number): string {
  const H = 24
  const mid = H / 2
  let x = 2
  const parts: string[] = []
  const add = (w: number, draw: (x: number) => string) => {
    if (x + w > W) return false
    parts.push(draw(x))
    x += w + 18
    return true
  }
  const healthLabel = `${m.health.score}`
  const word = GRADE_WORD[m.health.grade]
  add(16 + textW(healthLabel, 12, 600) + 6 + textW(word, 11), x0 =>
    `<circle cx="${x0 + 5}" cy="${mid}" r="5" class="${GRADE_TONE[m.health.grade]}"/>` +
    text(x0 + 16, mid + 4.2, 'b ink', healthLabel) +
    text(x0 + 16 + textW(healthLabel, 12, 600) + 6, mid + 4, 's dim', word),
  )
  const gauge = (label: string, pct: number | undefined, tone: Tone, tail?: string) => {
    const value = pct === undefined ? 'n/a' : `${Math.round(pct)}%`
    const w = textW(label, 11) + 6 + 44 + 6 + textW(value, 12, 600) + (tail ? 6 + textW(tail, 11) : 0)
    return add(w, x0 => {
      let out = text(x0, mid + 4, 's dim', label)
      const bx = x0 + textW(label, 11) + 6
      out += bar(bx, mid - 2.5, 44, 5, pct ?? 0, tone)
      out += text(bx + 50, mid + 4.2, pct === undefined ? 'b faint' : 'b ink', value)
      if (tail) out += text(bx + 50 + textW(value, 12, 600) + 6, mid + 4, 's faint', tail)
      return out
    })
  }
  gauge('Context', m.contextPct, levelTone(m.contextPct))
  const reset = m.five.resetsAt ? `↻ ${fmtDuration(Date.parse(m.five.resetsAt) - m.now)}` : undefined
  gauge('5h', m.five.used, RISK_TONE[m.five.risk] === 'faint' ? 'ok' : RISK_TONE[m.five.risk], reset)
  gauge('Week', m.seven.used, RISK_TONE[m.seven.risk] === 'faint' ? 'ok' : RISK_TONE[m.seven.risk])
  if (m.top) {
    const room = W - x
    if (room > 90) {
      const label = fit(m.top.title, room - 16, 12)
      parts.push(`<circle cx="${x + 4}" cy="${mid}" r="3.5" class="${SEVERITY_TONE[m.top.severity]}"/>` + text(x + 13, mid + 4.2, `b ${SEVERITY_TONE[m.top.severity]}`, label))
    }
  }
  return svg(W, H, parts.join(''))
}

export type BannerKind = 'pause' | 'handoff' | 'resume' | 'wrap'

const BANNER_TONE: Record<BannerKind, Tone> = { pause: 'warn', handoff: 'ok', resume: 'info', wrap: 'acc' }

function bannerIcon(kind: BannerKind, cx: number, cy: number): string {
  const t = BANNER_TONE[kind]
  switch (kind) {
    case 'pause':
      return `<rect x="${cx - 4}" y="${cy - 5}" width="3" height="10" rx="1" class="${t}"/><rect x="${cx + 1}" y="${cy - 5}" width="3" height="10" rx="1" class="${t}"/>`
    case 'handoff':
      return `<path d="M${cx - 4} ${cy - 6}h5l3 3v9h-8z" fill="none" class="s${t}" stroke-width="1.5" stroke-linejoin="round"/><path d="M${cx - 2} ${cy + 1}h4M${cx - 2} ${cy + 3.5}h4" class="s${t}" stroke-width="1.3" stroke-linecap="round"/>`
    case 'resume':
      return `<path d="M${cx + 5} ${cy + 4}a6 6 0 1 1-1.5-7.5" fill="none" class="s${t}" stroke-width="1.6" stroke-linecap="round"/><path d="M${cx + 4} ${cy - 7}v4h-4" fill="none" class="s${t}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
    default:
      return `<circle cx="${cx}" cy="${cy}" r="5" class="${t} pulse"/>`
  }
}

/** The width a banner needs for its words. */
export function bannerWidth(title: string, detail: string): number {
  return Math.ceil(30 + textW(title, 13, 600) + 10 + (detail ? textW(detail, 12) : 0) + 18)
}

/** A tinted banner for something that wants the person: a gate, a handoff ready, a session to resume. */
export function banner(kind: BannerKind, title: string, detail: string, W: number): string {
  const H = 30
  const t = BANNER_TONE[kind]
  let body = `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="9" class="${t} s${t}" fill-opacity=".12" stroke-opacity=".45"/>`
  body += bannerIcon(kind, 16, H / 2)
  const tt = fit(title, W * 0.55, 12.5, 600)
  body += text(30, H / 2 + 4.3, 'h ink', tt)
  const dx = 30 + textW(tt, 13, 600) + 10
  if (detail) body += text(dx, H / 2 + 4.2, 'r dim', fit(detail, W - dx - 10, 12))
  return svg(W, H, body)
}

// ---------------------------------------------------------------- the pane

export function sectionLabel(label: string, W: number, right?: string): string {
  let body = text(2, 13, 'cap faint', label.toUpperCase())
  if (right) body += text(W - 2, 13, 's faint', right, ' text-anchor="end"')
  return svg(W, 18, body)
}

/** The plan's summary card: title, goal, a large segmented bar and its figures. */
export function summaryCard(s: StripInput & { next: PlanNode[]; goal?: string }, W: number): string {
  const pad = 14
  const goal = s.goal ? wrap(s.goal, W - pad * 2, 12, 2) : []
  const H = 64 + goal.length * 16 + 28
  let body = `<rect x="0" y="0" width="${W}" height="${H}" rx="12" class="card"/>`
  body += text(pad, 26, 'h1 ink', fit(s.plan.title, W - pad * 2 - 60, 15, 600))
  body += text(W - pad, 26, 'h1 ink', `${s.pct}%`, ' text-anchor="end"')
  let y = 26
  for (const line of goal) {
    y += 17
    body += text(pad, y, 'r dim', line)
  }
  y += 14
  // Milestones side by side, each as wide as its share of tasks.
  const ms = ordered(s.plan).filter(n => !n.parent)
  const total = Math.max(1, leaves(s.plan).filter(n => n.status !== 'skipped').length)
  const gap = 4
  const avail = W - pad * 2 - gap * Math.max(0, ms.length - 1)
  let x = pad
  for (const m of ms) {
    const p = nodeProgress(s.plan, m)
    const w = Math.max(8, (avail * p.total) / total)
    const tone: Tone = p.pct === 100 ? 'ok' : m.status === 'active' ? 'acc' : 'faint'
    body += `<g><title>${esc(`${m.id} ${m.title}: ${p.done}/${p.total}`)}</title>${bar(x, y, w, 8, p.pct, tone === 'faint' ? 'acc' : tone)}</g>`
    x += w + gap
  }
  y += 26
  const cur = s.current ? `Now ${s.current.id}` : s.done === s.total && s.total > 0 ? 'All done' : 'Nothing running'
  const nxt = s.next.filter(n => n.id !== s.current?.id).slice(0, 2).map(n => n.id).join(', ')
  const facts = `${s.done} of ${s.total} tasks · ${cur}${nxt ? ` · next ${nxt}` : ''}`
  body += text(pad, y, 's dim', fit(facts, W - pad * 2, 11))
  return svg(W, H, body)
}

export type RowInput = {
  node: PlanNode
  depth: number
  isSelected: boolean
  isLimit: boolean
  isCollapsed?: boolean
  progress?: { done: number; total: number; pct: number }
}

/** A milestone's header row: chevron, title, a small bar and its count. */
export function milestoneRow(r: RowInput, W: number): string {
  const H = 34
  const mid = H / 2
  const p = r.progress ?? { done: 0, total: 0, pct: 0 }
  let body = r.isSelected ? `<rect x="0" y="1" width="${W}" height="${H - 2}" rx="8" class="card"/>` : ''
  body += `<path d="${r.isCollapsed ? `M10 ${mid - 4}l4 4-4 4` : `M8 ${mid - 2}l4 4 4-4`}" fill="none" class="sfaint" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  body += statusIcon(30, mid, r.node.status, 6.5)
  const right = `${p.done}/${p.total}`
  const rightW = 60 + textW(right, 11) + 10
  body += text(44, mid + 4.5, 'h ink', fit(r.node.title, W - 44 - rightW - 70, 13, 600))
  body += text(44 + textW(fit(r.node.title, W - 44 - rightW - 70, 13, 600), 13, 600) + 8, mid + 4, 'm faint', r.node.id)
  body += bar(W - rightW, mid - 2.5, 60, 5, p.pct, p.pct === 100 ? 'ok' : 'acc')
  body += text(W - 4, mid + 4, 's dim', right, ' text-anchor="end"')
  if (r.node.checkpoint) body += `<path d="M${W - rightW - 14} ${mid - 4}l4 4-4 4-4-4z" class="warn"><title>review checkpoint</title></path>`
  return svg(W, H, body)
}

/** A task or subtask row: status, id, title, and its chips (checkpoint, limit, dependencies, time). */
export function taskRow(r: RowInput, W: number): string {
  const H = 28
  const mid = H / 2
  const indent = 16 + r.depth * 18
  const n = r.node
  let body = r.isSelected ? `<rect x="${indent - 8}" y="1" width="${W - indent + 8}" height="${H - 2}" rx="7" class="card"/>` : ''
  if (r.depth > 1) body += `<path d="M${indent - 10} 0v${mid}h4" fill="none" class="sline" stroke-width="1"/>`
  body += statusIcon(indent + 6, mid, n.status, 6)
  let x = indent + 18
  body += text(x, mid + 4, 'm faint', n.id)
  x += textW(n.id, 11) + 4 + 8

  const chips: { label: string; tone: Tone }[] = []
  if (n.checkpoint) chips.push({ label: 'review', tone: 'warn' })
  if (r.isLimit) chips.push({ label: 'stop after', tone: 'bad' })
  if (n.status === 'blocked') chips.push({ label: 'blocked', tone: 'bad' })
  if (n.deps.length && n.status === 'pending') chips.push({ label: `after ${n.deps.join(', ')}`, tone: 'faint' })
  const time = n.cost ? fmtDuration(n.cost.ms) : n.status === 'active' && n.startedAt ? '' : ''
  const chipW = chips.reduce((s, c) => s + textW(c.label, 10, 600) + 12 + 6, 0) + (time ? textW(time, 11) + 8 : 0)
  const titleRoom = W - x - chipW - 6
  const cls = n.status === 'done' || n.status === 'skipped' ? 'r faint' : n.status === 'active' ? 'b ink' : 'r ink'
  body += text(x, mid + 4.2, cls, fit(n.title, titleRoom, 12))
  let cx = W - 2
  if (time) {
    body += text(cx, mid + 4, 's faint', time, ' text-anchor="end"')
    cx -= textW(time, 11) + 8
  }
  for (const c of chips.reverse()) {
    const b = badge(cx, mid - 8, c.label, c.tone, true)
    body += b.svg
    cx -= b.w + 6
  }
  if (n.note && r.isSelected) body += `<title>${esc(n.note)}</title>`
  return svg(W, H, body)
}

/** The health card: a ring with the score, its grade, and the most pressing advice. */
export function scoreCard(h: Health, verdict: string, W: number): string {
  const H = 92
  const tone = GRADE_TONE[h.grade]
  const r = 28
  const cx = 16 + r + 4
  const cy = H / 2
  const len = 2 * Math.PI * r
  let body = `<rect width="${W}" height="${H}" rx="12" class="card"/>`
  body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="strack" stroke-width="7"/>`
  body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="s${tone}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${round1((len * h.score) / 100)} ${round1(len)}" transform="rotate(-90 ${cx} ${cy})"/>`
  body += text(cx, cy + 7.5, 'big ink', String(h.score), ' text-anchor="middle"')
  const tx = cx + r + 22
  body += text(tx, 36, `h1 ${tone}`, `${GRADE_WORD[h.grade]} session`)
  const lines = wrap(verdict, W - tx - 14, 12, 2)
  lines.forEach((l, i) => (body += text(tx, 56 + i * 16, 'r dim', l)))
  return svg(W, H, body)
}

/** One factor of the score: its deduction, what it is, where the figure comes from. */
export function factorRow(f: Factor, W: number): string {
  const H = 24
  const mid = H / 2
  const tone: Tone = f.delta < 0 ? (f.delta <= -10 ? 'bad' : 'warn') : 'faint'
  const d = f.delta < 0 ? String(f.delta) : '·'
  let body = text(30, mid + 4.2, `b ${tone}`, d, ' text-anchor="end"')
  const prov = provBadge(W - 2, mid - 8, f.provenance, true)
  body += text(42, mid + 4.2, 'r ink', fit(f.label, W - 42 - prov.w - 12, 12))
  body += prov.svg
  return svg(W, H, body)
}

/** A usage gauge: the reading, its reset, and where the observed pace would take it. */
export function meterCard(label: string, w: WindowForecast | { used?: number; provenance: Provenance; sub?: string }, now: number, W: number): string {
  const H = 82
  const pad = 14
  const used = w.used
  let body = `<rect width="${W}" height="${H}" rx="12" class="card"/>`
  body += text(pad, 22, 'cap faint', label.toUpperCase())
  body += provBadge(W - pad, 10, used === undefined ? 'unavailable' : 'official', true).svg
  const value = used === undefined ? 'n/a' : `${round1(used)}%`
  body += text(pad, 50, used === undefined ? 'big faint' : 'big ink', value)
  const bx = pad + Math.max(52, textW(value, 22, 600)) + 12
  const bw = W - bx - pad
  const isForecast = 'risk' in w
  const tone: Tone = isForecast ? (RISK_TONE[w.risk] === 'faint' ? 'ok' : RISK_TONE[w.risk]) : levelTone(used)
  body += bar(bx, 39, bw, 8, used ?? 0, tone)
  let sub = ''
  let isEstimate = false
  if (isForecast && used !== undefined) {
    const parts: string[] = []
    if (w.resetsAt) parts.push(`resets in ${fmtDuration(Date.parse(w.resetsAt) - now)}`)
    if (w.perHour !== undefined) parts.push(`${round1(w.perHour)} pt/h`)
    if (w.etaMs !== undefined) parts.push(`full in ~${fmtDuration(w.etaMs)}`)
    parts.push(`risk ${w.risk}`)
    sub = parts.join(' · ')
    isEstimate = w.perHour !== undefined
    // Where the observed pace lands by the reset: a lighter extension of the bar.
    if (w.perHour !== undefined && w.resetsAt) {
      const atReset = Math.min(100, used + (w.perHour * (Date.parse(w.resetsAt) - now)) / 3_600_000)
      const from = bx + (bw * used) / 100
      const to = bx + (bw * atReset) / 100
      if (to - from > 1) {
        body += `<rect x="${round1(from)}" y="39" width="${round1(to - from)}" height="8" rx="4" class="${tone}" fill-opacity=".28"><title>${esc(`At this pace: ~${Math.round(atReset)}% by the reset (estimate)`)}</title></rect>`
      }
    }
  } else if ('sub' in w && w.sub) {
    sub = w.sub
  } else if (used === undefined) {
    sub = 'Not reported yet: subscription windows only, after the first response'
  }
  if (sub) {
    const badgeW = isEstimate ? textW('estimate', 10, 600) + 18 : 0
    body += text(pad, 70, 's dim', fit(sub, W - pad * 2 - badgeW, 11))
    if (isEstimate) body += provBadge(W - pad, 58, 'estimate', true).svg
  }
  return svg(W, H, body)
}

/** Model and effort: what runs now, what fits the task, and why. */
export function modelCard(now: string, fits: string, reason: string, isChange: boolean, W: number): string {
  const pad = 14
  const lines = wrap(reason, W - pad * 2, 12, 2)
  const H = 64 + lines.length * 16
  let body = `<rect width="${W}" height="${H}" rx="12" class="card"/>`
  body += text(pad, 22, 'cap faint', 'NOW')
  body += text(pad, 42, 'h ink', fit(now, W / 2 - pad * 2, 13, 600))
  const x2 = W / 2 + 8
  body += `<path d="M${W / 2 - 10} 37h12m-4-4 4 4-4 4" fill="none" class="sfaint" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
  body += text(x2, 22, 'cap faint', 'FITS THE TASK')
  body += text(x2, 42, `h ${isChange ? 'acc' : 'ink'}`, fit(fits, W - x2 - pad - 70, 13, 600))
  body += provBadge(W - pad, 29, 'heuristic', true).svg
  lines.forEach((l, i) => (body += text(pad, 64 + i * 16, 'r dim', l)))
  return svg(W, H, body)
}

/** One recommendation: a colored edge, what to do, and why. */
export function recCard(r: Recommendation, W: number): string {
  const pad = 14
  const lines = wrap(r.detail, W - pad * 2 - 6, 12, 3)
  const H = 40 + lines.length * 16
  const tone = SEVERITY_TONE[r.severity]
  let body = `<rect width="${W}" height="${H}" rx="10" class="card"/><rect x="0" y="0" width="4" height="${H}" rx="2" class="${tone}"/>`
  const prov = provBadge(W - pad, 10, r.provenance, true)
  body += text(pad + 4, 24, 'h ink', fit(r.title, W - pad * 2 - prov.w - 10, 13, 600))
  body += prov.svg
  lines.forEach((l, i) => (body += text(pad + 4, 44 + i * 16, 'r dim', l)))
  return svg(W, H, body)
}

/** A small explanatory note, wrapped. */
export function note(content: string, W: number, maxLines = 4): string {
  const lines = wrap(content, W - 4, 12, maxLines)
  return svg(W, lines.length * 17 + 4, lines.map((l, i) => text(2, 14 + i * 17, 'r dim', l)).join(''))
}

/** A thin divider. */
export function divider(W: number): string {
  return svg(W, 9, `<rect x="0" y="4" width="${W}" height="1" class="seg"/>`)
}

export { GLYPH }
