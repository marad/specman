/**
 * Tests for FEAT-0008: New spec command
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0008-new-spec-command.md
 */

import { assertEquals, assert } from "@std/assert";
import { newSpec, isNewSpecError, deriveSlug } from "../src/new.ts";
import { parse, isParsedSpec, serialize } from "../src/parser.ts";
import { init } from "../src/init.ts";
import * as path from "@std/path";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withProject(fn: (root: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_test_" });
  try {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function readSpec(root: string, relPath: string): string {
  return Deno.readTextFileSync(path.join(root, relPath));
}

// ─── AC-1: First spec gets FEAT-0001 ──────────────────────────────────────

Deno.test("AC-1: no existing specs assigns FEAT-0001", () => {
  withProject((root) => {
    const result = newSpec({ title: "First feature", projectRoot: root });
    assert(!isNewSpecError(result));
    assertEquals(result.id, "FEAT-0001");
    assert(result.path.includes("FEAT-0001"));
  });
});

// ─── AC-2: Sequential ID assignment ───────────────────────────────────────

Deno.test("AC-2: existing FEAT-0001 through FEAT-0007 assigns FEAT-0008", () => {
  withProject((root) => {
    // Create stub files for FEAT-0001 through FEAT-0007
    for (let i = 1; i <= 7; i++) {
      const id = `FEAT-${String(i).padStart(4, "0")}`;
      const filename = `${id}-stub.md`;
      Deno.writeTextFileSync(
        path.join(root, "specs", filename),
        `---\nid: ${id}\ntitle: Stub\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nStub.\n\n## Acceptance criteria\n\n- AC-1: Stub.\n`
      );
    }

    const result = newSpec({ title: "Next feature", projectRoot: root });
    assert(!isNewSpecError(result));
    assertEquals(result.id, "FEAT-0008");
  });
});

// ─── AC-3: Recursive scan across subfolders ────────────────────────────────

Deno.test("AC-3: scans subfolders recursively for max ID", () => {
  withProject((root) => {
    // Put specs in subfolders
    Deno.mkdirSync(path.join(root, "specs", "cli"));
    Deno.mkdirSync(path.join(root, "specs", "ui"));

    Deno.writeTextFileSync(
      path.join(root, "specs", "cli", "FEAT-0003-sync.md"),
      "---\nid: FEAT-0003\ntitle: Sync\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nX.\n\n## Acceptance criteria\n\n- AC-1: X.\n"
    );
    Deno.writeTextFileSync(
      path.join(root, "specs", "ui", "FEAT-0010-editor.md"),
      "---\nid: FEAT-0010\ntitle: Editor\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nX.\n\n## Acceptance criteria\n\n- AC-1: X.\n"
    );

    const result = newSpec({ title: "New feature", projectRoot: root });
    assert(!isNewSpecError(result));
    assertEquals(result.id, "FEAT-0011");
  });
});

// ─── AC-4: --group creates subfolder ───────────────────────────────────────

Deno.test("AC-4: --group places file in subfolder, creating it if needed", () => {
  withProject((root) => {
    const result = newSpec({
      title: "Sync command",
      projectRoot: root,
      group: "cli",
    });
    assert(!isNewSpecError(result));
    assertEquals(result.path, path.join("specs", "cli", "FEAT-0001-sync-command.md"));

    // File exists
    const bytes = readSpec(root, result.path);
    assert(bytes.length > 0);
  });
});

// ─── AC-5: --id collision ──────────────────────────────────────────────────

Deno.test("AC-5: --id with existing ID fails with clear error", () => {
  withProject((root) => {
    Deno.writeTextFileSync(
      path.join(root, "specs", "FEAT-0042-existing.md"),
      "---\nid: FEAT-0042\ntitle: Existing\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nX.\n\n## Acceptance criteria\n\n- AC-1: X.\n"
    );

    const result = newSpec({
      title: "Duplicate",
      projectRoot: root,
      id: "FEAT-0042",
    });
    assert(isNewSpecError(result));
    assert(result.reason.includes("FEAT-0042"));
    assert(result.reason.includes("already in use"));
  });
});

// ─── AC-6: --id with unused ID ────────────────────────────────────────────

Deno.test("AC-6: --id with unused ID creates file with that exact ID", () => {
  withProject((root) => {
    const result = newSpec({
      title: "Reinstated feature",
      projectRoot: root,
      id: "FEAT-0042",
    });
    assert(!isNewSpecError(result));
    assertEquals(result.id, "FEAT-0042");
    assert(result.path.includes("FEAT-0042"));
  });
});

// ─── AC-7: Slug derivation ────────────────────────────────────────────────

Deno.test("AC-7: slug from punctuated mixed-case title", () => {
  assertEquals(deriveSlug("Password Reset via Email!"), "password-reset-via-email");
  assertEquals(deriveSlug("  Leading & Trailing  "), "leading-trailing");
  assertEquals(deriveSlug("UPPER CASE"), "upper-case");
  assertEquals(deriveSlug("dots.and.stuff"), "dots-and-stuff");
  assertEquals(deriveSlug("multiple---hyphens"), "multiple-hyphens");
  assertEquals(deriveSlug("123 numeric start"), "123-numeric-start");
});

Deno.test("AC-7: slug in filename is correct", () => {
  withProject((root) => {
    const result = newSpec({
      title: "Password Reset via Email!",
      projectRoot: root,
    });
    assert(!isNewSpecError(result));
    assert(result.path.endsWith("password-reset-via-email.md"));
  });
});

// ─── AC-8: Scaffold is parseable but incomplete ────────────────────────────

Deno.test("AC-8: scaffold parses successfully under FEAT-0006", () => {
  withProject((root) => {
    const result = newSpec({ title: "Test scaffold", projectRoot: root });
    assert(!isNewSpecError(result));

    const bytes = readSpec(root, result.path);
    const parsed = parse(bytes, result.path);
    assert(isParsedSpec(parsed), "scaffold should parse");
    assertEquals(parsed.frontmatter.id, "FEAT-0001");
    assertEquals(parsed.frontmatter.title, "Test scaffold");
    assertEquals(parsed.frontmatter.status, "draft");
    assertEquals(parsed.frontmatter.depends_on, []);

    // Has the two required section headings
    const headings = parsed.sections.map(s => s.heading);
    assert(headings.includes("Intent"));
    assert(headings.includes("Acceptance criteria"));

    // Bodies are empty (scaffold, not valid spec)
    const intent = parsed.sections.find(s => s.heading === "Intent");
    assertEquals(intent?.body, "");
  });
});

// ─── AC-9: Only path on stdout ─────────────────────────────────────────────

Deno.test("AC-9: result contains only the path", () => {
  withProject((root) => {
    const result = newSpec({ title: "Stdout test", projectRoot: root });
    assert(!isNewSpecError(result));
    // path is a clean relative path, no extra content
    assert(!result.path.includes("\n"));
    assert(result.path.startsWith("specs/"));
    assert(result.path.endsWith(".md"));
  });
});

// ─── AC-10: specs/assets/ is ignored ───────────────────────────────────────

Deno.test("AC-10: .md files under specs/assets/ are ignored during ID scan", () => {
  withProject((root) => {
    // Create a FEAT-NNNN-named file under assets/
    Deno.mkdirSync(path.join(root, "specs", "assets", "FEAT-9999"), { recursive: true });
    Deno.writeTextFileSync(
      path.join(root, "specs", "assets", "FEAT-9999-notes.md"),
      "not a spec"
    );

    const result = newSpec({ title: "Should be one", projectRoot: root });
    assert(!isNewSpecError(result));
    // Should be FEAT-0001, not FEAT-10000
    assertEquals(result.id, "FEAT-0001");
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

Deno.test("edge: scaffold round-trips through parse→serialize", () => {
  withProject((root) => {
    const result = newSpec({ title: "Round trip test", projectRoot: root });
    assert(!isNewSpecError(result));

    const bytes = readSpec(root, result.path);
    const parsed = parse(bytes, result.path);
    assert(isParsedSpec(parsed));

    const reserialized = serialize(parsed);
    assert(typeof reserialized === "string");
    assertEquals(reserialized, bytes, "scaffold should be in canonical form already");
  });
});

Deno.test("edge: --id with invalid format is rejected", () => {
  withProject((root) => {
    const result = newSpec({
      title: "Bad ID",
      projectRoot: root,
      id: "WRONG-0042",
    });
    assert(isNewSpecError(result));
    assert(result.reason.includes("invalid ID format"));
  });
});

Deno.test("edge: IDs with gaps still assign max+1", () => {
  withProject((root) => {
    // Only FEAT-0001 and FEAT-0005 exist (gap at 2-4)
    Deno.writeTextFileSync(
      path.join(root, "specs", "FEAT-0001-first.md"),
      "---\nid: FEAT-0001\ntitle: First\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nX.\n\n## Acceptance criteria\n\n- AC-1: X.\n"
    );
    Deno.writeTextFileSync(
      path.join(root, "specs", "FEAT-0005-fifth.md"),
      "---\nid: FEAT-0005\ntitle: Fifth\nstatus: draft\ndepends_on: []\n---\n\n## Intent\n\nX.\n\n## Acceptance criteria\n\n- AC-1: X.\n"
    );

    const result = newSpec({ title: "After gap", projectRoot: root });
    assert(!isNewSpecError(result));
    assertEquals(result.id, "FEAT-0006"); // max+1, not fills gap
  });
});
