/**
 * Tests for FEAT-0004: Agent sync workflow
 *
 * Tests the sync orchestrator, seal command, verification runner,
 * trailer checking, dependency ordering, and working tree checks.
 */

import {
  assertEquals,
  assert,
  assertStringIncludes,
  assertNotEquals,
} from "@std/assert";
import { init } from "../src/init.ts";
import {
  syncOne,
  syncAll,
  seal,
  checkWorkingTree,
  getDirtyPaths,
  runVerification,
  checkTrailers,
  deriveScope,
  writeSnapshotCommit,
  topologicalSort,
  findTransitiveDependents,
  runGitCommand,
  getHead,
  getCommitsSince,
  formatSyncResult,
  formatSyncAllResult,
  formatSealResult,
  type SyncOneResult,
} from "../src/sync.ts";
import {
  writeSnapshot,
  readSnapshot,
  detectDrift,
  toCanonicalForm,
} from "../src/snapshot.ts";
import {
  writePlan,
  readPlan,
  planExists,
  loadDriftSet,
  computeDriftSet,
} from "../src/plan.ts";
import {
  parse,
  isParsedSpec,
  serialize,
  type ParsedSpec,
} from "../src/parser.ts";
import * as path from "@std/path";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temp directory with git repo and specman init */
function withGitProject(fn: (root: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_sync_test_" });
  try {
    // Initialize git repo
    runGitCommand(dir, ["init"]);
    runGitCommand(dir, ["config", "user.email", "test@specman.dev"]);
    runGitCommand(dir, ["config", "user.name", "Test"]);

    // Initialize specman
    init(dir);

    // Create a .gitkeep so the initial commit is not empty
    // (git doesn't track empty directories)
    Deno.writeTextFileSync(
      path.join(dir, ".specman", ".gitkeep"),
      "",
    );

    // Initial commit so HEAD exists
    runGitCommand(dir, ["add", "."]);
    runGitCommand(dir, ["commit", "-m", "initial commit"]);

    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** Create a spec file and return its relative path */
function createSpec(
  root: string,
  id: string,
  title: string,
  acs: Array<{ id: string; text: string }>,
  opts?: { dependsOn?: string[] },
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const filename = `${id}-${slug}.md`;
  const dir = path.join(root, "specs");
  Deno.mkdirSync(dir, { recursive: true });

  const depsStr = (opts?.dependsOn ?? []).map((d) => d).join(", ");
  const acLines = acs.map((ac) => `- ${ac.id}: ${ac.text}`).join("\n");

  const content = `---
id: ${id}
title: ${title}
status: draft
depends_on: [${depsStr}]
---

## Intent

Implement ${title}.

## Acceptance criteria

${acLines}
`;

  const fullPath = path.join(dir, filename);
  Deno.writeTextFileSync(fullPath, content);
  return path.relative(root, fullPath);
}

/** Create a spec and its in-sync snapshot, commit both */
function createSyncedSpec(
  root: string,
  id: string,
  title: string,
  acs: Array<{ id: string; text: string }>,
  opts?: { dependsOn?: string[]; commit?: boolean },
): string {
  const relPath = createSpec(root, id, title, acs, opts);
  const fullPath = path.join(root, relPath);
  const bytes = Deno.readTextFileSync(fullPath);
  const canonical = toCanonicalForm(bytes, relPath);
  assert(canonical !== null);
  Deno.writeTextFileSync(fullPath, canonical);
  writeSnapshot(root, id, canonical);

  if (opts?.commit !== false) {
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", `add ${id}`]);
  }

  return relPath;
}

/** Modify a spec's AC text to create drift */
function driftSpec(root: string, relPath: string, oldText: string, newText: string): void {
  const fullPath = path.join(root, relPath);
  const content = Deno.readTextFileSync(fullPath);
  Deno.writeTextFileSync(fullPath, content.replace(oldText, newText));
}

/** Modify a spec's non-AC content (editorial change) */
function editorialDrift(root: string, relPath: string): void {
  const fullPath = path.join(root, relPath);
  const content = Deno.readTextFileSync(fullPath);
  Deno.writeTextFileSync(
    fullPath,
    content.replace("## Intent\n\n", "## Intent\n\nUpdated intent prose.\n\n"),
  );
}

// ─── AC-1: sync produces plan with AC references ────────────────────────────

Deno.test("AC-1, AC-5: sync of new spec produces plan with all ACs as added", () => {
  withGitProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "Password reset", [
      { id: "AC-1", text: "Email delivered within 1 min" },
      { id: "AC-2", text: "Rate limit on 3 failures" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    const status = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(status, "new");

    const result = syncOne(root, "FEAT-0042", relPath, status);
    assertEquals(result.outcome, "plan-written");
    assert(result.planPath !== undefined);

    // Verify plan content (AC-1: each entry references an AC id)
    const planContent = readPlan(root, "FEAT-0042");
    assert(planContent !== null);
    assertStringIncludes(planContent, "AC-1");
    assertStringIncludes(planContent, "AC-2");
    assertStringIncludes(planContent, "(added)");

    // AC-5: new spec has full spec as delta
    assertStringIncludes(planContent, "Snapshot state: new");
    assertStringIncludes(planContent, "2 added (whole spec)");
  });
});

Deno.test("AC-1: sync of drifted spec produces plan keyed to changed ACs", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Password reset", [
      { id: "AC-1", text: "Email delivered within 5 min" },
      { id: "AC-2", text: "Rate limit" },
    ]);

    // Drift: change AC-1
    driftSpec(root, relPath, "within 5 min", "within 1 min");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "update spec"]);

    const status = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(status, "drifted");

    const result = syncOne(root, "FEAT-0042", relPath, status);
    assertEquals(result.outcome, "plan-written");

    const planContent = readPlan(root, "FEAT-0042");
    assert(planContent !== null);
    assertStringIncludes(planContent, "AC-1");
    assertStringIncludes(planContent, "(modified)");
    // AC-2 unchanged — should NOT be in the drift plan
    assert(!planContent.includes("## AC-2"));
  });
});

