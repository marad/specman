/**
 * Tests for FEAT-0007: Validate command
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0007-validate-command.md
 */

import { assertEquals, assert, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  validate,
  formatHuman,
  formatJson,
  exitCode,
  type ValidateResult,
  type ValidateOptions,
  type Finding,
} from "./validate.ts";
import { init } from "./init.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withProject(fn: (root: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_val_test_" });
  try {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** Create a well-formed spec file with all required fields and sections */
function createValidSpec(
  root: string,
  id: string,
  title: string,
  opts?: {
    dependsOn?: string[];
    subdir?: string;
    status?: string;
  },
): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const filename = `${id}-${slug}.md`;
  const dir = opts?.subdir
    ? path.join(root, "specs", opts.subdir)
    : path.join(root, "specs");

  Deno.mkdirSync(dir, { recursive: true });

  const depsArray = opts?.dependsOn ?? [];
  const depsStr = depsArray.length > 0
    ? `[${depsArray.join(", ")}]`
    : "[]";

  const content = `---
id: ${id}
title: ${title}
status: ${opts?.status ?? "draft"}
depends_on: ${depsStr}
---

## Intent

${title} intent description here.

## Acceptance criteria

- AC-1: Given a user, when they act, then something happens.
`;

  const fullPath = path.join(dir, filename);
  Deno.writeTextFileSync(fullPath, content);
  return path.relative(root, fullPath);
}

/** Create a spec file with raw content */
function createRawSpec(
  root: string,
  filename: string,
  content: string,
  subdir?: string,
): string {
  const dir = subdir
    ? path.join(root, "specs", subdir)
    : path.join(root, "specs");
  Deno.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  Deno.writeTextFileSync(fullPath, content);
  return path.relative(root, fullPath);
}

function findingCodes(result: ValidateResult): string[] {
  return result.findings.map((f) => f.code);
}

function findingsForCode(result: ValidateResult, code: string): Finding[] {
  return result.findings.filter((f) => f.code === code);
}

function errors(result: ValidateResult): Finding[] {
  return result.findings.filter((f) => f.severity === "error");
}

function warnings(result: ValidateResult): Finding[] {
  return result.findings.filter((f) => f.severity === "warning");
}

// ─── AC-1: Clean repo exits 0 with summary ─────────────────────────────────

Deno.test("AC-1: clean repo exits 0 with spec count in summary", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two");

    const result = validate(root);

    assertEquals(errors(result).length, 0);
    assertEquals(result.specsChecked, 2);
    assertEquals(exitCode(result, {}), 0);

    const lines = formatHuman(result);
    const summary = lines[lines.length - 1];
    assertStringIncludes(summary, "2 specs checked");
    assertStringIncludes(summary, "0 errors");
  });
});

Deno.test("AC-1: clean repo with depends_on targeting existing specs passes", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-0001"] });

    const result = validate(root);
    assertEquals(errors(result).length, 0);
    assertEquals(exitCode(result, {}), 0);
  });
});

// ─── AC-2: Duplicate ID across files ────────────────────────────────────────

Deno.test("AC-2: two specs with same id reports error for both files", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    // Second file with same id
    createRawSpec(root, "FEAT-0001-alt.md", `---
id: FEAT-0001
title: Alternate feature
status: draft
depends_on: []
---

## Intent

Alt intent.

## Acceptance criteria

- AC-1: Alt criterion.
`);

    const result = validate(root);
    const dupFindings = findingsForCode(result, "E001-duplicate-id");

    assertEquals(dupFindings.length, 2, "should report both files");
    assert(dupFindings.every((f) => f.severity === "error"));
    assertEquals(exitCode(result, {}), 1);

    // Both files mentioned
    const paths = dupFindings.map((f) => f.path).sort();
    assert(paths.some((p) => p.includes("FEAT-0001-alt.md")));
    assert(paths.some((p) => p.includes("FEAT-0001-feature-one.md")));
  });
});

// ─── AC-3: depends_on references nonexistent spec ───────────────────────────

Deno.test("AC-3: depends_on referencing nonexistent id reports error", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-9999"] });

    const result = validate(root);
    const depFindings = findingsForCode(result, "E006-depends-on-missing");

    assertEquals(depFindings.length, 1);
    assertEquals(depFindings[0].severity, "error");
    assertStringIncludes(depFindings[0].message, "FEAT-9999");
    assertEquals(exitCode(result, {}), 1);
  });
});

