// invariant-audit — entry point.
//
//   npx invariant-audit                 scan the working tree
//   npx invariant-audit --check         exit 1 on anything not baselined
//   npx invariant-audit --write-baseline  seed the baseline from this run
//
// Exit codes are three, not two:
//   0  clean
//   1  findings that are not in the baseline
//   2  the AUDITOR failed its own invariants, or crashed
// Separating 1 from 2 matters: "the code is broken" and "the tool is broken" must
// not arrive as the same signal, or a broken tool reads as a broken codebase.

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fingerprint, loadBaseline, partition, sortFindings, validate, type Finding } from "./findings.ts";
import { RULES, runRules, unknownSuppressions, walkFiles, type Rule } from "./rules.ts";
import { checkInvariants, openTrace, summarize, writeReport } from "./report.ts";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const argOf = (flag: string, fallback: string): string => {
	const i = argv.indexOf(flag);
	return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

if (has("--help") || has("-h")) {
	console.log(`invariant-audit — scan source for architectural invariants that have eroded

  invariant-audit [options]

  --root <dir>        tree to scan (default: cwd)
  --out <dir>         where the run artifacts land, relative to cwd (default: .invariant/last)
  --baseline <file>   the scanned tree's ledger of accepted findings (default: <root>/.invariant/baseline.json)
  --rules <file>      a module default-exporting Rule[] — replaces the built-ins
  --check             exit 1 on findings absent from the baseline
  --write-baseline    write every current finding into the baseline
  --json              print findings as JSON instead of text

  exit 0 clean · 1 findings not baselined · 2 the auditor itself failed`);
	process.exit(0);
}

const ROOT = resolve(argOf("--root", process.cwd()));

// The baseline belongs to the tree being scanned — it is that project's ledger, so
// `--root elsewhere` should read elsewhere's baseline. Output does not: artifacts are the
// caller's, and resolving them against --root writes a directory into someone else's repo
// just because you scanned it. They coincide in the common case, where root is cwd.
const underRoot = (flag: string, fallback: string) => {
	const v = argOf(flag, fallback);
	return isAbsolute(v) ? v : join(ROOT, v);
};
const underCwd = (flag: string, fallback: string) => {
	const v = argOf(flag, fallback);
	return isAbsolute(v) ? v : resolve(process.cwd(), v);
};
const OUT = underCwd("--out", ".invariant/last");
const BASELINE = underRoot("--baseline", ".invariant/baseline.json");
const CHECK = has("--check");
const JSON_OUT = has("--json");
const WRITE_BASELINE = has("--write-baseline");
const RULES_FILE = argv.includes("--rules") ? underCwd("--rules", "") : null;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
	dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
	red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
	yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
	green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
};

const SEVERITY_COLOR = { high: c.red, medium: c.yellow, low: c.dim } as const;

function printFindings(label: string, findings: Finding[]): void {
	if (!findings.length) return;
	console.log(`\n${c.bold(label)}`);
	for (const f of sortFindings(findings)) {
		console.log(`  ${SEVERITY_COLOR[f.severity](f.severity.padEnd(6))} ${f.file}:${f.line}  ${c.dim(f.rule)}`);
		console.log(`         ${f.message}`);
		if (f.evidence) console.log(`         ${c.dim(f.evidence.slice(0, 120))}`);
	}
}

async function loadRules(): Promise<Rule[]> {
	if (!RULES_FILE) return RULES;
	// A module, not a config format. Rules are code; a declarative layer over eight of
	// them would be more code than the rules and could express less.
	const mod = await import(pathToFileURL(RULES_FILE).href);
	const rules = mod.default ?? mod.rules;
	if (!Array.isArray(rules) || !rules.every((r) => r && typeof r.id === "string" && typeof r.scan === "function")) {
		throw new Error(`${RULES_FILE} must default-export an array of Rule objects.`);
	}
	return rules;
}

