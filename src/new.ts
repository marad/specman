/**
 * FEAT-0008: specman new
 *
 * Creates a new spec scaffold with auto-assigned ID, derived slug,
 * and canonical frontmatter. Non-interactive, deterministic.
 */

import * as path from "@std/path";
import { serialize, type ParsedSpec } from "./parser.ts";
import { walkSpecFiles } from "./specs.ts";

export interface NewSpecOptions {
  title: string;
  projectRoot: string;
  group?: string;
  id?: string;
}

export interface NewSpecResult {
  path: string;       // relative to projectRoot
  id: string;         // e.g. "FEAT-0008"
}

export interface NewSpecError {
  reason: string;
}

export function isNewSpecError(r: NewSpecResult | NewSpecError): r is NewSpecError {
  return "reason" in r;
}

/**
 * Create a new spec scaffold.
 *
 * - Scans specs/ recursively for existing FEAT-NNNN IDs
 * - Auto-assigns next ID (or uses --id if provided)
 * - Derives filename slug from title
 * - Writes minimal scaffold file
 */
export function newSpec(opts: NewSpecOptions): NewSpecResult | NewSpecError {
  // ── Scan existing IDs ─────────────────────────────────────────────────
  const specFiles = walkSpecFiles(opts.projectRoot);
  const existingIds = new Set(specFiles.map(s => s.id));

  // ── Resolve ID ────────────────────────────────────────────────────────
  let id: string;
  if (opts.id) {
    // Validate format
    if (!/^FEAT-\d+$/.test(opts.id)) {
      return { reason: `invalid ID format '${opts.id}' — expected FEAT-NNNN` };
    }
    // Normalize to 4-digit zero-padded form
    const num = parseInt(opts.id.match(/^FEAT-(\d+)$/)![1], 10);
    id = `FEAT-${String(num).padStart(4, "0")}`;
    // Check for collision (AC-5)
    if (existingIds.has(id)) {
      return { reason: `ID ${id} is already in use` };
    }
  } else {
    id = nextId(existingIds);
  }

  // ── Derive slug ───────────────────────────────────────────────────────
  const slug = deriveSlug(opts.title);
  if (slug === "") {
    return { reason: "title produces an empty slug — provide a title with at least one alphanumeric character" };
  }

  // ── Build path ────────────────────────────────────────────────────────
  const filename = `${id}-${slug}.md`;
  let relPath: string;
  if (opts.group) {
    relPath = path.join("specs", opts.group, filename);
    // Create group directory if absent
    const groupDir = path.join(opts.projectRoot, "specs", opts.group);
    try {
      Deno.mkdirSync(groupDir, { recursive: true });
    } catch (e: unknown) {
      return { reason: `failed to create group directory '${opts.group}': ${e}` };
    }
  } else {
    relPath = path.join("specs", filename);
  }

  // ── Build scaffold ────────────────────────────────────────────────────
  const spec: ParsedSpec = {
    frontmatter: {
      id,
      title: opts.title,
      status: "draft",
      depends_on: [],
    },
    sections: [
      { heading: "Intent", body: "" },
      { heading: "Acceptance criteria", body: "" },
    ],
    acceptance_criteria: [],
  };

  const bytes = serialize(spec);
  if (typeof bytes !== "string") {
    return { reason: `serialize error: ${bytes.reason}` };
  }

  // ── Write file ────────────────────────────────────────────────────────
  const fullPath = path.join(opts.projectRoot, relPath);
  try {
    Deno.writeTextFileSync(fullPath, bytes);
  } catch (e: unknown) {
    return { reason: `failed to write ${relPath}: ${e}` };
  }

  return { path: relPath, id };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the next FEAT-NNNN ID from existing IDs.
 */
function nextId(existingIds: Set<string>): string {
  if (existingIds.size === 0) return "FEAT-0001";

  let max = 0;
  for (const id of existingIds) {
    const match = id.match(/^FEAT-(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }

  return `FEAT-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Derive a URL-friendly slug from a title.
 * Lowercase, non-alphanumeric runs → single hyphen, no leading/trailing hyphens.
 */
export function deriveSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
