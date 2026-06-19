# Code Quality Rubric

Four dimensions, each scored 1–10. A file earns 10/10 on a dimension when
every item in that section is satisfied with no exceptions.

---

## 1. Quality (structural correctness)

A file scores 10 when:

- **Single responsibility** — the file does one thing. If you cannot describe
  it in one sentence without "and", it does too much.
- **No god objects** — no class, hook, or component accumulates unrelated
  concerns because it happens to be the root.
- **No workarounds in the wrong place** — workarounds (stable refs, one-shot
  flags, manual cooldowns) live at the source of the problem, not patched
  over at the call site.
- **No dead logic** — no code that handles conditions that cannot occur, no
  feature flags for shipped features, no backwards-compat shims for callers
  that no longer exist.
- **No error handling theater** — only validates at real system boundaries
  (user input, external API responses). Trusts internal contracts.
- **Correct dependency declarations** — all `useEffect`/`useCallback`/
  `useMemo` deps are accurate; no suppression comments that paper over a
  stale-closure bug.

---

## 2. Readability

A file scores 10 when:

- **Fits in one mental model** — a reader can hold the whole file in their
  head after one pass. In practice: hooks and utilities under ~150 lines,
  components under ~200 lines, orchestrators under ~250 lines.
- **Top-to-bottom narrative** — declarations, derived state, effects, and
  return appear in that order with no backtracking.
- **No destructuring walls** — when a hook returns >8 names, callers group
  them under a namespace or the hook is split.
- **No surprise control flow** — early returns are fine; deeply nested
  conditionals in JSX or effects are not.
- **No magic numbers or strings** — every threshold or key is a named
  constant at the top of the file or in a config module.
- **Consistent naming convention** — all identifiers follow the same
  pattern as the rest of the codebase.

---

## 3. Encapsulation

A file scores 10 when:

- **Minimal public surface** — exports only what callers need; internal
  helpers are not exported.
- **Opaque internals** — callers cannot reach inside and mutate state,
  ref contents, or implementation details.
- **No prop drilling of internals** — if a caller must thread an internal
  implementation detail (a ref, a callback that only the hook should own)
  through multiple layers, the abstraction is wrong.
- **Effects own their side effects** — an effect that belongs inside a hook
  is not hoisted to the component that calls the hook. Each hook manages
  its own subscriptions, timers, and listeners.
- **Stable output identity** — functions and objects returned from hooks are
  stable across renders unless their inputs change. Callers should never need
  to wrap return values in `useCallback` or `useMemo` to stabilise them.

---

## 4. Clarity

A file scores 10 when:

- **Self-documenting names** — identifiers say what they represent without
  needing a comment. No abbreviations unless they are universal in the domain.
- **Comments explain why, never what** — the only comments present capture a
  hidden constraint, a subtle invariant, or a workaround for a specific
  external bug. If removing the comment would not confuse a future reader,
  the comment should not exist.
- **No commented-out code** — dead code is deleted, not archived inline.
- **Canonical vocabulary** — terms match the domain model and are used
  consistently across all files. Two names for the same concept do not
  co-exist.
- **Obvious data flow** — the reader can trace data from source to consumer
  without jumping between files for the happy path.

---

## Scoring Guide

| Score | Meaning |
|-------|---------|
| 10 | Every item above satisfied; no exceptions |
| 8–9 | One minor violation; the reader notices it but is not slowed by it |
| 6–7 | One clear violation that a reviewer would flag; fixable in a single PR |
| 4–5 | Multiple violations; the file is doing more than one job |
| 1–3 | Fundamental structure problem; rewrite, not patch |

A file that scores 8+ on all four dimensions ships. A file that scores below
6 on any dimension is a refactor target before new features are added to it.

---

## Common failure patterns

| Pattern | Dimension hurt | Fix |
|---------|---------------|-----|
| God component / hook | Quality, Encapsulation | Extract sub-hooks or sub-components at natural seams |
| Workaround ref in caller | Quality, Encapsulation | Fix instability at source |
| 20-name destructure at call site | Readability | Split hook or namespace returns |
| Effect with suppressed deps | Quality | Fix stale closure; use a ref if genuinely stable |
| `[...Array(n)].map` | Readability | `Array.from({ length: n }, ...)` |
| Magic number inline | Readability, Clarity | Named constant at top of file |
| Comment restating code | Clarity | Delete the comment |
| Exported internal helper | Encapsulation | Move to module scope, unexported |
| Two names for same concept | Clarity | Pick one; update all call sites |