async function main(): Promise<number> {
	const startedAt = Date.now();
	mkdirSync(OUT, { recursive: true });
	const { trace, path: tracePath } = openTrace(OUT);

	// Read the baseline first: a malformed one is fatal regardless of findings, and
	// failing before doing the work makes the cause obvious.
	const baseline = loadBaseline(BASELINE);
	const rules = await loadRules();

	const t0 = Date.now();
	const found = await runRules(ROOT, rules);
	trace({ phase: "rules", ms: Date.now() - t0, note: `${found.length} finding(s) from ${rules.length} rule(s)` });
	if (!JSON_OUT) console.log(c.dim(`scanned in ${Date.now() - t0}ms · ${rules.length} rules · ${found.length} finding(s)`));

	// A typo'd annotation suppresses nothing while looking like it does, which is worse
	// than no annotation at all.
	const typos: string[] = [];
	await walkFiles(ROOT, ROOT, async (abs, r) => {
		// Test files carry deliberately bogus ids as fixtures — including the typo this very
		// check exists to catch — so scanning them reports a suite's own inputs.
		if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|html)$/.test(r) || /\.(test|spec)\.[a-z]+$/.test(r)) return;
		const { readFile } = await import("node:fs/promises");
		for (const id of unknownSuppressions(await readFile(abs, "utf8"), rules)) typos.push(`${r}: audit-ok(${id})`);
	});

	const { kept, dropped } = await validate(ROOT, found);

	const byId = new Map<string, Finding>();
	for (const f of kept) {
		const id = fingerprint(f);
		if (!byId.has(id)) byId.set(id, f);
	}
	const findings = [...byId.values()];
	const parts = partition(findings, baseline);

	const summary = summarize({
		startedAt,
		root: ROOT,
		model: null,
		parts,
		emitted: 0,
		droppedInvalid: dropped.length,
		guard: { steps: 0, blocked: 0, jailRejections: 0 },
		exhausted: null,
		investigations: [],
	});
	summary.invariants = checkInvariants(summary, tracePath, findings);

	const notes: Record<string, string> = {};
	for (const [id, entry] of Object.entries(baseline.accepted)) notes[id] = entry.note;
	writeReport(OUT, summary, parts, notes);

	if (WRITE_BASELINE) {
		const accepted = { ...baseline.accepted };
		for (const f of findings) {
			accepted[fingerprint(f)] ??= {
				rule: f.rule,
				file: f.file,
				// Deliberately a placeholder rather than a plausible sentence. An entry nobody
				// has justified should look unjustified — and loadBaseline rejects an empty
				// note, so it cannot be left blank either.
				note: "TODO: state why this is accepted, or fix it and remove this entry.",
			};
		}
		mkdirSync(join(BASELINE, ".."), { recursive: true });
		writeFileSync(BASELINE, JSON.stringify({ accepted }, null, 2) + "\n");
		console.log(`\nwrote ${Object.keys(accepted).length} entr(ies) to ${BASELINE}`);
		console.log(c.yellow("every note says TODO — replace them before committing, or the gate means nothing"));
		return 0;
	}

	if (JSON_OUT) {
		console.log(JSON.stringify({ fresh: parts.fresh, known: parts.known, resolved: parts.resolved, summary }, null, 2));
	} else {
		printFindings(`new (${parts.fresh.length})`, parts.fresh);
		if (parts.known.length) console.log(`\n${c.dim(`baselined: ${parts.known.length} finding(s) — see ${join(OUT, "report.md")}`)}`);
		if (parts.resolved.length) {
			console.log(`\n${c.green(`resolved: ${parts.resolved.length} baseline entr(ies) no longer match — prune them`)}`);
			for (const id of parts.resolved) console.log(c.dim(`  ${id}  ${baseline.accepted[id]?.rule ?? ""}`));
		}
		if (typos.length) {
			console.log(`\n${c.yellow("annotations naming a rule that does not exist (these suppress nothing):")}`);
			for (const t of typos) console.log(c.yellow(`  ${t}`));
		}
		console.log(`\n${c.dim(`artifacts: ${OUT}`)}`);
	}

	// The auditor's own health outranks the codebase's: a failed invariant means every
	// number above is suspect, so it must not be reported as either a clean or dirty tree.
	if (summary.invariants.length) {
		console.log(c.red(`\nAUDITOR SELF-CHECK FAILED — findings above are not trustworthy:`));
		for (const v of summary.invariants) console.log(c.red(`  - ${v}`));
		return 2;
	}
	if (typos.length && CHECK) return 1;
	if (CHECK && parts.fresh.length) {
		console.log(c.red(`\n${parts.fresh.length} finding(s) not in the baseline.`));
		console.log(c.dim(`Fix them, annotate with "// audit-ok(<rule-id>): reason", or add a baseline entry with a note.`));
		return 1;
	}
	if (!parts.fresh.length && !JSON_OUT) console.log(c.green("\nno new findings"));
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		// A crash is an auditor failure, not a verdict on the codebase.
		console.error(c.red(`invariant-audit failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
		process.exit(2);
	});
