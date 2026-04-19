/**
 * Tests for FEAT-0003: Implementation snapshots and drift detection
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0003-implementation-snapshots.md
 */

import { assertEquals, assert, assertStringIncludes } from "@std/assert";
import { init } from "../src/init.ts";
import {
  toCanonicalForm,
  detectDrift,
  writeSnapshot,
  readSnapshot,
  getStatus,
  formatStatus,
  validateSnapshots,
  formatValidation,
  generateDiff,
  scanSpecs,
  scanSnapshots,
  unifiedDiff,
} from "../src/snapshot.ts";
import { parse, serialize, isParsedSpec } from "../src/parser.ts";
import * as path from "@std/path";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withProject(fn: (root: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_snap_test_" });
  try {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** Create a well-formed spec file with given id and title */
function createSpec(
  root: string,
  id: string,
  title: string,
  extra?: { body?: string; subdir?: string },
): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const filename = `${id}-${slug}.md`;
  const dir = extra?.subdir
    ? path.join(root, "specs", extra.subdir)
    : path.join(root, "specs");

  Deno.mkdirSync(dir, { recursive: true });

  const body = extra?.body ?? `Let users do the thing described by ${title}.`;
  const content = `---
id: ${id}
title: ${title}
status: draft
depends_on: []
---

## Intent

${body}

## Acceptance criteria

- AC-1: Given a user, when they act, then something happens.
`;

  const fullPath = path.join(dir, filename);
  Deno.writeTextFileSync(fullPath, content);

  const relPath = path.relative(root, fullPath);
  return relPath;
}

/** Create a canonical spec and its snapshot (in-sync state) */
function createSyncedSpec(
  root: string,
  id: string,
  title: string,
): string {
  const relPath = createSpec(root, id, title);
  const fullPath = path.join(root, relPath);
  const bytes = Deno.readTextFileSync(fullPath);

  // Canonicalize
  const canonical = toCanonicalForm(bytes, relPath);
  assert(canonical !== null, `spec should parse: ${relPath}`);

  // Write canonical form back to the spec file so it matches snapshot
  Deno.writeTextFileSync(fullPath, canonical);

  // Write snapshot
  writeSnapshot(root, id, canonical);
  return relPath;
}

// ─── AC-1: in-sync when canonical form matches snapshot ─────────────────────

Deno.test("AC-1: spec whose canonical form equals snapshot is reported as in-sync", () => {
  withProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");

    const status = detectDrift(root, "FEAT-0001", relPath);
    assertEquals(status, "in-sync");
  });
});

Deno.test("AC-1: status command shows in-sync spec", () => {
  withProject((root) => {
    createSyncedSpec(root, "FEAT-0001", "Feature one");

    const result = getStatus(root);
    assertEquals(result.entries.length, 1);
    assertEquals(result.entries[0].id, "FEAT-0001");
    assertEquals(result.entries[0].status, "in-sync");
  });
});

Deno.test("AC-1: formatting-only differences (key order, blank lines) do not cause drift", () => {
  withProject((root) => {
    // Create synced spec
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");

    // Rewrite the spec file with non-canonical frontmatter key order
    // and extra blank lines between sections — the parser normalizes these
    const fullPath = path.join(root, relPath);
    const modified = `---
title: Feature one
status: draft
id: FEAT-0001
depends_on: []
---


## Intent


Let users do the thing described by Feature one.



## Acceptance criteria


- AC-1: Given a user, when they act, then something happens.
`;
    Deno.writeTextFileSync(fullPath, modified);

    // Canonical form should still match (frontmatter key order normalized,
    // extra blank lines around sections normalized)
    const status = detectDrift(root, "FEAT-0001", relPath);
    assertEquals(status, "in-sync");
  });
});

// ─── AC-2: drifted when canonical form differs from snapshot ────────────────

Deno.test("AC-2: spec with changed body is reported as drifted", () => {
  withProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");

    // Modify the spec body
    const fullPath = path.join(root, relPath);
    const original = Deno.readTextFileSync(fullPath);
    const modified = original.replace(
      "Let users do the thing described by Feature one.",
      "Completely different intent text here.",
    );
    Deno.writeTextFileSync(fullPath, modified);

    const status = detectDrift(root, "FEAT-0001", relPath);
    assertEquals(status, "drifted");
  });
});

