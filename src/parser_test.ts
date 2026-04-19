/**
 * Tests for FEAT-0006: Spec parser and serializer
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0006-spec-parser.md
 */

import { assertEquals, assertNotEquals, assert } from "@std/assert";
import {
  parse,
  serialize,
  isParsedSpec,
  isParseError,
  type ParsedSpec,
  type ParseError,
  type SerializeError,
} from "../src/parser.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mustParse(bytes: string, path = "test.md"): ParsedSpec {
  const result = parse(bytes, path);
  if (isParseError(result)) {
    throw new Error(`Expected parse success, got error: ${result.reason} at ${result.path}:${result.line}`);
  }
  return result;
}

function mustError(bytes: string, path = "test.md"): ParseError {
  const result = parse(bytes, path);
  if (isParsedSpec(result)) {
    throw new Error(`Expected parse error, got success`);
  }
  return result;
}

function mustSerialize(spec: ParsedSpec): string {
  const result = serialize(spec);
  if (typeof result !== "string") {
    throw new Error(`Expected serialize success, got error: ${result.reason} for field ${result.field}`);
  }
  return result;
}

// ─── Canonical test fixture ─────────────────────────────────────────────────

const CANONICAL_SPEC = `---
id: FEAT-0042
title: Password reset via email
status: draft
depends_on: []
---

## Intent

Let users regain account access without contacting support.

## Acceptance criteria

- AC-1: Given a registered email, a reset link is delivered within 1 minute.
`;

// ─── AC-1: Well-formed spec parsing ────────────────────────────────────────

Deno.test("AC-1: parse returns structured ParsedSpec for well-formed input", () => {
  const result = mustParse(CANONICAL_SPEC);

  // Frontmatter contains every key
  assertEquals(result.frontmatter.id, "FEAT-0042");
  assertEquals(result.frontmatter.title, "Password reset via email");
  assertEquals(result.frontmatter.status, "draft");
  assertEquals(result.frontmatter.depends_on, []);

  // Sections in source order
  assertEquals(result.sections.length, 2);
  assertEquals(result.sections[0].heading, "Intent");
  assert(result.sections[0].body.includes("Let users regain account access"));
  assertEquals(result.sections[1].heading, "Acceptance criteria");

  // ACs extracted in source order
  assertEquals(result.acceptance_criteria.length, 1);
  assertEquals(result.acceptance_criteria[0].id, "AC-1");
  assert(result.acceptance_criteria[0].text.includes("registered email"));
});

Deno.test("AC-1: frontmatter values are YAML-parsed as-is", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: [FEAT-0010, FEAT-0020]
platforms: [web, ios]
---

## Intent

Test intent.

## Acceptance criteria

- AC-1: Test criterion.
`;
  const result = mustParse(input);
  assertEquals(result.frontmatter.depends_on, ["FEAT-0010", "FEAT-0020"]);
  assertEquals(result.frontmatter.platforms, ["web", "ios"]);
});

// ─── AC-2: Malformed YAML ──────────────────────────────────────────────────

Deno.test("AC-2: malformed YAML returns ParseError with line number", () => {
  const input = `---
id: FEAT-0001
depends_on: [unclosed
status: draft
---

## Intent

Test.

## Acceptance criteria

- AC-1: Test.
`;
  const err = mustError(input, "specs/bad.md");
  assertEquals(err.path, "specs/bad.md");
  assert(err.line > 0, `expected line > 0, got ${err.line}`);
  assert(err.reason.includes("malformed YAML"), `reason should mention malformed YAML: ${err.reason}`);
});

Deno.test("AC-2: unterminated frontmatter returns ParseError", () => {
  const input = `---
id: FEAT-0001
title: Test
`;
  const err = mustError(input);
  assertEquals(err.line, 1);
  assert(err.reason.includes("unterminated frontmatter"));
});

Deno.test("AC-2: missing opening frontmatter returns ParseError", () => {
  const input = `id: FEAT-0001
title: Test
---`;
  const err = mustError(input);
  assertEquals(err.line, 1);
  assert(err.reason.includes("missing frontmatter"));
});

// ─── AC-3: Wrong-type values pass through ──────────────────────────────────

Deno.test("AC-3: status: 42 is parsed as integer, not rejected", () => {
  const input = `---
id: FEAT-0001
title: Test
status: 42
depends_on: []
---

## Intent

Test.

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  assertEquals(result.frontmatter.status, 42);
});

