/**
 * Tests for FEAT-0009: Sync plan format
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0009-sync-plan-format.md
 */

import {
  assertEquals,
  assert,
  assertStringIncludes,
  assertNotEquals,
} from "@std/assert";
import { init } from "../src/init.ts";
import {
  computeDriftSet,
  generatePlan,
  parsePlan,
  isParsedPlan,
  isPlanParseError,
  checkScope,
  checkVerificationNonEmpty,
  writePlan,
  readPlan,
  planExists,
  loadDriftSet,
  formatDriftSummary,
  formatScopeError,
  formatVerificationEmptyError,
  type DriftEntry,
  type DriftType,
  type GeneratePlanOptions,
  type ParsedPlan,
} from "../src/plan.ts";
import {
  parse,
  isParsedSpec,
  type ParsedSpec,
  type AcceptanceCriterion,
} from "../src/parser.ts";
import {
  writeSnapshot,
  readSnapshot,
  detectDrift,
  toCanonicalForm,
} from "../src/snapshot.ts";
import * as path from "@std/path";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withProject(fn: (root: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_plan_test_" });
  try {
    Deno.mkdirSync(path.join(dir, ".git"));
    init(dir);
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** Create a spec file with given ACs and return its relative path */
function createSpec(
  root: string,
  id: string,
  title: string,
  acs: Array<{ id: string; text: string }>,
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const filename = `${id}-${slug}.md`;
  const dir = path.join(root, "specs");
  Deno.mkdirSync(dir, { recursive: true });

  const acLines = acs
    .map((ac) => `- ${ac.id}: ${ac.text}`)
    .join("\n");

  const content = `---
id: ${id}
title: ${title}
status: draft
depends_on: []
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

/** Create a spec and its in-sync snapshot */
function createSyncedSpec(
  root: string,
  id: string,
  title: string,
  acs: Array<{ id: string; text: string }>,
): string {
  const relPath = createSpec(root, id, title, acs);
  const fullPath = path.join(root, relPath);
  const bytes = Deno.readTextFileSync(fullPath);
  const canonical = toCanonicalForm(bytes, relPath);
  assert(canonical !== null);
  Deno.writeTextFileSync(fullPath, canonical);
  writeSnapshot(root, id, canonical);
  return relPath;
}

/** Helper to build a minimal ParsedSpec for testing */
function makeParsedSpec(acs: AcceptanceCriterion[]): ParsedSpec {
  return {
    frontmatter: {
      id: "FEAT-0001",
      title: "Test",
      status: "draft",
      depends_on: [],
    },
    sections: [
      { heading: "Intent", body: "Test intent.\n" },
      {
        heading: "Acceptance criteria",
        body: acs.map((ac) => `- ${ac.id}: ${ac.text}`).join("\n") + "\n",
      },
    ],
    acceptance_criteria: acs,
  };
}

/** Build a populated plan (as if agent filled in approach + verification) */
function buildPopulatedPlan(opts: {
  featId: string;
  title: string;
  snapshotState: "drifted" | "new";
  driftSet: DriftEntry[];
  timestamp?: string;
}): string {
  const timestamp = opts.timestamp ?? "2026-04-17T14:30:00Z";
  const lines: string[] = [];

  lines.push(`# Sync plan — ${opts.featId} ${opts.title}`);
  lines.push("");
  lines.push(`Started: ${timestamp}`);
  lines.push(`Snapshot state: ${opts.snapshotState}`);
  lines.push(
    `Drift summary: ${formatDriftSummary(opts.driftSet, opts.snapshotState)}`,
  );

  for (const entry of opts.driftSet) {
    const n = entry.id.match(/^AC-(\d+)$/)![1];
    lines.push("");
    lines.push(`## AC-${n} (${entry.type}): ${entry.text}`);
    lines.push("");

    if (entry.type === "modified") {
      lines.push("Change: delivery window tightened.");
      lines.push("");
    }

    lines.push("Approach: implement the required changes.");
    lines.push("");
    lines.push("Files:");
    lines.push("- modified: src/main.ts");
  }

  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push("- `deno test`");
  lines.push("- `deno lint`");

  lines.push("");
  return lines.join("\n");
}

// ─── AC-1: Plan file exists at .specman/plans/<FEAT-ID>.md ──────────────────

Deno.test("AC-1: writePlan creates plan file at correct path", () => {
  withProject((root) => {
    const content = "# Sync plan — FEAT-0042 Test\n";
    writePlan(root, "FEAT-0042", content);

    assert(planExists(root, "FEAT-0042"));
    const read = readPlan(root, "FEAT-0042");
    assertEquals(read, content);
  });
});

Deno.test("AC-1: writePlan creates plans directory if missing", () => {
  withProject((root) => {
    // Remove plans dir
    Deno.removeSync(path.join(root, ".specman", "plans"));

    writePlan(root, "FEAT-0001", "test content");
    assert(planExists(root, "FEAT-0001"));
  });
});

Deno.test("AC-1: readPlan returns null when no plan exists", () => {
  withProject((root) => {
    assertEquals(readPlan(root, "FEAT-9999"), null);
  });
});

Deno.test("AC-1: planExists returns false when no plan exists", () => {
  withProject((root) => {
    assertEquals(planExists(root, "FEAT-9999"), false);
  });
});

// ─── AC-2: Scaffold has one AC section per drift entry + Verification ───────

Deno.test("AC-2: generatePlan scaffold has one section per drift entry", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "Given registered email, reset in 1 min" },
    { id: "AC-3", type: "added", text: "Rate limit three failures" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0042",
    title: "Password reset via email",
    snapshotState: "drifted",
    driftSet,
    timestamp: "2026-04-17T14:30:00Z",
  });

  // Parse the generated plan
  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  // Exactly 2 AC sections
  assertEquals(parsed.acSections.length, 2);
  assertEquals(parsed.acSections[0].id, "AC-1");
  assertEquals(parsed.acSections[0].type, "modified");
  assertStringIncludes(parsed.acSections[0].text, "registered email");
  assertEquals(parsed.acSections[1].id, "AC-3");
  assertEquals(parsed.acSections[1].type, "added");
  assertStringIncludes(parsed.acSections[1].text, "Rate limit");
});