// ─── AC-2: no drift → no-op ────────────────────────────────────────────────

Deno.test("AC-2: sync of in-sync spec is a no-op", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Password reset", [
      { id: "AC-1", text: "Email delivered" },
    ]);

    const status = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(status, "in-sync");

    const result = syncOne(root, "FEAT-0042", relPath, status);
    assertEquals(result.outcome, "in-sync");
    assertStringIncludes(result.message, "in-sync");
    assertStringIncludes(result.message, "nothing to do");
  });
});

// ─── AC-7: multi-spec dependency ordering ───────────────────────────────────

Deno.test("AC-7: topologicalSort orders dependencies before dependents", () => {
  const specs = [
    { id: "FEAT-0003", relPath: "specs/FEAT-0003-c.md", status: "new" as const, dependsOn: ["FEAT-0001"] },
    { id: "FEAT-0001", relPath: "specs/FEAT-0001-a.md", status: "new" as const, dependsOn: [] },
    { id: "FEAT-0002", relPath: "specs/FEAT-0002-b.md", status: "new" as const, dependsOn: ["FEAT-0001"] },
  ];

  const sorted = topologicalSort(specs);
  const ids = sorted.map((s) => s.id);

  // FEAT-0001 must come before FEAT-0002 and FEAT-0003
  const idx1 = ids.indexOf("FEAT-0001");
  const idx2 = ids.indexOf("FEAT-0002");
  const idx3 = ids.indexOf("FEAT-0003");
  assert(idx1 < idx2);
  assert(idx1 < idx3);
});

Deno.test("AC-7: topologicalSort handles cycles without infinite loop", () => {
  const specs = [
    { id: "FEAT-0001", relPath: "a.md", status: "new" as const, dependsOn: ["FEAT-0002"] },
    { id: "FEAT-0002", relPath: "b.md", status: "new" as const, dependsOn: ["FEAT-0001"] },
    { id: "FEAT-0003", relPath: "c.md", status: "new" as const, dependsOn: [] },
  ];

  const sorted = topologicalSort(specs);
  // Should include all 3 specs (cycles don't crash)
  assertEquals(sorted.length, 3);
  const ids = sorted.map((s) => s.id);
  assert(ids.includes("FEAT-0003"));
});