Deno.test("AC-3: depends_on referencing existing id is fine", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-0001"] });

    const result = validate(root);
    const depFindings = findingsForCode(result, "E006-depends-on-missing");
    assertEquals(depFindings.length, 0);
  });
});

// ─── AC-4: Cycle detection ──────────────────────────────────────────────────

Deno.test("AC-4: cycle of length 2 is detected", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-0002"] });
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-0001"] });

    const result = validate(root);
    const cycleFindings = findingsForCode(result, "E007-cycle");

    assert(cycleFindings.length >= 1, "should detect cycle");
    assertEquals(cycleFindings[0].severity, "error");
    assertStringIncludes(cycleFindings[0].message, "FEAT-0001");
    assertStringIncludes(cycleFindings[0].message, "FEAT-0002");
    assertEquals(exitCode(result, {}), 1);
  });
});

Deno.test("AC-4: cycle of length 3 is detected", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-0002"] });
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-0003"] });
    createValidSpec(root, "FEAT-0003", "Feature three", { dependsOn: ["FEAT-0001"] });

    const result = validate(root);
    const cycleFindings = findingsForCode(result, "E007-cycle");

    assert(cycleFindings.length >= 1, "should detect cycle");
    assertEquals(cycleFindings[0].severity, "error");
  });
});

Deno.test("AC-4: self-reference is ignored (no cycle)", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-0001"] });

    const result = validate(root);
    const cycleFindings = findingsForCode(result, "E007-cycle");
    assertEquals(cycleFindings.length, 0, "self-reference should not be a cycle");

    // Also no depends_on missing error — self-ref targets existing spec
    const depFindings = findingsForCode(result, "E006-depends-on-missing");
    assertEquals(depFindings.length, 0);
  });
});

Deno.test("AC-4: DAG with no cycles passes", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-0001"] });
    createValidSpec(root, "FEAT-0003", "Feature three", { dependsOn: ["FEAT-0001", "FEAT-0002"] });

    const result = validate(root);
    const cycleFindings = findingsForCode(result, "E007-cycle");
    assertEquals(cycleFindings.length, 0);
  });
});

// ─── AC-5: Filename convention warning ──────────────────────────────────────

Deno.test("AC-5: non-conventional filename produces warning", () => {
  withProject((root) => {
    createRawSpec(root, "notes-on-future-ideas.md", `---
id: FEAT-0099
title: Future ideas
status: draft
depends_on: []
---

## Intent

Some ideas.

## Acceptance criteria

- AC-1: Some criterion.
`);

    const result = validate(root);
    const fnFindings = findingsForCode(result, "W001-filename-convention");

    assertEquals(fnFindings.length, 1);
    assertEquals(fnFindings[0].severity, "warning");
    assertStringIncludes(fnFindings[0].message, "filename does not match");
  });
});

Deno.test("AC-5: conventional filename produces no warning", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    const result = validate(root);
    const fnFindings = findingsForCode(result, "W001-filename-convention");
    assertEquals(fnFindings.length, 0);
  });
});

// ─── FEAT-0001 AC-6: Invalid status value ──────────────────────────────────

Deno.test("FEAT-0001 AC-6: invalid status value is rejected with offending value named", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { status: "banana" });

    const result = validate(root);
    const statusFindings = findingsForCode(result, "E012-invalid-status");

    assertEquals(statusFindings.length, 1);
    assertEquals(statusFindings[0].severity, "error");
    assertStringIncludes(statusFindings[0].message, "banana");
    assertStringIncludes(statusFindings[0].message, "draft");
    assertStringIncludes(statusFindings[0].message, "active");
    assertStringIncludes(statusFindings[0].message, "shipped");
    assertStringIncludes(statusFindings[0].message, "deprecated");
    assertEquals(exitCode(result, {}), 1);
  });
});

Deno.test("FEAT-0001 AC-6: valid status values are accepted", () => {
  for (const status of ["draft", "active", "shipped", "deprecated"]) {
    withProject((root) => {
      createValidSpec(root, "FEAT-0001", "Feature one", { status });

      const result = validate(root);
      const statusFindings = findingsForCode(result, "E012-invalid-status");
      assertEquals(statusFindings.length, 0, `status '${status}' should be valid`);
    });
  }
});