Deno.test("AC-2: scaffold contains ## Verification section", () => {
  const plan = generatePlan({
    featId: "FEAT-0042",
    title: "Password reset",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  assertStringIncludes(plan, "## Verification");
});

Deno.test("AC-2: scaffold AC text matches current spec text", () => {
  const acText = "Given a registered email, when user requests reset, a link is delivered.";
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: acText },
  ];

  const plan = generatePlan({
    featId: "FEAT-0001",
    title: "Test",
    snapshotState: "new",
    driftSet,
  });

  assertStringIncludes(plan, acText);
});

// ─── AC-3: New spec → all ACs as "added" ───────────────────────────────────

Deno.test("AC-3: new spec has every AC as added", () => {
  const currentSpec = makeParsedSpec([
    { id: "AC-1", text: "First criterion" },
    { id: "AC-2", text: "Second criterion" },
    { id: "AC-3", text: "Third criterion" },
  ]);

  const driftSet = computeDriftSet(currentSpec, null);

  assertEquals(driftSet.length, 3);
  for (const entry of driftSet) {
    assertEquals(entry.type, "added");
  }
  assertEquals(driftSet[0].id, "AC-1");
  assertEquals(driftSet[1].id, "AC-2");
  assertEquals(driftSet[2].id, "AC-3");
});

Deno.test("AC-3: new spec plan scaffold labels all sections as added", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "First" },
    { id: "AC-2", type: "added", text: "Second" },
    { id: "AC-3", type: "added", text: "Third" },
    { id: "AC-4", type: "added", text: "Fourth" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0099",
    title: "Account settings screen",
    snapshotState: "new",
    driftSet,
    timestamp: "2026-04-17T15:02:00Z",
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.snapshotState, "new");
  assertEquals(parsed.acSections.length, 4);
  for (const s of parsed.acSections) {
    assertEquals(s.type, "added");
  }
  assertStringIncludes(parsed.driftSummary, "4 added (whole spec)");
});

// ─── AC-4: Agent-populated plan has Approach, Files, Verification ───────────

Deno.test("AC-4: populated plan has non-empty Approach in each AC section", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "Tightened deadline" },
    { id: "AC-3", type: "added", text: "Rate limiter" },
  ];

  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Password reset",
    snapshotState: "drifted",
    driftSet,
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  for (const section of parsed.acSections) {
    assertStringIncludes(section.body, "Approach:");
    assertStringIncludes(section.body, "Files:");
    // Approach is not empty placeholder
    assert(!section.body.includes("<!-- agent fills in -->"));
  }
});

Deno.test("AC-4: populated plan Verification has at least one command", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Password reset",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assert(parsed.verificationCommands.length >= 1);
  assertEquals(parsed.verificationCommands[0], "deno test");
});

// ─── AC-5: Three approval choices ──────────────────────────────────────────
// AC-5 is about the interactive prompt, which is tested at integration level.
// We test that the module provides the right validation for input.

Deno.test("AC-5: plan data model supports the approve/re-plan/abort flow", () => {
  // Verify plan can be parsed, scope-checked, and verification-checked
  // These are the prereqs for the approval prompt.
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  const scopeResult = checkScope(parsed, [
    { id: "AC-1", type: "added", text: "Test" },
  ]);
  assert(scopeResult.valid);

  const verifyResult = checkVerificationNonEmpty(parsed);
  assertEquals(verifyResult, null);
});

// ─── AC-6: User edits to approach/files/verification are preserved ──────────

