/**
 * FEAT-0010: Root discovery
 *
 * Walks up the directory tree from CWD looking for a directory
 * containing both `specs/` and `.specman/` as subdirectories.
 * Used by every command except `init`.
 */

import * as path from "@std/path";

/**
 * Find the SpecMan project root by walking up from `startDir`.
 * Returns the root path, or null if none found.
 */
export function findProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (isProjectRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}

/**
 * Check if a directory is a SpecMan project root
 * (contains both `specs/` and `.specman/` as directories).
 */
function isProjectRoot(dir: string): boolean {
  return isDirectory(path.join(dir, "specs")) &&
         isDirectory(path.join(dir, ".specman"));
}

/**
 * Check if a path exists and is a directory.
 */
function isDirectory(p: string): boolean {
  try {
    const stat = Deno.statSync(p);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Resolve project root or exit with error.
 * For use by all commands except `init`.
 */
export function requireProjectRoot(startDir: string): string {
  const root = findProjectRoot(startDir);
  if (root === null) {
    console.error(
      `error: no SpecMan project found (walked up from ${startDir})`
    );
    Deno.exit(1);
  }
  return root;
}
