/**
 * BrowserControlPort — Abstract interface + Chrome DevTools MCP adapter
 *
 * Deliberation 합의 스펙:
 * - 6 메서드: attach, sendTurn, waitTurnResult, health, recover, detach
 * - Chrome DevTools MCP 1차 구현
 * - DegradationStateMachine 위임 복구
 * - MVP: ChatGPT 단일 지원
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DegradationStateMachine, makeResult, ERROR_CODES } from "./degradation-state-machine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Selector Config Loader ───

function loadSelectorConfig(provider) {
  const configPath = join(__dirname, "selectors", `${provider}.json`);
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// ─── BrowserControlPort Interface ───

class BrowserControlPort {
  /**
   * Bind to a browser tab for a deliberation session.
   * @param {string} sessionId
   * @param {{ url?: string, provider?: string }} targetHint
   * @returns {Promise<Result>}
   */
  async attach(sessionId, targetHint) {
    throw new Error("attach() not implemented");
  }

  /**
   * Send a turn message to the LLM chat input.
   * @param {string} sessionId
   * @param {string} turnId
   * @param {string} text
   * @returns {Promise<Result>}
   */
  async sendTurn(sessionId, turnId, text) {
    throw new Error("sendTurn() not implemented");
  }

  /**
   * Wait for the LLM to produce a response.
   * @param {string} sessionId
   * @param {string} turnId
   * @param {number} timeoutSec
   * @returns {Promise<Result>}
   */
  async waitTurnResult(sessionId, turnId, timeoutSec) {
    throw new Error("waitTurnResult() not implemented");
  }

  /**
   * Check if the browser binding is healthy.
   * @param {string} sessionId
   * @returns {Promise<Result>}
   */
  async health(sessionId) {
    throw new Error("health() not implemented");
  }

  /**
   * Recover from failure.
   * @param {string} sessionId
   * @param {"rebind"|"reload"|"reopen"} mode
   * @returns {Promise<Result>}
   */
  async recover(sessionId, mode) {
    throw new Error("recover() not implemented");
  }

  /**
   * Detach from the browser tab.
   * @param {string} sessionId
   * @returns {Promise<Result>}
   */
  async detach(sessionId) {
    throw new Error("detach() not implemented");
  }
}

// ─── Chrome DevTools MCP Adapter ───

class DevToolsMcpAdapter extends BrowserControlPort {
  constructor({ cdpEndpoints = [], autoResend = true } = {}) {
    super();
    /** @type {Map<string, { tabId: string, wsUrl: string, provider: string, selectors: object }>} */
    this.bindings = new Map();
    this.cdpEndpoints = cdpEndpoints;
    this.autoResend = autoResend;
    this._cmdId = 0;
    /** @type {Map<string, Set<string>>} dedupe: sessionId → Set<turnId> */
    this.sentTurns = new Map();
  }

  async attach(sessionId, targetHint = {}) {
    const provider = targetHint.provider || "chatgpt";
    const selectorConfig = loadSelectorConfig(provider);
    if (!selectorConfig) {
      return makeResult(false, null, {
        code: "INVALID_SELECTOR_CONFIG",
        message: `No selector config found for provider: ${provider}`,
      });
    }

    // Find matching tab via CDP /json/list
    const targetUrl = targetHint.url;
    const domains = selectorConfig.domains || [];

    let foundTab = null;
    for (const endpoint of this.cdpEndpoints) {
      try {
        const resp = await fetch(endpoint, {
          signal: AbortSignal.timeout(3000),
          headers: { accept: "application/json" },
        });
        const tabs = await resp.json();
        for (const tab of tabs) {
          if (tab.type !== "page") continue;
          const tabUrl = tab.url || "";
          if (targetUrl && tabUrl.includes(targetUrl)) {
            foundTab = { ...tab, endpoint };
            break;
          }
          if (domains.some(d => tabUrl.includes(d))) {
            foundTab = { ...tab, endpoint };
            break;
          }
          // Strategy 3: Extension title match
          if (selectorConfig.isExtension && tabUrl.startsWith("chrome-extension://")) {
            const titlePatterns = selectorConfig.titlePatterns || [];
            const lowerTitle = String(tab.title || "").toLowerCase();
            if (titlePatterns.some(p => lowerTitle.includes(p.toLowerCase()))) {
              foundTab = { ...tab, endpoint };
              break;
            }
          }
        }
        if (foundTab) break;
      } catch {
        // endpoint not reachable
      }
    }

    if (!foundTab) {
      return makeResult(false, null, {
        code: "BIND_FAILED",
        message: `No matching browser tab found for provider "${provider}" (checked ${this.cdpEndpoints.length} endpoints)`,
      });
    }

    this.bindings.set(sessionId, {
      tabId: foundTab.id,
      wsUrl: foundTab.webSocketDebuggerUrl,
      provider,
      selectors: selectorConfig.selectors,
      timing: selectorConfig.timing,
      pageUrl: foundTab.url,
      title: foundTab.title,
    });

    return makeResult(true, {
      provider,
      tabId: foundTab.id,
      title: foundTab.title,
      url: foundTab.url,
    });
  }

