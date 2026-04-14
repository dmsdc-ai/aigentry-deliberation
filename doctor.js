#!/usr/bin/env node

/**
 * MCP Connection Doctor — aigentry-deliberation
 *
 * Triages MCP connection failures across all registered CLI environments:
 *   - ~/.codex/config.toml   (Codex CLI)
 *   - ~/.claude/.mcp.json    (Claude Code)
 *   - ~/.gemini/settings.json (Gemini CLI)
 *
 * Checks:
 *   1. Path existence for every mcp_servers.* entry
 *   2. Temp-path detection (/var/folders, /tmp, /_npx)
 *   3. MODULE_NOT_FOUND traces in logs
 *
 * Usage:
 *   node doctor.js
 *   npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-doctor
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const IS_WIN = process.platform === "win32";

// ── Config file locations ──────────────────────────────────────

const CONFIGS = [
  {
    name: "Codex CLI",
    path: path.join(HOME, ".codex", "config.toml"),
    format: "toml",
  },
  {
    name: "Claude Code",
    path: path.join(HOME, ".claude", ".mcp.json"),
    format: "json",
  },
  {
    name: "Gemini CLI",
    path: path.join(HOME, ".gemini", "settings.json"),
    format: "json",
  },
];

// Temp path patterns that indicate npx/ephemeral installs
const TEMP_PATTERNS = [
  /[/\\]_npx[/\\]/,
  /[/\\]\.npm[/\\]_npx[/\\]/,
  /^\/var\/folders\//,
  /^\/tmp\//,
  /^\/private\/var\/folders\//,
  /[/\\]Temp[/\\]/i,
  /^C:\\Users\\[^\\]+\\AppData\\Local\\Temp\\/i,
];

// Log locations to scan for MODULE_NOT_FOUND
const LOG_LOCATIONS = [
  path.join(HOME, ".codex", "log"),
  path.join(HOME, ".local", "lib", "mcp-deliberation", "runtime.log"),
];

// Runtime log size-check thresholds (env-configurable).
// Doctor DIAGNOSES only — it never mutates log files.
const LOG_SIZE_WARN_MB = Number(process.env.DELIBERATION_LOG_SIZE_WARN_MB) > 0
  ? Number(process.env.DELIBERATION_LOG_SIZE_WARN_MB)
  : 50;
const LOG_SIZE_ERROR_MB = Number(process.env.DELIBERATION_LOG_SIZE_ERROR_MB) > 0
  ? Number(process.env.DELIBERATION_LOG_SIZE_ERROR_MB)
  : 500;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "? B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Inspect ~/.local/lib/mcp-deliberation/ for runtime.log* files and report on
 * total footprint. Returns { level, totalBytes, topFiles } without mutating
 * anything (doctor is diagnostic-only).
 */
function checkRuntimeLogFootprint(installDir) {
  const result = { level: "ok", totalBytes: 0, topFiles: [], dir: installDir };
  try {
    if (!fs.existsSync(installDir)) return result;
    const entries = [];
    for (const name of fs.readdirSync(installDir)) {
      if (!/^runtime\.log(\.|$)/.test(name)) continue;
      const p = path.join(installDir, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        entries.push({ path: p, size: st.size });
        result.totalBytes += st.size;
      } catch { /* skip */ }
    }
    entries.sort((a, b) => b.size - a.size);
    result.topFiles = entries.slice(0, 3);
    if (result.totalBytes >= LOG_SIZE_ERROR_MB * 1024 * 1024) {
      result.level = "error";
    } else if (result.totalBytes >= LOG_SIZE_WARN_MB * 1024 * 1024) {
      result.level = "warn";
    }
  } catch { /* ignore */ }
  return result;
}

// ── TOML parser (minimal, mcp_servers only) ────────────────────

