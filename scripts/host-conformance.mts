/**
 * CLAUDE HOST CONFORMANCE — classifies the host-dependent gate into ONE exit
 * code a CI job can block on.
 *
 *   A GATE THAT CANNOT BLOCK A REAL FAILURE IS NOT A GATE
 *   NOT_APPLICABLE != PASS — AND NOT_APPLICABLE MUST NEVER MASK A FAIL
 *
 * `verify-host-tool-conformance.mts` distinguishes exit 0 (PASS) / 1 (FAIL
 * or INCONCLUSIVE) / 3 (NOT_APPLICABLE — `claude` absent from PATH, the
 * expected case on every hosted GitHub runner today). `ci.yml` used to carry
 * `continue-on-error: true` at JOB level to tolerate that expected exit 3 —
 * but that swallows exit 1 identically, which means a genuine FAIL on a
 * runner that DOES have `claude` (stale catalog, divergent agent delivery)
 * was reported green. This script is what the CI step calls instead of the
 * gate directly: it runs it, keeps its stdout/stderr verbatim
 * (`stdio: "inherit"`), classifies the exit code, and returns 0 ONLY for
 * PASS or NOT_APPLICABLE — the two states CI is allowed to treat as
 * non-blocking — 1 for anything that resolves to FAIL.
 *
 * `gates` stays an array and the classification (`anyFail` / `allNotApplicable`)
 * stays generic over it — not collapsed to a single-value special case —
 * so a future second host-dependent gate slots back in without rewriting the
 * combination logic: FAIL always wins, NOT_APPLICABLE never masks it, ALL
 * NOT_APPLICABLE only when every gate agrees.
 * `verify-agent-delegation.mts` was the second gate here; it was removed as
 * a mechanical casualty of the `src/lib/agent/delegation` module cut
 * (cfdf5289, block j) and was never restored or replaced — this wrapper does
 * not reference it. The second slot is now `verify-agent-visibility.mts`
 * (2026-09-22): asks the host which agents it actually RESOLVES, after 18
 * specialists were added to `assets/agents/` and nothing measured whether a
 * delivered file ever becomes a callable agent.
 *
 * `NEXOS_HOST_CONFORMANCE_HOST_GATE` exists ONLY so
 * `counterfactual-host-conformance.mts` / `verify-ci-gate-conformance.mts`
 * can inject a stub exit code (PASS/FAIL/NOT_APPLICABLE) without a real
 * `claude` binary — same override pattern as `NEXOS_HOST_TOOL_CATALOG` in
 * host-tool-catalog.mts. Unset, this runs the real gate, unchanged.
 *
 *   uso: npx tsx scripts/host-conformance.mts
 */
import { spawnSync } from "node:child_process";

type GateState = "PASS" | "FAIL" | "NOT_APPLICABLE";

function classify(exitCode: number | null): GateState {
  if (exitCode === 0) return "PASS";
  if (exitCode === 3) return "NOT_APPLICABLE";
  return "FAIL"; // 1, any other code, or null (signal-killed) — default is BLOCKING, never silent
}

interface GateRun {
  readonly label: string;
  readonly cmd: string;
  readonly exitCode: number | null;
  readonly state: GateState;
}

function runGate(label: string, defaultCmd: string, overrideEnv: string): GateRun {
  const cmd = process.env[overrideEnv] ?? defaultCmd;
  console.log(`\n── ${label} (\`${cmd}\`) ──`);
  const result = spawnSync(cmd, { shell: true, stdio: "inherit" });
  return { label, cmd, exitCode: result.status, state: classify(result.status) };
}

const gates: readonly GateRun[] = [
  runGate("host tool conformance", "npx tsx scripts/verify-host-tool-conformance.mts", "NEXOS_HOST_CONFORMANCE_HOST_GATE"),
  runGate("agent visibility", "npx tsx scripts/verify-agent-visibility.mts", "NEXOS_HOST_CONFORMANCE_AGENT_GATE"),
];

const anyFail = gates.some((g) => g.state === "FAIL");
const allNotApplicable = gates.every((g) => g.state === "NOT_APPLICABLE");
const overall: GateState = anyFail ? "FAIL" : allNotApplicable ? "NOT_APPLICABLE" : "PASS";

console.log(`\n── CLAUDE HOST CONFORMANCE ──`);
for (const g of gates) console.log(`  ${g.state.padEnd(15)} ${g.label} (exit=${String(g.exitCode)})`);
console.log(`\nHOST_CONFORMANCE=${overall}\n`);

process.exit(overall === "FAIL" ? 1 : 0);
