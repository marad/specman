/**
 * Tests for FEAT-0010: Init command + root discovery
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0010-init-command.md
 */

import { assertEquals, assert } from "@std/assert";
import { init, formatInitResult } from "../src/init.ts";
import { findProjectRoot } from "../src/root.ts";
import * as path from "@std/path";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_test_" });
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function dirExists(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function listDir(p: string): string[] {
  try {
    return [...Deno.readDirSync(p)].map(e => e.name).sort();
  } catch {
    return [];
  }
}

// ─── AC-1: Clean init ──────────────────────────────────────────────────────

Deno.test("AC-1: clean init creates all four directories and exits zero", () => {
  withTempDir((dir) => {
    // Add .git so we don't get a warning
    Deno.mkdirSync(path.join(dir, ".git"));

    const result = init(dir);
    assertEquals(result.conflict, null);
    assertEquals(result.created.length, 4);
    assertEquals(result.alreadyPresent.length, 0);
    assert(dirExists(path.join(dir, "specs")));
    assert(dirExists(path.join(dir, ".specman")));
    assert(dirExists(path.join(dir, ".specman", "implemented")));
    assert(dirExists(path.join(dir, ".specman", "plans")));

    const [lines, code] = formatInitResult(result);
    assertEquals(code, 0);
    assert(lines.some(l => l.includes("Created specs/")));
    assert(lines.some(l => l.includes("Created .specman/")));
    assert(lines.some(l => l.includes("specman new")));
  });
});

// ─── AC-2: Already initialized ─────────────────────────────────────────────

Deno.test("AC-2: already initialized reports nothing to do and exits zero", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    Deno.mkdirSync(path.join(dir, "specs"));
    Deno.mkdirSync(path.join(dir, ".specman", "implemented"), { recursive: true });
    Deno.mkdirSync(path.join(dir, ".specman", "plans"), { recursive: true });

    const result = init(dir);
    assertEquals(result.created.length, 0);
    assertEquals(result.alreadyPresent.length, 4);
    assertEquals(result.conflict, null);

    const [lines, code] = formatInitResult(result);
    assertEquals(code, 0);
    assert(lines.some(l => l.includes("Already initialized")));
  });
});

// ─── AC-3: Partial state ───────────────────────────────────────────────────

Deno.test("AC-3: partial state creates only missing dirs", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    Deno.mkdirSync(path.join(dir, "specs"));

    const result = init(dir);
    assertEquals(result.conflict, null);
    assert(result.alreadyPresent.includes("specs"));
    assert(result.created.includes(".specman"));
    assert(result.created.includes(".specman/implemented"));
    assert(result.created.includes(".specman/plans"));

    const [lines, code] = formatInitResult(result);
    assertEquals(code, 0);
    assert(lines.some(l => l.includes("Already present: specs/")));
    assert(lines.some(l => l.includes("Created .specman/")));
  });
});

// ─── AC-4: Conflict (file where directory expected) ────────────────────────

Deno.test("AC-4: file where directory expected causes error, creates nothing", () => {
  withTempDir((dir) => {
    // Create .specman as a file
    Deno.writeTextFileSync(path.join(dir, ".specman"), "not a directory");

    const result = init(dir);
    assertEquals(result.conflict, ".specman");
    assertEquals(result.created.length, 0);

    // specs/ should NOT have been created
    assert(!dirExists(path.join(dir, "specs")));

    const [lines, code] = formatInitResult(result);
    assertEquals(code, 1);
    assert(lines.some(l => l.includes("error:")));
    assert(lines.some(l => l.includes(".specman")));
  });
});

Deno.test("AC-4: conflict on specs/ also blocked", () => {
  withTempDir((dir) => {
    Deno.writeTextFileSync(path.join(dir, "specs"), "not a directory");

    const result = init(dir);
    assertEquals(result.conflict, "specs");
    assertEquals(result.created.length, 0);

    const [_lines, code] = formatInitResult(result);
    assertEquals(code, 1);
  });
});