function parseMcpServersFromToml(content) {
  const servers = {};
  const lines = content.split("\n");
  let currentServer = null;

  for (const raw of lines) {
    const line = raw.trim();

    // Match [mcp_servers.NAME] or [mcp_servers.NAME.env]
    const sectionMatch = line.match(/^\[mcp_servers\.([^\].]+)\]$/);
    if (sectionMatch) {
      currentServer = sectionMatch[1];
      if (!servers[currentServer]) {
        servers[currentServer] = { command: null, args: [] };
      }
      continue;
    }

    // Skip sub-sections like [mcp_servers.NAME.env]
    if (/^\[/.test(line)) {
      if (!/^\[mcp_servers\./.test(line)) currentServer = null;
      continue;
    }

    if (!currentServer) continue;

    // command = "node"
    const cmdMatch = line.match(/^command\s*=\s*"([^"]+)"/);
    if (cmdMatch) {
      servers[currentServer].command = cmdMatch[1];
      continue;
    }

    // args = ["path1", "path2"]
    const argsMatch = line.match(/^args\s*=\s*\[([^\]]*)\]/);
    if (argsMatch) {
      servers[currentServer].args = argsMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    }
  }

  return servers;
}

// ── JSON parser ────────────────────────────────────────────────

function parseMcpServersFromJson(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed.mcpServers || {};
  } catch {
    return null; // parse error
  }
}

// ── Path resolution ────────────────────────────────────────────

function resolveServerPaths(server) {
  const paths = [];

  // Extract paths from args
  if (Array.isArray(server.args)) {
    for (const arg of server.args) {
      // Skip flags and short args
      if (arg.startsWith("-") || arg.startsWith("@")) continue;
      // Skip bare package names (no path separator)
      if (!arg.includes("/") && !arg.includes("\\")) continue;
      // Expand ~
      const resolved = arg.startsWith("~")
        ? path.join(HOME, arg.slice(1))
        : arg;
      paths.push(resolved);
    }
  }

  return paths;
}

// ── Checks ─────────────────────────────────────────────────────

function checkPathExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isTempPath(p) {
  return TEMP_PATTERNS.some((re) => re.test(p));
}

function isNpxCommand(server) {
  return server.command === "npx";
}

function scanLogsForModuleNotFound(logPaths, limit = 50) {
  const findings = [];

  for (const logPath of logPaths) {
    if (!fs.existsSync(logPath)) continue;

    // For directories, scan recent files
    const stat = fs.statSync(logPath);
    const files = stat.isDirectory()
      ? fs
          .readdirSync(logPath)
          .filter((f) => f.endsWith(".log") || f.endsWith(".txt") || f.endsWith(".jsonl"))
          .map((f) => path.join(logPath, f))
      : [logPath];

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");
        // Scan last N lines for "Cannot find module" (the actionable line)
        // Skip bare "code: 'MODULE_NOT_FOUND'" lines — they duplicate the real error
        const recent = lines.slice(-limit);
        for (const line of recent) {
          const cfm = line.match(/Cannot find module '([^']+)'/);
          if (cfm) {
            findings.push({
              file: path.basename(file),
              module: cfm[1],
              line: line.trim().slice(0, 200),
            });
          }
        }
      } catch {
        /* skip unreadable files */
      }
    }
  }

  return findings;
}

// ── Fix suggestions ────────────────────────────────────────────

function suggestFix(serverName, server, issue) {
  switch (issue) {
    case "path_missing":
      if (serverName === "deliberation" || serverName === "mcp-deliberation") {
        return `npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install`;
      }
      if (serverName.includes("brain") || serverName.includes("aigentry-brain")) {
        return `npx @dmsdc-ai/aigentry-brain install`;
      }
      if (isNpxCommand(server)) {
        const pkg = (server.args || []).find((a) => a.startsWith("@") || !a.startsWith("-"));
        return pkg ? `npx -y ${pkg}  # npx server will be installed automatically` : null;
      }
      return `# ${serverName}: install the server file to the correct path`;

    case "temp_path": {
      const tempArg = (server.args || []).find((a) => isTempPath(a));
      if (serverName === "deliberation" || serverName === "mcp-deliberation") {
        return `npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install  # reinstall to permanent path`;
      }
      if (serverName.includes("brain") || serverName.includes("aigentry-brain")) {
        return `npx @dmsdc-ai/aigentry-brain install  # reinstall to permanent path`;
      }
      return `# ${serverName}: temporary path (${tempArg}) → change to permanent path`;
    }

    case "module_not_found":
      if (isNpxCommand(server)) {
        const pkg = (server.args || []).find((a) => a.startsWith("@") || !a.startsWith("-"));
        return pkg ? `npm install -g ${pkg}` : `# ${serverName}: install the package globally`;
      }
      return `cd $(dirname "${(server.args || [])[0] || ""}") && npm install`;

    default:
      return null;
  }
}