Deno.test("AC-3: depends_on as string passes through", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: FEAT-0010
---

## Intent

Test.

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  assertEquals(result.frontmatter.depends_on, "FEAT-0010");
});

// ─── AC-4: Missing required fields/sections pass through ───────────────────

Deno.test("AC-4: missing frontmatter field is simply absent", () => {
  const input = `---
id: FEAT-0001
---

## Intent

Test.

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  assertEquals(result.frontmatter.id, "FEAT-0001");
  assertEquals(result.frontmatter.title, undefined);
  assertEquals(result.frontmatter.status, undefined);
  assertEquals(result.frontmatter.depends_on, undefined);
});

Deno.test("AC-4: missing body section is absent from sections", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  // Intent section is not present
  const intentSection = result.sections.find(s => s.heading === "Intent");
  assertEquals(intentSection, undefined);
});

// ─── AC-5: Empty required section present with empty body ──────────────────

Deno.test("AC-5: section with heading but empty body returns empty body string", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  const intentSection = result.sections.find(s => s.heading === "Intent");
  assert(intentSection !== undefined, "Intent section should be present");
  assertEquals(intentSection.body, "");
});

// ─── AC-6: AC extraction with platform markers ────────────────────────────

Deno.test("AC-6: basic AC extraction", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

Test.

## Acceptance criteria

- AC-1: First criterion.
- AC-2: Second criterion.
- AC-3: Third criterion.
`;
  const result = mustParse(input);
  assertEquals(result.acceptance_criteria.length, 3);
  assertEquals(result.acceptance_criteria[0].id, "AC-1");
  assertEquals(result.acceptance_criteria[0].text, "First criterion.");
  assertEquals(result.acceptance_criteria[1].id, "AC-2");
  assertEquals(result.acceptance_criteria[2].id, "AC-3");
});

Deno.test("AC-6: AC with platform marker preserves ID correctly", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

Test.

## Acceptance criteria

- AC-1: Universal criterion.
- AC-2 *(web only)*: Web-specific criterion.
- AC-3 *(ios, android)*: Mobile-specific criterion.
`;
  const result = mustParse(input);
  assertEquals(result.acceptance_criteria.length, 3);
  assertEquals(result.acceptance_criteria[0].id, "AC-1");
  assertEquals(result.acceptance_criteria[0].text, "Universal criterion.");
  assertEquals(result.acceptance_criteria[1].id, "AC-2");
  assertEquals(result.acceptance_criteria[1].text, "Web-specific criterion.");
  assertEquals(result.acceptance_criteria[2].id, "AC-3");
  assertEquals(result.acceptance_criteria[2].text, "Mobile-specific criterion.");
});

// ─── AC-7: AC pattern outside Acceptance criteria section ──────────────────

Deno.test("AC-7: AC-like bullets outside ## Acceptance criteria are not extracted", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

Test.

## Behavior

- AC-99: This looks like an AC but isn't in the right section.

## Acceptance criteria

- AC-1: Real criterion.
`;
  const result = mustParse(input);
  assertEquals(result.acceptance_criteria.length, 1);
  assertEquals(result.acceptance_criteria[0].id, "AC-1");
});

// ─── AC-8: Duplicate AC IDs preserved ──────────────────────────────────────

