# Changelog

## Unreleased

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

### Snyk note (pre-existing, not introduced by #440)

Snyk At-Inception (#440 Phase 4) flagged a Medium-severity Path Traversal
(CWE-23) at `index.js:376` (`fs.readFileSync(file, "utf-8")` under
`getExecutionStatusFile()` — data flow originating from an MCP tool
argument at line 1449). This finding pre-exists δ2 (`git blame` →
e45a5a0e, 2026-03-13) and is unrelated to the logger emit wiring. Tracked
for follow-up under the same telepty 0.4.3 pattern — fix in a dedicated
input-sanitisation patch, not in a feat() commit.

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
