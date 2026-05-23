// δ2 Phase 3 (#440) — deliberation emitter wrapper.
//
// Library-context emit. The deliberation MCP server is consumed by many
// session roles (orchestrator/coder/architect/...), so we cannot
// fabricate a Role when AIGENTRY_ROLE is unset: per the Phase 2 ACK
// decision (option B), we emit-skip-with-warning so telemetry stays
// clean of synthetic attribution. Warning fires once per process.
//
// Schema mapping per orchestrator A1 decision:
//   spec event       → ssot kind        + payload.subtype
//   turn_event       → state-change     + turn_start | turn_complete
//   synthesis_event  → report           + synthesis
//   handoff_event    → report           + handoff_v2
//
// ESM module (package.json "type": "module"). @aigentry/logger is also
// ESM — direct `import` works.
//
// Failure mode (§9 독립): transport errors swallowed via try/catch.

import { emit as loggerEmit } from "@aigentry/logger";

const VALID_ROLES = new Set([
  "orchestrator",
  "architect",
  "coder",
  "tester",
  "builder",
  "analyst",
  "researcher",
  "reviewer",
  "logger",
]);

let _warnedRoleUnset = false;
function warnOnceRoleUnset() {
  if (_warnedRoleUnset) return;
  _warnedRoleUnset = true;
  try {
    console.warn(
      "[logger] emit skipped: AIGENTRY_ROLE unset (this is normal for library context)",
    );
  } catch (_e) {
    /* noop */
  }
}

export function __resetRoleWarningForTests() {
  _warnedRoleUnset = false;
}

export function resolveContext(env = process.env) {
  const session_id = env.AIGENTRY_SESSION_ID || `pid-${process.pid}`;
  const rawRole = env.AIGENTRY_ROLE;
  if (rawRole && VALID_ROLES.has(rawRole)) {
    return { session_id, role: rawRole };
  }
  return { session_id, role: null };
}

export function emitTelemetry(input, opts = {}) {
  const env = opts.env || process.env;
  if (env.AIGENTRY_LOGGER_DISABLED === "1") return;
  const ctx = resolveContext(env);
  if (ctx.role === null) {
    warnOnceRoleUnset();
    return;
  }
  const now = opts.now || (() => new Date());
  const event = {
    schema_version: "1",
    kind: input.kind,
    session_id: ctx.session_id,
    role: ctx.role,
    emitted_at: now().toISOString(),
    payload: input.payload || {},
  };
  if (input.correlation_id) event.correlation_id = input.correlation_id;
  const sink = opts.__emit || loggerEmit;
  try {
    sink(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      console.error(`[deliberation:logger-emit] telemetry emit failed: ${msg}`);
    } catch (_e) {
      /* noop */
    }
  }
}

export function emitTurnEvent(subtype, payload, correlationId) {
  emitTelemetry(
    {
      kind: "state-change",
      payload: { subtype, ...(payload || {}) },
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
  );
}

export function emitSynthesisEvent(payload, correlationId) {
  emitTelemetry(
    {
      kind: "report",
      payload: { subtype: "synthesis", ...(payload || {}) },
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
  );
}

export function emitHandoffEvent(payload, correlationId) {
  emitTelemetry(
    {
      kind: "report",
      payload: { subtype: "handoff_v2", ...(payload || {}) },
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
  );
}
