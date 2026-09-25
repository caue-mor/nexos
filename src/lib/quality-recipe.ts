/**
 * CANONICAL QUALITY RECIPE — one authority for "which gates does this project require".
 *
 *   QUALITY RECIPE = ONE AUTHORITY
 *   CATEGORY (semantic, cross-project) != IMPLEMENTATION (this project's command)
 *   LINT ABSENT != QUALITY FAILED
 *
 * Measured before this file existed: FOUR independent answers to "which gates".
 *   - the removed authorization-layer gate module's `GATE_MARKERS` — 4 hardcoded regexes on literal npm script names
 *   - `codex-delivery-attestation.ts` `resolveDeliveryGateRecipes` — declarative, but only
 *     4 categories, and `DeliveryGateRecipe.command` was typed as the literal `"npm"`
 *   - `scripts/verified-gates.mts` `GATES` — hardcoded, different runners (`npx`, `node`)
 *   - `.github/workflows/ci.yml` — the one that actually runs per commit, and disagreed
 *     with all three (no typecheck at all)
 *
 * This module separates the two things that were fused:
 *
 *   CATEGORY        the canonical, cross-project semantic (`typecheck`, `test`, `build`,
 *                    `secret-scan`, `lint`). This is what NexOS governs — never the literal
 *                    npm script name of ANY one project. A consumer project may use
 *                    `pnpm test`, `cargo test`, `pytest`, `go test`.
 *   IMPLEMENTATION   this project's command + args for a category. Project detail, resolved
 *                    here (today: read from `package.json.scripts`), never hardcoded by a
 *                    consumer.
 *
 * `resolveProjectQualityRecipe` never throws — same shape as `resolveAvailability` in
 * `./capability/contract.ts`: a pure VERDICT over measured reality, computed fresh every
 * call, never a stored/cached field. A category with no resolvable implementation is
 * reported in `missing`, not silently dropped — `ONE RANDOM GATE != COMPLETE QUALITY
 * RECIPE`, and a caller that needs to enforce completeness (`resolveDeliveryGateRecipes`,
 * `scripts/verified-gates.mts`) decides to throw/exit on `!complete`, not this resolver.
 */
import path from "node:path";
import fs from "fs-extra";
import { z } from "zod";

/** Canonical, cross-project semantic. Execution order = fail-fast-first: static checks
 *  before the test suite, the test suite before the build, the security scan last. */
export const QUALITY_CATEGORIES = ["typecheck", "lint", "test", "build", "secret-scan"] as const;
export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];

/**
 * Categories a COMPLETE recipe must declare, justified from the measured consumers above:
 *
 *   typecheck    TypeScript strict mode is this project's PRIMARY static-quality gate —
 *                there is no linter installed (no dependency, no config, no script).
 *   test         vitest suite — behavioral correctness. Non-negotiable in every consumer.
 *   build        `tsc` emit — what actually ships. `ci.yml`'s `publish` job runs unbuilt
 *                code without this.
 *   secret-scan  the only category that runs UNCONDITIONALLY on every push today
 *                (`ci.yml` `security-scan` job) — dropping it from delivery's own recipe
 *                is exactly the gap this recovery closes (`scan:secrets` "never became a
 *                delivery gate — it did not fit the type").
 *
 * `lint` is deliberately EXCLUDED: this project has no lint script, no linter dependency,
 * no lint config. Its static-quality function is partially supplied by `typecheck:all`
 * (`noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
 * `noUnusedLocals` — see `tsconfig.check.json`). A project that DOES declare a lint script
 * gets it in `recipes` (see `resolveProjectQualityRecipe`) — `lint` is modeled as a
 * category that may legitimately be ABSENT, never as a category that is required and
 * missing.
 */
export const REQUIRED_QUALITY_CATEGORIES: readonly QualityCategory[] = [
  "typecheck",
  "test",
  "build",
  "secret-scan",
];

/**
 * One resolved gate. `category` is the closed, NexOS-governed vocabulary (`QualityCategory`)
 * — what every consumer compares against. `gate` is kept as the open string label the
 * Evidence system (`../evidence.ts` `EvidenceRecord.gate`) and the attestation schema
 * already use everywhere; for now it always equals `category` (no per-project custom
 * labeling is built), kept as a separate field so a narrower enum can evolve without
 * touching the wider string contract Evidence already committed to.
 *
 * `command` is a plain `string`, not the literal `"npm"` this type used to carry
 * (`DeliveryGateRecipe` in `./host/codex-delivery-attestation.ts`, which now re-exports
 * this type under that name) — the literal type structurally could not express
 * `node scripts/scan-secrets.mjs` or `npx tsc`, which is why `scan:secrets` never became
 * an expressible delivery gate.
 */
