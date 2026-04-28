/**
 * SpecMan CLI entry point
 *
 * Dispatches to subcommands. Each command is a separate module
 * that receives the project root (or CWD for init).
 */

import { init, formatInitResult } from "./src/init.ts";
import { deleteSpec, isDeleteError, formatDeleteResult } from "./src/delete.ts";
import { newSpec, isNewSpecError } from "./src/new.ts";
import { requireProjectRoot } from "./src/root.ts";
import {
  getStatus,
  formatStatus,
  validateSnapshots,
  formatValidation,
  generateDiff,
} from "./src/snapshot.ts";
import {
  syncOne,
  syncAll,
  seal,
  checkWorkingTree,
  formatSyncResult,
  formatSyncAllResult,
  formatSealResult,
  dryRunReport,
  formatDryRunReport,
} from "./src/sync.ts";
import { detectDrift } from "./src/snapshot.ts";
import { walkSpecFiles } from "./src/specs.ts";
import {
  validate,
  formatHuman,
  formatJson,
  exitCode,
  type ValidateOptions,
} from "./src/validate.ts";

const args = Deno.args;
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`specman — spec-driven development

Commands:
  init        Initialize SpecMan in the current directory
  new         Create a new spec scaffold
  status      Show drift status of all specs
  validate    Validate specs and snapshots
  delete      Remove a spec and all its tracked artifacts
  sync        Sync drifted specs (generate plans, run verification)
  seal        Seal editorial changes (no AC drift)
  
Run 'specman <command> --help' for details.`);
  Deno.exit(0);
}

