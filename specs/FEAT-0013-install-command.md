---
id: FEAT-0013
title: Install command
status: draft
depends_on: [FEAT-0010, FEAT-0011]
---

## Intent

Specman is only useful when the people and agents working with it understand its conventions — the spec format, the lifecycle, the new-vs-update routing, the sync loop, the role of acceptance criteria. Today, that understanding has to come from reading `docs/`, which is friction for humans and a non-starter for AI coding agents that begin every session cold. An always-on instructions file (`CLAUDE.md`, `.github/copilot-instructions.md`, etc.) would solve the agent-cold-start problem at the cost of taxing every conversation in every project, regardless of whether the user is touching specs at all. `specman install` resolves the trade-off: it writes lazy-loaded, agent-native primitives — skills that fire on spec-flavored mentions, slash commands the user invokes deliberately — into the project (or the user's home), so an agent learns specman exactly when specman is relevant and stays out of the way otherwise. It is also the answer to "how do I onboard a new agent or a new contributor onto specman in this project?" — one command, committed alongside the rest of the repo.

## Behavior

The user runs `specman install` from anywhere inside a specman-initialized project. By default, install is project-scoped: it writes agent-native artifacts into the project's working tree, expecting them to be committed alongside `specs/` and `.specman/`. With `--global`, install writes the same artifacts under the user's home directory (per each agent's user-scope convention), so they apply across every project that user works on, without committing.

### Invocation modes

`specman install` with no positional argument and a TTY attached presents an **interactive checklist** of supported agents. The user toggles agents on or off (default: all on) and confirms; install proceeds for the selected set. With one or more agent names as positional arguments — `specman install claude-code opencode` — install skips the prompt and operates on exactly the named agents. This explicit form is the non-interactive entry point for scripts and CI; in a non-TTY environment, omitting the agent argument is an error rather than a hang or a silent default.

`specman install --list` prints the supported agents one per line and exits zero without modifying anything. `specman uninstall <agent>...` is the reverse operation: it removes the artifacts install would have written.

### Supported agents at MVP

| Agent | Identifier | Project path | Global path |
|---|---|---|---|
| Claude Code | `claude-code` | `.claude/` | `~/.claude/` |
| Opencode | `opencode` | `.opencode/` | `~/.config/opencode/` |
| Copilot CLI | `copilot-cli` | `.github/copilot/` | `~/.config/github-copilot/` |

Each supported agent has a corresponding **agent backend** in the binary that knows where its skills and commands live and how to write them. Adding a new backend later (Cursor, Pi, etc.) is a code change with no surface impact on this command's interface. Asking install for an unsupported agent — `specman install cursor` today — exits non-zero with a message naming the unsupported identifier and pointing at `--list`.

### Artifacts installed per agent

For every selected agent, install writes **four artifacts** with consistent purposes across agents (the file paths and trigger semantics are agent-specific, but the content templates are shared):

1. A **skill** — a lazy-loaded document containing specman's mental model and a router pointing at the slash commands. Triggered by the agent's own mechanism (skill description matching for Claude Code and Copilot CLI, agent definition for Opencode) on spec-flavored mentions: words like "spec", "specman", "drift", "acceptance criteria", "sync".
2. A **`/spec` slash command** — the entry point for authoring or updating a specification. Encodes the new-vs-update routing decision and the spec-writing principles.
3. A **`/spec-sync` slash command** — the full sync loop on a specific spec: plan generation, plan filling, the human approval gate, implementation, verification, and sealing.
4. A **`/spec-status` slash command** — quick triage. Runs `specman status`, interprets the output, suggests the next action.

Each slash command is **self-sufficient**: invoking `/spec-sync FEAT-0042` cold, without the skill having loaded, produces correct behavior. The skill is a bonus surface for ambient triggering, not a prerequisite.

The four artifacts are written from **static templates baked into the binary** at compile time. The templates ship with specman; updating specman updates the templates. Re-running `specman install` is the upgrade path. There is no runtime call-back from the installed artifacts to the specman binary.

### Project requirement and `--global`

Project-scoped install (the default) requires the current working directory to be inside a specman-initialized project — install walks up the tree looking for `specs/` and `.specman/`, the same root-discovery logic FEAT-0010 specifies for every command except `init`. Outside an initialized project, project-scoped install exits non-zero with a message pointing the user at both `specman init` (to initialize the project) and `--global` (to install per-user without a project). With `--global`, no project is required and no walk-up is performed; install writes only to the home-directory paths.

### Idempotency and overwrite

Install is destructively idempotent: re-running it overwrites every artifact it owns, regardless of whether the on-disk content differs. There is no `--force` flag because there is no refusal to override. Users who hand-edited an installed file lose those edits on the next install — the documented contract is that these files are owned by specman, not by the user. The same overwrite semantics apply to `specman uninstall`: the named files are removed unconditionally if they exist.

Install does not track which agents have been installed. There is no manifest, no hidden state, no version-stamp frontmatter on installed artifacts. The presence or absence of files at the agent's expected paths is the only state. Reinstalling without changing arguments is a safe no-op-equivalent: it produces the same on-disk content it produced last time.

### Output

Successful install prints, for each selected agent and each artifact written, a single line naming the path. After all artifacts are written, install ends with a one-line hint for the user: "Restart your agent or open a new session to load the new skills." Failures (e.g. permission denied on a destination, unsupported agent name, no project found) exit non-zero with an error naming the cause; partial work already done is not rolled back.

## Constraints

- **Static templates.** All installed content is baked into the binary at compile time via `include_str!` (or equivalent). No runtime fetch, no on-disk template directory, no network.
- **No telemetry.** Install does not emit any metrics, pings, or analytics, locally or remotely. It performs file writes and exits.
- **No configuration file.** Specman has no per-project config (per FEAT-0010); install does not introduce one. Selected agents on the interactive prompt are not persisted between runs.
- **Project scope by default.** Without `--global`, install requires the project to have been initialized via `specman init` and writes inside the project tree.
- **Project-scoped paths are committable.** Every project-scoped artifact lives under a path that fits the agent's standard for tracked configuration (`.claude/`, `.opencode/`, `.github/copilot/`); none of them require listing in `.gitignore`.
- **Overwrite without prompts.** Re-running install replaces existing artifacts unconditionally. Re-running uninstall removes them unconditionally. There is no `--force` and no confirmation prompt — it would be vestigial given the overwrite-everything contract.
- **Non-interactive falls back to error.** With no TTY and no positional agent arguments, install exits non-zero rather than picking a default set or hanging.
- **Templates are uniform across agents.** The content of the four artifacts (skill, `/spec`, `/spec-sync`, `/spec-status`) is the same regardless of which agent receives them. Agent backends differ only in destination paths, file format wrappers (e.g. frontmatter conventions), and trigger metadata.
- **Each slash command is self-sufficient.** A user can invoke `/spec`, `/spec-sync`, or `/spec-status` cold, without the skill having loaded, and the agent has enough context to operate correctly.

## Examples

Interactive install in a TTY:

```
$ specman install
? Select agents to install (space to toggle, enter to confirm):
  [x] claude-code
  [x] opencode
  [x] copilot-cli

Wrote .claude/skills/specman/SKILL.md
Wrote .claude/commands/spec.md
Wrote .claude/commands/spec-sync.md
Wrote .claude/commands/spec-status.md
Wrote .opencode/agents/specman.md
Wrote .opencode/commands/spec.md
Wrote .opencode/commands/spec-sync.md
Wrote .opencode/commands/spec-status.md
Wrote .github/copilot/skills/specman/SKILL.md
Wrote .github/copilot/commands/spec.md
Wrote .github/copilot/commands/spec-sync.md
Wrote .github/copilot/commands/spec-status.md
Restart your agent or open a new session to load the new skills.
```

Explicit single-agent install (script-friendly, non-interactive):

```
$ specman install claude-code
Wrote .claude/skills/specman/SKILL.md
Wrote .claude/commands/spec.md
Wrote .claude/commands/spec-sync.md
Wrote .claude/commands/spec-status.md
Restart your agent or open a new session to load the new skills.
```

Listing supported agents:

```
$ specman install --list
claude-code
opencode
copilot-cli
```

Global install (per-user, no project required):

```
$ specman install --global claude-code
Wrote /home/alice/.claude/skills/specman/SKILL.md
Wrote /home/alice/.claude/commands/spec.md
Wrote /home/alice/.claude/commands/spec-sync.md
Wrote /home/alice/.claude/commands/spec-status.md
Restart your agent or open a new session to load the new skills.
```

Re-running install — overwrites without prompting:

```
$ specman install claude-code
Wrote .claude/skills/specman/SKILL.md
Wrote .claude/commands/spec.md
Wrote .claude/commands/spec-sync.md
Wrote .claude/commands/spec-status.md
Restart your agent or open a new session to load the new skills.
```

Uninstall:

```
$ specman uninstall claude-code
Removed .claude/skills/specman/SKILL.md
Removed .claude/commands/spec.md
Removed .claude/commands/spec-sync.md
Removed .claude/commands/spec-status.md
```

Project-scoped install outside an initialized project:

```
$ specman install claude-code
error: no specman project found (walked up from /home/alice/work/scratch).
Run `specman init` first, or use `specman install --global` for a per-user install.
```

Unsupported agent identifier:

```
$ specman install cursor
error: unknown agent 'cursor'. Run `specman install --list` to see supported agents.
```

Non-interactive context with no explicit agents:

```
$ specman install < /dev/null
error: no agents specified and no TTY available for interactive selection.
Pass agent names explicitly, e.g. `specman install claude-code`.
```

## Acceptance criteria

- AC-1: Given a TTY and no positional arguments, `specman install` presents an interactive checklist where the user navigates with arrow keys, toggles selection with space, and confirms with enter; install proceeds for the selected agents.
- AC-2: Given one or more agent identifiers as positional arguments, `specman install <agent>...` skips the prompt entirely and installs the artifacts for exactly the named agents in the order given.
- AC-3: Given no TTY and no positional agent arguments, `specman install` exits non-zero with an error directing the user to pass agent names explicitly, and writes nothing.
- AC-4: Given `--list`, `specman install --list` prints each supported agent identifier on its own line, exits zero, and writes no files.
- AC-5: Given an unsupported agent identifier, `specman install <agent>` exits non-zero with an error naming the identifier and pointing at `--list`, and writes nothing for that invocation.
- AC-6: Given the default scope (no `--global`) and a current working directory that is not inside a specman-initialized project, `specman install` exits non-zero with an error pointing at `specman init` and `--global`, and writes nothing.
- AC-7: Given the default scope and a current working directory inside an initialized project, `specman install` writes the four artifacts (one skill plus three slash commands) per selected agent, into that agent's project-scoped paths.
- AC-8: Given `--global`, `specman install --global <agent>...` writes the same four artifacts per selected agent into the agent's user-home paths, regardless of whether the current working directory is inside a specman project.
- AC-9: Given a previous install whose artifacts already exist on disk, re-running `specman install` with the same arguments overwrites every artifact without prompting and exits zero.
- AC-10: Given an installed agent, `specman uninstall <agent>` removes every artifact that `install` would have written for that agent and exits zero. Missing files are not an error.
- AC-11: Given a successful install, the output names every path written, in the order written, and ends with a one-line hint about restarting the agent.
- AC-12: Given the supported agent matrix at MVP, `specman install --list` prints exactly: `claude-code`, `opencode`, `copilot-cli` — one per line.
- AC-13: Given any installed slash command (`/spec`, `/spec-sync`, `/spec-status`), invoking it without the skill having loaded provides the agent enough context to perform the corresponding workflow correctly. The slash command bodies are self-sufficient and do not assume the skill is in context.
- AC-14: Given any installed skill, its trigger metadata fires on at least the terms "spec", "specman", "acceptance criteria", "drift", and "sync" appearing in user input, in whatever form the agent's matching mechanism supports.
- AC-15: Given a partial install failure (e.g. permission denied on the third file written), the artifacts already written remain on disk; install exits non-zero naming the failed path; no rollback is attempted.
- AC-16: Given install runs entirely from baked-in templates, neither network access nor any external file outside the binary and the destination paths is read or written.

## Out of scope

- Cursor, Pi, and IDE-resident GitHub Copilot. Each of these will be handled by a dedicated extension or a future agent backend; they are explicitly not part of MVP.
- Auto-detection of which agents the user has installed locally. Selection is interactive (TTY) or explicit (positional args); install never inspects the system to guess.
- Version pinning, drift detection, or content checksums on installed artifacts. The contract is overwrite-on-reinstall; we do not track what version of specman wrote which file.
- Per-project template overrides or customization. Templates are uniform; users who want different content fork the binary or hand-edit installed files knowing those edits do not survive reinstall.
- Bundling specman knowledge into a single always-on instructions file (`CLAUDE.md`, `.github/copilot-instructions.md`). The whole point of this command is to avoid that pattern.
- Telemetry, usage reporting, or any form of network call. Install is pure filesystem.
- Migrating older specman installations or different conventions. There are none yet.

## Non-goals

- Not interactive beyond the agent-selection step. Install does not ask "where would you like to install?", "should I overwrite?", or "do you want global or project?". Scope is `--global` or default; overwrite is unconditional.
- Not opinionated about which agent the user should pick. The interactive prompt presents all supported agents with no recommendation; the explicit form trusts the user's choice without comment.
- Not a configuration system. Install does not store preferences, remember the last-selected agents, or read any config file. Each invocation is self-contained.
- Not a content authoring tool. Templates ship inside the binary. The install command is a static-content writer; evolving the templates is a development workflow, not a user-facing one.
- Not a recovery tool. If installed artifacts are corrupted or partially deleted, re-running install restores them — but install is not aware that recovery is what it is doing.

## Open questions

- Should the interactive checklist remember the previous selection across runs? *Defer — at MVP every invocation is independent. If users develop habits around partial installs, persistence becomes a real ask we can answer concretely.*
- Should `specman install --global` and project-scoped install be combinable in one invocation (e.g. install the same agents both globally and locally)? *Defer — the use case is unclear, and `specman install <agent> && specman install --global <agent>` already works. Trivially additive later.*
- Should `specman uninstall` accept `--all` to remove every installed agent in one call? *Defer — `specman install --list | xargs specman uninstall` is the workaround, and the use case is rare enough that adding a flag at MVP is premature.*
- Should the agent-restart hint at the end of install be configurable or suppressible? *Decide once a real scripting use case asks for it; the hint is one line on stdout and easy to ignore.*