export interface QualityGateRecipe {
  readonly category: QualityCategory;
  readonly gate: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface QualityRecipeResult {
  readonly recipes: readonly QualityGateRecipe[];
  /** REQUIRED categories with no resolvable implementation. Empty when `complete`. */
  readonly missing: readonly QualityCategory[];
  readonly complete: boolean;
}

/**
 * category -> conventional npm script key, for the ONE backend implemented today
 * (`package.json.scripts`). Sole consumer: `resolveProjectQualityRecipe` — reads
 * `scripts[key]` to resolve the implementation.
 *
 * PERMISSION P2.1 — until this fix, the removed authorization-layer gate module's
 * `hasGatePrecondition` was a SECOND consumer: it built a regex recognizing `npm run <key>` in raw Bash
 * command TEXT, and used that as a precondition to `allow` `remote_push`. That
 * mechanism (`hasGatePrecondition`/`GATE_MARKERS`/`CATEGORY_MARKER_PATTERN`) was
 * REMOVED, not merely disconnected — case-057 (`scripts/test-support/
 * permission-attack-cases.json`) proved that TEXT MATCHING GATE NAMES is not
 * proof any gate ran: a command that only `echo`ed the four names inside a
 * string, never executing them, satisfied every marker and reached `git push`.
 * `remote_push` is now fail-closed unconditionally — no marker of any kind
 * authorizes it — so this table no longer has a second consumer to keep in sync.
 *
 * `test` is handled separately (see `resolvePackageImplementation`): it prefers
 * `test:all` over `test` when both are declared, so "the test gate" means the FULL suite
 * (TS + engine) wherever it is a required precondition, not just the TS half.
 */
const CONVENTIONAL_NPM_SCRIPT: Readonly<Record<QualityCategory, string>> = {
  typecheck: "typecheck",
  lint: "lint",
  test: "test",
  build: "build",
  "secret-scan": "scan:secrets",
};

const packageScriptsSchema = z.object({
  scripts: z.record(z.string(), z.string()).default({}),
});

/**
 * `package.json` missing, unreadable, or malformed resolves to "no scripts" rather than
 * throwing — a project with no derivable recipe is `INCOMPLETE`, not a crash. This is the
 * backend Counterfactual E exercises: no package.json at all still returns a verdict.
 */
async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf-8");
    return packageScriptsSchema.parse(JSON.parse(raw) as unknown).scripts;
  } catch {
    return {};
  }
}

interface Implementation {
  readonly command: string;
  readonly args: readonly string[];
}

function resolvePackageImplementation(
  category: QualityCategory,
  scripts: Readonly<Record<string, string>>
): Implementation | null {
  if (category === "test") {
    if (scripts["test:all"]) return { command: "npm", args: ["run", "test:all"] };
    if (scripts["test"]) return { command: "npm", args: ["run", "test"] };
    return null;
  }
  const key = CONVENTIONAL_NPM_SCRIPT[category];
  return scripts[key] ? { command: "npm", args: ["run", key] } : null;
}

/**
 * The one place every consumer resolves "what does this project need to run to satisfy
 * category X". Deterministic order (`QUALITY_CATEGORIES`), never throws.
 *
 * Portability proof (Counterfactual C): the IMPLEMENTATION — what `npm run typecheck`
 * actually executes internally — is never inspected here, only whether the script KEY
 * exists. Renaming/changing what a script does (e.g. pointing `typecheck` at a stricter
 * `tsconfig.check.json`) changes NOTHING this function returns — `command`/`args` stay
 * `npm run typecheck` — so every consumer that derives from this resolver (instead of
 * hardcoding a direct invocation, the original defect) picks the change up automatically.
 */
export async function resolveProjectQualityRecipe(projectRoot: string): Promise<QualityRecipeResult> {
  const scripts = await readPackageScripts(projectRoot);
  const recipes: QualityGateRecipe[] = [];
  for (const category of QUALITY_CATEGORIES) {
    const impl = resolvePackageImplementation(category, scripts);
    if (impl) recipes.push({ category, gate: category, command: impl.command, args: impl.args });
  }
  const present = new Set(recipes.map((r) => r.category));
  const missing = REQUIRED_QUALITY_CATEGORIES.filter((c) => !present.has(c));
  return { recipes, missing, complete: missing.length === 0 };
}