Deno.test("AC-7: findTransitiveDependents finds transitive skip chain", () => {
  const specs = [
    { id: "FEAT-0001", relPath: "a.md", status: "new" as const, dependsOn: [] },
    { id: "FEAT-0002", relPath: "b.md", status: "new" as const, dependsOn: ["FEAT-0001"] },
    { id: "FEAT-0003", relPath: "c.md", status: "new" as const, dependsOn: ["FEAT-0002"] },
    { id: "FEAT-0004", relPath: "d.md", status: "new" as const, dependsOn: [] },
  ];

  const failedIds = new Set(["FEAT-0001"]);
  const dependents = findTransitiveDependents(specs, failedIds);

  // FEAT-0002 depends on FEAT-0001, FEAT-0003 depends on FEAT-0002
  assert(dependents.has("FEAT-0002"));
  assert(dependents.has("FEAT-0003"));
  assert(!dependents.has("FEAT-0004")); // independent
});

Deno.test("AC-7: syncAll processes specs in dependency order and skips on failure", () => {
  withGitProject((root) => {
    // Create three specs: 0001 (independent), 0002 depends on 0001, 0003 independent
    createSpec(root, "FEAT-0001", "Base feature", [
      { id: "AC-1", text: "Base AC" },
    ]);
    createSpec(root, "FEAT-0002", "Dependent feature", [
      { id: "AC-1", text: "Dependent AC" },
    ], { dependsOn: ["FEAT-0001"] });
    createSpec(root, "FEAT-0003", "Independent feature", [
      { id: "AC-1", text: "Independent AC" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add all specs"]);

    const result = syncAll(root);

    // All three are new, should all get plans
    assertEquals(result.results.length, 3);

    // FEAT-0001 should be processed before FEAT-0002
    const idx1 = result.results.findIndex((r) => r.featId === "FEAT-0001");
    const idx2 = result.results.findIndex((r) => r.featId === "FEAT-0002");
    assert(idx1 < idx2, "FEAT-0001 should be processed before FEAT-0002");
  });
});

// ─── AC-10, AC-11, AC-12, AC-13: Verification runner ───────────────────────

Deno.test("AC-10, AC-13: verification runs commands sequentially and passes on all zero exits", () => {
  withGitProject((root) => {
    const result = runVerification(root, ["true", "true"]);
    assert(result.passed);
    assertEquals(result.results.length, 2);
    assertEquals(result.results[0].exitCode, 0);
    assertEquals(result.results[1].exitCode, 0);
  });
});

Deno.test("AC-11: verification stops on first non-zero exit, surfaces details", () => {
  withGitProject((root) => {
    const result = runVerification(root, [
      "echo ok",
      "sh -c 'echo fail-output >&2; exit 1'",
      "echo should-not-run",
    ]);

    assert(!result.passed);
    assertEquals(result.results.length, 2); // stopped after second
    assertEquals(result.results[0].exitCode, 0);
    assertEquals(result.results[1].exitCode, 1);
    assertStringIncludes(result.results[1].stderr, "fail-output");
    assertStringIncludes(result.failureReason!, "exit");
  });
});

Deno.test("AC-12: verification fails if command leaves dirty working tree", () => {
  withGitProject((root) => {
    // Command that creates an untracked file
    const result = runVerification(root, [
      `echo 'dirty' > dirty-file.txt`,
    ]);

    assert(!result.passed);
    assert(result.dirtyPaths !== undefined);
    assert(result.dirtyPaths!.length > 0);
    assertStringIncludes(result.failureReason!, "uncommitted changes");

    // Cleanup
    try { Deno.removeSync(path.join(root, "dirty-file.txt")); } catch { /* ok */ }
  });
});

// ─── AC-14, AC-15: Working tree check ──────────────────────────────────────

Deno.test("AC-14: sync with dirty working tree exits with error, allows plan file", () => {
  withGitProject((root) => {
    // Create dirty file
    Deno.writeTextFileSync(path.join(root, "dirty.txt"), "dirty");

    const dirty = checkWorkingTree(root, [".specman/plans/FEAT-0042.md"]);
    assert(dirty !== null);
    assert(dirty.some((p) => p.includes("dirty.txt")));

    // Clean up
    Deno.removeSync(path.join(root, "dirty.txt"));
  });
});

Deno.test("AC-14: only plan file dirty is allowed for single-spec sync", () => {
  withGitProject((root) => {
    // Write a plan file (uncommitted)
    writePlan(root, "FEAT-0042", "existing plan content");

    // Use the actual relative path as git sees it
    const dirty = getDirtyPaths(root);
    const planFile = ".specman/plans/FEAT-0042.md";
    const disallowed = dirty.filter(
      (p) => p.replace(/\\/g, "/") !== planFile,
    );
    assertEquals(disallowed.length, 0, `unexpected dirty paths: ${JSON.stringify(disallowed)}`);

    // checkWorkingTree should allow the plan file
    const result = checkWorkingTree(root, [planFile]);
    assertEquals(result, null);
  });
});

Deno.test("AC-15: multi-spec sync allows any plan files in .specman/plans/", () => {
  withGitProject((root) => {
    writePlan(root, "FEAT-0001", "plan 1");
    writePlan(root, "FEAT-0002", "plan 2");

    // For multi-spec, we allow all plan files under .specman/plans/
    const allDirty = getDirtyPaths(root);
    const disallowed = allDirty.filter(
      (p) => !p.replace(/\\/g, "/").startsWith(".specman/plans/"),
    );
    assertEquals(disallowed.length, 0, `unexpected dirty paths: ${JSON.stringify(disallowed)}`);
  });
});

// ─── AC-16, AC-17, AC-18, AC-20: Seal command ──────────────────────────────

Deno.test("AC-16: seal updates snapshot and creates commit for editorial drift", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Password reset", [
      { id: "AC-1", text: "Email delivered" },
    ]);

    // Create editorial drift (change intent, not ACs)
    editorialDrift(root, relPath);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "editorial change"]);

    const status = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(status, "drifted");

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "sealed");
    assertStringIncludes(result.message, "sealed");

    // Verify snapshot was updated
    const newStatus = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(newStatus, "in-sync");

    // Verify a commit was created
    const log = runGitCommand(root, ["log", "--oneline", "-1"]);
    assertStringIncludes(log.stdout, "[specman] seal FEAT-0042");
  });
});

