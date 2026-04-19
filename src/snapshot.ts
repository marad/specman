/**
 * FEAT-0003: Implementation snapshots and drift detection
 *
 * Tracks which version of each spec the codebase currently reflects.
 * Drift is detected by comparing the canonical form of the current
 * spec against the snapshot in .specman/implemented/<FEAT-ID>.md.
 */

import * as path from "@std/path";
import { parse, serialize, isParsedSpec, type ParsedSpec } from "./parser.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Status of a single spec relative to its snapshot */
export type SpecStatus = "in-sync" | "drifted" | "new";

/** Result of classifying a spec */
export interface SpecStatusEntry {
  id: string;
  status: SpecStatus;
  specPath: string;        // relative to projectRoot
  snapshotPath: string;    // relative to projectRoot
  hint?: string;           // optional human hint, e.g. "(body changed)" or "(no snapshot yet)"
}

/** Orphan snapshot: snapshot exists but spec does not */
export interface OrphanSnapshot {
  snapshotPath: string;    // relative to projectRoot
  id: string;
}

/** Mismatched snapshot: parsed id ≠ filename-derived id */
export interface MismatchedSnapshot {
  snapshotPath: string;    // relative to projectRoot
  filenameId: string;
  parsedId: string;
}

/** Full status result for all specs in the project */
export interface StatusResult {
  entries: SpecStatusEntry[];
}

/** Validation result for snapshots */
export interface SnapshotValidation {
  orphans: OrphanSnapshot[];
  mismatches: MismatchedSnapshot[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const IMPLEMENTED_DIR = ".specman/implemented";
const SPECS_DIR = "specs";
const FEAT_PATTERN = /^FEAT-\d+/;
const FEAT_FILE_PATTERN = /^(FEAT-\d+)-.*\.md$/;

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Compute the canonical form of a spec's raw bytes.
 *
 * Parses the spec, then re-serializes it. If parsing fails,
 * returns null to signal that the caller should fall back to
 * raw byte comparison.
 */
export function toCanonicalForm(bytes: string, filePath: string): string | null {
  const parsed = parse(bytes, filePath);
  if (!isParsedSpec(parsed)) {
    return null; // parse failed — caller falls back to raw bytes
  }
  const serialized = serialize(parsed);
  if (typeof serialized !== "string") {
    return null; // serialize failed — fall back
  }
  return serialized;
}

/**
 * Compute the drift status of a single spec.
 *
 * - If no snapshot exists → "new"
 * - If canonical form matches snapshot byte-for-byte → "in-sync"
 * - If canonical form differs (or parse fails, falling back to raw) → "drifted"
 */
export function detectDrift(
  projectRoot: string,
  specId: string,
  specFilePath: string,
): SpecStatus {
  const snapshotPath = path.join(projectRoot, IMPLEMENTED_DIR, `${specId}.md`);

  // Read snapshot
  let snapshotBytes: string;
  try {
    snapshotBytes = Deno.readTextFileSync(snapshotPath);
  } catch {
    return "new";
  }

  // Read current spec
  const specBytes = Deno.readTextFileSync(
    path.join(projectRoot, specFilePath),
  );

  // Try canonical comparison
  const canonical = toCanonicalForm(specBytes, specFilePath);

  if (canonical === null) {
    // Parse failed — fall back to raw byte comparison
    return specBytes === snapshotBytes ? "in-sync" : "drifted";
  }

  // Canonical comparison against snapshot (snapshot is already canonical)
  return canonical === snapshotBytes ? "in-sync" : "drifted";
}

/**
 * Write a snapshot for a spec. Called ONLY by sync/seal commands.
 *
 * The bytes written are the canonical form of the spec.
 * Ensures the implemented/ directory exists.
 */
export function writeSnapshot(
  projectRoot: string,
  specId: string,
  canonicalBytes: string,
): void {
  const dir = path.join(projectRoot, IMPLEMENTED_DIR);
  Deno.mkdirSync(dir, { recursive: true });
  const snapshotPath = path.join(dir, `${specId}.md`);
  Deno.writeTextFileSync(snapshotPath, canonicalBytes);
}

/**
 * Read a snapshot file. Returns null if not found.
 */
export function readSnapshot(
  projectRoot: string,
  specId: string,
): string | null {
  const snapshotPath = path.join(projectRoot, IMPLEMENTED_DIR, `${specId}.md`);
  try {
    return Deno.readTextFileSync(snapshotPath);
  } catch {
    return null;
  }
}

// ─── Scanning ───────────────────────────────────────────────────────────────

/**
 * Find all spec files under specs/, recursively.
 * Returns array of { id, relPath } where relPath is relative to projectRoot.
 * Skips specs/assets/.
 */
export function scanSpecs(projectRoot: string): Array<{ id: string; relPath: string }> {
  const specsDir = path.join(projectRoot, SPECS_DIR);
  const results: Array<{ id: string; relPath: string }> = [];
  walkSpecs(specsDir, specsDir, projectRoot, results);
  // Sort by ID for deterministic output
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

function walkSpecs(
  dir: string,
  specsRoot: string,
  projectRoot: string,
  results: Array<{ id: string; relPath: string }>,
): void {
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory) {
      const relToSpecs = path.relative(specsRoot, path.join(dir, entry.name));
      if (relToSpecs === "assets" || relToSpecs.startsWith("assets/") || relToSpecs.startsWith("assets\\")) {
        continue;
      }
      walkSpecs(path.join(dir, entry.name), specsRoot, projectRoot, results);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      const match = entry.name.match(FEAT_FILE_PATTERN);
      if (match) {
        const rawId = match[1];
        // Normalize to 4-digit zero-padded
        const numMatch = rawId.match(/^FEAT-(\d+)$/);
        if (numMatch) {
          const num = parseInt(numMatch[1], 10);
          const id = `FEAT-${String(num).padStart(4, "0")}`;
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(projectRoot, fullPath);
          results.push({ id, relPath });
        }
      }
    }
  }
}

/**
 * Find all snapshot files under .specman/implemented/.
 * Returns array of { filenameId, relPath }.
 */
export function scanSnapshots(projectRoot: string): Array<{ filenameId: string; relPath: string }> {
  const implDir = path.join(projectRoot, IMPLEMENTED_DIR);
  const results: Array<{ filenameId: string; relPath: string }> = [];

  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(implDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      const idPart = entry.name.replace(/\.md$/, "");
      if (FEAT_PATTERN.test(idPart)) {
        const relPath = path.relative(projectRoot, path.join(implDir, entry.name));
        results.push({ filenameId: idPart, relPath });
      }
    }
  }

