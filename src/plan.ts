/**
 * FEAT-0009: Sync plan format
 *
 * Plan scaffold generation from drift analysis, plan parsing
 * (AC sections + verification commands), and scope checking.
 * SpecMan owns the scaffold; the agent owns the approach.
 */

import * as path from "@std/path";
import {
  parse,
  isParsedSpec,
  type ParsedSpec,
} from "./parser.ts";
import { readSnapshot } from "./snapshot.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Drift type for a single AC relative to its snapshot */
export type DriftType = "added" | "modified" | "removed";

/** A single entry in the drift set */
export interface DriftEntry {
  id: string;
  type: DriftType;
  text: string;
}

/** Options for generating a plan scaffold */
export interface GeneratePlanOptions {
  featId: string;
  title: string;
  snapshotState: "drifted" | "new";
  driftSet: DriftEntry[];
  timestamp?: string;
}

/** A parsed AC section from a plan file */
export interface AcSection {
  id: string;
  type: DriftType;
  text: string;
  body: string;
}

/** Successful plan parse result */
export interface ParsedPlan {
  featId: string;
  title: string;
  timestamp: string;
  snapshotState: string;
  driftSummary: string;
  acSections: AcSection[];
  crossCutting: string | null;
  verificationCommands: string[];
  raw: string;
}

/** Plan parse failure */
export interface PlanParseError {
  reason: string;
}

/** Result of a scope check */
export interface ScopeResult {
  valid: boolean;
  errors: string[];
}

// ─── Type guards ────────────────────────────────────────────────────────────

export function isParsedPlan(
  result: ParsedPlan | PlanParseError,
): result is ParsedPlan {
  return "featId" in result;
}

export function isPlanParseError(
  result: ParsedPlan | PlanParseError,
): result is PlanParseError {
  return "reason" in result;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PLANS_DIR = ".specman/plans";
const TITLE_RE = /^# Sync plan — (FEAT-\d+)\s+(.+)$/;
const AC_HEADING_RE = /^## AC-(\d+) \((added|modified|removed)\): (.+)$/;
const VERIFICATION_CMD_RE = /^- `([^`]+)`\s*$/;

// ─── Drift computation ─────────────────────────────────────────────────────

/**
 * Compute the drift set between a current spec and its snapshot.
 *
 * Returns entries sorted: added first, then modified, then removed.
 * If snapshotSpec is null (new spec), all ACs are marked as added.
 */
export function computeDriftSet(
  currentSpec: ParsedSpec,
  snapshotSpec: ParsedSpec | null,
): DriftEntry[] {
  const currentAcs = currentSpec.acceptance_criteria;

  if (snapshotSpec === null) {
    return currentAcs.map((ac) => ({
      id: ac.id,
      type: "added" as DriftType,
      text: ac.text,
    }));
  }

  const snapshotAcs = snapshotSpec.acceptance_criteria;
  const snapshotMap = new Map<string, string>();
  for (const ac of snapshotAcs) {
    snapshotMap.set(ac.id, ac.text);
  }

  const currentMap = new Map<string, string>();
  for (const ac of currentAcs) {
    currentMap.set(ac.id, ac.text);
  }

  const added: DriftEntry[] = [];
  const modified: DriftEntry[] = [];
  const removed: DriftEntry[] = [];

  for (const ac of currentAcs) {
    if (!snapshotMap.has(ac.id)) {
      added.push({ id: ac.id, type: "added", text: ac.text });
    } else if (snapshotMap.get(ac.id) !== ac.text) {
      modified.push({ id: ac.id, type: "modified", text: ac.text });
    }
  }

  for (const ac of snapshotAcs) {
    if (!currentMap.has(ac.id)) {
      removed.push({ id: ac.id, type: "removed", text: ac.text });
    }
  }

  return [...added, ...modified, ...removed];
}

// ─── Plan generation ────────────────────────────────────────────────────────

/**
 * Generate a plan scaffold from drift analysis.
 *
 * Deterministic and testable without an agent in the loop.
 * The agent later populates Approach, Files, and Verification.
 */
export function generatePlan(opts: GeneratePlanOptions): string {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const lines: string[] = [];

  lines.push(`# Sync plan — ${opts.featId} ${opts.title}`);
  lines.push("");
  lines.push(`Started: ${timestamp}`);
  lines.push(`Snapshot state: ${opts.snapshotState}`);
  lines.push(
    `Drift summary: ${formatDriftSummary(opts.driftSet, opts.snapshotState)}`,
  );

  for (const entry of opts.driftSet) {
    lines.push("");
    lines.push(`## ${entry.id} (${entry.type}): ${entry.text}`);
    lines.push("");

    if (entry.type === "modified") {
      lines.push("Change: <!-- describe what changed -->");
      lines.push("");
    }

    lines.push("Approach: <!-- agent fills in -->");
    lines.push("");
    lines.push("Files:");
    lines.push("<!-- agent fills in -->");
  }

  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push("<!-- agent fills in -->");
  lines.push("");

  return lines.join("\n");
}