  async sendTurn(sessionId, turnId, text) {
    const binding = this.bindings.get(sessionId);
    if (!binding) {
      return makeResult(false, null, {
        code: "BIND_FAILED",
        message: `No binding for session ${sessionId}. Call attach() first.`,
      });
    }

    // Idempotency check
    if (!this.sentTurns.has(sessionId)) this.sentTurns.set(sessionId, new Set());
    const sent = this.sentTurns.get(sessionId);
    if (sent.has(turnId)) {
      return makeResult(true, { deduplicated: true, turnId });
    }

    try {
      // Execute CDP commands to type and send
      const result = await this._cdpEvaluate(binding, `
        (function() {
          const input = document.querySelector('${binding.selectors.inputSelector}');
          if (!input) return { ok: false, error: 'INPUT_NOT_FOUND' };
          input.focus();
          input.textContent = ${JSON.stringify(text)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        })()
      `);

      if (!result.ok) {
        return makeResult(false, null, {
          code: "DOM_CHANGED",
          message: `Input selector not found: ${binding.selectors.inputSelector}`,
        });
      }

      // Small delay then click send
      await new Promise(r => setTimeout(r, binding.timing?.sendDelayMs || 200));

      const sendResult = await this._cdpEvaluate(binding, `
        (function() {
          const btn = document.querySelector('${binding.selectors.sendButton}');
          if (!btn) return { ok: false, error: 'SEND_BUTTON_NOT_FOUND' };
          btn.click();
          return { ok: true };
        })()
      `);

      if (!sendResult.ok) {
        return makeResult(false, null, {
          code: "SEND_FAILED",
          message: `Send button not found: ${binding.selectors.sendButton}`,
        });
      }

      sent.add(turnId);
      return makeResult(true, { turnId, sent: true });
    } catch (err) {
      return this._classifyError(err);
    }
  }

  async waitTurnResult(sessionId, turnId, timeoutSec = 45) {
    const binding = this.bindings.get(sessionId);
    if (!binding) {
      return makeResult(false, null, {
        code: "BIND_FAILED",
        message: `No binding for session ${sessionId}`,
      });
    }

    const timeoutMs = timeoutSec * 1000;
    const pollInterval = binding.timing?.pollIntervalMs || 500;
    const startTime = Date.now();

    try {
      while (Date.now() - startTime < timeoutMs) {
        // Check if streaming is complete
        const status = await this._cdpEvaluate(binding, `
          (function() {
            const streaming = document.querySelector('${binding.selectors.streamingIndicator}');
            if (streaming) return { streaming: true };
            const responses = document.querySelectorAll('${binding.selectors.responseContainer}');
            if (responses.length === 0) return { streaming: true };
            const last = responses[responses.length - 1];
            const content = last.querySelector('${binding.selectors.responseSelector}');
            return {
              streaming: false,
              text: content ? content.textContent : last.textContent,
            };
          })()
        `);

        if (status.data && !status.data.streaming && status.data.text) {
          return makeResult(true, {
            turnId,
            response: status.data.text.trim(),
            elapsedMs: Date.now() - startTime,
          });
        }

        await new Promise(r => setTimeout(r, pollInterval));
      }

      return makeResult(false, null, {
        code: "TIMEOUT",
        message: `Response not received within ${timeoutSec}s`,
      });
    } catch (err) {
      return this._classifyError(err);
    }
  }

  async health(sessionId) {
    const binding = this.bindings.get(sessionId);
    if (!binding) {
      return makeResult(true, { bound: false, sessionId });
    }

    try {
      const result = await this._cdpEvaluate(binding, "document.readyState");
      return makeResult(true, {
        bound: true,
        sessionId,
        provider: binding.provider,
        pageUrl: binding.pageUrl,
        readyState: result.data,
      });
    } catch (err) {
      return makeResult(false, null, {
        code: "TAB_CLOSED",
        message: `Health check failed: ${err.message}`,
      });
    }
  }

  async recover(sessionId, mode = "rebind") {
    const binding = this.bindings.get(sessionId);

    switch (mode) {
      case "rebind": {
        // Re-scan for the tab
        if (!binding) return makeResult(false, null, { code: "BIND_FAILED", message: "No previous binding to rebind" });
        return this.attach(sessionId, { provider: binding.provider });
      }
      case "reload": {
        if (!binding) return makeResult(false, null, { code: "TAB_CLOSED", message: "No binding to reload" });
        try {
          await this._cdpCommand(binding, "Page.reload", {});
          await new Promise(r => setTimeout(r, 3000)); // wait for reload
          return makeResult(true, { mode: "reload", sessionId });
        } catch (err) {
          return this._classifyError(err);
        }
      }
      case "reopen": {
        // Detach old binding, try re-attach
        this.bindings.delete(sessionId);
        const provider = binding?.provider || "chatgpt";
        return this.attach(sessionId, { provider });
      }
      default:
        return makeResult(false, null, { code: "SEND_FAILED", message: `Unknown recover mode: ${mode}` });
    }
  }

