/**
 * FEAT-0013: specman install
 *
 * Writes lazy-loaded skills and slash commands into agent-native paths
 * so the agent learns specman exactly when specman is relevant.
 *
 * Templates are loaded from ../templates/ at runtime; the compiled
 * binary bundles them via `deno compile --include templates`.
 */

import * as path from "@std/path";

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentId = "claude-code" | "opencode" | "copilot-cli";

export type TemplateKind = "skill" | "spec" | "spec-sync" | "spec-status";

export type Scope = "project" | "global";

export interface AgentBackend {
  id: AgentId;
  /** Paths relative to the project root. */
  projectPaths: Record<TemplateKind, string>;
  /** Resolves to absolute paths under the user's home directory. */
  globalPaths(home: string): Record<TemplateKind, string>;
  /** Apply agent-specific frontmatter or wrapping to the template body. */
  wrap(kind: TemplateKind, body: string): string;
}

export interface InstallOptions {
  scope: Scope;
  /** Project root (scope=project) or home directory (scope=global). */
  root: string;
}

export interface InstallResult {
  written: string[];
  error: { path: string; message: string } | null;
}

export interface UninstallResult {
  removed: string[];
}

// ── Skill description (trigger metadata) ────────────────────────────────────

/**
 * Trigger description for skill-based agents (Claude Code, Copilot CLI).
 * Must contain each of: "spec", "specman", "acceptance criteria", "drift", "sync"
 * (see FEAT-0013/AC-14).
 */
const SKILL_DESCRIPTION =
  "Use when working with specifications, specman, acceptance criteria, " +
  "drift detection, or sync workflows. Routes to /spec, /spec-sync, " +
  "/spec-status as needed.";

// ── Templates (lazy-loaded) ─────────────────────────────────────────────────

const TEMPLATE_KINDS: TemplateKind[] = [
  "skill",
  "spec",
  "spec-sync",
  "spec-status",
];

let templateCache: Record<TemplateKind, string> | null = null;

function getTemplates(): Record<TemplateKind, string> {
  if (templateCache !== null) return templateCache;
  const cache: Partial<Record<TemplateKind, string>> = {};
  for (const kind of TEMPLATE_KINDS) {
    const url = new URL(`../templates/${kind}.md`, import.meta.url);
    cache[kind] = Deno.readTextFileSync(url);
  }
  templateCache = cache as Record<TemplateKind, string>;
  return templateCache;
}

// ── Agent backends ──────────────────────────────────────────────────────────

const claudeCode: AgentBackend = {
  id: "claude-code",
  projectPaths: {
    "skill": ".claude/skills/specman/SKILL.md",
    "spec": ".claude/commands/spec.md",
    "spec-sync": ".claude/commands/spec-sync.md",
    "spec-status": ".claude/commands/spec-status.md",
  },
  globalPaths(home) {
    return {
      "skill": path.join(home, ".claude/skills/specman/SKILL.md"),
      "spec": path.join(home, ".claude/commands/spec.md"),
      "spec-sync": path.join(home, ".claude/commands/spec-sync.md"),
      "spec-status": path.join(home, ".claude/commands/spec-status.md"),
    };
  },
  wrap(kind, body) {
    if (kind === "skill") {
      return `---\nname: specman\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${body}`;
    }
    return body;
  },
};

const opencode: AgentBackend = {
  id: "opencode",
  projectPaths: {
    "skill": ".opencode/agents/specman.md",
    "spec": ".opencode/commands/spec.md",
    "spec-sync": ".opencode/commands/spec-sync.md",
    "spec-status": ".opencode/commands/spec-status.md",
  },
  globalPaths(home) {
    return {
      "skill": path.join(home, ".config/opencode/agents/specman.md"),
      "spec": path.join(home, ".config/opencode/commands/spec.md"),
      "spec-sync": path.join(home, ".config/opencode/commands/spec-sync.md"),
      "spec-status": path.join(home, ".config/opencode/commands/spec-status.md"),
    };
  },
  wrap(kind, body) {
    if (kind === "skill") {
      return `---\nname: specman\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${body}`;
    }
    return body;
  },
};

