// dm1172av tester helper — isolated MCP stdio harness.
//
// RELOCATED (dm1172av). This file replaces the out-of-repository
// `../../../helpers/mcp-harness.mjs` that `delegated-selection.test.js` used
// to import. Nothing outside the repository is referenced any more, so the
// suite resolves from a plain checkout.
//
// Owned by the tests: every child handle is spawned here, bounded by an
// explicit timeout, and joined in cleanup(). No installed server is touched;
// the server entry is always the repository-local copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Reused from the ratified discovery fixture, not reimplemented:
//   * buildFixtureEnv — the complete child environment, which deliberately
//     never spreads `process.env`.
//   * joinOwnedChild — the observed-exit / bounded-deadline join. The prior
//     revision of this harness resolved as soon as SIGKILL had been SENT,
//     which authorised `rmSync(homeDir)` while the server might still be
//     alive and writing into it. Sending a signal is not observing an exit.
//   * getFixtureInstallDir — the platform-correct install dir for an owned
//     HOME. This helper used to hardcode the POSIX branch, so on win32 it
//     wrote config.json and read state under `<home>/.local/lib/...` while
//     the server used `<home>/AppData/Local/...`. Re-exported below under the
//     name its importers already use.
import {
  buildFixtureEnv,
  getFixtureInstallDir,
  joinOwnedChild,
} from './cli-discovery-fixture.js';
import { isTrustedPathEntry } from './stub-cli-bin.mjs';

export function getInstallDir(homeDir) {
  return getFixtureInstallDir(homeDir);
}

export function getProjectStateDir(homeDir, project) {
  return path.join(getInstallDir(homeDir), 'state', project);
}

export function getSessionFile(homeDir, project, sessionId) {
  return path.join(getProjectStateDir(homeDir, project), 'sessions', `${sessionId}.json`);
}

export function getSelectionFile(homeDir, project) {
  return path.join(getProjectStateDir(homeDir, project), 'speaker-selection.json');
}

export function getArchiveFiles(homeDir, project) {
  const archiveDir = path.join(getProjectStateDir(homeDir, project), 'archive');
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir).map(name => path.join(archiveDir, name));
}