// ─── AC-5: No .git warning ────────────────────────────────────────────────

Deno.test("AC-5: no .git directory prints warning but still succeeds", () => {
  withTempDir((dir) => {
    // No .git directory
    const result = init(dir);
    assertEquals(result.conflict, null);
    assertEquals(result.created.length, 4);
    assert(result.gitWarning);

    const [lines, code] = formatInitResult(result);
    assertEquals(code, 0);
    assert(lines.some(l => l.includes("warning:") && l.includes(".git")));
    assert(lines.some(l => l.includes("specman new")));
  });
});

// ─── AC-6: Idempotent ─────────────────────────────────────────────────────

Deno.test("AC-6: second init is idempotent no-op", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));

    const result1 = init(dir);
    assertEquals(result1.created.length, 4);

    const result2 = init(dir);
    assertEquals(result2.created.length, 0);
    assertEquals(result2.alreadyPresent.length, 4);

    const [lines, code] = formatInitResult(result2);
    assertEquals(code, 0);
    assert(lines.some(l => l.includes("Already initialized")));
  });
});

// ─── AC-7: Crash recovery ─────────────────────────────────────────────────

Deno.test("AC-7: re-run after partial creation completes remaining", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    // Simulate partial creation: only specs/ and .specman/ exist
    Deno.mkdirSync(path.join(dir, "specs"));
    Deno.mkdirSync(path.join(dir, ".specman"));

    const result = init(dir);
    assert(result.alreadyPresent.includes("specs"));
    assert(result.alreadyPresent.includes(".specman"));
    assert(result.created.includes(".specman/implemented"));
    assert(result.created.includes(".specman/plans"));

    const [_lines, code] = formatInitResult(result);
    assertEquals(code, 0);
  });
});

// ─── AC-8: Directories are empty ──────────────────────────────────────────

Deno.test("AC-8: created directories are empty (no .gitkeep, no README)", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);

    assertEquals(listDir(path.join(dir, "specs")), []);
    assertEquals(listDir(path.join(dir, ".specman", "implemented")), []);
    assertEquals(listDir(path.join(dir, ".specman", "plans")), []);
  });
});

// ─── AC-9: Nested init doesn't inspect ancestors ──────────────────────────

Deno.test("AC-9: init in subdirectory of initialized project creates local layout", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir); // init parent

    const subdir = path.join(dir, "subproject");
    Deno.mkdirSync(subdir);
    Deno.mkdirSync(path.join(subdir, ".git"));

    const result = init(subdir);
    assertEquals(result.created.length, 4);
    assert(dirExists(path.join(subdir, "specs")));
    assert(dirExists(path.join(subdir, ".specman")));
  });
});

// ─── AC-10: Root discovery from subdirectory ───────────────────────────────

Deno.test("AC-10: findProjectRoot discovers root from subdirectory", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);

    const subdir = path.join(dir, "src", "deep", "nested");
    Deno.mkdirSync(subdir, { recursive: true });

    const root = findProjectRoot(subdir);
    assertEquals(root, dir);
  });
});

Deno.test("AC-10: findProjectRoot finds root from immediate directory", () => {
  withTempDir((dir) => {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);

    const root = findProjectRoot(dir);
    assertEquals(root, dir);
  });
});

// ─── AC-11: No project found ──────────────────────────────────────────────

Deno.test("AC-11: findProjectRoot returns null when no project exists", () => {
  withTempDir((dir) => {
    // Empty temp dir, no specs/ or .specman/
    const root = findProjectRoot(dir);
    assertEquals(root, null);
  });
});

Deno.test("AC-11: findProjectRoot requires both specs/ and .specman/", () => {
  withTempDir((dir) => {
    // Only specs/ present, not .specman/
    Deno.mkdirSync(path.join(dir, "specs"));
    const root = findProjectRoot(dir);
    assertEquals(root, null);
  });
});
