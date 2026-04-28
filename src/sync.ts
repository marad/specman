/**
 * FEAT-0004: Agent sync workflow
 *
 * Orchestrates spec-to-code sync: drift detection → plan generation →
 * verification → snapshot seal. The interactive approval loop and
 * agent invocation are out of scope; this module handles everything
 * SpecMan owns directly.
 */

import * as path from "@std/path";
import {
  parse,
  isParsedSpec,
  serialize,
  type ParsedSpec,
} from "./parser.ts";
import {
  detectDrift,
  writeSnapshot,
  toCanonicalForm,
  getStatus,
  type SpecStatus,
} from "./snapshot.ts";
import {
  computeDriftSet,
  generatePlan,
  loadDriftSet,
  writePlan,
  readPlan,
  planExists,
  planHasUncommittedChanges,
  parsePlan,
  isParsedPlan,
  formatDriftSummary,
  type DriftEntry,
} from "./plan.ts";
import { walkSpecFiles } from "./specs.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of a single verification command */
export interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Result of running the full verification suite */
export interface VerificationResult {
  passed: boolean;
  results: VerificationCommandResult[];
  /** If failed due to dirty tree, the paths that were dirty */
  dirtyPaths?: string[];
  /** The specific failure reason if not a command failure */
  failureReason?: string;
}

/** Result of the trailer check */
export interface TrailerCheckResult {
  passed: boolean;
  /** Commits missing a matching trailer */
  offenders: Array<{ hash: string; message: string }>;
}

/** Result of a single spec sync */
export interface SyncOneResult {
  featId: string;
  outcome:
    | "in-sync"       // no drift, nothing to do
    | "no-ac-drift"   // drifted but no AC changes
    | "plan-written"  // plan scaffold generated (agent/approval pending)
    | "sealed"        // verification passed, snapshot written
    | "verification-failed"
    | "trailer-check-failed"
    | "error";
  message: string;
  /** Populated if plan was written */
  planPath?: string;
  /** Populated on verification failure */
  verificationResult?: VerificationResult;
  /** Populated on trailer check failure */
  trailerResult?: TrailerCheckResult;
}

/** Result of multi-spec sync */
export interface SyncAllResult {
  results: SyncOneResult[];
  skipped: Array<{ featId: string; reason: string }>;
}

/** Result of seal command */
export interface SealResult {
  outcome: "sealed" | "error";
  message: string;
}

// ─── Working tree check ─────────────────────────────────────────────────────

/**
 * Get the list of dirty paths in the working tree via `git status --porcelain`.
 * Returns an array of relative paths. Empty array means clean.
 */
export function getDirtyPaths(root: string): string[] {
  // Use -uall to show individual untracked files, not collapsed directories
  const result = runGitCommand(root, ["status", "--porcelain", "-uall"]);
  if (!result.success) {
    return []; // if git is not available, treat as clean
  }
  const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
  return lines.map((l) => {
    // porcelain format: XY PATH or XY ORIG -> PATH (for renames)
    const rest = l.slice(3);
    // Handle renames: "R  old -> new"
    const arrowIdx = rest.indexOf(" -> ");
    return (arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest).trim();
  });
}

/**
 * Check the working tree for uncommitted changes.
 * Allows specific paths (plan files) to be dirty.
 *
 * Returns null if clean (or only allowed paths are dirty),
 * or an array of disallowed dirty paths.
 */
export function checkWorkingTree(
  root: string,
  allowedPaths: string[],
): string[] | null {
  const dirty = getDirtyPaths(root);
  if (dirty.length === 0) return null;

  const allowed = new Set(allowedPaths.map((p) => p.replace(/\\/g, "/")));
  const disallowed = dirty.filter((p) => {
    const normalized = p.replace(/\\/g, "/");
    return !allowed.has(normalized);
  });

  return disallowed.length > 0 ? disallowed : null;
}

