# Spec File Format

Technical reference for the spec file format. For practical guidance, see [Writing Specs](writing-specs.md).

## Structure

Every spec file has two parts:

```
┌─────────────────────────────┐
│ --- (YAML frontmatter)      │
│ id: FEAT-NNNN               │
│ title: Human-readable name  │
│ status: draft               │
│ depends_on: [FEAT-0001]     │
│ ---                         │
├─────────────────────────────┤
│ ## Intent                   │
│ (required, non-empty)       │
│                             │
│ ## Behavior                 │
│ (optional)                  │
│                             │
│ ## Constraints              │
│ (optional)                  │
│                             │
│ ## Examples                 │
│ (optional)                  │
│                             │
│ ## Acceptance criteria      │
│ (required, non-empty)       │
│                             │
│ ## Out of scope             │
│ (optional)                  │
│                             │
│ ## Non-goals                │
│ (optional)                  │
│                             │
│ ## Open questions           │
│ (optional)                  │
└─────────────────────────────┘
```

## Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | ✅ | string | Unique identifier, e.g. `FEAT-0042` |
| `title` | ✅ | string | Human-readable feature name |
| `status` | ✅ | string | One of: `draft`, `active`, `shipped`, `deprecated` |
| `depends_on` | ✅ | list | IDs of specs this one depends on, e.g. `[FEAT-0001]` |
| `platforms` | ❌ | list | Platform tags, e.g. `[web, ios, android]` |

### Canonical Key Order

The serializer writes frontmatter keys in this order:
```yaml
id → title → status → platforms (if present) → depends_on
```

Non-canonical order is accepted on read and canonicalized on first save.

### List Style

- **Flow style** for short lists: `depends_on: [FEAT-0001, FEAT-0002]`
- **Block style** when the line would exceed 80 columns:
  ```yaml
  depends_on:
    - FEAT-0001
    - FEAT-0002
    - FEAT-0003
  ```

## Body Sections

### Required

| Section | Rule |
|---------|------|
| `## Intent` | Must be present with non-empty body |
| `## Acceptance criteria` | Must be present with non-empty body |

### Optional (canonical order)

`## Behavior`, `## Constraints`, `## Examples`, `## Out of scope`, `## Non-goals`, `## Open questions`

### Custom Sections

Authors may add sections beyond the canonical set (e.g. `## Security considerations`). Custom sections are preserved by the parser and serializer and not flagged by the validator.

### Section Order

The canonical order is **recommended but not enforced**. The serializer preserves whatever order the sections appear in.

## Acceptance Criteria Format

```markdown
- AC-1: Given X, when Y, then Z.
- AC-2 *(web only)*: Given X, then Z.
```

### ID Format

`AC-<N>` where `<N>` is a positive integer. IDs are:
- **Stable** — once assigned, never reused for a different criterion
- **Unique within a file** — duplicates are validation errors
- **Referenced by commits** — via `Spec: FEAT-0042/AC-1` trailers

### Platform Markers

Optional text between the ID and the colon is preserved but not part of the ID:
```
AC-5 *(web only)*: ...
     ^^^^^^^^^^^^^^ ignored for ID extraction, preserved in raw text
```

## Canonical Form

The parser and serializer enforce a **canonical form** — the deterministic formatting SpecMan produces. When a spec is already canonical, `parse → serialize` is a no-op (byte-identical).

Canonical rules:
- **Frontmatter**: keys in canonical order, one space after `:`, flow-style lists when short
- **Sections**: one blank line before `##`, one blank line after `##`, body as-is
- **File ending**: exactly one trailing newline
- **Line endings**: LF only

Non-canonical input (tabs, extra blank lines, out-of-order keys) is accepted on read and canonicalized on first save through any SpecMan path.

## File Naming

Convention: `<FEAT-ID>-<slug>.md`

- `FEAT-ID`: matches the `id` field, e.g. `FEAT-0042`
- `slug`: lowercase, hyphens, derived from title
- Violation is a **warning**, not an error

Files may live at any depth under `specs/` (except `specs/assets/`). Subfolder choice doesn't affect identity.

## Assets

Non-markdown assets live at `specs/assets/<FEAT-ID>/`:

```
specs/assets/FEAT-0099/
├── mobile-mockup.png
├── desktop-layout.png
└── error-states.png
```

Referenced from specs by relative path, typically from `## Examples`.
