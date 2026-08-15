// invariant-audit — public API, for projects adding their own rules.
export { RULES, layering, runRules, stripped, sliceCall, walkFiles, unknownSuppressions, SKIP_DIRS, type Rule, type Hit } from "./rules.ts";
export { fingerprint, loadBaseline, partition, validate, sortFindings, normalizeEvidence, type Finding, type Severity, type Baseline } from "./findings.ts";
export { openTrace, summarize, writeReport, checkInvariants, type Summary, type TraceRecord } from "./report.ts";
