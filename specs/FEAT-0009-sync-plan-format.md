---
id: FEAT-0009
title: Sync plan format
status: draft
depends_on: [FEAT-0001, FEAT-0003]
---

## Intent

Pin the shape of the implementation plan that sits between drift detection and code execution. FEAT-0004 treats the plan as a black box ("produce a plan, execute it, verify"); without a concrete format, the sync loop cannot be built, humans cannot reliably review what is about to happen, and the agent has no scaffold to fill in. The plan is the single artifact through which humans approve a sync, the agent coordinates its work, and FEAT-0004's verification step determines whether to seal the snapshot. It is also the audit trail: "what did we intend when we last synced this spec?" is answered by reading one file.

## Behavior

When `specman sync` runs against a drifted or new spec, SpecMan works with a plan file at `.specman/plans/<FEAT-ID>.md`. Only one plan per spec lives on disk at a time; history for successfully-sealed syncs is preserved in git via the snapshot commit (FEAT-0004).

### Resume vs regenerate

If the plan file already exists with uncommitted changes at sync start — the tell-tale of a prior sync that aborted or failed before sealing — SpecMan prompts the user to **resume** with the existing plan or **regenerate** it from scratch. Resume skips scaffolding and agent population, proceeding directly to the approval prompt with the existing file contents. Regenerate overwrites the plan with a fresh scaffold, then invokes the agent as normal.

If the plan file is absent or matches HEAD (meaning the last sync sealed cleanly and the committed artifact is still in place), no prompt appears; sync writes a fresh scaffold for the current drift, overwriting the HEAD plan as part of normal flow. The HEAD plan is not user state — it is a record of a completed past sync, and the new sync will produce its own record at seal.

Resume uses the plan file as the user last left it, regardless of whether the spec has drifted further since the plan was generated. If the spec's drift set has changed in the meantime, the approval-time scope check (AC-7) will reject the mismatch; the user then picks `re-plan` to regenerate approach (and should consider `abort` + fresh sync if the scaffold itself needs to change). On resumed execution, the agent operates against the current codebase state, which includes any commits from prior attempts; it is expected to recognize already-completed work and skip it.

### Authorship

Authorship is split:

- **SpecMan** writes the plan scaffold deterministically from the spec diff. It fills in the header, the drift summary, and one section per AC in the drift set (added, modified, or removed), with that AC's current text. This part is mechanical and testable without an agent in the loop.
- **The agent** populates the approach under each AC section — target files, intended changes, brief rationale — and proposes the verification block. The agent never adds or removes AC sections; it only fills in what SpecMan laid out.

After the plan is populated, SpecMan presents it to the user with three choices:

- **approve** — execution begins against the plan as it stands on disk (including any user edits).
- **re-plan** — the agent regenerates the approach, treating any user edits as hard constraints, and re-presents. The loop has no hard iteration cap.
- **abort** — sync exits cleanly; no code is committed.

The user may edit the plan file between presentation and approval. Edits to the **approach** — prose, file lists, verification steps — are accepted and respected. Edits that change the **scope** — adding an AC section, removing an AC section, changing an AC's ID — are rejected at approval time with a clear error. The spec is the source of truth for scope; to sync a different set of ACs, the user reverts the spec change and re-runs sync.

On successful execution, the plan file is committed as part of the snapshot commit (FEAT-0004) — the same single commit that writes `.specman/implemented/<FEAT-ID>.md`. On failure or abort, the plan file remains on disk at its last state but is not committed.

### Plan file structure

A plan file has the following sections, in this order:

1. **Header** — FEAT-ID, title, timestamp when sync started, snapshot state at sync start (`drifted` or `new`).
2. **Drift summary** — one-line counts: `N ACs added, N modified, N removed`.
3. **Per-AC sections** — one per AC in the drift set, titled `## AC-<N> (<added|modified|removed>): <AC text>`. Each contains:
   - For `modified`: a short note on what changed in the AC text.
   - **Approach** — prose describing what the agent intends to do for this AC.
   - **Files** — list of paths the agent expects to touch (new, modified, deleted).
4. **Cross-cutting** — a single section for work that cannot be attributed to a single AC (shared helpers touched by multiple ACs, refactors prerequisite to the plan). Commits for cross-cutting work carry multiple `Spec:` trailers, one per AC they serve. Often empty; omitted when empty.
5. **Verification** — a list of runnable checks (shell commands) that must all pass before the snapshot commit is written. These are what FEAT-0004's "verification passes" resolves to.

## Constraints

- **Plan parsing is structural and line-based.** SpecMan machine-parses the plan file using the following rules:
  - **AC sections**: any `##` heading matching `## AC-<N> (<type>): <text>` where `<N>` is an integer and `<type>` is one of `added`, `modified`, `removed`. The AC ID (`AC-<N>`) and type are extracted from the heading. Content between this heading and the next `##` heading is the section body.
  - **Verification commands**: under the `## Verification` heading, each bullet (`- `) whose text is a single backtick-delimited span (e.g. `` - `npm test` ``) is extracted as a runnable command. The text inside the backticks is the command string passed to the shell. Bullets without backtick-delimited commands are ignored (treated as commentary). Nested or fenced code blocks are not treated as commands.
  - **Scope check at approval**: SpecMan extracts the set of `(AC-ID, type)` pairs from AC section headings and compares it against the drift set. Any mismatch — missing section, extra section, changed ID or type — is a scope-change error.