Deno.test("AC-8: duplicate AC IDs both appear in source order", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

Test.

## Acceptance criteria

- AC-1: First version.
- AC-1: Duplicate version.
- AC-2: Another one.
`;
  const result = mustParse(input);
  assertEquals(result.acceptance_criteria.length, 3);
  assertEquals(result.acceptance_criteria[0].id, "AC-1");
  assertEquals(result.acceptance_criteria[0].text, "First version.");
  assertEquals(result.acceptance_criteria[1].id, "AC-1");
  assertEquals(result.acceptance_criteria[1].text, "Duplicate version.");
  assertEquals(result.acceptance_criteria[2].id, "AC-2");
});

// ─── AC-9: ParseError carries path and line ────────────────────────────────

Deno.test("AC-9: ParseError has path and line sufficient for editor/CLI", () => {
  const err = mustError(`---
bad: [unclosed
---`, "specs/FEAT-0001-test.md");
  assertEquals(err.path, "specs/FEAT-0001-test.md");
  assert(typeof err.line === "number");
  assert(err.line >= 1);
  assert(err.reason.length > 0);
});

// ─── AC-10: Round-trip byte-identical for canonical input ──────────────────

Deno.test("AC-10: serialize(parse(canonical)) == canonical byte-for-byte", () => {
  const result = mustParse(CANONICAL_SPEC);
  const reserialized = mustSerialize(result);
  assertEquals(reserialized, CANONICAL_SPEC);
});

Deno.test("AC-10: round-trip with multiple sections", () => {
  const input = `---
id: FEAT-0099
title: Account settings screen
status: active
platforms: [web, ios, android]
depends_on: [FEAT-0010]
---

## Intent

Let users manage their account.

## Behavior

Users can change email, password, and notification preferences.

## Acceptance criteria

- AC-1: Given a logged-in user, the settings page loads within 2 seconds.
- AC-2 *(web only)*: Given a desktop browser, the layout uses a two-column grid.
`;
  const result = mustParse(input);
  const reserialized = mustSerialize(result);
  assertEquals(reserialized, input);
});

// ─── AC-11: parse(serialize(ps)) == ps ─────────────────────────────────────

Deno.test("AC-11: parse(serialize(ps)) produces equivalent ParsedSpec", () => {
  const original = mustParse(CANONICAL_SPEC);
  const bytes = mustSerialize(original);
  const reparsed = mustParse(bytes);

  assertEquals(reparsed.frontmatter, original.frontmatter);
  assertEquals(reparsed.sections.length, original.sections.length);
  for (let i = 0; i < original.sections.length; i++) {
    assertEquals(reparsed.sections[i].heading, original.sections[i].heading);
    assertEquals(reparsed.sections[i].body, original.sections[i].body);
  }
  assertEquals(reparsed.acceptance_criteria.length, original.acceptance_criteria.length);
  for (let i = 0; i < original.acceptance_criteria.length; i++) {
    assertEquals(reparsed.acceptance_criteria[i].id, original.acceptance_criteria[i].id);
    assertEquals(reparsed.acceptance_criteria[i].text, original.acceptance_criteria[i].text);
  }
});

// ─── AC-12: Non-canonical input gets canonicalized ─────────────────────────

Deno.test("AC-12: non-canonical frontmatter order is canonicalized", () => {
  const input = `---
title: Password reset via email
id: FEAT-0042
depends_on: []
status: draft
---

## Intent

Let users regain account access without contacting support.

## Acceptance criteria

- AC-1: Given a registered email, a reset link is delivered within 1 minute.
`;
  const result = mustParse(input);
  const canonical = mustSerialize(result);

  // Frontmatter should be in canonical order
  const fmLines = canonical.split("---")[1].trim().split("\n");
  assert(fmLines[0].startsWith("id:"), `first FM key should be id, got: ${fmLines[0]}`);
  assert(fmLines[1].startsWith("title:"), `second FM key should be title, got: ${fmLines[1]}`);
  assert(fmLines[2].startsWith("status:"), `third FM key should be status, got: ${fmLines[2]}`);
  assert(fmLines[3].startsWith("depends_on:"), `fourth FM key should be depends_on, got: ${fmLines[3]}`);

  // Content preserved
  const reparsed = mustParse(canonical);
  assertEquals(reparsed.frontmatter.id, "FEAT-0042");
  assertEquals(reparsed.frontmatter.title, "Password reset via email");
});

Deno.test("AC-12: irregular blank lines are normalized", () => {
  const input = `---
id: FEAT-0042
title: Test
status: draft
depends_on: []
---



## Intent
Let users regain account access.


## Acceptance criteria
- AC-1: Test criterion.
`;
  const result = mustParse(input);
  const canonical = mustSerialize(result);

  // Should have exactly one blank line before and after headings
  assert(!canonical.includes("\n\n\n"), "should not have triple newlines");
  // Content should be preserved
  const reparsed = mustParse(canonical);
  assertEquals(reparsed.frontmatter.id, "FEAT-0042");
  assert(reparsed.sections[0].body.includes("Let users regain account access"));
});

// ─── AC-13: Deterministic serialization ────────────────────────────────────

Deno.test("AC-13: two serialize calls on same ParsedSpec produce identical bytes", () => {
  const spec = mustParse(CANONICAL_SPEC);
  const bytes1 = mustSerialize(spec);
  const bytes2 = mustSerialize(spec);
  assertEquals(bytes1, bytes2);
});

// ─── AC-14: Serializer preserves section order ─────────────────────────────

Deno.test("AC-14: serializer emits sections in ParsedSpec order, not canonical order", () => {
  // Deliberately put AC before Intent
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Acceptance criteria

- AC-1: Test.

## Intent

Test intent.
`;
  const result = mustParse(input);
  assertEquals(result.sections[0].heading, "Acceptance criteria");
  assertEquals(result.sections[1].heading, "Intent");

  const reserialized = mustSerialize(result);
  const headingPositions = [
    reserialized.indexOf("## Acceptance criteria"),
    reserialized.indexOf("## Intent"),
  ];
  assert(headingPositions[0] < headingPositions[1],
    "Acceptance criteria should come before Intent in output");
});

