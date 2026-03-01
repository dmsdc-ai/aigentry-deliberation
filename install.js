#!/usr/bin/env node

/**
 * Deliberation MCP Server — One-click installer
 *
 * Usage:
 *   npx @dmsdc-ai/aigentry-deliberation install
 *   node install.js
 *
 * What it does:
 *   1. Copies server files to ~/.local/lib/mcp-deliberation/
 *   2. Installs npm dependencies
 *   3. Registers MCP server in ~/.claude/.mcp.json (Claude Code)
 *   4. Registers MCP server in ~/.gemini/settings.json (Gemini CLI)
 *   5. Ready to use — next Claude Code or Gemini CLI session will auto-load
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const IS_WIN = process.platform === "win32";
const INSTALL_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "mcp-deliberation")
  : path.join(HOME, ".local", "lib", "mcp-deliberation");
const MCP_CONFIG = path.join(HOME, ".claude", ".mcp.json");
const GEMINI_CONFIG = path.join(HOME, ".gemini", "settings.json");

/** Normalize path to forward slashes for JSON config (Windows backslash → forward slash) */
function toForwardSlash(p) {
  return p.replace(/\\/g, "/");
}

const FILES_TO_COPY = [
  "index.js",
  "observer.js",
  "browser-control-port.js",
  "degradation-state-machine.js",
  "model-router.js",
  "doctor.js",
  "session-monitor.sh",
  "session-monitor-win.js",
  "package.json",
  "package-lock.json",
];

const DIRS_TO_COPY = ["selectors", "public", "skills"];

function log(msg) {
  console.log(`  ${msg}`);
}

function copyFileIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function install() {
  console.log("\n🎯 Deliberation MCP Server — 설치 시작\n");

  // Step 1: Create install directory
  log("📁 설치 디렉토리 생성...");
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  log(`   → ${INSTALL_DIR}`);

  // Step 2: Copy files
  log("📦 서버 파일 복사...");
  let copied = 0;
  for (const file of FILES_TO_COPY) {
    if (copyFileIfExists(path.join(__dirname, file), path.join(INSTALL_DIR, file))) {
      copied++;
    }
  }
  for (const dir of DIRS_TO_COPY) {
    const src = path.join(__dirname, dir);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, path.join(INSTALL_DIR, dir));
      copied++;
    }
  }
  log(`   → ${copied}개 항목 복사 완료`);

  // Step 3: Install dependencies
  log("📥 의존성 설치...");
  try {
    execSync("npm install --production --no-audit --no-fund", {
      cwd: INSTALL_DIR,
      stdio: "pipe",
    });
    log("   → npm install 완료");
  } catch (err) {
    log(`   ⚠️ npm install 실패: ${err.message}`);
    log("   수동 실행: cd ~/.local/lib/mcp-deliberation && npm install");
  }

  // Step 4: Register MCP server
  log("🔧 Claude Code MCP 서버 등록...");
  const claudeDir = path.join(HOME, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  let mcpConfig = {};
  if (fs.existsSync(MCP_CONFIG)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf-8"));
    } catch {
      mcpConfig = {};
    }
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

  const alreadyRegistered = !!mcpConfig.mcpServers.deliberation;
  mcpConfig.mcpServers.deliberation = {
    command: "node",
    args: [toForwardSlash(path.join(INSTALL_DIR, "index.js"))],
  };

  fs.writeFileSync(MCP_CONFIG, JSON.stringify(mcpConfig, null, 2));
  log(alreadyRegistered
    ? "   → 기존 등록 업데이트 완료"
    : "   → 새로 등록 완료");

  // Step 5: Register Gemini CLI MCP server
  log("🔧 Gemini CLI MCP 서버 등록 시도...");
  const geminiDir = path.join(HOME, ".gemini");
  if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });

  let geminiConfig = {};
  if (fs.existsSync(GEMINI_CONFIG)) {
    try {
      geminiConfig = JSON.parse(fs.readFileSync(GEMINI_CONFIG, "utf-8"));
    } catch {
      geminiConfig = {};
    }
  }

  if (!geminiConfig.mcpServers) geminiConfig.mcpServers = {};

  const geminiAlreadyRegistered = !!geminiConfig.mcpServers.deliberation;
  geminiConfig.mcpServers.deliberation = {
    command: "node",
    args: [toForwardSlash(path.join(INSTALL_DIR, "index.js"))],
  };

  fs.writeFileSync(GEMINI_CONFIG, JSON.stringify(geminiConfig, null, 2));
  log(geminiAlreadyRegistered
    ? "   → Gemini CLI 기존 등록 업데이트 완료"
    : "   → Gemini CLI 새로 등록 완료");

  // Step 6: Make session-monitor.sh executable
  const monitorScript = path.join(INSTALL_DIR, "session-monitor.sh");
  if (fs.existsSync(monitorScript)) {
    try {
      fs.chmodSync(monitorScript, 0o755);
    } catch { /* ignore on Windows */ }
  }

  // Step 6: Preserve existing config
  const configPath = path.join(INSTALL_DIR, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
  }

  // Done
  console.log("\n✅ 설치 완료!\n");
  console.log("  다음 단계:");
  console.log("  1. Claude Code 또는 Gemini CLI 세션을 재시작하세요");
  console.log("  2. \"토론 시작해\" 또는 deliberation_start(topic: \"...\") 호출");
  console.log("  3. 첫 사용 시 온보딩 위저드가 기본 설정을 안내합니다\n");
}

// Entry point
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Deliberation MCP Server Installer

Usage:
  npx @dmsdc-ai/aigentry-deliberation install
  node install.js

Options:
  --help, -h     이 도움말 표시
  --uninstall    서버 제거

설치 경로: ${INSTALL_DIR}
MCP 설정:  ${MCP_CONFIG}
Gemini:    ${GEMINI_CONFIG}
`);
} else if (args.includes("--uninstall") || args.includes("uninstall")) {
  console.log("\n🗑️ Deliberation MCP Server 제거\n");

  // Remove from Claude MCP config
  if (fs.existsSync(MCP_CONFIG)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf-8"));
      if (mcpConfig.mcpServers?.deliberation) {
        delete mcpConfig.mcpServers.deliberation;
        fs.writeFileSync(MCP_CONFIG, JSON.stringify(mcpConfig, null, 2));
        log("Claude Code MCP 등록 해제 완료");
      }
    } catch { /* ignore */ }
  }

  // Remove from Gemini CLI config
  if (fs.existsSync(GEMINI_CONFIG)) {
    try {
      const geminiConfig = JSON.parse(fs.readFileSync(GEMINI_CONFIG, "utf-8"));
      if (geminiConfig.mcpServers?.deliberation) {
        delete geminiConfig.mcpServers.deliberation;
        fs.writeFileSync(GEMINI_CONFIG, JSON.stringify(geminiConfig, null, 2));
        log("Gemini CLI MCP 등록 해제 완료");
      }
    } catch { /* ignore */ }
  }

  // Remove install directory
  if (fs.existsSync(INSTALL_DIR)) {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    log("설치 디렉토리 삭제 완료");
  }

  console.log("\n✅ 제거 완료. Claude Code / Gemini CLI를 재시작하세요.\n");
} else {
  install();
}
