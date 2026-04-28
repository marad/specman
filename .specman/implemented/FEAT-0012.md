---
id: FEAT-0012
title: Verify command
status: draft
depends_on: [FEAT-0004, FEAT-0009]
---

## Intent

Let users run a plan's verification commands independently of the sync loop. During development, the author often wants to check whether the implementation satisfies the plan's verification section without going through the full sync → approve → execute → verify → seal cycle. This is especially useful when the agent has finished work and the user wants to manually confirm before sealing, or when debugging a verification failure from a prior sync attempt.

Without a standalone verify command, the only way to run verification is to re-enter the sync loop — which may regenerate plans, prompt for approval, and invoke the agent, all of which are unnecessary when the user just wants to re-run the checks.

## Behavior

`specman verify <FEAT-ID>` reads the plan file at `.specman/plans/<FEAT-ID>.md`, extracts the verification commands from the `## Verification` section (per FEAT-0009's parsing rules), and runs them sequentially from the repository root using the user's shell environment.

Each command runs via the user's shell (`sh -c` on Unix). Commands execute in the order listed. If a command exits non-zero, execution stops immediately — remaining commands do not run. The failing command's stdout, stderr, exit code, and the command string are printed.

After each command, `specman verify` checks `git status --porcelain`; if the working tree has new uncommitted changes, verification fails with a dirty-tree error (same behavior as FEAT-0004 AC-12).

If all commands pass and the tree remains clean, verify prints a success summary and exits zero. The command does **not** write any snapshot or create any commit — it is purely diagnostic.

If no plan file exists for the given FEAT-ID, the command exits non-zero with a clear error.

If the plan's `## Verification` section has no runnable commands (no backtick-delimited bullets), the command exits non-zero with an error rather than silently "passing" an empty suite.

### Flags

- `--plan <path>` — use a plan file at an arbitrary path instead of the default `.specman/plans/<FEAT-ID>.md`. Useful for testing plan drafts before writing them to the canonical location.

## Acceptance criteria

- AC-1: Given a plan file with two verification commands that both exit zero and leave the tree clean, `specman verify <FEAT-ID>` prints a success summary and exits zero.
- AC-2: Given a plan file whose second verification command exits non-zero, `specman verify` stops after the second command, prints the failure details (command, exit code, stdout, stderr), and exits non-zero.
- AC-3: Given a verification command that creates uncommitted files, `specman verify` fails with a dirty-tree error after that command.
- AC-4: Given no plan file exists for the given FEAT-ID, the command exits non-zero naming the missing plan path.
- AC-5: Given a plan file with no runnable verification commands (empty or commentary-only `## Verification`), the command exits non-zero with an empty-verification error.
- AC-6: Given `--plan ./my-plan.md`, the command reads verification commands from that path instead of the default location.
- AC-7: `specman verify` does not write any snapshot, create any commit, or modify any file. It is read-only except for whatever side effects the verification commands themselves produce (which are then detected by the dirty-tree check).

## Out of scope

- Running verification for all specs at once. Verify takes a single FEAT-ID.
- Automatic remediation of verification failures.
- Timeout or resource limits on verification commands.
- Capturing verification output to a file or structured format.

## Non-goals

- Not a replacement for `specman sync` verification. The sync loop's verification has the same behavior but additionally gates the snapshot commit. `specman verify` is the same check without the commit gate.
- Not a test runner. It runs arbitrary shell commands listed in the plan; it doesn't discover or organize tests.