Deno.test("AC-6: user edits to approach prose are preserved through parse", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test criterion" }],
  });

  // Simulate user editing the approach
  const edited = plan.replace(
    "Approach: implement the required changes.",
    "Approach: use a custom Redis-backed rate limiter with exponential backoff.",
  );

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));
  assertStringIncludes(
    parsed.acSections[0].body,
    "Redis-backed rate limiter",
  );
});

Deno.test("AC-6: user edits to verification commands are preserved", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  // Add a verification command
  const edited = plan.replace(
    "- `deno lint`",
    "- `deno lint`\n- `deno check src/`",
  );

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.verificationCommands.length, 3);
  assertEquals(parsed.verificationCommands[2], "deno check src/");
});

Deno.test("AC-6: user edits to file lists are preserved", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  // Change the files list
  const edited = plan.replace(
    "- modified: src/main.ts",
    "- new: src/auth/rate-limit.ts\n- modified: src/auth/reset.ts",
  );

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));
  assertStringIncludes(parsed.acSections[0].body, "rate-limit.ts");
  assertStringIncludes(parsed.acSections[0].body, "reset.ts");
});

// ─── AC-7: Scope-change edits rejected ─────────────────────────────────────

Deno.test("AC-7: adding an AC section not in drift set is rejected", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "Test" },
    { id: "AC-3", type: "added", text: "Rate limit" },
  ];

  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  // User adds an AC-7 section
  const edited =
    plan + "\n## AC-7 (added): Unauthorized extra criterion\n\nApproach: sneak it in.\n";

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));

  const scopeResult = checkScope(parsed, driftSet);
  assert(!scopeResult.valid);
  assert(scopeResult.errors.some((e) => e.includes("AC-7")));
});

Deno.test("AC-7: removing an AC section from the plan is rejected", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "First" },
    { id: "AC-3", type: "added", text: "Third" },
  ];

  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  // Remove the AC-3 section by replacing it
  const lines = plan.split("\n");
  const ac3Start = lines.findIndex((l) => l.startsWith("## AC-3"));
  const nextSectionStart = lines.findIndex(
    (l, i) => i > ac3Start && l.startsWith("## "),
  );
  const edited = [
    ...lines.slice(0, ac3Start),
    ...lines.slice(nextSectionStart),
  ].join("\n");

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));

  const scopeResult = checkScope(parsed, driftSet);
  assert(!scopeResult.valid);
  assert(scopeResult.errors.some((e) => e.includes("AC-3")));
});

Deno.test("AC-7: changing an AC's type is rejected as scope change", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "First" },
  ];

  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  // Change (modified) to (added) in the heading
  const edited = plan.replace("(modified)", "(added)");

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));

  const scopeResult = checkScope(parsed, driftSet);
  assert(!scopeResult.valid);
});

Deno.test("AC-7: scope error formatting names AC-ID mismatches", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "First" },
    { id: "AC-3", type: "added", text: "Third" },
  ];

  // Simulate a plan with AC-1, AC-3, and AC-7
  const planAcSections = [
    { id: "AC-1", type: "added" as DriftType },
    { id: "AC-3", type: "added" as DriftType },
    { id: "AC-7", type: "added" as DriftType },
  ];

  const result = checkScope(
    {
      featId: "FEAT-0042",
      title: "Test",
      timestamp: "",
      snapshotState: "new",
      driftSummary: "",
      acSections: planAcSections.map((a) => ({
        ...a,
        text: "x",
        body: "",
      })),
      crossCutting: null,
      verificationCommands: ["deno test"],
      raw: "",
    },
    driftSet,
  );

  assert(!result.valid);
  const formatted = formatScopeError(result, "FEAT-0042");
  assert(formatted.some((l) => l.includes("AC-7")));
  assert(formatted.some((l) => l.includes("specman sync FEAT-0042")));
});

// ─── AC-8: Re-plan treats user edits as constraints ─────────────────────────
// AC-8 is about agent behavior during re-plan — we test that the plan
// structure preserves user edits so they're available as constraints.

Deno.test("AC-8: plan preserves user edits across parse/re-parse", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  // User makes edits
  const edited = plan.replace(
    "Approach: implement the required changes.",
    "Approach: MUST use Redis. Do NOT use in-memory store.",
  );

  const parsed = parsePlan(edited);
  assert(isParsedPlan(parsed));

  // The user's constraint is visible in the parsed plan
  assertStringIncludes(parsed.acSections[0].body, "MUST use Redis");
  assertStringIncludes(parsed.acSections[0].body, "Do NOT use in-memory");
});

// ─── AC-9: Re-plan has no iteration limit ───────────────────────────────────
// AC-9 is about the loop having no cap — structural test.

