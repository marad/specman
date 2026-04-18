---
id: FEAT-0004
title: Agent sync workflow
status: draft
depends_on: [FEAT-0001, FEAT-0003, FEAT-0009]
---

## Intent

Turn spec changes into code changes through an agent-driven workflow. This is the payoff feature — the reason SpecMan exists at all. Given a drifted spec, an agent reads the diff between the last-implemented snapshot and the current spec, derives which code is relevant to each changed acceptance criterion from git history (prior commits carrying a `Spec:` trailer for that AC), produces a plan keyed to changed ACs, and executes the plan against the codebase. When the plan succeeds, the new snapshot is written, sealing the implementation.

The AC-to-code mapping is derived, never stored. A separately-maintained manifest would be a second source of truth that silently diverges on refactors; commit trailers record what actually happened and remain correct without bookkeeping.

## Behavior

The user invokes `specman sync` (optionally scoped to a single spec id) from within a repo. For each drifted spec in scope, SpecMan:

1. Loads the current spec and its last-implemented snapshot from `.specman/implemented/<FEAT-ID>.md` (FEAT-0003).
2. Computes the diff, specifically identifying which acceptance criteria were added, removed, or changed.
3. Derives the candidate scope — the set of code paths historically associated with each changed AC — by running `git log --grep='Spec: <FEAT-ID>/<AC-ID>' --name-only` per affected AC and intersecting with paths that still exist. This scopes the agent's attention; it is a starting point, not authoritative, and the agent may read additional files as needed.
4. Produces (or resumes) an implementation plan at `.specman/plans/<FEAT-ID>.md` — structured per FEAT-0009, keyed to AC ids. If a prior aborted sync left an uncommitted plan file, SpecMan prompts the user to `resume` (use it as-is) or `regenerate` (overwrite) per FEAT-0009. Otherwise, SpecMan writes a fresh scaffold and the agent populates approach and verification on top.
5. Presents the plan to the user with three choices — `approve`, `re-plan`, `abort` — per FEAT-0009. Re-plan regenerates the approach treating user edits as constraints and re-presents; the loop has no iteration cap.
6. On approval, executes the plan. On success, writes the plan file and the spec snapshot in a single commit. On failure or abort, neither file is committed during this sync; the snapshot remains unchanged so the next invocation retries cleanly.

### Commit structure

A single sync invocation may produce any number of commits. The agent authors commits as it works — typically one per AC or per logical change — with a `Spec: <FEAT-ID>/<AC-ID>` trailer identifying which criterion drove the change. SpecMan itself authors exactly one commit per sync: the **snapshot commit**, which writes `.specman/implemented/<FEAT-ID>.md`. The snapshot commit is always the last commit of the sync, and is only created if verification passes.

This gives atomicity at the state-machine level rather than the git level: a spec is implemented iff its snapshot matches. If a sync aborts partway through, intermediate code commits may exist in history, but without the snapshot commit the spec is still reported as drifted — and a subsequent `specman sync` can resume against the partial state.

A brand-new feature (status `new` per FEAT-0003 — no snapshot exists) is treated as a full greenfield implementation: the whole spec is the delta.

### Verification

After the last agent-authored code commit and before the snapshot commit, SpecMan runs the commands listed in the plan's `## Verification` section (FEAT-0009). Commands execute sequentially in the order listed, from the repository root, using the user's shell environment as inherited at sync invocation. A command that exits non-zero fails verification immediately; remaining commands are not run, and the failing command's stdout, stderr, and exit code are surfaced to the user.

Verification must not leave the working tree dirty. After each verification command completes, SpecMan checks `git status --porcelain`; any new uncommitted changes cause verification to fail. This catches two failure modes at once: verification commands with side effects beyond their declared purpose (so the snapshot would otherwise capture unintended state), and tests that write fixtures or generated artifacts the agent should have committed earlier.

Verification operates on the post-execution state — it observes the result of every agent commit produced during the sync. If verification passes, the snapshot commit lands; if it fails, no snapshot commit is created and the sync halts per AC-4.

## Constraints

- The snapshot commit is always the final commit of a sync invocation. No code commit may follow the snapshot commit within the same sync.
- Every agent-authored code commit carries a `Spec: <FEAT-ID>/<AC-ID>` trailer naming at least one AC it addresses. Uncredited commits are a sync bug — the trailer is the sole substrate from which future syncs derive AC-to-code scope, so omissions silently degrade scoping over time.
- The user reviews the plan (FEAT-0009) and must explicitly approve before any code change is committed. `re-plan` and `abort` are also available; approval is the only path to execution.
- On any failure path — agent error, verification failure, user abort — the snapshot does not advance. Any agent-authored code commits that landed before the failure remain in history with their `Spec:` trailers intact, so a subsequent sync can see the partial work.
- Only one spec is synced at a time; cross-spec reasoning within a single sync invocation is forbidden (see Non-goals).
- Sync requires a clean working tree at start, with one exception: an uncommitted `.specman/plans/<target-FEAT-ID>.md` is permitted because it signals a prior aborted sync and triggers the resume flow (FEAT-0009). Any other dirty path causes sync to exit with an error naming the paths before producing a plan or invoking the agent. The exception preserves the verification-dirty-tree check's meaning: every non-plan working-tree change observed during sync was produced by the sync itself.