// ─── Git helpers ────────────────────────────────────────────────────────────

interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a git command synchronously in the given directory.
 */
export function runGitCommand(root: string, args: string[]): GitResult {
  try {
    const cmd = new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const output = cmd.outputSync();
    const decoder = new TextDecoder();
    return {
      success: output.success,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      code: output.code,
    };
  } catch {
    return {
      success: false,
      stdout: "",
      stderr: "git command failed to execute",
      code: -1,
    };
  }
}

/**
 * Get the current HEAD commit hash.
 */
export function getHead(root: string): string | null {
  const result = runGitCommand(root, ["rev-parse", "HEAD"]);
  if (!result.success) return null;
  return result.stdout.trim();
}

/**
 * Get all commits between startRef (exclusive) and HEAD (inclusive).
 * Returns array of { hash, message } in chronological order.
 */
export function getCommitsSince(
  root: string,
  startRef: string,
): Array<{ hash: string; message: string }> {
  // First get the list of commit hashes
  const hashResult = runGitCommand(root, [
    "log",
    `${startRef}..HEAD`,
    "--format=%H",
    "--reverse",
  ]);
  if (!hashResult.success) return [];

  const hashes = hashResult.stdout.trim().split("\n").filter((l) => l.length >= 7);
  const commits: Array<{ hash: string; message: string }> = [];

  for (const hash of hashes) {
    // Get the full message for each commit
    const msgResult = runGitCommand(root, [
      "log",
      "-1",
      "--format=%B",
      hash,
    ]);
    const message = msgResult.success ? msgResult.stdout.trim() : "";
    commits.push({ hash: hash.trim(), message });
  }

  return commits;
}

/**
 * Check that every commit since startRef carries at least one
 * `Spec: <FEAT-ID>/<AC-ID>` trailer matching the synced spec.
 */
export function checkTrailers(
  root: string,
  featId: string,
  startRef: string,
): TrailerCheckResult {
  const commits = getCommitsSince(root, startRef);
  const trailerRe = new RegExp(`Spec:\\s*${featId}/AC-\\d+`);

  const offenders: Array<{ hash: string; message: string }> = [];
  for (const commit of commits) {
    if (!trailerRe.test(commit.message)) {
      offenders.push(commit);
    }
  }

  return {
    passed: offenders.length === 0,
    offenders,
  };
}

/**
 * Derive candidate scope — code paths associated with changed ACs —
 * via `git log --grep='Spec: <FEAT-ID>/<AC-ID>' --name-only`.
 */