Deno.test("AC-9: plan can be parsed and re-generated arbitrarily many times", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "Test" },
  ];

  // Simulate 10 re-plan cycles
  let plan = generatePlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet,
    timestamp: "2026-04-17T14:30:00Z",
  });

  for (let i = 0; i < 10; i++) {
    const parsed = parsePlan(plan);
    assert(isParsedPlan(parsed));
    // Simulate agent re-populating
    plan = buildPopulatedPlan({
      featId: "FEAT-0042",
      title: "Test",
      snapshotState: "new",
      driftSet,
      timestamp: "2026-04-17T14:30:00Z",
    });
  }

  // Final plan is still valid
  const finalParsed = parsePlan(plan);
  assert(isParsedPlan(finalParsed));
  assertEquals(finalParsed.acSections.length, 1);
});

// ─── AC-10: Abort exits cleanly ────────────────────────────────────────────
// AC-10 is about the CLI behavior. We verify the plan module doesn't
// prevent clean abort — plan file stays on disk, no commits needed.

Deno.test("AC-10: plan file persists on disk after write (abort leaves it)", () => {
  withProject((root) => {
    const content = "# Sync plan — FEAT-0042 Test\n\nSome content\n";
    writePlan(root, "FEAT-0042", content);

    // Plan file should exist
    assert(planExists(root, "FEAT-0042"));
    assertEquals(readPlan(root, "FEAT-0042"), content);

    // "Abort" means we just don't commit — file stays
    assert(planExists(root, "FEAT-0042"));
  });
});

// ─── AC-11: Plan and snapshot both in single commit ─────────────────────────
// AC-11 is about commit behavior at the FEAT-0004 level. We verify the
// module provides the needed write functions.

Deno.test("AC-11: writePlan and writeSnapshot can both write to expected paths", () => {
  withProject((root) => {
    writePlan(root, "FEAT-0042", "plan content");
    writeSnapshot(root, "FEAT-0042", "snapshot content");

    assertEquals(readPlan(root, "FEAT-0042"), "plan content");
    assertEquals(readSnapshot(root, "FEAT-0042"), "snapshot content");
  });
});

// ─── AC-12: Failed/aborted sync — plan on disk, not committed ──────────────
// Structural: same as AC-10, plan file operations don't auto-commit.

Deno.test("AC-12: plan remains on disk when sync is not sealed", () => {
  withProject((root) => {
    writePlan(root, "FEAT-0042", "plan for failed sync");
    assert(planExists(root, "FEAT-0042"));
    // No snapshot written → sync wasn't sealed
    assertEquals(readSnapshot(root, "FEAT-0042"), null);
  });
});

// ─── AC-13: Verification commands extracted from plan ───────────────────────

Deno.test("AC-13: verification commands extracted in order from plan", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Verification",
    "",
    "- `npm test -- src/auth`",
    "- `npm run lint -- src/auth`",
    "- `deno check`",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.verificationCommands.length, 3);
  assertEquals(parsed.verificationCommands[0], "npm test -- src/auth");
  assertEquals(parsed.verificationCommands[1], "npm run lint -- src/auth");
  assertEquals(parsed.verificationCommands[2], "deno check");
});

Deno.test("AC-13: non-backtick bullets in Verification are ignored", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Verification",
    "",
    "- `deno test`",
    "- This is a commentary bullet, not a command",
    "- `deno lint`",
    "- Also commentary: explains what lint checks",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.verificationCommands.length, 2);
  assertEquals(parsed.verificationCommands[0], "deno test");
  assertEquals(parsed.verificationCommands[1], "deno lint");
});

Deno.test("AC-13: fenced code blocks in Verification are not treated as commands", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Verification",
    "",
    "- `deno test`",
    "",
    "```",
    "some fenced code",
    "```",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  // Only the bullet command counts, not the fenced block
  assertEquals(parsed.verificationCommands.length, 1);
  assertEquals(parsed.verificationCommands[0], "deno test");
});

// ─── AC-14: Empty verification rejected ────────────────────────────────────

Deno.test("AC-14: plan with zero verification commands fails check", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Verification",
    "",
    "- No runnable commands here",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.verificationCommands.length, 0);

  const error = checkVerificationNonEmpty(parsed);
  assert(error !== null);
  assertStringIncludes(error, "zero runnable commands");
});

Deno.test("AC-14: plan with only commentary bullets fails check", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Verification",
    "",
    "- Run tests to make sure everything works",
    "- Check lint output too",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.verificationCommands.length, 0);

  const error = checkVerificationNonEmpty(parsed);
  assert(error !== null);
});

Deno.test("AC-14: plan with at least one command passes check", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  const error = checkVerificationNonEmpty(parsed);
  assertEquals(error, null);
});

Deno.test("AC-14: formatVerificationEmptyError produces helpful message", () => {
  const lines = formatVerificationEmptyError();
  assert(lines.length > 0);
  assert(lines.some((l) => l.includes("zero runnable commands")));
});

// ─── AC-15: Uncommitted plan triggers resume prompt ─────────────────────────
// AC-15 is about the interactive prompt at sync start. We test the
// underlying plan file detection.