  async detach(sessionId) {
    this.bindings.delete(sessionId);
    this.sentTurns.delete(sessionId);
    return makeResult(true, { sessionId, detached: true });
  }

  // ─── CDP Helpers ───

  async _cdpEvaluate(binding, expression) {
    return this._cdpCommand(binding, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    }).then(result => {
      const val = result?.result?.value;
      if (val && typeof val === "object" && val.ok === false) {
        return makeResult(false, null, { code: "DOM_CHANGED", message: val.error || "DOM evaluation failed" });
      }
      return makeResult(true, val);
    });
  }

  async _cdpCommand(binding, method, params = {}) {
    if (!binding.wsUrl) {
      throw Object.assign(new Error("No WebSocket URL for CDP"), { code: "MCP_CHANNEL_CLOSED" });
    }

    // Use dynamic import for WebSocket (Node 18+ has it globally, or ws package)
    const ws = await this._connectWs(binding.wsUrl);
    const id = ++this._cmdId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(Object.assign(new Error("CDP command timeout"), { code: "TIMEOUT" }));
      }, 10000);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(typeof event === "string" ? event : event.data);
          if (data.id === id) {
            clearTimeout(timeout);
            ws.close();
            if (data.error) {
              reject(Object.assign(new Error(data.error.message), { code: "SEND_FAILED" }));
            } else {
              resolve(data.result);
            }
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        ws.close();
        reject(Object.assign(new Error(err.message || "WebSocket error"), { code: "NETWORK_DISCONNECTED" }));
      };

      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async _connectWs(url) {
    // Node.js 22+ has global WebSocket; fallback to ws package
    if (typeof globalThis.WebSocket !== "undefined") {
      const ws = new globalThis.WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      return ws;
    }

    // Try dynamic import of ws
    try {
      const { default: WS } = await import("ws");
      const ws = new WS(url);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      return ws;
    } catch {
      throw Object.assign(new Error("WebSocket not available. Install 'ws' package or use Node 22+."), { code: "MCP_CHANNEL_CLOSED" });
    }
  }

  _classifyError(err) {
    const code = err.code || "UNKNOWN";
    if (ERROR_CODES[code]) {
      return makeResult(false, null, { code, message: err.message });
    }
    // Classify by message patterns
    if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(err.message)) {
      return makeResult(false, null, { code: "NETWORK_DISCONNECTED", message: err.message });
    }
    if (/WebSocket|ws:/i.test(err.message)) {
      return makeResult(false, null, { code: "MCP_CHANNEL_CLOSED", message: err.message });
    }
    if (/target.*closed|page.*crashed/i.test(err.message)) {
      return makeResult(false, null, { code: "BROWSER_CRASHED", message: err.message });
    }
    return makeResult(false, null, { code: "UNKNOWN", message: err.message });
  }
}

// ─── Orchestrated Port (with DegradationStateMachine) ───

class OrchestratedBrowserPort {
  constructor({ cdpEndpoints = [], autoResend = true, skipEnabled = false } = {}) {
    this.adapter = new DevToolsMcpAdapter({ cdpEndpoints, autoResend });
    this.machines = new Map(); // sessionId → DegradationStateMachine
  }

  _getOrCreateMachine(sessionId) {
    if (!this.machines.has(sessionId)) {
      this.machines.set(sessionId, new DegradationStateMachine({
        onRetry: () => makeResult(false, null, { code: "SEND_FAILED", message: "retry pass-through" }),
        onRebind: () => this.adapter.recover(sessionId, "rebind"),
        onReload: () => this.adapter.recover(sessionId, "reload"),
        onFallback: (lastResult) => {
          return makeResult(false, null, {
            code: "TIMEOUT",
            message: "All degradation stages exhausted. Falling back to clipboard mode.",
          });
        },
      }));
    }
    return this.machines.get(sessionId);
  }

  async attach(sessionId, targetHint) {
    return this.adapter.attach(sessionId, targetHint);
  }

  /**
   * Send a turn with full degradation pipeline.
   */
  async sendTurnWithDegradation(sessionId, turnId, text) {
    const machine = this._getOrCreateMachine(sessionId);
    return machine.execute(() => this.adapter.sendTurn(sessionId, turnId, text));
  }

  async waitTurnResult(sessionId, turnId, timeoutSec) {
    return this.adapter.waitTurnResult(sessionId, turnId, timeoutSec);
  }

  async health(sessionId) {
    return this.adapter.health(sessionId);
  }

  async recover(sessionId, mode) {
    return this.adapter.recover(sessionId, mode);
  }

  async detach(sessionId) {
    this.machines.delete(sessionId);
    return this.adapter.detach(sessionId);
  }

  getDegradationState(sessionId) {
    const machine = this.machines.get(sessionId);
    return machine ? machine.toJSON() : null;
  }
}

export {
  BrowserControlPort,
  DevToolsMcpAdapter,
  OrchestratedBrowserPort,
  loadSelectorConfig,
};
