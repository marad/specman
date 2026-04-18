---
id: FEAT-0010
title: Init command
status: draft
depends_on: []
---

## Intent

Give users a single command to bootstrap SpecMan in a repository — creating the directory layout every other command depends on, in a known state, with no surprises. Without it, every other command has to handle "what if the tree isn't set up yet?" either by refusing to run or by lazy-creating directories; both options spread the layout convention across every command instead of owning it in one place. `specman init` is also the first command a new user runs, so it doubles as the place to surface expected next steps.

## Behavior

The user runs `specman init` in any directory. SpecMan creates the following, if absent:

- `specs/`
- `.specman/`
- `.specman/implemented/`
- `.specman/plans/`

Each path that gets created is listed in the output. Paths already present are listed separately. When all four paths already exist as directories, the command reports the repo as already initialized and exits zero.

Init is purely additive: it never deletes, overwrites, or modifies existing content. No files are created inside any of the created directories — they start empty. The `.specman/` layout is designed to be committed to the repository entirely (snapshots per FEAT-0003, plans per FEAT-0009); init adds no `.gitignore` entries, because nothing in the layout is meant to be ignored.

Init does not require or create a git repository. If no `.git` directory is present at the working directory root, init succeeds but prints a warning naming the SpecMan commands that will need git to function (notably `specman sync` and `specman status`). Init does not invoke `git init` on the user's behalf — managing the repository is the user's choice.

After a successful init, output ends with a one-line hint pointing at `specman new` as the suggested next step.

## Constraints

- **Purely additive.** Creates directories only. Never deletes, overwrites, or modifies existing paths.
- **Idempotent.** Running `specman init` any number of times against an already-initialized repo is a no-op that exits zero.
- **Crash-safe.** If init fails partway (e.g. permission denied on one of the subdirectories), paths already created remain in place; a re-run picks up where the failure stopped and completes the remaining work.
- **No configuration file.** SpecMan has no per-project configuration at MVP; init does not write or read any config.
- **No file contents.** Every directory created by init is empty immediately after the call. No `.gitkeep`, no README, no placeholder.
- **No network, no subprocess invocation.** Filesystem operations only.
- **Works outside a git repository.** Init neither requires `.git` nor refuses to run without it; the warning is informational.

## Examples

Clean init in an empty directory that is already a git repository:

```
$ specman init
Created specs/
Created .specman/
Created .specman/implemented/
Created .specman/plans/
Next: specman new "<title>" to create your first spec.
```

Already-initialized repo:

```
$ specman init
Already initialized. Nothing to do.
```

Partial state — `specs/` already present, rest absent:

```
$ specman init
Already present: specs/
Created .specman/
Created .specman/implemented/
Created .specman/plans/
Next: specman new "<title>" to create your first spec.
```

Running outside a git repository:

```
$ specman init
Created specs/
Created .specman/
Created .specman/implemented/
Created .specman/plans/
warning: no .git directory found — specman sync and specman status require a git repository.
Next: specman new "<title>" to create your first spec.
```

Conflict — one of the target paths exists as a file, not a directory:

```
$ specman init
error: .specman exists but is a file, not a directory — refusing to overwrite
```

## Acceptance criteria

- AC-1: Given a directory with none of the SpecMan layout present, `specman init` creates `specs/`, `.specman/`, `.specman/implemented/`, and `.specman/plans/`, prints each as a created path, and exits zero.
- AC-2: Given a directory where all four target paths already exist as directories, `specman init` prints an "already initialized" message and exits zero without modifying anything on disk.
- AC-3: Given a directory where some target paths are present and others are absent, `specman init` creates only the missing ones, labels each path as either "created" or "already present", and exits zero.
- AC-4: Given any of the target paths exists as a non-directory (regular file, symlink to a non-directory, etc.), `specman init` exits non-zero with an error naming the conflicting path, and creates none of the remaining paths.
- AC-5: Given no `.git` directory exists at the working directory root, `specman init` still creates the layout, prints a warning naming the commands that will require git, and exits zero.
- AC-6: Given `specman init` has succeeded, re-invoking it is a no-op that exits zero with the "already initialized" message.
- AC-7: Given `specman init` fails partway through creation (e.g. permission denied on one subdirectory), paths already created persist, and a subsequent successful re-run completes the remaining paths without attempting to recreate the ones that already exist.
- AC-8: Given `specman init` succeeds, no file is created inside any of the created directories — they start empty.
- AC-9: Given `specman init` runs in a directory whose parent is a SpecMan-initialized repo (so `specs/` would shadow a parent's), it still creates the local layout without inspecting ancestors; SpecMan has no notion of inherited initialization.

## Out of scope

- Creating a first spec. `specman new` is the separate command for that.
- Running `git init` or otherwise manipulating the git repository.
- Writing `.gitignore` entries. The SpecMan layout is meant to be committed.
- Writing a configuration file or project metadata. SpecMan has no config at MVP.
- Creating `.gitkeep` or similar placeholders in empty directories. Directories enter version control when their contents do.
- Migrating an existing non-SpecMan spec tree into SpecMan's layout.

## Non-goals

- Not interactive. No prompts, no wizard, no "would you like to git init?" dialogue. Init reads its working directory and writes directories, nothing else.
- Not destructive under any flag. There is no `--force`, no `--reset`, no `--clean`. Users who want to wipe SpecMan state do it with `rm -rf` and git.
- Not a recovery tool. If the layout is damaged (e.g. `.specman/implemented/` was deleted but snapshot commits reference it), init will re-create the directory but will not attempt to restore its contents. Git history and `specman sync` are the right recovery paths.
- Not opinionated about the working directory. Init does not check whether it is being run at the repo root versus a subdirectory; it creates the layout relative to wherever it was invoked. Misplaced invocations are a user error caught by subsequent commands failing to find the expected layout.

## Open questions

- Should `specman init --in <path>` be supported for initializing a different directory without changing into it? *Defer — users can `cd`. Trivially additive later.*
- Should init detect an existing non-empty `.specman/` whose contents do not match SpecMan's expected layout (e.g. a different tool used the name)? *Decide if it collides with something concrete. Currently `.specman/` is unique enough that the case seems theoretical.*
- Should the "already initialized" exit code differ from the "created" exit code so scripts can distinguish? *Defer — both success states are currently exit zero, and no scripting use case has asked for the distinction.*