// The server derives the project slug from its cwd, so tests locate state by
// scanning the isolated HOME rather than hard-coding a slug.
export function listProjectSlugs(homeDir) {
  const base = path.join(getInstallDir(homeDir), 'state');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

export function findSelectionState(homeDir) {
  for (const slug of listProjectSlugs(homeDir)) {
    const file = getSelectionFile(homeDir, slug);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return null;
}

export function findSessions(homeDir) {
  const out = [];
  for (const slug of listProjectSlugs(homeDir)) {
    const dir = path.join(getProjectStateDir(homeDir, slug), 'sessions');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')));
    }
  }
  return out;
}

export function writeSelectionState(homeDir, value) {
  const [slug] = listProjectSlugs(homeDir);
  if (!slug) throw new Error('no project state dir yet — call a tool first');
  writeJson(getSelectionFile(homeDir, slug), value);
  return slug;
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function getText(result) {
  return (result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

// Switches that must hold no matter what a caller merged in. Applied AFTER
// every optional merge, never before, so an `extra` key cannot re-open an
// external boundary by shadowing them.
//
// dt1172ay CORRECTION. The prior revision emitted
// `DELIBERATION_DISABLE_BROWSER=1`, a name no product code reads. It was an
// inert string in the child environment that LOOKED like a browser-off
// guarantee and enforced nothing, while the knob the product does honour —
// `DELIBERATION_BROWSER_SCAN_MODE` — was left UNSET, so the child ran the
// default scan mode. The unsupported name is removed rather than kept beside
// the real one: an env var no code reads is a fake product knob, and leaving
// it in would keep the misleading claim alive inside the harness.
//
// DECLARED LIMIT — do not quote this as "the browser is off".
//
// DATED OBSERVATION, baseline `aba40501` (NOT a permanent invariant):
// at that baseline `..._SCAN_MODE=off` gated `collectBrowserLlmTabs` ONLY and
// did NOT gate `ensureCdpAvailable()`, which is the path the two held
// `include_browser: true` cases reach and which spawned a real Chrome plus an
// unconditional 5000ms sleep. Product candidate `09bc0c9` is reported to add
// BOTH off gates; that candidate is INDEPENDENTLY UNVERIFIED here — this seal
// neither ran nor inspected it, and this harness asserts nothing about it.
//
// What holds regardless of which product revision is in play: this harness
// only guarantees that the knob the product reads is SET to off and cannot be
// re-opened by a caller. Whether "off" actually closes every browser path is a
// PRODUCT fact, verified product-side, not here. Nothing in this file forces
// `include_browser` metadata to false, and no test semantics are changed.
const NO_PROVIDER_SWITCHES = Object.freeze({
  DELIBERATION_BROWSER_SCAN_MODE: 'off',
  DELIBERATION_TELEPTY_DISABLED: '1',
});

/**
 * Fail loudly if the child would inherit any PATH element other than its own
 * owned stub dir and the trusted OS primitives. This is the "no host PATH
 * fallback" claim expressed as an executable check instead of a comment.
 */
function assertInertPath(pathValue, stubDir) {
  const entries = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const foreign = entries.filter(entry => !isTrustedPathEntry(entry, stubDir));
  if (foreign.length > 0) {
    throw new Error(
      `mcp-harness: refusing to spawn with a host PATH fallback. Untrusted PATH `
      + `entries: ${foreign.join(', ')}`
    );
  }
  if (entries[0] !== stubDir) {
    throw new Error(`mcp-harness: owned stub dir must lead PATH, got ${entries[0]}`);
  }
}

/**
 * Inert boundaries. `buildFixtureEnv` names everything the product needs and
 * never spreads `process.env`, so no host PATH, no ambient provider key and no
 * host TMPDIR reaches the child. The no-provider switches are re-applied last.
 */
function inertEnv({ homeDir, stubDir, extra = {} }) {
  const merged = buildFixtureEnv({ homeDir, stubDir, extra });
  const env = { ...merged, ...NO_PROVIDER_SWITCHES };
  assertInertPath(env.PATH, stubDir);
  return env;
}

export async function createHarness({
  serverEntry,
  repoRoot,
  stubDir,
  config = {},
  env = {},
} = {}) {
  if (!serverEntry) throw new Error('createHarness requires a serverEntry');
  if (!stubDir) throw new Error('createHarness requires an owned stubDir');

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1172av-'));
  let child = null;

  // Anything that fails between here and the returned handle must still join
  // whatever was spawned and remove the owned root. Without this, a harness
  // that failed to initialize leaked both a child and a temp tree, and the
  // test that observed the failure could not clean up what it never received.
  //
  // dt1172ay CORRECTION. The prior revision swallowed a `joinOwnedChild`
  // rejection and then ran `rmSync(homeDir)` anyway. A rejection from that
  // helper is precisely the statement "no exit was observed for this handle" —
  // the child may STILL BE ALIVE holding the owned root open. So the
  // catch-and-delete turned the one signal that FORBIDS removal into a
  // removal: the very defect the join exists to prevent, on the init path. It
  // also discarded the join error, leaving the operator with no record that
  // the child had not been reaped.
  //
  // Removal is now authorised by a POSITIVE fact only:
  //   * no child was ever spawned (`child === null`) — nothing can hold the
  //     root open, so remove it; or
  //   * `joinOwnedChild` RESOLVED, which it does only on an observed exit
  //     (`exitCode`/`signalCode` non-null) — so remove it.
  // If the join REJECTS, the root is PRESERVED and BOTH the initialization
  // error and the join error are reported. No deletion, and no false claim of
  // a successful cleanup.
  const abort = async (err) => {
    try {
      await joinOwnedChild(child);
    } catch (joinErr) {
      const combined = new Error(
        `mcp-harness: harness initialization failed AND the owned child could `
        + `not be joined (pid=${child && child.pid}). The owned root is PRESERVED `
        + `at ${homeDir} and was NOT removed: an unjoined child may still be alive `
        + `and writing into it. Remove it by hand once the process is confirmed gone.`
        + `\n  initialization error: ${err && err.message}`
        + `\n  join error: ${joinErr && joinErr.message}`
      );
      combined.cause = err;
      combined.initError = err;
      combined.joinError = joinErr;
      combined.preservedRoot = homeDir;
      combined.rootRemoved = false;
      throw combined;
    }
    // Reached only on a positive observed exit, or with no child ever spawned.
    fs.rmSync(homeDir, { recursive: true, force: true });
    throw err;
  };

  try {
    const installDir = getInstallDir(homeDir);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({
      setup_complete: true,
      require_speaker_selection: true,
      include_browser_speakers: false,
      ...config,
    }, null, 2));

    child = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: inertEnv({ homeDir, stubDir, extra: env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return abort(err);
  }

  const responses = new Map();
  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined) responses.set(parsed.id, parsed);
      } catch {
        // ignore non-JSON lines
      }
    }
  });
  child.stderr.on('data', (data) => { stderrBuffer += data.toString(); });

  const send = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  };

  const waitFor = (id, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for response ${id}\n${stderrBuffer}`));
      }
    }, 25);
  });

  try {
    send(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dm1172av-tester', version: '1.0.0' },
    });
    await waitFor(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } catch (err) {
    return abort(err);
  }

  return {
    homeDir,
    child,
    // Execution identity: the exact entry this handle was spawned with.
    serverEntry,
    stubDir,
    stderr: () => stderrBuffer,
    async listTools(timeoutMs = 15000) {
      const id = Math.floor(Math.random() * 1_000_000);
      send(id, 'tools/list', {});
      const response = await waitFor(id, timeoutMs);
      if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
      return response.result;
    },
    // Returns the raw JSON-RPC envelope so tests can distinguish a protocol
    // error (unknown tool) from a tool-level refusal in the content payload.
    async callToolRaw(name, args, timeoutMs = 15000) {
      const id = Math.floor(Math.random() * 1_000_000);
      send(id, 'tools/call', { name, arguments: args });
      return waitFor(id, timeoutMs);
    },
    async callTool(name, args, timeoutMs = 15000) {
      const response = await this.callToolRaw(name, args, timeoutMs);
      if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
      return response.result;
    },
    // Bounded join on a POSITIVE observed exit, then remove the owned root.
    // joinOwnedChild rejects if no exit was ever observed, so a live server's
    // root is never deleted out from under it.
    async cleanup() {
      await joinOwnedChild(child);
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}