export function deriveScope(
  root: string,
  featId: string,
  acIds: string[],
): Map<string, string[]> {
  const scopeMap = new Map<string, string[]>();

  for (const acId of acIds) {
    const grepPattern = `Spec: ${featId}/${acId}`;
    const result = runGitCommand(root, [
      "log",
      `--grep=${grepPattern}`,
      "--name-only",
      "--format=",
    ]);

    if (!result.success) {
      scopeMap.set(acId, []);
      continue;
    }

    const paths = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Intersect with paths that still exist
    const existing = paths.filter((p) => {
      try {
        Deno.statSync(path.join(root, p));
        return true;
      } catch {
        return false;
      }
    });

    // Deduplicate
    scopeMap.set(acId, [...new Set(existing)]);
  }

  return scopeMap;
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Run verification commands sequentially from the repository root.
 *
 * Each command runs in the user's shell environment. A non-zero exit
 * code fails immediately. After each command, the working tree is
 * checked for cleanliness.
 */
export function runVerification(
  root: string,
  commands: string[],
): VerificationResult {
  const results: VerificationCommandResult[] = [];

  for (const command of commands) {
    // Run the command via shell
    const cmdResult = runShellCommand(root, command);
    results.push(cmdResult);

    // Check exit code (AC-11)
    if (cmdResult.exitCode !== 0) {
      return {
        passed: false,
        results,
        failureReason: `command exited with code ${cmdResult.exitCode}: ${command}`,
      };
    }

    // Check for dirty working tree (AC-12)
    const dirty = getDirtyPaths(root);
    if (dirty.length > 0) {
      return {
        passed: false,
        results,
        dirtyPaths: dirty,
        failureReason: `verification command left uncommitted changes: ${command}`,
      };
    }
  }

  return { passed: true, results };
}

/**
 * Run a shell command from the repository root.
 */
export function runShellCommand(
  root: string,
  command: string,
): VerificationCommandResult {
  try {
    // Use sh -c to run the command in the user's shell
    const cmd = new Deno.Command("sh", {
      args: ["-c", command],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
      env: Deno.env.toObject(),
    });
    const output = cmd.outputSync();
    const decoder = new TextDecoder();
    return {
      command,
      exitCode: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (e) {
    return {
      command,
      exitCode: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Snapshot commit ────────────────────────────────────────────────────────

/**
 * Write the snapshot and plan as part of a single "seal" commit.
 *
 * The commit message follows a stable template (AC-9).
 */
export function writeSnapshotCommit(
  root: string,
  featId: string,
  specRelPath: string,
): { success: boolean; error?: string } {
  // Read and canonicalize current spec
  const specFullPath = path.join(root, specRelPath);
  let specBytes: string;
  try {
    specBytes = Deno.readTextFileSync(specFullPath);
  } catch (e) {
    return { success: false, error: `failed to read spec: ${e}` };
  }

  const canonical = toCanonicalForm(specBytes, specRelPath);
  if (canonical === null) {
    return { success: false, error: "failed to canonicalize spec" };
  }

  // Write snapshot
  writeSnapshot(root, featId, canonical);

  // Stage snapshot file
  const snapshotRelPath = path.join(".specman", "implemented", `${featId}.md`);
  let stageResult = runGitCommand(root, ["add", snapshotRelPath]);
  if (!stageResult.success) {
    return { success: false, error: `git add snapshot failed: ${stageResult.stderr}` };
  }

  // Stage plan file if it exists
  const planRelPath = path.join(".specman", "plans", `${featId}.md`);
  const planFullPath = path.join(root, planRelPath);
  try {
    Deno.statSync(planFullPath);
    stageResult = runGitCommand(root, ["add", planRelPath]);
    if (!stageResult.success) {
      return { success: false, error: `git add plan failed: ${stageResult.stderr}` };
    }
  } catch {
    // Plan file doesn't exist — that's OK for seal
  }

  // Commit with stable template (AC-9)
  const commitMsg = `[specman] seal ${featId} (implemented snapshot @ sync)`;
  const commitResult = runGitCommand(root, [
    "commit",
    "-m",
    commitMsg,
    "--allow-empty",
  ]);

  if (!commitResult.success) {
    return { success: false, error: `git commit failed: ${commitResult.stderr}` };
  }

  return { success: true };
}

// ─── Dependency ordering ────────────────────────────────────────────────────

interface SpecNode {
  id: string;
  relPath: string;
  status: SpecStatus;
  dependsOn: string[];
}

/**
 * Topological sort of specs by depends_on.
 * Returns specs in dependency order (dependencies first).
 * Handles cycles by including cycle-participating specs at the end.
 */
export function topologicalSort(specs: SpecNode[]): SpecNode[] {
  const nodeMap = new Map<string, SpecNode>();
  for (const spec of specs) {
    nodeMap.set(spec.id, spec);
  }

  const sorted: SpecNode[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle detection

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // cycle — skip

    const node = nodeMap.get(id);
    if (!node) return;

    visiting.add(id);

    for (const dep of node.dependsOn) {
      if (nodeMap.has(dep)) {
        visit(dep);
      }
    }

    visiting.delete(id);
    visited.add(id);
    sorted.push(node);
  }

  // Visit all specs in ID order for determinism
  const sortedIds = [...nodeMap.keys()].sort();
  for (const id of sortedIds) {
    visit(id);
  }

  return sorted;
}

/**
 * Given a set of failed spec IDs, find all specs that transitively
 * depend on them.
 */
export function findTransitiveDependents(
  specs: SpecNode[],
  failedIds: Set<string>,
): Map<string, string[]> {
  const dependentsMap = new Map<string, string[]>();

  // Build reverse dependency graph
  const reverseDeps = new Map<string, string[]>();
  for (const spec of specs) {
    for (const dep of spec.dependsOn) {
      const existing = reverseDeps.get(dep) ?? [];
      existing.push(spec.id);
      reverseDeps.set(dep, existing);
    }
  }

  // BFS from each failed ID
  const allSkipped = new Set<string>();

  for (const failedId of failedIds) {
    const queue = [failedId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = reverseDeps.get(current) ?? [];
      for (const dep of dependents) {
        if (!visited.has(dep) && !failedIds.has(dep)) {
          visited.add(dep);
          allSkipped.add(dep);

          // Build the dependency chain for the message
          const chain = [failedId, dep];
          dependentsMap.set(dep, chain);

          queue.push(dep);
        }
      }
    }
  }

  return dependentsMap;
}

// ─── Sync one spec ──────────────────────────────────────────────────────────

/**
 * Sync a single spec. This is the core orchestration function.
 *
 * For now (without agent/interactive loop), this:
 * 1. Checks drift status
 * 2. Computes AC-level drift
 * 3. Generates/resumes plan scaffold
 * 4. Writes plan to disk
 *
 * The verification runner and snapshot commit are available as
 * separate functions for when the agent loop is integrated.
 */
export function syncOne(
  root: string,
  featId: string,
  specRelPath: string,
  status: SpecStatus,
): SyncOneResult {
  // AC-2: no drift → no-op
  if (status === "in-sync") {
    return {
      featId,
      outcome: "in-sync",
      message: `${featId} is in-sync — nothing to do.`,
    };
  }

  // Load drift set
  const driftState = status === "new" ? "new" : "drifted";
  const driftResult = loadDriftSet(root, featId, specRelPath, driftState);

  if ("error" in driftResult) {
    return {
      featId,
      outcome: "error",
      message: `${featId}: ${driftResult.error}`,
    };
  }

  const { driftSet } = driftResult;

  // AC-19: drifted but no AC changes → direct to seal
  if (status === "drifted" && driftSet.length === 0) {
    return {
      featId,
      outcome: "no-ac-drift",
      message:
        `${featId} is drifted but no acceptance criteria changed. ` +
        `Update ACs if the change has implementation consequences, ` +
        `or run: specman seal ${featId}`,
    };
  }

  // Parse current spec for title
  const specFullPath = path.join(root, specRelPath);
  const specBytes = Deno.readTextFileSync(specFullPath);
  const parsed = parse(specBytes, specRelPath);
  if (!isParsedSpec(parsed)) {
    return {
      featId,
      outcome: "error",
      message: `${featId}: failed to parse spec: ${parsed.reason}`,
    };
  }

  const title = (parsed.frontmatter.title as string) ?? featId;

  // Check for existing plan with uncommitted changes (resume flow, AC-15/AC-18)
  const existingPlan = readPlan(root, featId);
  let planContent: string;

  if (existingPlan !== null && planHasUncommittedChanges(root, featId)) {
    // Uncommitted plan from a prior aborted sync — resume with it
    planContent = existingPlan;
  } else {
    // No plan, or plan matches HEAD (prior completed sync) — generate fresh
    const snapshotState = status === "new" ? "new" : "drifted";
    planContent = generatePlan({
      featId,
      title,
      snapshotState: snapshotState as "new" | "drifted",
      driftSet,
    });
  }

  // Write plan to disk
  writePlan(root, featId, planContent);

  const planPath = path.join(".specman", "plans", `${featId}.md`);

  return {
    featId,
    outcome: "plan-written",
    message: `${featId}: plan scaffold written to ${planPath}`,
    planPath,
  };
}

// ─── Sync all specs ─────────────────────────────────────────────────────────

/**
 * Sync all drifted/new specs in dependency order (AC-7).
 *
 * If a spec fails, all transitive dependents are skipped.
 */
export function syncAll(root: string): SyncAllResult {
  const statusResult = getStatus(root);
  const specFiles = walkSpecFiles(root);

  // Build spec nodes for dependency ordering
  const specNodes: SpecNode[] = [];
  for (const entry of statusResult.entries) {
    if (entry.status === "in-sync") continue; // skip in-sync for ordering

    // Find the spec file entry for depends_on
    const specFile = specFiles.find((s) => s.id === entry.id);
    if (!specFile) continue;

    const specFullPath = path.join(root, entry.specPath);
    let dependsOn: string[] = [];
    try {
      const bytes = Deno.readTextFileSync(specFullPath);
      const parsed = parse(bytes, entry.specPath);
      if (isParsedSpec(parsed) && Array.isArray(parsed.frontmatter.depends_on)) {
        dependsOn = parsed.frontmatter.depends_on.filter(
          (d): d is string => typeof d === "string",
        );
      }
    } catch {
      // Can't read spec — will error during sync
    }

    specNodes.push({
      id: entry.id,
      relPath: entry.specPath,
      status: entry.status,
      dependsOn,
    });
  }

  // Sort by dependency order
  const sorted = topologicalSort(specNodes);

  const results: SyncOneResult[] = [];
  const skipped: Array<{ featId: string; reason: string }> = [];
  const failedIds = new Set<string>();

  for (const node of sorted) {
    // Check if this spec depends on a failed spec
    const failedDep = node.dependsOn.find((d) => failedIds.has(d));
    if (failedDep) {
      skipped.push({
        featId: node.id,
        reason: `depends on failed spec ${failedDep}`,
      });
      failedIds.add(node.id); // propagate skip
      continue;
    }

    const result = syncOne(root, node.id, node.relPath, node.status);
    results.push(result);

    if (result.outcome === "error" || result.outcome === "verification-failed" ||
        result.outcome === "trailer-check-failed") {
      failedIds.add(node.id);
    }
  }

  return { results, skipped };
}

// ─── Dry run ────────────────────────────────────────────────────────────────

/** A single entry in the dry-run report */
export interface DryRunEntry {
  featId: string;
  status: "new" | "drifted";
  /** Formatted drift summary, e.g. "3 added (whole spec)" or "1 added, 2 modified, 0 removed" */
  summary: string;
}

/**
 * Compute what `specman sync` would do, without writing any plan files.
 *
 * AC-24: lists each new/drifted spec with id, status, and drift counts.
 * AC-25: when featId is given, restricts the report to that spec.
 *
 * In-sync specs are omitted. Order matches dependency order so the
 * report mirrors the order a real sync would process them.
 */
export function dryRunReport(root: string, featId?: string): DryRunEntry[] {
  const statusResult = getStatus(root);
  const specFiles = walkSpecFiles(root);

  const candidates = statusResult.entries.filter((e) => {
    if (e.status === "in-sync") return false;
    if (featId !== undefined && e.id !== featId) return false;
    return true;
  });

  // Build SpecNodes for dependency ordering (matches syncAll behavior).
  const nodes: SpecNode[] = [];
  for (const entry of candidates) {
    const specFile = specFiles.find((s) => s.id === entry.id);
    if (!specFile) continue;

    const specFullPath = path.join(root, entry.specPath);
    let dependsOn: string[] = [];
    try {
      const bytes = Deno.readTextFileSync(specFullPath);
      const parsed = parse(bytes, entry.specPath);
      if (isParsedSpec(parsed) && Array.isArray(parsed.frontmatter.depends_on)) {
        dependsOn = parsed.frontmatter.depends_on.filter(
          (d): d is string => typeof d === "string",
        );
      }
    } catch {
      // ignore — drift summary will surface the parse failure
    }

    nodes.push({
      id: entry.id,
      relPath: entry.specPath,
      status: entry.status,
      dependsOn,
    });
  }

  const sorted = topologicalSort(nodes);

  const report: DryRunEntry[] = [];
  for (const node of sorted) {
    const driftState = node.status === "new" ? "new" : "drifted";
    const driftResult = loadDriftSet(root, node.id, node.relPath, driftState);
    if ("error" in driftResult) {
      report.push({
        featId: node.id,
        status: node.status as "new" | "drifted",
        summary: `error: ${driftResult.error}`,
      });
      continue;
    }
    report.push({
      featId: node.id,
      status: node.status as "new" | "drifted",
      summary: formatDriftSummary(driftResult.driftSet, driftState),
    });
  }

  return report;
}

/** Format a dry-run report for CLI output — one line per spec. */
export function formatDryRunReport(entries: DryRunEntry[]): string[] {
  if (entries.length === 0) {
    return ["All specs are in-sync — nothing to sync."];
  }
  return entries.map((e) => `${e.featId} ${e.status}: ${e.summary}`);
}

// ─── Seal ───────────────────────────────────────────────────────────────────

/**
 * Seal an editorial change — update the snapshot without agent/plan.
 *
 * AC-16: Updates snapshot, creates single commit.
 * AC-17: Refuses if ACs changed.
 * AC-18: Refuses if spec is new or in-sync.
 * AC-20: Refuses if working tree is dirty.
 */
export function seal(
  root: string,
  featId: string,
  opts?: { initial?: boolean },
): SealResult {
  const initial = opts?.initial === true;

  // Find the spec file
  const specFiles = walkSpecFiles(root);
  const specEntry = specFiles.find((s) => s.id === featId);
  if (!specEntry) {
    return {
      outcome: "error",
      message: `no spec found for ${featId}`,
    };
  }

  // Check drift status
  const status = detectDrift(root, featId, specEntry.relPath);

  if (initial) {
    // AC-23: --initial only valid for new specs
    if (status !== "new") {
      return {
        outcome: "error",
        message:
          `--initial is only for specs with no snapshot; ${featId} is currently ${status}. ` +
          `Use 'specman seal ${featId}' for editorial changes or 'specman sync ${featId}' for AC drift.`,
      };
    }

    // AC-20 (parity): refuse if working tree is dirty.
    // Allow the spec's plan file — writeSnapshotCommit stages it alongside
    // the snapshot, mirroring the sync seal commit (AC-3).
    const planRelPath = path.join(".specman", "plans", `${featId}.md`);
    const dirtyPaths = checkWorkingTree(root, [planRelPath]);
    if (dirtyPaths !== null) {
      return {
        outcome: "error",
        message:
          `working tree has uncommitted changes:\n` +
          dirtyPaths.map((p) => `  ${p}`).join("\n") +
          `\nCommit or stash changes before running seal.`,
      };
    }

    // AC-22: write snapshot and commit
    const commitResult = writeSnapshotCommit(root, featId, specEntry.relPath);
    if (!commitResult.success) {
      return {
        outcome: "error",
        message: `${featId}: failed to create snapshot commit: ${commitResult.error}`,
      };
    }

    return {
      outcome: "sealed",
      message: `${featId}: sealed (initial snapshot created).`,
    };
  }

  // AC-18: refuse if new or in-sync (no --initial)
  if (status === "new") {
    return {
      outcome: "error",
      message:
        `${featId} has no snapshot (status: new). ` +
        `Use 'specman sync ${featId}' for initial implementation, ` +
        `or 'specman seal --initial ${featId}' if the implementation already exists.`,
    };
  }

  if (status === "in-sync") {
    return {
      outcome: "error",
      message: `${featId} is already in-sync — nothing to seal.`,
    };
  }

  // AC-20: refuse if working tree is dirty
  const dirtyPaths = checkWorkingTree(root, []);
  if (dirtyPaths !== null) {
    return {
      outcome: "error",
      message:
        `working tree has uncommitted changes:\n` +
        dirtyPaths.map((p) => `  ${p}`).join("\n") +
        `\nCommit or stash changes before running seal.`,
    };
  }

  // AC-17: refuse if ACs changed
  const driftResult = loadDriftSet(root, featId, specEntry.relPath, "drifted");
  if ("error" in driftResult) {
    return {
      outcome: "error",
      message: `${featId}: ${driftResult.error}`,
    };
  }

  if (driftResult.driftSet.length > 0) {
    return {
      outcome: "error",
      message:
        `${featId} has AC-level drift (` +
        driftResult.driftSet.map((d) => `${d.id} ${d.type}`).join(", ") +
        `). Use 'specman sync ${featId}' instead.`,
    };
  }

  // AC-16: write snapshot and commit
  const commitResult = writeSnapshotCommit(root, featId, specEntry.relPath);
  if (!commitResult.success) {
    return {
      outcome: "error",
      message: `${featId}: failed to create snapshot commit: ${commitResult.error}`,
    };
  }

  return {
    outcome: "sealed",
    message: `${featId}: sealed (editorial change, snapshot updated).`,
  };
}

// ─── CLI formatting helpers ─────────────────────────────────────────────────

/**
 * Format sync result for CLI output.
 */
export function formatSyncResult(result: SyncOneResult): string[] {
  const lines: string[] = [];

  switch (result.outcome) {
    case "in-sync":
      lines.push(result.message);
      break;
    case "no-ac-drift":
      lines.push(result.message);
      break;
    case "plan-written":
      lines.push(result.message);
      break;
    case "sealed":
      lines.push(result.message);
      break;
    case "verification-failed":
      lines.push(`error: ${result.message}`);
      if (result.verificationResult) {
        const vr = result.verificationResult;
        const lastResult = vr.results[vr.results.length - 1];
        if (lastResult) {
          lines.push(`  command: ${lastResult.command}`);
          lines.push(`  exit code: ${lastResult.exitCode}`);
          if (lastResult.stdout.trim()) {
            lines.push(`  stdout: ${lastResult.stdout.trim()}`);
          }
          if (lastResult.stderr.trim()) {
            lines.push(`  stderr: ${lastResult.stderr.trim()}`);
          }
        }
        if (vr.dirtyPaths) {
          lines.push(`  dirty paths:`);
          for (const p of vr.dirtyPaths) {
            lines.push(`    ${p}`);
          }
        }
      }
      break;
    case "trailer-check-failed":
      lines.push(`error: ${result.message}`);
      if (result.trailerResult) {
        for (const offender of result.trailerResult.offenders) {
          const firstLine = offender.message.split("\n")[0];
          lines.push(`  ${offender.hash.slice(0, 7)} ${firstLine}`);
        }
      }
      break;
    case "error":
      lines.push(`error: ${result.message}`);
      break;
  }

  return lines;
}

/**
 * Format sync-all results for CLI output.
 */
export function formatSyncAllResult(result: SyncAllResult): string[] {
  const lines: string[] = [];

  for (const r of result.results) {
    lines.push(...formatSyncResult(r));
  }

  for (const s of result.skipped) {
    lines.push(`${s.featId}: skipped (${s.reason})`);
  }

  if (result.results.length === 0 && result.skipped.length === 0) {
    lines.push("All specs are in-sync — nothing to do.");
  }

  return lines;
}

/**
 * Format seal result for CLI output.
 */
export function formatSealResult(result: SealResult): string[] {
  if (result.outcome === "sealed") {
    return [result.message];
  }
  return [`error: ${result.message}`];
}