- **Scope is locked to the spec diff.** The set of AC IDs appearing as sections in the plan must equal the set of AC IDs in the drift set. User edits that change this set are rejected at approval.
- **Approach is editable.** Prose, file lists, and verification steps may be freely edited by the user before approval; accepted edits constrain the agent on re-plan and bind execution on approve.
- **SpecMan owns the scaffold; the agent owns the approach.** SpecMan's writes are deterministic and reproducible from the spec diff alone. No agent call is required to produce the scaffold.
- **One plan per spec on disk.** Only a single plan file per spec ever exists on disk. A sync that finds the file with uncommitted changes prompts resume-or-regenerate before overwriting; on resume the file is used as-is, on regenerate it is overwritten. No plan archives, no timestamped variants — history lives in git via the snapshot commit.
- **Resume skips the agent.** On resume, SpecMan makes no scaffold rewrite and no agent call. The existing file content goes directly to the approval prompt. Re-plan and the re-plan → agent call are available from that prompt exactly as in a non-resume flow.
- **Plan file is committed iff the sync seals.** The snapshot commit includes both `.specman/implemented/<FEAT-ID>.md` and `.specman/plans/<FEAT-ID>.md`. On failure or abort, neither file lands in a commit during this sync.
- **Re-plan is unlimited.** No maximum iteration count. The user keeps re-planning until they approve or abort.
- **Format is markdown only.** No JSON variant. Plans are human-reviewed artifacts; machine consumers read markdown.
- **Verification is declared, not inferred.** Whatever commands appear in the Verification section are exactly what execution runs. No hidden fallbacks, no auto-injected lint or type-check unless the plan says so.
- **Verification must be non-empty at approval.** A plan whose `## Verification` section contains zero runnable commands cannot be approved — the user must add at least one command or abort. Empty verification would make "verification passed" a silent no-op; requiring an explicit command (even `true` for a user who genuinely wants no check) forces intentionality.

## Examples

A plan file for a sync with one modified AC and one added AC:

```markdown
# Sync plan — FEAT-0042 Password reset via email

Started: 2026-04-17T14:30:00Z
Snapshot state: drifted
Drift summary: 1 modified, 1 added, 0 removed

## AC-1 (modified): Given a registered email, a reset link is delivered within 1 minute

Change: delivery window tightened from 5 minutes to 1 minute.

Approach: reduce SMTP queue debounce from 30s to 5s; add a p99-latency test
covering the new ceiling.

Files:
- modified: src/auth/reset.ts
- modified: src/auth/queue.ts
- new:      tests/auth/reset-latency.test.ts

## AC-3 (added): Given three failed reset attempts in 10 minutes, block further attempts for 1 hour

Approach: new rate-limiter keyed on the email hash, backed by existing Redis.
Enforcement happens in the reset handler before any email is dispatched.

Files:
- modified: src/auth/reset.ts
- new:      src/auth/rate-limit.ts
- new:      tests/auth/rate-limit.test.ts

## Verification

- `npm test -- src/auth`
- `npm run lint -- src/auth`
```

A scope-change rejection at approval:

```
$ specman sync FEAT-0042
Plan written to .specman/plans/FEAT-0042.md.
[a]pprove / [r]e-plan / a[b]ort: a

error: plan scope changed since scaffold
  plan now declares ACs: {AC-1, AC-3, AC-7}
  spec drift set is:     {AC-1, AC-3}
  AC-7 is not in the drift set — remove its section, or revert the
  corresponding change in specs/FEAT-0042-password-reset-via-email.md
```

A new (greenfield) spec plan:

```markdown
# Sync plan — FEAT-0099 Account settings screen

Started: 2026-04-17T15:02:00Z
Snapshot state: new
Drift summary: 4 added (whole spec)

## AC-1 (added): ...
...
```

## Acceptance criteria

