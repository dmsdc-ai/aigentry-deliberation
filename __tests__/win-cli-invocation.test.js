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

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  quoteCmdArgument,
  windowsCommandCandidates,
  resolveCommandInterpreter,
  buildWindowsCliInvocation,
  buildCliInvocation,
  terminateCliProcess,
  CLI_INVOCATION_HINTS,
} from '../lib/speaker-discovery.js';

const INTERP = String.raw`C:\Windows\System32\cmd.exe`;
const CODEX_SHIM = String.raw`C:\tools\codex.cmd`;

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

describe('windowsCommandCandidates — PATH × PATHEXT in the order Windows uses', () => {
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
    expect(inv.options).toEqual({ windowsVerbatimArguments: true });
    expect(inv.viaInterpreter).toBe(true);
    expect(inv.shimPath).toBe(CODEX_SHIM);
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
});

describe('stdin capability comes from the hint table, not from the call sites', () => {
  it('declares codex stdin-capable and gemini not', () => {
    expect(CLI_INVOCATION_HINTS.codex.stdinMode).toBe(true);
    expect(CLI_INVOCATION_HINTS.gemini.stdinMode).toBeUndefined();
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
    // 4), so on win32 taskkill is launched, reports "not found" and nothing else
    // happens — which is observable as child.kill NOT having been used. Off
    // Windows there is no tree mechanism and the single kill is correct.
    terminateCliProcess({ pid: 0x7ffffffe, kill: (sig) => signals.push(sig) }, { viaInterpreter: true });
    expect(signals).toEqual(process.platform === 'win32' ? [] : ['SIGTERM']);
  });
});
