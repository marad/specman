---
id: UI-0001
title: Design system baseline
status: draft
depends_on: []
---

## Intent

Establish the single design system every UI feature in the product builds on. Without it, each feature re-derives visual primitives — colors, spacing, components — and the UI drifts into quiet inconsistency within two quarters. For SpecMan specifically: without a design system, UI specs are forced to carry pixel values and visual decisions themselves, which rot every time a designer nudges a value. The design system is the contract that lets UI specs stay at the composition layer and survive iteration.

## Behavior

The design system is composed of six layers, each with a single source of truth:

1. **Design tokens** — named constants for colors, typography, spacing, radii, shadows, motion durations. Values live in `design-system/tokens.json`, consumed by both engineering and design tooling. Names are the stable contract; values behind them may move.
2. **Components** — a registered inventory of reusable UI components, each with its own spec (`UI-0002` Button, `UI-0003` Input, …). Components are the only units UI specs reference by name.
3. **A11y baseline** — WCAG 2.1 AA conformance. Every component and every composition built on top must meet it; individual features do not re-declare it.
4. **Error catalog** — a registry at `design-system/errors.json` mapping error codes to authored user-facing strings. UI specs reference error codes; they never author error strings inline.
5. **Breakpoints** — a named set (e.g. `sm`, `md`, `lg`, `xl`), defined in tokens. UI specs and components reference breakpoint names only; raw pixel widths are never used in prose.
6. **Copy conventions** — tone, casing, punctuation, and error-message shape documented under `docs/copy/`. All authored UI strings conform.

UI specs consume the system via `depends_on: [UI-0001, …]` and by reference to token names, component names, and error codes. They never restate the values behind those references. When a feature genuinely needs something the system does not provide, the fix is to extend the system (new token, new component, new error code) — not to inline the value into the feature spec.

## Constraints

- Token names are stable contracts. A token may change *value* but not *name* or *semantic meaning*. Renames are breaking changes and require a versioned migration.
- Every registered component defines, at minimum, its applicable states among: `idle`, `hover`, `focus`, `active`, `disabled`, `loading`, `error`. A component missing any state that applies to its role is not considered complete.
- Every interactive component satisfies the a11y baseline — keyboard operability, visible focus, programmatic labeling, announced validation and error messages.
- Every user-facing string originates from either the error catalog or a component's own authored copy. No inline strings in product code or UI specs beyond those surfaces.
- Token values, error strings, and the component inventory live in files committed to the repository. No external-tool-only source of truth for these values (Figma may be a working surface, not the contract).
- Breakpoint names are referenced, never pixel values. "On `md` and above" is valid in a UI spec; "on 768px and above" is not.

## Examples

A UI feature spec consuming the system:

```yaml
---
id: FEAT-0042
title: Password reset via email
depends_on: [FEAT-0010, UI-0001]
---
```

A component reference in a feature spec's Behavior section:

> "The primary submission uses `Button variant=primary size=lg`. Disabled and loading states are handled per UI-0002."

An error reference:

> "On network failure, the flow surfaces error code `network.unreachable` from the error catalog above the primary action."

A breakpoint reference:

> "The form is single-column on all breakpoints; no rearrangement at `md` or above."

A token file entry (for illustration — the file is the contract, this spec is not):

```json
{
  "color.action.primary": "#2F6FEB",
  "spacing.lg": "24px",
  "radius.md": "8px",
  "motion.fast": "120ms"
}
```

## Acceptance criteria

- AC-1: Given a token referenced by name in a UI spec, when the token name is looked up in `design-system/tokens.json`, then a definition exists for that name.
- AC-2: Given a component referenced by name in a UI spec, then a registered `UI-XXXX` spec exists for that component.
- AC-3: Given an error code referenced in a UI spec, when the code is looked up in `design-system/errors.json`, then an authored string exists for that code.
- AC-4: Given any component spec under `UI-XXXX`, then its spec explicitly enumerates the component's applicable states.
- AC-5: Given a UI spec, when it references a breakpoint, then the reference uses a registered breakpoint name; raw pixel values in breakpoint context are rejected by validation.
- AC-6: Given a feature that validates user input against shared rules (e.g. passwords), then it references the rules from the design system registry rather than redefining them.
- AC-7: Given any user-facing string in a UI spec that is not a literal component name or error code, then the string is either sourced from the error catalog or flagged for copy review.

## Out of scope

- Marketing and campaign design (landing pages, promotional assets) — different discipline, different constraints.
- Brand assets (logos, wordmarks, brand colors not represented as tokens).
- Platform-native controls (OS-level pickers, native dialogs) and their variance across platforms.
- Animation choreography beyond named motion tokens. Complex sequences belong to the component spec that needs them.
- Internationalization infrastructure. A single-locale error catalog is assumed until the product commits to multi-locale.

## Non-goals

- The design system does not inline token values into UI specs. If a hex color, pixel value, or exact duration appears in a UI spec, the system has failed at its job — the fix is to promote it to a token, not to accept it in prose.
- The design system does not permit per-feature visual overrides. A feature that cannot be expressed in the current system signals a system gap; the gap is closed by extending the system, not by working around it in one spec.
- The design system does not depend on a specific design tool. Figma may be the working surface today; the contract is the token file and the component specs, not the Figma file.
- The design system does not ship a theming or dark-mode abstraction until multiple themes are concretely required. Premature theming creates token sprawl and forces every component to be theme-aware without a payoff.

## Open questions

- Should component specs live under `specs/ui/` or flat under `specs/`? *Decide once the component count exceeds ~15 — same subfolder-when-crowded rule from FEAT-0001.*
- Should tokens carry semantic aliases (`color.action.primary` → `color.blue.500`) from day one, or only when theming pressure emerges? *Decide after the first concrete request for a second theme; premature aliasing slows initial development.*
- Does the error catalog need i18n structure at MVP? *Decide based on product scope: single-locale defer; multi-locale fold in now.*
- Who authors the content of `design-system/tokens.json` and `design-system/errors.json`, and who reviews changes? *Decide as the team grows past one designer or one copywriter; single-author regime is fine until then.*
