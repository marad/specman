/**
 * FEAT-0010: specman init
 *
 * Bootstrap SpecMan layout in the current directory.
 * Purely additive, idempotent, crash-safe.
 */

import * as path from "@std/path";

/** Directories that make up the SpecMan layout */
const LAYOUT_DIRS = [
  "specs",
  ".specman",
  ".specman/implemented",
  ".specman/plans",
] as const;

export interface InitResult {
  created: string[];
  alreadyPresent: string[];
  conflict: string | null;
  gitWarning: boolean;
}

/**
 * Initialize SpecMan layout in the given directory.
 *
 * - Creates missing directories
 * - Reports already-present directories
 * - Fails on path conflicts (file where directory expected)
 * - Warns if no .git present
 */
export function init(targetDir: string): InitResult {
  const created: string[] = [];
  const alreadyPresent: string[] = [];

  // Check for conflicts first (AC-4: exit without creating anything)
  for (const dir of LAYOUT_DIRS) {
    const fullPath = path.join(targetDir, dir);
    const status = pathStatus(fullPath);

    if (status === "conflict") {
      return {
        created: [],
        alreadyPresent: [],
        conflict: dir,
        gitWarning: false,
      };
    }
  }

  // Create missing directories
  for (const dir of LAYOUT_DIRS) {
    const fullPath = path.join(targetDir, dir);
    const status = pathStatus(fullPath);

    if (status === "directory") {
      alreadyPresent.push(dir);
    } else if (status === "absent") {
      Deno.mkdirSync(fullPath, { recursive: true });
      created.push(dir);
    }
  }

  // Check for .git
  const gitWarning = !isDirectory(path.join(targetDir, ".git"));

  return { created, alreadyPresent, conflict: null, gitWarning };
}

/**
 * Format init result for CLI output.
 * Returns [lines, exitCode].
 */
export function formatInitResult(result: InitResult): [string[], number] {
  const lines: string[] = [];

  if (result.conflict !== null) {
    lines.push(
      `error: ${result.conflict} exists but is a file, not a directory — refusing to overwrite`
    );
    return [lines, 1];
  }

  if (result.created.length === 0 && result.alreadyPresent.length > 0) {
    lines.push("Already initialized. Nothing to do.");
    return [lines, 0];
  }

  for (const dir of result.alreadyPresent) {
    lines.push(`Already present: ${dir}/`);
  }
  for (const dir of result.created) {
    lines.push(`Created ${dir}/`);
  }

  if (result.gitWarning) {
    lines.push(
      "warning: no .git directory found — specman sync and specman status require a git repository."
    );
  }

  lines.push('Next: specman new "<title>" to create your first spec.');

  return [lines, 0];
}

function pathStatus(p: string): "directory" | "conflict" | "absent" {
  try {
    const stat = Deno.statSync(p); // follows symlinks
    if (stat.isDirectory) return "directory";
    return "conflict"; // exists but not a directory
  } catch (e: unknown) {
    // statSync throws on broken symlinks and missing paths
    // Check if it's a broken symlink (lstat succeeds but stat fails)
    try {
      Deno.lstatSync(p);
      return "conflict"; // exists (broken symlink) but not a directory
    } catch {
      // truly absent
    }
    if (e instanceof Deno.errors.NotFound) return "absent";
    throw e;
  }
}

function isDirectory(p: string): boolean {
  try {
    const stat = Deno.statSync(p);
    return stat.isDirectory;
  } catch {
    return false;
  }
}
