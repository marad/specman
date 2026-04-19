/**
 * FEAT-0006: Spec parser and serializer
 *
 * Single canonical translation between spec files on disk and structured
 * in-memory values. Every other SpecMan component calls into this module.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single acceptance criterion extracted from ## Acceptance criteria */
export interface AcceptanceCriterion {
  id: string;    // e.g. "AC-1"
  text: string;  // everything after the first ":"
}

/** A body section: heading text and raw body content */
export interface Section {
  heading: string; // e.g. "Intent", "Acceptance criteria"
  body: string;    // raw markdown body, may be empty
}

/** Successful parse result */
export interface ParsedSpec {
  frontmatter: Record<string, unknown>;
  sections: Section[];
  acceptance_criteria: AcceptanceCriterion[];
}

/** Parse failure */
export interface ParseError {
  path: string;
  line: number;
  column?: number;
  reason: string;
}

/** Serialization failure (programmer error, not user error) */
export interface SerializeError {
  field: string;
  reason: string;
}

// ─── Type guards ────────────────────────────────────────────────────────────

export function isParsedSpec(result: ParsedSpec | ParseError): result is ParsedSpec {
  return "frontmatter" in result;
}

export function isParseError(result: ParsedSpec | ParseError): result is ParseError {
  return "reason" in result && "path" in result;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

const FRONTMATTER_OPEN = /^---\s*$/;
const FRONTMATTER_CLOSE = /^---\s*$/;
const SECTION_HEADING = /^##\s+(.+)$/;
const AC_PATTERN = /^-\s+(AC-(\d+))\b[^:]*:\s?(.*)/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;

/** Check if a line opens or closes a fenced code block. Returns fence marker or null. */
function fenceToggle(line: string, currentFence: string | null): string | null {
  if (currentFence !== null) {
    // Inside a fence — check for closing fence (same or longer, same char)
    const char = currentFence[0];
    const re = new RegExp(`^${char}{${currentFence.length},}\\s*$`);
    if (re.test(line)) return null; // closed
    return currentFence; // still inside
  }
  const m = line.match(FENCE_OPEN);
  if (m) return m[1]; // opened
  return null; // not inside
}

/**
 * Parse a spec file into a structured representation.
 *
 * Pure and deterministic. Same input bytes → same result.
 * Fails only on structural problems (malformed YAML, no frontmatter).
 * Policy violations (missing fields, wrong types) pass through for the validator.
 */
export function parse(bytes: string, filePath: string): ParsedSpec | ParseError {
  const lines = bytes.split("\n");

  // ── Find frontmatter ──────────────────────────────────────────────────
  // First line must be ---
  if (lines.length === 0 || !FRONTMATTER_OPEN.test(lines[0])) {
    return { path: filePath, line: 1, reason: "missing frontmatter: expected opening '---'" };
  }

  let fmEndLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_CLOSE.test(lines[i])) {
      fmEndLine = i;
      break;
    }
  }

  if (fmEndLine === -1) {
    return { path: filePath, line: 1, reason: "unterminated frontmatter: no closing '---' found" };
  }

  const fmLines = lines.slice(1, fmEndLine);
  const fmRaw = fmLines.join("\n");

  // ── Parse YAML ────────────────────────────────────────────────────────
  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(fmRaw);
    if (parsed === null || parsed === undefined) {
      frontmatter = {};
    } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        path: filePath,
        line: 2,
        reason: `malformed YAML: frontmatter must be a mapping, got ${Array.isArray(parsed) ? "sequence" : typeof parsed}`,
      };
    } else {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (e: unknown) {
    // Try to extract line number from YAML error
    let yamlLine = 2; // default to start of frontmatter
    const msg = e instanceof Error ? e.message : String(e);
    const lineMatch = msg.match(/line (\d+)/i);
    if (lineMatch) {
      yamlLine = 1 + parseInt(lineMatch[1], 10); // offset by opening ---
    }
    return {
      path: filePath,
      line: yamlLine,
      reason: `malformed YAML: ${msg}`,
    };
  }

  // ── Parse body into sections ──────────────────────────────────────────
  const bodyLines = lines.slice(fmEndLine + 1);
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentBodyLines: string[] = [];
  let fence: string | null = null;

  for (const line of bodyLines) {
    fence = fenceToggle(line, fence);
    const headingMatch = fence === null ? line.match(SECTION_HEADING) : null;
    if (headingMatch) {
      if (currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          body: trimSectionBody(currentBodyLines),
        });
      }
      currentHeading = headingMatch[1];
      currentBodyLines = [];
    } else if (currentHeading !== null) {
      currentBodyLines.push(line);
    }
    // Lines before any heading are ignored (typically blank lines after frontmatter)
  }

  // Push final section
  if (currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      body: trimSectionBody(currentBodyLines),
    });
  }

  // ── Extract acceptance criteria ───────────────────────────────────────
  const acceptance_criteria: AcceptanceCriterion[] = [];
  const acSection = sections.find(
    (s) => s.heading.toLowerCase() === "acceptance criteria"
  );
  if (acSection) {
    // Process each line looking for AC bullets, supporting multi-line ACs
    const acLines = acSection.body.split("\n");
    let currentAcId: string | null = null;
    let currentAcText: string[] = [];

    for (const line of acLines) {
      const acMatch = line.match(AC_PATTERN);
      if (acMatch) {
        // Save previous AC if any
        if (currentAcId !== null) {
          acceptance_criteria.push({
            id: currentAcId,
            text: currentAcText.join("\n").trim(),
          });
        }
        currentAcId = acMatch[1]; // "AC-1"
        currentAcText = [acMatch[3]]; // text after the colon
      } else if (currentAcId !== null && line.match(/^\s+\S/)) {
        // Continuation line (indented) for multi-line AC
        currentAcText.push(line);
      } else if (currentAcId !== null) {
        // Non-continuation line — save current AC
        acceptance_criteria.push({
          id: currentAcId,
          text: currentAcText.join("\n").trim(),
        });
        currentAcId = null;
        currentAcText = [];
      }
    }

    // Push final AC
    if (currentAcId !== null) {
      acceptance_criteria.push({
        id: currentAcId,
        text: currentAcText.join("\n").trim(),
      });
    }
  }

  return { frontmatter, sections, acceptance_criteria };
}