switch (command) {
  case "init": {
    const result = init(Deno.cwd());
    const [lines, exitCode] = formatInitResult(result);
    for (const line of lines) {
      if (line.startsWith("error:")) {
        console.error(line);
      } else {
        console.log(line);
      }
    }
    Deno.exit(exitCode);
  }

  case "new": {
    const root = requireProjectRoot(Deno.cwd());
    // Parse args: specman new "<title>" [--group <name>] [--id FEAT-NNNN]
    const newArgs = args.slice(1);
    let title: string | undefined;
    let group: string | undefined;
    let id: string | undefined;

    for (let i = 0; i < newArgs.length; i++) {
      if (newArgs[i] === "--group" && i + 1 < newArgs.length) {
        group = newArgs[++i];
      } else if (newArgs[i] === "--id" && i + 1 < newArgs.length) {
        id = newArgs[++i];
      } else if (!title) {
        title = newArgs[i];
      }
    }

    if (!title) {
      console.error('error: missing title. Usage: specman new "<title>" [--group <name>] [--id FEAT-NNNN]');
      Deno.exit(1);
    }

    const result = newSpec({ title, projectRoot: root, group, id });
    if (isNewSpecError(result)) {
      console.error(`error: ${result.reason}`);
      Deno.exit(1);
    }
    console.log(result.path);
    Deno.exit(0);
  }

  case "status": {
    const root = requireProjectRoot(Deno.cwd());
    const statusArgs = args.slice(1);
    const verbose = statusArgs.includes("--verbose") || statusArgs.includes("-v");
    const showDiff = statusArgs.includes("--diff");

    const result = getStatus(root);
    const lines = formatStatus(result, { verbose, diff: showDiff });
    for (const line of lines) {
      console.log(line);
    }

    // Show diffs for drifted specs if --diff
    if (showDiff) {
      for (const entry of result.entries) {
        if (entry.status === "drifted") {
          const diff = generateDiff(root, entry.id, entry.specPath);
          if (diff) {
            console.log("");
            console.log(`--- ${entry.id} diff ---`);
            console.log(diff);
          }
        }
      }
    }

    Deno.exit(0);
  }

  case "validate": {
    const valArgs = args.slice(1);
    const valOpts: ValidateOptions = {
      format: valArgs.includes("--format=json") ? "json" : "human",
      strict: valArgs.includes("--strict"),
    };

    // Check if specs/ exists before requiring full project root
    const specsExists = (() => {
      try {
        return Deno.statSync("specs").isDirectory;
      } catch {
        return false;
      }
    })();

    if (!specsExists) {
      // AC-11: no specs/ folder
      if (valOpts.format === "json") {
        console.log(JSON.stringify({
          summary: { specs_checked: 0, errors: 0, warnings: 0 },
          findings: [],
          error: "no specs/ directory found",
        }, null, 2));
      } else {
        console.error("error: no specs/ directory found. Run 'specman init' first.");
      }
      Deno.exit(2);
    }

    // Use CWD as project root for validate (it must have specs/)
    const valRoot = Deno.cwd();
    const result = validate(valRoot);

    if (result.specsChecked === -1) {
      // specs/ doesn't exist (shouldn't reach here, but safety)
      console.error("error: no specs/ directory found. Run 'specman init' first.");
      Deno.exit(2);
    }

    if (valOpts.format === "json") {
      console.log(formatJson(result));
    } else {
      const lines = formatHuman(result);
      for (const line of lines) {
        console.log(line);
      }
    }

    Deno.exit(exitCode(result, valOpts));
  }

  case "delete": {
    // Handle --help before requiring project root
    if (args.slice(1).includes("--help") || args.slice(1).includes("-h")) {
      console.log(`Usage: specman delete <FEAT-ID> [--dry-run]

Remove a spec and all its tracked artifacts:
  - spec file (specs/**/<FEAT-ID>-*.md)
  - snapshot (.specman/implemented/<FEAT-ID>.md)
  - plan (.specman/plans/<FEAT-ID>.md)
  - assets folder (specs/assets/<FEAT-ID>/)

Options:
  --dry-run   Show what would be removed without deleting`);
      Deno.exit(0);
    }

    const root = requireProjectRoot(Deno.cwd());
    const delArgs = args.slice(1);
    let featId: string | undefined;
    let dryRun = false;

    for (let i = 0; i < delArgs.length; i++) {
      if (delArgs[i] === "--dry-run") {
        dryRun = true;
      } else if (!featId) {
        featId = delArgs[i];
      }
    }

    if (!featId) {
      console.error("error: missing FEAT-ID. Usage: specman delete <FEAT-ID> [--dry-run]");
      Deno.exit(1);
    }

    const result = deleteSpec(root, featId, { dryRun });
    if (isDeleteError(result)) {
      console.error(`error: ${result.reason}`);
      Deno.exit(1);
    }

    const lines = formatDeleteResult(result, { dryRun });
    for (const line of lines) {
      if (line.startsWith("warning:")) {
        console.error(line);
      } else {
        console.log(line);
      }
    }
    Deno.exit(0);
  }

  case "sync": {
    // Handle --help before requiring project root
    const syncArgs = args.slice(1);
    if (syncArgs.includes("--help") || syncArgs.includes("-h")) {
      console.log(`Usage: specman sync [FEAT-ID] [--dry-run]

Sync drifted specs by generating implementation plans.

With FEAT-ID: sync a single spec.
Without: sync all drifted/new specs in dependency order.

Options:
  --dry-run   List specs that would be synced with their drift counts.
              Writes no plan files. Read-only.
  --help      Show this help`);
      Deno.exit(0);
    }

    const root = requireProjectRoot(Deno.cwd());

    const dryRun = syncArgs.includes("--dry-run");
    const featId = syncArgs.find((a) => a.startsWith("FEAT-"));

    if (dryRun) {
      // AC-24, AC-25: read-only report, no plan files written
      const report = dryRunReport(root, featId);
      const lines = formatDryRunReport(report);
      for (const line of lines) {
        console.log(line);
      }
      Deno.exit(0);
    }

    if (featId) {
      // Single spec sync (AC-14)
      const planPath = `.specman/plans/${featId}.md`;
      const disallowed = checkWorkingTree(root, [planPath]);
      if (disallowed !== null) {
        console.error("error: working tree has uncommitted changes:");
        for (const p of disallowed) {
          console.error(`  ${p}`);
        }
        console.error("Commit or stash changes before running sync.");
        Deno.exit(1);
      }

      // Find spec file
      const specFiles = walkSpecFiles(root);
      const specEntry = specFiles.find((s) => s.id === featId);
      if (!specEntry) {
        console.error(`error: no spec found for ${featId}`);
        Deno.exit(1);
      }

      const status = detectDrift(root, featId, specEntry.relPath);
      const result = syncOne(root, featId, specEntry.relPath, status);
      const lines = formatSyncResult(result);
      for (const line of lines) {
        if (line.startsWith("error:")) {
          console.error(line);
        } else {
          console.log(line);
        }
      }
      Deno.exit(result.outcome === "error" ? 1 : 0);
    } else {
      // Multi-spec sync (AC-7, AC-15)
      const disallowed = checkWorkingTree(root, []);
      // Allow plan files in .specman/plans/
      const filtered = disallowed?.filter(
        (p) => !p.startsWith(".specman/plans/")
      ) ?? null;
      if (filtered !== null && filtered.length > 0) {
        console.error("error: working tree has uncommitted changes:");
        for (const p of filtered) {
          console.error(`  ${p}`);
        }
        console.error("Commit or stash changes before running sync.");
        Deno.exit(1);
      }

      const result = syncAll(root);
      const lines = formatSyncAllResult(result);
      for (const line of lines) {
        if (line.startsWith("error:")) {
          console.error(line);
        } else {
          console.log(line);
        }
      }

      const hasFailures = result.results.some(
        (r) => r.outcome === "error" || r.outcome === "verification-failed" ||
               r.outcome === "trailer-check-failed"
      );
      Deno.exit(hasFailures ? 1 : 0);
    }
    break;
  }

  case "seal": {
    // Handle --help before requiring project root
    if (args.slice(1).includes("--help") || args.slice(1).includes("-h")) {
      console.log(`Usage: specman seal <FEAT-ID> [--initial]

Seal a snapshot.

Without --initial: updates the snapshot for a drifted spec without running
the agent. Requires the spec to be 'drifted' (not 'new' or 'in-sync'),
no acceptance criteria changes, and a clean working tree.

With --initial: creates the first snapshot for a 'new' spec whose
implementation was done outside of SpecMan (manual coding, migration
from another workflow, or initial project setup). Requires the spec to
be 'new' (no existing snapshot) and a clean working tree.

In both cases, a single commit is created updating the snapshot file.`);
      Deno.exit(0);
    }

    const root = requireProjectRoot(Deno.cwd());
    const sealArgs = args.slice(1);
    const sealInitial = sealArgs.includes("--initial");
    const sealFeatId = sealArgs.find((a) => a.startsWith("FEAT-"));

    if (!sealFeatId) {
      console.error("error: missing FEAT-ID. Usage: specman seal <FEAT-ID> [--initial]");
      Deno.exit(1);
    }

    const result = seal(root, sealFeatId, { initial: sealInitial });
    const lines = formatSealResult(result);
    for (const line of lines) {
      if (line.startsWith("error:")) {
        console.error(line);
      } else {
        console.log(line);
      }
    }
    Deno.exit(result.outcome === "error" ? 1 : 0);
  }

  default: {
    console.error(`error: unknown command '${command}'`);
    console.error("Run 'specman --help' for available commands.");
    Deno.exit(1);
  }
}