// ─── AC-15: SerializeError for unsupported types ───────────────────────────

Deno.test("AC-15: serialize raises SerializeError for nested object in frontmatter", () => {
  const spec: ParsedSpec = {
    frontmatter: {
      id: "FEAT-0001",
      title: "Test",
      status: "draft",
      depends_on: [],
      nested: { deep: "value" },
    },
    sections: [
      { heading: "Intent", body: "Test.\n" },
      { heading: "Acceptance criteria", body: "- AC-1: Test.\n" },
    ],
    acceptance_criteria: [{ id: "AC-1", text: "Test." }],
  };
  const result = serialize(spec);
  assert(typeof result !== "string", "expected SerializeError");
  assertEquals((result as SerializeError).field, "nested");
});

// ─── Additional edge cases ─────────────────────────────────────────────────

Deno.test("edge: empty frontmatter parses successfully", () => {
  const input = `---
---

## Intent

Test.

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  assertEquals(Object.keys(result.frontmatter).length, 0);
});

Deno.test("edge: spec with no sections after frontmatter", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---
`;
  const result = mustParse(input);
  assertEquals(result.sections.length, 0);
  assertEquals(result.acceptance_criteria.length, 0);
});

Deno.test("edge: custom sections are preserved", () => {
  const input = `---
id: FEAT-0001
title: Test
status: draft
depends_on: []
---

## Intent

Test.

## Security considerations

Must encrypt at rest.

## Acceptance criteria

- AC-1: Test.
`;
  const result = mustParse(input);
  assertEquals(result.sections.length, 3);
  assertEquals(result.sections[1].heading, "Security considerations");
  assert(result.sections[1].body.includes("encrypt at rest"));
});

Deno.test("edge: long depends_on list uses block style", () => {
  const spec: ParsedSpec = {
    frontmatter: {
      id: "FEAT-0099",
      title: "Test",
      status: "draft",
      depends_on: [
        "FEAT-0001", "FEAT-0002", "FEAT-0003", "FEAT-0004",
        "FEAT-0005", "FEAT-0006", "FEAT-0007", "FEAT-0008",
      ],
    },
    sections: [
      { heading: "Intent", body: "Test.\n" },
      { heading: "Acceptance criteria", body: "- AC-1: Test.\n" },
    ],
    acceptance_criteria: [{ id: "AC-1", text: "Test." }],
  };
  const bytes = mustSerialize(spec);
  // Should use block style
  assert(bytes.includes("depends_on:\n  - FEAT-0001"),
    `expected block style, got: ${bytes}`);
});

Deno.test("edge: boolean-like string values are quoted", () => {
  const spec: ParsedSpec = {
    frontmatter: {
      id: "FEAT-0001",
      title: "true",
      status: "yes",
      depends_on: [],
    },
    sections: [
      { heading: "Intent", body: "Test.\n" },
      { heading: "Acceptance criteria", body: "- AC-1: Test.\n" },
    ],
    acceptance_criteria: [{ id: "AC-1", text: "Test." }],
  };
  const bytes = mustSerialize(spec);
  assert(bytes.includes('title: "true"'), `expected quoted true, got: ${bytes}`);
  assert(bytes.includes('status: "yes"'), `expected quoted yes, got: ${bytes}`);
});

Deno.test("round-trip: real-world spec from examples dir", async () => {
  // Use the canonical example from the spec itself
  const input = `---
id: FEAT-0042
title: Password reset via email
status: draft
depends_on: [FEAT-0010]
---

## Intent

Let users regain access to their account without contacting support.

## Acceptance criteria

- AC-1: Given a registered email, when the user requests a reset, then a reset link is delivered within 1 minute.
- AC-2: Given a reset link older than 1 hour, when followed, then the request is rejected with a clear error.
`;
  const parsed = mustParse(input);
  const serialized = mustSerialize(parsed);
  assertEquals(serialized, input);
});