Deno.test("FEAT-0001 AC-6: non-string status gets type error not status error", () => {
  withProject((root) => {
    // status: 42 is not a string, so it should get a type error, not an invalid-status error
    const specPath = path.join(root, "specs", "FEAT-0001-test.md");
    Deno.writeTextFileSync(specPath, `---
id: FEAT-0001
title: Test
status: 42
depends_on: []
---

## Intent

Test intent.

## Acceptance criteria

- AC-1: Test criterion.
`);

    const result = validate(root);
    const statusFindings = findingsForCode(result, "E012-invalid-status");
    assertEquals(statusFindings.length, 0, "non-string status should not trigger invalid-status");
    const typeFindings = findingsForCode(result, "E003-wrong-type");
    assert(typeFindings.length > 0, "non-string status should trigger wrong-type");
  });
});

// ─── AC-6: Orphan snapshot ──────────────────────────────────────────────────

Deno.test("AC-6: snapshot with no matching spec is orphaned error", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    // Create orphan snapshot
    Deno.writeTextFileSync(
      path.join(root, ".specman", "implemented", "FEAT-0099.md"),
      `---
id: FEAT-0099
title: Ghost
status: draft
depends_on: []
---

## Intent

Ghost.

## Acceptance criteria

- AC-1: Ghost.
`,
    );

    const result = validate(root);
    const orphanFindings = findingsForCode(result, "E009-orphan-snapshot");

    assertEquals(orphanFindings.length, 1);
    assertEquals(orphanFindings[0].severity, "error");
    assertStringIncludes(orphanFindings[0].message, "FEAT-0099");
    assertEquals(exitCode(result, {}), 1);
  });
});

// ─── AC-7: Warnings without errors → exit 0; with --strict → exit 1 ────────

Deno.test("AC-7: warnings only → exit 0 by default", () => {
  withProject((root) => {
    // File with non-conventional name → warning only
    createRawSpec(root, "notes.md", `---
id: FEAT-0001
title: Notes
status: draft
depends_on: []
---

## Intent

Notes intent.

## Acceptance criteria

- AC-1: Notes criterion.
`);

    const result = validate(root);
    assertEquals(errors(result).length, 0);
    assert(warnings(result).length > 0);
    assertEquals(exitCode(result, {}), 0);
  });
});

Deno.test("AC-7: warnings only with --strict → exit 1", () => {
  withProject((root) => {
    createRawSpec(root, "notes.md", `---
id: FEAT-0001
title: Notes
status: draft
depends_on: []
---

## Intent

Notes intent.

## Acceptance criteria

- AC-1: Notes criterion.
`);

    const result = validate(root);
    assertEquals(errors(result).length, 0);
    assert(warnings(result).length > 0);
    assertEquals(exitCode(result, { strict: true }), 1);
  });
});

// ─── AC-8: JSON output format ───────────────────────────────────────────────

Deno.test("AC-8: JSON output has summary and findings array", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-9999"] });

    const result = validate(root);
    const jsonStr = formatJson(result);
    const parsed = JSON.parse(jsonStr);

    // Summary
    assert("summary" in parsed);
    assertEquals(parsed.summary.specs_checked, 2);
    assert(typeof parsed.summary.errors === "number");
    assert(typeof parsed.summary.warnings === "number");

    // Findings
    assert(Array.isArray(parsed.findings));
    assert(parsed.findings.length > 0);

    // Each finding has required fields
    for (const f of parsed.findings) {
      assert("code" in f, "finding must have code");
      assert("severity" in f, "finding must have severity");
      assert("path" in f, "finding must have path");
      assert("message" in f, "finding must have message");
    }
  });
});

Deno.test("AC-8: JSON output for clean repo", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    const result = validate(root);
    const jsonStr = formatJson(result);
    const parsed = JSON.parse(jsonStr);

    assertEquals(parsed.summary.specs_checked, 1);
    assertEquals(parsed.summary.errors, 0);
    assertEquals(parsed.findings.length, 0);
  });
});

// ─── AC-9: Deterministic output ────────────────────────────────────────────

Deno.test("AC-9: two runs produce identical human output", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two", { dependsOn: ["FEAT-0001"] });
    createValidSpec(root, "FEAT-0003", "Feature three", { dependsOn: ["FEAT-9999"] });

    const result1 = validate(root);
    const result2 = validate(root);

    const human1 = formatHuman(result1).join("\n");
    const human2 = formatHuman(result2).join("\n");
    assertEquals(human1, human2);

    const json1 = formatJson(result1);
    const json2 = formatJson(result2);
    assertEquals(json1, json2);
  });
});

// ─── AC-10: Parser errors come through unchanged ────────────────────────────

