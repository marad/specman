---
id: FEAT-0007
title: Validate command
status: draft
depends_on: [FEAT-0001, FEAT-0003, FEAT-0006]
---

## Intent

Give users and CI a single command that checks every structural and cross-file invariant SpecMan depends on and reports every violation in one pass. Without it, each component would either trust malformed input silently (dangerous) or reimplement its own checks (drift). `specman validate` is where the rules humans have to uphold get mechanized, and where CI plants its flag in the spec tree.

## Behavior

The user runs `specman validate` from within a repo. The command walks `specs/` recursively — excluding `specs/assets/`, which is reserved for non-spec content per FEAT-0001 — runs the parser (FEAT-0006) on every `.md` file it finds, and then performs cross-file and cross-layer checks:

- Every spec parses successfully.
- Every `id` is unique across the repo — regardless of which subfolder each spec lives in.
- Every `depends_on` reference targets an existing spec `id`.
- Every spec file's leaf name matches the `<FEAT-ID>-<slug>.md` convention; subfolder names themselves are unconstrained.
- Every snapshot under `.specman/implemented/` has a matching spec and a matching embedded `id` (FEAT-0003).
- Every plan file under `.specman/plans/` has a matching spec.

Each finding is classified as **error** or **warning** according to the severity already declared by the spec that defines the rule (for example: FEAT-0001 declares the filename mismatch as a warning). Validate does not invent severities; it reports them.

Output is human-readable by default, grouped by file, and a `--format=json` flag emits a machine-readable report with the same content. Exit code is `0` when there are no errors and `1` when there is at least one error. A `--strict` flag promotes warnings so any finding causes a non-zero exit.

## Constraints

- Validate is read-only. No file on disk is created, modified, or deleted by any invocation.
- Validate reports the full set of findings per invocation. Early termination is acceptable only when the parser cannot be run at all (e.g. `specs/` does not exist).
- Exit code is a pure function of findings and flags. Same findings + same flags ⇒ same exit code.
- Every finding carries a stable machine-readable code (e.g. `E001-duplicate-id`, `W001-filename-convention`) so CI can grep, filter, or gate on specific codes across versions.
- Every finding is attributable to at least one file path, and to a line number when the rule has location semantics.
- Output is deterministic: two runs against the same repo state produce byte-identical output (both human and JSON formats).

## Examples

Clean repo:

```
$ specman validate
specs/FEAT-0001-spec-file-format.md       OK
specs/FEAT-0002-local-visual-editor.md    OK
specs/FEAT-0003-implementation-snapshots.md  OK
specs/FEAT-0004-agent-sync-workflow.md    OK
specs/FEAT-0006-spec-parser.md            OK
specs/FEAT-0007-validate-command.md       OK
6 specs checked. 0 errors, 0 warnings.
```

A duplicate-id error and a filename-convention warning:

```
$ specman validate
specs/FEAT-0004-agent-sync-workflow.md:3   E001-duplicate-id  id "FEAT-0004" also declared in specs/FEAT-0004-alt.md:3
specs/notes-on-future-ideas.md             W001-filename-convention  filename does not match <FEAT-ID>-<slug>.md
6 specs checked. 1 error, 1 warning.
$ echo $?
1
```

JSON output (shape):

```json
{
  "summary": { "specs_checked": 6, "errors": 1, "warnings": 1 },
  "findings": [
    {
      "code": "E001-duplicate-id",
      "severity": "error",
      "path": "specs/FEAT-0004-agent-sync-workflow.md",
      "line": 3,
      "message": "id \"FEAT-0004\" also declared in specs/FEAT-0004-alt.md:3"
    }
  ]
}
```

## Acceptance criteria

- AC-1: Given a repo whose specs all parse and satisfy every cross-file check, `specman validate` exits with code 0 and prints a summary including the count of specs checked.
- AC-2: Given two specs declaring the same `id`, validate reports both files with severity `error` and exits with code 1.
- AC-3: Given a `depends_on` entry referencing a nonexistent spec `id`, validate reports a finding with severity `error`.
- AC-4: Given a file whose name does not match the `<FEAT-ID>-<slug>.md` convention, validate reports a finding with severity `warning` (per FEAT-0001 AC-7).
- AC-5: Given a snapshot file at `.specman/implemented/<ID>.md` with no matching spec, validate reports it as orphaned with severity `error` (per FEAT-0003 AC-4).
- AC-7: Given a run with warnings but no errors, exit code is 0 by default and 1 under `--strict`.
- AC-8: Given `--format=json`, the output is a single JSON document containing a `summary` object and a `findings` array, with one entry per finding carrying at minimum `code`, `severity`, `path`, and `message`.
- AC-9: Given two invocations against an identical repo state with identical flags, the output is byte-identical across runs.
- AC-10: Given a finding surfaced by the parser (FEAT-0006), its code, severity, path, and line come through unchanged — validate does not downgrade, relabel, or summarize parser errors.
- AC-11: Given an invocation in a directory with no `specs/` folder, validate exits with a distinct non-zero code and a clear message, without attempting to produce an empty report.
- AC-12: Given spec files organized across subfolders under `specs/` (e.g. `specs/cli/FEAT-0008-...md`), validate discovers them, applies every check uniformly, and surfaces duplicate-id errors across subfolder boundaries.
- AC-13: Given any `.md` file under `specs/assets/`, validate ignores it — `specs/assets/` is reserved for non-spec content per FEAT-0001.
- AC-14: Given a plan file at `.specman/plans/<ID>.md` with no matching spec, validate reports it as orphaned with severity `error` (per FEAT-0011).

## Out of scope

- Auto-fixing findings. Validate reports; humans fix.
- Generating or updating snapshots (FEAT-0003). Those are written only by the sync loop (FEAT-0004).
- Prose linting — grammar, spelling, style. Outside the structural mandate.
- Running tests or any form of code verification. Validate is a static check over specs and metadata; code correctness is the sync loop's concern.
- Multi-repo validation. One repo per invocation.

## Non-goals

- Validate does not stop at the first error. It always reports the full set per invocation — the opposite of the parser's one-error-per-call rule. The parser's job is "is this one file parseable?"; validate's job is "what is wrong across the whole repo?"
- Validate does not invent rules. Every check enforces a contract declared by another spec. When a rule moves or changes severity, validate inherits the change without needing its own edit.
- Validate does not silently skip unknown files. Extra `.md` files under `specs/` that cannot be parsed are reported as findings, not ignored.
- Validate does not prompt. It is designed for CI: no interactive confirmation, no tty assumptions, no color required for semantic meaning (colors are additive, not load-bearing).

## Open questions

- Should the JSON output be pinned by a JSON Schema committed to the repo? *Decide once a first CI integration writes against the output — reuse pressure will clarify whether the shape needs a stricter contract.*
- Should `--only <code>` / `--ignore <code>` filters exist? *Defer until users actually request them; trivially additive later.*
- Should there be a `--diff` mode that validates only specs changed vs. a base ref, for fast PR checks? *Decide when a concrete PR-bot integration is planned; premature now.*
- Should validate also flag specs whose `status` is `active` but whose snapshot is missing (i.e. never synced)? That straddles FEAT-0003's territory. *Decide when the sync loop lands and we see whether this state is common or pathological.*
