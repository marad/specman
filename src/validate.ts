/**
 * FEAT-0007: Validate command
 *
 * Checks every structural and cross-file invariant SpecMan depends on
 * and reports every violation in one pass. The policy layer on top of
 * the parser — it checks FEAT-0001 rules the parser deliberately
 * doesn't enforce.
 */

import * as path from "@std/path";
import { parse, isParsedSpec, type ParsedSpec, type ParseError } from "./parser.ts";
import { walkSpecFiles, type SpecFileEntry } from "./specs.ts";
import { scanSnapshots, validateSnapshots } from "./snapshot.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Severity = "error" | "warning";

export interface Finding {
  code: string;
  severity: Severity;
  path: string;
  line?: number;
  message: string;
}

export interface ValidateResult {
  specsChecked: number;
  findings: Finding[];
}

export interface ValidateOptions {
  format?: "human" | "json";
  strict?: boolean;
}

// ─── Finding codes ──────────────────────────────────────────────────────────

// Errors
const E_PARSE = "E000-parse-error";
const E_DUPLICATE_ID = "E001-duplicate-id";
const E_MISSING_FIELD = "E002-missing-field";
const E_WRONG_TYPE = "E003-wrong-type";
const E_MISSING_SECTION = "E004-missing-section";
const E_EMPTY_SECTION = "E005-empty-section";
const E_DEPENDS_ON_MISSING = "E006-depends-on-missing";
const E_CYCLE = "E007-cycle";
const E_DUPLICATE_AC = "E008-duplicate-ac";
const E_ORPHAN_SNAPSHOT = "E009-orphan-snapshot";
const E_SNAPSHOT_MISMATCH = "E010-snapshot-mismatch";
const E_ORPHAN_PLAN = "E011-orphan-plan";

// Warnings
const W_FILENAME_CONVENTION = "W001-filename-convention";

// ─── Filename convention ────────────────────────────────────────────────────

const FEAT_FILENAME_PATTERN = /^FEAT-\d+-[a-z0-9-]+\.md$/;

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Run all validation checks against a project.
 *
 * Walks specs/ recursively (excluding specs/assets/), parses each .md file,
 * then performs cross-file checks: duplicate IDs, depends_on targets, cycles,
 * snapshot orphans/mismatches, plan orphans.
 */