/**
 * Trim the leading blank line (from ## Heading\n\n convention)
 * and trailing blank lines from a section body, then ensure
 * the body ends with a single newline if non-empty.
 */
function trimSectionBody(lines: string[]): string {
  // Remove leading blank lines
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start++;
  }
  // Remove trailing blank lines
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === "") {
    end--;
  }

  if (start >= end) return "";

  return lines.slice(start, end).join("\n") + "\n";
}

// ─── Serializer ─────────────────────────────────────────────────────────────

/** Canonical frontmatter key order */
const CANONICAL_KEY_ORDER = ["id", "title", "status", "platforms", "depends_on"];

/** Max line length before switching to block style for lists */
const FLOW_STYLE_MAX_LENGTH = 80;

/**
 * Serialize a ParsedSpec into canonical byte representation.
 *
 * Pure and deterministic. Same ParsedSpec → same bytes.
 * Never fails on a ParsedSpec produced by parse().
 */
export function serialize(spec: ParsedSpec): string | SerializeError {
  const parts: string[] = [];

  // ── Frontmatter ───────────────────────────────────────────────────────
  parts.push("---");

  const fmResult = serializeFrontmatter(spec.frontmatter);
  if (typeof fmResult !== "string") return fmResult;
  parts.push(fmResult);

  parts.push("---");

  // ── Sections ──────────────────────────────────────────────────────────
  for (const section of spec.sections) {
    parts.push(""); // blank line before heading
    parts.push(`## ${section.heading}`);
    parts.push(""); // blank line after heading
    if (section.body) {
      // Body already ends with \n from parser; strip trailing \n
      // since we join with \n and add final \n
      const body = section.body.endsWith("\n")
        ? section.body.slice(0, -1)
        : section.body;
      parts.push(body);
    }
  }

  parts.push(""); // final trailing newline
  return parts.join("\n");
}