// ─── Plan parsing ───────────────────────────────────────────────────────────

/**
 * Parse a plan file into a structured representation.
 *
 * Line-based structural parsing per the spec constraints.
 * AC sections, cross-cutting, and verification are extracted.
 */
export function parsePlan(content: string): ParsedPlan | PlanParseError {
  const lines = content.split("\n");

  // Find title line
  let titleLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("# ")) {
      titleLineIdx = i;
      break;
    }
  }

  if (titleLineIdx === -1) {
    return {
      reason: "missing title line: expected '# Sync plan — FEAT-XXXX ...'",
    };
  }

  const titleMatch = lines[titleLineIdx].match(TITLE_RE);
  if (!titleMatch) {
    return {
      reason: "malformed title line: expected '# Sync plan — FEAT-XXXX ...'",
    };
  }

  const featId = titleMatch[1];
  const title = titleMatch[2];

  // Extract metadata from lines after title
  let timestamp = "";
  let snapshotState = "";
  let driftSummary = "";

  for (let i = titleLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("Started: ")) {
      timestamp = line.slice("Started: ".length).trim();
    } else if (line.startsWith("Snapshot state: ")) {
      snapshotState = line.slice("Snapshot state: ".length).trim();
    } else if (line.startsWith("Drift summary: ")) {
      driftSummary = line.slice("Drift summary: ".length).trim();
    } else if (line.startsWith("## ")) {
      break;
    }
  }

  // Parse ## sections
  interface RawSection {
    heading: string;
    bodyLines: string[];
  }

  const rawSections: RawSection[] = [];
  let currentHeading: string | null = null;
  let currentBodyLines: string[] = [];

  for (let i = titleLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      if (currentHeading !== null) {
        rawSections.push({
          heading: currentHeading,
          bodyLines: currentBodyLines,
        });
      }
      currentHeading = line;
      currentBodyLines = [];
    } else if (currentHeading !== null) {
      currentBodyLines.push(line);
    }
  }
  if (currentHeading !== null) {
    rawSections.push({
      heading: currentHeading,
      bodyLines: currentBodyLines,
    });
  }

  // Process each section
  const acSections: AcSection[] = [];
  let crossCutting: string | null = null;
  const verificationCommands: string[] = [];

  for (const section of rawSections) {
    const acMatch = section.heading.match(AC_HEADING_RE);
    if (acMatch) {
      const acN = acMatch[1];
      const acType = acMatch[2] as DriftType;
      const acText = acMatch[3];
      const body = trimBody(section.bodyLines);
      acSections.push({
        id: `AC-${acN}`,
        type: acType,
        text: acText,
        body,
      });
    } else if (section.heading === "## Cross-cutting") {
      const body = trimBody(section.bodyLines);
      crossCutting = body || null;
    } else if (section.heading === "## Verification") {
      for (const line of section.bodyLines) {
        const cmdMatch = line.match(VERIFICATION_CMD_RE);
        if (cmdMatch) {
          verificationCommands.push(cmdMatch[1]);
        }
      }
    }
  }

  return {
    featId,
    title,
    timestamp,
    snapshotState,
    driftSummary,
    acSections,
    crossCutting,
    verificationCommands,
    raw: content,
  };
}

/** Trim leading and trailing blank lines from section body lines. */
function trimBody(lines: string[]): string {
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start++;
  }
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === "") {
    end--;
  }

  if (start >= end) return "";
  return lines.slice(start, end).join("\n");
}

// ─── Scope checking ────────────────────────────────────────────────────────

/**
 * Check that the plan's AC sections match the drift set exactly.
 *
 * Scope is purely structural: the set of (AC-ID, type) pairs must match.
 * Content inside sections is the user's responsibility.
 */