Deno.test("AC-15: planExists detects existing plan file", () => {
  withProject((root) => {
    writePlan(root, "FEAT-0042", "existing plan");
    assert(planExists(root, "FEAT-0042"));
  });
});

Deno.test("AC-15: planExists returns false for absent plan", () => {
  withProject((root) => {
    assertEquals(planExists(root, "FEAT-0042"), false);
  });
});

// ─── AC-16: Resume uses existing plan verbatim ─────────────────────────────

Deno.test("AC-16: readPlan returns exact file content for resume", () => {
  withProject((root) => {
    const content =
      "# Sync plan — FEAT-0042 Test\n\nUser-edited content that should be preserved verbatim.\n";
    writePlan(root, "FEAT-0042", content);

    const read = readPlan(root, "FEAT-0042");
    assertEquals(read, content);
  });
});

// ─── AC-17: Regenerate overwrites plan with fresh scaffold ──────────────────

Deno.test("AC-17: writePlan overwrites existing plan", () => {
  withProject((root) => {
    writePlan(root, "FEAT-0042", "old content");
    assertEquals(readPlan(root, "FEAT-0042"), "old content");

    writePlan(root, "FEAT-0042", "regenerated content");
    assertEquals(readPlan(root, "FEAT-0042"), "regenerated content");
  });
});

// ─── AC-18: Absent or HEAD-matching plan → no resume prompt ────────────────
// Tested via planExists returning false.

Deno.test("AC-18: absent plan file means fresh scaffold flow", () => {
  withProject((root) => {
    assertEquals(planExists(root, "FEAT-0042"), false);
    // In the sync flow, this would proceed to write a fresh scaffold
  });
});

// ─── Drift set computation ──────────────────────────────────────────────────

Deno.test("computeDriftSet: detects added ACs", () => {
  const snapshot = makeParsedSpec([
    { id: "AC-1", text: "Original first" },
  ]);
  const current = makeParsedSpec([
    { id: "AC-1", text: "Original first" },
    { id: "AC-2", text: "New second" },
  ]);

  const driftSet = computeDriftSet(current, snapshot);
  assertEquals(driftSet.length, 1);
  assertEquals(driftSet[0].id, "AC-2");
  assertEquals(driftSet[0].type, "added");
  assertEquals(driftSet[0].text, "New second");
});

Deno.test("computeDriftSet: detects modified ACs", () => {
  const snapshot = makeParsedSpec([
    { id: "AC-1", text: "Original text" },
  ]);
  const current = makeParsedSpec([
    { id: "AC-1", text: "Updated text" },
  ]);

  const driftSet = computeDriftSet(current, snapshot);
  assertEquals(driftSet.length, 1);
  assertEquals(driftSet[0].id, "AC-1");
  assertEquals(driftSet[0].type, "modified");
  assertEquals(driftSet[0].text, "Updated text");
});

Deno.test("computeDriftSet: detects removed ACs", () => {
  const snapshot = makeParsedSpec([
    { id: "AC-1", text: "First" },
    { id: "AC-2", text: "Second to remove" },
  ]);
  const current = makeParsedSpec([
    { id: "AC-1", text: "First" },
  ]);

  const driftSet = computeDriftSet(current, snapshot);
  assertEquals(driftSet.length, 1);
  assertEquals(driftSet[0].id, "AC-2");
  assertEquals(driftSet[0].type, "removed");
  assertEquals(driftSet[0].text, "Second to remove");
});

Deno.test("computeDriftSet: mixed added/modified/removed", () => {
  const snapshot = makeParsedSpec([
    { id: "AC-1", text: "Unchanged first" },
    { id: "AC-2", text: "Original second" },
    { id: "AC-3", text: "Will be removed" },
  ]);
  const current = makeParsedSpec([
    { id: "AC-1", text: "Unchanged first" },
    { id: "AC-2", text: "Modified second" },
    { id: "AC-4", text: "New fourth" },
  ]);

  const driftSet = computeDriftSet(current, snapshot);
  assertEquals(driftSet.length, 3);

  // Added first in sort order
  const added = driftSet.filter((e) => e.type === "added");
  assertEquals(added.length, 1);
  assertEquals(added[0].id, "AC-4");

  // Modified
  const modified = driftSet.filter((e) => e.type === "modified");
  assertEquals(modified.length, 1);
  assertEquals(modified[0].id, "AC-2");

  // Removed
  const removed = driftSet.filter((e) => e.type === "removed");
  assertEquals(removed.length, 1);
  assertEquals(removed[0].id, "AC-3");
});

Deno.test("computeDriftSet: no changes returns empty set", () => {
  const spec = makeParsedSpec([
    { id: "AC-1", text: "Same text" },
  ]);

  const driftSet = computeDriftSet(spec, spec);
  assertEquals(driftSet.length, 0);
});

