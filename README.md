# session-pilot

Session dashboard and execution control for Claude Code (a function-hooks mod, Claude Code ≥ 2.1.295).

- **Band above the prompt**: the plan (segmented bar on desktop, text bar on the terminal), current task, what's next, session health, context, the 5-hour and weekly windows, and the main controls.
- **Side pane** (`/pilot`, or click *Dashboard*): *Plan*, *Health* and *Handoff* tabs.
- **Execution control** enforced through hooks, not only prompt instructions.
- **Handoff** to a new session, reviewable, saved under `.claude/handoffs/`.

## Install

Requires Claude Code **2.1.295 or newer** (the mods API is early access).

From GitHub, at the prompt of a terminal session:

```
/plugin install session-pilot --marketplace carlinhu/session-pilot
```

Answer `y` to add the marketplace, then pick a scope (user = every session).

From a folder (a clone, or an unzipped copy):

```bash
claude plugin marketplace add <folder>
claude plugin install session-pilot@session-pilot
```

Installed from a folder, the mod is read from it: after editing, run `/reload-plugins`.

Uninstall: `claude plugin uninstall session-pilot@session-pilot`

The mod only writes `.claude/handoffs/*.md` in the project you work in (when you ask for a handoff) and its plan in Claude Code's local plugin store. Nothing is sent anywhere.

## Architecture

```
hooks/register.tsx   events, tools, commands, enforcement, actions
hooks/logic.ts       pure logic: plan, gates, health, forecasts, recommendations, handoff
hooks/draw.ts        SVG pictures for desktop, vscode and mobile (dark and light)
hooks/pictures.tsx   band and pane built from those pictures and native buttons
hooks/ui.tsx         text band and pane for the terminal; picks one per surface
types/index.d.ts     the mod's state contract ($.state)
tests/               19 tests (logic, flows, UI on terminal and desktop)
```

Session state lives in `$.state` (survives hot reload). The plan is kept per project in `$.store` (`plan:<root>`), a pending handoff in `handoff:<root>`.

### Where the numbers come from

| Figure | Source | Label |
| --- | --- | --- |
| Context (% / tokens / window) | `$.session.usage()` and the `session.measure` event | official |
| `five_hour` / `seven_day` windows (% used, reset) | same; subscription plans only, after the first response | official / n/a |
| Cost (USD) | same | official |
| Model and effort per request | `turn.step` event | official |
| Pace (pt/h), ETA, risk, stop point | linear fit over this session's readings | estimate |
| Health score, suggested model/effort | explicit rules, every deduction listed | heuristic |

Nothing is made up: without a reading, the pane shows "n/a".

### How the controls take effect

| Control | Mechanism |
| --- | --- |
| Checkpoint / limit / pause at the next safe point | When a task finishes (`plan_update`, `TodoWrite` or `TaskUpdate`) a *gate* engages. The tool result tells the model to stop; the `tool.call` hook **denies** every tool that changes something (Edit, Write, Bash, Agent…) until you decide. Read-only tools pass. |
| Releasing the gate | *Continue* / *Continue to X* / *Handoff*, or your own next prompt. |
| Finish the functional unit first | `plan_update.start` on another open milestone is refused. |
| Finish current task → safe checkpoint → handoff | A wrap-up prompt (stop at a consistent point, quick checks only); `TaskCreate`, `Agent` and starting new tasks are denied; the `classic.Stop` hook sends the model back (at most twice) until `handoff_write` is called. |
| Handoff now | The model writes the handoff from what it already knows: no more work, no checks. |
| Short handoffs | The tool schema caps every list and line, and the generator cuts anything longer and leaves out empty sections: a one-minute read. |
| The plan survives compaction | The `session.compact` hook adds the plan to the summary instructions. |
| New session with handoff | *Use in new session* only queues the handoff: the session you are in is never cleared. The next session opened in the project offers *Resume*, which asks the model to read the handoff file. |
| Stop now | `$.turn.abort` (warns that it may leave the tree inconsistent). |

## Tools for the model

- `plan_set`: a hierarchical plan (milestones → tasks → subtasks, `deps`, `checkpoint`).
- `plan_update`: `start`, `done`, `block`, `skip`, `note`, `add`. Its answer may tell the model to stop.
- `handoff_write`: a structured handoff; the mod appends what it **observed**: git (branch, status, last commit), files edited, check commands with their exit status, usage at that moment.

Without `plan_set`, `TodoWrite` lists and `TaskCreate`/`TaskUpdate` are mirrored automatically.

## Commands

`/pilot [plan|health|handoff|band]` · `/pilot-pause` · `/pilot-handoff` · `/pilot-limit [id]` · `/pilot-checkpoint <id>`

## Known limitations

- Forecasts are linear estimates over this session's readings; other sessions on the same account also use the window.
- Usage windows exist only on subscription plans, and only after the first response.
- Switching model uses `/model`; effort uses `/effort` where the build has it, otherwise it is set per request in `turn.step`.
- Gates block per tool; Bash counts as possibly changing things while a gate is engaged.
- Cost per task depends on the model calling `plan_update start/done` (or TodoWrite) at task boundaries.

## Development

```bash
claude plugin validate .
claude plugin test .
```
