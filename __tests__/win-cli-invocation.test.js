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
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  quoteCmdArgument,
  windowsCommandCandidates,
  resolveCommandInterpreter,
  buildWindowsCliInvocation,
  buildCliInvocation,
  cliDispatchRefusal,
  checkCliLiveness,
  terminateCliProcess,
  buildTreeKillCommand,
  isPermanentCliFailure,
  isWindowsFullyQualifiedPath,
  isWindowsDriveAbsolutePath,
  CLI_INVOCATION_FAILURE_CODES,
  CLI_INVOCATION_HINTS,
} from '../lib/speaker-discovery.js';
import { invokeCliReviewer } from '../lib/transport.js';

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
    expect(inv.args[4]).toBe(String.raw`"^"C:\tools\codex.cmd^" ^^^"exec^^^" ^^^"-^^^""`);
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

// The two call sites that used to bound a CLI with a synchronous timeout. A
// synchronous timeout terminates the single spawned pid, which on the Windows
// shim path is the interpreter — leaving the CLI underneath it running, still
// holding the inherited pipes and the provider session. Being abandonable
// means being asynchronous, which is what these two cases pin; the termination
// itself is terminateCliProcess, pinned above.
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