Deno.test("AC-10: parser error surfaces with original path, line, and reason", () => {
  withProject((root) => {
    createRawSpec(root, "FEAT-0001-broken.md", `---
bad: [unclosed
---`);

    const result = validate(root);
    const parseFindings = findingsForCode(result, "E000-parse-error");

    assertEquals(parseFindings.length, 1);
    assertEquals(parseFindings[0].severity, "error");
    assertStringIncludes(parseFindings[0].path, "FEAT-0001-broken.md");
    assert(parseFindings[0].line !== undefined, "should have line number");
    assertStringIncludes(parseFindings[0].message, "malformed YAML");
  });
});

Deno.test("AC-10: parser errors are not downgraded or relabeled", () => {
  withProject((root) => {
    // Missing frontmatter
    createRawSpec(root, "FEAT-0001-no-fm.md", `no frontmatter here`);

    const result = validate(root);
    const parseFindings = findingsForCode(result, "E000-parse-error");

    assertEquals(parseFindings.length, 1);
    assertEquals(parseFindings[0].severity, "error");
    assertStringIncludes(parseFindings[0].message, "missing frontmatter");
  });
});

// ─── AC-11: No specs/ directory ─────────────────────────────────────────────

Deno.test("AC-11: no specs/ directory returns specsChecked -1 with exit code 2", () => {
  const dir = Deno.makeTempDirSync({ prefix: "specman_val_test_" });
  try {
    // Don't create specs/ or .specman/
    const result = validate(dir);
    assertEquals(result.specsChecked, -1);
    assertEquals(exitCode(result, {}), 2);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ─── AC-12: Specs in subfolders discovered and checked ──────────────────────

Deno.test("AC-12: specs in subfolders are discovered and validated", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    createValidSpec(root, "FEAT-0002", "Feature two", { subdir: "cli" });
    createValidSpec(root, "FEAT-0003", "Feature three", { subdir: "ui/deep" });

    const result = validate(root);
    assertEquals(result.specsChecked, 3);
    assertEquals(errors(result).length, 0);
  });
});

Deno.test("AC-12: duplicate IDs across subfolders are detected", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    // Same id in a subfolder
    createRawSpec(root, "FEAT-0001-clone.md", `---
id: FEAT-0001
title: Clone
status: draft
depends_on: []
---

## Intent

Clone.

## Acceptance criteria

- AC-1: Clone criterion.
`, "cli");

    const result = validate(root);
    const dupFindings = findingsForCode(result, "E001-duplicate-id");
    assert(dupFindings.length >= 2, "should detect duplicate across subfolders");
  });
});

// ─── AC-13: specs/assets/ is ignored ────────────────────────────────────────

Deno.test("AC-13: files under specs/assets/ are ignored", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    // Create a file in assets/
    const assetsDir = path.join(root, "specs", "assets");
    Deno.mkdirSync(assetsDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(assetsDir, "notes.md"),
      "not a spec — should be ignored",
    );

    const result = validate(root);
    assertEquals(result.specsChecked, 1, "should only count the real spec");
    assertEquals(errors(result).length, 0);
  });
});

Deno.test("AC-13: FEAT-named files under specs/assets/ are also ignored", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    const assetsDir = path.join(root, "specs", "assets");
    Deno.mkdirSync(assetsDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(assetsDir, "FEAT-9999-notes.md"),
      `---
id: FEAT-9999
title: Should be ignored
status: draft
depends_on: []
---

## Intent

Ignored.

## Acceptance criteria

- AC-1: Ignored.
`,
    );

    const result = validate(root);
    assertEquals(result.specsChecked, 1);
  });
});

// ─── AC-14: Orphan plan file ────────────────────────────────────────────────

Deno.test("AC-14: plan file with no matching spec is orphaned error", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    // Create orphan plan
    const plansDir = path.join(root, ".specman", "plans");
    Deno.mkdirSync(plansDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(plansDir, "FEAT-0099.md"),
      "# Plan for FEAT-0099\n\nOrphan plan.\n",
    );

    const result = validate(root);
    const planFindings = findingsForCode(result, "E011-orphan-plan");

    assertEquals(planFindings.length, 1);
    assertEquals(planFindings[0].severity, "error");
    assertStringIncludes(planFindings[0].message, "FEAT-0099");
    assertEquals(exitCode(result, {}), 1);
  });
});

