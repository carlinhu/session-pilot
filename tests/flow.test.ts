import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-11T12:00:00Z')
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 110, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

// What the fake surface shows: whether the pane is open.
const surfacePane = { isOpen: false }
let clock: ReturnType<typeof mock.clock>
// Prompts the mod submitted.
const submitted: string[] = []
// The context each submitted prompt carried.
const contexts: (readonly string[] | undefined)[] = []
// Slash commands the mod ran through the engine.
const ran: string[] = []

function engine(on: On) {
  surfacePane.isOpen = false
  ran.length = 0
  on('command.run', ($, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const files: Record<string, string> = {}
  on('session.root', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a repo', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => {
    surfacePane.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    surfacePane.isOpen = false
  ran.length = 0
  on('command.run', ($, e) => {
    ran.push(e.command)
    return { text: '' }
  })
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: surfacePane.isOpen ? [{ id: 'session-pilot', title: 'Session pilot', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  submitted.length = 0
  contexts.length = 0
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    contexts.push(e.context)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  on('classic.Stop', () => ({}))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  return files
}

async function plan($: Engine) {
  return $.tool.call({
    tool: 'mcp__session-pilot__plan_set',
    title: 'Auth',
    milestones: [
      { id: 'M1', title: 'Backend', items: [{ id: 'M1.1', title: 'Routes' }, { id: 'M1.2', title: 'Tokens', checkpoint: true }] },
      { id: 'M2', title: 'Frontend', items: [{ id: 'M2.1', title: 'Login form' }] },
    ],
  })
}

const update = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__session-pilot__plan_update', ...input })

test('a checkpoint pauses the run until the person answers', async ($, on) => {
  engine(on)
  await plan($)
  await update($, { start: 'M1.1' })
  const quiet = await update($, { done: ['M1.1'], start: 'M1.2' })
  expect(String(quiet.result)).not.toMatch(/paused/)

  const stop = await update($, { done: ['M1.2'] })
  expect(String(stop.result)).toMatch(/Checkpoint: M1\.2 Tokens.*paused for the user's review/)

  const blocked = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  expect(blocked.deny).toMatch(/paused/)
  const start = await update($, { start: 'M2.1' })
  expect(String(start.result)).toMatch(/Refused: not started M2\.1/)

  await $.prompt.submit({ text: 'looks good, go on', wait: false, origin: { kind: 'composer' } })
  const edit = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  expect(edit.deny).toBeUndefined()
})

test('an execution limit stops after its task', async ($, on) => {
  engine(on)
  await plan($)
  await $.command.run({ command: 'pilot-limit', args: 'm1.1', ...RUN })
  await update($, { start: 'M1.1' })
  const out = await update($, { done: ['M1.1'] })
  expect(String(out.result)).toMatch(/Execution limit reached: M1\.1/)
})

test('focus mode keeps work inside the open milestone', async ($, on) => {
  engine(on)
  await plan($)
  await update($, { start: 'M1.1' })
  // The pane's "Finish unit first" toggle, through the band's drawing.
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'terminal', component: 'Pane', requestId: 'session-pilot', props: { title: 'Session pilot', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await ui.press({ key: 'c-focus' })
  const out = await update($, { start: 'M2.1' })
  expect(String(out.result)).toMatch(/finish the current unit first/)
  await ui.unmount()
})

test('wrap-up for handoff: refuses new work, sends the model back at Stop, writes the file', async ($, on) => {
  const files = engine(on)
  await plan($)
  await update($, { start: 'M1.1' })
  await $.command.run({ command: 'pilot-handoff', args: '', ...RUN })

  const spawn = await $.tool.call({ tool: 'TaskCreate', subject: 'more', description: 'more' })
  expect(spawn.deny).toMatch(/wrapping up/)

  const first = await $.classic.Stop({ stop_hook_active: false })
  expect(first.block).toMatch(/handoff_write/)

  const written = await $.tool.call({
    tool: 'mcp__session-pilot__handoff_write',
    objective: 'Ship auth',
    next_steps: ['Finish M1.1'],
    tests: [{ command: 'npm test', result: 'pass' }],
  })
  expect(String(written.result)).toMatch(/Handoff saved to \/proj\/\.claude\/handoffs\/handoff-/)
  // The engine spells the path the platform's way.
  const latest = Object.entries(files).find(([path]) => /[\\/]\.claude[\\/]handoffs[\\/]latest\.md$/.test(path))?.[1]
  expect(latest).toContain('## Objective\nShip auth')
  expect(latest).toContain('Not a git repository, or git unavailable.')

  const after = await $.classic.Stop({ stop_hook_active: false })
  expect(after.block).toBeUndefined()
})

test('the band shows the plan and its controls on every surface that draws it', async ($, on) => {
  engine(on)
  await plan($)
  await update($, { start: 'M1.1' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-pilot', surface, ...BAND })
    expect(await ui.find({ key: 'plan' })).toBeDefined()
    expect((await ui.find({ key: 'finish' }))?.text).toMatch(/finish & handoff/i)
    await ui.press({ key: 'pause' })
    expect((await ui.find({ key: 'pause' }))?.text).toMatch(/pausing/i)
    await ui.press({ key: 'pause' })
    await ui.unmount()
  }
})

test('the pane draws plan, health and handoff views on terminal and desktop', async ($, on) => {
  engine(on)
  await plan($)
  await update($, { start: 'M1.1' })
  await $.session.measure({
    context: { tokens: 150_000, window: 200_000, percent: 75 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-11T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-10-15T00:00:00Z' },
    ],
    cost: { usd: 3.2 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-pilot',
      surface,
      component: 'Pane',
      requestId: 'session-pilot',
      props: { title: 'Session pilot', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    })
    await ui.press({ key: 'n:M1.1' })
    expect(await ui.find({ key: 'cp:M1.1' }), 'cp').toBeDefined()
    // Text on the terminal, pictures (read by their alt) where the surface draws them.
    const shows = async (re: RegExp) =>
      (await ui.find({ type: 'Text', text: re })) ?? (await ui.findAll({ type: 'Svg' })).find(svg => re.test(String(svg.props.alt)))
    await ui.press({ key: 'tab-health' })
    expect(await shows(/Context 75% full/), 'ctx ' + surface).toBeDefined()
    expect(await shows(/62(\.0)?%/), '62 ' + surface).toBeDefined()
    expect(await ui.find({ key: 'rec:compact' }), 'rec').toBeDefined()
    await ui.press({ key: 'tab-handoff' })
    expect(await ui.find({ key: 'h-start' }), 'hstart').toBeDefined()
    await ui.press({ key: 'tab-plan' })
    // Selection is session state: deselect so the next surface starts alike.
    await ui.press({ key: 'n:M1.1' })
    await ui.unmount()
  }
})

test('Dashboard opens the pane, and closes it when it is open', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  await ui.press({ key: 'open' })
  expect(surfacePane.isOpen).toBe(true)
  await ui.press({ key: 'open' })
  expect(surfacePane.isOpen).toBe(false)
  await ui.unmount()
})

test('using a handoff in a new session never clears this one', async ($, on) => {
  engine(on)
  await plan($)
  await $.tool.call({ tool: 'mcp__session-pilot__handoff_write', objective: 'Ship auth', next_steps: ['Finish M1.1'] })
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  await ui.press({ key: 'handoff-new' })
  expect(ran).not.toContain('clear')
  await ui.unmount()
})

test('the main agent is told to keep the plan; subagents may not set it', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['desktop'],
    tools: ['Read', 'mcp__session-pilot__plan_set'],
    outputStyle: null,
    traits: [],
  })
  expect(composed.sections.map(s => s.id)).toEqual(['intro', 'session-pilot:plan'])
  const denied = await $.tool.call({ tool: 'mcp__session-pilot__plan_set', agentId: 'sub-1', title: 'x', milestones: [{ title: 'a' }] })
  expect(denied.deny).toMatch(/Only the main session/)
})

test('a handoff with no plan seeds one from its next steps', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'mcp__session-pilot__handoff_write', objective: 'Ship auth', next_steps: ['Write login form', 'Add tests'] })
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'plan' })).toBeDefined()
  await ui.unmount()
})