Deno.test("AC-2: spec with changed frontmatter is reported as drifted", () => {
  withProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");

    // Modify the status field
    const fullPath = path.join(root, relPath);
    const original = Deno.readTextFileSync(fullPath);
    const modified = original.replace("status: draft", "status: active");
    Deno.writeTextFileSync(fullPath, modified);

    const status = detectDrift(root, "FEAT-0001", relPath);
    assertEquals(status, "drifted");
  });
});

Deno.test("AC-2: specman status --diff includes unified diff for drifted spec", () => {
  withProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");

    // Modify the spec
    const fullPath = path.join(root, relPath);
    const original = Deno.readTextFileSync(fullPath);
    const modified = original.replace(
      "Let users do the thing described by Feature one.",
      "New intent text.",
    );
    Deno.writeTextFileSync(fullPath, modified);

    const diff = generateDiff(root, "FEAT-0001", relPath);
    assert(diff !== null, "diff should be generated for drifted spec");
    assertStringIncludes(diff, "---");
    assertStringIncludes(diff, "+++");
    assertStringIncludes(diff, "@@");
    assertStringIncludes(diff, "-Let users do the thing described by Feature one.");
    assertStringIncludes(diff, "+New intent text.");
  });
});

Deno.test("AC-2: status command reports drifted spec", () => {
  withProject((root) => {
    createSyncedSpec(root, "FEAT-0001", "Feature one");

    // Modify the spec
    const specPath = path.join(root, "specs", "FEAT-0001-feature-one.md");
    const original = Deno.readTextFileSync(specPath);
    const modified = original.replace("status: draft", "status: active");
    Deno.writeTextFileSync(specPath, modified);

    const result = getStatus(root);
    const entry = result.entries.find((e) => e.id === "FEAT-0001");
    assert(entry !== undefined);
    assertEquals(entry.status, "drifted");
  });
});

// ─── AC-3: new when no snapshot exists ──────────────────────────────────────

Deno.test("AC-3: spec with no snapshot is reported as new", () => {
  withProject((root) => {
    const relPath = createSpec(root, "FEAT-0001", "Feature one");

    const status = detectDrift(root, "FEAT-0001", relPath);
    assertEquals(status, "new");
  });
});

Deno.test("AC-3: status command reports new spec", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");

    const result = getStatus(root);
    const entry = result.entries.find((e) => e.id === "FEAT-0001");
    assert(entry !== undefined);
    assertEquals(entry.status, "new");
    assert(entry.hint?.includes("no snapshot yet"));
  });
});

// ─── AC-4: orphan snapshots reported by validate ────────────────────────────

Deno.test("AC-4: orphan snapshot (no matching spec) is reported by validate", () => {
  withProject((root) => {
    // Create a snapshot without a corresponding spec
    const implDir = path.join(root, ".specman", "implemented");
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0099.md"),
      "---\nid: FEAT-0099\ntitle: Ghost\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nGhost spec.\n\n## Acceptance criteria\n\n- AC-1: Ghost.\n",
    );

    const validation = validateSnapshots(root);
    assertEquals(validation.orphans.length, 1);
    assertEquals(validation.orphans[0].id, "FEAT-0099");
    assertStringIncludes(validation.orphans[0].snapshotPath, "FEAT-0099.md");
  });
});

Deno.test("AC-4: orphan snapshot naming in validate output", () => {
  withProject((root) => {
    const implDir = path.join(root, ".specman", "implemented");
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0099.md"),
      "---\nid: FEAT-0099\ntitle: Ghost\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nGhost.\n\n## Acceptance criteria\n\n- AC-1: Ghost.\n",
    );

    const validation = validateSnapshots(root);
    const [lines, hasErrors] = formatValidation(validation);
    assert(hasErrors);
    assert(lines.some((l) => l.includes("orphan") && l.includes("FEAT-0099")));
  });
});