Deno.test("computeDriftSet: null snapshot (new) marks all as added", () => {
  const current = makeParsedSpec([
    { id: "AC-1", text: "First" },
    { id: "AC-2", text: "Second" },
  ]);

  const driftSet = computeDriftSet(current, null);
  assertEquals(driftSet.length, 2);
  assertEquals(driftSet[0].type, "added");
  assertEquals(driftSet[1].type, "added");
});

// ─── Plan parsing ───────────────────────────────────────────────────────────

Deno.test("parsePlan: extracts header metadata", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Password reset",
    snapshotState: "drifted",
    driftSet: [{ id: "AC-1", type: "modified", text: "Test" }],
    timestamp: "2026-04-17T14:30:00Z",
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.featId, "FEAT-0042");
  assertEquals(parsed.title, "Password reset");
  assertEquals(parsed.timestamp, "2026-04-17T14:30:00Z");
  assertEquals(parsed.snapshotState, "drifted");
});

Deno.test("parsePlan: extracts drift summary", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "drifted",
    driftSet: [
      { id: "AC-1", type: "modified", text: "First" },
      { id: "AC-3", type: "added", text: "Third" },
    ],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertStringIncludes(parsed.driftSummary, "1 added");
  assertStringIncludes(parsed.driftSummary, "1 modified");
});

Deno.test("parsePlan: malformed title line returns error", () => {
  const plan = "Not a valid plan title\n";
  const result = parsePlan(plan);
  assert(isPlanParseError(result));
  assertStringIncludes(result.reason, "title line");
});

Deno.test("parsePlan: handles cross-cutting section", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Cross-cutting",
    "",
    "Shared helper refactor needed for both ACs.",
    "",
    "## Verification",
    "",
    "- `deno test`",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assert(parsed.crossCutting !== null);
  assertStringIncludes(parsed.crossCutting!, "Shared helper refactor");
});

Deno.test("parsePlan: cross-cutting is null when not present", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.crossCutting, null);
});

Deno.test("parsePlan: preserves raw content", () => {
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.raw, plan);
});

// ─── Drift summary formatting ──────────────────────────────────────────────

Deno.test("formatDriftSummary: new spec shows count with whole-spec marker", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "A" },
    { id: "AC-2", type: "added", text: "B" },
    { id: "AC-3", type: "added", text: "C" },
  ];
  assertEquals(formatDriftSummary(driftSet, "new"), "3 added (whole spec)");
});

Deno.test("formatDriftSummary: drifted spec shows counts by type", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "A" },
    { id: "AC-2", type: "added", text: "B" },
    { id: "AC-3", type: "removed", text: "C" },
  ];
  assertEquals(formatDriftSummary(driftSet, "drifted"), "1 added, 1 modified, 1 removed");
});

Deno.test("formatDriftSummary: zero counts shown for each type", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "A" },
  ];
  assertEquals(formatDriftSummary(driftSet, "drifted"), "0 added, 1 modified, 0 removed");
});

// ─── Scope checking ────────────────────────────────────────────────────────

Deno.test("checkScope: exact match passes", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "A" },
    { id: "AC-2", type: "modified", text: "B" },
  ];

  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  const result = checkScope(parsed, driftSet);
  assert(result.valid);
  assertEquals(result.errors.length, 0);
});

Deno.test("checkScope: extra AC in plan fails", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "A" },
  ];

  // Plan has AC-1 and AC-2
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [
      { id: "AC-1", type: "added", text: "A" },
      { id: "AC-2", type: "added", text: "B" },
    ],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  const result = checkScope(parsed, driftSet);
  assert(!result.valid);
  assert(result.errors.some((e) => e.includes("AC-2")));
});

Deno.test("checkScope: missing AC in plan fails", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "A" },
    { id: "AC-2", type: "added", text: "B" },
  ];

  // Plan only has AC-1
  const plan = buildPopulatedPlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "A" }],
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  const result = checkScope(parsed, driftSet);
  assert(!result.valid);
  assert(result.errors.some((e) => e.includes("AC-2")));
});

// ─── loadDriftSet integration ───────────────────────────────────────────────

Deno.test("loadDriftSet: new spec returns all ACs as added", () => {
  withProject((root) => {
    const relPath = createSpec(root, "FEAT-0042", "Test feature", [
      { id: "AC-1", text: "First" },
      { id: "AC-2", text: "Second" },
    ]);

    const result = loadDriftSet(root, "FEAT-0042", relPath, "new");
    assert(!("error" in result));

    assertEquals(result.driftSet.length, 2);
    assertEquals(result.driftSet[0].type, "added");
    assertEquals(result.driftSet[1].type, "added");
    assertEquals(result.snapshotSpec, null);
  });
});

