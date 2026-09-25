/**
 * QUALITY RECIPE CONFORMANCE — the detector for Counterfactual D.
 *
 *   A GREEN GATE THAT CANNOT GO RED IS NOT A GATE
 *   QUALITY RECIPE = ONE AUTHORITY
 *
 * Fixing the 4 divergent gate definitions once is easy. Keeping them from
 * drifting apart again is the hard part — nothing stops a future edit from
 * reintroducing `npm run lint` (or any other literal gate list) as a FIFTH
 * competing authority in a consumer file. This script is that stop: it reads
 * the REAL consumer files and the REAL resolved recipe, and fails when any
 * consumer disagrees with `resolveProjectQualityRecipe` instead of deriving
 * from it.
 *
 * Static source inspection (regex/text checks against known consumer files),
 * not a general-purpose linter — cheap to run, cheap to reason about, and
 * exactly targeted at the defect this recovery closes. See
 * `scripts/counterfactual-quality-recipe.mts` for the RED/GREEN proof that
 * this detector actually catches the reintroduction it claims to.
 *
 *   uso: npx tsx scripts/verify-quality-recipe-conformance.mts
 */
import fs from "fs-extra";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveProjectQualityRecipe } from "../src/lib/quality-recipe.js";

const ROOT = process.cwd();
const provas: Array<{ n: string; ok: boolean; detail: string }> = [];
const checar = (n: string, ok: boolean, detail: string): void => void provas.push({ n, ok, detail });

console.log("\n── QUALITY RECIPE CONFORMANCE ──\n");

const recipe = await resolveProjectQualityRecipe(ROOT);
checar(
  "0 receita canônica completa",
  recipe.complete,
  recipe.complete
    ? recipe.recipes.map((r) => r.gate).join(", ")
    : `categoria(s) obrigatória(s) ausente(s): ${recipe.missing.join(", ")}`
);

// ── src/commands/verify.ts (`nexos verify`, publicado em dist/) deriva, não hardcoda ──
const nexosVerifyPath = path.join(ROOT, "src/commands/verify.ts");
const nexosVerifySrc = await fs.readFile(nexosVerifyPath, "utf-8");
const importsResolver = /from\s+["'].*quality-recipe\.js["']/.test(nexosVerifySrc);
const hasHardcodedGateArray = /\bcmd\s*:\s*["']/.test(nexosVerifySrc) ||
  /const\s+GATES\s*:.*=\s*\[/.test(nexosVerifySrc);
checar(
  "1 src/commands/verify.ts deriva de resolveProjectQualityRecipe",
  importsResolver && !hasHardcodedGateArray,
  importsResolver
    ? (hasHardcodedGateArray ? "importa o resolver MAS ainda contém um array de gates hardcoded" : "importa o resolver, sem array de gates próprio")
    : "não importa quality-recipe.js — pode estar hardcoding gates de novo"
);

// ── prova 2 (GATE_MARKERS/CATEGORY_MARKER_PATTERN/hasGatePrecondition em
// permission-gate.ts) removida: o arquivo e o conceito de remote_push
// fail-closed via marcador textual saíram por inteiro com a camada de
// autorização (nexos://decision/p1-0-remover-authorization-layer). Não há
// mais motor para reintroduzir confiança em marcador nele.

// ── prova 3 (codex-delivery-attestation.ts resolveDeliveryGateRecipes)
// removida: o arquivo saiu por inteiro no corte P0 de multi-host (commit
// 75bebd47, "remove Codex host adapter"). Ficava um `await fs.readFile` sem
// try/catch sobre um path que não existe mais — ENOENT não tratado derrubava
// o processo ANTES do loop de `checar()`, então NENHUMA prova rodava,
// inclusive as que continuam válidas (knw_01M2QV49TXGNANQW671N1HW2WG). Sem
// adapter Codex, não há "resolveDeliveryGateRecipes" para provar wrapper —
// não há mais o que checar aqui, não só um arquivo pra reapontar.

// ── ci.yml: todo passo REQUIRED bate com a receita canônica, nenhuma quinta lista ──
const ciPath = path.join(ROOT, ".github/workflows/ci.yml");
const ciRaw = await fs.readFile(ciPath, "utf-8");
const ciDoc = parseYaml(ciRaw) as {
  jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
};
const runSteps = new Set<string>();
for (const job of Object.values(ciDoc.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    if (typeof step.run === "string") runSteps.add(step.run.trim());
  }
}
const requiredRecipes = recipe.recipes.filter((r) =>
  ["typecheck", "test", "build", "secret-scan"].includes(r.category)
);
const missingInCi = requiredRecipes.filter(
  (r) => !runSteps.has(`${r.command} ${r.args.join(" ")}`)
);
checar(
  "4 ci.yml roda a invocação exata da receita para cada categoria obrigatória",
  missingInCi.length === 0,
  missingInCi.length === 0
    ? requiredRecipes.map((r) => `${r.command} ${r.args.join(" ")}`).join(" | ")
    : `ci.yml não roda: ${missingInCi.map((r) => `${r.category} (${r.command} ${r.args.join(" ")})`).join(", ")}`
);

for (const p of provas) console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.n} — ${p.detail}`);
const falhas = provas.filter((p) => !p.ok);
console.log(`\n${falhas.length === 0 ? "PASS" : "FAIL"} — ${provas.length - falhas.length}/${provas.length} provas\n`);
process.exit(falhas.length === 0 ? 0 : 1);