// ─── AC-5: mismatched snapshot id ───────────────────────────────────────────

Deno.test("AC-5: snapshot whose parsed id does not match filename is reported as mismatched", () => {
  withProject((root) => {
    // Create a spec so the snapshot is not also orphaned
    createSpec(root, "FEAT-0001", "Feature one");

    // Create a snapshot file named FEAT-0001.md but with id: FEAT-0099 inside
    const implDir = path.join(root, ".specman", "implemented");
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0001.md"),
      "---\nid: FEAT-0099\ntitle: Wrong\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nMismatched.\n\n## Acceptance criteria\n\n- AC-1: Wrong.\n",
    );

    const validation = validateSnapshots(root);
    assertEquals(validation.mismatches.length, 1);
    assertEquals(validation.mismatches[0].filenameId, "FEAT-0001");
    assertEquals(validation.mismatches[0].parsedId, "FEAT-0099");
  });
});

Deno.test("AC-5: mismatched snapshot in validate output", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");

    const implDir = path.join(root, ".specman", "implemented");
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0001.md"),
      "---\nid: FEAT-0099\ntitle: Wrong\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nMismatched.\n\n## Acceptance criteria\n\n- AC-1: Wrong.\n",
    );

    const validation = validateSnapshots(root);
    const [lines, hasErrors] = formatValidation(validation);
    assert(hasErrors);
    assert(lines.some((l) => l.includes("mismatch") && l.includes("FEAT-0001") && l.includes("FEAT-0099")));
  });
});

// ─── AC-6: writeSnapshot only writes canonical bytes ────────────────────────

Deno.test("AC-6: writeSnapshot writes exact bytes passed to it", () => {
  withProject((root) => {
    const canonical = "---\nid: FEAT-0001\ntitle: Test\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nTest.\n\n## Acceptance criteria\n\n- AC-1: Test.\n";
    writeSnapshot(root, "FEAT-0001", canonical);

    const read = readSnapshot(root, "FEAT-0001");
    assertEquals(read, canonical);
  });
});

Deno.test("AC-6: writeSnapshot creates implemented directory if missing", () => {
  withProject((root) => {
    // Remove the implemented dir
    Deno.removeSync(path.join(root, ".specman", "implemented"));

    const canonical = "test content";
    writeSnapshot(root, "FEAT-0001", canonical);

    const read = readSnapshot(root, "FEAT-0001");
    assertEquals(read, canonical);
  });
});

// ─── AC-7: snapshot not modified by non-sync code ───────────────────────────

Deno.test("AC-7: readSnapshot and detectDrift never modify snapshot files", () => {
  withProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");
    const snapshotPath = path.join(root, ".specman", "implemented", "FEAT-0001.md");
    const originalSnapshot = Deno.readTextFileSync(snapshotPath);
    const originalMtime = Deno.statSync(snapshotPath).mtime;

    // Read operations should not modify
    readSnapshot(root, "FEAT-0001");
    detectDrift(root, "FEAT-0001", relPath);
    getStatus(root);
    validateSnapshots(root);

    const afterSnapshot = Deno.readTextFileSync(snapshotPath);
    assertEquals(afterSnapshot, originalSnapshot);
  });
});

// ─── AC-8: default status output ────────────────────────────────────────────

Deno.test("AC-8: default status shows drifted and new, summarizes in-sync as count", () => {
  withProject((root) => {
    // One in-sync
    createSyncedSpec(root, "FEAT-0001", "Feature one");
    // One drifted
    createSyncedSpec(root, "FEAT-0042", "Feature forty two");
    const specPath42 = path.join(root, "specs", "FEAT-0042-feature-forty-two.md");
    const orig42 = Deno.readTextFileSync(specPath42);
    Deno.writeTextFileSync(specPath42, orig42.replace("status: draft", "status: active"));
    // One new
    createSpec(root, "FEAT-0099", "Feature ninety nine");

    const result = getStatus(root);
    const lines = formatStatus(result);

    // Should show FEAT-0042 drifted
    assert(lines.some((l) => l.includes("FEAT-0042") && l.includes("drifted")));
    // Should show FEAT-0099 new
    assert(lines.some((l) => l.includes("FEAT-0099") && l.includes("new")));
    // Should summarize in-sync as count
    assert(lines.some((l) => l.includes("1") && l.includes("in-sync")));
    // Should NOT show FEAT-0001 individually (it's in-sync, not --verbose)
    assert(!lines.some((l) => l.includes("FEAT-0001") && l.includes("in-sync")));
  });
});