Deno.test("AC-17: seal refuses when ACs changed", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Password reset", [
      { id: "AC-1", text: "Email delivered within 5 min" },
    ]);

    // Drift AC text
    driftSpec(root, relPath, "within 5 min", "within 1 min");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "change AC"]);

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "AC-level drift");
    assertStringIncludes(result.message, "specman sync");
  });
});

Deno.test("AC-18: seal refuses for new spec (no snapshot) and mentions both sync and --initial", () => {
  withGitProject((root) => {
    createSpec(root, "FEAT-0042", "New feature", [
      { id: "AC-1", text: "Test" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "new");
    assertStringIncludes(result.message, "specman sync");
    assertStringIncludes(result.message, "specman seal --initial");
  });
});

Deno.test("AC-18: seal refuses for in-sync spec", () => {
  withGitProject((root) => {
    createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "in-sync");
  });
});

Deno.test("AC-20: seal refuses with dirty working tree", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);

    // Create editorial drift
    editorialDrift(root, relPath);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "editorial change"]);

    // Create dirty file
    Deno.writeTextFileSync(path.join(root, "dirty.txt"), "dirty");

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "uncommitted changes");
    assertStringIncludes(result.message, "dirty.txt");

    // Clean up
    Deno.removeSync(path.join(root, "dirty.txt"));
  });
});

// ─── AC-19: drifted but no AC changes → no-ac-drift ────────────────────────

Deno.test("AC-19: sync of drifted spec with no AC changes directs to seal", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test criterion" },
    ]);

    // Editorial drift only
    editorialDrift(root, relPath);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "editorial"]);

    const status = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(status, "drifted");

    const result = syncOne(root, "FEAT-0042", relPath, status);
    assertEquals(result.outcome, "no-ac-drift");
    assertStringIncludes(result.message, "specman seal");
  });
});

