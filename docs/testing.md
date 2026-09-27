# Testing lanes

This repository runs two kinds of test, and they answer two different
questions. Keeping them apart is the point of this document.

| Lane | Question it answers | Entry points | Blocks a release? |
| --- | --- | --- | --- |
| **Product gate** | Does *our* code work? | `npm test`, `npm run test:watch`, `prepublishOnly`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` | **Yes** |
| **Upstream monitor** | Does the *runtime underneath us* still behave as observed? | `npm run test:upstream`, `.github/workflows/upstream-runtime.yml` (`main` push / PR only — no tag trigger) | **No — but it stays red** |

## Product gate

`npm test` runs the whole Vitest suite with exactly one file removed:

```
vitest run --exclude=__tests__/native-unicode-copy.test.js
```

One bare path. No `**/` prefix, no second `--exclude`, no restated defaults.

### Why one bare path, and why nothing else

Read off the installed `vitest@4.0.18` sources rather than inferred from CLI
documentation:

| Source | Line | What it shows |
| --- | --- | --- |
| `dist/config.cjs` | 16 | `const defaultExclude = ["**/node_modules/**", "**/.git/**"];` |
| `dist/config.cjs` | 52 | `exclude: defaultExclude` — the built-in default for `test.exclude` |
| `dist/chunks/cac.*.js` | 1344–1347 | `normalizeCliOptions` moves `argv.exclude` into `argv.cliExclude` and **deletes** `argv.exclude` |
| `dist/chunks/coverage.*.js` | 2615 | `if (resolved.cliExclude) resolved.exclude.push(...resolved.cliExclude);` |

Because the CLI value is renamed to `cliExclude` and the original key deleted,
a `--exclude` on the command line can never land on `test.exclude`. It is
**appended** to the already-resolved defaults. So:

* Restating `**/node_modules/**` is redundant — it is already there.
* Adding `**/dist/**` would be an *unauthorised broadening*, not the
  preservation of an inherited default.
* A single bare relative path is the smallest change that removes exactly one
  file.

`prepublishOnly` is `npm test`, so the publish path and CI cannot drift apart:
there is one definition of "the product gate" and both callers use it.

`npm run test:watch` carries the **same** exclusion, so the verdict you watch
while working is the verdict CI will produce.

CI runs `npm test` on the full matrix (`ubuntu` / `macos` / `windows` x Node
18 / 20 / 22), and `Release` runs it again before `npm publish`. Neither the
`ci.yml` matrix nor the release gate changed, and no product test lost an arm.

What *did* change is **which workflow's matrix runs the excluded file**. Before
this change `npm test` was a bare `vitest run`, so the diagnostic was collected
on all nine product arms; the exclusion removes all nine of those from the
product gate. On `main` pushes and pull requests they are restored in the
upstream lane rather than dropped. The tag-triggered `release.yml` lane is a
different story and is **not** restored — see
[Coverage of the excluded file](#coverage-of-the-excluded-file).

## Upstream monitor

`__tests__/native-unicode-copy.test.js` (`cp1172br`) measures `fs.cpSync`
against a destination directory whose name contains non-ASCII characters. On
Windows it has been observed returning successfully while leaves did not land.

That is a **runtime** observation. It is not a defect in this package, and no
product code path depends on it: `install.js` copies its payload with
`copyFileIfExists` / `copyDirRecursive`, i.e. `fs.copyFileSync`, and *that*
caller is covered by `__tests__/installer-unicode.test.js`, which stays in the
product gate.

So the diagnostic runs in its own lane:

```
npm run test:upstream        # vitest run __tests__/native-unicode-copy.test.js
```

and `.github/workflows/upstream-runtime.yml` runs it in CI on the same
`push` / `pull_request` triggers as `ci.yml`, in **two jobs**. It deliberately
has no `tag` trigger, so it is not a counterpart to `release.yml` — see
[Coverage of the excluded file](#coverage-of-the-excluded-file):

| Job | Arms | What it answers |
| --- | --- | --- |
| `native-unicode-copy-diagnostic` | `windows-latest` x Node 20, 22 (**2**) | Runtime behaviour, or Vitest-runtime contamination? The raw builtin-only reproduction (`node scripts/diagnose-native-unicode-copy.mjs`) runs *before* any dependency install, followed by an always-run Vitest comparison — two side-by-side comparisons, one per Node version. |
| `upstream-runtime-coverage` | `ubuntu` / `macos` / `windows` x Node 18, 20, 22 (**9**) | Does this happen anywhere other than the two Windows arms where it was recorded? Vitest only, via `npm run test:upstream`. |

Neither job substitutes for the other, and neither tolerates a failure.

### Coverage of the excluded file

The one arm count that must not shrink is **where the diagnostic executes**.

On a `main` push or a pull request:

| | Arms running `native-unicode-copy.test.js` |
| --- | --- |
| Before: product gate (`npm test`, bare `vitest run`) | 9 — `ubuntu` / `macos` / `windows` x Node 18 / 20 / 22 |
| Before: plus the former `ci.yml` raw job | 2 raw-vs-Vitest comparisons on `windows-latest` x Node 20 / 22 |
| After: `upstream-runtime-coverage` | **9** — the same OS and Node lists, read off `ci.yml`'s matrix |
| After: `native-unicode-copy-diagnostic` | **2** — unchanged |

On a `v*` **tag** push, which is what `release.yml` answers to:

| | Arms running `native-unicode-copy.test.js` |
| --- | --- |
| Before: `release.yml`'s `test` job (`npm test`, bare `vitest run`) | 1 — `ubuntu-latest` x Node 20 |
| After: `release.yml`'s `test` job (`npm test`, now excluding) | **0** |
| After: `upstream-runtime.yml` | **0** — it triggers on `push: branches: [main]` / `pull_request`, and a tag push matches neither |

So on `main` pushes and pull requests the move is a change of **attribution
only**, not of reach: the nine coverage arms and the two Windows comparisons are
preserved exactly. Had the upstream lane kept just the Windows Node 20/22 job,
the ubuntu, macOS and Node-18 observations would have disappeared: the same
`fs.cpSync` behaviour surfacing on Linux, macOS or Node 18 would then be observed
nowhere. The test file skips no OS and no Node version by design, so every
restored arm really executes it.

**Trigger coverage is not claimed to be unchanged.** At tag / publication time
the diagnostic used to run once, in `release.yml`, and now runs nowhere: the
publication gate no longer collects it and no tag-triggered monitor replaces it.
Removing it from the publication gate is the approved intent of this change — an
upstream runtime defect must not block a publish — so this table records the drop
instead of papering over it. The *observations* are not lost, because the nine
restored arms (ubuntu / macOS / windows x Node 18 / 20 / 22, which include the
former release arm's ubuntu x Node 20) run on every `main` push; what is gone is
the check at the moment of publication. Re-adding one, here or anywhere, would be
a separate reviewed decision.

`__tests__/upstream-gate-separation.test.js` asserts this by reading the `os:`
and `node:` matrix lines out of `ci.yml` itself and requiring the same lines in
`upstream-runtime.yml`, so widening the product matrix without widening the
upstream lane fails. That is a **source** check: that GitHub dispatches nine
coverage jobs, and that the diagnostic really runs on the non-Windows arms, is a
runner claim and must be read off real runs.

### Separation is not suppression

1. **The upstream workflow stays RED on failure.** None of
   `continue-on-error`, `continue_on_error`, `allow-failure`, `allowFailure`,
   `|| true`, `|| echo`, `exit 0`, `if: false` or `passWithNoTests` appears in
   it. A discrepancy fails the job and the job is visible. The `if: always()`
   on the later steps is the opposite of masking — it forces the comparison to
   be collected even after a red raw step.
2. **The explicit script inherits no exclusion.** `test:upstream` names the
   file directly and passes no `--exclude`. There is deliberately **no**
   `vitest.config.*` in this repository: a global `exclude` would apply to the
   explicit script too and silently reduce it to zero collected tests.
3. **The lanes are not wired together.** No product workflow references the
   diagnostic, the upstream workflow, or the `test:upstream` script; the
   upstream workflow gates nothing and is `needs:`-linked from nothing.

What the separation changes is **attribution**, not tolerance: an upstream
runtime defect no longer fails the install / security / regression gates of a
package that did not cause it. It still shows up, on every push and every pull
request, as a red check.

### If the upstream workflow is red

Read it as "the runtime still behaves this way", not as "the build is broken".
Retiring the diagnostic is a reviewed decision, not a CI edit.

## How the wiring is guarded, and how it is not

`__tests__/upstream-gate-separation.test.js` is a **drift detector**:

* `JSON.parse` on `package.json`, compared against the exact reviewed command
  strings.
* `node:crypto` sha256 **byte pins** on `ci.yml`, `upstream-runtime.yml` and
  `release.yml`, plus exact whole-line membership for the lines that carry the
  separation contract.
* Direct negative mutations, each asserted to break a pin or an exact value.

A byte pin proves the reviewed bytes are still on disk. **That is all it
proves.** It does not prove GitHub Actions runs the job, and it does not prove
Vitest collects any particular file. A deliberate workflow change *should* fail
that test; the fix is to re-read the diff and update the pin, never to loosen
the assertion.

The claim that actually matters — **the product list loses exactly one file and
the explicit upstream script still selects it** — is a runner claim and can
only be established by running the runner:

```
npx vitest list                                  # full collected list
npm test -- --reporter=verbose                   # product gate
npm run test:upstream -- --reporter=verbose      # upstream lane
```

The product list must equal the full list minus
`__tests__/native-unicode-copy.test.js`, and the upstream lane must collect
that one file with a non-zero test count. No handwritten glob matcher is used
to assert this, and none should be added — a reimplementation of the runner's
matcher would only prove itself.

## Adding a test

Put it in `__tests__/` as `*.test.js` and it joins the **product gate**
automatically — the gate excludes one named file and includes everything else.
Nothing needs to be registered.

A test belongs in the upstream lane only if it measures a runtime, OS or
toolchain behaviour this package cannot fix. That is a deliberate, reviewed
move, and it requires updating both `__tests__/upstream-gate-separation.test.js`
(which hard-codes the single excluded path) and this document.
