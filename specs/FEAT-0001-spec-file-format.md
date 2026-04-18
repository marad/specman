---
id: FEAT-0001
title: Specification file format
status: draft
depends_on: []
---

## Intent

Define a single, versionable format for feature specifications that both humans and agents can work with comfortably. Humans need to read and edit specs without friction; agents need stable anchors they can parse, diff, and target. A shared format is the foundation every other part of SpecMan rests on — without it, the editor, the versioning logic, and the agent sync loop all have to invent their own conventions.

## Behavior

Each feature lives in its own markdown file under a `specs/` folder in the target repository. A spec file has two parts:

1. **YAML frontmatter** carrying structured metadata. Required: `id`, `title`, `status`, `depends_on`. Optional: `platforms` — a list of strings naming the platforms this spec targets (e.g. `[web, ios, android]`). Platform values are project-defined and not enumerated by the validator.
2. **A markdown body** with conventional sections in this canonical order: `## Intent`, `## Behavior`, `## Constraints`, `## Examples`, `## Acceptance criteria`, `## Out of scope`, `## Non-goals`, `## Open questions`.

Of the body sections, `## Intent` and `## Acceptance criteria` are required — each must be present **as a heading and carry non-empty content**. A heading with an empty body does not satisfy the requirement. The rest are optional and appear only when they carry content; authors omit empty sections rather than leaving placeholders.

`## Behavior` describes what the feature does from its consumer's perspective — whether that consumer is an end user, calling code, or a CLI caller — not how the feature does it. Implementation detail belongs in agent-generated plans, not in specs. For UI features specifically, "implementation" includes visual specifics — exact dimensions, colors, spacing, typography, motion curves. Those belong in the design system, not the spec. Write *"primary button, prominent in the hero"* rather than *"#0066CC, 44px tall, 8px corner radius."* The section name is deliberately neutral so technical and product specs share one convention; the "consumer" reframes naturally per spec.

Acceptance criteria use stable IDs of the form `AC-N:` so that commit trailers and agent plans can reference specific criteria even as surrounding prose changes. An AC may carry a platform marker (e.g. `AC-5 *(web only)*:`) when a criterion applies only to a subset of the spec's declared `platforms`. Files are named `<FEAT-ID>-<slug>.md`. They may live directly under `specs/` or in any subfolder of `specs/` — subfolder organization is a free choice for readability and not part of identity. `<FEAT-ID>` values are globally unique across the whole `specs/` tree regardless of where a file lives, and `depends_on` references resolve by id alone. Moving a spec between folders never changes its identity or invalidates references to it. The `specs/assets/` subtree is reserved for non-markdown assets (see below) and is not treated as a container for specs.

Non-markdown assets — mockups, diagrams, exported screens, reference screenshots — live at `specs/assets/<FEAT-ID>/` and are referenced from the markdown by relative path, typically from `## Examples`. Keeping assets in-repo alongside their owning spec makes specs self-contained, offline-readable, and diffable alongside the features that own them. External design-tool links (Figma, etc.) are allowed as supplementary references but never as the source of truth — the agent sync loop can only diff what it can read from the repo.

The format is validated by a parser/linter shipped with SpecMan: frontmatter is type-checked, required fields are enforced, IDs are unique across the repo, and ACs are extracted with stable identifiers.

## Constraints

- The format must remain primary plain text — readable and writeable in any editor, with no semantics that exist only through the visual editor.
- Serialization is deterministic: the same parsed representation always writes back to the same byte stream, so round-tripping through the editor produces clean git diffs.
- The parser is pure and side-effect-free — no I/O, no network, no filesystem mutation during parsing.
- Once assigned, an AC ID is stable across edits that do not delete the AC. Renumbering unaffected ACs is forbidden (enforced by FEAT-0002 on the editor side).

## Examples

A minimal valid spec:

```markdown
---
id: FEAT-0042
title: Password reset via email
status: draft
depends_on: [FEAT-0010]
---

## Intent

Let users regain access to their account without contacting support.

## Acceptance criteria

- AC-1: Given a registered email, when the user requests a reset, then a reset link is delivered within 1 minute.
- AC-2: Given a reset link older than 1 hour, when followed, then the request is rejected with a clear error.
```

A spec targeting multiple platforms adds `platforms` to its frontmatter and may tag platform-specific ACs:

```yaml
---
id: FEAT-0099
title: Account settings screen
status: draft
platforms: [web, ios, android]
depends_on: []
---
```

A spec referencing mockups places them under `specs/assets/<FEAT-ID>/` and links from `## Examples`:

```
specs/
  FEAT-0099-account-settings-screen.md
  assets/
    FEAT-0099/
      mobile-primary.png
      desktop-primary.png
      pending-email-banner.png
```

A spec may add any optional section (`## Behavior`, `## Constraints`, `## Examples`, `## Out of scope`, `## Non-goals`, `## Open questions`) as the content warrants. The canonical order above is recommended for readability but not enforced.

## Acceptance criteria

- AC-1: Given a well-formed spec file, the parser returns a structured object containing parsed frontmatter and a list of sections keyed by heading.
- AC-2: Given a spec file missing any required frontmatter field (`id`, `title`, `status`), the validator returns an error naming the missing field and the file path.
- AC-3: Given a spec file missing a required body section (`## Intent`, `## Acceptance criteria`) — whether the heading is absent, or present with an empty body — the validator returns an error naming the offending section.
- AC-4: Given two spec files declaring the same `id`, the validator fails with both file paths reported.
- AC-5: Given a body section titled `## Acceptance criteria`, every bullet matching `AC-<N>:` is extracted and exposed with its ID preserved.
- AC-6: Given a `status` value outside the set `{draft, active, shipped, deprecated}`, the validator fails naming the offending value.
- AC-7: Given a file whose name does not match the `<FEAT-ID>-<slug>.md` convention, the validator emits a warning (not an error) so the author can fix it without blocking other tooling.
- AC-8: Given a spec parsed and then re-serialized without modification, the output is byte-identical to the input.
- AC-9: Given a frontmatter with a `platforms` field, the parser accepts it as a list of strings and does not enumerate allowed values; given `platforms` is absent, parsing succeeds unchanged.
- AC-10: Given spec files placed in arbitrary subfolders under `specs/` (e.g. `specs/cli/FEAT-0008-...md`), the parser and validator treat them identically to specs at the top level, and the same `<FEAT-ID>` uniqueness rule applies across the whole tree.
- AC-11: Given a frontmatter field whose value is not of its declared type (e.g. `status: 42` where a string is required, or `depends_on: "FEAT-0001"` where a list is required), the validator returns an error naming the field, the expected type, and the actual YAML-parsed type.
- AC-12: Given two or more acceptance criteria within a single spec declaring the same `AC-<N>` ID, the validator returns an error naming the duplicate ID and the file path.

## Out of scope

- Storage of version history — git is the source of truth.
- The editor UI (FEAT-0002). The format must be readable and writeable as plain text regardless of any editor.
- Drift detection and implementation tracking (FEAT-0003).
- Cross-spec link resolution beyond `depends_on` ID existence checks.
- A design system catalog. Specs reference design-system atoms by name; the catalog itself is a separate repo-level artifact (e.g. `DESIGN_SYSTEM.md`), not part of the spec format.

## Non-goals

- The parser does not auto-correct malformed specs. It reports errors; humans fix them. Silent fixes would mask format drift.
- Format content is not derivable from code. Specs describe intent; code reflects specs. The arrow runs one way.
- No per-spec schema overrides. Every spec conforms to the same format; escape hatches would split the agent's assumptions.
- No externally-hosted primary assets. If an asset is needed to understand the spec, it lives in `specs/assets/<FEAT-ID>/`. External links are fine as supplements, never as the only source.

## Open questions

- Should frontmatter support `owners`? *Decide once ≥5 specs exist and we can see whether ownership information is being used or is decorative.*
- Do we want a `tags` field for filtering in the editor? *Decide once the editor (FEAT-0002) is shipped and filtering friction is felt in practice.*
- Is `## Acceptance criteria` the only section with stable sub-IDs, or should `## Behavior` also get numbered anchors? *Decide when derivation-based agent scoping (git `Spec:` trailers per FEAT-0004) proves too coarse in practice. Until then, ACs are the only stable-ID surface.*
- Should `specman validate` check that relative-path references from specs (e.g., assets under `specs/assets/<FEAT-ID>/`) actually resolve on disk? *Decide after the first broken-asset link appears in practice; warn-level at minimum seems useful.*
