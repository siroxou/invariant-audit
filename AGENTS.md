# Project memory

A dependency-free scanner for architectural invariants. Reads source as text, reports
what eroded, and gates CI on anything not baselined.

## Commands

```bash
npm test          # node:test, colocated *.test.ts
npm run typecheck # strict, no emit
npm run audit     # run the tool on itself
npm run build     # tsc → dist/
```

## Layout

- `src/rules.ts` — `stripped`, `sliceCall`, `walkFiles`, `RULES`, `layering`, `runRules`
- `src/findings.ts` — schema, fingerprint, baseline, corroboration
- `src/report.ts` — trace, summary, report, self-invariants
- `src/cli.ts` — entry point

## Conventions

- Tabs. ESM only. `node:` prefixes on builtins. `.ts` extensions in relative imports.
- **Zero runtime dependencies.** This is the product, not a preference.
- Comments explain *why*, including approaches tried and rejected.
- Mark a deliberate simplification with `// ponytail:` and name its ceiling.

## Rules

A rule belongs here only if you can name the day it broke and what broke because of it.
Otherwise it is a style rule and does not belong in a gate.

Every rule ships with a fixture test containing a hit **and a near-miss**. A rule that
cannot tell a compliant call from a defective one is noise with extra steps.

Scan `code` (comments and string bodies blanked), report against `src`. Scanning raw
source makes the tool report its own documentation.

## Tests

`node:test` + `node:assert/strict`, colocated. Test names are sentences describing the
behaviour. A fix ships with a test that was **seen failing** first.

## Commits

Imperative, naming the behaviour change rather than the code change.
