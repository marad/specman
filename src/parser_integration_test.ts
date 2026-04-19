/**
 * Integration test: parse every spec in specs/ and verify round-trip.
 * This tests the parser against real-world specs, not just contrived fixtures.
 */

import { assert, assertEquals } from "@std/assert";
import { parse, serialize, isParsedSpec, isParseError } from "../src/parser.ts";

const SPECS_DIR = "specs";

Deno.test("integration: all specs in specs/ parse successfully", async () => {
  const failures: string[] = [];

  for await (const entry of Deno.readDir(SPECS_DIR)) {
    if (!entry.name.endsWith(".md")) continue;
    const path = `${SPECS_DIR}/${entry.name}`;
    const bytes = await Deno.readTextFile(path);
    const result = parse(bytes, path);

    if (isParseError(result)) {
      failures.push(`${path}: ${result.reason} (line ${result.line})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Parse failures:\n${failures.join("\n")}`);
  }
});

Deno.test("integration: all specs round-trip through serialize(parse(bytes))", async () => {
  const drifted: string[] = [];

  for await (const entry of Deno.readDir(SPECS_DIR)) {
    if (!entry.name.endsWith(".md")) continue;
    const path = `${SPECS_DIR}/${entry.name}`;
    const bytes = await Deno.readTextFile(path);
    const result = parse(bytes, path);

    if (isParseError(result)) continue; // covered by previous test

    const serialized = serialize(result);
    if (typeof serialized !== "string") {
      drifted.push(`${path}: serialize error: ${serialized.reason}`);
      continue;
    }

    if (serialized !== bytes) {
      // Show first difference for debugging
      const lines1 = bytes.split("\n");
      const lines2 = serialized.split("\n");
      for (let i = 0; i < Math.max(lines1.length, lines2.length); i++) {
        if (lines1[i] !== lines2[i]) {
          drifted.push(
            `${path}: first diff at line ${i + 1}:\n` +
            `  original:   ${JSON.stringify(lines1[i])}\n` +
            `  serialized: ${JSON.stringify(lines2[i])}`
          );
          break;
        }
      }
    }
  }

  if (drifted.length > 0) {
    throw new Error(`Round-trip failures (non-canonical specs):\n${drifted.join("\n\n")}`);
  }
});

Deno.test("integration: parse(serialize(parse(bytes))) == parse(bytes) for all specs", async () => {
  for await (const entry of Deno.readDir(SPECS_DIR)) {
    if (!entry.name.endsWith(".md")) continue;
    const path = `${SPECS_DIR}/${entry.name}`;
    const bytes = await Deno.readTextFile(path);
    const result = parse(bytes, path);

    if (isParseError(result)) continue;

    const serialized = serialize(result);
    if (typeof serialized !== "string") continue;

    const reparsed = parse(serialized, path);
    assert(isParsedSpec(reparsed), `reparsed should be ParsedSpec for ${path}`);

    // Structural equivalence
    assertEquals(reparsed.frontmatter, result.frontmatter,
      `frontmatter mismatch for ${path}`);
    assertEquals(reparsed.sections.length, result.sections.length,
      `section count mismatch for ${path}`);
    for (let i = 0; i < result.sections.length; i++) {
      assertEquals(reparsed.sections[i].heading, result.sections[i].heading,
        `section heading mismatch at index ${i} for ${path}`);
      assertEquals(reparsed.sections[i].body, result.sections[i].body,
        `section body mismatch at index ${i} for ${path}`);
    }
    assertEquals(reparsed.acceptance_criteria.length, result.acceptance_criteria.length,
      `AC count mismatch for ${path}`);
  }
});
