/**
 * SpecMan CLI entry point
 *
 * Dispatches to subcommands. Each command is a separate module
 * that receives the project root (or CWD for init).
 */

import { init, formatInitResult } from "./src/init.ts";
import { requireProjectRoot } from "./src/root.ts";

const args = Deno.args;
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`specman — spec-driven development

Commands:
  init        Initialize SpecMan in the current directory
  
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

  default: {
    console.error(`error: unknown command '${command}'`);
    console.error("Run 'specman --help' for available commands.");
    Deno.exit(1);
  }
}