Deno.test("AC-8: --verbose shows all specs including in-sync", () => {
  withProject((root) => {
    createSyncedSpec(root, "FEAT-0001", "Feature one");
    createSpec(root, "FEAT-0002", "Feature two");

    const result = getStatus(root);
    const lines = formatStatus(result, { verbose: true });

    // Should show both specs
    assert(lines.some((l) => l.includes("FEAT-0001") && l.includes("in-sync")));
    assert(lines.some((l) => l.includes("FEAT-0002") && l.includes("new")));
  });
});

Deno.test("AC-8: multiple in-sync specs uses plural", () => {
  withProject((root) => {
    createSyncedSpec(root, "FEAT-0001", "Feature one");
    createSyncedSpec(root, "FEAT-0002", "Feature two");

    const result = getStatus(root);
    const lines = formatStatus(result);

    assert(lines.some((l) => l.includes("2 specs in-sync")));
  });
});

Deno.test("AC-8: single in-sync spec uses singular", () => {
  withProject((root) => {
    createSyncedSpec(root, "FEAT-0001", "Feature one");

    const result = getStatus(root);
    const lines = formatStatus(result);

    assert(lines.some((l) => l.includes("1 spec in-sync")));
  });
});

// ─── AC-9: malformed spec falls back to raw byte comparison ─────────────────

Deno.test("AC-9: malformed spec (bad YAML) falls back to raw byte comparison", () => {
  withProject((root) => {
    // Create a snapshot with raw bytes
    const rawBytes = "---\nid: FEAT-0001\nbad yaml: [\nunterminated\n---\n\n## Intent\n\nBroken.\n";
    writeSnapshot(root, "FEAT-0001", rawBytes);

    // Create spec file with same raw bytes
    const specFile = path.join(root, "specs", "FEAT-0001-broken.md");
    Deno.writeTextFileSync(specFile, rawBytes);

    // Same bytes → raw comparison → "in-sync"
    const status1 = detectDrift(root, "FEAT-0001", "specs/FEAT-0001-broken.md");
    assertEquals(status1, "in-sync");

    // Now change the spec — raw comparison → "drifted"
    Deno.writeTextFileSync(specFile, rawBytes + "\nextra line");
    const status2 = detectDrift(root, "FEAT-0001", "specs/FEAT-0001-broken.md");
    assertEquals(status2, "drifted");
  });
});

Deno.test("AC-9: malformed spec (unterminated frontmatter) falls back to raw comparison", () => {
  withProject((root) => {
    // Unterminated frontmatter — will fail to parse
    const rawBytes = "---\nid: FEAT-0001\ntitle: Unterminated\n";
    writeSnapshot(root, "FEAT-0001", rawBytes);

    const specFile = path.join(root, "specs", "FEAT-0001-unterminated.md");
    Deno.writeTextFileSync(specFile, rawBytes);

    // Same bytes → "in-sync" via raw fallback
    assertEquals(
      detectDrift(root, "FEAT-0001", "specs/FEAT-0001-unterminated.md"),
      "in-sync",
    );

    // Different bytes → "drifted" via raw fallback
    Deno.writeTextFileSync(specFile, rawBytes + "extra\n");
    assertEquals(
      detectDrift(root, "FEAT-0001", "specs/FEAT-0001-unterminated.md"),
      "drifted",
    );
  });
});

Deno.test("AC-9: malformed spec with no snapshot is still 'new'", () => {
  withProject((root) => {
    // Malformed spec, no snapshot
    const specFile = path.join(root, "specs", "FEAT-0001-broken.md");
    Deno.writeTextFileSync(specFile, "---\nbad: [\n");

    assertEquals(
      detectDrift(root, "FEAT-0001", "specs/FEAT-0001-broken.md"),
      "new",
    );
  });
});

