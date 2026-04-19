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

  default: {
    console.error(`error: unknown command '${command}'`);
    console.error("Run 'specman --help' for available commands.");
    Deno.exit(1);
  }
}