// ── Main diagnostic ────────────────────────────────────────────

function runDiagnostics() {
  console.log("\n🩺 MCP Connection Doctor — aigentry-deliberation\n");
  console.log("━".repeat(60));

  let totalServers = 0;
  let totalIssues = 0;
  const allIssues = [];

  // ── Phase 1: Config file scanning ──

  for (const cfg of CONFIGS) {
    console.log(`\n📋 ${cfg.name}: ${cfg.path}`);

    if (!fs.existsSync(cfg.path)) {
      console.log("   ⚠️  Config file not found (skipping)");
      continue;
    }

    const content = fs.readFileSync(cfg.path, "utf-8");
    let servers;

    if (cfg.format === "toml") {
      servers = parseMcpServersFromToml(content);
    } else {
      servers = parseMcpServersFromJson(content);
      if (servers === null) {
        console.log("   ❌ JSON parsing failed");
        totalIssues++;
        allIssues.push({
          config: cfg.name,
          server: "(all)",
          issue: "JSON parsing failed",
          fix: `# Check the JSON syntax in ${cfg.path}`,
        });
        continue;
      }
    }

    const serverEntries = Object.entries(servers);
    if (serverEntries.length === 0) {
      console.log("   (no registered MCP servers)");
      continue;
    }

    for (const [name, server] of serverEntries) {
      totalServers++;
      const issues = [];
      const filePaths = resolveServerPaths(server);

      // Check 1: npx command (volatile but expected)
      if (isNpxCommand(server)) {
        console.log(`   ✅ ${name}: npx (auto-install)`);
        continue;
      }

      // Check paths: temp path (root cause) takes priority over missing
      for (const p of filePaths) {
        if (isTempPath(p)) {
          issues.push({ type: "temp_path", detail: p });
        } else if (!checkPathExists(p)) {
          issues.push({ type: "path_missing", detail: p });
        }
      }

      if (issues.length === 0) {
        console.log(`   ✅ ${name}: OK`);
      } else {
        for (const issue of issues) {
          totalIssues++;
          const fix = suggestFix(name, server, issue.type);
          const label =
            issue.type === "path_missing"
              ? "❌ Path not found"
              : "⚠️  Temporary path";
          console.log(`   ${label}: ${name}`);
          console.log(`      path: ${issue.detail}`);
          if (fix) console.log(`      fix: ${fix}`);
          allIssues.push({
            config: cfg.name,
            server: name,
            issue: issue.type === "path_missing" ? "Path not found" : "Temporary path",
            path: issue.detail,
            fix,
          });
        }
      }
    }
  }

  // ── Phase 2: MODULE_NOT_FOUND log scan ──

  console.log(`\n📜 Log scan (MODULE_NOT_FOUND)`);
  const moduleFindings = scanLogsForModuleNotFound(LOG_LOCATIONS);

  if (moduleFindings.length === 0) {
    console.log("   ✅ No MODULE_NOT_FOUND traces found");
  } else {
    // Deduplicate by module path
    const seen = new Set();
    for (const f of moduleFindings) {
      if (seen.has(f.module)) continue;
      seen.add(f.module);
      totalIssues++;
      console.log(`   ❌ ${f.file}: Cannot find module '${f.module}'`);

      // Generate smart fix based on module path
      let fix;
      const mod = f.module;
      if (isTempPath(mod)) {
        if (mod.includes("aigentry-brain") || mod.includes("brain")) {
          fix = `npx @dmsdc-ai/aigentry-brain install  # temporary path → reinstall to permanent path`;
        } else if (mod.includes("deliberation") || mod.includes("mcp-deliberation")) {
          fix = `npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install  # temporary path -> reinstall to permanent path`;
        } else {
          fix = `# temporary path (${mod}) — change to permanent path in MCP config`;
        }
      } else {
        fix = `# ${mod} file does not exist — reinstall the MCP server`;
      }

      console.log(`      fix: ${fix}`);
      allIssues.push({ config: "logs", server: mod, issue: "MODULE_NOT_FOUND", fix });
    }
  }

  // ── Phase 3: deliberation self-check ──

  console.log(`\n🔍 deliberation self-check`);
  const installDir = IS_WIN
    ? path.join(
        process.env.LOCALAPPDATA ||
          path.join(HOME, "AppData", "Local"),
        "mcp-deliberation"
      )
    : path.join(HOME, ".local", "lib", "mcp-deliberation");

  // Runtime log footprint check — diagnose only, never mutate.
  const logCheck = checkRuntimeLogFootprint(installDir);
  if (logCheck.totalBytes > 0) {
    const sizeStr = formatBytes(logCheck.totalBytes);
    if (logCheck.level === "error") {
      totalIssues++;
      console.log(`   ❌ runtime.log footprint: ${sizeStr} (>= ${LOG_SIZE_ERROR_MB} MB ERROR threshold)`);
    } else if (logCheck.level === "warn") {
      totalIssues++;
      console.log(`   ⚠️  runtime.log footprint: ${sizeStr} (>= ${LOG_SIZE_WARN_MB} MB WARN threshold)`);
    } else {
      console.log(`   ✅ runtime.log footprint: ${sizeStr}`);
    }
    if (logCheck.level !== "ok" && logCheck.topFiles.length > 0) {
      console.log(`      top offenders:`);
      for (const f of logCheck.topFiles) {
        console.log(`        - ${formatBytes(f.size).padStart(10)}  ${f.path}`);
      }
      console.log(`      fix: upgrade to v0.0.45+ and let normal rotation / budget enforcement reclaim space. Immediate: rm ${path.join(installDir, 'runtime.log.old')} && : > ${path.join(installDir, 'runtime.log')}`);
      allIssues.push({
        config: "logs",
        server: "runtime.log",
        issue: logCheck.level === "error" ? "log dir >= 500 MB" : "log dir >= 50 MB",
        fix: "upgrade to v0.0.45+ or manual cleanup",
      });
    }
  }

  const selfPath = path.join(installDir, "index.js");
  if (checkPathExists(selfPath)) {
    console.log(`   ✅ Server file: ${selfPath}`);
  } else {
    totalIssues++;
    console.log(`   ❌ Server file not found: ${selfPath}`);
    console.log(`      fix: npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install`);
  }

  // Check node_modules
  const nodeModules = path.join(installDir, "node_modules");
  if (checkPathExists(nodeModules)) {
    console.log(`   ✅ node_modules: installed`);
  } else {
    totalIssues++;
    console.log(`   ❌ node_modules not found`);
    console.log(`      fix: cd ${installDir} && npm install`);
  }

  // Syntax check
  try {
    execSync(`node --check "${selfPath}"`, { stdio: "pipe", timeout: 5000 });
    console.log(`   ✅ Syntax check: passed`);
  } catch {
    totalIssues++;
    console.log(`   ❌ Syntax error detected`);
    console.log(`      fix: npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install`);
  }

  // ── Summary ──

  console.log("\n" + "━".repeat(60));
  if (totalIssues === 0) {
    console.log(`\n✅ All OK — ${totalServers} MCP server(s) checked\n`);
  } else {
    console.log(`\n❌ ${totalIssues} issue(s) found (${totalServers} server(s) checked)\n`);

    if (allIssues.length > 0) {
      console.log("📌 Recovery commands:\n");
      const fixSet = new Set();
      for (const issue of allIssues) {
        if (issue.fix && !fixSet.has(issue.fix)) {
          fixSet.add(issue.fix);
          console.log(`   ${issue.fix}`);
        }
      }
      console.log();
    }
  }

  return totalIssues === 0 ? 0 : 1;
}

// ── Entry point ────────────────────────────────────────────────

const exitCode = runDiagnostics();
process.exit(exitCode);