export function validate(projectRoot: string): ValidateResult {
  const specsDir = path.join(projectRoot, "specs");

  // Check specs/ exists
  try {
    const stat = Deno.statSync(specsDir);
    if (!stat.isDirectory) {
      return { specsChecked: 0, findings: [] };
    }
  } catch {
    // specs/ does not exist — caller should handle this as AC-11
    return { specsChecked: -1, findings: [] };
  }

  // Walk ALL .md files under specs/ (excluding specs/assets/)
  const allMdFiles = walkAllMdFiles(specsDir, specsDir, projectRoot);
  allMdFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const findings: Finding[] = [];

  // ── Phase 1: Parse each file, collect per-file findings ───────────────
  const parsedSpecs: Array<{
    relPath: string;
    filename: string;
    parsed: ParsedSpec;
  }> = [];

  for (const { relPath, filename } of allMdFiles) {
    const fullPath = path.join(projectRoot, relPath);
    let bytes: string;
    try {
      bytes = Deno.readTextFileSync(fullPath);
    } catch {
      findings.push({
        code: E_PARSE,
        severity: "error",
        path: relPath,
        message: `cannot read file`,
      });
      continue;
    }

    const result = parse(bytes, relPath);

    if (!isParsedSpec(result)) {
      // AC-10: parser errors come through unchanged
      findings.push({
        code: E_PARSE,
        severity: "error",
        path: result.path,
        line: result.line,
        message: result.reason,
      });
      // Check filename convention even for unparseable files
      if (!FEAT_FILENAME_PATTERN.test(filename)) {
        findings.push({
          code: W_FILENAME_CONVENTION,
          severity: "warning",
          path: relPath,
          message: `filename does not match <FEAT-ID>-<slug>.md`,
        });
      }
      continue;
    }

    parsedSpecs.push({ relPath, filename, parsed: result });

    // ── Per-file validations ────────────────────────────────────────────

    // Filename convention (AC-5)
    if (!FEAT_FILENAME_PATTERN.test(filename)) {
      findings.push({
        code: W_FILENAME_CONVENTION,
        severity: "warning",
        path: relPath,
        message: `filename does not match <FEAT-ID>-<slug>.md`,
      });
    }

    // Required frontmatter fields: id, title, status, depends_on
    const fm = result.frontmatter;
    const fmLineBase = 2; // frontmatter fields start at line 2 (after opening ---)

    for (const field of ["id", "title", "status", "depends_on"]) {
      if (!(field in fm) || fm[field] === null || fm[field] === undefined) {
        findings.push({
          code: E_MISSING_FIELD,
          severity: "error",
          path: relPath,
          line: fmLineBase,
          message: `missing required field '${field}'`,
        });
      }
    }

    // Type checks
    if ("id" in fm && fm.id !== undefined && fm.id !== null && typeof fm.id !== "string") {
      findings.push({
        code: E_WRONG_TYPE,
        severity: "error",
        path: relPath,
        line: fmLineBase,
        message: `field 'id' must be a string, got ${typeof fm.id}`,
      });
    }
    if ("title" in fm && fm.title !== undefined && fm.title !== null && typeof fm.title !== "string") {
      findings.push({
        code: E_WRONG_TYPE,
        severity: "error",
        path: relPath,
        line: fmLineBase,
        message: `field 'title' must be a string, got ${typeof fm.title}`,
      });
    }
    if ("status" in fm && fm.status !== undefined && fm.status !== null && typeof fm.status !== "string") {
      findings.push({
        code: E_WRONG_TYPE,
        severity: "error",
        path: relPath,
        line: fmLineBase,
        message: `field 'status' must be a string, got ${typeof fm.status}`,
      });
    }
    if ("depends_on" in fm && fm.depends_on !== undefined && fm.depends_on !== null && !Array.isArray(fm.depends_on)) {
      findings.push({
        code: E_WRONG_TYPE,
        severity: "error",
        path: relPath,
        line: fmLineBase,
        message: `field 'depends_on' must be an array, got ${typeof fm.depends_on}`,
      });
    }

    // Required sections with non-empty bodies: Intent, Acceptance criteria
    for (const requiredHeading of ["Intent", "Acceptance criteria"]) {
      const section = result.sections.find(
        (s) => s.heading.toLowerCase() === requiredHeading.toLowerCase(),
      );
      if (!section) {
        findings.push({
          code: E_MISSING_SECTION,
          severity: "error",
          path: relPath,
          message: `missing required section '## ${requiredHeading}'`,
        });
      } else if (section.body.trim() === "") {
        findings.push({
          code: E_EMPTY_SECTION,
          severity: "error",
          path: relPath,
          message: `required section '## ${requiredHeading}' has empty body`,
        });
      }
    }

    // Duplicate AC IDs within file (AC-8 of FEAT-0006 says parser preserves them;
    // validator flags them)
    const acIds = new Map<string, number>();
    for (const ac of result.acceptance_criteria) {
      const count = (acIds.get(ac.id) ?? 0) + 1;
      acIds.set(ac.id, count);
    }
    for (const [acId, count] of acIds) {
      if (count > 1) {
        findings.push({
          code: E_DUPLICATE_AC,
          severity: "error",
          path: relPath,
          message: `duplicate acceptance criterion '${acId}' (appears ${count} times)`,
        });
      }
    }
  }

  // ── Phase 2: Cross-file checks ────────────────────────────────────────

  // Build id → [file paths] map for duplicate ID detection (AC-2)
  const idToFiles = new Map<string, string[]>();
  for (const { relPath, parsed } of parsedSpecs) {
    const id = parsed.frontmatter.id;
    if (typeof id === "string" && id.length > 0) {
      const files = idToFiles.get(id) ?? [];
      files.push(relPath);
      idToFiles.set(id, files);
    }
  }

  // Report duplicate IDs (AC-2)
  for (const [id, files] of [...idToFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (files.length > 1) {
      const sortedFiles = [...files].sort();
      for (const file of sortedFiles) {
        const others = sortedFiles.filter((f) => f !== file);
        findings.push({
          code: E_DUPLICATE_ID,
          severity: "error",
          path: file,
          line: findFrontmatterFieldLine(projectRoot, file, "id"),
          message: `id "${id}" also declared in ${others.join(", ")}`,
        });
      }
    }
  }

  // Collect set of all valid spec IDs
  const allIds = new Set<string>();
  for (const [id, files] of idToFiles) {
    if (files.length >= 1) {
      allIds.add(id);
    }
  }

  // depends_on target existence (AC-3) and cycle detection (AC-4)
  const graph = new Map<string, string[]>();

  for (const { relPath, parsed } of parsedSpecs) {
    const id = parsed.frontmatter.id;
    const deps = parsed.frontmatter.depends_on;

    if (typeof id !== "string") continue;
    if (!Array.isArray(deps)) continue;

    const validDeps: string[] = [];
    for (const dep of deps) {
      if (typeof dep !== "string") continue;

      // Self-reference: ignored (not a cycle, not flagged)
      if (dep === id) continue;

      if (!allIds.has(dep)) {
        findings.push({
          code: E_DEPENDS_ON_MISSING,
          severity: "error",
          path: relPath,
          line: findFrontmatterFieldLine(projectRoot, relPath, "depends_on"),
          message: `depends_on references nonexistent spec '${dep}'`,
        });
      } else {
        validDeps.push(dep);
      }
    }

    graph.set(id, validDeps);
  }

  // Cycle detection (AC-4) — find all cycles of length >= 2
  const cycles = detectCycles(graph);
  for (const cycle of cycles) {
    // Report the cycle against each spec involved
    const cycleStr = cycle.join(" -> ") + " -> " + cycle[0];
    // Only report once, attributed to the first spec in the cycle (sorted)
    const sortedCycle = [...cycle].sort();
    const firstSpec = sortedCycle[0];
    const firstSpecFile = parsedSpecs.find(
      (s) => typeof s.parsed.frontmatter.id === "string" && s.parsed.frontmatter.id === firstSpec,
    );
    if (firstSpecFile) {
      findings.push({
        code: E_CYCLE,
        severity: "error",
        path: firstSpecFile.relPath,
        message: `dependency cycle detected: ${cycleStr}`,
      });
    }
  }

  // ── Phase 3: Snapshot validation (AC-6, FEAT-0003) ────────────────────

  const snapshotValidation = validateSnapshots(projectRoot);
  for (const orphan of snapshotValidation.orphans) {
    findings.push({
      code: E_ORPHAN_SNAPSHOT,
      severity: "error",
      path: orphan.snapshotPath,
      message: `orphan snapshot: no matching spec for ${orphan.id}`,
    });
  }
  for (const mismatch of snapshotValidation.mismatches) {
    findings.push({
      code: E_SNAPSHOT_MISMATCH,
      severity: "error",
      path: mismatch.snapshotPath,
      message: `snapshot id mismatch: filename says ${mismatch.filenameId}, content says ${mismatch.parsedId}`,
    });
  }

  // ── Phase 4: Plan orphan validation (AC-14) ──────────────────────────

  const planOrphans = scanOrphanPlans(projectRoot, allIds);
  for (const orphan of planOrphans) {
    findings.push({
      code: E_ORPHAN_PLAN,
      severity: "error",
      path: orphan.relPath,
      message: `orphan plan: no matching spec for ${orphan.id}`,
    });
  }

  // Sort findings for deterministic output (AC-9):
  // by path, then line, then code
  findings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    const lineA = a.line ?? 0;
    const lineB = b.line ?? 0;
    if (lineA !== lineB) return lineA - lineB;
    return a.code.localeCompare(b.code);
  });

  return { specsChecked: allMdFiles.length, findings };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface MdFile {
  relPath: string;
  filename: string;
}

