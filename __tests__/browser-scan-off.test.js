/**
 * Focused regression for the browser-off product boundary (candidate 09bc0c9).
 *
 * WHY THIS EXISTS: __tests__/helpers/mcp-harness.mjs sets the real product knob
 * DELIBERATION_BROWSER_SCAN_MODE=off, but explicitly declares that whether "off"
 * actually closes every browser path is a PRODUCT fact it does not assert. At
 * baseline aba40501 the off switch gated collectBrowserLlmTabs ONLY: it did NOT
 * gate ensureCdpAvailable(), which spawned a real Chrome and then slept an
 * unconditional 5000ms, nor the residual CDP endpoint probe inside
 * collectSpeakerCandidates. This file is the product-side proof the harness
 * declines to make.
 *
 * ALL EXTERNAL BOUNDARIES ARE INERT. child_process.spawn/execFileSync and the
 * global fetch are replaced with recording stubs that THROW, and HOME is
 * redirected to a per-case directory this file ALLOCATES with mkdtempSync under
 * the output work tree. Cleanup removes only that exact allocated path, so no
 * pre-existing directory can ever be deleted by this test. Nothing here launches
 * a browser, copies a Chrome profile, opens a socket or touches a real profile.
 * The negative controls therefore EXPOSE the ungated path (the boundary is
 * recorded as reached) without ever ACTUATING it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const boundary = vi.hoisted(() => ({
  spawn: [],
  execFileSync: [],
  fetch: [],
  reset() {
    this.spawn.length = 0;
    this.execFileSync.length = 0;
    this.fetch.length = 0;
  },
}));

vi.mock("child_process", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    spawn: (...args) => {
      boundary.spawn.push(args);
      throw new Error("INERT BOUNDARY: child_process.spawn must not be actuated by this test");
    },
    execFileSync: (...args) => {
      boundary.execFileSync.push(args);
      throw new Error("INERT BOUNDARY: child_process.execFileSync must not be actuated by this test");
    },
  };
});

const { ensureCdpAvailable, collectSpeakerCandidates } = await import("../lib/speaker-discovery.js");

const INJECTED_TABS = JSON.stringify([
  { browser: "Google Chrome", title: "Design review thread", url: "https://chatgpt.com/c/abc-123" },
  { browser: "Google Chrome", title: "Spec critique", url: "https://claude.ai/chat/def-456" },
]);

const ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "DELIBERATION_BROWSER_SCAN_MODE",
  "DELIBERATION_BROWSER_TABS_JSON",
  "DELIBERATION_BROWSER_CDP_ENDPOINTS",
  "DELIBERATION_BROWSER_CDP_PORTS",
  "DELIBERATION_CHROME_PROFILE",
];

let savedEnv;
// Per-case directory allocated by mkdtempSync below. Only this exact path is
// removed in afterEach, and only when this file created it.
let ownedHome;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  ownedHome = fs.mkdtempSync(path.join(process.cwd(), ".test-home-browser-scan-off-"));
  process.env.HOME = ownedHome;
  process.env.TMPDIR = ownedHome;
  delete process.env.DELIBERATION_BROWSER_CDP_ENDPOINTS;
  delete process.env.DELIBERATION_CHROME_PROFILE;
  delete process.env.DELIBERATION_BROWSER_TABS_JSON;
  process.env.DELIBERATION_BROWSER_CDP_PORTS = "9222";

  boundary.reset();
  vi.stubGlobal("fetch", (url) => {
    boundary.fetch.push(String(url));
    return Promise.reject(new Error("INERT BOUNDARY: no network request may leave this test"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (ownedHome) {
    fs.rmSync(ownedHome, { recursive: true, force: true });
    ownedHome = undefined;
  }
});

describe("DELIBERATION_BROWSER_SCAN_MODE=off closes the browser boundary before any actuation", () => {
  it("short-circuits ensureCdpAvailable ahead of endpoint resolution, network, profile copy, spawn and sleep", async () => {
    process.env.DELIBERATION_BROWSER_SCAN_MODE = "off";

    const startedAt = Date.now();
    const status = await ensureCdpAvailable();
    const elapsedMs = Date.now() - startedAt;

    expect(status.available).toBe(false);
    expect(String(status.reason)).toMatch(/disabled/i);
    expect(status.launched).toBeUndefined();

    expect(boundary.fetch).toEqual([]);
    expect(boundary.spawn).toEqual([]);
    expect(boundary.execFileSync).toEqual([]);
    expect(fs.existsSync(path.join(ownedHome, ".chrome-cdp"))).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("negative control: with the switch unset the SAME call reaches the network and spawn boundaries", async () => {
    delete process.env.DELIBERATION_BROWSER_SCAN_MODE;

    const status = await ensureCdpAvailable();

    expect(status.available).toBe(false);
    expect(boundary.fetch.length).toBeGreaterThan(0);
    expect(boundary.fetch.some(url => url.includes("/json/list"))).toBe(true);

    if (process.platform === "darwin") {
      expect(boundary.spawn.length).toBe(1);
      expect(String(boundary.spawn[0][0])).toMatch(/Google Chrome/);
      expect(boundary.spawn[0][1]).toContain("--remote-debugging-port=9222");
    }
  });

  it("skips the residual CDP probe in collectSpeakerCandidates and keeps injected browser metadata", async () => {
    process.env.DELIBERATION_BROWSER_SCAN_MODE = "off";
    process.env.DELIBERATION_BROWSER_TABS_JSON = INJECTED_TABS;

    const startedAt = Date.now();
    const { candidates, browserNote } = await collectSpeakerCandidates({
      include_cli: false,
      include_browser: true,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(boundary.fetch).toEqual([]);
    expect(boundary.spawn).toEqual([]);
    expect(boundary.execFileSync).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);

    const detected = candidates.filter(c => c.type === "browser" && !c.auto_registered);
    expect(detected).toHaveLength(2);

    const chatgpt = detected.find(c => c.provider === "chatgpt");
    expect(chatgpt).toBeDefined();
    expect(chatgpt.speaker).toBe("web-chatgpt-1");
    expect(chatgpt.url).toBe("https://chatgpt.com/c/abc-123");
    expect(chatgpt.title).toBe("Design review thread");
    expect(chatgpt.browser).toBe("Google Chrome");

    const claude = detected.find(c => c.provider === "claude");
    expect(claude).toBeDefined();
    expect(claude.url).toBe("https://claude.ai/chat/def-456");

    for (const candidate of detected) {
      expect(candidate.cdp_available).toBeUndefined();
      expect(candidate.cdp_tab_id).toBeUndefined();
      expect(candidate.cdp_ws_url).toBeUndefined();
    }

    const autoRegistered = candidates.filter(c => c.type === "browser" && c.auto_registered);
    expect(autoRegistered.length).toBeGreaterThan(0);
    for (const candidate of autoRegistered) {
      expect(candidate.cdp_available).toBe(false);
    }

    expect(String(browserNote)).toMatch(/tab injection/i);
  });

  it("negative control: with the switch unset collectSpeakerCandidates still resolves and probes CDP endpoints", async () => {
    delete process.env.DELIBERATION_BROWSER_SCAN_MODE;
    process.env.DELIBERATION_BROWSER_TABS_JSON = INJECTED_TABS;

    const { candidates } = await collectSpeakerCandidates({
      include_cli: false,
      include_browser: true,
    });

    expect(boundary.fetch.some(url => url.includes("/json/list"))).toBe(true);

    const detected = candidates.filter(c => c.type === "browser" && !c.auto_registered);
    expect(detected).toHaveLength(2);
  });

  it("off disables scanning without disabling include_browser semantics", async () => {
    process.env.DELIBERATION_BROWSER_SCAN_MODE = "off";

    const withBrowser = await collectSpeakerCandidates({ include_cli: false, include_browser: true });
    const withoutBrowser = await collectSpeakerCandidates({ include_cli: false, include_browser: false });

    expect(withBrowser.candidates.filter(c => c.type === "browser").length).toBeGreaterThan(0);
    expect(withoutBrowser.candidates.filter(c => c.type === "browser")).toHaveLength(0);
    expect(String(withBrowser.browserNote)).toMatch(/disabled/i);

    expect(boundary.fetch).toEqual([]);
    expect(boundary.spawn).toEqual([]);
    expect(boundary.execFileSync).toEqual([]);
  });
});