  results.sort((a, b) => a.filenameId.localeCompare(b.filenameId));
  return results;
}

// ─── Status Command ─────────────────────────────────────────────────────────

/**
 * Compute status for all specs in the project.
 */
export function getStatus(projectRoot: string): StatusResult {
  const specs = scanSpecs(projectRoot);
  const entries: SpecStatusEntry[] = [];

  for (const { id, relPath } of specs) {
    const snapshotRelPath = path.join(IMPLEMENTED_DIR, `${id}.md`);
    const status = detectDrift(projectRoot, id, relPath);
    let hint: string | undefined;

    if (status === "new") {
      hint = "(no snapshot yet)";
    } else if (status === "drifted") {
      hint = "(changed since last sync)";
    }

    entries.push({
      id,
      status,
      specPath: relPath,
      snapshotPath: snapshotRelPath,
      hint,
    });
  }

  return { entries };
}

/**
 * Format status output for CLI.
 *
 * Default: show drifted and new specs; summarize in-sync as a count.
 * --verbose: show all specs including in-sync.
 */
export function formatStatus(
  result: StatusResult,
  options: { verbose?: boolean; diff?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const inSync = result.entries.filter((e) => e.status === "in-sync");
  const drifted = result.entries.filter((e) => e.status === "drifted");
  const newSpecs = result.entries.filter((e) => e.status === "new");

  if (options.verbose) {
    // Show all entries
    for (const entry of result.entries) {
      lines.push(formatStatusLine(entry));
    }
  } else {
    // Show drifted and new; summarize in-sync
    for (const entry of drifted) {
      lines.push(formatStatusLine(entry));
    }
    for (const entry of newSpecs) {
      lines.push(formatStatusLine(entry));
    }
    if (inSync.length > 0) {
      const plural = inSync.length === 1 ? "spec" : "specs";
      lines.push(`${inSync.length} ${plural} in-sync`);
    }
  }

  if (lines.length === 0) {
    lines.push("No specs found.");
  }

  return lines;
}

function formatStatusLine(entry: SpecStatusEntry): string {
  const hint = entry.hint ? `  ${entry.hint}` : "";
  return `${entry.id} ${entry.status}${hint}`;
}

/**
 * Generate a unified diff between two strings.
 * Simple line-based unified diff implementation.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: string[] = [];

  lines.push(`--- ${oldLabel}`);
  lines.push(`+++ ${newLabel}`);

  // Simple diff: find differences using LCS-based approach
  const diff = computeLineDiff(oldLines, newLines);

  // Group into hunks
  const hunks = groupIntoHunks(diff, oldLines.length, newLines.length);
  for (const hunk of hunks) {
    lines.push(hunk);
  }

  return lines.join("\n");
}

interface DiffLine {
  type: "keep" | "remove" | "add";
  text: string;
  oldIdx?: number;
  newIdx?: number;
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Myers diff or simple LCS
  const n = oldLines.length;
  const m = newLines.length;

  // LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = n, j = m;
  const stack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "keep", text: oldLines[i - 1], oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", text: newLines[j - 1], newIdx: j - 1 });
      j--;
    } else {
      stack.push({ type: "remove", text: oldLines[i - 1], oldIdx: i - 1 });
      i--;
    }
  }

  // Reverse since we built it backwards
  for (let k = stack.length - 1; k >= 0; k--) {
    result.push(stack[k]);
  }

  return result;
}

function groupIntoHunks(diff: DiffLine[], _oldLen: number, _newLen: number, context: number = 3): string[] {
  const lines: string[] = [];

  // Find regions with changes
  const changeIndices: number[] = [];
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type !== "keep") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return lines;

  // Group changes into hunks with context
  let hunkStart = 0;
  let hunkChanges: number[] = [changeIndices[0]];

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - changeIndices[i - 1] <= context * 2 + 1) {
      hunkChanges.push(changeIndices[i]);
    } else {
      // Emit hunk
      emitHunk(diff, hunkChanges, context, lines);
      hunkChanges = [changeIndices[i]];
    }
  }

  // Final hunk
  if (hunkChanges.length > 0) {
    emitHunk(diff, hunkChanges, context, lines);
  }

  return lines;
}

function emitHunk(diff: DiffLine[], changeIndices: number[], context: number, lines: string[]): void {
  const firstChange = changeIndices[0];
  const lastChange = changeIndices[changeIndices.length - 1];

  const start = Math.max(0, firstChange - context);
  const end = Math.min(diff.length - 1, lastChange + context);

  // Count old and new lines in this hunk
  let oldStart = 1;
  let newStart = 1;
  for (let i = 0; i < start; i++) {
    if (diff[i].type === "keep" || diff[i].type === "remove") oldStart++;
    if (diff[i].type === "keep" || diff[i].type === "add") newStart++;
  }

  let oldCount = 0;
  let newCount = 0;
  const hunkLines: string[] = [];

  for (let i = start; i <= end; i++) {
    const d = diff[i];
    if (d.type === "keep") {
      hunkLines.push(` ${d.text}`);
      oldCount++;
      newCount++;
    } else if (d.type === "remove") {
      hunkLines.push(`-${d.text}`);
      oldCount++;
    } else if (d.type === "add") {
      hunkLines.push(`+${d.text}`);
      newCount++;
    }
  }

  lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  lines.push(...hunkLines);
}

/**
 * Generate diff output for a drifted spec.
 * Returns the unified diff string, or null if not applicable.
 */
export function generateDiff(
  projectRoot: string,
  specId: string,
  specFilePath: string,
): string | null {
  const snapshotPath = path.join(projectRoot, IMPLEMENTED_DIR, `${specId}.md`);

  let snapshotBytes: string;
  try {
    snapshotBytes = Deno.readTextFileSync(snapshotPath);
  } catch {
    return null; // no snapshot — can't diff
  }

  const specBytes = Deno.readTextFileSync(
    path.join(projectRoot, specFilePath),
  );

  // Try canonical form
  let currentCanonical = toCanonicalForm(specBytes, specFilePath);
  if (currentCanonical === null) {
    // Fall back to raw bytes
    currentCanonical = specBytes;
  }

  return unifiedDiff(
    snapshotBytes,
    currentCanonical,
    `snapshot: ${specId}.md`,
    `current: ${specFilePath}`,
  );
}

// ─── Validate Command ───────────────────────────────────────────────────────

/**
 * Validate snapshots: find orphans and mismatches.
 */
export function validateSnapshots(projectRoot: string): SnapshotValidation {
  const specs = scanSpecs(projectRoot);
  const specIds = new Set(specs.map((s) => s.id));
  const snapshots = scanSnapshots(projectRoot);

  const orphans: OrphanSnapshot[] = [];
  const mismatches: MismatchedSnapshot[] = [];

  for (const { filenameId, relPath } of snapshots) {
    // Check for orphan
    if (!specIds.has(filenameId)) {
      orphans.push({ snapshotPath: relPath, id: filenameId });
    }

    // Check for id mismatch: parse the snapshot, compare its frontmatter id to filename
    const fullPath = path.join(projectRoot, relPath);
    try {
      const bytes = Deno.readTextFileSync(fullPath);
      const parsed = parse(bytes, relPath);
      if (isParsedSpec(parsed)) {
        const parsedId = parsed.frontmatter.id as string | undefined;
        if (parsedId && parsedId !== filenameId) {
          mismatches.push({
            snapshotPath: relPath,
            filenameId,
            parsedId: String(parsedId),
          });
        }
      }
    } catch {
      // Can't read/parse snapshot — skip mismatch check
    }
  }

  return { orphans, mismatches };
}

/**
 * Format validation results for CLI output.
 * Returns [lines, hasErrors].
 */
export function formatValidation(result: SnapshotValidation): [string[], boolean] {
  const lines: string[] = [];
  let hasErrors = false;

  for (const orphan of result.orphans) {
    lines.push(`orphan: ${orphan.snapshotPath} (no matching spec for ${orphan.id})`);
    hasErrors = true;
  }

  for (const mismatch of result.mismatches) {
    lines.push(
      `mismatch: ${mismatch.snapshotPath} (filename says ${mismatch.filenameId}, content says ${mismatch.parsedId})`
    );
    hasErrors = true;
  }

  return [lines, hasErrors];
}