/**
 * Walk all .md files under specs/, excluding specs/assets/.
 */
function walkAllMdFiles(
  dir: string,
  specsRoot: string,
  projectRoot: string,
): MdFile[] {
  const results: MdFile[] = [];
  walkMdDir(dir, specsRoot, projectRoot, results);
  return results;
}

function walkMdDir(
  dir: string,
  specsRoot: string,
  projectRoot: string,
  results: MdFile[],
): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }

  // Sort entries for deterministic walk order (AC-9)
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.isDirectory) {
      const relToSpecs = path.relative(specsRoot, path.join(dir, entry.name));
      if (
        relToSpecs === "assets" ||
        relToSpecs.startsWith("assets/") ||
        relToSpecs.startsWith("assets\\")
      ) {
        continue;
      }
      walkMdDir(path.join(dir, entry.name), specsRoot, projectRoot, results);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(projectRoot, fullPath);
      results.push({ relPath, filename: entry.name });
    }
  }
}

/**
 * Find the line number of a frontmatter field by reading the file.
 * Returns the line number (1-indexed) or undefined if not found.
 */
function findFrontmatterFieldLine(
  projectRoot: string,
  relPath: string,
  field: string,
): number | undefined {
  try {
    const bytes = Deno.readTextFileSync(path.join(projectRoot, relPath));
    const lines = bytes.split("\n");
    // frontmatter starts at line 1 (---), fields follow
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith("---")) break; // end of frontmatter
      if (lines[i].startsWith(`${field}:`)) return i + 1; // 1-indexed
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Detect cycles of length >= 2 in a directed graph.
 * Returns unique cycles as arrays of node IDs.
 * Self-references are assumed already filtered out.
 */
function detectCycles(graph: Map<string, string[]>): string[][] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const reportedCycles = new Set<string>();

  function dfs(node: string): void {
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (inStack.has(neighbor)) {
        // Found a cycle — extract it from the stack
        const cycleStart = stack.indexOf(neighbor);
        const cycle = stack.slice(cycleStart);
        if (cycle.length >= 2) {
          // Canonicalize: rotate so smallest id is first, for dedup
          const key = canonicalizeCycle(cycle);
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key);
            cycles.push(cycle);
          }
        }
      } else if (!visited.has(neighbor)) {
        dfs(neighbor);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  // Visit nodes in sorted order for determinism (AC-9)
  const nodes = [...graph.keys()].sort();
  for (const node of nodes) {
    dfs(node);
  }

  // Sort cycles for deterministic output
  cycles.sort((a, b) => canonicalizeCycle(a).localeCompare(canonicalizeCycle(b)));

  return cycles;
}