test('with no plan, the model is reminded once after a few tool calls', async ($, on) => {
  engine(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: { ok: true } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'refactor the cache', turnId: 't1' })
  const contexts: (readonly string[] | undefined)[] = []
  for (let i = 0; i < 7; i++) contexts.push((await $.tool.call({ tool: 'Read', file_path: 'a.ts' })).context)
  const nudged = contexts.filter(c => c?.some(t => /no plan is recorded/.test(t)))
  expect(nudged).toHaveLength(1)
  expect(contexts[4]?.join(' ')).toMatch(/plan_set/)
})

// What a session start needs beneath the mod.
function sessionStartBottom(on: On) {
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-pilot__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

test('continuing in a new session: one opened soon after starts from the handoff on its own', async ($, on) => {
  engine(on)
  sessionStartBottom(on)
  await $.tool.call({ tool: 'mcp__session-pilot__handoff_write', objective: 'Ship auth', next_steps: ['Write login form'] })
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  await ui.press({ key: 'handoff-new' })
  await ui.unmount()
  expect(submitted).toHaveLength(0)

  // The new session, ten minutes later.
  await clock.advance(10 * 60_000)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  expect(submitted.join(' ')).toMatch(/Continue the work from the handoff/)
})

test('a session opened long after the handoff only offers to resume', async ($, on) => {
  engine(on)
  sessionStartBottom(on)
  await $.tool.call({ tool: 'mcp__session-pilot__handoff_write', objective: 'Ship auth', next_steps: ['Write login form'] })
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  await ui.press({ key: 'handoff-new' })
  await ui.unmount()
  await clock.advance(2 * 3_600_000)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  expect(submitted).toHaveLength(0)
  const band = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  expect(await band.find({ key: 'resume' })).toBeDefined()
  await band.unmount()
})

test('handoff while idle writes it at once, with no "finish your work" round', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'session-pilot', surface: 'desktop', ...BAND })
  await ui.press({ key: 'finish' })
  await ui.unmount()
  expect(submitted.join(' ')).toMatch(/Write a handoff now from what you already know/)
  expect(submitted.join(' ')).not.toMatch(/nearest consistent point/)
})

test('the first prompt after a recent handoff asks the model to plan from it, once', async ($, on) => {
  engine(on)
  on('fs.stat', () => ({ value: { mtimeMs: NOW - 60_000, size: 100, isFile: true, isDirectory: false, isSymbolicLink: false } as never }))
  await $.prompt.submit({ text: 'Continuando do handoff', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'ok', wait: false, origin: { kind: 'composer' } })
  expect(contexts[0]?.join(' ')).toMatch(/record its next steps as the plan/)
  expect(contexts[1]?.join(' ') ?? '').not.toMatch(/record its next steps/)
})