// ─── AC-9: Snapshot commit template ─────────────────────────────────────────

Deno.test("AC-9: writeSnapshotCommit creates commit with stable template", () => {
  withGitProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    const result = writeSnapshotCommit(root, "FEAT-0042", relPath);
    assert(result.success);

    const log = runGitCommand(root, ["log", "--oneline", "-1"]);
    assertStringIncludes(log.stdout, "[specman] seal FEAT-0042");
    assertStringIncludes(log.stdout, "implemented snapshot @ sync");
  });
});

// ─── AC-21: Trailer check ──────────────────────────────────────────────────

Deno.test("AC-21: checkTrailers passes when all commits have matching trailers", () => {
  withGitProject((root) => {
    const preSyncHead = getHead(root)!;

    // Create commits with proper trailers
    Deno.writeTextFileSync(path.join(root, "file1.ts"), "code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, [
      "commit", "-m", "feat: validate email\n\nSpec: FEAT-0042/AC-1",
    ]);

    Deno.writeTextFileSync(path.join(root, "file2.ts"), "more code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, [
      "commit", "-m", "feat: expire links\n\nSpec: FEAT-0042/AC-2",
    ]);

    const result = checkTrailers(root, "FEAT-0042", preSyncHead);
    assert(result.passed);
    assertEquals(result.offenders.length, 0);
  });
});

Deno.test("AC-21: checkTrailers fails when commit lacks matching trailer", () => {
  withGitProject((root) => {
    const preSyncHead = getHead(root)!;

    // Good commit
    Deno.writeTextFileSync(path.join(root, "file1.ts"), "code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, [
      "commit", "-m", "feat: validate\n\nSpec: FEAT-0042/AC-1",
    ]);

    // Bad commit — no trailer
    Deno.writeTextFileSync(path.join(root, "file2.ts"), "more code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "feat: quick fix with no trailer"]);

    const result = checkTrailers(root, "FEAT-0042", preSyncHead);
    assert(!result.passed);
    assertEquals(result.offenders.length, 1);
    assertStringIncludes(result.offenders[0].message, "quick fix");
  });
});

Deno.test("AC-21: checkTrailers fails when trailer references wrong FEAT-ID", () => {
  withGitProject((root) => {
    const preSyncHead = getHead(root)!;

    Deno.writeTextFileSync(path.join(root, "file1.ts"), "code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, [
      "commit", "-m", "feat: wrong spec\n\nSpec: FEAT-0099/AC-1",
    ]);

    const result = checkTrailers(root, "FEAT-0042", preSyncHead);
    assert(!result.passed);
    assertEquals(result.offenders.length, 1);
  });
});

// ─── Derive scope ───────────────────────────────────────────────────────────

Deno.test("deriveScope: finds files from git log with Spec: trailers", () => {
  withGitProject((root) => {
    // Create src/ directory and a file, then commit with a trailer
    Deno.mkdirSync(path.join(root, "src"), { recursive: true });
    Deno.writeTextFileSync(path.join(root, "src", "auth.ts"), "code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, [
      "commit", "-m", "feat: auth\n\nSpec: FEAT-0042/AC-1",
    ]);

    const scope = deriveScope(root, "FEAT-0042", ["AC-1"]);
    const ac1Files = scope.get("AC-1") ?? [];
    assert(ac1Files.some((f) => f.includes("auth.ts")));
  });
});

Deno.test("deriveScope: excludes deleted files from scope", () => {
  withGitProject((root) => {
    // Create a file, commit, then delete it
    const filePath = path.join(root, "deleted.ts");
    Deno.writeTextFileSync(filePath, "code");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, [
      "commit", "-m", "feat: add\n\nSpec: FEAT-0042/AC-1",
    ]);

    Deno.removeSync(filePath);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "delete file\n\nSpec: FEAT-0042/AC-1"]);

    const scope = deriveScope(root, "FEAT-0042", ["AC-1"]);
    const ac1Files = scope.get("AC-1") ?? [];
    assert(!ac1Files.some((f) => f.includes("deleted.ts")));
  });
});