// ─── toCanonicalForm ────────────────────────────────────────────────────────

Deno.test("toCanonicalForm: returns canonical bytes for valid spec", () => {
  const bytes = "---\nid: FEAT-0001\ntitle: Test\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nHello.\n\n## Acceptance criteria\n\n- AC-1: Test.\n";
  const canonical = toCanonicalForm(bytes, "test.md");
  assert(canonical !== null);
  // Should parse and re-serialize
  assertEquals(typeof canonical, "string");
});

Deno.test("toCanonicalForm: returns null for malformed spec", () => {
  const bytes = "not a spec at all";
  const canonical = toCanonicalForm(bytes, "bad.md");
  assertEquals(canonical, null);
});

Deno.test("toCanonicalForm: normalizes frontmatter key order", () => {
  // Non-canonical key order
  const bytes = "---\ntitle: Test\nstatus: draft\nid: FEAT-0001\ndepends_on: []\n---\n\n## Intent\n\nHello.\n\n## Acceptance criteria\n\n- AC-1: Test.\n";
  const canonical = toCanonicalForm(bytes, "test.md");
  assert(canonical !== null);
  // id should come before title in canonical form
  const idPos = canonical.indexOf("id:");
  const titlePos = canonical.indexOf("title:");
  assert(idPos < titlePos, "id should come before title in canonical form");
});

// ─── scanSpecs / scanSnapshots ──────────────────────────────────────────────

Deno.test("scanSpecs: finds specs in root and subdirectories", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");
    createSpec(root, "FEAT-0002", "Feature two", { subdir: "cli" });
    createSpec(root, "FEAT-0003", "Feature three", { subdir: "ui/deep" });

    const specs = scanSpecs(root);
    assertEquals(specs.length, 3);
    assertEquals(specs[0].id, "FEAT-0001");
    assertEquals(specs[1].id, "FEAT-0002");
    assertEquals(specs[2].id, "FEAT-0003");
  });
});

Deno.test("scanSpecs: skips specs/assets/", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");
    // File in assets
    const assetsDir = path.join(root, "specs", "assets");
    Deno.mkdirSync(assetsDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(assetsDir, "FEAT-9999-notes.md"),
      "not a spec",
    );

    const specs = scanSpecs(root);
    assertEquals(specs.length, 1);
    assertEquals(specs[0].id, "FEAT-0001");
  });
});

Deno.test("scanSnapshots: finds snapshot files", () => {
  withProject((root) => {
    writeSnapshot(root, "FEAT-0001", "content 1");
    writeSnapshot(root, "FEAT-0042", "content 42");

    const snapshots = scanSnapshots(root);
    assertEquals(snapshots.length, 2);
    assertEquals(snapshots[0].filenameId, "FEAT-0001");
    assertEquals(snapshots[1].filenameId, "FEAT-0042");
  });
});

// ─── unifiedDiff ────────────────────────────────────────────────────────────

Deno.test("unifiedDiff: produces correct diff output", () => {
  const oldText = "line 1\nline 2\nline 3\n";
  const newText = "line 1\nline 2 modified\nline 3\n";

  const diff = unifiedDiff(oldText, newText, "old.md", "new.md");
  assertStringIncludes(diff, "--- old.md");
  assertStringIncludes(diff, "+++ new.md");
  assertStringIncludes(diff, "-line 2");
  assertStringIncludes(diff, "+line 2 modified");
});

Deno.test("unifiedDiff: identical texts produce no hunks", () => {
  const text = "same\ncontent\n";
  const diff = unifiedDiff(text, text, "a", "b");
  // Should have headers but no hunks
  assertStringIncludes(diff, "--- a");
  assertStringIncludes(diff, "+++ b");
  assert(!diff.includes("@@"));
});

// ─── generateDiff ───────────────────────────────────────────────────────────

Deno.test("generateDiff: returns null for spec with no snapshot", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");
    const diff = generateDiff(root, "FEAT-0001", "specs/FEAT-0001-feature-one.md");
    assertEquals(diff, null);
  });
});