/**
 * Serialize frontmatter map to YAML lines (without --- delimiters).
 * Produces canonical key order and formatting.
 */
function serializeFrontmatter(
  fm: Record<string, unknown>
): string | SerializeError {
  const lines: string[] = [];

  // Emit keys in canonical order first, then any extra keys alphabetically
  const emitted = new Set<string>();

  for (const key of CANONICAL_KEY_ORDER) {
    if (key in fm) {
      const result = serializeFrontmatterField(key, fm[key]);
      if (typeof result !== "string") return result;
      lines.push(result);
      emitted.add(key);
    }
  }

  // Extra keys in alphabetical order
  const extraKeys = Object.keys(fm)
    .filter((k) => !emitted.has(k))
    .sort();
  for (const key of extraKeys) {
    const result = serializeFrontmatterField(key, fm[key]);
    if (typeof result !== "string") return result;
    lines.push(result);
  }

  return lines.join("\n");
}

/**
 * Serialize a single frontmatter key: value pair.
 */
function serializeFrontmatterField(
  key: string,
  value: unknown
): string | SerializeError {
  if (value === null || value === undefined) {
    return `${key}:`;
  }

  if (typeof value === "string") {
    return `${key}: ${yamlQuoteString(value)}`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `${key}: ${value}`;
  }

  if (Array.isArray(value)) {
    return serializeListField(key, value);
  }

  if (typeof value === "object") {
    return {
      field: key,
      reason: `unsupported YAML type: object/mapping for frontmatter field '${key}'`,
    };
  }

  return {
    field: key,
    reason: `unsupported type '${typeof value}' for frontmatter field '${key}'`,
  };
}

/**
 * Serialize a list field, choosing flow or block style based on line length.
 */
function serializeListField(
  key: string,
  items: unknown[]
): string | SerializeError {
  // Check each item is a scalar
  for (const item of items) {
    if (item !== null && typeof item === "object") {
      return {
        field: key,
        reason: `unsupported nested object in list for field '${key}'`,
      };
    }
  }

  // Try flow style first
  const flowItems = items.map((item) => {
    if (typeof item === "string") return yamlQuoteString(item);
    if (item === null || item === undefined) return "null";
    return String(item);
  });
  const flowLine = `${key}: [${flowItems.join(", ")}]`;

  if (flowLine.length <= FLOW_STYLE_MAX_LENGTH) {
    return flowLine;
  }

  // Block style
  const blockLines = [
    `${key}:`,
    ...flowItems.map((item) => `  - ${item}`),
  ];
  return blockLines.join("\n");
}

/**
 * Quote a YAML string only when necessary.
 * Unquoted when safe; double-quoted otherwise.
 */
function yamlQuoteString(s: string): string {
  if (s === "") return '""';
  if (s === "true" || s === "false" || s === "null") return `"${s}"`;
  if (s === "yes" || s === "no" || s === "on" || s === "off") return `"${s}"`;
  // If it looks like a number, quote it
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return `"${s}"`;
  // If it starts with special chars or contains : followed by space, or other YAML special chars
  if (/^[&*!|>%@`{[\],#?'"-]/.test(s)) return `"${yamlEscape(s)}"`;
  if (/[:{}\[\],#&*!|>'"%@`]/.test(s)) return `"${yamlEscape(s)}"`;
  // Contains newlines
  if (/[\n\r]/.test(s)) return `"${yamlEscape(s)}"`;
  return s;
}

/**
 * Escape special characters for YAML double-quoted strings.
 */
function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
