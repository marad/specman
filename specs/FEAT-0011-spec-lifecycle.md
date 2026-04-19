---
id: FEAT-0011
title: Spec lifecycle operations
status: draft
depends_on: [FEAT-0001, FEAT-0003, FEAT-0007, FEAT-0008, FEAT-0009]
---

## Intent

Pin the rules for how specs are removed or relocated so the bookkeeping around them — snapshots, plans, asset folders, `depends_on` references, `Spec:` commit trailers — stays consistent and predictable. Without explicit rules, users leave orphans behind, write ad-hoc cleanup scripts, or silently corrupt sync's scoping inputs. Three operations need clear positions: filename/folder rename, deletion, and id change. Each has a different shape and each wants a different answer; a single spec covers all three so the boundaries between them are visible in one place.

## Behavior

### Filename and folder rename

Handled without tooling. A spec's identity is its `id`, not its path (FEAT-0001). Users move or rename spec files with `git mv`, an editor, or any other filesystem operation. `depends_on` references and `Spec:` commit trailers are unaffected because both resolve by id. The snapshot file at `.specman/implemented/<FEAT-ID>.md` is keyed on id, not on the spec filename, so it does not need to move.

If the new filename does not match `<FEAT-ID>-<slug>.md`, validate (FEAT-0007) emits a W001 filename warning. Users pick a sensible slug; no further tool action is required.

### Deletion: `specman delete <FEAT-ID>`

Removes, if present, everything SpecMan tracks for `<FEAT-ID>`:

- `specs/*/<FEAT-ID>-<slug>.md` — the spec file, wherever it lives under `specs/`. Lookup first matches by filename pattern (`specs/**/<FEAT-ID>-*.md`); if no match is found, falls back to scanning `.md` files under `specs/` (excluding `specs/assets/`) for an `id: <FEAT-ID>` frontmatter field.
- `.specman/implemented/<FEAT-ID>.md` — the snapshot
- `.specman/plans/<FEAT-ID>.md` — the plan
- `specs/assets/<FEAT-ID>/` — the asset folder (recursively, with contents)

Each removed path is listed in the output. Paths that did not exist are summarized so the user can see what was and was not present. Delete succeeds as long as at least one of the four paths existed for the id; if none did, it exits non-zero with a "no such spec" error.

Delete modifies the working tree only. It creates no commit, stages nothing, and makes no git calls. Staging and committing the deletion is the user's normal git workflow.

Delete does not modify other specs. If any other spec currently declares `<FEAT-ID>` in its `depends_on`, delete prints a warning naming those specs but removes the target anyway — resolving the dangling reference might mean dropping the dependency or re-pointing it, which is a content decision delete cannot make. Validate (FEAT-0007) will continue to surface the broken reference until it is fixed.

Delete does not modify code. Code that implements the deleted spec is the user's concern to remove through their normal development workflow. Commits historically tagged with `Spec: <FEAT-ID>/<AC-ID>` remain in history untouched; they are simply irrelevant to future sync scoping because no spec with that id exists.

### Id change

Not supported as a command. Commit trailers naming the old id cannot be rewritten without history surgery (out of scope per FEAT-0004 non-goals). Synthesizing partial support — renaming the files but leaving trailers stale — would silently degrade future sync's scoping without any visible signal.

The documented path for effectively changing a spec's id is delete followed by `specman new --id <new-id>`. The user accepts that any code historically tagged with the old id will not be scoped under the new id by future syncs. This is tolerable for the primary legitimate case — two branches both claiming the same id on unshipped specs, resolved during a merge — and appropriately inconvenient for mature specs with accumulated history, where an id change is almost always the wrong move.

Editing the `id` frontmatter in place produces no automatic migration. The result is typically: a filename-convention warning from validate, and an orphan-snapshot error for the old id. The tool does not guess the user's intent.

## Constraints

- **Identity is the `<FEAT-ID>`.** Filenames, paths, slugs, and folder placement are labels users may freely change without any tool involvement or bookkeeping migration.
- **`specman delete` is atomic at the working-tree level.** Either all existing bookkeeping files for the id are removed, or — on filesystem error partway through — the command restores anything it had already removed and exits non-zero. The user never observes a half-deleted state they must clean up manually.
- **`specman delete` never commits.** It touches the working tree only. Staging and commits remain the user's choice.
- **`specman delete` does not modify other specs.** Dangling `depends_on` references are warned about, not rewritten.
- **`specman delete` does not modify code.** Implementation code outlives the spec until the user removes it.
- **No id-rename tooling.** There is no `specman rename-id`, no `--new-id` flag on any command that rewrites trailers, and no frontmatter-edit-triggered migration. Id changes route through delete + recreate with known tradeoffs.
- **Non-interactive.** Delete takes an id argument and removes the files, no prompts.

## Examples

Folder rename — no tooling needed:

```
$ git mv specs/FEAT-0042-password-reset.md specs/auth/FEAT-0042-password-reset.md
$ specman validate
... 9 specs checked. 0 errors, 0 warnings.
```

Deletion of a fully-tracked spec with a dependent:

```
$ specman delete FEAT-0042
Removed specs/auth/FEAT-0042-password-reset.md
Removed .specman/implemented/FEAT-0042.md
Removed .specman/plans/FEAT-0042.md
Removed specs/assets/FEAT-0042/ (3 files)
warning: FEAT-0099 declares FEAT-0042 in depends_on — edit or remove that reference
```