Deno.test("AC-14: plan file with matching spec is not flagged", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    const plansDir = path.join(root, ".specman", "plans");
    Deno.mkdirSync(plansDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(plansDir, "FEAT-0001.md"),
      "# Plan for FEAT-0001\n\nValid plan.\n",
    );

    const result = validate(root);
    const planFindings = findingsForCode(result, "E011-orphan-plan");
    assertEquals(planFindings.length, 0);
  });
});

// ─── Additional validation checks ──────────────────────────────────────────

Deno.test("validate: missing required frontmatter fields reported", () => {
  withProject((root) => {
    // Spec missing title, status, depends_on
    createRawSpec(root, "FEAT-0001-incomplete.md", `---
id: FEAT-0001
---

## Intent

Incomplete.

## Acceptance criteria

- AC-1: Test.
`);

    const result = validate(root);
    const missingFindings = findingsForCode(result, "E002-missing-field");

    // Should report missing title, status, depends_on
    assert(missingFindings.length >= 3, `expected >= 3 missing field errors, got ${missingFindings.length}`);
    const messages = missingFindings.map((f) => f.message);
    assert(messages.some((m) => m.includes("title")));
    assert(messages.some((m) => m.includes("status")));
    assert(messages.some((m) => m.includes("depends_on")));
  });
});

Deno.test("validate: wrong-type frontmatter fields reported", () => {
  withProject((root) => {
    createRawSpec(root, "FEAT-0001-wrong-types.md", `---
id: FEAT-0001
title: Test
status: 42
depends_on: FEAT-0010
---

## Intent

Wrong types.

## Acceptance criteria

- AC-1: Test.
`);

    const result = validate(root);
    const typeFindings = findingsForCode(result, "E003-wrong-type");

    assert(typeFindings.length >= 2, `expected >= 2 type errors, got ${typeFindings.length}`);
    const messages = typeFindings.map((f) => f.message);
    assert(messages.some((m) => m.includes("status")));
    assert(messages.some((m) => m.includes("depends_on")));
  });
});

Deno.test("validate: missing required sections reported", () => {
  withProject((root) => {
    createRawSpec(root, "FEAT-0001-no-sections.md", `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Behavior

Just behavior, no intent or AC.
`);

    const result = validate(root);
    const sectionFindings = findingsForCode(result, "E004-missing-section");

    assert(sectionFindings.length >= 2, `expected >= 2 missing section errors, got ${sectionFindings.length}`);
    const messages = sectionFindings.map((f) => f.message);
    assert(messages.some((m) => m.includes("Intent")));
    assert(messages.some((m) => m.includes("Acceptance criteria")));
  });
});

Deno.test("validate: empty required section body reported", () => {
  withProject((root) => {
    createRawSpec(root, "FEAT-0001-empty-intent.md", `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

## Acceptance criteria

- AC-1: Test criterion.
`);

    const result = validate(root);
    const emptyFindings = findingsForCode(result, "E005-empty-section");

    assertEquals(emptyFindings.length, 1);
    assertStringIncludes(emptyFindings[0].message, "Intent");
  });
});

Deno.test("validate: duplicate AC IDs within file reported", () => {
  withProject((root) => {
    createRawSpec(root, "FEAT-0001-dup-ac.md", `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

Test intent.

## Acceptance criteria

- AC-1: First version.
- AC-1: Duplicate version.
- AC-2: Unique.
`);

    const result = validate(root);
    const acFindings = findingsForCode(result, "E008-duplicate-ac");

    assertEquals(acFindings.length, 1);
    assertStringIncludes(acFindings[0].message, "AC-1");
    assertStringIncludes(acFindings[0].message, "2 times");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

Deno.test("edge: empty specs/ directory", () => {
  withProject((root) => {
    const result = validate(root);
    assertEquals(result.specsChecked, 0);
    assertEquals(errors(result).length, 0);
    assertEquals(exitCode(result, {}), 0);
  });
});

Deno.test("edge: all findings have stable codes", () => {
  withProject((root) => {
    // Create a mess of issues
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-9999"] });
    createRawSpec(root, "notes.md", `---
id: FEAT-0001
title: Duplicate
status: draft
depends_on: []
---

## Intent

Dup.

## Acceptance criteria

- AC-1: Dup.
`);

    const result = validate(root);
    // Every finding has a code
    for (const f of result.findings) {
      assert(f.code.length > 0, `finding must have a code: ${JSON.stringify(f)}`);
      assert(f.code.match(/^[EW]\d{3}-/), `code must match pattern: ${f.code}`);
    }
  });
});

Deno.test("edge: findings are attributable to at least one file path", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-9999"] });

    const result = validate(root);
    for (const f of result.findings) {
      assert(f.path.length > 0, `finding must have a path: ${JSON.stringify(f)}`);
    }
  });
});

Deno.test("edge: snapshot mismatch detected via validate", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");
    // Create snapshot with mismatched id
    const implDir = path.join(root, ".specman", "implemented");
    Deno.writeTextFileSync(
      path.join(implDir, "FEAT-0001.md"),
      `---
id: FEAT-0099
title: Wrong
status: draft
depends_on: []
---

## Intent

Wrong.

## Acceptance criteria

- AC-1: Wrong.
`,
    );

    const result = validate(root);
    const mismatchFindings = findingsForCode(result, "E010-snapshot-mismatch");
    assertEquals(mismatchFindings.length, 1);
    assertStringIncludes(mismatchFindings[0].message, "FEAT-0001");
    assertStringIncludes(mismatchFindings[0].message, "FEAT-0099");
  });
});