- AC-1: Given a drifted or new spec, `specman sync` ensures a plan file exists at `.specman/plans/<FEAT-ID>.md` before presenting anything to the user — either by writing a fresh scaffold, or (on resume) by preserving the existing file as-is.
- AC-2: Given the plan scaffold produced by SpecMan, it contains exactly one `## AC-<N> (<type>): ...` section per AC in the drift set, with AC text quoted from the current spec, and contains a `## Verification` section (possibly empty pending agent population).
- AC-3: Given a spec with `new` snapshot state, every AC in the current spec appears as an `added` section in the plan.
- AC-4: Given the agent populates the plan, each AC section contains a non-empty `Approach` and a `Files` list; the `## Verification` section contains at least one command.
- AC-5: Given the plan is presented to the user, the three available choices are `approve`, `re-plan`, and `abort`; any other input is rejected and re-prompted.
- AC-6: Given the user edits approach prose, file lists, or verification commands under existing AC sections, and then approves, execution proceeds against the edited plan.
- AC-7: Given the user edits the plan to add an AC section not in the drift set, remove an AC section that is in the drift set, or rename an AC's ID, and then approves, approval is rejected with a scope-change error naming the specific AC-ID mismatches and pointing to the remediation: abort and re-run `specman sync <ID>` for a fresh plan. The same error and remediation applies when the spec itself was edited since plan generation — no separate mechanism is needed.
- AC-8: Given `re-plan` is selected, the agent regenerates the Approach and Verification contents, treating any user-authored edits as constraints (it does not undo them silently), and the plan file is re-presented for approval.
- AC-9: Given `re-plan` is selected an arbitrary number of times, no hard iteration limit applies; the loop ends only when the user selects `approve` or `abort`.
- AC-10: Given `abort` is selected, sync exits cleanly with a non-error status distinguishable from a failure; no code is committed during this sync.
- AC-11: Given a successful sync, `.specman/plans/<FEAT-ID>.md` and `.specman/implemented/<FEAT-ID>.md` are both written as part of the single snapshot commit (FEAT-0004 AC-3), with no intermediate commit containing one but not the other.
- AC-12: Given a sync that fails verification or is aborted after plan approval, the plan file may remain on disk but is not included in any commit authored during this sync.
- AC-13: Given FEAT-0004's execution step invokes verification, the commands it runs are exactly those listed in the plan's `## Verification` section, in the order listed, and execution fails if any one exits non-zero.
- AC-14: Given the user edits the plan to leave the `## Verification` section with zero runnable commands, and then approves, approval is rejected with an error naming the empty-verification requirement.
- AC-15: Given sync starts on a spec whose plan file at `.specman/plans/<FEAT-ID>.md` has uncommitted changes relative to HEAD, SpecMan prompts the user to choose `resume` or `regenerate` before any scaffolding or agent call occurs.
- AC-16: Given `resume` is selected at the prompt in AC-15, the existing plan file is used verbatim: no scaffold rewrite, no agent population call, and flow proceeds directly to the approval prompt (AC-5).
- AC-17: Given `regenerate` is selected at the prompt in AC-15, the plan file is overwritten with a fresh scaffold and the normal scaffold+populate flow runs, culminating in the approval prompt.
- AC-18: Given sync starts on a spec whose plan file is absent or byte-identical to its HEAD version, no resume prompt occurs; a fresh scaffold is written and the normal scaffold+populate flow runs.

## Out of scope

- UI beyond the CLI approval loop. The editor (FEAT-0002) may eventually surface plans, but this spec governs the file format only.
- Plan history beyond git — no `.specman/plans/history/` or timestamped copies.
- JSON or other machine-first variants of the plan.
- Preventing the user from introducing contradictions in edits (e.g. editing an AC's approach to implement a different AC). Garbage-in-garbage-out; the spec is the authority on what each AC means.
- Automatic discovery of tests or lint commands to populate `## Verification`. The agent proposes them from project context; the user confirms or edits.

## Non-goals

- No scope expansion through plan edits. If a user wants to sync a different AC set, they edit the spec, not the plan. Allowing plan edits to expand scope would let humans silently override drift detection.
- No templates or user-customizable scaffolds. SpecMan owns the scaffold shape so every plan is parseable and reviewable by the same rules.
- No multi-plan sessions. One spec per sync invocation (FEAT-0004 non-goal), therefore one plan per invocation.
- No plan rollback or "undo" after approval. Approve means execute; abort means stop. There is no "abort-after-approve" state distinct from execution failure.
- No silent regeneration on re-plan that discards user edits. Re-plan treats user edits as constraints, not suggestions — otherwise the editing affordance is meaningless.

## Open questions

- **What counts as a scope-preserving edit at the margin?** An AC section whose heading the user slightly reformats, a Files list the user empties, an Approach the user replaces with `TODO` — all still in scope, but each creates a degenerate execution. *Current rule: scope check is purely structural (set of AC IDs and their "type" marker). Content inside sections is the user's responsibility. Revisit if real-world use produces a confusing class of degenerate plans.*
- **Scaffold and populate in two calls or one?** SpecMan can write the scaffold, then call the agent to populate approach + verification; or hand both tasks off in a single agent call. *Decide during implementation — the external contract (the final plan file) is the same either way.*
- **Should removed-AC sections carry an `Approach` at all?** "Remove the code that used to implement this" is the approach, but it is inherently less file-specific. *Keep Approach required for now; revisit once we see real removed-AC plans in practice.*
- **Off-limits paths declared by the user?** A `## Do not touch` section in plans could let users fence off directories. *Defer — users can achieve the same effect by editing the Files lists. Add only if real syncs demonstrate a need.*
- **Should `--resume` / `--regenerate` flags exist for scripted use?** The prompt is interactive by default; scripted callers currently need to pipe input. *Defer — add flags when a concrete automation use case surfaces.*