Deletion of an unsynced spec (no snapshot, plan, or assets):

```
$ specman delete FEAT-0050
Removed specs/FEAT-0050-half-baked.md
(no snapshot, plan, or asset folder to remove)
```

Deletion of a pure orphan — spec was removed manually with `rm`, but snapshot remained:

```
$ specman delete FEAT-0042
Removed .specman/implemented/FEAT-0042.md
(spec, plan, and asset folder were not present)
```

Attempting to delete an id with nothing under it:

```
$ specman delete FEAT-9999
error: no spec, snapshot, plan, or asset folder found for FEAT-9999
```

Id change via delete + new:

```
$ specman delete FEAT-0042
Removed specs/auth/FEAT-0042-password-reset.md
Removed .specman/implemented/FEAT-0042.md
Removed .specman/plans/FEAT-0042.md
$ specman new "Password reset via email" --id FEAT-0099
specs/FEAT-0099-password-reset-via-email.md
note: commits historically tagged 'Spec: FEAT-0042/...' will not be scoped by sync under FEAT-0099
```

## Acceptance criteria

- AC-1: Given a spec file moved to a new location under `specs/` via any filesystem operation, `depends_on` references and `Spec:` commit trailers continue to resolve to it by id without SpecMan action.
- AC-2: Given `specman delete <FEAT-ID>` where a spec with that id exists, the spec file is removed and the removed path is reported.
- AC-3: Given `specman delete <FEAT-ID>` where a snapshot file at `.specman/implemented/<FEAT-ID>.md` exists, it is removed and reported.
- AC-4: Given `specman delete <FEAT-ID>` where a plan file at `.specman/plans/<FEAT-ID>.md` exists, it is removed and reported.
- AC-5: Given `specman delete <FEAT-ID>` where an asset folder at `specs/assets/<FEAT-ID>/` exists, it is removed recursively (contents and folder) and the removal is reported with a file count.
- AC-6: Given `specman delete <FEAT-ID>` where some of the four tracked paths are present and others are absent, only the existing paths are removed; absent paths are summarized in the output.
- AC-7: Given `specman delete <FEAT-ID>` where none of spec, snapshot, plan, or asset folder exists for that id, the command exits non-zero with a "no such spec" error and modifies nothing.
- AC-8: Given `specman delete <FEAT-ID>` and one or more other specs declaring that id in `depends_on`, the command prints a warning naming those specs but still removes the target; exit code is zero.
- AC-9: Given a filesystem error during delete (e.g. permission denied on one of the target paths), the command restores any files or directories it had already removed and exits non-zero with a clear error.
- AC-10: Given `specman delete` completes successfully, no git commit is created and no file outside the four tracked paths for the id is modified.
- AC-11: Given `specman delete <FEAT-ID>` completes, the validator's orphan-snapshot and orphan-plan checks (FEAT-0007) report no orphans for `<FEAT-ID>` — because snapshot, plan, and assets were removed alongside the spec.
- AC-12: Given an attempt to change a spec's id by editing its `id` frontmatter field in place, no automatic migration occurs. The validator reports the resulting inconsistencies (orphan snapshot at the old id, filename-convention warning, etc.); the user follows the delete + `specman new --id` path to perform the change deliberately.

## Out of scope

- Rewriting `Spec:` trailers in commit history. Git history is append-only by convention (FEAT-0004 non-goal).
- Automatically editing other specs' `depends_on` entries when a referenced id is deleted.
- Automatically removing code that implemented a deleted spec.
- A `specman rename-id` command. Unsupported by design; see Non-goals.
- Bulk operations (e.g. `specman delete --all-drafts`). Single id per invocation.
- An "undo" or trash. Recovery is a git operation — `git restore`, `git checkout`.

## Non-goals

- **No id-rename tooling.** The operation cannot be made safe at the tool layer: old commit trailers remain in history and silently miss-scope future syncs under the new id. Providing a command that hides this tradeoff would create a false sense of safety. Users who must change an id do so through delete + recreate and accept the tradeoff explicitly.
- **No cross-spec edits from delete.** Delete warns about dangling references but does not rewrite them. The user's judgment is required for each: drop the dependency, re-point it, or accept the broken reference until the referring spec is itself edited.
- **No code-side cleanup from delete.** Removing implementation code is a normal development change, not a SpecMan operation. Treating code removal as a SpecMan concern would imply automated code edits without a plan — the opposite of FEAT-0004's "no silent code changes" non-goal.
- **No delete confirmation prompt.** Delete is non-interactive by design. Git recovers mistakes cheaply; requiring a prompt would break scripting and add friction without meaningful safety.
- **No warning suppression flag.** The depends_on warning on delete cannot be disabled; being told about broken references is the feature.

## Open questions

- Should `specman delete` accept multiple ids in one invocation (`specman delete FEAT-0042 FEAT-0043`)? *Defer — trivially additive later; single-id-per-call keeps blast radius small until a concrete batch use case surfaces.*
- Should `specman delete` offer a `--dry-run` that prints what would be removed without touching disk? *Closed — yes, `--dry-run` prints the list of tracked paths that would be removed (or are absent) without deleting anything.*
- Should validate auto-suggest `specman delete <FEAT-ID>` when it finds an orphan snapshot or plan? *Decide if orphan states prove to be a common confusion point; for now validate reports, humans pick the remediation.*
