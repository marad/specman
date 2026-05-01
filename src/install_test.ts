/**
 * Tests for FEAT-0013: Install command
 *
 * Each test maps to one or more acceptance criteria from
 * specs/FEAT-0013-install-command.md
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  AGENTS,
  type AgentId,
  installAgents,
  interactiveSelect,
  type Key,
  SUPPORTED_AGENT_IDS,
  type TemplateKind,
  uninstallAgents,
} from "../src/install.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "specman_install_test_" });
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function fileExists(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function readFile(p: string): string {
  return Deno.readTextFileSync(p);
}

const ALL_AGENTS = SUPPORTED_AGENT_IDS;
const TEMPLATE_KINDS: TemplateKind[] = ["skill", "spec", "spec-sync", "spec-status"];

// ─── AC-7: Project-scope install writes four artifacts per agent ─────────────

Deno.test("AC-7: project install writes 4 artifacts per agent at project paths", () => {
  withTempDir((dir) => {
    const result = installAgents(["claude-code"], { scope: "project", root: dir });
    assertEquals(result.error, null);
    assertEquals(result.written.length, 4);

    for (const kind of TEMPLATE_KINDS) {
      const expected = path.join(dir, AGENTS["claude-code"].projectPaths[kind]);
      assert(fileExists(expected), `expected file missing: ${expected}`);
      assert(result.written.includes(expected), `not in written list: ${expected}`);
    }
  });
});

Deno.test("AC-7: project install handles all three MVP agents", () => {
  withTempDir((dir) => {
    const result = installAgents(ALL_AGENTS, { scope: "project", root: dir });
    assertEquals(result.error, null);
    assertEquals(result.written.length, 12); // 3 agents × 4 artifacts

    for (const id of ALL_AGENTS) {
      for (const kind of TEMPLATE_KINDS) {
        const expected = path.join(dir, AGENTS[id].projectPaths[kind]);
        assert(fileExists(expected), `expected file missing: ${expected}`);
      }
    }
  });
});

// ─── AC-8: --global writes to home-rooted absolute paths ─────────────────────

Deno.test("AC-8: global install writes to home-rooted paths regardless of project context", () => {
  withTempDir((home) => {
    // No project dir — this simulates --global scope
    const result = installAgents(["claude-code"], { scope: "global", root: home });
    assertEquals(result.error, null);
    assertEquals(result.written.length, 4);

    const globalPaths = AGENTS["claude-code"].globalPaths(home);
    for (const kind of TEMPLATE_KINDS) {
      assert(fileExists(globalPaths[kind]), `expected file missing: ${globalPaths[kind]}`);
    }
  });
});

// ─── AC-9: re-install overwrites without prompting ───────────────────────────

Deno.test("AC-9: re-running install overwrites existing artifacts", () => {
  withTempDir((dir) => {
    // First install
    installAgents(["claude-code"], { scope: "project", root: dir });
    const skillPath = path.join(
      dir,
      AGENTS["claude-code"].projectPaths.skill,
    );

    // Tamper with the file
    Deno.writeTextFileSync(skillPath, "TAMPERED");
    assertEquals(readFile(skillPath), "TAMPERED");

    // Re-install
    const result = installAgents(["claude-code"], { scope: "project", root: dir });
    assertEquals(result.error, null);
    assert(readFile(skillPath) !== "TAMPERED", "file should have been overwritten");
    // Re-install includes the same paths in the written list
    assertEquals(result.written.length, 4);
  });
});

// ─── AC-10: uninstall removes installed artifacts ────────────────────────────

Deno.test("AC-10: uninstall removes the four artifacts and is silent on missing", () => {
  withTempDir((dir) => {
    installAgents(["claude-code"], { scope: "project", root: dir });

    const result = uninstallAgents(["claude-code"], { scope: "project", root: dir });
    assertEquals(result.removed.length, 4);

    for (const kind of TEMPLATE_KINDS) {
      const expected = path.join(dir, AGENTS["claude-code"].projectPaths[kind]);
      assert(!fileExists(expected), `file should have been removed: ${expected}`);
    }

    // Re-uninstall: missing files are not errors, removed list is empty
    const second = uninstallAgents(["claude-code"], { scope: "project", root: dir });
    assertEquals(second.removed.length, 0);
  });
});

// ─── AC-12: MVP agent matrix is exactly the three identifiers ────────────────

Deno.test("AC-12: SUPPORTED_AGENT_IDS contains exactly claude-code, opencode, copilot-cli in order", () => {
  assertEquals(SUPPORTED_AGENT_IDS, ["claude-code", "opencode", "copilot-cli"]);
});

// ─── AC-13: slash commands are self-sufficient (start with mental-model recap) ─

Deno.test("AC-13: each slash command template begins with a mental-model recap section", () => {
  withTempDir((dir) => {
    installAgents(["claude-code"], { scope: "project", root: dir });

    for (const kind of ["spec", "spec-sync", "spec-status"] as TemplateKind[]) {
      const filePath = path.join(dir, AGENTS["claude-code"].projectPaths[kind]);
      const content = readFile(filePath);
      // Each command body opens with a "Mental model recap" section so the
      // agent has the model even when the skill never loads.
      assert(
        content.includes("Mental model recap"),
        `${kind} template missing mental-model recap`,
      );
    }
  });
});

// ─── AC-14: skill content contains every required trigger term ───────────────

Deno.test("AC-14: installed skill contains all required trigger terms for every agent", () => {
  const triggers = ["spec", "specman", "acceptance criteria", "drift", "sync"];
  withTempDir((dir) => {
    installAgents(ALL_AGENTS, { scope: "project", root: dir });

    for (const id of ALL_AGENTS) {
      const skillPath = path.join(dir, AGENTS[id].projectPaths.skill);
      const content = readFile(skillPath);
      for (const term of triggers) {
        assert(
          content.includes(term),
          `agent ${id}: skill missing trigger term "${term}"`,
        );
      }
    }
  });
});

Deno.test("AC-14: skill artifact for skill-frontmatter agents includes a description field", () => {
  withTempDir((dir) => {
    installAgents(["claude-code", "opencode", "copilot-cli"], { scope: "project", root: dir });

    for (const id of ALL_AGENTS) {
      const skillPath = path.join(dir, AGENTS[id].projectPaths.skill);
      const content = readFile(skillPath);
      assert(
        content.startsWith("---\n") && content.includes("description:"),
        `agent ${id}: skill missing frontmatter description`,
      );
    }
  });
});

// ─── AC-15: partial failure leaves earlier writes in place ───────────────────

Deno.test("AC-15: partial install failure preserves earlier writes; no rollback", () => {
  withTempDir((dir) => {
    // Pre-create one of the target paths as a directory so writeTextFile fails
    // for the third file in the sequence (claude-code commands/spec.md).
    const blockerPath = path.join(dir, ".claude/commands/spec.md");
    Deno.mkdirSync(blockerPath, { recursive: true });

    const result = installAgents(["claude-code"], { scope: "project", root: dir });
    assert(result.error !== null, "expected install to fail");
    assertEquals(result.error?.path, blockerPath);

    // First two writes (skill + spec — wait, spec is the failing one)
    // The skill is the first write and should have succeeded.
    const skillPath = path.join(dir, AGENTS["claude-code"].projectPaths.skill);
    assert(fileExists(skillPath), "skill should have been written before failure");
    assert(result.written.includes(skillPath));

    // The blocker path itself was not written successfully.
    assert(!result.written.includes(blockerPath));
  });
});

// ─── interactiveSelect ───────────────────────────────────────────────────────

function keySequence(keys: Key[]): () => Key | null {
  let i = 0;
  return () => keys[i++] ?? null;
}

Deno.test("interactiveSelect: enter confirms full default selection", () => {
  const result = interactiveSelect(
    SUPPORTED_AGENT_IDS,
    keySequence(["enter"]),
    (_s) => {},
  );
  assertEquals(result, SUPPORTED_AGENT_IDS);
});

Deno.test("interactiveSelect: space toggles the cursor's agent off", () => {
  // Cursor starts at row 0 (claude-code); space toggles, enter confirms.
  const result = interactiveSelect(
    SUPPORTED_AGENT_IDS,
    keySequence(["space", "enter"]),
    (_s) => {},
  );
  assertEquals(result, ["opencode", "copilot-cli"]);
});

Deno.test("interactiveSelect: down arrow moves cursor before toggling", () => {
  // Down once → cursor on opencode; space toggles it off; enter confirms.
  const result = interactiveSelect(
    SUPPORTED_AGENT_IDS,
    keySequence(["down", "space", "enter"]),
    (_s) => {},
  );
  assertEquals(result, ["claude-code", "copilot-cli"]);
});

Deno.test("interactiveSelect: up arrow wraps from first to last row", () => {
  // Up from row 0 wraps to copilot-cli; toggle off; confirm.
  const result = interactiveSelect(
    SUPPORTED_AGENT_IDS,
    keySequence(["up", "space", "enter"]),
    (_s) => {},
  );
  assertEquals(result, ["claude-code", "opencode"]);
});

Deno.test("interactiveSelect: toggling same agent twice restores it", () => {
  const result = interactiveSelect(
    SUPPORTED_AGENT_IDS,
    keySequence(["down", "space", "space", "enter"]),
    (_s) => {},
  );
  assertEquals(result, SUPPORTED_AGENT_IDS);
});

Deno.test("interactiveSelect: cancel returns empty selection", () => {
  const result = interactiveSelect(
    SUPPORTED_AGENT_IDS,
    keySequence(["cancel"]),
    (_s) => {},
  );
  assertEquals(result, []);
});

// ─── Path layout sanity ──────────────────────────────────────────────────────

Deno.test("each agent's project paths are under a stable per-agent prefix", () => {
  const prefixes: Record<AgentId, string> = {
    "claude-code": ".claude/",
    "opencode": ".opencode/",
    "copilot-cli": ".github/copilot/",
  };
  for (const id of ALL_AGENTS) {
    for (const kind of TEMPLATE_KINDS) {
      const p = AGENTS[id].projectPaths[kind];
      assert(
        p.startsWith(prefixes[id]),
        `agent ${id}: path ${p} does not start with expected prefix ${prefixes[id]}`,
      );
    }
  }
});
