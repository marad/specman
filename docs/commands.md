# Command Reference

## specman init

Initialize SpecMan in the current directory.

```
specman init
```

Creates `specs/`, `.specman/`, `.specman/implemented/`, `.specman/plans/`. Purely additive — never deletes or overwrites. Idempotent — safe to run multiple times.

| Condition | Behavior |
|-----------|----------|
| Clean directory | Creates all 4 directories, exits 0 |
| Already initialized | Prints "Already initialized", exits 0 |
| Partial state | Creates only missing directories, exits 0 |
| Path conflict (file where dir expected) | Error, exits 1, creates nothing |
| No `.git` | Warning (sync/status need git), still creates, exits 0 |

---

## specman new

Create a new spec scaffold.

```
specman new "<title>" [--group <name>] [--id FEAT-NNNN]
```

| Flag | Description |
|------|-------------|
| `--group <name>` | Place file in `specs/<name>/`, creating the dir if needed |
| `--id FEAT-NNNN` | Force a specific ID instead of auto-assigning |

**ID assignment:** Scans `specs/` recursively for the highest existing `FEAT-NNNN` and assigns `max + 1`. IDs are never reused.

**Slug:** Derived from title — lowercase, non-alphanumeric → hyphens, no leading/trailing hyphens.

**Output:** Prints the created file path to stdout (single line, nothing else).

**Scaffold:** Required frontmatter + empty `## Intent` and `## Acceptance criteria`. Not yet valid per `specman validate` — the author fills in content.

| Exit code | Meaning |
|-----------|---------|
| 0 | File created |
| 1 | Missing title, ID collision, or other error |

---

## specman validate

Check specs for errors and warnings.

```
specman validate [--format=json] [--strict]
```

| Flag | Description |
|------|-------------|
| `--format=json` | Output as JSON with `summary` and `findings` array |
| `--strict` | Warnings cause non-zero exit (normally only errors do) |

**Checks performed:**

| Code | Severity | What |
|------|----------|------|
| E000 | error | Spec file fails to parse (malformed YAML, no frontmatter) |
| E001 | error | Duplicate `id` across files |
| E002 | error | Missing required frontmatter field (`id`, `title`, `status`, `depends_on`) |
| E003 | error | Wrong type for frontmatter field |
| E005 | error | Required section (`Intent`, `Acceptance criteria`) empty or missing |
| E006 | error | `depends_on` references nonexistent spec |
| E007 | error | Dependency cycle (length ≥ 2; self-refs ignored) |
| E008 | error | Duplicate AC ID within a single spec |
| E009 | error | Orphan snapshot (no matching spec) |
| E010 | error | Snapshot ID mismatch (filename vs content) |
| E011 | error | Orphan plan (no matching spec) |
| E012 | error | Invalid status value |
| W001 | warning | Filename doesn't match `<FEAT-ID>-<slug>.md` convention |

| Exit code | Meaning |
|-----------|---------|
| 0 | No errors (warnings allowed unless `--strict`) |
| 1 | Validation errors found |
| 2 | No `specs/` directory found |

---

## specman status

Show drift status of all specs.

```
specman status [--verbose | -v] [--diff]
```

| Flag | Description |
|------|-------------|
| `--verbose`, `-v` | Show all specs including in-sync ones |
| `--diff` | Include unified diff for drifted specs |

**Output format:**
```
FEAT-0001 drifted  (changed since last sync)
FEAT-0002 new      (no snapshot yet)
3 specs in-sync
```

Drift detection uses **canonical-form comparison**: the spec is parsed and re-serialized before comparing against the snapshot. This means formatting-only differences (frontmatter key order, blank lines) don't count as drift.

| Exit code | Meaning |
|-----------|---------|
| 0 | Always (status is informational) |

---

## specman sync

Sync drifted specs — generate plans, run verification, seal snapshots.

```
specman sync [<FEAT-ID>] [--dry-run]
```

| Flag | Description |
|------|-------------|
| `<FEAT-ID>` | Sync a single spec. Without it, syncs all drifted/new specs |
| `--dry-run` | Show what would be synced without generating plans |

**Single-spec sync:** Generates a plan scaffold targeting only changed ACs, writes it to `.specman/plans/<FEAT-ID>.md`.

**Multi-spec sync:** Processes specs in dependency order. If a spec fails, it and all transitive dependents are skipped; independent specs continue.

**Clean working tree required** at start, except uncommitted plan files in the sync scope.

| Exit code | Meaning |
|-----------|---------|
| 0 | Sync completed (or nothing to sync) |
| 1 | Error (dirty tree, parse failure, etc.) |

---

## specman seal

Seal a snapshot for editorial or initial changes.

```
specman seal <FEAT-ID> [--initial]
```

| Flag | Description |
|------|-------------|
| `--initial` | Create first snapshot for a `new` spec (no prior sync needed) |

**Without `--initial`:** Updates the snapshot for a `drifted` spec. Requires no AC-level drift (only prose/metadata changes). Refuses if ACs were added, removed, or changed.

**With `--initial`:** Creates the first snapshot for a `new` spec. Use when implementation was done outside SpecMan.

**Clean working tree required.**

| Exit code | Meaning |
|-----------|---------|
| 0 | Snapshot sealed |
| 1 | Error (AC drift, wrong status, dirty tree) |

---

## specman verify

Run a plan's verification commands standalone.

```
specman verify <FEAT-ID> [--plan <path>]
```

| Flag | Description |
|------|-------------|
| `--plan <path>` | Use a plan file at an arbitrary path |

Reads verification commands from the plan's `## Verification` section. Runs each sequentially via `sh -c`. Stops on first failure. Checks for dirty working tree after each command.

**Does not** write snapshots or create commits — purely diagnostic.

| Exit code | Meaning |
|-----------|---------|
| 0 | All commands passed, tree clean |
| 1 | Command failed, dirty tree, or no plan found |

---

## specman delete

Remove a spec and all tracked artifacts.

```
specman delete <FEAT-ID> [--dry-run]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be removed without deleting |

Removes:
- Spec file (`specs/**/<FEAT-ID>-*.md`)
- Snapshot (`.specman/implemented/<FEAT-ID>.md`)
- Plan (`.specman/plans/<FEAT-ID>.md`)
- Assets directory (`specs/assets/<FEAT-ID>/`)

Warns about dependent specs but proceeds. Non-interactive — no confirmation prompt (git is the undo mechanism).

| Exit code | Meaning |
|-----------|---------|
| 0 | Deleted (or dry-run completed) |
| 1 | Spec not found |
