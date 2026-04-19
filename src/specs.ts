/**
 * Shared spec-tree walking utility.
 *
 * Recursively finds all FEAT-NNNN-*.md files under specs/,
 * excluding specs/assets/. Used by new.ts (ID scan) and
 * snapshot.ts (drift scan).
 */

import * as path from "@std/path";

const FEAT_FILE_PATTERN = /^(FEAT-(\d+))-.*\.md$/;

export interface SpecFileEntry {
  id: string;        // normalized, e.g. "FEAT-0042"
  numericId: number; // e.g. 42
  filename: string;  // e.g. "FEAT-0042-reset.md"
  relPath: string;   // relative to projectRoot, e.g. "specs/cli/FEAT-0042-reset.md"
}

/**
 * Walk specs/ recursively, returning all FEAT-NNNN-*.md files.
 * Excludes specs/assets/. Sorted by ID.
 */
export function walkSpecFiles(projectRoot: string): SpecFileEntry[] {
  const specsDir = path.join(projectRoot, "specs");
  const results: SpecFileEntry[] = [];
  walkDir(specsDir, specsDir, projectRoot, results);
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

function walkDir(
  dir: string,
  specsRoot: string,
  projectRoot: string,
  results: SpecFileEntry[],
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
      if (
        relToSpecs === "assets" ||
        relToSpecs.startsWith("assets/") ||
        relToSpecs.startsWith("assets\\")
      ) {
        continue;
      }
      walkDir(path.join(dir, entry.name), specsRoot, projectRoot, results);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      const match = entry.name.match(FEAT_FILE_PATTERN);
      if (match) {
        const num = parseInt(match[2], 10);
        const id = `FEAT-${String(num).padStart(4, "0")}`;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(projectRoot, fullPath);
        results.push({ id, numericId: num, filename: entry.name, relPath });
      }
    }
  }
}
