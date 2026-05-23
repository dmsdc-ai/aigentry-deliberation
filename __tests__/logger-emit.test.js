// δ2 Phase 3 (#440) — deliberation emitter wrapper unit tests.

import { describe, expect, it, beforeEach } from "vitest";
import {
  emitTelemetry,
  emitTurnEvent,
  emitSynthesisEvent,
  emitHandoffEvent,
  resolveContext,
  __resetRoleWarningForTests,
} from "../logger-emit.js";

const FROZEN = () => new Date("2026-05-23T12:00:00.000Z");

function capture() {
  const events = [];
  return { events, sink: (e) => events.push(e) };
}

beforeEach(() => {
  __resetRoleWarningForTests();
});

describe("resolveContext", () => {
  it("returns valid env values", () => {
    const ctx = resolveContext({ AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "coder" });
    expect(ctx).toEqual({ session_id: "sid-A", role: "coder" });
  });

  it("returns null role when unset/invalid (library context)", () => {
    expect(resolveContext({ AIGENTRY_SESSION_ID: "sid-A" }).role).toBeNull();
    expect(resolveContext({ AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "deliberation" }).role).toBeNull();
  });

  it("falls back to pid session_id", () => {
    expect(resolveContext({}).session_id).toMatch(/^pid-\d+$/);
  });
});

describe("emitTelemetry", () => {
  it("emits a well-formed envelope when role is valid", () => {
    const { events, sink } = capture();
    emitTelemetry(
      {
        kind: "state-change",
        payload: { subtype: "turn_complete", speaker: "claude" },
        correlation_id: "t1",
      },
      {
        env: { AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "orchestrator" },
        now: FROZEN,
        __emit: sink,
      },
    );
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.schema_version).toBe("1");
    expect(e.kind).toBe("state-change");
    expect(e.session_id).toBe("sid-A");
    expect(e.role).toBe("orchestrator");
    expect(e.correlation_id).toBe("t1");
    expect(e.payload).toEqual({ subtype: "turn_complete", speaker: "claude" });
  });

  it("skip-with-warning when AIGENTRY_ROLE unset", () => {
    const { events, sink } = capture();
    const origWarn = console.warn;
    const warns = [];
    console.warn = (msg) => warns.push(msg);
    try {
      emitTelemetry(
        { kind: "state-change", payload: { subtype: "turn_start" } },
        { env: { AIGENTRY_SESSION_ID: "sid-A" }, now: FROZEN, __emit: sink },
      );
    } finally {
      console.warn = origWarn;
    }
    expect(events.length).toBe(0);
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/AIGENTRY_ROLE unset/);
  });

  it("warning fires only once per process", () => {
    const origWarn = console.warn;
    const warns = [];
    console.warn = (msg) => warns.push(msg);
    try {
      for (let i = 0; i < 3; i++) {
        emitTelemetry(
          { kind: "report", payload: { subtype: "synthesis" } },
          { env: { AIGENTRY_SESSION_ID: "sid-A" }, now: FROZEN, __emit: () => {} },
        );
      }
    } finally {
      console.warn = origWarn;
    }
    expect(warns.length).toBe(1);
  });

  it("AIGENTRY_LOGGER_DISABLED=1 short-circuits before sink", () => {
    let called = 0;
    emitTelemetry(
      { kind: "report", payload: { subtype: "synthesis" } },
      {
        env: {
          AIGENTRY_LOGGER_DISABLED: "1",
          AIGENTRY_SESSION_ID: "sid-A",
          AIGENTRY_ROLE: "orchestrator",
        },
        now: FROZEN,
        __emit: () => { called++; },
      },
    );
    expect(called).toBe(0);
  });

  it("transport failure is swallowed (§9 non-blocking)", () => {
    const origErr = console.error;
    const errs = [];
    console.error = (msg) => errs.push(msg);
    try {
      expect(() =>
        emitTelemetry(
          { kind: "error", payload: { reason: "x" } },
          {
            env: { AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "orchestrator" },
            now: FROZEN,
            __emit: () => { throw new Error("simulated"); },
          },
        ),
      ).not.toThrow();
    } finally {
      console.error = origErr;
    }
    expect(errs.some((m) => /telemetry emit failed/.test(m))).toBe(true);
  });
});

describe("A1 helpers", () => {
  it("convenience helpers tag subtype + kind correctly with AIGENTRY_LOGGER_DISABLED=1", () => {
    process.env.AIGENTRY_LOGGER_DISABLED = "1";
    try {
      expect(() => emitTurnEvent("turn_complete", { session: "x" })).not.toThrow();
      expect(() => emitSynthesisEvent({ session: "x" })).not.toThrow();
      expect(() => emitHandoffEvent({ session: "x", tasks_total: 5 })).not.toThrow();
    } finally {
      delete process.env.AIGENTRY_LOGGER_DISABLED;
    }
  });
});
