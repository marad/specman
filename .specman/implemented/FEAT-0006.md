---
id: FEAT-0006
title: Spec parser and serializer
status: draft
depends_on: [FEAT-0001]
---

## Intent

Provide the single, canonical translation in both directions between a spec file on disk and a structured in-memory value. Every other SpecMan component — validator, editor, `specman new`, status, sync — calls into this module rather than interpreting or emitting the format itself. Without a central parser the format drifts toward "whatever each reader tolerates"; without a central serializer the format drifts toward "whatever each writer emits," and FEAT-0001's byte-identical round-trip invariant stops being enforceable at the edges.

Parsing and serialization are two halves of one format contract. Co-locating them keeps the round-trip invariant (parse then serialize = input, for canonical input) testable against a single module and prevents FEAT-0002's save path and FEAT-0008's scaffold writer from each inventing their own whitespace and YAML conventions.

## Behavior

The module exposes two operations: `parse` and `serialize`.

### Parsing

`parse` is called with the bytes of one spec file and its path. It returns either:

- a `ParsedSpec` carrying frontmatter (the raw YAML-parsed map — values are whatever YAML gave, not coerced against FEAT-0001's declared types), an ordered list of `(heading, body)` section pairs, and an ordered list of `(id, text)` acceptance criteria extracted from the `## Acceptance criteria` section; or
- a `ParseError` carrying the file path, a location within the file (line; column when meaningful), and a machine-readable reason.

The parser's job is to produce a structured representation of the bytes, not to judge them. It fails only when bytes cannot be structured at all — malformed YAML, an unterminated frontmatter block, no parseable body. Everything that is structurally representable passes through untouched: a missing required field is simply absent from the frontmatter map; a wrong-type field carries whatever YAML parsed it as; a missing required body section is absent from `sections`; an empty required section is present with an empty body; duplicate AC IDs both appear in `acceptance_criteria` in source order. Judging these against FEAT-0001's policy is the validator's job (FEAT-0007).

Scope is one file per call. Cross-file concerns — duplicate `id`, `depends_on` targets, orphan snapshots — also belong to the validator.

Section splitting respects fenced code blocks: lines matching `## <Heading>` inside a fenced code block (` ``` ` or `~~~`) are not treated as section boundaries. This is critical because spec examples routinely contain markdown snippets with headings.

### Serialization

`serialize` is called with a `ParsedSpec`. It returns the canonical byte representation of that spec. Serialization is the inverse operation of parsing for canonical input: `parse(serialize(ps))` always reconstructs an equivalent `ParsedSpec`, and `serialize(parse(bytes))` returns `bytes` byte-for-byte when the input was already canonical.

Canonical form is a fixed set of formatting rules:

- **Frontmatter**: YAML block with a fixed key order (`id`, `title`, `status`, `platforms` if present, `depends_on`). Lists use flow style (`[FEAT-0001, FEAT-0002]`) for short lists and block style for long ones (threshold is a fixed rule, not a heuristic). Strings are unquoted when safe, double-quoted otherwise. One space after `:`. Trailing newline inside the frontmatter block before the closing `---`.
- **Body**: section headings rendered as `## <Heading>` preceded by exactly one blank line (none at start of file), followed by one blank line, followed by the section body as-is. Section order in the output matches the order in `ParsedSpec.sections` — the serializer does **not** reorder sections against FEAT-0001's canonical order, because that order is recommended, not enforced.
- **File ending**: exactly one trailing newline.
- **Line endings**: LF.

Section bodies are emitted verbatim from the `ParsedSpec` — the serializer does not reflow prose, normalize lists, or touch acceptance-criteria formatting beyond the body-level rules above.

When the input to `parse` was already canonical, `serialize(parse(bytes)) == bytes`. When the input was not canonical (tabs, irregular blank lines, out-of-order frontmatter keys), `serialize` produces the canonical rendering; the first save through the editor or `specman new` will show as a single normalizing diff. This is intentional — it gives the repo a one-time convergence toward canonical form rather than perpetuating arbitrary formatting.

`serialize` never fails on a `ParsedSpec` produced by `parse`. A `ParsedSpec` constructed by hand (e.g. by the editor) may in principle contain values the serializer cannot render (e.g. frontmatter with unsupported YAML types); in that case it raises a `SerializeError` naming the offending field. Such errors are programmer errors, not user errors — they indicate a caller bug, not a malformed file.

## Constraints

- **Single-file scope for parsing.** One input, one output value. No batch, stream, or multi-file API at the parse layer.
- **Parsing is pure and deterministic.** Same input bytes ⇒ same `ParsedSpec` or same `ParseError`. No I/O, no caching, no cross-call state.
- **Serialization is pure and deterministic.** Same `ParsedSpec` ⇒ same bytes, every call.
- **Canonical serialization is the only serialization.** There is no "preserve original formatting" mode. Any call to `serialize` produces canonical form.
- **Round-trip is byte-identical for canonical input.** `serialize(parse(bytes)) == bytes` when `bytes` is already canonical. This is the invariant FEAT-0001 AC-8 relies on.
- **Parser → serializer equivalence.** For every `ParsedSpec` produced by `parse` (on any well-formed input), `parse(serialize(ps))` produces a `ParsedSpec` equivalent to `ps` — same frontmatter map, same section list, same acceptance criteria list.
- **A `ParseError` always names exactly one file and one location.**
- **Sections and acceptance criteria are ordered by source position** in `ParsedSpec`; serializer preserves that order.
- **Parsing never partially succeeds.** A call returns either a fully valid `ParsedSpec` or a `ParseError` — never "mostly parsed with warnings."
- **Serialization never partially succeeds.** Either the full canonical bytes or a `SerializeError`.

## Examples

Parsing a well-formed input at `specs/FEAT-0042-reset.md`:

```markdown
---
id: FEAT-0042
title: Password reset via email
status: draft
depends_on: []
---

## Intent

Let users regain account access without contacting support.

## Acceptance criteria

- AC-1: Given a registered email, a reset link is delivered within 1 minute.
```

`parse` returns a `ParsedSpec` with:

- `frontmatter = { id: "FEAT-0042", title: "Password reset via email", status: "draft", depends_on: [] }`
- `sections = [("Intent", "Let users regain account access without contacting support.\n"), ("Acceptance criteria", "- AC-1: Given a registered email, a reset link is delivered within 1 minute.\n")]`
- `acceptance_criteria = [("AC-1", "Given a registered email, a reset link is delivered within 1 minute.")]`

Given the same file with `status: 42`, the parser succeeds and returns `frontmatter.status = 42` (an integer). The policy that `status` must be a string is FEAT-0001's, and the validator reports the violation.

Given a file whose frontmatter block is malformed YAML (e.g. unclosed bracket on the `depends_on` line), the parser returns a `ParseError { path: "specs/FEAT-0042-reset.md", line: 5, reason: "malformed YAML: ..." }` — there is no structured representation to return.

### Round-trip

Serializing the `ParsedSpec` from the above example produces bytes byte-identical to the input. A caller that adds a new acceptance criterion and serializes produces a file differing from the original only in the modified `## Acceptance criteria` section — other sections, frontmatter, and whitespace are preserved.

### Canonicalizing non-canonical input

Given a file with frontmatter keys in a non-canonical order and irregular blank lines between sections:

```markdown
---
title: Password reset via email
id: FEAT-0042
depends_on: []
status: draft
---



## Intent
Let users regain account access without contacting support.


## Acceptance criteria
- AC-1: Given a registered email, a reset link is delivered within 1 minute.
```

`parse` succeeds and produces a `ParsedSpec` equivalent to the canonical example above. `serialize` of that `ParsedSpec` produces the canonical bytes — a one-time normalizing diff on first save.

## Acceptance criteria

- AC-1: Given a well-formed spec file, `parse` returns a `ParsedSpec` whose `frontmatter` contains every key present in the YAML block (with YAML-parsed values as-is), whose `sections` lists every `##` heading and its raw body in source order, and whose `acceptance_criteria` lists every AC bullet from the `## Acceptance criteria` section in source order.
- AC-2: Given malformed YAML frontmatter, `parse` returns a `ParseError` naming the line within the frontmatter block.
- AC-3: Given a frontmatter field whose YAML-parsed value is of an unexpected type (e.g. `status: 42`), `parse` does not fail — the value is placed into `frontmatter` as YAML parsed it, for the validator to judge against FEAT-0001.
- AC-4: Given a spec that omits a required frontmatter field or a required body section, `parse` does not fail — the field is simply absent from `frontmatter` and/or the section is absent from `sections`.
- AC-5: Given a required body section present with an empty body, `parse` returns it in `sections` with an empty body string; this is not a parser error.
- AC-6: Given an `## Acceptance criteria` section, every bullet whose text starts with `AC-<N>` (where `<N>` is one or more digits) followed eventually by a `:` is extracted as an acceptance criterion. The ID is `AC-<N>`. Any text between the ID and the first `:` (e.g. a platform marker like `*(web only)*`) is ignored for ID extraction but preserved in the raw text. The AC text is everything after the first `:`, captured verbatim. Extraction is in source order.
- AC-7: Given a bullet matching the AC pattern outside the `## Acceptance criteria` section, `parse` does not include it in `acceptance_criteria`.
- AC-8: Given two acceptance criteria within a single file declaring the same ID, both entries appear in `acceptance_criteria` in source order — `parse` does not fail or deduplicate. The validator flags the duplicate.
- AC-9: Given any `ParseError`, the returned value carries at minimum a path and a line number sufficient for an editor or CLI to point the user at the problem.
- AC-10: Given a `ParsedSpec` produced by `parse`, `serialize(parse(bytes))` returns `bytes` byte-for-byte when `bytes` was already in canonical form.
- AC-11: Given a `ParsedSpec` `ps`, `parse(serialize(ps))` returns a `ParsedSpec` equivalent to `ps` (same frontmatter map, same section list in the same order, same acceptance criteria list in the same order).
- AC-12: Given a non-canonical but well-formed input (e.g. frontmatter keys in non-canonical order, irregular blank lines between sections), `parse(bytes)` succeeds and `serialize(parse(bytes))` produces canonical bytes that differ from `bytes` only in formatting, never in structure or content.
- AC-13: Given two calls to `serialize` on the same `ParsedSpec` value, the returned bytes are byte-identical.
- AC-14: Given a `ParsedSpec` whose `sections` list is in a non-canonical order (e.g. `## Acceptance criteria` before `## Intent`), `serialize` emits sections in the order given — it does not reorder against FEAT-0001's recommended canonical order.
- AC-15: Given a `ParsedSpec` carrying a frontmatter value the serializer cannot render (e.g. an unsupported YAML type introduced by a buggy caller), `serialize` raises a `SerializeError` naming the offending field; this does not occur for any `ParsedSpec` produced by `parse`.

## Out of scope

- Cross-file validation — duplicate `id`, broken `depends_on`, orphan snapshots, filename conventions. These belong to the validator (FEAT-0007).
- Rendering `ParseError` or `SerializeError` as human-readable strings. The CLI and editor format errors for display.
- Full markdown AST for section bodies. Bodies are raw markdown strings; consumers that need deeper structure parse it themselves.
- Filesystem I/O in either direction. Callers read bytes from disk and pass them in; callers write returned bytes to disk. The module does not touch the filesystem.
- Implementation choices: language, YAML library, markdown library, concrete error type hierarchy.
- Migration of existing non-canonical specs. Canonicalization happens opportunistically on first save of any spec; there is no batch "`specman format`" command (add later if a real need surfaces).

## Non-goals

- The parser does not enforce FEAT-0001's policy rules. Required fields, declared types, required sections, non-empty required bodies, AC-ID uniqueness within a spec, `status` enum — all belong to the validator (FEAT-0007). Judging structure at the parser layer would silently prevent downstream tools (including the editor in raw-text fallback mode) from loading anything that isn't yet fully valid.
- The parser never partially succeeds. No "parsed with warnings" mode, no best-effort recovery. Either a `ParsedSpec` or a `ParseError`.
- The parser emits one blocking error per call, not a list. Multi-error reporting across a whole file is the validator's job; the parser stops at the first structural failure.
- No preserving-serialization mode. There is one canonical form; `serialize` always produces it. A "preserve arbitrary input formatting" option would mean storing original bytes alongside `ParsedSpec` and would make the round-trip invariant conditional on hidden state — not worth the complexity for what is a one-time first-save diff.
- The parser and serializer are stateless. No caching, memoization, or cross-call optimization. Callers that need caching provide it.
- Serialization does not validate. A caller may construct a `ParsedSpec` that violates FEAT-0001's policy (e.g. missing `## Intent`) and `serialize` will happily produce bytes for it. The validator exists to catch this; duplicating the check here would fork the policy.

## Open questions

- Should section bodies carry starting line numbers so editors and diff tools can point into the file? *Decide when the editor (FEAT-0002) surfaces a concrete need for error-to-location mapping.*
- Should `parse` return a partial `ParsedSpec` (frontmatter only) alongside a `ParseError` for the editor's raw-text fallback (FEAT-0002 AC-7)? *Decide when implementing the fallback — depends on whether the editor needs frontmatter for malformed bodies.*
- What is the exact threshold where `depends_on` and `platforms` switch from flow style (`[a, b]`) to block style (one per line)? *Pick a concrete rule — e.g. "flow style when the serialized line would exceed 80 columns" — during implementation; document in a serializer conformance test.*
- Should a future `specman format` command exist to batch-canonicalize an entire repo in one commit? *Defer until a concrete need surfaces — first-save canonicalization covers 99% of cases organically.*
