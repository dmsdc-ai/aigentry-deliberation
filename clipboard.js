
import { execFileSync, spawnSync } from "child_process";

function commandExistsInPath(command) {
  try {
    const isWin = process.platform === "win32";
    execFileSync(isWin ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveClipboardReader() {
  if (process.platform === "darwin") {
    if (commandExistsInPath("pbpaste")) {
      return { cmd: "pbpaste", args: [] };
    }
    return { cmd: "osascript", args: ["-e", "get the clipboard as «class utf8»"] };
  }
  if (process.platform === "win32") {
    const windowsShell = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"]
      .find(cmd => commandExistsInPath(cmd));
    if (windowsShell) {
      return { cmd: windowsShell, args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] };
    }
  }
  if (commandExistsInPath("wl-paste")) {
    return { cmd: "wl-paste", args: ["-n"] };
  }
  if (commandExistsInPath("xclip")) {
    return { cmd: "xclip", args: ["-selection", "clipboard", "-o"] };
  }
  if (commandExistsInPath("xsel")) {
    return { cmd: "xsel", args: ["--clipboard", "--output"] };
  }
  return null;
}

function resolveClipboardWriter() {
  if (process.platform === "darwin") {
    if (commandExistsInPath("pbcopy")) {
      return { cmd: "pbcopy", args: [] };
    }
    return null;
  }
  if (process.platform === "win32") {
    if (commandExistsInPath("clip.exe") || commandExistsInPath("clip")) {
      return { cmd: "clip", args: [] };
    }
    const windowsShell = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"]
      .find(cmd => commandExistsInPath(cmd));
    if (windowsShell) {
      return { cmd: windowsShell, args: ["-NoProfile", "-Command", "[Console]::In.ReadToEnd() | Set-Clipboard"] };
    }
  }
  if (commandExistsInPath("wl-copy")) {
    return { cmd: "wl-copy", args: [] };
  }
  if (commandExistsInPath("xclip")) {
    return { cmd: "xclip", args: ["-selection", "clipboard"] };
  }
  if (commandExistsInPath("xsel")) {
    return { cmd: "xsel", args: ["--clipboard", "--input"] };
  }
  return null;
}

const COMMON_ENV = {
  LANG: "ko_KR.UTF-8",
  LC_ALL: "ko_KR.UTF-8",
  PATH: process.env.PATH
};

export function readClipboardText() {
  const tool = resolveClipboardReader();
  if (!tool) {
    throw new Error("No supported clipboard read command found (pbpaste/wl-paste/xclip/xsel etc).");
  }
  const res = spawnSync(tool.cmd, tool.args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: COMMON_ENV,
    timeout: 3000,
  });
  
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = res.stderr ? res.stderr.toString() : "Unknown error";
    throw new Error(`Clipboard read failed: ${err}`);
  }
  
  return res.stdout.toString();
}

export function writeClipboardText(text) {
  const tool = resolveClipboardWriter();
  
  // AppleScript fallback logic
  const tryAppleScript = (txt) => {
    if (process.platform !== "darwin") return false;
    try {
      const escaped = txt.replace(/["\\]/g, '\\$&');
      const scriptRes = spawnSync("osascript", ["-e", `set the clipboard to "${escaped}"`], { timeout: 3000 });
      return scriptRes.status === 0;
    } catch {
      return false;
    }
  };

  if (!tool) {
    if (tryAppleScript(text)) return;
    throw new Error("No supported clipboard write command found.");
  }
  
  const res = spawnSync(tool.cmd, tool.args, {
    input: text,
    encoding: "utf-8",
    stdio: ["pipe", "ignore", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 3000,
    env: COMMON_ENV
  });

  if (res.error || res.status !== 0) {
    if (tryAppleScript(text)) return;
    throw res.error || new Error(`Clipboard write failed with status ${res.status}`);
  }
}

/**
 * Capture current clipboard image to a file (macOS only for now)
 * @param {string} targetPath 
 * @returns {boolean} success
 */
export function captureClipboardImage(targetPath) {
  if (process.platform !== "darwin") return false;
  
  // Using osascript to save PNG data from clipboard
  const script = `
    try
      set theFile to (POSIX file "${targetPath}")
      set theImage to the clipboard as «class PNGf»
      set theOpenFile to open for access theFile with write permission
      set eof theOpenFile to 0
      write theImage to theOpenFile
      close access theOpenFile
      return true
    on error
      try
        close access theFile
      end try
      return false
    end try
  `;
  
  const res = spawnSync("osascript", ["-e", script], { timeout: 5000 });
  return res.stdout.toString().trim() === "true";
}

/**
 * Check if clipboard contains an image
 * @returns {boolean}
 */
export function hasClipboardImage() {
  if (process.platform !== "darwin") return false;
  const script = `
    try
      (the clipboard as «class PNGf»)
      return true
    on error
      return false
    end try
  `;
  const res = spawnSync("osascript", ["-e", script], { timeout: 3000 });
  return res.stdout.toString().trim() === "true";
}