Deno.test("edge: multiple issues in single file all reported", () => {
  withProject((root) => {
    // File with bad name, missing fields, missing sections
    createRawSpec(root, "bad-file.md", `---
id: FEAT-0001
---
`);

    const result = validate(root);
    // Should have: W001 (filename), E002 (missing title, status, depends_on),
    // E004 (missing Intent, AC sections)
    assert(result.findings.length >= 5, `expected >= 5 findings, got ${result.findings.length}`);
  });
});

Deno.test("edge: validate is read-only — no files created or modified", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one");

    // Record file state before
    const specsBefore = [...Deno.readDirSync(path.join(root, "specs"))].map((e) => e.name).sort();
    const specmanBefore = [...Deno.readDirSync(path.join(root, ".specman"))].map((e) => e.name).sort();

    validate(root);

    // Verify no changes
    const specsAfter = [...Deno.readDirSync(path.join(root, "specs"))].map((e) => e.name).sort();
    const specmanAfter = [...Deno.readDirSync(path.join(root, ".specman"))].map((e) => e.name).sort();

    assertEquals(specsBefore, specsAfter);
    assertEquals(specmanBefore, specmanAfter);
  });
});

Deno.test("edge: human format includes file path and code in each finding line", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Feature one", { dependsOn: ["FEAT-9999"] });

    const result = validate(root);
    const lines = formatHuman(result);

    // There should be at least one finding line before the summary
    assert(lines.length >= 2);
    // Finding line should contain the path and code
    const findingLine = lines[0];
    assert(findingLine.includes("FEAT-0001"), `finding should mention spec path: ${findingLine}`);
    assert(findingLine.includes("E006"), `finding should mention error code: ${findingLine}`);
  });
});

Deno.test("edge: exit code is pure function of findings and flags", () => {
  // Same findings, same flags → same exit code
  const result: ValidateResult = {
    specsChecked: 1,
    findings: [{
      code: "W001-filename-convention",
      severity: "warning",
      path: "specs/notes.md",
      message: "test",
    }],
  };

  assertEquals(exitCode(result, {}), 0);
  assertEquals(exitCode(result, {}), 0);
  assertEquals(exitCode(result, { strict: true }), 1);
  assertEquals(exitCode(result, { strict: true }), 1);
});

Deno.test("edge: complex graph — diamond dependency is not a cycle", () => {
  withProject((root) => {
    createValidSpec(root, "FEAT-0001", "Base");
    createValidSpec(root, "FEAT-0002", "Left", { dependsOn: ["FEAT-0001"] });
    createValidSpec(root, "FEAT-0003", "Right", { dependsOn: ["FEAT-0001"] });
    createValidSpec(root, "FEAT-0004", "Top", { dependsOn: ["FEAT-0002", "FEAT-0003"] });

    const result = validate(root);
    const cycleFindings = findingsForCode(result, "E007-cycle");
    assertEquals(cycleFindings.length, 0, "diamond pattern is not a cycle");
  });
});

Deno.test("edge: JSON output is valid JSON even with special chars in messages", () => {
  withProject((root) => {
    createRawSpec(root, "FEAT-0001-special.md", `---
id: FEAT-0001
title: Test "special" chars & <things>
status: draft
depends_on: []
---

## Intent

Intent with "quotes" and <brackets>.

## Acceptance criteria

- AC-1: Criterion.
`);

    const result = validate(root);
    const jsonStr = formatJson(result);
    // Should not throw
    const parsed = JSON.parse(jsonStr);
    assert(parsed !== null);
  });
});