/** Canonicalize a cycle by rotating to smallest element, then joining */
function canonicalizeCycle(cycle: string[]): string {
  if (cycle.length === 0) return "";
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
  return rotated.join(",");
}

/**
 * Scan .specman/plans/ for orphan plan files (no matching spec).
 */
function scanOrphanPlans(
  projectRoot: string,
  specIds: Set<string>,
): Array<{ id: string; relPath: string }> {
  const plansDir = path.join(projectRoot, ".specman", "plans");
  const orphans: Array<{ id: string; relPath: string }> = [];

  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(plansDir)];
  } catch {
    return orphans;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const FEAT_PATTERN = /^(FEAT-\d+)\.md$/;
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".md")) continue;
    const match = entry.name.match(FEAT_PATTERN);
    if (!match) continue;
    const id = match[1];
    if (!specIds.has(id)) {
      const relPath = path.relative(projectRoot, path.join(plansDir, entry.name));
      orphans.push({ id, relPath });
    }
  }

  return orphans;
}

// ─── Output formatting ─────────────────────────────────────────────────────

/**
 * Format validation results as human-readable lines.
 * Groups findings by file.
 */
export function formatHuman(result: ValidateResult): string[] {
  const lines: string[] = [];

  if (result.specsChecked === -1) {
    // No specs/ dir — handled by caller
    return lines;
  }

  // Gather paths that have findings
  const findingsByPath = new Map<string, Finding[]>();
  const allPaths = new Set<string>();

  // Collect all spec paths (from findings + all checked specs)
  for (const f of result.findings) {
    const existing = findingsByPath.get(f.path) ?? [];
    existing.push(f);
    findingsByPath.set(f.path, existing);
    allPaths.add(f.path);
  }

  // For the "OK" lines, we need to know which spec paths had no findings.
  // We reconstruct spec paths from findings + the specsChecked count.
  // Actually — we should emit findings grouped by file, then specs with no findings as OK.
  // But we don't have the complete file list. The validate function returns specsChecked count.
  // For the human format, we output findings grouped by path, then the summary.

  // Output findings grouped by path
  const sortedPaths = [...findingsByPath.keys()].sort();
  for (const p of sortedPaths) {
    const pathFindings = findingsByPath.get(p)!;
    for (const f of pathFindings) {
      const lineRef = f.line !== undefined ? `:${f.line}` : "";
      lines.push(`${f.path}${lineRef}   ${f.code}  ${f.message}`);
    }
  }

  // Summary
  const errors = result.findings.filter((f) => f.severity === "error").length;
  const warnings = result.findings.filter((f) => f.severity === "warning").length;
  const errorWord = errors === 1 ? "error" : "errors";
  const warningWord = warnings === 1 ? "warning" : "warnings";
  lines.push(`${result.specsChecked} specs checked. ${errors} ${errorWord}, ${warnings} ${warningWord}.`);

  return lines;
}

/**
 * Format validation results as JSON.
 */
export function formatJson(result: ValidateResult): string {
  const output = {
    summary: {
      specs_checked: result.specsChecked,
      errors: result.findings.filter((f) => f.severity === "error").length,
      warnings: result.findings.filter((f) => f.severity === "warning").length,
    },
    findings: result.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      path: f.path,
      ...(f.line !== undefined ? { line: f.line } : {}),
      message: f.message,
    })),
  };
  return JSON.stringify(output, null, 2);
}

/**
 * Determine exit code based on findings and options.
 */
export function exitCode(result: ValidateResult, options: ValidateOptions): number {
  if (result.specsChecked === -1) return 2; // no specs/ dir (AC-11)

  const hasErrors = result.findings.some((f) => f.severity === "error");
  const hasWarnings = result.findings.some((f) => f.severity === "warning");

  if (hasErrors) return 1;
  if (options.strict && hasWarnings) return 1;
  return 0;
}
