/**
 * SpecMan CLI entry point
 *
 * Dispatches to subcommands. Each command is a separate module
 * that receives the project root (or CWD for init).
 */

import { init, formatInitResult } from "./src/init.ts";
import { newSpec, isNewSpecError } from "./src/new.ts";
import { requireProjectRoot } from "./src/root.ts";
import {
  getStatus,
  formatStatus,
  validateSnapshots,
  formatValidation,
  generateDiff,
} from "./src/snapshot.ts";

const args = Deno.args;
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`specman — spec-driven development

Commands:
  init        Initialize SpecMan in the current directory
  new         Create a new spec scaffold
  status      Show drift status of all specs
  validate    Validate specs and snapshots
  
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
    const root = requireProjectRoot(Deno.cwd());
    const validation = validateSnapshots(root);
    const [valLines, hasErrors] = formatValidation(validation);

    if (valLines.length === 0) {
      console.log("All snapshots valid.");
    } else {
      for (const line of valLines) {
        console.error(line);
      }
    }

    Deno.exit(hasErrors ? 1 : 0);
  }

  default: {
    console.error(`error: unknown command '${command}'`);
    console.error("Run 'specman --help' for available commands.");
    Deno.exit(1);
  }
}
