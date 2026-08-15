<div align="center">

# invariant‑audit

### Find the architectural invariants your codebase has quietly stopped holding.

![Node](https://img.shields.io/badge/node-%E2%89%A522-3C873A?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-6E56CF)
![CI](https://img.shields.io/github/actions/workflow/status/siroxou/invariant-audit/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white&color=2ea44f)
![License](https://img.shields.io/badge/license-MIT-6E56CF)

</div>

---

## What it is

Most of your codebase already does the right thing. Three of your four `spawn` calls
attach an `'error'` listener. Three of your five `fetch` calls pass an `AbortSignal`. The
discipline exists — it just isn't written down anywhere, so nothing notices when the
fourth one arrives.

`invariant-audit` writes it down. Each rule asserts a property your code **already holds
at every site but one or two**, which is what makes it enforceable without asking anyone
to change how they write code.

That is different from a linter. A linter says *this style is discouraged*. An invariant
says *this architectural property was deliberately established and must not silently
disappear*. The test for whether something belongs here: **can you name the day it broke
and what broke because of it?** If not, it is a style rule and does not belong in a gate.

```bash
npx invariant-audit            # scan
npx invariant-audit --check    # exit 1 on anything not baselined
```

No config file. No AST. No dependencies. ~50 ms on a 6k‑line repo.

---

## The rules

| Rule | Sev | Fires when |
|------|:---:|-----------|
| `spawn-no-error-listener` | high | a `spawn` handle never gets `.on("error")`. `'error'` is emitted asynchronously, so a surrounding `try/catch` never sees it and an unhandled one takes the process down |
| `ws-server-no-origin-check` | high | a `WebSocketServer` has no origin or upgrade check. WebSocket handshakes are exempt from the same‑origin policy, so binding to loopback does not stop a web page connecting |
| `fetch-no-timeout` | med | `fetch` without an `AbortSignal`. A hung remote leaves the caller pending forever |
| `download-without-integrity` | med | a file is fetched and written to disk with no checksum anywhere in sight |
| `regexp-non-literal-source` | med | a `RegExp` is built from something other than a literal. A review trigger, not a ReDoS detector — see limits |
| `innerhtml-interpolated` | med | an unescaped interpolation reaches `innerHTML` |
| `promise-timer-never-cleared` | low | a promise deadline is armed and never disarmed. A sleep is not a deadline — only a timer that *rejects* counts |

Plus `layering(...)`, which is a factory rather than a fixed rule, because only your
project knows its layers:

```ts
// invariant.rules.mjs
import { RULES, layering } from "invariant-audit";

export default [
  ...RULES,
  layering({ "src/core": ["src/ui", "src/electron"] }, { typeOnly: true }),
];
```

```bash
npx invariant-audit --rules invariant.rules.mjs --check
```

A module, not a config format. Rules are code — a declarative layer over eight of them
would be more code than the rules and could express less.

### Rules deliberately not shipped

The most useful table here. **A bad rule is worse than no rule**, because it teaches
people to ignore the tool and takes the good rules down with it.

| Not a rule | Why |
|------------|-----|
| Empty `catch {}` | In the codebase this was built against, all eleven were intentional and commented. A rule that is 100 % false positives on day one gets muted |
| File length / "god file" | Measures a proxy for the thing rather than the thing. A composition root is long because composition roots are long |
| Unchecked index access | A scanner would relitigate, worse, what `noUncheckedIndexedAccess` already models |
| Anything decidable by running code | If a property can be checked by executing one line, write a test. A scanner can assert a concept is *present*, never that it is *correct* |

---

## The baseline

Findings that predate the gate go in `.invariant/baseline.json`, and the gate passes on
them. It is **a deferral ledger, not an absolution**.

```bash
npx invariant-audit --write-baseline   # seed it, then write a real note per entry
```

**Every entry needs a non‑empty note or the tool refuses to run.** That single constraint
is what stops the file decaying into a suppression dump where entries accumulate and
nobody remembers why. One sentence each is the whole price.

Fingerprints are `sha256(rule + file + evidence)` and **deliberately exclude the line
number**. Adding an import shifts every line beneath it; a line‑keyed baseline would report
all of them as new, turning the gate red for reasons nobody caused — and a gate that cries
wolf is one people learn to route around. The cost: two byte‑identical violations in one
file collapse to a single entry, which is the right trade — they are the same defect twice.

A baseline entry with no matching finding is reported as **resolved** and does *not* fail
the build. Failing on a bug someone just fixed is how a gate gets disabled.

### Annotating a false positive

In the code, where it belongs, rather than in a JSON file:

```ts
// audit-ok(regexp-non-literal-source): the interpolated value is regex-escaped inline
const re = new RegExp(`^${escape(name)}$`);
```

The rule id and a reason are both required — a bare `audit-ok` suppresses nothing. The run
also reports any annotation naming a rule that does not exist, because a typo suppresses
nothing while looking like it does.

---

## In CI

```yaml
- run: npx invariant-audit --check
```

**Exit codes.** `0` clean · `1` findings not in the baseline · `2` the auditor failed its
own self‑checks, or crashed. The third is separate on purpose: "the code is broken" and
"the tool is broken" must not arrive as the same signal, or a broken tool reads as a broken
codebase.

Every run also writes `.invariant/last/` — `trace.jsonl`, `summary.json` and `report.md`.
Upload it as an artifact and the report is readable straight from the run.

One deliberate hole: a contributor can add a violation *and* baseline it in the same pull
request, and the gate passes. That is intentional. The baseline diff shows up in review as
a plain‑English sentence explaining why it is acceptable. The gate's job is to convert a
silent regression into a reviewable sentence, not to make regressions impossible — making
them impossible just pushes people to disable the tool.

---

## Writing a rule

```ts
import type { Rule } from "invariant-audit";

export const myRule: Rule = {
  id: "my-rule",
  severity: "medium",
  message: "What is wrong, and what it causes.",
  include: /\.ts$/,            // tested against the repo-relative, forward-slashed path
  scan(src, code, path) {      // `code` has comments and string bodies blanked
    return [];                 // → [{ line, evidence }]
  },
};
```

Scan `code`, report against `src`. That is what `stripped()` is for: it blanks the
*contents* of comments and string literals while preserving every offset and newline, so a
match index still maps to the right line. Without it a tool like this reports itself — this
README names `fetch(` and `spawn(` in prose, and the rules describe their own patterns in
comments.

Then write a fixture test with a hit **and a near‑miss**. The near‑miss is the important
half: a rule that cannot tell a compliant call from a defective one is noise with extra
steps. Measure the hit count on a real tree before shipping it.

---

## Limits

Stated plainly, because a tool that oversells itself is worse than one that doesn't.

- **Regex over prepared source.** No AST, no data flow, no type information. It asserts a
  safety concept is *present*, never that it is *correct*. `ws-server-no-origin-check`
  confirms a file mentions `verifyClient`; whether that check is right is a job for a test.
- **A green run means "no new findings", not "no findings."**
- **`regexp-non-literal-source` cannot detect ReDoS** and does not claim to. It flags that
  a pattern is built from a non‑literal, which is a review trigger.
- **Two byte‑identical violations in one file share a fingerprint** — a deliberate
  consequence of leaving line numbers out.
- **It only reads text.** Anything that needs execution to decide belongs in a test.

---

## Provenance

Built while auditing [local-language-machine](https://github.com/siroxou/local-language-machine),
an offline coding IDE, where the first run turned up 30 findings including three
high‑severity ones — an unauthenticated control socket, a path jail that compared strings
instead of resolving symlinks, and a `spawn` whose async `'error'` event took the whole
process down. Every rule here earned its place by catching something real.

That project also runs a second, model‑driven pass over the same finding pipeline. It is
not in this package: it needs an inference engine, and the interesting half of the work —
the rules, the baseline, the fingerprinting — is the half that runs in 50 ms with nothing
installed.

## License

[MIT](LICENSE) — use it, fork it, ship it.
