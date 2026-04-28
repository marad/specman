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

/**
 * Ask the user to select agents from a numbered list. Toggle by typing
 * the agent's number; confirm with empty input. Returns the selection
 * in canonical order (input order, filtered to those checked).
 *
 * Default: all agents checked. Tested separately via injected I/O.
 */
export function interactiveSelect(
  agents: AgentId[],
  read: () => string | null = () => prompt(""),
  write: (s: string) => void = (s) => console.log(s),
): AgentId[] {
  const selected = new Set<AgentId>(agents);

  while (true) {
    write("");
    write("Select agents to install:");
    agents.forEach((id, i) => {
      const mark = selected.has(id) ? "x" : " ";
      write(`  ${i + 1}. [${mark}] ${id}`);
    });
    write("Type a number to toggle, or press Enter to confirm.");

    const input = (read() ?? "").trim();
    if (input === "") break;

    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= agents.length) {
      const id = agents[n - 1];
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    }
    // Invalid input: silently re-prompt. The list re-renders next iteration.
  }

  return agents.filter((id) => selected.has(id));
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