export function checkScope(
  parsed: ParsedPlan,
  driftSet: DriftEntry[],
): ScopeResult {
  const errors: string[] = [];

  const planAcs = new Map<string, DriftType>();
  for (const section of parsed.acSections) {
    planAcs.set(section.id, section.type);
  }

  const driftAcs = new Map<string, DriftType>();
  for (const entry of driftSet) {
    driftAcs.set(entry.id, entry.type);
  }

  // Extra ACs in plan (not in drift set)
  for (const [id, type] of planAcs) {
    if (!driftAcs.has(id)) {
      errors.push(`${id} is not in the drift set`);
    } else if (driftAcs.get(id) !== type) {
      errors.push(
        `${id} type mismatch: plan says ${type}, drift set says ${driftAcs.get(id)}`,
      );
    }
  }

  // Missing ACs in plan (in drift set but not in plan)
  for (const [id, _type] of driftAcs) {
    if (!planAcs.has(id)) {
      errors.push(`${id} is in the drift set but missing from the plan`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check that the plan has at least one runnable verification command.
 *
 * Returns null if OK, or an error message string.
 */
export function checkVerificationNonEmpty(parsed: ParsedPlan): string | null {
  if (parsed.verificationCommands.length === 0) {
    return (
      "plan has zero runnable commands in ## Verification — " +
      "add at least one command (e.g. `deno test`) or abort"
    );
  }
  return null;
}

// ─── File operations ────────────────────────────────────────────────────────

/**
 * Write a plan file to .specman/plans/<FEAT-ID>.md.
 * Creates the plans directory if it does not exist.
 */
export function writePlan(
  root: string,
  featId: string,
  content: string,
): void {
  const dir = path.join(root, PLANS_DIR);
  Deno.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${featId}.md`);
  Deno.writeTextFileSync(filePath, content);
}

/**
 * Read a plan file. Returns null if not found.
 */
export function readPlan(root: string, featId: string): string | null {
  const filePath = path.join(root, PLANS_DIR, `${featId}.md`);
  try {
    return Deno.readTextFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Check whether a plan file exists on disk.
 */
export function planExists(root: string, featId: string): boolean {
  const filePath = path.join(root, PLANS_DIR, `${featId}.md`);
  try {
    Deno.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Drift set loading ─────────────────────────────────────────────────────

/**
 * Load the drift set for a spec by reading both the current spec and
 * its snapshot, parsing both, and computing the diff.
 *
 * Returns the drift set and the parsed snapshot (null for new specs),
 * or an error string if parsing fails.
 */
export function loadDriftSet(
  root: string,
  featId: string,
  specRelPath: string,
  status: "new" | "drifted",
): { driftSet: DriftEntry[]; snapshotSpec: ParsedSpec | null } | { error: string } {
  // Parse current spec
  const specFullPath = path.join(root, specRelPath);
  let specBytes: string;
  try {
    specBytes = Deno.readTextFileSync(specFullPath);
  } catch (e) {
    return { error: `failed to read spec: ${e}` };
  }

  const currentParsed = parse(specBytes, specRelPath);
  if (!isParsedSpec(currentParsed)) {
    return { error: `failed to parse current spec: ${currentParsed.reason}` };
  }

  // For new specs, no snapshot
  if (status === "new") {
    const driftSet = computeDriftSet(currentParsed, null);
    return { driftSet, snapshotSpec: null };
  }

  // For drifted specs, read and parse the snapshot
  const snapshotBytes = readSnapshot(root, featId);
  if (snapshotBytes === null) {
    // Treat as new if snapshot is missing
    const driftSet = computeDriftSet(currentParsed, null);
    return { driftSet, snapshotSpec: null };
  }

  const snapshotParsed = parse(snapshotBytes, `<snapshot:${featId}>`);
  if (!isParsedSpec(snapshotParsed)) {
    return {
      error: `failed to parse snapshot: ${snapshotParsed.reason}`,
    };
  }

  const driftSet = computeDriftSet(currentParsed, snapshotParsed);
  return { driftSet, snapshotSpec: snapshotParsed };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a one-line drift summary.
 *
 * New specs: "N added (whole spec)"
 * Drifted specs: "N added, N modified, N removed"
 */
export function formatDriftSummary(
  driftSet: DriftEntry[],
  snapshotState: "new" | "drifted",
): string {
  if (snapshotState === "new") {
    return `${driftSet.length} added (whole spec)`;
  }

  const added = driftSet.filter((e) => e.type === "added").length;
  const modified = driftSet.filter((e) => e.type === "modified").length;
  const removed = driftSet.filter((e) => e.type === "removed").length;

  return `${added} added, ${modified} modified, ${removed} removed`;
}

/**
 * Format a scope-change error for CLI output.
 * Names the specific AC-ID mismatches and points to remediation.
 */
export function formatScopeError(
  result: ScopeResult,
  featId: string,
): string[] {
  const lines: string[] = [];
  lines.push("error: plan scope changed since scaffold");
  for (const error of result.errors) {
    lines.push(`  ${error}`);
  }
  lines.push(
    `  Remove or fix the scope changes, or abort and re-run: specman sync ${featId}`,
  );
  return lines;
}

/**
 * Format the empty-verification error for CLI output.
 */
export function formatVerificationEmptyError(): string[] {
  return [
    "error: plan has zero runnable commands in ## Verification",
    "  Add at least one backtick-delimited command (e.g. - `deno test`), or abort.",
  ];
}
