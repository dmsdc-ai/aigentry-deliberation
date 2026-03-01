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
 *   npx @dmsdc-ai/aigentry-deliberation doctor
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
        return `npx @dmsdc-ai/aigentry-deliberation install`;
      }
      if (serverName.includes("brain") || serverName.includes("aigentry-brain")) {
        return `npx @dmsdc-ai/aigentry-brain install`;
      }
      if (isNpxCommand(server)) {
        const pkg = (server.args || []).find((a) => a.startsWith("@") || !a.startsWith("-"));
        return pkg ? `npx -y ${pkg}  # npx 서버는 자동 설치됩니다` : null;
      }
      return `# ${serverName}: 서버 파일을 올바른 경로에 설치하세요`;

    case "temp_path": {
      const tempArg = (server.args || []).find((a) => isTempPath(a));
      if (serverName === "deliberation" || serverName === "mcp-deliberation") {
        return `npx @dmsdc-ai/aigentry-deliberation install  # 영구 경로로 재설치`;
      }
      if (serverName.includes("brain") || serverName.includes("aigentry-brain")) {
        return `npx @dmsdc-ai/aigentry-brain install  # 영구 경로로 재설치`;
      }
      return `# ${serverName}: 임시 경로(${tempArg}) → 영구 경로로 변경 필요`;
    }

    case "module_not_found":
      if (isNpxCommand(server)) {
        const pkg = (server.args || []).find((a) => a.startsWith("@") || !a.startsWith("-"));
        return pkg ? `npm install -g ${pkg}` : `# ${serverName}: 패키지를 전역 설치하세요`;
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
      console.log("   ⚠️  설정 파일 없음 (스킵)");
      continue;
    }

    const content = fs.readFileSync(cfg.path, "utf-8");
    let servers;

    if (cfg.format === "toml") {
      servers = parseMcpServersFromToml(content);
    } else {
      servers = parseMcpServersFromJson(content);
      if (servers === null) {
        console.log("   ❌ JSON 파싱 실패");
        totalIssues++;
        allIssues.push({
          config: cfg.name,
          server: "(전체)",
          issue: "JSON 파싱 실패",
          fix: `# ${cfg.path} 파일의 JSON 문법을 확인하세요`,
        });
        continue;
      }
    }

    const serverEntries = Object.entries(servers);
    if (serverEntries.length === 0) {
      console.log("   (등록된 MCP 서버 없음)");
      continue;
    }

    for (const [name, server] of serverEntries) {
      totalServers++;
      const issues = [];
      const filePaths = resolveServerPaths(server);

      // Check 1: npx command (volatile but expected)
      if (isNpxCommand(server)) {
        console.log(`   ✅ ${name}: npx (자동 설치)`);
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
        console.log(`   ✅ ${name}: 정상`);
      } else {
        for (const issue of issues) {
          totalIssues++;
          const fix = suggestFix(name, server, issue.type);
          const label =
            issue.type === "path_missing"
              ? "❌ 경로 없음"
              : "⚠️  임시 경로";
          console.log(`   ${label}: ${name}`);
          console.log(`      경로: ${issue.detail}`);
          if (fix) console.log(`      복구: ${fix}`);
          allIssues.push({
            config: cfg.name,
            server: name,
            issue: label,
            path: issue.detail,
            fix,
          });
        }
      }
    }
  }

  // ── Phase 2: MODULE_NOT_FOUND log scan ──

  console.log(`\n📜 로그 스캔 (MODULE_NOT_FOUND)`);
  const moduleFindings = scanLogsForModuleNotFound(LOG_LOCATIONS);

  if (moduleFindings.length === 0) {
    console.log("   ✅ MODULE_NOT_FOUND 흔적 없음");
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
          fix = `npx @dmsdc-ai/aigentry-brain install  # 임시 경로 → 영구 설치`;
        } else if (mod.includes("deliberation") || mod.includes("mcp-deliberation")) {
          fix = `npx @dmsdc-ai/aigentry-deliberation install  # 임시 경로 → 영구 설치`;
        } else {
          fix = `# 임시 경로(${mod}) — MCP 설정에서 영구 경로로 변경 필요`;
        }
      } else {
        fix = `# ${mod} 파일이 존재하지 않음 — 해당 MCP 서버 재설치 필요`;
      }

      console.log(`      복구: ${fix}`);
      allIssues.push({ config: "logs", server: mod, issue: "MODULE_NOT_FOUND", fix });
    }
  }

  // ── Phase 3: deliberation self-check ──

  console.log(`\n🔍 deliberation 자체 점검`);
  const installDir = IS_WIN
    ? path.join(
        process.env.LOCALAPPDATA ||
          path.join(HOME, "AppData", "Local"),
        "mcp-deliberation"
      )
    : path.join(HOME, ".local", "lib", "mcp-deliberation");

  const selfPath = path.join(installDir, "index.js");
  if (checkPathExists(selfPath)) {
    console.log(`   ✅ 서버 파일: ${selfPath}`);
  } else {
    totalIssues++;
    console.log(`   ❌ 서버 파일 없음: ${selfPath}`);
    console.log(`      복구: npx @dmsdc-ai/aigentry-deliberation install`);
  }

  // Check node_modules
  const nodeModules = path.join(installDir, "node_modules");
  if (checkPathExists(nodeModules)) {
    console.log(`   ✅ node_modules: 설치됨`);
  } else {
    totalIssues++;
    console.log(`   ❌ node_modules 없음`);
    console.log(`      복구: cd ${installDir} && npm install`);
  }

  // Syntax check
  try {
    execSync(`node --check "${selfPath}"`, { stdio: "pipe", timeout: 5000 });
    console.log(`   ✅ 문법 검증: 통과`);
  } catch {
    totalIssues++;
    console.log(`   ❌ 문법 오류 감지`);
    console.log(`      복구: npx @dmsdc-ai/aigentry-deliberation install`);
  }

  // ── Summary ──

  console.log("\n" + "━".repeat(60));
  if (totalIssues === 0) {
    console.log(`\n✅ 전체 정상 — ${totalServers}개 MCP 서버 점검 완료\n`);
  } else {
    console.log(`\n❌ ${totalIssues}개 문제 발견 (${totalServers}개 서버 점검)\n`);

    if (allIssues.length > 0) {
      console.log("📌 즉시 복구 커맨드:\n");
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
