/**
 * DegradationStateMachine — 4-stage graceful degradation for BrowserControlPort
 *
 * States: HEALTHY → RETRYING → REBINDING → RELOADING → FALLBACK → FAILED
 * Time budget (60s SLO): S1(12s) + S2(8s) + S3(18s) + S4(22s spare)
 */

const STATES = {
  HEALTHY: "HEALTHY",
  RETRYING: "RETRYING",
  REBINDING: "REBINDING",
  RELOADING: "RELOADING",
  FALLBACK: "FALLBACK",
  FAILED: "FAILED",
};

const STAGE_BUDGETS = {
  RETRYING: { maxAttempts: 2, backoffMs: [2000, 4000], budgetMs: 12000 },
  REBINDING: { maxAttempts: 1, budgetMs: 8000 },
  RELOADING: { maxAttempts: 1, budgetMs: 18000 },
  FALLBACK: { budgetMs: 22000 },
};

const ERROR_CODES = {
  BIND_FAILED: { category: "transient", domain: "browser", retryable: true },
  SEND_FAILED: { category: "transient", domain: "transport", retryable: true },
  TIMEOUT: { category: "transient", domain: "transport", retryable: true },
  DOM_CHANGED: { category: "transient", domain: "dom", retryable: true },
  SESSION_EXPIRED: { category: "permanent", domain: "session", retryable: false },
  TAB_CLOSED: { category: "transient", domain: "browser", retryable: true },
  NETWORK_DISCONNECTED: { category: "transient", domain: "transport", retryable: true },
  MCP_CHANNEL_CLOSED: { category: "transient", domain: "transport", retryable: true },
  BROWSER_CRASHED: { category: "transient", domain: "browser", retryable: true },
  INVALID_SELECTOR_CONFIG: { category: "permanent", domain: "dom", retryable: false },
};

function makeResult(ok, data, error) {
  if (ok) return { ok: true, data: data ?? null };
  const meta = ERROR_CODES[error?.code] || ERROR_CODES.TIMEOUT;
  return {
    ok: false,
    error: {
      code: error?.code || "UNKNOWN",
      category: meta.category,
      domain: meta.domain,
      message: error?.message || "Unknown error",
      retryable: meta.retryable,
    },
  };
}

class DegradationStateMachine {
  constructor({ onRetry, onRebind, onReload, onFallback, skipEnabled = false } = {}) {
    this.state = STATES.HEALTHY;
    this.stageAttempts = { RETRYING: 0, REBINDING: 0, RELOADING: 0 };
    this.startTime = null;
    this.lastError = null;
    this.skipEnabled = skipEnabled;

    // Callbacks for each stage action
    this._onRetry = onRetry || (() => makeResult(false, null, { code: "SEND_FAILED", message: "retry not implemented" }));
    this._onRebind = onRebind || (() => makeResult(false, null, { code: "DOM_CHANGED", message: "rebind not implemented" }));
    this._onReload = onReload || (() => makeResult(false, null, { code: "TAB_CLOSED", message: "reload not implemented" }));
    this._onFallback = onFallback || (() => makeResult(false, null, { code: "TIMEOUT", message: "fallback not implemented" }));
  }

  reset() {
    this.state = STATES.HEALTHY;
    this.stageAttempts = { RETRYING: 0, REBINDING: 0, RELOADING: 0 };
    this.startTime = null;
    this.lastError = null;
  }

  get elapsedMs() {
    return this.startTime ? Date.now() - this.startTime : 0;
  }

  get totalBudgetMs() {
    return 60000;
  }

  get isTerminal() {
    return this.state === STATES.FAILED || this.state === STATES.FALLBACK;
  }