Deno.test("loadDriftSet: drifted spec detects modified ACs", () => {
  withProject((root) => {
    // Create synced spec
    const relPath = createSyncedSpec(root, "FEAT-0042", "Test feature", [
      { id: "AC-1", text: "Original first" },
      { id: "AC-2", text: "Original second" },
    ]);

    // Modify spec — change AC-1 text
    const fullPath = path.join(root, relPath);
    const content = Deno.readTextFileSync(fullPath);
    Deno.writeTextFileSync(
      fullPath,
      content.replace("Original first", "Updated first"),
    );

    const result = loadDriftSet(root, "FEAT-0042", relPath, "drifted");
    assert(!("error" in result));

    assertEquals(result.driftSet.length, 1);
    assertEquals(result.driftSet[0].id, "AC-1");
    assertEquals(result.driftSet[0].type, "modified");
  });
});

Deno.test("loadDriftSet: drifted spec detects added and removed ACs", () => {
  withProject((root) => {
    // Create synced spec with AC-1 and AC-2
    const relPath = createSyncedSpec(root, "FEAT-0042", "Test feature", [
      { id: "AC-1", text: "First" },
      { id: "AC-2", text: "Will be removed" },
    ]);

    // Rewrite spec: keep AC-1, remove AC-2, add AC-3
    const fullPath = path.join(root, relPath);
    const newContent = `---
id: FEAT-0042
title: Test feature
status: draft
depends_on: []
---

## Intent

Implement Test feature.

## Acceptance criteria

- AC-1: First
- AC-3: Brand new third
`;
    Deno.writeTextFileSync(fullPath, newContent);

    const result = loadDriftSet(root, "FEAT-0042", relPath, "drifted");
    assert(!("error" in result));

    const added = result.driftSet.filter((e) => e.type === "added");
    const removed = result.driftSet.filter((e) => e.type === "removed");
    assertEquals(added.length, 1);
    assertEquals(added[0].id, "AC-3");
    assertEquals(removed.length, 1);
    assertEquals(removed[0].id, "AC-2");
  });
});

// ─── Plan generation + parsing round-trip ───────────────────────────────────

Deno.test("round-trip: generatePlan → parsePlan preserves structure", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "Tightened from 5min to 1min" },
    { id: "AC-3", type: "added", text: "Rate limit on 3 failures" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0042",
    title: "Password reset via email",
    snapshotState: "drifted",
    driftSet,
    timestamp: "2026-04-17T14:30:00Z",
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  assertEquals(parsed.featId, "FEAT-0042");
  assertEquals(parsed.title, "Password reset via email");
  assertEquals(parsed.timestamp, "2026-04-17T14:30:00Z");
  assertEquals(parsed.snapshotState, "drifted");
  assertEquals(parsed.acSections.length, 2);
  assertEquals(parsed.acSections[0].id, "AC-1");
  assertEquals(parsed.acSections[0].type, "modified");
  assertEquals(parsed.acSections[1].id, "AC-3");
  assertEquals(parsed.acSections[1].type, "added");
});

Deno.test("round-trip: scaffold scope matches drift set", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "First" },
    { id: "AC-2", type: "modified", text: "Second" },
    { id: "AC-3", type: "removed", text: "Third" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0042",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));

  const scopeResult = checkScope(parsed, driftSet);
  assert(scopeResult.valid);
});

// ─── Example from spec ─────────────────────────────────────────────────────

Deno.test("spec example: FEAT-0042 plan with 1 modified + 1 added", () => {
  const planContent = `# Sync plan — FEAT-0042 Password reset via email

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

- \`npm test -- src/auth\`
- \`npm run lint -- src/auth\`
`;

  const parsed = parsePlan(planContent);
  assert(isParsedPlan(parsed));

  assertEquals(parsed.featId, "FEAT-0042");
  assertEquals(parsed.title, "Password reset via email");
  assertEquals(parsed.snapshotState, "drifted");

  assertEquals(parsed.acSections.length, 2);
  assertEquals(parsed.acSections[0].id, "AC-1");
  assertEquals(parsed.acSections[0].type, "modified");
  assertEquals(parsed.acSections[1].id, "AC-3");
  assertEquals(parsed.acSections[1].type, "added");

  assertEquals(parsed.verificationCommands.length, 2);
  assertEquals(parsed.verificationCommands[0], "npm test -- src/auth");
  assertEquals(parsed.verificationCommands[1], "npm run lint -- src/auth");

  // Scope check against matching drift set
  const driftSet: DriftEntry[] = [
    {
      id: "AC-1",
      type: "modified",
      text: "Given a registered email, a reset link is delivered within 1 minute",
    },
    {
      id: "AC-3",
      type: "added",
      text: "Given three failed reset attempts in 10 minutes, block further attempts for 1 hour",
    },
  ];
  const scopeResult = checkScope(parsed, driftSet);
  assert(scopeResult.valid);
});