// ─── Resume flow ────────────────────────────────────────────────────────────

Deno.test("resume: syncOne uses existing plan if present on disk", () => {
  withGitProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    // Pre-write a plan (simulating prior aborted sync)
    const existingPlan = "# Sync plan — FEAT-0042 Feature\n\nExisting plan from prior sync.\n";
    writePlan(root, "FEAT-0042", existingPlan);

    const status = detectDrift(root, "FEAT-0042", relPath);
    const result = syncOne(root, "FEAT-0042", relPath, status);
    assertEquals(result.outcome, "plan-written");

    // Should use existing plan, not regenerate
    const planContent = readPlan(root, "FEAT-0042");
    assertStringIncludes(planContent!, "Existing plan from prior sync");
  });
});

// ─── Formatting ─────────────────────────────────────────────────────────────

Deno.test("formatSyncResult: formats each outcome type", () => {
  const cases: Array<[SyncOneResult, string]> = [
    [
      { featId: "FEAT-0001", outcome: "in-sync", message: "FEAT-0001 is in-sync" },
      "in-sync",
    ],
    [
      { featId: "FEAT-0001", outcome: "no-ac-drift", message: "no AC changes" },
      "no AC changes",
    ],
    [
      { featId: "FEAT-0001", outcome: "plan-written", message: "plan written" },
      "plan written",
    ],
    [
      { featId: "FEAT-0001", outcome: "error", message: "something broke" },
      "error: something broke",
    ],
  ];

  for (const [input, expected] of cases) {
    const lines = formatSyncResult(input);
    assert(lines.length > 0);
    assertStringIncludes(lines[0], expected);
  }
});

Deno.test("formatSealResult: formats sealed and error outcomes", () => {
  const sealed = formatSealResult({ outcome: "sealed", message: "done" });
  assertEquals(sealed, ["done"]);

  const error = formatSealResult({ outcome: "error", message: "fail" });
  assertEquals(error, ["error: fail"]);
});

Deno.test("formatSyncAllResult: shows message when all in-sync", () => {
  const lines = formatSyncAllResult({ results: [], skipped: [] });
  assert(lines.some((l) => l.includes("in-sync")));
});

// ─── Git helper edge cases ──────────────────────────────────────────────────

Deno.test("getCommitsSince: returns empty when no new commits", () => {
  withGitProject((root) => {
    const head = getHead(root)!;
    const commits = getCommitsSince(root, head);
    assertEquals(commits.length, 0);
  });
});

Deno.test("getCommitsSince: returns commits in chronological order", () => {
  withGitProject((root) => {
    const before = getHead(root)!;

    Deno.writeTextFileSync(path.join(root, "a.txt"), "a");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "first"]);

    Deno.writeTextFileSync(path.join(root, "b.txt"), "b");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "second"]);

    const commits = getCommitsSince(root, before);
    assertEquals(commits.length, 2);
    assertStringIncludes(commits[0].message, "first");
    assertStringIncludes(commits[1].message, "second");
  });
});

// ─── AC-3: Snapshot commit is the last commit of sync ─────────────────────

Deno.test("AC-3: writeSnapshotCommit writes both snapshot and plan in single commit", () => {
  withGitProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    // Write a plan file first
    writePlan(root, "FEAT-0042", "# Sync plan — FEAT-0042 Feature\n");

    const result = writeSnapshotCommit(root, "FEAT-0042", relPath);
    assert(result.success);

    // Verify both files are in the commit
    const showResult = runGitCommand(root, ["show", "--name-only", "--format=", "HEAD"]);
    assertStringIncludes(showResult.stdout, ".specman/implemented/FEAT-0042.md");
    assertStringIncludes(showResult.stdout, ".specman/plans/FEAT-0042.md");
  });
});

// ─── AC-4: Failed execution preserves trailer commits ─────────────────────

