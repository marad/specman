/**
 * FEAT-0011: specman delete
 *
 * Removes everything SpecMan tracks for a given FEAT-ID:
 * spec file, snapshot, plan, and asset folder.
 * Atomic at the working-tree level — restores on partial failure.
 * Never commits or stages. Warns about dangling depends_on.
 */

import * as path from "@std/path";
import { walkSpecFiles } from "./specs.ts";
import { parse, isParsedSpec } from "./parser.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TrackedPathType = "spec" | "snapshot" | "plan" | "assets";

export interface RemovedEntry {
  relPath: string;
  type: TrackedPathType;
  fileCount?: number; // for assets directory
}

export interface DependentSpec {
  id: string;
  relPath: string;
}

export interface DeleteResult {
  removed: RemovedEntry[];
  absent: TrackedPathType[];
  dependents: DependentSpec[];
}

export interface DeleteError {
  reason: string;
}

export function isDeleteError(r: DeleteResult | DeleteError): r is DeleteError {
  return "reason" in r;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Delete all SpecMan-tracked artifacts for a FEAT-ID.
 *
 * Returns a DeleteResult on success (at least one path existed),
 * or a DeleteError if nothing was found or a filesystem error occurred.
 *
 * When dryRun is true, identifies what would be removed without touching disk.
 */
export function deleteSpec(
  projectRoot: string,
  featId: string,
  options?: { dryRun?: boolean },
): DeleteResult | DeleteError {
  const dryRun = options?.dryRun ?? false;

  // Normalize the ID
  const normalizedId = normalizeId(featId);
  if (normalizedId === null) {
    return { reason: `invalid ID format '${featId}' — expected FEAT-NNNN` };
  }

  // ── Discover tracked paths ────────────────────────────────────────────
  const specFile = findSpecFile(projectRoot, normalizedId);
  const snapshotPath = path.join(".specman", "implemented", `${normalizedId}.md`);
  const planPath = path.join(".specman", "plans", `${normalizedId}.md`);
  const assetsPath = path.join("specs", "assets", normalizedId);

  // Check existence
  const targets: Array<{ relPath: string; type: TrackedPathType; exists: boolean; isDir: boolean }> = [];

  if (specFile) {
    targets.push({ relPath: specFile, type: "spec", exists: true, isDir: false });
  } else {
    targets.push({ relPath: "(spec file)", type: "spec", exists: false, isDir: false });
  }

  targets.push({
    relPath: snapshotPath,
    type: "snapshot",
    exists: fileExists(path.join(projectRoot, snapshotPath)),
    isDir: false,
  });

  targets.push({
    relPath: planPath,
    type: "plan",
    exists: fileExists(path.join(projectRoot, planPath)),
    isDir: false,
  });

  const assetsFullPath = path.join(projectRoot, assetsPath);
  const assetsDirExists = dirExists(assetsFullPath);
  targets.push({
    relPath: assetsPath,
    type: "assets",
    exists: assetsDirExists,
    isDir: true,
  });

  // Check if at least one path exists
  const existingTargets = targets.filter(t => t.exists);
  if (existingTargets.length === 0) {
    return { reason: `no spec, snapshot, plan, or asset folder found for ${normalizedId}` };
  }

  // ── Find dependents (specs that reference this ID in depends_on) ──────
  const dependents = findDependents(projectRoot, normalizedId);

  // ── Dry run: report without modifying ─────────────────────────────────
  const removed: RemovedEntry[] = [];
  const absent: TrackedPathType[] = [];

  for (const t of targets) {
    if (t.exists) {
      const entry: RemovedEntry = { relPath: t.relPath, type: t.type };
      if (t.type === "assets") {
        entry.fileCount = countFiles(path.join(projectRoot, t.relPath));
      }
      removed.push(entry);
    } else {
      absent.push(t.type);
    }
  }

  if (dryRun) {
    return { removed, absent, dependents };
  }

  // ── Atomic removal with backup ────────────────────────────────────────
  const backupDir = Deno.makeTempDirSync({ prefix: "specman_delete_backup_" });
  const backedUp: Array<{ relPath: string; backupPath: string; isDir: boolean }> = [];

  try {
    // Phase 1: Backup existing files/dirs
    for (const t of existingTargets) {
      const fullPath = path.join(projectRoot, t.relPath);
      const backupPath = path.join(backupDir, t.relPath);

      // Ensure backup parent dir
      Deno.mkdirSync(path.dirname(backupPath), { recursive: true });

      if (t.isDir) {
        copyDirSync(fullPath, backupPath);
      } else {
        Deno.copyFileSync(fullPath, backupPath);
      }
      backedUp.push({ relPath: t.relPath, backupPath, isDir: t.isDir });
    }

    // Phase 2: Remove
    for (const t of existingTargets) {
      const fullPath = path.join(projectRoot, t.relPath);
      if (t.isDir) {
        Deno.removeSync(fullPath, { recursive: true });
      } else {
        Deno.removeSync(fullPath);
      }
    }

    // Success — clean up backup
    Deno.removeSync(backupDir, { recursive: true });

    return { removed, absent, dependents };
  } catch (e: unknown) {
    // Restore from backup
    for (const b of backedUp) {
      try {
        const fullPath = path.join(projectRoot, b.relPath);
        if (b.isDir) {
          // Remove partial if it exists
          try { Deno.removeSync(fullPath, { recursive: true }); } catch { /* ok */ }
          copyDirSync(b.backupPath, fullPath);
        } else {
          Deno.copyFileSync(b.backupPath, fullPath);
        }
      } catch {
        // Best effort restore
      }
    }

    // Clean up backup dir
    try { Deno.removeSync(backupDir, { recursive: true }); } catch { /* ok */ }

    const msg = e instanceof Error ? e.message : String(e);
    return { reason: `filesystem error during delete: ${msg}` };
  }
}

// ─── Output formatting ─────────────────────────────────────────────────────

/**
 * Format delete result for CLI output.
 * Returns lines to print.
 */
export function formatDeleteResult(
  result: DeleteResult,
  options?: { dryRun?: boolean },
): string[] {
  const lines: string[] = [];
  const dryRun = options?.dryRun ?? false;
  const prefix = dryRun ? "Would remove" : "Removed";

  for (const entry of result.removed) {
    if (entry.type === "assets") {
      const fileLabel = entry.fileCount === 1 ? "file" : "files";
      lines.push(`${prefix} ${entry.relPath}/ (${entry.fileCount} ${fileLabel})`);
    } else {
      lines.push(`${prefix} ${entry.relPath}`);
    }
  }

  // Summarize absent paths
  if (result.absent.length > 0) {
    const absentNames = result.absent.map(t => {
      switch (t) {
        case "spec": return "spec";
        case "snapshot": return "snapshot";
        case "plan": return "plan";
        case "assets": return "asset folder";
      }
    });

    const notPresent = dryRun ? "not present" : "not present";
    if (result.removed.length > 0) {
      // Some removed, some absent
      lines.push(`(no ${absentNames.join(", ")} to remove)`);
    }
  }

  // Dependent warnings
  for (const dep of result.dependents) {
    lines.push(
      `warning: ${dep.id} declares ${result.removed[0]?.relPath ? formatIdFromRemoved(result) : "this ID"} in depends_on — edit or remove that reference`,
    );
  }

  return lines;
}

function formatIdFromRemoved(result: DeleteResult): string {
  // Extract the FEAT ID from the first removed entry
  for (const entry of result.removed) {
    const match = entry.relPath.match(/(FEAT-\d+)/);
    if (match) return match[1];
  }
  return "the deleted spec";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a FEAT-ID to canonical zero-padded form.
 */
function normalizeId(id: string): string | null {
  const match = id.match(/^FEAT-(\d+)$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return `FEAT-${String(num).padStart(4, "0")}`;
}

/**
 * Find the spec file for a given ID.
 *
 * Strategy 1: filename pattern match via walkSpecFiles
 * Strategy 2: scan all .md under specs/ (excluding assets/) for id frontmatter
 */
function findSpecFile(projectRoot: string, featId: string): string | null {
  // Strategy 1: filename pattern match
  const specFiles = walkSpecFiles(projectRoot);
  const byFilename = specFiles.find(s => s.id === featId);
  if (byFilename) {
    return byFilename.relPath;
  }

  // Strategy 2: grep fallback — scan all .md files for id in frontmatter
  const specsDir = path.join(projectRoot, "specs");
  return scanForIdInFrontmatter(specsDir, specsDir, projectRoot, featId);
}

/**
 * Recursively scan .md files for a matching id frontmatter field.
 * Excludes specs/assets/.
 */
function scanForIdInFrontmatter(
  dir: string,
  specsRoot: string,
  projectRoot: string,
  targetId: string,
): string | null {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return null;
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
      const found = scanForIdInFrontmatter(
        path.join(dir, entry.name),
        specsRoot,
        projectRoot,
        targetId,
      );
      if (found) return found;
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      const fullPath = path.join(dir, entry.name);
      try {
        const bytes = Deno.readTextFileSync(fullPath);
        const parsed = parse(bytes, fullPath);
        if (isParsedSpec(parsed) && parsed.frontmatter.id === targetId) {
          return path.relative(projectRoot, fullPath);
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Find all specs that declare the given ID in their depends_on.
 */
function findDependents(projectRoot: string, featId: string): DependentSpec[] {
  const dependents: DependentSpec[] = [];
  const specFiles = walkSpecFiles(projectRoot);

  for (const entry of specFiles) {
    if (entry.id === featId) continue; // skip self

    const fullPath = path.join(projectRoot, entry.relPath);
    try {
      const bytes = Deno.readTextFileSync(fullPath);
      const parsed = parse(bytes, entry.relPath);
      if (
        isParsedSpec(parsed) &&
        Array.isArray(parsed.frontmatter.depends_on) &&
        parsed.frontmatter.depends_on.includes(featId)
      ) {
        dependents.push({ id: entry.id, relPath: entry.relPath });
      }
    } catch {
      continue;
    }
  }

  // Also check non-convention files via fallback scan
  const specsDir = path.join(projectRoot, "specs");
  const nonConventionDeps = scanDependentsInFrontmatter(
    specsDir,
    specsDir,
    projectRoot,
    featId,
    new Set(specFiles.map(s => s.relPath)),
  );
  dependents.push(...nonConventionDeps);

  dependents.sort((a, b) => a.id.localeCompare(b.id));
  return dependents;
}

/**
 * Scan non-convention .md files for depends_on references.
 */
function scanDependentsInFrontmatter(
  dir: string,
  specsRoot: string,
  projectRoot: string,
  targetId: string,
  alreadyChecked: Set<string>,
): DependentSpec[] {
  const dependents: DependentSpec[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return dependents;
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
      dependents.push(
        ...scanDependentsInFrontmatter(
          path.join(dir, entry.name),
          specsRoot,
          projectRoot,
          targetId,
          alreadyChecked,
        ),
      );
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(projectRoot, fullPath);
      if (alreadyChecked.has(relPath)) continue;

      try {
        const bytes = Deno.readTextFileSync(fullPath);
        const parsed = parse(bytes, fullPath);
        if (
          isParsedSpec(parsed) &&
          typeof parsed.frontmatter.id === "string" &&
          parsed.frontmatter.id !== targetId &&
          Array.isArray(parsed.frontmatter.depends_on) &&
          parsed.frontmatter.depends_on.includes(targetId)
        ) {
          dependents.push({ id: parsed.frontmatter.id, relPath });
        }
      } catch {
        continue;
      }
    }
  }

  return dependents;
}

/**
 * Count files recursively in a directory.
 */
function countFiles(dirPath: string): number {
  let count = 0;
  try {
    for (const entry of Deno.readDirSync(dirPath)) {
      if (entry.isFile) {
        count++;
      } else if (entry.isDirectory) {
        count += countFiles(path.join(dirPath, entry.name));
      }
    }
  } catch {
    // empty
  }
  return count;
}

/**
 * Copy a directory recursively.
 */
function copyDirSync(src: string, dest: string): void {
  Deno.mkdirSync(dest, { recursive: true });
  for (const entry of Deno.readDirSync(src)) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory) {
      copyDirSync(srcPath, destPath);
    } else {
      Deno.copyFileSync(srcPath, destPath);
    }
  }
}

function fileExists(p: string): boolean {
  try {
    const stat = Deno.statSync(p);
    return stat.isFile;
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    const stat = Deno.statSync(p);
    return stat.isDirectory;
  } catch {
    return false;
  }
}