Deno.test("spec example: new greenfield spec plan", () => {
  const planContent = `# Sync plan — FEAT-0099 Account settings screen

Started: 2026-04-17T15:02:00Z
Snapshot state: new
Drift summary: 4 added (whole spec)

## AC-1 (added): First criterion

Approach: implement the screen.

Files:
- new: src/settings.ts

## AC-2 (added): Second criterion

Approach: add validation.

Files:
- modified: src/settings.ts

## AC-3 (added): Third criterion

Approach: add persistence.

Files:
- new: src/store.ts

## AC-4 (added): Fourth criterion

Approach: add tests.

Files:
- new: tests/settings.test.ts

## Verification

- \`deno test\`
`;

  const parsed = parsePlan(planContent);
  assert(isParsedPlan(parsed));

  assertEquals(parsed.featId, "FEAT-0099");
  assertEquals(parsed.snapshotState, "new");
  assertEquals(parsed.acSections.length, 4);
  for (const s of parsed.acSections) {
    assertEquals(s.type, "added");
  }
  assertStringIncludes(parsed.driftSummary, "4 added (whole spec)");
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

Deno.test("edge: generatePlan with single removed AC", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-5", type: "removed", text: "Deprecated criterion" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0001",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.acSections.length, 1);
  assertEquals(parsed.acSections[0].id, "AC-5");
  assertEquals(parsed.acSections[0].type, "removed");
});

Deno.test("edge: generatePlan with modified AC includes Change marker", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "modified", text: "Updated text" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0001",
    title: "Test",
    snapshotState: "drifted",
    driftSet,
  });

  assertStringIncludes(plan, "Change:");
});

Deno.test("edge: generatePlan with added AC does not include Change marker", () => {
  const driftSet: DriftEntry[] = [
    { id: "AC-1", type: "added", text: "New text" },
  ];

  const plan = generatePlan({
    featId: "FEAT-0001",
    title: "Test",
    snapshotState: "new",
    driftSet,
  });

  // AC-1 section shouldn't have Change:
  const lines = plan.split("\n");
  const ac1Start = lines.findIndex((l) => l.includes("## AC-1"));
  const nextSection = lines.findIndex(
    (l, i) => i > ac1Start && l.startsWith("## "),
  );
  const ac1Body = lines.slice(ac1Start, nextSection).join("\n");
  assert(!ac1Body.includes("Change:"));
});

Deno.test("edge: parsePlan handles empty plan body", () => {
  const plan = `# Sync plan — FEAT-0001 Test

Started: 2026-04-17T14:30:00Z
Snapshot state: new
Drift summary: 1 added (whole spec)

## AC-1 (added): Test

## Verification

`;

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  assertEquals(parsed.acSections.length, 1);
  assertEquals(parsed.acSections[0].body, "");
  assertEquals(parsed.verificationCommands.length, 0);
});

Deno.test("edge: drift set sorting: added before modified before removed", () => {
  const snapshot = makeParsedSpec([
    { id: "AC-1", text: "Will be removed" },
    { id: "AC-2", text: "Original" },
  ]);
  const current = makeParsedSpec([
    { id: "AC-2", text: "Modified" },
    { id: "AC-3", text: "Added" },
  ]);

  const driftSet = computeDriftSet(current, snapshot);
  assertEquals(driftSet.length, 3);
  assertEquals(driftSet[0].type, "added");   // AC-3
  assertEquals(driftSet[1].type, "modified"); // AC-2
  assertEquals(driftSet[2].type, "removed");  // AC-1
});

Deno.test("edge: multiple backtick commands in one line are not extracted", () => {
  const plan = [
    "# Sync plan — FEAT-0042 Test",
    "",
    "Started: 2026-04-17T14:30:00Z",
    "Snapshot state: new",
    "Drift summary: 1 added (whole spec)",
    "",
    "## AC-1 (added): Test",
    "",
    "Approach: do it.",
    "",
    "## Verification",
    "",
    "- `deno test` and then `deno lint`",
    "- `deno check`",
    "",
  ].join("\n");

  const parsed = parsePlan(plan);
  assert(isParsedPlan(parsed));
  // The line with two backtick spans doesn't match the single-backtick pattern
  assertEquals(parsed.verificationCommands.length, 1);
  assertEquals(parsed.verificationCommands[0], "deno check");
});

Deno.test("edge: generatePlan timestamp defaults to current time", () => {
  const plan = generatePlan({
    featId: "FEAT-0001",
    title: "Test",
    snapshotState: "new",
    driftSet: [{ id: "AC-1", type: "added", text: "Test" }],
  });

  assertStringIncludes(plan, "Started: 20");
});

Deno.test("edge: loadDriftSet returns error for unparseable spec", () => {
  withProject((root) => {
    const specPath = path.join(root, "specs", "FEAT-0042-broken.md");
    Deno.writeTextFileSync(specPath, "not a valid spec");

    const result = loadDriftSet(root, "FEAT-0042", "specs/FEAT-0042-broken.md", "new");
    assert("error" in result);
    assertStringIncludes(result.error, "failed to parse");
  });
});
