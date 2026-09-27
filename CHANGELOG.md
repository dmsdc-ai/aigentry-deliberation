# Changelog

## Unreleased

### Removed (BREAKING — public MCP surface + bin)

Over-engineering cleanup (ponytail audit 2026-07-26). The following MCP
tools are **no longer exposed** by the server:

- `decision_start`, `decision_status`, `decision_respond`,
  `decision_resume`, `decision_history`, `decision_templates` — the
  Micro-Decision engine (`decision-engine.js`, `selectors/decision-templates.json`).
  A deliberation with a "decide" topic covers the same ground.
- `deliberation_list_remote_sessions` — client of the observer dashboard's
  `/api/sessions`, removed together with it.
- `deliberation_copy_last_turn`, `deliberation_set_execution_status` —
  zero references across README, skills, examples, tests, or the
  orchestrator/devkit repos. The execution-status sidecar itself is
  unchanged; only the standalone setter tool is gone.

Changed tool signature:

- **`deliberation_inject_context` no longer accepts `remote_url`.** That
  branch POSTed to the observer dashboard's
  `/api/sessions/:id/context`, and the observer is gone (below), so it
  could no longer reach anything. Local injection — the only path anything
  in the ecosystem uses — is unchanged. Callers passing `remote_url` will
  now fail schema validation instead of silently attempting a dead
  endpoint. `deliberation_ingest_remote_reply` is unaffected.

Also removed:

- **`deliberation-observer` bin** (`observer.js` + `public/index.html`) —
  undocumented dashboard, its `--dashboard` flag was never wired into CLI
  routing. `deliberation_status` / `deliberation_list_active` and the tmux
  monitor cover local monitoring.
- `inbox-watcher.mjs` — watched `~/.local/lib/mcp-deliberation/inbox` while
  the only producer writes to `~/.aigentry/inbox`, so it could never fire.
- `lib/entitlement.js` and its tool gate — every feature was granted to
  every tier, so it could not deny anything.
- Hardcoded `~/Documents/Obsidian Vault` context/archive branches.

### Added

