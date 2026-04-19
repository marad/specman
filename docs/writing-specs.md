# Writing Specs

A good spec communicates intent to both humans and agents. This guide covers the format, best practices, and common patterns.

## Anatomy of a Spec

```markdown
---
id: FEAT-0042
title: Password reset via email
status: draft
platforms: [web, ios]
depends_on: [FEAT-0001]
---

## Intent           ← Why this feature exists (required)

## Behavior         ← What it does from the user's perspective

## Constraints      ← Hard rules the implementation must follow

## Examples         ← Concrete scenarios, mockups, sample data

## Acceptance criteria  ← Testable success conditions (required)

## Out of scope     ← Explicitly excluded to prevent scope creep

## Non-goals        ← Things that look related but are deliberately not done

## Open questions   ← Unresolved decisions, with context for resolving them
```

## Required Sections

Only **Intent** and **Acceptance criteria** must be present with non-empty content. Everything else is optional — include sections when they add value, omit when they don't.

## Writing Good Intent

Intent answers: **why does this feature exist?** Not what it does (that's Behavior), but why it matters.

**Good:**
> Let users regain access to their account without contacting support.

**Bad:**
> Implement a password reset endpoint that sends an email with a JWT token.

The first describes the problem. The second describes a solution. Specs describe problems; code describes solutions.

## Writing Good Acceptance Criteria

ACs are the interface between specs and implementation. They must be:

### Testable

Every AC should be verifiable by a concrete test. Use Given/When/Then or Given/Then structure:

```
- AC-1: Given a registered email, when the user requests a reset,
  then a reset link is delivered within 1 minute.
```

### Stable

AC IDs (`AC-1`, `AC-2`, ...) are permanent anchors. Agent commits reference them via `Spec:` trailers. Once assigned, an ID should never be reused for a different criterion.

### Independent

Each AC should be implementable and testable on its own. Avoid ACs that only make sense as a group:

**Good:**
```
- AC-1: Given valid credentials, login returns a session token.
- AC-2: Given invalid credentials, login returns a 401 error.
```

**Bad:**
```
- AC-1: The login endpoint works correctly.
- AC-2: See AC-1 but for edge cases.
```

### Platform-Scoped (when needed)

For multi-platform specs, tag platform-specific ACs:

```yaml
platforms: [web, ios, android]
```

```
- AC-1: Given any platform, the settings page loads within 2 seconds.
- AC-2 *(web only)*: The layout uses a two-column grid on desktop.
- AC-3 *(ios, android)*: Biometric auth is offered when available.
```

## Writing Good Behavior

Behavior describes **what the feature does from its consumer's perspective** — not how it's implemented.

For UI features, stay at the interaction level:
> The user taps "Reset Password", enters their email, and receives a confirmation screen.

Not at the pixel level:
> A 44px tall button with 8px corner radius in #0066CC...

Visual specifics belong in the design system, not the spec.

## Dependencies

```yaml
depends_on: [FEAT-0001, FEAT-0010]
```

`depends_on` means: **implementing this spec assumes the dependencies are already implemented.** SpecMan uses this for:
- Sync ordering (dependencies sync first)
- Validation (broken references caught)
- Failure cascading (dependent specs skip when a dependency fails)

Only list direct dependencies. If FEAT-0003 depends on FEAT-0002 which depends on FEAT-0001, FEAT-0003 should list `[FEAT-0002]`, not `[FEAT-0001, FEAT-0002]`.

## Status Field

```yaml
status: draft    # Writing the spec
status: active   # Under active development
status: shipped  # Live in production
status: deprecated  # Being phased out
```

Status is a **human-managed label** for communication and filtering. SpecMan doesn't enforce transitions or change it automatically.

## File Organization

Specs live under `specs/`, optionally in subfolders:

```
specs/
├── FEAT-0001-auth.md
├── FEAT-0002-reset.md
├── cli/
│   ├── FEAT-0008-new-command.md
│   └── FEAT-0010-init-command.md
├── ui/
│   └── FEAT-0099-account-settings.md
└── assets/
    └── FEAT-0099/
        ├── mobile-mockup.png
        └── desktop-mockup.png
```

Rules:
- **Filename**: `<FEAT-ID>-<slug>.md` — validator warns if non-conventional
- **Subfolders**: free choice for organization, don't affect identity
- **Assets**: `specs/assets/<FEAT-ID>/` for mockups, diagrams, screenshots
- **Identity**: `id` field in frontmatter, globally unique across the whole tree

## Patterns

### The Minimal Spec

For small features or technical tasks:

```markdown
---
id: FEAT-0042
title: Add request timeout
status: draft
depends_on: []
---

## Intent

Prevent hung connections from consuming server resources indefinitely.

## Acceptance criteria

- AC-1: Given a request that takes longer than 30 seconds, the server
  returns a 504 and closes the connection.
```

### The Evolution Spec

When modifying an existing feature, edit the existing spec — don't create a new one. Add or modify ACs. SpecMan's drift detection sees only the changes:

```
# Before: 3 ACs, all in-sync
# After edit: 3 original ACs + 1 new AC

specman status --diff
# Shows only the new AC-4 as the change

specman sync FEAT-0042
# Plan targets only AC-4
```

### The Multi-Platform Spec

```yaml
platforms: [web, ios, android]
```

Use platform markers on ACs that don't apply universally. Leave unmarked ACs as cross-platform requirements.

## Anti-Patterns

### Over-specified Behavior

❌ Describing implementation details in the spec:
> Use Redis for session storage with a 24-hour TTL and LRU eviction.

✅ Describing the requirement:
> Sessions expire after 24 hours of inactivity.

### Duplicate ACs

❌ Same criterion stated differently:
```
- AC-1: Login returns a token on success.
- AC-2: Successful login produces a session token.
```

### Missing Dependencies

❌ A spec that assumes auth exists without declaring it:
```yaml
depends_on: []  # But AC-1 says "Given a logged-in user..."
```

✅
```yaml
depends_on: [FEAT-0001]  # FEAT-0001 is the auth spec
```