  /**
   * Execute a turn with full degradation pipeline.
   * @param {Function} primaryAction - async () => Result. The main action to attempt.
   * @returns {Result} Final result after all degradation attempts.
   */
  async execute(primaryAction) {
    this.startTime = Date.now();
    this.state = STATES.HEALTHY;
    this.stageAttempts = { RETRYING: 0, REBINDING: 0, RELOADING: 0 };

    // Stage 0: Primary attempt
    const primaryResult = await this._timed(primaryAction);
    if (primaryResult.ok) return primaryResult;
    this.lastError = primaryResult.error;

    // Check if permanent error — skip to FAILED
    if (primaryResult.error && !primaryResult.error.retryable) {
      this.state = STATES.FAILED;
      return primaryResult;
    }

    // Stage 1: Retry with backoff
    this.state = STATES.RETRYING;
    const retryResult = await this._stageRetry(primaryAction);
    if (retryResult.ok) { this.state = STATES.HEALTHY; return retryResult; }
    if (this._budgetExceeded()) return this._toFallback(retryResult);

    // Stage 2: Rebind (DOM re-scan)
    this.state = STATES.REBINDING;
    const rebindResult = await this._stageRebind();
    if (rebindResult.ok) {
      // Rebind succeeded, retry primary once more
      const afterRebind = await this._timed(primaryAction);
      if (afterRebind.ok) { this.state = STATES.HEALTHY; return afterRebind; }
    }
    if (this._budgetExceeded()) return this._toFallback(rebindResult);

    // Stage 3: Reload/Reopen
    this.state = STATES.RELOADING;
    const reloadResult = await this._stageReload();
    if (reloadResult.ok) {
      // After reload, retry primary once (auto-resend with turn_id idempotency)
      const afterReload = await this._timed(primaryAction);
      if (afterReload.ok) { this.state = STATES.HEALTHY; return afterReload; }
    }
    if (this._budgetExceeded()) return this._toFallback(reloadResult);

    // Stage 4: Fallback
    return this._toFallback(reloadResult);
  }

  async _stageRetry(action) {
    const budget = STAGE_BUDGETS.RETRYING;
    let lastResult = null;
    for (let i = 0; i < budget.maxAttempts; i++) {
      if (this._budgetExceeded()) break;
      const delay = budget.backoffMs[i] || budget.backoffMs[budget.backoffMs.length - 1];
      await this._sleep(delay);
      this.stageAttempts.RETRYING++;
      lastResult = await this._timed(action);
      if (lastResult.ok) return lastResult;
      this.lastError = lastResult.error;
    }
    return lastResult || makeResult(false, null, { code: "TIMEOUT", message: "retry exhausted" });
  }

  async _stageRebind() {
    if (this._budgetExceeded()) return makeResult(false, null, { code: "TIMEOUT", message: "budget exceeded before rebind" });
    this.stageAttempts.REBINDING++;
    return this._timed(this._onRebind);
  }

  async _stageReload() {
    if (this._budgetExceeded()) return makeResult(false, null, { code: "TIMEOUT", message: "budget exceeded before reload" });
    this.stageAttempts.RELOADING++;
    return this._timed(this._onReload);
  }

  async _toFallback(lastResult) {
    this.state = STATES.FALLBACK;
    const fallbackResult = await this._onFallback(lastResult);
    if (!fallbackResult?.ok && !this.skipEnabled) {
      this.state = STATES.FAILED;
    }
    return fallbackResult || makeResult(false, null, {
      code: "TIMEOUT",
      message: `All degradation stages exhausted (elapsed: ${this.elapsedMs}ms)`,
    });
  }

  _budgetExceeded() {
    return this.elapsedMs >= this.totalBudgetMs;
  }

  async _timed(fn) {
    try {
      return await fn();
    } catch (err) {
      return makeResult(false, null, {
        code: err.code || "UNKNOWN",
        message: err.message || String(err),
      });
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  toJSON() {
    return {
      state: this.state,
      elapsedMs: this.elapsedMs,
      stageAttempts: { ...this.stageAttempts },
      lastError: this.lastError,
      skipEnabled: this.skipEnabled,
    };
  }
}

export { DegradationStateMachine, STATES, STAGE_BUDGETS, ERROR_CODES, makeResult };
