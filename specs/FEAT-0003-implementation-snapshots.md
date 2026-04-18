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

Drift detection is a plain file comparison: a spec is drifted iff `.specman/implemented/<FEAT-ID>.md` exists and differs from the current spec file. A spec with no snapshot is considered `new` — a distinct state from `drifted`, used by the sync loop to know whether to generate a greenfield plan or a diff-based plan.

`specman status` classifies each spec as one of:

- `in-sync` — snapshot exists and matches the current spec byte-for-byte.
- `drifted` — snapshot exists and differs.
- `new` — no snapshot yet.

`specman validate` surfaces orphan snapshots (snapshot exists, source spec does not) and malformed snapshots.

## Constraints

- Snapshots are written **only** by the sync loop (FEAT-0004). No other code path — editor, validator, external tool, test harness — ever creates or modifies a snapshot. Violating this invariant would silently mark drifted specs as in-sync.
- Drift comparison is byte-for-byte. No normalization, no "semantic equivalence" — any diff, including whitespace and frontmatter-only changes, counts as drift.
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

- AC-1: Given a spec file whose contents equal `.specman/implemented/<FEAT-ID>.md` byte-for-byte, `specman status` reports it as `in-sync`.
- AC-2: Given a spec file whose contents differ from its snapshot, `specman status` reports it as `drifted`, and `specman status --diff` includes a unified diff.
- AC-3: Given a spec with no corresponding snapshot file, `specman status` reports it as `new`.
- AC-4: Given a snapshot file under `.specman/implemented/` whose corresponding spec in `specs/` does not exist, `specman validate` reports it as orphaned naming the snapshot path.
- AC-5: Given a snapshot file whose parsed `id` does not match its filename, `specman validate` reports it as mismatched.
- AC-6: Given a successful sync of a spec, the snapshot is written in the same commit (or atomic commit sequence) as the code changes so the repository never observes a snapshot-without-code or code-without-snapshot state.
- AC-7: Given a failed or aborted sync, the snapshot is not modified.
- AC-8: Given `specman status` invoked with no arguments, `drifted` and `new` specs are both listed; `in-sync` specs are summarized as a count unless `--verbose` is passed.

## Out of scope

- Per-branch snapshot semantics for long-lived feature branches (revisit when concretely needed).
- Tracking snapshot history beyond what git already provides.
- Automatic sync on drift detection — drift surfaces a state; sync remains explicit (FEAT-0004).

## Non-goals

- No normalization of snapshots (whitespace trimming, frontmatter canonicalization, AC reordering). Any such transform would mask drift we actually want to surface.
- No "semantic drift" detection that ignores non-behavioral edits. A later layer may summarize drift, but the core comparison remains bytes.
- Snapshots are not a change log. They reflect a single point in time — the last successful sync. History lives in git.

## Open questions

- Should `specman status --diff` show structural diffs (AC-level: "AC-2 changed", "AC-5 added") in addition to raw unified diffs? *Decide after the first real drift review — unified diff is enough to ship; structural output is a refinement driven by actual human reading pain.*
