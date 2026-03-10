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
 *   6. Installs skill file (~/.claude/skills/deliberation-gate/SKILL.md)
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
const SKILL_SRC = path.join(__dirname, "skills", "deliberation-gate", "SKILL.md");
const SKILL_DEST_DIR = path.join(HOME, ".claude", "skills", "deliberation-gate");
const SKILL_DEST = path.join(SKILL_DEST_DIR, "SKILL.md");
const MANIFEST_PATH = path.join(INSTALL_DIR, ".install-manifest.json");

/** Normalize path to forward slashes for JSON config (Windows backslash → forward slash) */
function toForwardSlash(p) {
  return p.replace(/\\/g, "/");
}

const FILES_TO_COPY = [
  "index.js",
  "observer.js",
  "clipboard.js",
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
  console.log("\n🎯 Deliberation MCP Server — Installation started\n");

  // Step 1: Create install directory
  log("📁 Creating install directory...");
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  log(`   → ${INSTALL_DIR}`);

  // Step 2: Copy files
  log("📦 Copying server files...");
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
  log(`   → ${copied} item(s) copied`);

  // Step 3: Install dependencies
  log("📥 Installing dependencies...");
  try {
    execSync("npm install --production --no-audit --no-fund", {
      cwd: INSTALL_DIR,
      stdio: "pipe",
    });
    log("   → npm install complete");
  } catch (err) {
    log(`   ⚠️ npm install failed: ${err.message}`);
    log("   Manual fix: cd ~/.local/lib/mcp-deliberation && npm install");
  }

  // Step 4: Register MCP server
  log("🔧 Registering Claude Code MCP server...");
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
    ? "   → Existing registration updated"
    : "   → Registered successfully");

  // Step 5: Register Gemini CLI MCP server
  log("🔧 Registering Gemini CLI MCP server...");
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
    ? "   → Gemini CLI existing registration updated"
    : "   → Gemini CLI registered successfully");

  // Step 6: Make session-monitor.sh executable
  const monitorScript = path.join(INSTALL_DIR, "session-monitor.sh");
  if (fs.existsSync(monitorScript)) {
    try {
      fs.chmodSync(monitorScript, 0o755);
    } catch { /* ignore on Windows */ }
  }

  // Step 6b: Preserve existing config
  const configPath = path.join(INSTALL_DIR, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
  }

  // Step 7: Deploy deliberation-gate skill
  log("🎓 Installing deliberation-gate skill file...");
  if (!fs.existsSync(SKILL_SRC)) {
    log("   ⚠️ Skill source file not found, skipping: " + SKILL_SRC);
  } else {
    try {
      fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
      let shouldCopy = true;
      if (fs.existsSync(SKILL_DEST) && !FORCE) {
        const existing = fs.readFileSync(SKILL_DEST, "utf-8");
        const incoming = fs.readFileSync(SKILL_SRC, "utf-8");
        if (existing === incoming) {
          log("   → Already up to date, skipping");
          shouldCopy = false;
        } else {
          fs.copyFileSync(SKILL_DEST, SKILL_DEST + ".backup");
          log("   → Existing file backed up: SKILL.md.backup");
        }
      }
      if (shouldCopy) {
        fs.copyFileSync(SKILL_SRC, SKILL_DEST);
        log("   → " + SKILL_DEST);
      }
    } catch (err) {
      log(`   ⚠️ Skill installation failed: ${err.message}`);
    }
  }

  // Write install manifest
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
    const manifest = {
      version: pkg.version,
      installedAt: new Date().toISOString(),
      skills: [SKILL_DEST],
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch (err) {
    log(`   ⚠️ Failed to write manifest: ${err.message}`);
  }

  // Done
  console.log("\n✅ Installation complete!\n");
  console.log("  Next steps:");
  console.log("  1. Restart your Claude Code or Gemini CLI session");
  console.log("  2. Call deliberation_start(topic: \"...\") to start a deliberation");
  console.log("  3. On first use, the onboarding wizard will guide you through initial setup\n");
}

// Entry point
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Deliberation MCP Server Installer

Usage:
  npx @dmsdc-ai/aigentry-deliberation install
  node install.js

Options:
  --help, -h     Show this help message
  --uninstall    Remove the server
  --force        Overwrite existing skill file without comparison

Features:
  - Copies server files to install directory
  - Installs npm dependencies
  - Registers MCP server in Claude Code / Gemini CLI
  - Installs skill file (~/.claude/skills/deliberation-gate/SKILL.md)

Install path: ${INSTALL_DIR}
MCP config:   ${MCP_CONFIG}
Gemini:       ${GEMINI_CONFIG}
Skill path:   ${SKILL_DEST}
`);
} else if (args.includes("--uninstall") || args.includes("uninstall")) {
  console.log("\n🗑️ Deliberation MCP Server — Uninstalling\n");

  // Remove from Claude MCP config
  if (fs.existsSync(MCP_CONFIG)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf-8"));
      if (mcpConfig.mcpServers?.deliberation) {
        delete mcpConfig.mcpServers.deliberation;
        fs.writeFileSync(MCP_CONFIG, JSON.stringify(mcpConfig, null, 2));
        log("Claude Code MCP server unregistered");
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
        log("Gemini CLI MCP server unregistered");
      }
    } catch { /* ignore */ }
  }

  // Remove skill files tracked by manifest (or fall back to default path)
  let skillsToRemove = [SKILL_DEST];
  const manifestFile = path.join(INSTALL_DIR, ".install-manifest.json");
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      if (Array.isArray(manifest.skills) && manifest.skills.length > 0) {
        skillsToRemove = manifest.skills;
      }
    } catch { /* use default */ }
  }
  for (const skillPath of skillsToRemove) {
    if (fs.existsSync(skillPath)) {
      try {
        fs.rmSync(skillPath, { force: true });
        log(`Skill file removed: ${skillPath}`);
        const backupPath = skillPath + ".backup";
        if (fs.existsSync(backupPath)) {
          log(`  💡 Backup file remains: ${backupPath}`);
          log(`     To restore: cp "${backupPath}" "${skillPath}"`);
        }
        // Remove directory if empty
        const dir = path.dirname(skillPath);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
          log(`Empty skill directory removed: ${dir}`);
        }
      } catch (err) {
        log(`  ⚠️ Failed to remove skill file: ${err.message}`);
      }
    }
  }

  // Remove install directory
  if (fs.existsSync(INSTALL_DIR)) {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    log("Install directory removed");
  }

  console.log("\n✅ Uninstall complete. Please restart Claude Code / Gemini CLI.\n");
} else {
  install();
}