## Examples

Sync of a spec with two changed ACs produces a commit sequence like:

```
feat: validate email format on reset request

Spec: FEAT-0042/AC-1

feat: expire reset links after one hour

Spec: FEAT-0042/AC-2

test: cover expired-link rejection path

Spec: FEAT-0042/AC-2

[specman] seal FEAT-0042 (implemented snapshot @ sync)
```

The first three commits are authored by the agent; the final snapshot commit is authored by SpecMan and updates `.specman/implemented/FEAT-0042.md`. If verification had failed after the second commit, the sync would stop, no snapshot commit would be created, and the spec would remain `drifted` until a subsequent sync.

## Acceptance criteria

- AC-1: Given a drifted spec, `specman sync <id>` produces a plan in which each entry references at least one AC id from the spec.
- AC-2: Given no drift in the target spec(s), `specman sync` is a no-op and exits successfully with a message naming the in-sync specs.
- AC-3: Given a successful execution, the snapshot file (per FEAT-0003) and the plan file (per FEAT-0009) are both written as part of a single commit — the snapshot commit — that is the last commit of the sync invocation. No further code changes land after the snapshot commit within the same sync.
- AC-4: Given a failed execution — agent error, verification failure, or explicit user abort — no snapshot commit is created. Intermediate code commits authored by the agent before the failure remain in history with their `Spec:` trailers intact, and the spec continues to report as drifted until a subsequent sync completes.
- AC-5: Given a spec with no existing snapshot (status `new` per FEAT-0003), the agent receives the full current spec as the delta (not a diff against nothing).
- AC-6: Given a plan produced in step 4, the user is shown the plan before execution and must choose one of `approve`, `re-plan`, or `abort` (per FEAT-0009); execution begins only on approval.
- AC-7: Given `specman sync` with no id argument, every drifted spec in the repo is processed in dependency order (using `depends_on`), one at a time.
- AC-8: Given any code commit produced by the agent during sync, its commit message contains a `Spec: <FEAT-ID>/<AC-ID>` trailer identifying at least one AC the commit addresses.
- AC-9: Given the snapshot commit produced by a successful sync, its commit message is authored by SpecMan (not the agent) and follows a stable template identifying the sealed spec.
- AC-10: Given execution reaches verification, each command from the plan's `## Verification` section runs sequentially in the listed order, from the repository root, using the user's shell environment as inherited at sync invocation.
- AC-11: Given a verification command exits non-zero, no further verification commands run, no snapshot commit is created, and the failing command's stdout, stderr, exit code, and the command string itself are surfaced to the user.
- AC-12: Given a verification command leaves new uncommitted changes in the working tree (detected via `git status --porcelain` after the command completes), verification is treated as failed; no snapshot commit is created.
- AC-13: Given every verification command exits zero and the working tree remains clean throughout, SpecMan proceeds to write the snapshot commit.
- AC-14: Given `specman sync <ID>` invoked while the working tree has uncommitted changes outside of `.specman/plans/<ID>.md`, sync exits with an error naming the dirty paths before producing a plan or invoking the agent. An uncommitted `.specman/plans/<ID>.md` alone is permitted and triggers the resume flow (FEAT-0009).

## Out of scope

- Automatic conflict resolution when multiple specs change overlapping code — surface a warning, defer to the human.
- Autonomous "watch mode" that syncs on every save.
- Rollback of partially-applied code changes beyond what git itself provides.
- The agent runtime itself (prompt engineering, model choice, SDK integration). SpecMan's contract is "produce a plan, execute it, verify" — the mechanism is a black box at this layer.

## Non-goals

- No cross-spec reasoning within a single sync. One spec at a time, full stop — otherwise plan scope and blast radius become unpredictable.
- No silent code changes. Every edit is part of a plan the user approved. Agents never commit work that wasn't in an approved plan.
- No rewriting or amending of agent-authored code commits after the fact. History is append-only; the snapshot commit is the only post-hoc summary.
- No partial-success snapshots. Implementation is all-or-nothing per spec; a half-sealed spec would give drift detection a false signal.

## Open questions

- Where does the agent actually run? CLI-embedded (SpecMan invokes an SDK directly) vs. "SpecMan writes a prompt file and the user runs it in Claude Code." *Decide before MVP ships: prompt-generation is cheaper and exposes the contract cleanly; revisit once manual-prompting friction is concrete.*
- Does the trailer-derivation scope degrade on long-lived repos where ACs accumulate many historical touches that are no longer relevant? *Decide once a real repo exhibits the problem. Mitigations if it appears: recency weighting, intersecting with files-currently-touched-by-the-spec's-changed-ACs-only, or promoting a stored index — but only when the pain is concrete.*
