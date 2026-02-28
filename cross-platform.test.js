import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const HOME = os.homedir();

// ── Replicate INSTALL_DIR logic from index.js / install.js ──

function resolveInstallDir() {
  if (IS_WIN) {
    return path.join(
      process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"),
      "mcp-deliberation"
    );
  }
  return path.join(HOME, ".local", "lib", "mcp-deliberation");
}

function toForwardSlash(p) {
  return p.replace(/\\/g, "/");
}

// ── Replicate commandExistsInPath from index.js ──

function commandExistsInPath(command) {
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    return false;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("where", [command], { stdio: "ignore" });
      return true;
    } catch {
      // fallback to PATH scan
    }
  }
  const pathVar = process.env.PATH || "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return false;
  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, `${command}${ext}`);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return true;
      } catch { /* continue */ }
    }
  }
  return false;
}

// ── Tests ──

describe("cross-platform: INSTALL_DIR", () => {
  it("resolves to a valid absolute path", () => {
    const dir = resolveInstallDir();
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it("ends with mcp-deliberation", () => {
    const dir = resolveInstallDir();
    expect(path.basename(dir)).toBe("mcp-deliberation");
  });

  it("uses LOCALAPPDATA on Windows, ~/.local/lib on Unix", () => {
    const dir = resolveInstallDir();
    if (IS_WIN) {
      const expectedBase = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
      expect(dir.startsWith(expectedBase)).toBe(true);
    } else {
      expect(dir).toBe(path.join(HOME, ".local", "lib", "mcp-deliberation"));
    }
  });

  it("state and config subpaths resolve correctly", () => {
    const dir = resolveInstallDir();
    const statePath = path.join(dir, "state");
    const configPath = path.join(dir, "config.json");
    const runtimeLog = path.join(dir, "runtime.log");

    expect(path.isAbsolute(statePath)).toBe(true);
    expect(path.isAbsolute(configPath)).toBe(true);
    expect(path.isAbsolute(runtimeLog)).toBe(true);
    expect(configPath.endsWith("config.json")).toBe(true);
  });
});

describe("cross-platform: toForwardSlash", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toForwardSlash("C:\\Users\\test\\file.js")).toBe("C:/Users/test/file.js");
  });

  it("leaves forward slashes unchanged", () => {
    expect(toForwardSlash("/home/user/.local/lib/file.js")).toBe("/home/user/.local/lib/file.js");
  });

  it("handles mixed slashes", () => {
    expect(toForwardSlash("C:\\Users/test\\file.js")).toBe("C:/Users/test/file.js");
  });

  it("handles empty string", () => {
    expect(toForwardSlash("")).toBe("");
  });
});

describe("cross-platform: commandExistsInPath", () => {
  it("finds node (must exist since we are running on Node)", () => {
    expect(commandExistsInPath("node")).toBe(true);
  });

  it("returns false for nonexistent command", () => {
    expect(commandExistsInPath("this-command-does-not-exist-xyz123")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(commandExistsInPath("")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(commandExistsInPath(null)).toBe(false);
    expect(commandExistsInPath(undefined)).toBe(false);
  });

  it("rejects command injection attempts", () => {
    expect(commandExistsInPath("node; echo pwned")).toBe(false);
    expect(commandExistsInPath("node && rm -rf /")).toBe(false);
    expect(commandExistsInPath("$(whoami)")).toBe(false);
  });

  it("finds npm (should exist in CI and dev environments)", () => {
    expect(commandExistsInPath("npm")).toBe(true);
  });
});

describe("cross-platform: MCP config path", () => {
  it("resolves .claude/.mcp.json to absolute path", () => {
    const mcpConfig = path.join(HOME, ".claude", ".mcp.json");
    expect(path.isAbsolute(mcpConfig)).toBe(true);
    expect(mcpConfig.endsWith(path.join(".claude", ".mcp.json"))).toBe(true);
  });

  it("MCP args use forward slashes after toForwardSlash", () => {
    const dir = resolveInstallDir();
    const indexPath = toForwardSlash(path.join(dir, "index.js"));
    // Should never contain backslashes (even on Windows)
    expect(indexPath).not.toContain("\\");
    expect(indexPath.endsWith("/index.js")).toBe(true);
  });
});

describe("cross-platform: source files exist", () => {
  const requiredFiles = [
    "index.js",
    "install.js",
    "observer.js",
    "browser-control-port.js",
    "package.json",
  ];

  for (const file of requiredFiles) {
    it(`${file} exists in project root`, () => {
      const filePath = path.join(__dirname, file);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  }

  it("selectors directory exists", () => {
    expect(fs.existsSync(path.join(__dirname, "selectors"))).toBe(true);
  });

  it("chatgpt.json selector config exists", () => {
    expect(fs.existsSync(path.join(__dirname, "selectors", "chatgpt.json"))).toBe(true);
  });
});

describe("cross-platform: path.delimiter", () => {
  it("uses correct PATH delimiter for current OS", () => {
    if (IS_WIN) {
      expect(path.delimiter).toBe(";");
    } else {
      expect(path.delimiter).toBe(":");
    }
  });

  it("PATH env var can be split into directories", () => {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    expect(dirs.length).toBeGreaterThan(0);
  });
});
