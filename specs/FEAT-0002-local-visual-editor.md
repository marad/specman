---
id: FEAT-0002
title: Local visual spec editor
status: draft
depends_on: [FEAT-0001]
---

## Intent

Let users author and edit specifications without needing to hand-write YAML frontmatter or remember section conventions. The editor is the primary authoring surface for non-technical contributors and reduces friction for everyone else. It runs locally, served from within the user's own repository, so specs never leave the user's machine and git remains the source of truth.

## Behavior

The user runs a command (e.g. `specman dev`) inside a repository that contains a `specs/` folder. SpecMan starts a local web server and opens the default browser. The UI presents:

- A **list view** of all specs in the repo, showing id, title, and status at minimum.
- An **editor view** for a single spec: frontmatter rendered as a structured form (inputs per field, with validation), and the markdown body rendered in an editor that is comfortable for prose authoring.

Saves write back to the file on disk. The server watches the filesystem so external edits (git pull, direct file edit) are reflected in the UI without silently losing unsaved in-memory work. The editor optimizes for the spec format specifically, with first-class affordances for acceptance criteria (add/reorder/renumber) and dependency references.

The body editor is a structured markdown editor rather than full WYSIWYG: it produces clean, diffable markdown source, because specs are version-controlled artifacts and WYSIWYG tools routinely mangle source layout in ways that pollute git history.

## Constraints

- No data leaves the user's machine. The server binds to localhost only; no outbound telemetry, analytics, or network calls.
- Unsaved edits are never silently discarded. Any state-shifting event — external file change, window close, navigation away — surfaces an explicit choice to the user.
- Editor output must round-trip through the FEAT-0001 parser byte-identically when no semantic change has occurred. A no-op edit must produce a no-op diff.
- AC IDs remain stable across edits: adding or removing one AC must never renumber the others.

## Examples

Typical authoring flow:

1. User runs `specman dev` in the repo root. Browser opens to `http://localhost:<port>/`.
2. List view shows every spec with id, title, and status.
3. User selects `FEAT-0042`. The editor view opens with frontmatter on top as a form (id read-only, title editable, status as a dropdown) and body sections rendered below.
4. User edits the Intent prose and adds a new AC. The new AC appears as `AC-<next>`; existing ACs are untouched.
5. User saves. The file on disk is updated with a diff-clean markdown serialization.
6. `git status` shows one file changed with a minimal, readable diff.

## Acceptance criteria

- AC-1: Given a repo with a `specs/` folder, running `specman dev` starts a local HTTP server and opens the default browser to its root URL.
- AC-2: Given the list view, every valid spec file in `specs/` appears with its id, title, and status; invalid files appear with a clear error marker.
- AC-3: Given a user edits a spec and triggers save, the file on disk contains the changes within one second and remains format-valid.
- AC-4: Given a spec file is changed on disk by an external process while the editor is open, the editor surfaces the external change and offers to reload without silently discarding the user's unsaved edits.
- AC-5: Given the user adds or removes an acceptance criterion, ACs remain uniquely numbered and the IDs of unaffected ACs do not change.
- AC-6: Given the user references a non-existent spec ID in `depends_on`, the editor flags the reference as invalid.
- AC-7: Given a malformed spec file, the editor opens it in a raw-text fallback mode so the user can repair it without data loss.
- AC-8: Given a spec opened and saved with no user edits, the on-disk file is byte-identical to its previous contents.

## Out of scope

- Remote or multi-user editing — single user, localhost only.
- Running the agent sync loop from inside the editor UI (that lives in FEAT-0004 and is CLI-first for now).
- Rendering or authoring generic markdown documents outside the spec format.

## Non-goals

- Not a cloud service. Even optional cloud sync is explicitly not wanted — git already serves that need and adding a second sync channel splits the source of truth.
- Not a full markdown IDE. Features that make sense for general prose (complex tables, embedded media, plugin systems) are out — the editor targets specs only.
- No authentication, accounts, or user management. The server trusts its local user by virtue of being local.

## Open questions

- Should the editor embed a preview of the rendered spec, or is the editor view itself preview enough? *Decide after dogfooding on ≥5 real specs — pick whichever reduces perceived friction in practice.*
- Do we need offline-first behavior (service worker, etc.) or is "the server is local, it's always available" sufficient? *Decide once users report the local server was unexpectedly unreachable; lean always-local for MVP.*