Deno.test("generateDiff: returns diff for drifted spec", () => {
  withProject((root) => {
    const relPath = createSyncedSpec(root, "FEAT-0001", "Feature one");

    // Modify spec
    const fullPath = path.join(root, relPath);
    const original = Deno.readTextFileSync(fullPath);
    Deno.writeTextFileSync(fullPath, original.replace("status: draft", "status: shipped"));

    const diff = generateDiff(root, "FEAT-0001", relPath);
    assert(diff !== null);
    assertStringIncludes(diff, "draft");
    assertStringIncludes(diff, "shipped");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

Deno.test("edge: readSnapshot returns null when no snapshot exists", () => {
  withProject((root) => {
    const result = readSnapshot(root, "FEAT-9999");
    assertEquals(result, null);
  });
});

Deno.test("edge: empty project has no specs and no issues", () => {
  withProject((root) => {
    const status = getStatus(root);
    assertEquals(status.entries.length, 0);

    const validation = validateSnapshots(root);
    assertEquals(validation.orphans.length, 0);
    assertEquals(validation.mismatches.length, 0);
  });
});

Deno.test("edge: formatStatus with no specs shows message", () => {
  const lines = formatStatus({ entries: [] });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "No specs found");
});

Deno.test("edge: snapshot keyed by FEAT-ID not filename", () => {
  withProject((root) => {
    // Create a spec with a specific filename
    const relPath = createSyncedSpec(root, "FEAT-0001", "Original name");

    // Verify snapshot is named by ID, not by spec filename
    const snapshotPath = path.join(root, ".specman", "implemented", "FEAT-0001.md");
    const exists = (() => {
      try {
        Deno.statSync(snapshotPath);
        return true;
      } catch {
        return false;
      }
    })();
    assert(exists, "snapshot should be named FEAT-0001.md regardless of spec filename");
  });
});

Deno.test("edge: validate detects both orphan and mismatch simultaneously", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");

    const implDir = path.join(root, ".specman", "implemented");
    // Orphan: no matching spec
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0099.md"),
      "---\nid: FEAT-0099\ntitle: Ghost\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nGhost.\n\n## Acceptance criteria\n\n- AC-1: Ghost.\n",
    );
    // Mismatch: filename says FEAT-0001, content says FEAT-0002
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0001.md"),
      "---\nid: FEAT-0002\ntitle: Wrong\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nWrong.\n\n## Acceptance criteria\n\n- AC-1: Wrong.\n",
    );

    const validation = validateSnapshots(root);
    assertEquals(validation.orphans.length, 1);
    assertEquals(validation.mismatches.length, 1);
  });
});

Deno.test("edge: formatValidation with no issues returns no lines and no errors", () => {
  const [lines, hasErrors] = formatValidation({ orphans: [], mismatches: [] });
  assertEquals(lines.length, 0);
  assertEquals(hasErrors, false);
});

Deno.test("edge: writeSnapshot overwrites existing snapshot", () => {
  withProject((root) => {
    writeSnapshot(root, "FEAT-0001", "version 1");
    assertEquals(readSnapshot(root, "FEAT-0001"), "version 1");

    writeSnapshot(root, "FEAT-0001", "version 2");
    assertEquals(readSnapshot(root, "FEAT-0001"), "version 2");
  });
});

Deno.test("edge: status with only in-sync specs shows just the count", () => {
  withProject((root) => {
    createSyncedSpec(root, "FEAT-0001", "Feature one");
    createSyncedSpec(root, "FEAT-0002", "Feature two");

    const result = getStatus(root);
    const lines = formatStatus(result);

    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "2 specs in-sync");
  });
});

Deno.test("edge: status with only new specs shows them all", () => {
  withProject((root) => {
    createSpec(root, "FEAT-0001", "Feature one");
    createSpec(root, "FEAT-0002", "Feature two");

    const result = getStatus(root);
    const lines = formatStatus(result);

    assert(lines.some((l) => l.includes("FEAT-0001") && l.includes("new")));
    assert(lines.some((l) => l.includes("FEAT-0002") && l.includes("new")));
  });
});
