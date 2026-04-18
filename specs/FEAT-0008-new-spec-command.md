---
id: FEAT-0008
title: New spec command
status: draft
depends_on: [FEAT-0001, FEAT-0006]
---

## Intent

Give authors a frictionless, non-interactive way to create a new spec without hunting for the next free ID, remembering frontmatter boilerplate, or worrying about filename conventions. When specs are organized across subfolders (per FEAT-0001), the "pick the next number" problem only gets worse — a single command that reserves the next global ID removes that friction entirely and eliminates an entire class of merge-conflict bugs around duplicate IDs. Without this command, humans scan directories, miscount, or collide with parallel work.

## Behavior

The user runs `specman new "<title>"` from within a repo. SpecMan:

1. Globs every `FEAT-NNNN-*.md` file under `specs/` recursively, ignoring `specs/assets/`.
2. Takes the maximum existing numeric suffix and adds one. If no specs exist, starts at `FEAT-0001`.
3. Derives a slug from the title — lowercased, non-alphanumeric runs collapsed to single hyphens, leading/trailing hyphens stripped.
4. Writes a new file at `specs/<FEAT-ID>-<slug>.md` as a **scaffold**: required frontmatter (`id`, `title`, `status: draft`, `depends_on: []`) and the two required section headings (`## Intent`, `## Acceptance criteria`) with empty bodies. The scaffold is intentionally not yet a valid spec under FEAT-0001 (which requires content in those sections) — `specman validate` will report it as incomplete until the author fills them in. The tool removes filename, ID, and frontmatter friction; only the author can supply intent and acceptance criteria, so it does not invent them.
5. Prints the resulting path to stdout.

Flags:

- `--group <name>` places the file at `specs/<name>/<FEAT-ID>-<slug>.md`, creating the folder if it does not exist.
- `--id FEAT-<NNNN>` forces a specific ID instead of auto-assigning. Fails if the ID is already in use.

The file is left on disk ready to edit. The command does not open an editor, does not prompt, and does not write anything outside the new spec file.

## Constraints

- ID assignment scans every `.md` file matching `FEAT-<NNNN>-*.md` under `specs/` recursively (excluding `specs/assets/`). Location does not affect identity.
- The newly-created file parses successfully under FEAT-0006 on first write. A `specman new` that produces an unparseable stub is a bug.
- Slug derivation is deterministic: the same title always produces the same slug.
- The command is non-interactive. No prompts, no tty requirement — suitable for scripts and CI.
- ID assignment is a read-scan-write sequence; it is not crash-safe across concurrent invocations. Two racing `specman new` calls in the same working tree may produce duplicate IDs — validate catches this, and humans resolve it. Preventing the race is out of scope at MVP.

## Examples

Creating a new top-level spec:

```
$ specman new "Password reset via email"
specs/FEAT-0009-password-reset-via-email.md
```

Creating a grouped spec when specs are organized by subfolder:

```
$ specman new "Sync command" --group cli
specs/cli/FEAT-0010-sync-command.md
```

Initial contents of a freshly-created scaffold — the required frontmatter plus the two required section headings, empty bodies, no placeholder markers. This is **not** yet a valid spec under FEAT-0001, and `specman validate` will flag it as incomplete; the author makes it valid by filling in the Intent and at least one acceptance criterion:

```markdown
---
id: FEAT-0010
title: Sync command
status: draft
depends_on: []
---

## Intent

## Acceptance criteria
```

Forcing an ID (e.g. restoring a deleted spec from history):

```
$ specman new "Reinstated feature" --id FEAT-0042
specs/FEAT-0042-reinstated-feature.md
```

## Acceptance criteria

- AC-1: Given no spec files exist in the repo, `specman new "<title>"` creates a file with id `FEAT-0001`.
- AC-2: Given existing specs with ids `FEAT-0001` through `FEAT-0007`, `specman new "<title>"` creates a file with id `FEAT-0008`.
- AC-3: Given existing specs scattered across subfolders under `specs/`, ID assignment scans recursively and picks `max + 1` across the whole tree.
- AC-4: Given `--group cli`, the new file is created at `specs/cli/<FEAT-ID>-<slug>.md`, creating the `cli/` directory if it does not already exist.
- AC-5: Given `--id FEAT-0042` where FEAT-0042 is already declared by another spec, the command exits non-zero with a clear error and creates no file.
- AC-6: Given `--id FEAT-0042` where FEAT-0042 does not exist, the new file is created with that exact id regardless of gaps.
- AC-7: Given a title containing punctuation, spaces, or mixed case, the filename slug contains only lowercase letters, digits, and single hyphens — with no leading or trailing hyphens.
- AC-8: Given a freshly-created scaffold, `specman validate` reports it as incomplete (empty required sections per FEAT-0001) and exits non-zero; the author resolves the finding by filling in the required sections.
- AC-9: Given a successful run, the created file path is written to stdout as a single line and nothing else is written to stdout.
- AC-10: Given `.md` files under `specs/assets/`, they are ignored during ID-scan so asset notes cannot collide with spec IDs.

## Out of scope

- Opening the new file in an editor. Authors pipe the printed path into whatever tool they prefer.
- Reserving IDs without creating a file.
- Migrating or reorganizing existing specs into subfolders. That is a one-shot manual task, not something the tool performs.
- Templates per group (e.g. different stub sections for UI vs. backend specs). Stubs are minimal and uniform.

## Non-goals

- No interactive prompt flow. The command takes its title and flags on the command line and exits — no tty assumptions, no confirmation dialogs.
- No concurrency guarantees. Two parallel `specman new` invocations may produce duplicate IDs; FEAT-0007 validation catches it. Adding locks or reservation would be premature.
- No implicit re-slugging on rename. If the author later edits the title, the filename does not silently change — filename drift is a human concern.
- No "smart" ID reuse of deleted specs. Ids are monotonic; deleted specs leave gaps, which is fine and clearer than reuse.

## Open questions

- Should `specman new` also print the assigned ID alone on stderr (alongside the full path on stdout) so scripts can capture either easily? *Decide after the first real scripting use case asks for it.*
- Should `--group` validate against a configured list of permitted groups? *Decide once projects start using groups in anger — a permitted-list prevents typos but adds config to maintain.*
- Should there be a `--dry-run` that prints the path without creating the file? *Defer until a concrete need surfaces; trivially additive later.*