- **`@aigentry/logger` emit wiring at turn + synthesis sites (#440).**
  ESM wrapper at `logger-emit.js` (no CJS bridge — package is `"type":
  "module"`). Three emit call sites:
  - `lib/session.js` `submitDeliberationTurn` → `state-change` /
    `turn_complete` after a successful turn (correlated by `turn_id`).
  - `index.js` `deliberation_synthesize` MCP tool → `report` / `synthesis`
    on completion.
  - `index.js` `deliberation_synthesize` → `report` / `handoff_v2` when an
    `execution_contract` is built (auto-execute or manual handoff).

  A1 mapping (spec event names → `payload.subtype` on closed ssot
  `TelemetryEventKind` enum). Library-context emit-skip-with-warning
  when `AIGENTRY_ROLE` is unset/invalid (option B, once-per-process).
  Honors `AIGENTRY_LOGGER_DISABLED=1`. All transport failures swallowed
  (§9 독립).
- **Wrapper unit tests** at `__tests__/logger-emit.test.js` (9 cases).
  Full suite 226/226 with the opt-out env.
- **Stdin-cleanup deadline regressions** at `__tests__/stdin-deadline.test.js`
  (40 cases). Drives the real `runCliAutoTurnCore` / `generateAutoSynthesis`
  with owned in-process fake children and fake timers — no provider, no
  spawned process — and pins settlement against each path's own measured
  deadline: initial failure, deadline-1 ms, the stage boundary, close before
  and after the deadline, duplicate/late errors, a synchronous stdin throw,
  and a stdin error arriving after the deadline already settled the call
  (15 cases), plus 17 cases for the system-clock-step contract below: a
  3-assertion harness probe that the fake monotonic clock, the fake wall clock
  and the timer queue can be moved independently; the two deadlines re-measured
  in scheduler time; proof that two mid-flight wall-clock steps do not move the
  deadline the product enforces; and the six stepped arms (backward 60 s and
  3 s, forward on both paths, forward mid-grace) each beside its unchanged-clock
  twin. Settlement instants in the stepped arms are read from a scheduler-elapsed
  accumulator, never from `Date.now()`, which is the perturbed quantity there.
  Plus 8 cases for the measured-window contract below, on both callsites: a
  loop-lag control that moves the monotonic clock without running the scheduler
  (re-proved at every use), a zero-lag control on each path, the 4000 ms-lag
  counterexample, lag past the deadline, a fractional elapsed, a later error
  that must not restart the window, and an observed close that reports no
  window at all.
  Measured evidence, and its exact limits: an independent tester ran this suite
  against two trees differing only in `lib/transport.js` and recorded 40 passed
  on the corrected bytes versus 5 failed / 35 passed on the predecessor bytes,
  the five failures being exactly the measured-window arms. That run was
  **virtual time, in process**: fake timers and a faked `performance` clock over
  in-memory fake children, with no provider, no spawned process and no real
  scheduling. Real event-loop lag, native clocks, suspend/resume and NTP slew
  are **unmeasured**, and `SIGTERM`/`SIGKILL` there are recorded calls on fakes,
  not delivered signals. The composition onto this release base is newer than
  that run and was syntax-checked only here; re-execution, the rest of the
  repository's suites, CI, build and installed-release acceptance are all
  separate gates and none of them is claimed.

### Changed

- **A failed provider-stdin turn now waits for the provider's observed
  close before it returns.** On this release base the provider-stdin write
  carried no guard at all: there was no 'error' listener, so an EPIPE from
  writing the prompt escaped to the process-level fatal handlers, where it is
  indistinguishable from the MCP client going away, and no signal was issued
  or awaited on the turn's behalf. The write is now guarded, a synchronous
  throw funnels into the same path, and the turn — not the process — owns the
  failure. The bullets in this section describe that whole path as it lands
  here; the wall-clock and summed-window defects they correct were never
  shipped on this base and are recorded because the path is new to it. The
  wait is bounded by the cleanup budget in `lib/transport.js`: a 5000 ms
  SIGTERM grace, then a 2000 ms SIGKILL confirmation (7000 ms worst case).
  If the close is still not observed, the turn stays **failed** and its
  error is marked `UNOBSERVED` — the outcome is never upgraded on an
  unconfirmed signal.

  **That cleanup is bounded by whatever is left of the original turn (or
  synthesis) deadline, not by an unconditional 7 s.** 5000 ms and 2000 ms
  are each stage's *maximum*; a stage runs for its own length or until the
  original deadline, whichever comes first. So a stdin failure schedules no
  wait that reaches past the deadline — including when the
  failure arrives moments before the deadline, where the earlier code
  cleared the deadline, started a fresh 7000 ms budget and overran it by
  up to 6999 ms. Reaching the deadline mid-cleanup does **not** convert the
  outcome into a generic `CLI timeout (Ns)` / `Synthesis generation
  timeout`: the first stdin error stays the reported failure (verbatim,
  and as `cause`) with the provider's termination stated as `UNOBSERVED`.
  When the deadline cuts the SIGTERM grace short, that stage never runs,
  so **no SIGKILL is issued and none is claimed** — the error names only
  the signals actually attempted, and the window it reports is the one that
  actually elapsed.

  This is measured cleanup latency on the failure path only. Normal turns
  are unaffected. Because `runAutoHandoff` runs speakers in sequence, a run
  with K such failures can spend up to 7 s each — and, per the bound above,
  never past each turn's own deadline. This is **not** a claim that every
  provider is reaped, nor that an attempted signal was delivered — only
  that each one is waited for, bounded, and reported honestly when it is
  not.

- **That deadline bound is now measured on the monotonic clock, so a system
  clock change cannot move it** (`lib/transport.js`). The bound was computed
  as `deadlineAt - Date.now()`: a *wall*-clock remainder clipping a deadline
  that `setTimeout` enforces on libuv's *monotonic* clock. An NTP correction,
  a manual clock change or a suspend/resume moves one of those clocks without
  the scheduler making any progress, and the remainder was then wrong by
  exactly that step — independently measured on both callsites, with 8
  unchanged-clock controls passing beside 6 failing stepped arms:

  - a **backward** step gave the stages budget the deadline no longer had, so
    settlement overran the original deadline by `min(step, 6999)` ms; at a step
    of 60 s that is the full pre-fix 6999 ms overrun *and* the false
    `SIGTERM+SIGKILL within 7000ms` claim the bound exists to prevent;
  - a **forward** step collapsed the remainder to zero, so both stages were
    skipped: the call settled up to 7000 ms early and **no SIGKILL was ever
    issued**, leaving a wedged provider un-reaped.

  The deadline origin and each stage's remainder are now monotonic: the origins
  come from `performance.now()` (a Node global — no dependency and no public API
  change), and each remainder is a difference on that one clock, floored to whole
  milliseconds so the bound stays conservative. Everything else is unchanged: the same
  original deadline, the same first-error-wins outcome, one cleanup escalation
  handle cancelled by an observed close, only the signals actually attempted
  named, `UNOBSERVED` still stated rather than termination claimed, and the
  full 5000+2000 ms path for a failure that arrives with room for it. No
  timeout or termination policy changed, and the unrelated wall-clock
  `elapsedMs` result fields were deliberately left alone.

- **The cleanup window an `UNOBSERVED` failure reports is now measured, not
  summed** (`lib/transport.js`, both stdin-failure callsites). It was
  accumulated from each cleanup stage's *scheduled* length. `setTimeout`
  guarantees a floor and never a ceiling, so a blocked or saturated event loop
  serves each stage late and that sum states less time than really elapsed —
  independently measured on the synthesis callsite as `within 7000ms` reported
  for 11000 ms of monotonic progress under 4000 ms of loop lag, beside a
  zero-lag control that reported 7000 ms for 7000 ms. The window is now the real
  duration from the **first** stdin error to settlement, read from the same
  monotonic clock the stages are clipped against, rounded to whole milliseconds
  and never negative, and stamped once so a later error cannot restart it.

  The overshoot is **reported, not clamped** to the 7000 ms budget or to the
  original deadline. Clipping later waits bounds the scheduled wait; it cannot
  guarantee event-loop responsiveness, so a wedged loop can still carry
  settlement past the deadline instant, and hiding that in the diagnostic was
  the defect. This is a diagnostic-accuracy change only: the operation-start
  monotonic deadline, the ceil/floor stage budget handling, first-error-wins,
  observed-close cancellation, the bounded stages and the signals named are all
  unchanged, and an observed close still hands the first error back untouched
  with no window reported at all. No dependency, public API, permission,
  provider, auth, router or CLI change.

### Snyk note (pre-existing, not introduced by #440)

Snyk At-Inception (#440 Phase 4) flagged a Medium-severity Path Traversal
(CWE-23) at `index.js:376` (`fs.readFileSync(file, "utf-8")` under
`getExecutionStatusFile()` — data flow originating from an MCP tool
argument at line 1449). This finding pre-exists δ2 (`git blame` →
e45a5a0e, 2026-03-13) and is unrelated to the logger emit wiring. Tracked
for follow-up under the same telepty 0.4.3 pattern — fix in a dedicated
input-sanitisation patch, not in a feat() commit.

## v0.0.46 — 2026-06-13

### Fixed

- **tmux monitor window targeted by index for Hangul topics (#610).**
  `lib/transport.js` now resolves the monitor window via
  `parseTmuxWindowIndex` (window-index based) instead of matching the
  Korean `winName` string, fixing the 전광판 (status board) selection for
  Hangul deliberation topics. Landed on `main` at `d62a0c1`.

### Release hygiene (#612)

- **Version bump 0.0.45 → 0.0.46 to break the same-string drift.** The
  installed copy (`~/.local/lib/mcp-deliberation`) and the repo had both
  carried `0.0.45` while diverging in content, so the #610 fix never
  propagated to the install. Bumping the version makes the installed copy
  trackable and forces the `node install.js` sync to land the fix.

## v0.0.45 — 2026-04-15

### Fixed (P0 disk exhaustion)
- **runtime.log unbounded growth — two compounding bugs** (`index.js`).
  Reported: `.local/lib/mcp-deliberation/runtime.log.old` reached **330 GB**
  in ~18 hours on an affected machine, cascading ENOSPC to unrelated tools.

  - **Bug 1 — rotation cleanup**. Previous logic relied on POSIX atomic
    rename-overwrite for `.old` cleanup. Under concurrent writers the
    guarantee degraded. Fix: explicit `fs.unlinkSync(runtime.log.old)` before
    rename, plus a hard-cap fallback that truncates `runtime.log` in-place to
    its last 500 KB when it exceeds `2 × DELIBERATION_LOG_MAX_SIZE_MB`.
  - **Bug 2 — EPIPE self-amplifying log loop**. When the MCP client
    disconnected, `process.stderr.write` in the `uncaughtException` handler
    re-triggered EPIPE, forming a tight loop bounded only by event-loop
    throughput (~470 M iterations in 18 h for the reporter). Fix:
    module-level `hasHandledFatalError` reentrance guard, broadened EPIPE
    detection (`EPIPE` / `ERR_STREAM_DESTROYED` / `ERR_STREAM_WRITE_AFTER_END`
    / message regex), and REMOVAL of the `process.stderr.write` lines that
    served as the re-trigger source. File logging is the sole sink.
  - **Dedup**. `appendRuntimeLog` now suppresses identical `level+message`
    pairs within `DELIBERATION_LOG_DEDUP_MS` (default 1000 ms) and emits a
    single `[Nx in Xms]` summary line when the window expires. Prevents a
    single repeating stacktrace from dominating the log.

### Added
- **Doctor runtime.log size check** (`doctor.js`). Diagnoses only —
  never mutates. Warns at ≥ 50 MB, errors at ≥ 500 MB total `runtime.log*`
  footprint, reports top 3 offenders with paths and sizes. Thresholds
  configurable via `DELIBERATION_LOG_SIZE_WARN_MB` / `DELIBERATION_LOG_SIZE_ERROR_MB`.
- **One-time upgrade safety**. On first v0.0.45 run, if pre-existing
  `runtime.log*` total exceeds 1 MB the current `runtime.log` is renamed to
  `runtime.log.pre-0.0.45` (preserved as a one-time backup). Other pre-existing
  rotated files are removed so normal rotation starts clean. The backup is
  expired after 7 days or when the total-footprint budget is exceeded,
  whichever comes first. A marker file `.log-upgrade-v0.0.45` prevents
  re-running the migration.

### Environment variables
- `DELIBERATION_LOG_MAX_SIZE_MB` — per-file rotation threshold (default 1).
- `DELIBERATION_LOG_TOTAL_BUDGET_MB` — cap for runtime.log* footprint
  enforcement (default 10).
- `DELIBERATION_LOG_DEDUP_MS` — window for identical-message suppression
  (default 1000).
- `DELIBERATION_LOG_SIZE_WARN_MB` / `DELIBERATION_LOG_SIZE_ERROR_MB` —
  doctor thresholds (defaults 50 / 500).

### Preserved
- v0.0.44 `self_turn` fix in `lib/transport.js` untouched.
- Log format (`<iso-ts> [LEVEL] <message>`) unchanged — rotation / dedup
  entries are additive.

### Tests
- `__tests__/runtime-log.test.js` — rotation cap, dedup collapse + summary,
  EPIPE reentrance guard (including message-only detection fallback),
  cross-key isolation, upgrade-safety migration.
- `__tests__/doctor.test.js` — ERROR / WARN / OK thresholds, non-mutation
  invariant, top-3 offender ordering.

### Immediate mitigation for users still on v0.0.43
```sh
rm ~/.local/lib/mcp-deliberation/runtime.log.old 2>/dev/null
: > ~/.local/lib/mcp-deliberation/runtime.log
```
Upgrade to v0.0.45 for the permanent fix.

Ref spec: telepty shared `ad8ae96589a2f61b150712d9fe945258bf183a32f01362c809708320f399a954`.

## v0.0.44 — 2026-04-15

### Fixed
- **`runAutoHandoff` self_turn over-abort** (`lib/transport.js`). When the
  orchestrator's own CLI identity matched any speaker (e.g. orchestrator is
  claude and speakers include `claude`), the Phase 1 turn loop aborted
  entirely at the first self-turn detection, leaving remaining speakers
  un-dispatched and Phase 2 synthesis to fabricate output over an
  empty/partial debate log. The self_turn handler now submits a visible
  `[SELF_TURN_SKIP]` placeholder and advances to the next speaker. A new
  pre-flight check halts auto-handoff cleanly (no fabricated synthesis, status
  stays `active`) when every speaker matches the caller identity. Defensive
  guard at `transport.js:934-944` is untouched — self-turn speakers are still
  never passed to `runCliAutoTurnCore`, preserving the original protection
  against recursive CLI self-spawn.

### Preserved
- Interactive `deliberation_run_until_blocked` tool behavior unchanged
  (continues to return `blocked` with hint for direct callers).
- `telepty_bus` batch path unchanged.
- Defensive self_turn detection logic at `transport.js:934-944` byte-identical.

### Tests
- 3 new e2e cases in `__tests__/deliberation-e2e.test.js`:
  - `test_self_turn_skip_first_speaker`
  - `test_self_turn_skip_middle_speaker`
  - `test_all_speakers_self_match`

Ref spec: telepty shared `70a11c03e930a57f8f676236fc80ef1f85088d8a4d398239c231e2d65f7962f9`.

## v0.0.43 — 2026-04-14

- Open-source tier gating removed — all features available to free tier.

## v0.0.41 — 2026-04-14

- Cross-process semantic completion via `turn_responded` bus events.
- Inject envelope now carries `deliberation_session_id` and `turn_id`.
- `runUntilBlockedCore` returns `remaining_auto_speakers` + actionable hint on self_turn blocks.
