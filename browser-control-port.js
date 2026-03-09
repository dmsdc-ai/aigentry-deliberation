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
import { writeClipboardText } from "./clipboard.js";

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
    /** @type {Map<string, any>} wsUrl -> WebSocket connection promise */
    this._connections = new Map();
  }

  async _getConnection(wsUrl) {
    if (this._connections.has(wsUrl)) {
      const conn = await this._connections.get(wsUrl);
      if (conn.readyState === 1 || conn.readyState === 0) return conn; // OPEN or CONNECTING
      this._connections.delete(wsUrl);
    }

    const connPromise = this._connectWs(wsUrl);
    this._connections.set(wsUrl, connPromise);
    
    try {
      const ws = await connPromise;
      // Handle cleanup if closed externally
      if (ws.on) {
        ws.on("close", () => this._connections.delete(wsUrl));
      } else if (ws.addEventListener) {
        ws.addEventListener("close", () => this._connections.delete(wsUrl));
      }
      return ws;
    } catch (err) {
      this._connections.delete(wsUrl);
      throw err;
    }
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

    // If no matching tab found, try to open one automatically
    if (!foundTab && targetHint.url) {
      for (const endpoint of this.cdpEndpoints) {
        try {
          const baseUrl = endpoint.replace(/\/json\/list\/?$/, "");
          const createUrl = `${baseUrl}/json/new?${encodeURIComponent(targetHint.url)}`;
          const resp = await fetch(createUrl, {
            method: "PUT",
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) {
            const newTab = await resp.json();
            if (newTab && newTab.webSocketDebuggerUrl) {
              // Wait for page to initialize
              await new Promise(r => setTimeout(r, 3000));
              foundTab = { ...newTab, endpoint };
              break;
            }
          }
        } catch {
          // endpoint not reachable or create failed
        }
      }
    }

    if (!foundTab) {
      return makeResult(false, null, {
        code: "BIND_FAILED",
        message: `No matching browser tab found for provider "${provider}" (checked ${this.cdpEndpoints.length} endpoints). Ensure Chrome is running with --remote-debugging-port=9222 and a tab with ${targetHint.url || provider} is open.`,
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
      modelSelector: selectorConfig.modelSelector || null,
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
      // Capture baseline response count BEFORE send (for waitTurnResult to detect NEW responses)
      const respContSel = JSON.stringify(binding.selectors.responseContainer);
      const respSel = JSON.stringify(binding.selectors.responseSelector);
      const baseline = await this._cdpEvaluate(binding, `
        (function() {
          var cc = 0, dc = 0;
          ${respContSel}.split(',').forEach(function(s) {
            try { cc += document.querySelectorAll(s.trim()).length; } catch(e) {}
          });
          ${respSel}.split(',').forEach(function(s) {
            try { dc += document.querySelectorAll(s.trim()).length; } catch(e) {}
          });
          return { containerCount: cc, directCount: dc };
        })()
      `);
      binding._baselineResponseCount = baseline.data?.containerCount || 0;
      binding._baselineDirectCount = baseline.data?.directCount || 0;
      binding._lastSentText = text; // Store for response filtering

      // Mark existing containers with data-dlb-baseline for robust new-response detection
      // (immune to content-visibility CSS count fluctuations)
      await this._cdpEvaluate(binding, `
        (function() {
          var contSels = ${respContSel}.split(',').map(function(s) { return s.trim(); });
          try { document.querySelectorAll('[data-dlb-baseline]').forEach(function(el) { el.removeAttribute('data-dlb-baseline'); }); } catch(e) {}
          for (var i = 0; i < contSels.length; i++) {
            try { document.querySelectorAll(contSels[i]).forEach(function(el) { el.setAttribute('data-dlb-baseline', '1'); }); } catch(e) {}
          }
          return { ok: true };
        })()
      `);

      // Step 1: Focus input and insert text
      const inputSel = JSON.stringify(binding.selectors.inputSelector);
      const sendBtnSel = JSON.stringify(binding.selectors.sendButton);
      const escapedText = JSON.stringify(text);

      // Focus the input element first — use click() + focus() for full framework initialization
      const focusInput = await this._cdpEvaluate(binding, `
        (function() {
          var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
          for (var i = 0; i < sels.length; i++) {
            var input = document.querySelector(sels[i]);
            if (input) {
              input.click();
              input.focus();
              return { ok: true, isContentEditable: input.isContentEditable, tagName: input.tagName };
            }
          }
          return { ok: false, error: 'INPUT_NOT_FOUND' };
        })()
      `);

      if (!focusInput.ok || focusInput.data?.error) {
        return makeResult(false, null, {
          code: "DOM_CHANGED",
          message: `Input selector not found: ${binding.selectors.inputSelector}`,
        });
      }

      const isCE = focusInput.data?.isContentEditable;
      const isMac = process.platform === "darwin";

      // ── Step 1.1: Insert text ──
      // For IME-heavy languages (Korean, Japanese, etc.) or complex editors (tiptap, ProseMirror),
      // Input.insertText is the canonical CDP way to inject text while bypassing IME.
      let insertionSuccess = false;
      
      try {
        // Strategy 1: Clear and insert via CDP (Reliable for most web apps)
        await this._cdpEvaluate(binding, `
          (function() {
            var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
            for (var i = 0; i < sels.length; i++) {
              var input = document.querySelector(sels[i]);
              if (input) {
                input.click();
                input.focus();
                if (input.isContentEditable) {
                  var sel = window.getSelection();
                  var range = document.createRange();
                  range.selectNodeContents(input);
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('delete', false);
                } else {
                  input.value = '';
                }
                return { ok: true };
              }
            }
            return { ok: false };
          })()
        `);
        
        await this._cdpCommand(binding, "Input.insertText", { text });
        await new Promise(r => setTimeout(r, 100));
        
        // Sync framework state
        await this._cdpEvaluate(binding, `
          (function() {
            var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
            for (var i = 0; i < sels.length; i++) {
              var input = document.querySelector(sels[i]);
              if (input) {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          })()
        `);
        insertionSuccess = true;
      } catch (e) { /* ignore and try fallback */ }

      // Strategy 2: Fallback to System Clipboard Paste (Cmd+V)
      if (!insertionSuccess) {
        try {
          writeClipboardText(text);
          const mod = isMac ? 4 : 2; // Meta (4) on Mac, Control (2) on Win/Linux
          const keyCode = isMac ? 9 : 86; // 'V' key code
          
          // On Mac, we can send a list of commands. "paste" is layout-independent.
          const cdpParams = {
            type: "keyDown",
            modifiers: mod,
            key: isMac ? "ㅍ" : "v", // Map to current layout if possible
            code: "KeyV",
            windowsVirtualKeyCode: 86,
            nativeVirtualKeyCode: keyCode
          };
          if (isMac) cdpParams.commands = ["paste"];
          
          await this._cdpCommand(binding, "Input.dispatchKeyEvent", cdpParams);
          
          // Also send KeyUp
          await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
            type: "keyUp",
            modifiers: mod,
            key: isMac ? "ㅍ" : "v",
            code: "KeyV",
            windowsVirtualKeyCode: 86,
            nativeVirtualKeyCode: keyCode
          });
          
          insertionSuccess = true;
          await new Promise(r => setTimeout(r, 200));
        } catch (clipErr) { /* ignore */ }
      }

      if (!insertionSuccess) {
        if (isCE) {
          // For contenteditable: use CDP Input.insertText (works with tiptap/ProseMirror/Quill)
          // First clear existing content
          await this._cdpEvaluate(binding, `
            (function() {
              var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
              var input = null;
              for (var i = 0; i < sels.length; i++) { input = document.querySelector(sels[i]); if (input) break; }
              if (!input) return { ok: true };
              input.click();
              input.focus();
              var sel = window.getSelection();
              var range = document.createRange();
              range.selectNodeContents(input);
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand('delete', false);
              return { ok: true };
            })()
          `);
          await new Promise(r => setTimeout(r, 50));

          // Use CDP Input.insertText — triggers all framework handlers (tiptap, ProseMirror, Quill)
          try {
            await this._cdpCommand(binding, "Input.insertText", { text });
          } catch {
            // Fallback: execCommand (works for tiptap when properly focused via click)
            await this._cdpEvaluate(binding, `
              (function() {
                var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
                for (var i = 0; i < sels.length; i++) {
                  var input = document.querySelector(sels[i]);
                  if (input) { input.click(); input.focus(); document.execCommand('insertText', false, ${escapedText}); break; }
                }
                return { ok: true };
              })()
            `);
          }
        } else {
          // For regular <textarea>/<input>: clear existing content, then use CDP Input.insertText
          await this._cdpEvaluate(binding, `
            (function() {
              var input = document.querySelector(${inputSel});
              if (!input) return { ok: true };
              input.focus();
              input.select ? input.select() : null;
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true };
            })()
          `);
          await new Promise(r => setTimeout(r, 50));

          // CDP Input.insertText triggers OS-level text input
          try {
            await this._cdpCommand(binding, "Input.insertText", { text });
          } catch {
            // Fallback: nativeSetter approach
            await this._cdpEvaluate(binding, `
              (function() {
                var input = document.querySelector(${inputSel});
                if (!input) return { ok: true };
                var nativeSetter = Object.getOwnPropertyDescriptor(
                  Object.getPrototypeOf(input), 'value'
                );
                if (nativeSetter && nativeSetter.set) {
                  nativeSetter.set.call(input, ${escapedText});
                } else {
                  input.value = ${escapedText};
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true };
              })()
            `);
          }

          // Sync React/Vue state: CDP Input.insertText updates DOM but may not trigger React onChange.
          // Re-set value via nativeSetter + dispatch input event to force framework state sync.
          await this._cdpEvaluate(binding, `
            (function() {
              var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
              for (var i = 0; i < sels.length; i++) {
                var input = document.querySelector(sels[i]);
                if (input && input.value) {
                  var proto = Object.getPrototypeOf(input);
                  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (desc && desc.set) {
                    desc.set.call(input, input.value);
                  }
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  return { ok: true };
                }
              }
              return { ok: true };
            })()
          `);
        }
      }

      // Small delay for framework state propagation
      await new Promise(r => setTimeout(r, binding.timing?.sendDelayMs || 200));

      // Step 2: Send — strategy depends on input type
      if (isCE) {
        // For contenteditable (ProseMirror/Quill/tiptap): click send button (Enter = newline)
        // Retry up to 4 times with delay — send button may appear after framework state update
        let sendAttempted = false;
        for (let attempt = 0; attempt < 4 && !sendAttempted; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 400));
          const sendResult = await this._cdpEvaluate(binding, `
            (function() {
              var btnSels = ${sendBtnSel}.split(',').map(function(s) { return s.trim(); });
              for (var i = 0; i < btnSels.length; i++) {
                try {
                  var btn = document.querySelector(btnSels[i]);
                  if (!btn) continue;
                  var isVisible = btn.offsetParent !== null || btn.getClientRects().length > 0;
                  var isEnabled = btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled;
                  if (isVisible && isEnabled) {
                    // Use MouseEvent dispatch (works with React, div[role=button], etc.)
                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return { ok: true, method: 'button', sel: btnSels[i], attempt: ${attempt} };
                  }
                } catch(e) {}
              }
              // Fallback: try form submit
              var input = document.querySelector(${inputSel});
              var form = input ? input.closest('form') : null;
              if (form) {
                form.requestSubmit ? form.requestSubmit() : form.submit();
                return { ok: true, method: 'form-submit' };
              }
              return { ok: false, method: 'none' };
            })()
          `);
          if (sendResult.data?.method !== 'none') {
            sendAttempted = true;
          }
        }
        // Last resort: try Enter key via CDP (may work for some editors)
        if (!sendAttempted) {
          try {
            await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
              type: "rawKeyDown", key: "Enter", code: "Enter",
              windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
            await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
              type: "char", key: "\r", code: "Enter",
              windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
            await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Enter", code: "Enter",
              windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
          } catch {}
        }
      } else {
        // For regular textarea/input: try send button click FIRST (more reliable), Enter as fallback
        // Step 2a: Try clicking send button (prefer LAST match — rightmost button is typically send)
        let textareaSendClicked = false;
        const btnClickResult = await this._cdpEvaluate(binding, `
          (function() {
            var btnSels = ${sendBtnSel}.split(',').map(function(s) { return s.trim(); });
            // Collect ALL matching buttons
            var allBtns = [];
            for (var i = 0; i < btnSels.length; i++) {
              try {
                var matches = document.querySelectorAll(btnSels[i]);
                for (var j = 0; j < matches.length; j++) allBtns.push({ el: matches[j], sel: btnSels[i] });
              } catch(e) {}
            }
            // Try in REVERSE order — last matching button near input is typically the send button
            for (var k = allBtns.length - 1; k >= 0; k--) {
              var btn = allBtns[k].el;
              var isVisible = btn.offsetParent !== null || btn.getClientRects().length > 0;
              var isEnabled = btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled;
              if (isVisible && isEnabled) {
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return { ok: true, method: 'button-reverse', sel: allBtns[k].sel, idx: k };
              }
            }
            return { ok: false, method: 'none', btnCount: allBtns.length };
          })()
        `);
        textareaSendClicked = btnClickResult.data?.method !== 'none';

        // Step 2b: Also send Enter key (some providers need it in addition to or instead of button)
        await new Promise(r => setTimeout(r, 100));
        const focusResult = await this._cdpEvaluate(binding, `
          (function() {
            var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
            for (var i = 0; i < sels.length; i++) {
              var input = document.querySelector(sels[i]);
              if (input) { input.focus(); return { ok: true }; }
            }
            return { ok: false };
          })()
        `);

        try {
          await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
          await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
            type: "char", key: "\r", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
          await this._cdpCommand(binding, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
        } catch {
          // JS fallback
          await this._cdpEvaluate(binding, `
            (function() {
              var sels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
              for (var i = 0; i < sels.length; i++) {
                var input = document.querySelector(sels[i]);
                if (input) {
                  input.focus();
                  ['keydown','keypress','keyup'].forEach(function(t) {
                    input.dispatchEvent(new KeyboardEvent(t, { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true }));
                  });
                  break;
                }
              }
              return { ok: true };
            })()
          `);
        }
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
    const stabilizationThreshold = binding.timing?.stabilizationThreshold || 6;
    const stabilizationMinWaitMs = binding.timing?.stabilizationMinWaitMs || 0;
    const startTime = Date.now();

    const streamSel = JSON.stringify(binding.selectors.streamingIndicator);
    const respContSel = JSON.stringify(binding.selectors.responseContainer);
    const respSel = JSON.stringify(binding.selectors.responseSelector);
    const baselineContainers = binding._baselineResponseCount || 0;
    const baselineDirect = binding._baselineDirectCount || 0;
    const sentText = JSON.stringify(binding._lastSentText || "");

    let lastSeenText = '';
    let stableCount = 0;

    try {
      while (Date.now() - startTime < timeoutMs) {
        const elapsed = Date.now() - startTime;
        const status = await this._cdpEvaluate(binding, `
          (function() {
            var sentMsg = ${sentText};

            // Helper: check if text is actually a response (not user echo, placeholder, or UI noise)
            function isResponse(txt) {
              if (!txt || !txt.trim()) return false;
              var t = txt.trim();
              var tLower = t.toLowerCase();
              // Reject if text is exact match of sent message (user echo)
              if (sentMsg && t === sentMsg) return false;
              // Reject if text is >80% similar to sent message (likely echo with minor formatting diff)
              if (sentMsg && t.length > 20 && (t.includes(sentMsg) || sentMsg === t.substring(0, sentMsg.length))) return false;
              // Strip known suffixes before checking (Qwen appends skip button text)
              var suffixes = ['건너뛰기', 'skip'];
              for (var s = 0; s < suffixes.length; s++) {
                if (tLower.length > suffixes[s].length && tLower.lastIndexOf(suffixes[s]) === tLower.length - suffixes[s].length) {
                  t = t.substring(0, t.length - suffixes[s].length).trim();
                  tLower = t.toLowerCase();
                }
              }
              // Reject known loading/placeholder texts (case-insensitive)
              var placeholders = ['...', '…', '생각 중...', '생각 중', '생각이 끝났습니다',
                '조금만 더 기다려 주세요', '조금만 더 기다려 주세요.',
                '응답을 준비 중입니다. 잠시만 기다려 주세요.', '응답을 준비 중입니다.', '잠시만 기다려 주세요.',
                'copilot 메시지', 'copilot message',
                'thinking', 'thinking...', 'loading', 'loading...', 'generating', 'generating...'];
              if (placeholders.indexOf(tLower) >= 0) return false;
              // Reject by prefix (loading/preparing messages)
              var prefixes = ['응답을 준비', 'generating response'];
              for (var p = 0; p < prefixes.length; p++) {
                if (tLower.indexOf(prefixes[p].toLowerCase()) === 0) return false;
              }
              // Reject very short text (likely placeholder dots or single chars)
              if (t.length < 2) return false;
              return true;
            }

            // Helper: clean container text (strip common UI noise like button labels, timestamps)
            function cleanContainerText(txt) {
              if (!txt) return '';
              // Remove common UI text patterns appended by buttons
              return txt.replace(/\s*(Copied|Copy|복사|복사됨|공유|Share)\s*$/gi, '')
                        .replace(/\s*(오전|오후)\s+\d{1,2}:\d{2}\s*$/g, '') // Korean timestamps
                        .replace(/\s*\d+\.\d+초\s*$/g, '') // Duration indicators
                        .replace(/\s*(건너뛰기|skip)\s*$/gi, '') // Qwen skip button text
                        .trim();
            }

            // Step 1: Check streaming indicators
            var isStreaming = false;
            var streamSels = ${streamSel}.split(',').map(function(s) { return s.trim(); });
            for (var i = 0; i < streamSels.length; i++) {
              try { if (document.querySelector(streamSels[i])) { isStreaming = true; break; } } catch(e) {}
            }

            // Step 2: Try to extract response text (even if streaming — for stabilization)
            var candidateText = '';
            var candidateStrategy = '';

            var contSels = ${respContSel}.split(',').map(function(s) { return s.trim(); });
            var allContainers = [];
            for (var i = 0; i < contSels.length; i++) {
              try {
                var found = document.querySelectorAll(contSels[i]);
                for (var j = 0; j < found.length; j++) allContainers.push(found[j]);
              } catch(e) {}
            }

            // Find NEW containers (without baseline marker — immune to content-visibility count fluctuations)
            var newContainers = [];
            for (var nc = 0; nc < allContainers.length; nc++) {
              if (!allContainers[nc].hasAttribute('data-dlb-baseline')) newContainers.push(allContainers[nc]);
            }
            if (newContainers.length > 0) {
              var last = newContainers[newContainers.length - 1];
              // Scroll into view to force content-visibility rendering
              try { last.scrollIntoView({ block: 'end' }); } catch(e) {}
              var respSels = ${respSel}.split(',').map(function(s) { return s.trim(); });
              for (var i = 0; i < respSels.length; i++) {
                try {
                  var content = last.querySelector(respSels[i]);
                  var txt = content ? (content.textContent || content.innerText || '') : '';
                  if (isResponse(txt)) {
                    candidateText = txt;
                    candidateStrategy = 'container';
                    break;
                  }
                } catch(e) {}
              }
              if (!candidateText) {
                var rawTxt = cleanContainerText(last.textContent);
                if (isResponse(rawTxt)) {
                  candidateText = rawTxt;
                  candidateStrategy = 'container-text';
                }
              }
            }

            // Step 3: Fallback — try responseSelector directly (after 3s)
            if (!candidateText && ${elapsed} >= 3000) {
              var respSels2 = ${respSel}.split(',').map(function(s) { return s.trim(); });
              var allDirect = [];
              for (var i = 0; i < respSels2.length; i++) {
                try {
                  var found = document.querySelectorAll(respSels2[i]);
                  for (var j = 0; j < found.length; j++) allDirect.push(found[j]);
                } catch(e) {}
              }
              // Filter to elements NOT inside a baseline-marked container
              var newDirect = [];
              for (var d = 0; d < allDirect.length; d++) {
                if (!allDirect[d].closest('[data-dlb-baseline]')) newDirect.push(allDirect[d]);
              }
              for (var k = newDirect.length - 1; k >= 0; k--) {
                var txt = newDirect[k].textContent?.trim();
                if (isResponse(txt)) {
                  candidateText = txt;
                  candidateStrategy = 'direct';
                  break;
                }
              }
            }

            // If not streaming and we have text, done
            if (!isStreaming && candidateText) {
              return { streaming: false, text: candidateText, strategy: candidateStrategy };
            }
            // Return streaming status + candidate text for stabilization tracking
            return { streaming: true, candidateText: candidateText || '' };
          })()
        `);

        // Unified text tracking: always verify text stability before returning
        // (prevents premature capture when streaming indicators are unreliable)
        const currentText = (status.data?.text || status.data?.candidateText || '').trim();
        const isCurrentlyStreaming = !!(status.data?.streaming);

        if (currentText) {
          if (currentText === lastSeenText) {
            stableCount++;
            // Non-streaming: require 2 stable polls (1s) for fast return
            // Streaming: require full stabilizationThreshold for thorough check
            const effectiveThreshold = isCurrentlyStreaming ? stabilizationThreshold : Math.min(2, stabilizationThreshold);
            if (stableCount >= effectiveThreshold && elapsed >= stabilizationMinWaitMs) {
              return makeResult(true, {
                turnId,
                response: currentText,
                elapsedMs: Date.now() - startTime,
                strategy: isCurrentlyStreaming ? 'stabilized' : (status.data?.strategy || 'non-streaming'),
              });
            }
          } else {
            lastSeenText = currentText;
            stableCount = 0;
          }
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

  async switchModel(sessionId, modelName) {
    const binding = this.bindings.get(sessionId);
    if (!binding) {
      return makeResult(false, null, { code: "BIND_FAILED", message: "No binding for session. Call attach() first." });
    }

    const modelSel = binding.modelSelector;
    if (!modelSel) {
      return makeResult(true, { skipped: true, reason: "No model selector config for this provider" });
    }

    const triggerSel = JSON.stringify(modelSel.trigger);
    const optionSel = JSON.stringify(modelSel.optionSelector || "[role='option'], [role='menuitem'], li");
    const escapedModel = JSON.stringify(modelName.toLowerCase());

    try {
      const result = await this._cdpEvaluate(binding, `
        (function() {
          var trigger = document.querySelector(${triggerSel});
          if (!trigger) return { ok: false, error: 'TRIGGER_NOT_FOUND' };
          trigger.click();

          return new Promise(function(resolve) {
            setTimeout(function() {
              var optSels = ${optionSel}.split(',').map(function(s) { return s.trim(); });
              var allOptions = [];
              for (var i = 0; i < optSels.length; i++) {
                try {
                  var found = document.querySelectorAll(optSels[i]);
                  for (var j = 0; j < found.length; j++) allOptions.push(found[j]);
                } catch(e) {}
              }

              var target = null;
              for (var k = 0; k < allOptions.length; k++) {
                var text = (allOptions[k].textContent || '').toLowerCase().trim();
                if (text.indexOf(${escapedModel}) >= 0) {
                  target = allOptions[k];
                  break;
                }
              }

              if (!target) {
                resolve({ ok: false, error: 'MODEL_OPTION_NOT_FOUND', searched: allOptions.length });
                return;
              }

              target.click();

              setTimeout(function() {
                resolve({ ok: true, matched: target.textContent.trim() });
              }, 200);
            }, 300);
          });
        })()
      `);

      if (!result.ok || (result.data && result.data.ok === false)) {
        var errData = result.data || {};
        return makeResult(false, null, {
          code: "DOM_CHANGED",
          message: errData.error || "Model switch failed",
          detail: errData,
        });
      }

      return makeResult(true, { modelName, matched: result.data?.matched });
    } catch (err) {
      return this._classifyError(err);
    }
  }

  async checkLogin(sessionId) {
    const binding = this.bindings.get(sessionId);
    if (!binding) return null;

    try {
      const inputSel = JSON.stringify(binding.selectors.inputSelector);
      const result = await this._cdpEvaluate(binding, `
        (function() {
          var url = location.href.toLowerCase();

          // Check for login/auth URL patterns
          var loginUrlPatterns = ['/login', '/signin', '/sign-in', '/auth', '/oauth', '/sso', '/accounts'];
          var isLoginUrl = loginUrlPatterns.some(function(p) { return url.indexOf(p) >= 0; });

          // Check for login form indicators
          var hasPasswordField = !!document.querySelector('input[type="password"]');
          var loginTexts = ['sign in', 'log in', 'login', '로그인', '登录', 'continue with google', 'continue with email'];
          var bodyText = document.body ? document.body.textContent.substring(0, 2000).toLowerCase() : '';
          var hasLoginText = loginTexts.some(function(t) { return bodyText.indexOf(t) >= 0; }) && hasPasswordField;

          // Check if chat input exists (logged-in indicator)
          var inputSels = ${inputSel}.split(',').map(function(s) { return s.trim(); });
          var hasInput = false;
          for (var i = 0; i < inputSels.length; i++) {
            if (document.querySelector(inputSels[i])) { hasInput = true; break; }
          }

          if (hasInput) return { loggedIn: true };
          if (isLoginUrl) return { loggedIn: false, reason: 'login_page_url', url: url.substring(0, 100) };
          if (hasPasswordField && hasLoginText) return { loggedIn: false, reason: 'login_form_detected', url: url.substring(0, 100) };
          if (!hasInput && document.readyState === 'complete') {
            return { loggedIn: false, reason: 'no_chat_input_found', url: url.substring(0, 100) };
          }
          return { loggedIn: true };
        })()
      `);
      return result.data;
    } catch {
      return null;
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

    const ws = await this._getConnection(binding.wsUrl);
    const id = ++this._cmdId;

    return new Promise((resolve, reject) => {
      let cleanup;
      
      const timeout = setTimeout(() => {
        if (cleanup) cleanup();
        reject(Object.assign(new Error(`CDP command timeout: ${method}`), { code: "TIMEOUT" }));
      }, 15000);

      const handleMessage = (event) => {
        try {
          const data = JSON.parse(typeof event === "string" ? event : event.data);
          if (data.id === id) {
            clearTimeout(timeout);
            if (cleanup) cleanup();

            if (data.error) {
              reject(Object.assign(new Error(data.error.message), { code: "SEND_FAILED" }));
            } else {
              resolve(data.result);
            }
          }
        } catch { /* parse error */ }
      };

      cleanup = () => {
        if (ws.removeEventListener) ws.removeEventListener("message", handleMessage);
        else if (ws.off) ws.off("message", handleMessage);
        else if (ws.onmessage === handleMessage) ws.onmessage = null;
      };

      if (ws.addEventListener) ws.addEventListener("message", handleMessage);
      else if (ws.on) ws.on("message", handleMessage);
      else ws.onmessage = handleMessage;

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

  async switchModel(sessionId, modelName) {
    return this.adapter.switchModel(sessionId, modelName);
  }

  async checkLogin(sessionId) {
    return this.adapter.checkLogin(sessionId);
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
