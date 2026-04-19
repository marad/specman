---
id: FEAT-0003
title: Implementation snapshots and drift detection
status: draft
depends_on: [FEAT-0001]
---

## Intent

Track which version of each spec the codebase currently reflects, so drift — "the spec has been edited since the last sync" — can be detected mechanically, without interpreting human-maintained counters and without walking git history. The previous approach (frontmatter integers bumped by the editor, last-implemented version recovered by git archaeology) relied on invariants nothing enforces: any non-editor edit, any history rewrite, any careless merge would silently corrupt the signal. Snapshots eliminate that class of problem — drift becomes a plain file comparison.

## Behavior

For each spec that has been successfully synced (FEAT-0004), SpecMan maintains a **snapshot file** at `.specman/implemented/<FEAT-ID>.md` containing a byte-for-byte copy of the spec as it existed at sync time. Snapshots are checked into the repository alongside the specs they mirror.

Drift detection compares the **canonical form** of the current spec against the snapshot. The snapshot is already in canonical form (written by SpecMan). To check drift, SpecMan parses the current spec file via FEAT-0006 and serializes it to canonical form, then compares the result against the snapshot byte-for-byte. This eliminates false-positive drift from editor whitespace changes (trailing space trimming, newline insertion) that do not affect spec content. If the current spec file fails to parse, SpecMan falls back to raw byte-for-byte comparison against the snapshot — a malformed file always counts as drifted. A spec with no snapshot is considered `new` — a distinct state from `drifted`, used by the sync loop to know whether to generate a greenfield plan or a diff-based plan.

`specman status` classifies each spec as one of:

- `in-sync` — snapshot exists and matches the current spec byte-for-byte.
- `drifted` — snapshot exists and differs.
- `new` — no snapshot yet.

`specman validate` surfaces orphan snapshots (snapshot exists, source spec does not) and malformed snapshots.

## Constraints

- Snapshots are written **only** by the sync or seal commands (FEAT-0004). No other code path — editor, validator, external tool, test harness — ever creates or modifies a snapshot. Violating this invariant would silently mark drifted specs as in-sync.
- Drift comparison uses canonical-form normalization (parse then serialize via FEAT-0006) before byte comparison. This means formatting-only differences (whitespace, frontmatter key order, blank lines) do not constitute drift. Content differences — any change to frontmatter values, section text, or acceptance criteria — always constitute drift.
- Snapshots live in the repo (`.specman/implemented/`) so they are version-controlled and visible in PRs. No hidden state outside version control.
- Snapshot filenames are keyed on `<FEAT-ID>`, not on the spec's on-disk filename, so renaming a spec file does not break the snapshot link as long as the ID stays stable.

## Examples

Directory layout after a successful first sync of two features:

```
specs/
  FEAT-0001-spec-file-format.md
  FEAT-0042-password-reset.md
.specman/
  implemented/
    FEAT-0001.md
    FEAT-0042.md
```

`specman status` output with one drifted spec and one brand-new one:

```
FEAT-0001 in-sync
FEAT-0042 drifted  (body changed)
FEAT-0099 new      (no snapshot yet)
```

## Acceptance criteria

- AC-1: Given a spec file whose canonical form (parsed and re-serialized via FEAT-0006) equals `.specman/implemented/<FEAT-ID>.md` byte-for-byte, `specman status` reports it as `in-sync`.
- AC-2: Given a spec file whose canonical form differs from its snapshot, `specman status` reports it as `drifted`, and `specman status --diff` includes a unified diff between canonical forms.
- AC-3: Given a spec with no corresponding snapshot file, `specman status` reports it as `new`.
- AC-4: Given a snapshot file under `.specman/implemented/` whose corresponding spec in `specs/` does not exist, `specman validate` reports it as orphaned naming the snapshot path.
- AC-5: Given a snapshot file whose parsed `id` does not match its filename, `specman validate` reports it as mismatched.
- AC-6: Given a successful sync, the snapshot commit is the final commit of the sync invocation, landing after all agent-authored code commits and after verification passes. Intermediate states where code commits exist without a snapshot are expected — the spec remains `drifted` until the snapshot commit seals it.
- AC-7: Given a failed or aborted sync, the snapshot is not modified.
- AC-8: Given `specman status` invoked with no arguments, `drifted` and `new` specs are both listed; `in-sync` specs are summarized as a count unless `--verbose` is passed.
- AC-9: Given a spec file that fails to parse (malformed YAML, unterminated frontmatter), drift detection falls back to raw byte-for-byte comparison against the snapshot, and the spec is reported as `drifted`.

## Out of scope

- Per-branch snapshot semantics for long-lived feature branches (revisit when concretely needed).
- Tracking snapshot history beyond what git already provides.
- Automatic sync on drift detection — drift surfaces a state; sync remains explicit (FEAT-0004).

## Non-goals

- No normalization of snapshots (whitespace trimming, frontmatter canonicalization, AC reordering). Any such transform would mask drift we actually want to surface.
- No "semantic drift" detection that ignores non-behavioral edits beyond formatting. Canonical-form normalization handles whitespace; everything else (including frontmatter-only changes like `status`) counts as drift. A later layer may summarize drift, but the core comparison is canonical bytes.
- Snapshots are not a change log. They reflect a single point in time — the last successful sync. History lives in git.

## Open questions

- Should `specman status --diff` show structural diffs (AC-level: "AC-2 changed", "AC-5 added") in addition to raw unified diffs? *Decide after the first real drift review — unified diff is enough to ship; structural output is a refinement driven by actual human reading pain.*