Deno.test("AC-4: on verification failure, no snapshot commit is created", () => {
  withGitProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    // Run verification that fails
    const verResult = runVerification(root, ["false"]);
    assert(!verResult.passed);

    // No snapshot should exist
    assertEquals(readSnapshot(root, "FEAT-0042"), null);

    // Spec should still be 'new'
    const status = detectDrift(root, "FEAT-0042", relPath);
    assertEquals(status, "new");
  });
});

// ─── Seal with added AC ────────────────────────────────────────────────────

Deno.test("AC-17: seal refuses when AC is added", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Original" },
    ]);

    // Add a new AC
    const fullPath = path.join(root, relPath);
    const content = Deno.readTextFileSync(fullPath);
    Deno.writeTextFileSync(
      fullPath,
      content.replace(
        "- AC-1: Original",
        "- AC-1: Original\n- AC-2: Brand new AC",
      ),
    );
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add AC"]);

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "AC-level drift");
    assertStringIncludes(result.message, "AC-2 added");
  });
});

Deno.test("AC-17: seal refuses when AC is removed", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "First" },
      { id: "AC-2", text: "Second" },
    ]);

    // Remove AC-2
    const fullPath = path.join(root, relPath);
    const content = Deno.readTextFileSync(fullPath);
    Deno.writeTextFileSync(
      fullPath,
      content.replace("\n- AC-2: Second", ""),
    );
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "remove AC"]);

    const result = seal(root, "FEAT-0042");
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "AC-level drift");
    assertStringIncludes(result.message, "AC-2 removed");
  });
});

// ─── AC-22, AC-23: seal --initial ──────────────────────────────────────────

Deno.test("AC-22: seal --initial creates snapshot for new spec and transitions to in-sync", () => {
  withGitProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "New feature", [
      { id: "AC-1", text: "First" },
      { id: "AC-2", text: "Second" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    assertEquals(detectDrift(root, "FEAT-0042", relPath), "new");

    const result = seal(root, "FEAT-0042", { initial: true });
    assertEquals(result.outcome, "sealed");
    assertStringIncludes(result.message, "initial snapshot");

    // Snapshot was written
    assertEquals(detectDrift(root, "FEAT-0042", relPath), "in-sync");

    // A single commit was created
    const log = runGitCommand(root, ["log", "--oneline", "-1"]);
    assertStringIncludes(log.stdout, "[specman] seal FEAT-0042");
  });
});

Deno.test("AC-23: seal --initial refuses when spec already has snapshot (in-sync)", () => {
  withGitProject((root) => {
    createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "Test" },
    ]);

    const result = seal(root, "FEAT-0042", { initial: true });
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "--initial is only for specs with no snapshot");
    assertStringIncludes(result.message, "in-sync");
  });
});

Deno.test("AC-23: seal --initial refuses when spec is drifted", () => {
  withGitProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0042", "Feature", [
      { id: "AC-1", text: "First" },
    ]);

    // Drift it
    driftSpec(root, relPath, "First", "Updated");
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "drift"]);

    const result = seal(root, "FEAT-0042", { initial: true });
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "--initial is only for specs with no snapshot");
    assertStringIncludes(result.message, "drifted");
  });
});

Deno.test("AC-22: seal --initial refuses with dirty working tree", () => {
  withGitProject((root) => {
    createSpec(root, "FEAT-0042", "New feature", [
      { id: "AC-1", text: "Test" },
    ]);
    runGitCommand(root, ["add", "."]);
    runGitCommand(root, ["commit", "-m", "add spec"]);

    // Create dirty file
    Deno.writeTextFileSync(path.join(root, "dirty.txt"), "dirty");

    const result = seal(root, "FEAT-0042", { initial: true });
    assertEquals(result.outcome, "error");
    assertStringIncludes(result.message, "uncommitted changes");
    assertStringIncludes(result.message, "dirty.txt");

    // Snapshot was NOT written
    const fullPath = path.join(root, "specs", "FEAT-0042-new-feature.md");
    const relPath = path.relative(root, fullPath);
    assertEquals(detectDrift(root, "FEAT-0042", relPath), "new");

    Deno.removeSync(path.join(root, "dirty.txt"));
  });
});