const copilotCli: AgentBackend = {
  id: "copilot-cli",
  projectPaths: {
    "skill": ".github/copilot/skills/specman/SKILL.md",
    "spec": ".github/copilot/commands/spec.md",
    "spec-sync": ".github/copilot/commands/spec-sync.md",
    "spec-status": ".github/copilot/commands/spec-status.md",
  },
  globalPaths(home) {
    return {
      "skill": path.join(home, ".config/github-copilot/skills/specman/SKILL.md"),
      "spec": path.join(home, ".config/github-copilot/commands/spec.md"),
      "spec-sync": path.join(home, ".config/github-copilot/commands/spec-sync.md"),
      "spec-status": path.join(home, ".config/github-copilot/commands/spec-status.md"),
    };
  },
  wrap(kind, body) {
    if (kind === "skill") {
      return `---\nname: specman\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${body}`;
    }
    return body;
  },
};

/**
 * Supported agents at MVP. Order is canonical and stable — `--list` and
 * the interactive checklist render in this order. Adding a new agent
 * is a code change here; no other surface needs to update.
 */
export const AGENTS: Record<AgentId, AgentBackend> = {
  "claude-code": claudeCode,
  "opencode": opencode,
  "copilot-cli": copilotCli,
};

export const SUPPORTED_AGENT_IDS: AgentId[] =
  Object.keys(AGENTS) as AgentId[];

// ── Path resolution ─────────────────────────────────────────────────────────

