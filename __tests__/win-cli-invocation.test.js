// Windows CLI invocation: command resolution, command-line construction and
// quoting.
//
// On Windows an npm-installed CLI is a `.cmd` shim, which CreateProcess cannot
// run (it appends only `.com`/`.exe` to a bare name, and a batch file is not an
// executable image), so these helpers resolve the shim and run it through the
// command interpreter. Everything they do is a pure function of its inputs —
// `path.win32` throughout, no filesystem, no process.env except where an env
// object is passed in — so the cases below run on EVERY matrix leg, not only on
// windows-latest, which is the only way CI can see a regression in them.
//
// Expectations are written with String.raw so a backslash in a Windows path or
// in a CommandLineToArgvW escape is the literal character.

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  quoteCmdArgument,
  windowsCommandCandidates,
  resolveCommandInterpreter,
  buildWindowsCliInvocation,
  buildCliInvocation,
  cliDispatchRefusal,
  cliDispatchArgs,
  getCliExecArgs,
  getCliHint,
  isApprovedCliCommandName,
  resolveCliProbeCommand,
  checkCliLiveness,
  terminateCliProcess,
  abandonCliProcess,
  buildTreeKillCommand,
  isPermanentCliFailure,
  isWindowsFullyQualifiedPath,
  isWindowsDriveAbsolutePath,
  CLI_INVOCATION_FAILURE_CODES,
  CLI_INVOCATION_HINTS,
} from '../lib/speaker-discovery.js';
import { invokeCliReviewer, isPermanentTurnFailure, boundReviewerStderr } from '../lib/transport.js';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// Command resolution with a known answer on every OS.
//
// The entry-point cases below have to reach a DEADLINE or an OVERFLOW, which
// means the builder must first resolve the command — and on Windows that reads
// the real PATH, so the earlier version of these cases silently depended on
// what the runner had installed: with no `claude` present the builder answered
// `E_CLI_NOT_FOUND` before the injected spawn was ever called, and with an npm
// shim present `viaInterpreter` would have been true where the case said false
// (R5-09, and the Windows CI failure of r5).
//
// So PATH is replaced by a directory containing exactly one CLI for the
// duration of the case. On Windows the fixture is a `.cmd` shim — the shape npm
// installs, and the one the product must run through cmd.exe — so the
// interpreter path is exercised for real and `viaInterpreter` is true by
// construction. On POSIX the bare name is handed to `spawn` without consulting
// PATH at all, so resolution cannot fail there and `viaInterpreter` is false by
// construction; the file is written anyway to keep the two legs symmetric.
// Nothing is ever executed: every case injects its own spawn.
async function withCliFixture(name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-cli-fixture-'));
  const savedPath = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;
  try {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
      // Pin PATHEXT too, so neither the host's PATH nor its PATHEXT takes part.
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    } else {
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = dir;
    return await run({
      dir,
      shimPath: path.join(dir, `${name}.cmd`),
      // What the product will build for this fixture on this OS.
      viaInterpreter: process.platform === 'win32',
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathExt;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A stdio stream that honours setEncoding the way a real one does: a consumer
// that called it receives DECODED STRINGS, one that did not receives Buffers.
// Without that, a test cannot tell raw-byte accounting from decoded-length
// accounting, because every chunk it emits arrives unchanged either way
// (R5-08).
function fakeStdioStream() {
  const stream = new NodeEventEmitter();
  let decoder = null;
  stream.setEncoding = (encoding) => { decoder = new StringDecoder(encoding || 'utf8'); };
  const rawEmit = stream.emit.bind(stream);
  stream.emit = (event, ...args) => {
    if (event === 'data' && decoder) {
      const [chunk] = args;
      return rawEmit(event, decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')));
    }
    return rawEmit(event, ...args);
  };
  return stream;
}

// A child process that is alive and never answers: the only way to reach either
// deadline without starting a real process.
function fakeLiveChild({ withStdio = false } = {}) {
  const child = new NodeEventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.killed = true; return true; };
  if (withStdio) {
    child.stdout = fakeStdioStream();
    child.stderr = fakeStdioStream();
    child.stdin = Object.assign(new NodeEventEmitter(), { write: () => true, end: () => {} });
  }
  return child;
}

const INTERP = String.raw`C:\Windows\System32\cmd.exe`;
const CODEX_SHIM = String.raw`C:\tools\codex.cmd`;
const GEMINI_SHIM = String.raw`C:\tools\gemini.cmd`;
const CLAUDE_SHIM = String.raw`C:\tools\claude.CMD`;

describe('quoteCmdArgument — CommandLineToArgvW rules, then cmd.exe carets', () => {
  it('quotes a plain argument and carets the quotes it added', () => {
    expect(quoteCmdArgument('plain')).toBe(String.raw`^"plain^"`);
  });

  it('escapes a space so the argument stays one token', () => {
    expect(quoteCmdArgument('a b')).toBe(String.raw`^"a^ b^"`);
  });

  it('handles the empty string', () => {
    expect(quoteCmdArgument('')).toBe(String.raw`^"^"`);
  });

  it('escapes an embedded quote for both parsers', () => {
    expect(quoteCmdArgument(String.raw`say "hi"`)).toBe(String.raw`^"say^ \^"hi\^"^"`);
  });

  it('doubles a backslash run that precedes a quote (2n+1 rule)', () => {
    // One backslash + a literal quote must arrive as 3 backslashes + quote.
    expect(quoteCmdArgument(String.raw`a\"b`)).toBe(String.raw`^"a\\\^"b^"`);
  });

  it('doubles a trailing backslash run so it cannot escape the closing quote', () => {
    expect(quoteCmdArgument(String.raw`a\\`)).toBe(String.raw`^"a\\\\^"`);
  });

  it('escapes the command-splitting metacharacters', () => {
    expect(quoteCmdArgument('a&b|c<d>e^f')).toBe(String.raw`^"a^&b^|c^<d^>e^^f^"`);
  });

  it('escapes `=`, a cmd token delimiter', () => {
    expect(quoteCmdArgument('k=v')).toBe(String.raw`^"k^=v^"`);
  });

  it('does NOT pretend a caret neutralises %VAR%, !VAR! or TAB', () => {
    // Percent expansion runs before caret processing and `!` is expanded after
    // it, so these are refused by the builder instead (see the fail-closed
    // cases below). The quoting function must not claim to handle them.
    expect(quoteCmdArgument('%PATH%')).toBe(String.raw`^"%PATH%^"`);
    expect(quoteCmdArgument('!PATH!')).toBe(String.raw`^"!PATH!^"`);
    expect(quoteCmdArgument('a\tb')).toBe('^"a\tb^"');
  });

  it('adds a second caret level for a shim target (the `%*` re-parse)', () => {
    // A .cmd/.bat shim forwards its arguments, which makes cmd.exe parse them a
    // second time after the first pass consumed one caret level.
    expect(quoteCmdArgument('exec', { doubleEscape: true })).toBe(String.raw`^^^"exec^^^"`);
    // First pass leaves `^"a^&b^"`, the shim's re-parse yields `"a&b"`, and the
    // program finally sees `a&b`.
    expect(quoteCmdArgument('a&b', { doubleEscape: true })).toBe(String.raw`^^^"a^^^&b^^^"`);
  });
});

describe('windowsCommandCandidates — PATH × PATHEXT, restricted to what can be run and to fully-qualified entries', () => {
  it('drops a PATH entry that is not fully qualified, because the file stat\'d and the file run would differ', () => {
    // A relative entry is stat'd against the SERVER's cwd here and resolved by
    // the interpreter against the CHILD's cwd, which is caller-supplied
    // (ADR-264 spawn_cwd). A rooted-but-driveless entry resolves against the
    // current drive, which has the same dependency. UNC is fully qualified and
    // stays.
    const candidates = windowsCommandCandidates(
      'claude',
      ['tools', String.raw`C:\a`, String.raw`\rooted`, String.raw`\\srv\share`, '.'].join(path.win32.delimiter),
      '.CMD',
    );
    expect(candidates).toEqual([
      String.raw`C:\a\claude.CMD`,
      String.raw`\\srv\share\claude.CMD`,
    ]);
  });

  it('is directory-major and PATHEXT-minor', () => {
    const candidates = windowsCommandCandidates(
      'claude',
      [String.raw`C:\a`, String.raw`C:\b`].join(path.win32.delimiter),
      '.COM;.EXE;.CMD',
    );
    expect(candidates).toEqual([
      String.raw`C:\a\claude.COM`,
      String.raw`C:\a\claude.EXE`,
      String.raw`C:\a\claude.CMD`,
      String.raw`C:\b\claude.COM`,
      String.raw`C:\b\claude.EXE`,
      String.raw`C:\b\claude.CMD`,
    ]);
  });

  it('skips PATHEXT entries it cannot execute, so a .ps1 sibling cannot shadow the .cmd shim', () => {
    // npm installs `claude`, `claude.cmd` AND `claude.ps1` side by side; a
    // PATHEXT listing .PS1 before .CMD must not hide the shim.
    const candidates = windowsCommandCandidates('claude', String.raw`C:\a`, '.PS1;.CMD');
    expect(candidates).toEqual([String.raw`C:\a\claude.CMD`]);
  });

  it('never considers the extension-less file (npm ships an sh script there)', () => {
    const candidates = windowsCommandCandidates('claude', String.raw`C:\a`, '.CMD');
    expect(candidates).toEqual([String.raw`C:\a\claude.CMD`]);
  });

  it('falls back to the default runnable extensions when PATHEXT is empty or unusable', () => {
    expect(windowsCommandCandidates('claude', String.raw`C:\a`, '')).toEqual([
      String.raw`C:\a\claude.COM`,
      String.raw`C:\a\claude.EXE`,
      String.raw`C:\a\claude.BAT`,
      String.raw`C:\a\claude.CMD`,
    ]);
    expect(windowsCommandCandidates('claude', String.raw`C:\a`, '.PS1;.VBS')).toEqual([
      String.raw`C:\a\claude.COM`,
      String.raw`C:\a\claude.EXE`,
      String.raw`C:\a\claude.BAT`,
      String.raw`C:\a\claude.CMD`,
    ]);
  });

  it('honours an explicit runnable extension and refuses one it cannot run', () => {
    expect(windowsCommandCandidates('claude.cmd', String.raw`C:\a`, '.CMD'))
      .toEqual([String.raw`C:\a\claude.cmd`]);
    expect(windowsCommandCandidates('claude.ps1', String.raw`C:\a`, '.PS1;.CMD')).toEqual([]);
  });

  it('refuses a name that is not a bare command (the gate for config/env-supplied names)', () => {
    for (const bad of ['', 'c laude', '../claude', 'a&b', String.raw`C:\x\claude`, 'a|b']) {
      expect(windowsCommandCandidates(bad, String.raw`C:\a`, '.CMD')).toEqual([]);
    }
  });

  it('returns nothing when PATH is empty', () => {
    expect(windowsCommandCandidates('claude', '', '.CMD')).toEqual([]);
  });
});

describe('fully-qualified Windows paths', () => {
  it('separates drive-absolute and UNC from the rooted-but-driveless path isAbsolute accepts', () => {
    expect(isWindowsDriveAbsolutePath(String.raw`C:\x\y`)).toBe(true);
    expect(isWindowsDriveAbsolutePath('C:/x/y')).toBe(true);
    expect(isWindowsDriveAbsolutePath(String.raw`\\host\share\y`)).toBe(false);
    expect(isWindowsDriveAbsolutePath(String.raw`\rooted\y`)).toBe(false);
    expect(isWindowsDriveAbsolutePath(String.raw`tools\y`)).toBe(false);
    expect(isWindowsDriveAbsolutePath('')).toBe(false);

    expect(isWindowsFullyQualifiedPath(String.raw`C:\x\y`)).toBe(true);
    expect(isWindowsFullyQualifiedPath(String.raw`\\host\share\y`)).toBe(true);
    // `path.win32.isAbsolute` says true for both of these; neither is free of
    // current-drive / current-directory context.
    expect(path.win32.isAbsolute(String.raw`\rooted\y`)).toBe(true);
    expect(isWindowsFullyQualifiedPath(String.raw`\rooted\y`)).toBe(false);
    expect(isWindowsFullyQualifiedPath(String.raw`tools\y`)).toBe(false);
    expect(isWindowsFullyQualifiedPath(null)).toBe(false);
  });
});

describe('resolveCommandInterpreter — absolute only', () => {
  it('uses an absolute ComSpec', () => {
    expect(resolveCommandInterpreter({ ComSpec: String.raw`D:\nt\cmd.exe` }))
      .toBe(String.raw`D:\nt\cmd.exe`);
  });

  it('ignores a bare or relative ComSpec, because a bare name is searched in the cwd first', () => {
    expect(resolveCommandInterpreter({ ComSpec: 'cmd.exe', SystemRoot: String.raw`C:\Win` }))
      .toBe(String.raw`C:\Win\System32\cmd.exe`);
    expect(resolveCommandInterpreter({ ComSpec: String.raw`.\cmd.exe`, windir: String.raw`D:\W` }))
      .toBe(String.raw`D:\W\System32\cmd.exe`);
  });

  it('ignores a rooted-but-driveless or UNC ComSpec, which still depends on the current drive or a share', () => {
    expect(resolveCommandInterpreter({ ComSpec: String.raw`\cmd.exe`, SystemRoot: String.raw`C:\Win` }))
      .toBe(String.raw`C:\Win\System32\cmd.exe`);
    expect(resolveCommandInterpreter({ ComSpec: String.raw`\\host\share\cmd.exe`, SystemRoot: String.raw`C:\Win` }))
      .toBe(String.raw`C:\Win\System32\cmd.exe`);
  });

  it('falls back to %SystemRoot%\\System32\\cmd.exe, and to C:\\Windows if even that is unset', () => {
    expect(resolveCommandInterpreter({ SystemRoot: String.raw`E:\Windows` }))
      .toBe(String.raw`E:\Windows\System32\cmd.exe`);
    expect(resolveCommandInterpreter({})).toBe(String.raw`C:\Windows\System32\cmd.exe`);
  });
});

describe('buildWindowsCliInvocation — executable image', () => {
  it('spawns the resolved .exe directly, keeping argv (a multi-line prompt is safe without an interpreter)', () => {
    const prompt = 'line one\nline two';
    const inv = buildWindowsCliInvocation('gemini', ['-m', 'pro'], {
      promptArgs: ['-p', prompt],
      promptText: prompt,
      resolvedPath: String.raw`C:\tools\gemini.exe`,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.file).toBe(String.raw`C:\tools\gemini.exe`);
    expect(inv.args).toEqual(['-m', 'pro', '-p', prompt]);
    expect(inv.options).toEqual({});
    expect(inv.stdinPrompt).toBe(null);
    expect(inv.viaInterpreter).toBe(false);
    expect(inv.promptMovedToStdin).toBe(false);
  });
});

describe('buildWindowsCliInvocation — .cmd/.bat shim', () => {
  it('runs the shim through an absolute interpreter with /d /s /v:off /c and verbatim arguments', () => {
    const inv = buildWindowsCliInvocation('codex', ['exec', '-'], {
      promptArgs: ['--prompt', 'hi'],
      promptText: 'hi',
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.file).toBe(INTERP);
    expect(inv.args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    // `--prompt` is on the line and `hi` is not: for a stdinMode CLI only the
    // prompt TEXT moves to stdin, its flags stay where the CLI expects them
    // (R3-06 — before r4 the whole of promptArgs was dropped here).
    expect(inv.args[4]).toBe(String.raw`"^"C:\tools\codex.cmd^" ^^^"exec^^^" ^^^"-^^^" ^^^"--prompt^^^""`);
    // argv0 is the quoted interpreter: windowsVerbatimArguments makes libuv
    // join argv without quoting anything, and cmd.exe parses its own switches
    // out of that line.
    expect(inv.options).toEqual({
      windowsVerbatimArguments: true,
      argv0: `"${INTERP}"`,
    });
    expect(inv.viaInterpreter).toBe(true);
    expect(inv.shimPath).toBe(CODEX_SHIM);
  });

  it('keeps the interpreter a single token even when its path contains a space', () => {
    const spaced = String.raw`C:\Program Files\nt\cmd.exe`;
    const inv = buildWindowsCliInvocation('codex', ['exec'], {
      resolvedPath: CODEX_SHIM,
      interpreter: spaced,
    });
    expect(inv.ok).toBe(true);
    // CreateProcess takes the image from `file`, so it stays unquoted…
    expect(inv.file).toBe(spaced);
    // …while the line cmd.exe parses carries it quoted.
    expect(inv.options.argv0).toBe(`"${spaced}"`);
  });

  it('moves the prompt to stdin for a CLI declared to read it there, and never puts it on the command line', () => {
    const prompt = 'topic line\nsecond line & echo pwned';
    const inv = buildWindowsCliInvocation('codex', ['exec', '-'], {
      promptArgs: ['--prompt', prompt],
      promptText: prompt,
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.stdinPrompt).toBe(prompt);
    expect(inv.promptMovedToStdin).toBe(true);
    expect(inv.args[4]).not.toContain('topic line');
    expect(inv.args[4]).not.toContain('echo pwned');
  });

  it('keeps a stdin CLI\'s prompt FLAGS on the line and moves only the text', () => {
    // Dropping the flags is the same failure the builder refuses to create for
    // every other CLI — the CLI is launched without arguments it was given. The
    // dispatch sites build flags and text into one array, so the builder is the
    // only place that can separate them (R3-06).
    const prompt = 'topic line\nsecond line & echo pwned';
    const inv = buildWindowsCliInvocation('codex', ['exec'], {
      promptArgs: ['--prompt', '--format', 'text', prompt],
      promptText: prompt,
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.args[4]).toBe(
      String.raw`"^"C:\tools\codex.cmd^" ^^^"exec^^^" ^^^"--prompt^^^" ^^^"--format^^^" ^^^"text^^^""`,
    );
    expect(inv.args[4]).not.toContain('topic line');
    expect(inv.args[4]).not.toContain('echo pwned');
    expect(inv.stdinPrompt).toBe(prompt);
    expect(inv.promptMovedToStdin).toBe(true);
  });

  it('runs the kept flags through the same fail-closed guard as `args`', () => {
    for (const [flag, code] of [
      ['--pro%mpt', 'E_CLI_ARG_META'],
      ['--pro\u001ampt', 'E_CLI_ARG_META'],
      ['--pro\nmpt', 'E_CLI_ARG_NEWLINE'],
    ]) {
      const inv = buildWindowsCliInvocation('codex', ['exec'], {
        promptArgs: [flag, 'prompt text'],
        promptText: 'prompt text',
        resolvedPath: CODEX_SHIM,
        interpreter: INTERP,
      });
      expect(inv.ok, flag).toBe(false);
      expect(inv.code).toBe(code);
    }
  });

  it('refuses a CLI whose prompt must be an argv element instead of dropping its flags', () => {
    // Dropping the prompt flags would launch the CLI with no arguments at all,
    // which for an interactive CLI means hanging until the turn times out.
    const inv = buildWindowsCliInvocation('gemini', [], {
      promptArgs: ['-p', 'hello'],
      promptText: 'hello',
      resolvedPath: String.raw`C:\tools\gemini.cmd`,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(false);
    expect(inv.code).toBe('E_CLI_PROMPT_ARGV_REQUIRED');
    expect(inv.reason).toContain('gemini');
    expect(inv.stdinPrompt).toBe(null);
  });

  it('keeps every configured non-prompt flag on the command line', () => {
    const inv = buildWindowsCliInvocation('claude', ['-p', '--output-format', 'text'], {
      promptText: 'fed on stdin by the call site',
      resolvedPath: String.raw`C:\tools\claude.CMD`,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.args[4]).toBe(
      String.raw`"^"C:\tools\claude.CMD^" ^^^"-p^^^" ^^^"--output-format^^^" ^^^"text^^^""`,
    );
    expect(inv.stdinPrompt).toBe(null);
    expect(inv.promptMovedToStdin).toBe(false);
  });

  it('round-trips an argument containing quotes through both cmd passes', () => {
    const inv = buildWindowsCliInvocation('codex', ['-c', 'approval_policy="never"'], {
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.args[4]).toContain(String.raw`^^^"approval_policy^^^=\^^^"never\^^^"^^^"`);
  });

  it('fails closed on characters the interpreter would expand or split on', () => {
    const cases = [
      ['a%b', 'E_CLI_ARG_META'],
      ['a!b', 'E_CLI_ARG_META'],
      ['a\tb', 'E_CLI_ARG_META'],
      // A NUL terminates the command-line string the OS receives, so the rest
      // of the line — including the closing quote `/s` strips — is lost below
      // this layer and the remainder is re-parsed with unbalanced quotes.
      ['a\u0000b', 'E_CLI_ARG_META'],
      // Every other C0 control is refused for the same reason it cannot be
      // argued about: 0x1A is cmd.exe's batch end-of-file, 0x0B/0x0C are
      // whitespace cmd's tokeniser may split on but CommandLineToArgvW does
      // not, and none of them can be escaped by a caret (R3-10).
      ['a\u001ab', 'E_CLI_ARG_META'],
      ['a\u000bb', 'E_CLI_ARG_META'],
      ['a\u000cb', 'E_CLI_ARG_META'],
      ['a\u0007b', 'E_CLI_ARG_META'],
      ['a\u001bb', 'E_CLI_ARG_META'],
      ['a\nb', 'E_CLI_ARG_NEWLINE'],
      ['a\rb', 'E_CLI_ARG_NEWLINE'],
    ];
    for (const [arg, code] of cases) {
      const inv = buildWindowsCliInvocation('codex', ['-c', arg], {
        resolvedPath: CODEX_SHIM,
        interpreter: INTERP,
      });
      expect(inv.ok).toBe(false);
      expect(inv.code).toBe(code);
    }
  });

  it('fails closed when the resolved shim path itself carries such a character', () => {
    const inv = buildWindowsCliInvocation('codex', [], {
      resolvedPath: String.raw`C:\to%ols\codex.cmd`,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(false);
    expect(inv.code).toBe('E_CLI_ARG_META');
  });

  it('fails closed over cmd.exe\'s command-line limit, which escaping reaches from much shorter input', () => {
    // The full line is `"<interpreter>" /d /s /v:off /c "<escaped elements>"`,
    // and 8191 characters is what cmd.exe accepts. 8112 plain characters fit
    // exactly; one more does not.
    const fits = buildWindowsCliInvocation('codex', ['a'.repeat(8112)], {
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(fits.ok).toBe(true);
    expect(fits.args[4].length).toBe(8191 - `"${INTERP}"`.length - 1 - '/d /s /v:off /c'.length - 1);

    const overflows = buildWindowsCliInvocation('codex', ['a'.repeat(8113)], {
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(overflows.ok).toBe(false);
    expect(overflows.code).toBe('E_CLI_ARG_TOO_LONG');

    // Metacharacter-dense text costs ~5 characters per 2, so it overflows from
    // ~3400 characters — well under the limit it is measured against.
    const dense = buildWindowsCliInvocation('codex', ['a&'.repeat(1700)], {
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(dense.ok).toBe(false);
    expect(dense.code).toBe('E_CLI_ARG_TOO_LONG');
  });

  it('refuses an interpreter it would otherwise place on the line unescaped', () => {
    for (const interpreter of [
      String.raw`\cmd.exe`,            // rooted, resolves against the current drive
      String.raw`\\host\share\cmd.exe`, // the interpreter itself off a share
      'cmd.exe',                        // bare: searched in the child's cwd first
      String.raw`C:\%TMP%\cmd.exe`,     // percent expansion runs before carets
      String.raw`C:\a!b\cmd.exe`,
      'C:\\a\tb\\cmd.exe',
      'C:\\a\u001ab\\cmd.exe',          // any C0 control, not just the four named
      'C:\\a\u0000b\\cmd.exe',
      String.raw`C:\a"b\cmd.exe`,       // argv[0] is quoted, not caret-escaped
    ]) {
      const inv = buildWindowsCliInvocation('codex', ['exec'], {
        resolvedPath: CODEX_SHIM,
        interpreter,
      });
      expect(inv.ok, `interpreter ${JSON.stringify(interpreter)}`).toBe(false);
      expect(inv.code).toBe('E_CLI_INTERPRETER_INVALID');
    }
  });

  it('defaults the interpreter to an absolute path when the caller supplies none', () => {
    const inv = buildWindowsCliInvocation('claude', [], { resolvedPath: String.raw`C:\tools\claude.cmd` });
    expect(inv.ok).toBe(true);
    expect(inv.file).toBe(resolveCommandInterpreter());
    expect(path.win32.isAbsolute(inv.file)).toBe(true);
  });
});

describe('buildWindowsCliInvocation — unrunnable targets', () => {
  it('reports E_CLI_NOT_FOUND when nothing resolved', () => {
    const inv = buildWindowsCliInvocation('claude', [], { resolvedPath: null });
    expect(inv.ok).toBe(false);
    expect(inv.code).toBe('E_CLI_NOT_FOUND');
  });

  it('reports E_CLI_NOT_EXECUTABLE for an extension Windows cannot start', () => {
    const inv = buildWindowsCliInvocation('claude', [], {
      resolvedPath: String.raw`C:\tools\claude.ps1`,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(false);
    expect(inv.code).toBe('E_CLI_NOT_EXECUTABLE');
  });

  it('refuses a target that is not fully qualified, for the shim path and the image path alike', () => {
    // The stat that found it ran against the server's cwd; CreateProcess (image)
    // and the interpreter (shim) would both resolve it against the child's cwd,
    // which the caller chooses via ADR-264 spawn_cwd.
    for (const resolvedPath of [
      String.raw`tools\claude.CMD`,
      String.raw`.\claude.cmd`,
      String.raw`\tools\claude.CMD`,
      'claude.exe',
      String.raw`\tools\claude.exe`,
    ]) {
      const inv = buildWindowsCliInvocation('claude', [], { resolvedPath, interpreter: INTERP });
      expect(inv.ok, resolvedPath).toBe(false);
      expect(inv.code).toBe('E_CLI_PATH_NOT_ABSOLUTE');
    }
  });

  it('accepts a UNC target, which needs no cwd and no current drive', () => {
    const inv = buildWindowsCliInvocation('claude', ['-p'], {
      resolvedPath: String.raw`\\srv\share\claude.CMD`,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.args[4]).toContain(String.raw`^"\\srv\share\claude.CMD^"`);
  });
});

describe('cliDispatchRefusal — liveness asks the question the dispatcher will ask', () => {
  // On Windows a `.cmd` shim runs through the command interpreter, whose
  // command line cannot carry prompt text. A flags-only `--version` probe
  // through that shim succeeds, so probing alone would advertise a speaker
  // whose every turn then fails E_CLI_PROMPT_ARGV_REQUIRED.
  const onWin = (command, resolvedPath) =>
    cliDispatchRefusal(command, { platform: 'win32', resolvedPath, interpreter: INTERP });

  it('refuses a shim CLI that takes its prompt in argv', () => {
    const refusal = onWin('gemini', GEMINI_SHIM);
    expect(refusal).not.toBeNull();
    expect(refusal.code).toBe('E_CLI_PROMPT_ARGV_REQUIRED');
    expect(refusal.reason).toContain('gemini');
    // Same for every other argv-prompt CLI in the hint table.
    for (const command of ['grok', 'agy', 'aider', 'cursor']) {
      expect(onWin(command, String.raw`C:\tools\x.cmd`)?.code).toBe('E_CLI_PROMPT_ARGV_REQUIRED');
    }
  });

  it('does not refuse the CLIs whose prompt travels on stdin', () => {
    expect(onWin('codex', CODEX_SHIM)).toBeNull();
    // claude is fed on stdin at every dispatch site, so refusing it here would
    // take away a CLI the product dispatches fine.
    expect(onWin('claude', CLAUDE_SHIM)).toBeNull();
  });

  it('does not refuse a real executable image, whose argv is untouched', () => {
    expect(onWin('gemini', String.raw`C:\tools\gemini.exe`)).toBeNull();
  });

  it('reports the resolution failures too, so discovery can say why', () => {
    expect(onWin('gemini', null)?.code).toBe('E_CLI_NOT_FOUND');
    expect(onWin('gemini', String.raw`C:\tools\gemini.ps1`)?.code).toBe('E_CLI_NOT_EXECUTABLE');
    expect(onWin('gemini', String.raw`tools\gemini.cmd`)?.code).toBe('E_CLI_PATH_NOT_ABSOLUTE');
  });

  it('never refuses off Windows, where argv carries anything', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(cliDispatchRefusal('gemini', { platform, resolvedPath: GEMINI_SHIM })).toBeNull();
    }
  });

  // The probe has to ask with the arguments the dispatch will really put on the
  // line. Three of the eight refusal codes are decided from `args` alone, so a
  // probe with an empty `args` answers for five of eight and the other three
  // stay invisible to discovery — R2-01's shape, narrowed (R3-01).
  it('models the arguments the dispatcher sends, per CLI', () => {
    expect(cliDispatchArgs('codex')).toEqual(getCliExecArgs('codex', CLI_INVOCATION_HINTS.codex.defaultModel));
    expect(cliDispatchArgs('codex')).toEqual([
      'exec', '--ephemeral',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="read-only"',
      '-c', 'model_reasoning_effort="low"',
      '-m', 'gpt-5.4',
      '-',
    ]);
    expect(cliDispatchArgs('claude')).toEqual(['-p', '--output-format', 'text']);
    // gemini's model args are empty while defaultModel is null, and the CLIs
    // that carry everything in promptArgs put nothing on the line.
    expect(cliDispatchArgs('gemini')).toEqual([]);
    expect(cliDispatchArgs('grok')).toEqual([]);
    expect(cliDispatchArgs('no-such-cli')).toEqual([]);
  });

  it('reaches the three refusals that are decided from `args` alone', () => {
    for (const [args, code] of [
      [['-c', 'a%b'], 'E_CLI_ARG_META'],
      [['-c', 'a!b'], 'E_CLI_ARG_META'],
      [['-c', 'a\u001ab'], 'E_CLI_ARG_META'],
      [['-c', 'a\nb'], 'E_CLI_ARG_NEWLINE'],
      [['a'.repeat(9000)], 'E_CLI_ARG_TOO_LONG'],
    ]) {
      const refusal = cliDispatchRefusal('codex', {
        platform: 'win32', resolvedPath: CODEX_SHIM, interpreter: INTERP, args,
      });
      expect(refusal?.code, JSON.stringify(args)).toBe(code);
    }
  });

  it('uses the real vector by default, not an empty one', () => {
    // A shim path that fits on the line by itself but not once codex's own 11
    // arguments are escaped onto it: with `args: []` the probe says
    // "dispatchable", with the vector the dispatcher actually sends it does not.
    const longShim = `C:\\${'a'.repeat(7963)}\\codex.cmd`;
    const withEmptyArgs = cliDispatchRefusal('codex', {
      platform: 'win32', resolvedPath: longShim, interpreter: INTERP, args: [],
    });
    expect(withEmptyArgs).toBeNull();
    const withDispatchArgs = cliDispatchRefusal('codex', {
      platform: 'win32', resolvedPath: longShim, interpreter: INTERP,
    });
    expect(withDispatchArgs?.code).toBe('E_CLI_ARG_TOO_LONG');
    // …and the ordinary shim path is still dispatchable with those same args.
    expect(cliDispatchRefusal('codex', {
      platform: 'win32', resolvedPath: CODEX_SHIM, interpreter: INTERP,
    })).toBeNull();
  });
});

describe('isPermanentCliFailure — a pre-spawn refusal must not be retried', () => {
  it('classifies every code the builder can return', () => {
    for (const code of CLI_INVOCATION_FAILURE_CODES) {
      expect(isPermanentCliFailure(`CLI "x" cannot be executed: ${code} — because`), code).toBe(true);
    }
  });

  it('covers the codes the builder actually produces, with no code missing from the list', () => {
    const produced = [
      buildWindowsCliInvocation('claude', [], { resolvedPath: null }),
      buildWindowsCliInvocation('claude', [], { resolvedPath: String.raw`C:\t\claude.ps1`, interpreter: INTERP }),
      buildWindowsCliInvocation('claude', [], { resolvedPath: String.raw`t\claude.cmd`, interpreter: INTERP }),
      buildWindowsCliInvocation('codex', ['exec'], { resolvedPath: CODEX_SHIM, interpreter: 'cmd.exe' }),
      buildWindowsCliInvocation('gemini', [], { promptArgs: ['-p', 'hi'], promptText: 'hi', resolvedPath: GEMINI_SHIM, interpreter: INTERP }),
      // r5: the trailing promptArgs entry must BE the prompt text (R4-03).
      buildWindowsCliInvocation('codex', [], { promptArgs: ['--prompt', 'hi', '--tail'], promptText: 'hi', resolvedPath: CODEX_SHIM, interpreter: INTERP }),
      buildWindowsCliInvocation('codex', ['a\nb'], { resolvedPath: CODEX_SHIM, interpreter: INTERP }),
      buildWindowsCliInvocation('codex', ['a%b'], { resolvedPath: CODEX_SHIM, interpreter: INTERP }),
      buildWindowsCliInvocation('codex', ['a'.repeat(9000)], { resolvedPath: CODEX_SHIM, interpreter: INTERP }),
    ];
    const codes = produced.map(inv => inv.code);
    expect(codes).toEqual(CLI_INVOCATION_FAILURE_CODES);
    for (const inv of produced) {
      // This is the exact text the dispatch sites hand to the retry loop.
      expect(isPermanentCliFailure(`CLI "x" cannot be executed: ${inv.code} — ${inv.reason}`)).toBe(true);
    }
  });

  it('leaves a transient failure retryable', () => {
    expect(isPermanentCliFailure('CLI timeout (180s)')).toBe(false);
    expect(isPermanentCliFailure('CLI exit code 1: rate limited')).toBe(false);
    expect(isPermanentCliFailure('')).toBe(false);
    expect(isPermanentCliFailure(null)).toBe(false);
    expect(isPermanentCliFailure(undefined)).toBe(false);
  });
});

describe('isPermanentTurnFailure — the retry decision reads a field, not prose', () => {
  // The failure text of a turn can be `CLI exit code N: <child stderr>`, and
  // child stderr is CLI- and model-influenced. Deciding "permanent" by looking
  // for E_CLI_* codes in that text lets a process the deliberation is talking
  // to suppress the retry loop and have a platform refusal recorded that never
  // happened, on every platform (R3-02).
  it('trusts the structured flag', () => {
    expect(isPermanentTurnFailure({ ok: false, permanent: true, error: 'anything' })).toBe(true);
    expect(isPermanentTurnFailure({ ok: false, permanent: false, error: 'anything' })).toBe(false);
    expect(isPermanentTurnFailure({ ok: false, error: 'anything' })).toBe(false);
    expect(isPermanentTurnFailure({})).toBe(false);
    expect(isPermanentTurnFailure(null)).toBe(false);
    expect(isPermanentTurnFailure(undefined)).toBe(false);
  });

  it('ignores a refusal code that only appears in text a child could have printed', () => {
    const fromStderr = {
      ok: false,
      error: 'CLI exit code 1: upstream rejected (E_CLI_NOT_FOUND in cache key)',
    };
    // The text test says yes — which is why the decision must not use it…
    expect(isPermanentCliFailure(fromStderr.error)).toBe(true);
    // …and the decision says no, because nothing structural marked it.
    expect(isPermanentTurnFailure(fromStderr)).toBe(false);
  });

  it('does not treat a blocked transport or a timeout as permanent', () => {
    expect(isPermanentTurnFailure({ ok: false, blocked: true, error: 'self_turn' })).toBe(false);
    expect(isPermanentTurnFailure({ ok: false, error: 'CLI timeout (180s)' })).toBe(false);
  });
});

describe('boundReviewerStderr — the bound maxBuffer used to provide', () => {
  // The base passed `maxBuffer: 10 * 1024 * 1024`, which bounded stdout AND
  // stderr; after the spawn rewrite stderr had no bound at all, so a reviewer
  // CLI that streams to stderr for the whole deadline grew the heap (R3-03).
  it('keeps the retained text bounded however many chunks arrive', () => {
    let stderr = '';
    for (let i = 0; i < 64; i += 1) stderr = boundReviewerStderr(stderr, 'x'.repeat(1024));
    expect(stderr.length).toBe(4096);
  });

  it('keeps the HEAD, so the first 500 characters still mean what they meant', () => {
    const chunks = ['first chunk: the real error\n', 'y'.repeat(100000), 'tail'];
    let bounded = '';
    let unbounded = '';
    for (const chunk of chunks) {
      bounded = boundReviewerStderr(bounded, chunk);
      unbounded += chunk;
    }
    expect(bounded.slice(0, 500)).toBe(unbounded.slice(0, 500));
    expect(bounded.length).toBeLessThanOrEqual(4096);
  });

  it('clips a single oversized chunk and stops appending once full', () => {
    expect(boundReviewerStderr('', 'z'.repeat(99999)).length).toBe(4096);
    const full = 'a'.repeat(4096);
    expect(boundReviewerStderr(full, 'ignored')).toBe(full);
    expect(boundReviewerStderr(undefined, undefined)).toBe('');
    expect(boundReviewerStderr('ab', 'cd', 3)).toBe('abc');
  });
});

describe('stdin capability comes from the hint table, not from the call sites', () => {
  it('declares codex stdin-capable and gemini not', () => {
    expect(CLI_INVOCATION_HINTS.codex.stdinMode).toBe(true);
    expect(CLI_INVOCATION_HINTS.gemini.stdinMode).toBeUndefined();
  });

  it('declares claude stdin-capable, which is what every dispatch site does with it', () => {
    // index.js, transport.js (runCliAutoTurnCore, generateAutoSynthesis) and
    // invokeCliReviewer all feed `claude -p` on stdin and pass no promptArgs.
    // The table is what cliDispatchRefusal reads, so if it said otherwise,
    // liveness would stop offering a CLI the product dispatches fine.
    expect(CLI_INVOCATION_HINTS.claude.stdinMode).toBe(true);
  });
});

describe('buildCliInvocation — platform dispatch', () => {
  it('passes a bare command through unchanged off Windows, and resolves it on Windows', () => {
    const inv = buildCliInvocation('no-such-cli-xyz', ['-p'], {
      promptArgs: ['--prompt', 'hi'],
      promptText: 'hi',
    });
    if (process.platform === 'win32') {
      // Nothing of that name is on PATH, so the structured code must come back
      // rather than a bare name being handed to CreateProcess.
      expect(inv.ok).toBe(false);
      expect(inv.code).toBe('E_CLI_NOT_FOUND');
    } else {
      expect(inv).toMatchObject({
        ok: true,
        file: 'no-such-cli-xyz',
        args: ['-p', '--prompt', 'hi'],
        stdinPrompt: null,
        viaInterpreter: false,
        promptMovedToStdin: false,
      });
      expect(inv.options).toEqual({});
    }
  });
});

describe('terminateCliProcess', () => {
  it('kills the child directly when no interpreter is interposed, and escalates on force', () => {
    const signals = [];
    terminateCliProcess({ pid: 4242, kill: (sig) => signals.push(sig) }, {});
    terminateCliProcess({ pid: 4242, kill: (sig) => signals.push(sig) }, { force: true });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('never throws on a process that is already gone, or on no child at all', () => {
    expect(() => terminateCliProcess({
      pid: 4242,
      kill: () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); },
    }, {})).not.toThrow();
    expect(() => terminateCliProcess(null)).not.toThrow();
    expect(() => terminateCliProcess(undefined, { viaInterpreter: true })).not.toThrow();
  });

  it('prefers the tree kill when an interpreter is interposed, and only on Windows', () => {
    const signals = [];
    // 0x7ffffffe cannot be a live Windows pid (Windows hands out multiples of
    // 4), so on win32 taskkill is launched and the direct kill is not used
    // before it answers — which is observable as child.kill NOT having been
    // used at this point. Off Windows there is no tree mechanism and the
    // single kill is correct. What the tree kill actually runs, and what
    // happens when it fails, is pinned deterministically below.
    terminateCliProcess({ pid: 0x7ffffffe, kill: (sig) => signals.push(sig) }, { viaInterpreter: true });
    expect(signals).toEqual(process.platform === 'win32' ? [] : ['SIGTERM']);
  });

  // The cases below inject the platform and the spawner, so the Windows branch
  // is driven on every matrix leg instead of only where taskkill exists.
  const fakeKiller = () => {
    const killer = new EventEmitter();
    return killer;
  };
  const treeKill = (child, killer, extra = {}) => {
    const calls = [];
    terminateCliProcess(child, {
      viaInterpreter: true,
      platform: 'win32',
      spawnFn: (file, args, options) => {
        calls.push({ file, args, options });
        if (killer instanceof Error) throw killer;
        return killer;
      },
      ...extra,
    });
    return calls;
  };

  it('builds the tree kill with /t — without it this is the single-process kill again', () => {
    expect(buildTreeKillCommand(4242, { SystemRoot: String.raw`C:\Win` })).toEqual([
      String.raw`C:\Win\System32\taskkill.exe`,
      ['/pid', '4242', '/t', '/f'],
    ]);
    // Absolute path, no shell, and the vector the product really passes.
    const calls = treeKill({ pid: 4242, kill: () => {} }, fakeKiller());
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['/pid', '4242', '/t', '/f']);
    expect(calls[0].args).toContain('/t');
    expect(path.win32.isAbsolute(calls[0].file)).toBe(true);
    expect(calls[0].file.toLowerCase().endsWith(String.raw`\system32\taskkill.exe`)).toBe(true);
    expect(calls[0].options).toMatchObject({ stdio: 'ignore', windowsHide: true });
  });

  it('falls back to the direct kill when the tree kill exits non-zero', () => {
    // taskkill that starts and then refuses (access denied, an elevated child,
    // the pid already reaped) used to leave child.kill never called, so a
    // failed tree kill killed nothing at all.
    const signals = [];
    const killer = fakeKiller();
    treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, killer);
    expect(signals).toEqual([]);
    killer.emit('exit', 1);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('does not touch the handle when the tree kill succeeds', () => {
    const signals = [];
    const killer = fakeKiller();
    treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, killer);
    killer.emit('exit', 0);
    expect(signals).toEqual([]);
  });

  it('escalates to SIGKILL on the fallback when force was requested', () => {
    const signals = [];
    const killer = fakeKiller();
    treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, killer, { force: true });
    killer.emit('exit', 128);
    expect(signals).toEqual(['SIGKILL']);
  });

  it('falls back once only, whatever the tree killer reports', () => {
    const signals = [];
    const killer = fakeKiller();
    treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, killer);
    killer.emit('error', new Error('ENOENT'));
    killer.emit('exit', 1);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('falls back when spawning the tree killer throws', () => {
    const signals = [];
    treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, new Error('EPERM'));
    expect(signals).toEqual(['SIGTERM']);
  });

  it('falls back when the tree killer never exits at all', () => {
    vi.useFakeTimers();
    try {
      const signals = [];
      treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, fakeKiller());
      expect(signals).toEqual([]);
      vi.advanceTimersByTime(2000);
      expect(signals).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the hung-killer fallback once the tree kill has answered', () => {
    vi.useFakeTimers();
    try {
      const signals = [];
      const killer = fakeKiller();
      treeKill({ pid: 4242, kill: (sig) => signals.push(sig) }, killer);
      killer.emit('exit', 0);
      vi.advanceTimersByTime(10000);
      expect(signals).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a non-numeric pid and kills the handle directly', () => {
    const signals = [];
    const calls = treeKill({ pid: undefined, kill: (sig) => signals.push(sig) }, fakeKiller());
    expect(calls).toHaveLength(0);
    expect(signals).toEqual(['SIGTERM']);
  });
});

describe('abandonCliProcess — what both async deadlines do', () => {
  // The deadline has to close the TREE, not the interpreter it holds (R2-02),
  // and escalate at most once, only if the child survived (R3-05). Both
  // deadlines call this one function, so the wiring is driven here instead of
  // being visible only by reading the two call sites (R3-08).
  const run = (child, options = {}) => {
    const calls = [];
    const timers = [];
    const timer = abandonCliProcess(child, {
      terminate: (c, opts) => calls.push(opts),
      timerFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      ...options,
    });
    return { calls, timers, timer };
  };
  const liveChild = () => ({ pid: 4242, exitCode: null, signalCode: null });

  it('closes the tree immediately, carrying viaInterpreter', () => {
    const { calls, timers } = run(liveChild(), { viaInterpreter: true });
    expect(calls).toEqual([{ viaInterpreter: true }]);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(2000);
  });

  it('escalates once, with force, when the child is still alive', () => {
    const child = liveChild();
    const { calls, timers } = run(child, { viaInterpreter: true });
    timers[0].fn();
    expect(calls).toEqual([{ viaInterpreter: true }, { viaInterpreter: true, force: true }]);
  });

  it('does not escalate against a child that has already exited', () => {
    const exited = { pid: 4242, exitCode: 0, signalCode: null };
    const { calls, timers } = run(exited, { viaInterpreter: true });
    timers[0].fn();
    expect(calls).toEqual([{ viaInterpreter: true }]);

    const killed = { pid: 4242, exitCode: null, signalCode: 'SIGTERM' };
    const second = run(killed, { viaInterpreter: true });
    second.timers[0].fn();
    expect(second.calls).toEqual([{ viaInterpreter: true }]);
  });

  it('passes viaInterpreter: false through unchanged, and honours an explicit grace', () => {
    const { calls, timers } = run(liveChild(), { graceMs: 5000 });
    expect(calls).toEqual([{ viaInterpreter: false }]);
    expect(timers[0].ms).toBe(5000);
    timers[0].fn();
    expect(calls).toEqual([{ viaInterpreter: false }, { viaInterpreter: false, force: true }]);
  });

  it('unrefs the escalation timer so it cannot hold the event loop open', () => {
    let unrefCalled = false;
    abandonCliProcess(liveChild(), {
      terminate: () => {},
      timerFn: () => ({ unref() { unrefCalled = true; } }),
    });
    expect(unrefCalled).toBe(true);
  });
});

// The two call sites that used to bound a CLI with a synchronous timeout. A
// synchronous timeout terminates the single spawned pid, which on the Windows
// shim path is the interpreter — leaving the CLI underneath it running, still
// holding the inherited pipes and the provider session. Being abandonable
// means being asynchronous, which is what these two cases pin; the termination
// itself is terminateCliProcess, pinned above.
describe('nothing but an approved CLI command name is ever spawned', () => {
  // `deliberation_start`'s `first_speaker`, a telepty session id and a manual
  // participant name all reach checkCliLiveness, and on POSIX buildCliInvocation
  // passes the name straight to spawn — so `first_speaker: "/usr/bin/true"`
  // started an unrelated local executable with `--version` (R4-01).
  it('classifies what an approved command name is', () => {
    for (const good of ['codex', 'claude', 'gpt-4.1', 'a_b', 'q']) {
      expect(isApprovedCliCommandName(good), good).toBe(true);
    }
    for (const bad of [
      '/usr/bin/true', './true', '../true', String.raw`C:\tools\x.exe`,
      'a b', 'a;b', 'a&b', 'a|b', 'a$(b)', 'a\nb', '', null, undefined, 42, {},
    ]) {
      expect(isApprovedCliCommandName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a path-like or token-like speaker name without spawning anything', async () => {
    for (const name of ['/usr/bin/true', './true', '../../bin/sh', String.raw`C:\Windows\System32\cmd.exe`, 'a b', 'rm -rf /', '']) {
      const spawns = [];
      const live = await checkCliLiveness(name, { spawnFn: (...args) => { spawns.push(args); throw new Error('must not spawn'); } });
      expect(live, name).toBe(false);
      expect(spawns, name).toEqual([]);
    }
  });

  it('still probes an ordinary bare command name, through the resolution this OS uses', async () => {
    await withCliFixture('codex', async ({ shimPath, viaInterpreter }) => {
      const spawns = [];
      const child = fakeLiveChild();
      const live = await checkCliLiveness('codex', {
        spawnFn: (file, args, options) => { spawns.push({ file, args, options }); setTimeout(() => child.emit('close', 0), 0); return child; },
      });
      expect(live).toBe(true);
      expect(spawns).toHaveLength(1);
      if (viaInterpreter) {
        // Windows: the fixture is a .cmd shim, so the probe goes through the
        // interpreter and the shim path is on the /c string.
        expect(spawns[0].file).toBe(resolveCommandInterpreter());
        expect(spawns[0].args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
        // Lower-cased: the resolved candidate carries PATHEXT's case (`.CMD`)
        // while the fixture file is written in npm's (`.cmd`), and NTFS treats
        // them as the same file.
        expect(spawns[0].args[4].toLowerCase()).toContain(shimPath.toLowerCase());
        expect(spawns[0].args[4]).toContain('--version');
        expect(spawns[0].options).toMatchObject({ windowsVerbatimArguments: true });
      } else {
        // POSIX: the bare name goes to spawn, PATH is the OS's business.
        expect(spawns[0].file).toBe('codex');
        expect(spawns[0].args).toEqual(['--version']);
      }
    });
  });

  it('reads the hint table by own property only', () => {
    expect(getCliHint('codex')).toBe(CLI_INVOCATION_HINTS.codex);
    // A plain-object read returns Object.prototype members for these names.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(CLI_INVOCATION_HINTS[inherited], inherited).toBeTruthy();
      expect(getCliHint(inherited), inherited).toBeUndefined();
    }
    expect(getCliHint('no-such-cli')).toBeUndefined();
    expect(getCliHint(undefined)).toBeUndefined();
  });
});

describe('only a known CLI candidate can become a probe target', () => {
  // `mapParticipantProfiles` turns a `participant_types` override into a CLI
  // profile with no command, and the start tool used the SPEAKER ID as the probe
  // target — so a confirmed telepty session called `true` became
  // `spawn("true", ["--version"])`. A speaker with no candidate at all was also
  // promoted to CLI by PATH membership (R5-01).
  const cliCandidate = (speaker, command = speaker) => ({ speaker, type: 'cli', command, label: speaker });
  const teleptyCandidate = (speaker) => ({ speaker, type: 'telepty', telepty_session_id: speaker, command: 'claude' });
  const trustedCommands = ['claude', 'codex', 'gemini'];

  it('returns the discovered candidate\'s own command for a known CLI', () => {
    expect(resolveCliProbeCommand('codex', [cliCandidate('codex')], { trustedCommands })).toBe('codex');
    // The command comes from the candidate, not from the speaker id.
    expect(resolveCliProbeCommand('codex-alias', [{ speaker: 'codex-alias', type: 'cli', command: 'codex' }], { trustedCommands })).toBe('codex');
  });

  it('refuses a speaker whose candidate is not a CLI, whatever its type was overridden to', () => {
    // The override lives in participant_types and never reaches this function:
    // the candidate's own type is what decides.
    expect(resolveCliProbeCommand('true', [teleptyCandidate('true')], { trustedCommands })).toBeNull();
    expect(resolveCliProbeCommand('web-gemini', [{ speaker: 'web-gemini', type: 'browser' }], { trustedCommands })).toBeNull();
  });

  it('refuses a speaker that is not a candidate at all, however the name looks', () => {
    for (const name of ['true', 'sh', 'node', 'codex']) {
      expect(resolveCliProbeCommand(name, [], { trustedCommands }), name).toBeNull();
      expect(resolveCliProbeCommand(name, [cliCandidate('other')], { trustedCommands }), name).toBeNull();
    }
  });

  it('refuses a CLI candidate whose command is outside the trusted registry or not a bare name', () => {
    expect(resolveCliProbeCommand('rogue', [cliCandidate('rogue')], { trustedCommands })).toBeNull();
    expect(resolveCliProbeCommand('codex', [cliCandidate('codex', '/usr/bin/true')], { trustedCommands })).toBeNull();
    expect(resolveCliProbeCommand('codex', [cliCandidate('codex', 'a b')], { trustedCommands })).toBeNull();
    expect(resolveCliProbeCommand('', [cliCandidate('codex')], { trustedCommands })).toBeNull();
    expect(resolveCliProbeCommand('codex', null, { trustedCommands })).toBeNull();
  });

  it('uses the built-in hint table as the registry when none is injected', () => {
    // Production path: every default CLI candidate is in the hint table.
    expect(resolveCliProbeCommand('codex', [cliCandidate('codex')])).toBe('codex');
    expect(resolveCliProbeCommand('rogue-cli', [cliCandidate('rogue-cli')])).toBeNull();
  });

  it('nothing is spawned for an override-to-cli name or a disappeared candidate', async () => {
    // The start tool's decision sequence, with the spawn seam watched: resolve
    // the authorized command, and only then probe (index.js
    // `participantProfiles` loop). `true` and `sh` are approved bare names, so
    // without the authorization step they WOULD be spawned — which is the
    // finding.
    const spawns = [];
    const startTooDecision = async (speaker, candidates) => {
      const command = resolveCliProbeCommand(speaker, candidates, { trustedCommands });
      if (!command) return { probed: false, live: false };
      const live = await checkCliLiveness(command, {
        spawnFn: (...args) => { spawns.push(args); throw new Error('must not spawn'); },
      });
      return { probed: true, live };
    };

    // A confirmed telepty session called `true`, its type overridden to cli.
    expect(await startTooDecision('true', [teleptyCandidate('true')])).toEqual({ probed: false, live: false });
    // A confirmed speaker that is no longer a candidate but is a name on PATH.
    expect(await startTooDecision('sh', [])).toEqual({ probed: false, live: false });
    // Both names would otherwise have passed the command-name gate.
    expect(isApprovedCliCommandName('true')).toBe(true);
    expect(isApprovedCliCommandName('sh')).toBe(true);
    expect(spawns).toEqual([]);
  });
});

describe('the probe models the dispatch it gates, per CLI', () => {
  // A stdinMode CLI is dispatched with `args` only and its prompt on stdin, so
  // a synthetic prompt flag in the probe is 11 escaped units the real line never
  // carries — enough to refuse an installation the dispatch would have run
  // (R4-02).
  const shimFor = (n) => `C:\\${'a'.repeat(n)}\\codex.cmd`;

  it('asks a stdin CLI the question with no prompt argv at all', () => {
    // A path chosen so the REAL vector lands on exactly 8191 and one extra
    // escaped flag would not (8202): on the previous round the probe refused
    // this installation while the dispatch ran it.
    const longShim = shimFor(7888);
    const realLine = buildWindowsCliInvocation('codex', cliDispatchArgs('codex'), {
      resolvedPath: longShim,
      interpreter: INTERP,
    });
    expect(realLine.ok).toBe(true);
    expect(cliDispatchRefusal('codex', { platform: 'win32', resolvedPath: longShim, interpreter: INTERP })).toBeNull();
  });

  it('still asks an argv-prompt CLI whether prompt text in argv is refused', () => {
    const refusal = cliDispatchRefusal('gemini', { platform: 'win32', resolvedPath: GEMINI_SHIM, interpreter: INTERP });
    expect(refusal?.code).toBe('E_CLI_PROMPT_ARGV_REQUIRED');
  });

  it('refuses a stdin CLI whose own arguments do not fit, as the dispatch would', () => {
    const tooLong = shimFor(7889);
    expect(buildWindowsCliInvocation('codex', cliDispatchArgs('codex'), {
      resolvedPath: tooLong, interpreter: INTERP,
    }).code).toBe('E_CLI_ARG_TOO_LONG');
    expect(cliDispatchRefusal('codex', { platform: 'win32', resolvedPath: tooLong, interpreter: INTERP })?.code)
      .toBe('E_CLI_ARG_TOO_LONG');
  });
});

describe('promptArgs: the prompt is the trailing entry, by position', () => {
  it('keeps a flag that happens to equal the prompt text', () => {
    // Value-based filtering removed every matching entry, so `["-p", "-p"]`
    // with promptText "-p" lost the flag as well (R4-03).
    const inv = buildWindowsCliInvocation('codex', [], {
      promptArgs: ['-p', '-p'],
      promptText: '-p',
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.args[4]).toBe(String.raw`"^"C:\tools\codex.cmd^" ^^^"-p^^^""`);
    expect(inv.stdinPrompt).toBe('-p');
  });

  it('fails closed when the trailing entry is not the prompt text', () => {
    // Otherwise the mismatched entries are treated as flags — which is prompt
    // text on the interpreter line, the one thing the builder exists to prevent.
    const inv = buildWindowsCliInvocation('codex', [], {
      promptArgs: ['--prompt', 'the real prompt', '--extra'],
      promptText: 'the real prompt',
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(false);
    expect(inv.code).toBe('E_CLI_PROMPT_ARGV_SHAPE');
    expect(CLI_INVOCATION_FAILURE_CODES).toContain('E_CLI_PROMPT_ARGV_SHAPE');
    expect(isPermanentCliFailure(`CLI "codex" cannot be executed: ${inv.code} — ${inv.reason}`)).toBe(true);
  });

  it('is unaffected when the prompt text is the only prompt entry', () => {
    const inv = buildWindowsCliInvocation('codex', ['exec'], {
      promptArgs: ['just the prompt'],
      promptText: 'just the prompt',
      resolvedPath: CODEX_SHIM,
      interpreter: INTERP,
    });
    expect(inv.ok).toBe(true);
    expect(inv.args[4]).toBe(String.raw`"^"C:\tools\codex.cmd^" ^^^"exec^^^""`);
    expect(inv.stdinPrompt).toBe('just the prompt');
  });
});

describe('the deadline of each entry point closes the tree exactly once', () => {
  // The helper cases below prove what abandonCliProcess does; these prove that
  // each PUBLIC entry point calls it at its deadline (R4-07), and that a
  // reviewer cannot enter abandonment twice through queued output (R4-04).
  it('checkCliLiveness hands each timed-out probe child to the tree terminator', async () => {
    await withCliFixture('codex', async ({ viaInterpreter }) => {
      const children = [];
      const abandoned = [];
      const live = await checkCliLiveness('codex', {
        spawnFn: () => { const child = fakeLiveChild(); children.push(child); return child; },
        probeTimeoutMs: 1,
        abandon: (child, opts) => { abandoned.push({ index: children.indexOf(child), opts }); return { unref() {} }; },
      });
      expect(live).toBe(false);
      // Two probes run — `--version`, then `--help` — each with its own child,
      // and each deadline closes ITS OWN tree. On Windows the fixture is a .cmd
      // shim, so the child each deadline holds is the interpreter and
      // `viaInterpreter` must say so. (That the second probe starts while the
      // first tree is still being killed is a stated base difference.)
      expect(children).toHaveLength(2);
      expect(abandoned).toEqual([
        { index: 0, opts: { viaInterpreter } },
        { index: 1, opts: { viaInterpreter } },
      ]);
    });
  });

  it('invokeCliReviewer hands its timed-out child to the tree terminator, once', async () => {
    await withCliFixture('claude', async ({ viaInterpreter }) => {
      const child = fakeLiveChild({ withStdio: true });
      const abandoned = [];
      const pending = invokeCliReviewer('claude', 'review this', 1, {
        spawnFn: () => child,
        abandonFn: (c, opts) => { abandoned.push(opts); return { unref() {} }; },
      });
      const result = await pending;
      expect(result).toEqual({ ok: false, error: 'timeout' });
      expect(abandoned).toHaveLength(1);
      // On Windows the reviewer runs through the .cmd shim, so what the deadline
      // closes is the interpreter's tree — the metadata has to say so.
      expect(abandoned[0]).toMatchObject({ viaInterpreter, graceMs: 5000 });
      // Output queued behind the deadline must not start a second termination.
      child.stdout.emit('data', Buffer.from('late chunk'));
      child.stderr.emit('data', Buffer.from('late chunk'));
      expect(abandoned).toHaveLength(1);
    });
  });

  it('abandons a flooding reviewer once, counting the RAW bytes maxBuffer counted', async () => {
    await withCliFixture('claude', async ({ viaInterpreter }) => {
      const child = fakeLiveChild({ withStdio: true });
      const abandoned = [];
      const pending = invokeCliReviewer('claude', 'review this', 60000, {
        spawnFn: () => child,
        abandonFn: (c, opts) => { abandoned.push(opts); return { unref() {} }; },
      });
      // 4 million U+D55C are 4 million UTF-16 units but 12 million UTF-8 bytes:
      // over the 10 MiB cap the base enforced, under a code-unit counter (R4-05).
      const chunk = Buffer.from('한'.repeat(4 * 1000 * 1000), 'utf8');
      expect(chunk.length).toBe(12 * 1000 * 1000);
      child.stderr.emit('data', chunk);
      child.stderr.emit('data', chunk);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toBe(`stderr exceeded ${10 * 1024 * 1024} bytes`);
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]).toMatchObject({ viaInterpreter });
    });
  });

  it('charges a reviewer the bytes it wrote, not what decoding them would cost', async () => {
    // 4 MiB of isolated 0xff is inside the 10 MiB budget the base enforced, but
    // each byte decodes to U+FFFD and re-encodes to three — so measuring the
    // decoded text charged 12 MiB and abandoned a successful review (R5-08).
    await withCliFixture('claude', async () => {
      const child = fakeLiveChild({ withStdio: true });
      const abandoned = [];
      const pending = invokeCliReviewer('claude', 'review this', 60000, {
        spawnFn: () => child,
        abandonFn: (c, opts) => { abandoned.push(opts); return { unref() {} }; },
      });
      child.stderr.emit('data', Buffer.alloc(4 * 1024 * 1024, 0xff));
      child.stdout.emit('data', Buffer.from('the review text'));
      child.emit('close', 0);
      const result = await pending;
      expect(result).toEqual({ ok: true, response: 'the review text' });
      expect(abandoned).toEqual([]);
    });
  });

  it('decodes a multi-byte character split across two chunks exactly once', async () => {
    await withCliFixture('claude', async () => {
      const child = fakeLiveChild({ withStdio: true });
      const pending = invokeCliReviewer('claude', 'review this', 60000, {
        spawnFn: () => child,
        abandonFn: () => ({ unref() {} }),
      });
      const text = Buffer.from('답변: 한글', 'utf8');
      child.stdout.emit('data', text.subarray(0, 5));   // mid-character
      child.stdout.emit('data', text.subarray(5));
      child.emit('close', 0);
      const result = await pending;
      expect(result).toEqual({ ok: true, response: '답변: 한글' });
    });
  });
});

describe('the CLI deadlines are ours, so the whole tree can be closed at them', () => {
  const ABSENT = 'no-such-cli-xyz-r2';

  it('checkCliLiveness is async and answers false for a CLI it cannot reach', async () => {
    const pending = checkCliLiveness(ABSENT);
    expect(typeof pending?.then).toBe('function');
    await expect(pending).resolves.toBe(false);
  });

  it('invokeCliReviewer is async and reports the failure without throwing', async () => {
    const pending = invokeCliReviewer(ABSENT, 'review this', 2000);
    expect(typeof pending?.then).toBe('function');
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    // Not the deadline: there was nothing to wait for.
    expect(result.error).not.toBe('timeout');
  });
});