function resolvePaths(
  backend: AgentBackend,
  opts: InstallOptions,
): Record<TemplateKind, string> {
  if (opts.scope === "global") {
    return backend.globalPaths(opts.root);
  }
  const result: Partial<Record<TemplateKind, string>> = {};
  for (const kind of TEMPLATE_KINDS) {
    result[kind] = path.join(opts.root, backend.projectPaths[kind]);
  }
  return result as Record<TemplateKind, string>;
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Write all four artifacts for each agent in `agents` to disk.
 *
 * Order: agents in input order; within each agent, fixed order
 * (skill, spec, spec-sync, spec-status). Each successful write appends
 * the absolute path to `written`. On the first failure, returns the
 * partial result with `error` set; no rollback is attempted (FEAT-0013/AC-15).
 */
export function installAgents(
  agents: AgentId[],
  opts: InstallOptions,
): InstallResult {
  const written: string[] = [];
  const templates = getTemplates();

  for (const id of agents) {
    const backend = AGENTS[id];
    const targets = resolvePaths(backend, opts);

    for (const kind of TEMPLATE_KINDS) {
      const target = targets[kind];
      const content = backend.wrap(kind, templates[kind]);
      try {
        Deno.mkdirSync(path.dirname(target), { recursive: true });
        Deno.writeTextFileSync(target, content);
        written.push(target);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { written, error: { path: target, message: msg } };
      }
    }
  }

  return { written, error: null };
}

// ── Uninstall ───────────────────────────────────────────────────────────────

/**
 * Remove every artifact `installAgents` would have written for each agent
 * in `agents`. Missing files are not errors. Empty parent directories
 * are not pruned.
 */
export function uninstallAgents(
  agents: AgentId[],
  opts: InstallOptions,
): UninstallResult {
  const removed: string[] = [];

  for (const id of agents) {
    const backend = AGENTS[id];
    const targets = resolvePaths(backend, opts);

    for (const kind of TEMPLATE_KINDS) {
      const target = targets[kind];
      try {
        Deno.removeSync(target);
        removed.push(target);
      } catch (e: unknown) {
        if (e instanceof Deno.errors.NotFound) continue;
        throw e;
      }
    }
  }

  return { removed };
}

// ── Interactive selection ───────────────────────────────────────────────────

export type Key = "up" | "down" | "space" | "enter" | "cancel";

/**
 * Ask the user to select agents using arrow keys (navigate), space
 * (toggle), and enter (confirm). Cancel (Ctrl+C / Ctrl+D) returns an
 * empty selection. Returns the selection in canonical order.
 *
 * Default: all agents checked, cursor on the first row. Tested via
 * injected `readKey` and `write` so tests don't need a real terminal.
 */
export function interactiveSelect(
  agents: AgentId[],
  readKey: () => Key | null = defaultReadKey,
  write: (s: string) => void = (s) => Deno.stdout.writeSync(
    new TextEncoder().encode(s),
  ),
): AgentId[] {
  const selected = new Set<AgentId>(agents);
  let cursor = 0;
  let firstRender = true;

  const render = () => {
    if (!firstRender) {
      // Move cursor up over the previously rendered block (header +
      // one line per agent + footer) and clear each line.
      const lines = agents.length + 2;
      for (let i = 0; i < lines; i++) {
        write("\x1b[1A\x1b[2K");
      }
    }
    firstRender = false;
    write("Select agents to install:\n");
    agents.forEach((id, i) => {
      const pointer = i === cursor ? ">" : " ";
      const mark = selected.has(id) ? "x" : " ";
      write(`${pointer} [${mark}] ${id}\n`);
    });
    write("(arrow keys to move, space to toggle, enter to confirm)\n");
  };

  try {
    while (true) {
      render();
      const key = readKey();
      if (key === null || key === "cancel") {
        return [];
      }
      if (key === "enter") break;
      if (key === "up") {
        cursor = (cursor - 1 + agents.length) % agents.length;
      } else if (key === "down") {
        cursor = (cursor + 1) % agents.length;
      } else if (key === "space") {
        const id = agents[cursor];
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
    }
  } finally {
    // Render once more so the final state is visible after exit, and
    // ensure any raw-mode stdin state is released by the default reader.
    defaultReadKeyCleanup();
  }

  return agents.filter((id) => selected.has(id));
}

let rawModeActive = false;

function defaultReadKeyCleanup(): void {
  if (rawModeActive) {
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // ignore — stdin may not be a TTY in test contexts
    }
    rawModeActive = false;
  }
}

function defaultReadKey(): Key | null {
  if (!rawModeActive) {
    try {
      Deno.stdin.setRaw(true);
      rawModeActive = true;
    } catch {
      // Not a TTY — caller shouldn't have invoked us, but degrade gracefully.
      return null;
    }
  }

  const buf = new Uint8Array(8);
  const n = Deno.stdin.readSync(buf);
  if (n === null || n === 0) return "cancel";
  const b0 = buf[0];

  // Ctrl+C (\x03), Ctrl+D (\x04), Esc alone (\x1b with no follow-up).
  if (b0 === 0x03 || b0 === 0x04) return "cancel";
  if (b0 === 0x0d || b0 === 0x0a) return "enter";
  if (b0 === 0x20) return "space";

  // CSI escape: ESC [ A/B/C/D
  if (b0 === 0x1b && n >= 3 && buf[1] === 0x5b) {
    const code = buf[2];
    if (code === 0x41) return "up";
    if (code === 0x42) return "down";
    // Left/right ignored — not used by this UI.
    return defaultReadKey();
  }
  if (b0 === 0x1b) return "cancel";

  // Any other key: keep waiting for a meaningful one.
  return defaultReadKey();
}

// ── Home directory ──────────────────────────────────────────────────────────

/**
 * Resolve the user's home directory for `--global` installs.
 * Throws on misconfigured environments — caller surfaces a clean error.
 */
export function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "cannot resolve home directory: neither HOME nor USERPROFILE is set",
    );
  }
  return home;
}

// ── Output formatting ───────────────────────────────────────────────────────

const RESTART_HINT =
  "Restart your agent or open a new session to load the new skills.";

export function formatInstallSuccess(result: InstallResult): string[] {
  const lines: string[] = [];
  for (const p of result.written) lines.push(`Wrote ${p}`);
  if (result.error === null) lines.push(RESTART_HINT);
  return lines;
}

export function formatInstallFailure(result: InstallResult): string[] {
  // Successful writes go to stdout, error to stderr — caller dispatches.
  const lines: string[] = [];
  for (const p of result.written) lines.push(`Wrote ${p}`);
  if (result.error !== null) {
    lines.push(`error: failed to write ${result.error.path}: ${result.error.message}`);
  }
  return lines;
}

export function formatUninstall(result: UninstallResult): string[] {
  return result.removed.map((p) => `Removed ${p}`);
}
