/**
 * CANONICAL QUALITY RECIPE — `resolveProjectQualityRecipe` against real fixtures.
 *
 *   QUALITY RECIPE = ONE AUTHORITY
 *   CATEGORY != IMPLEMENTATION
 *
 * Covers three of the five counterfactuals from the recovery this file was
 * written for (B, C, E — see `PLAN.md`/task notes; A is covered against the
 * real trust boundary in `tests/codex-delivery-broker.test.ts`, D against
 * real consumer source in `scripts/counterfactual-quality-recipe.mts`):
 *
 *   B — remove a required category's script → recipe reported INCOMPLETE
 *   C — rename the IMPLEMENTATION (what a script runs) while the script KEY
 *       (the category's declared entry point) stays put → resolved recipe
 *       entry is byte-identical — portability proof
 *   E — no package.json at all → BLOCKED/INCOMPLETE, never silently "empty is fine"
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  QUALITY_CATEGORIES,
  REQUIRED_QUALITY_CATEGORIES,
  resolveProjectQualityRecipe,
} from "../src/lib/quality-recipe.js";

const TMP = fs.realpathSync(os.tmpdir());
let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(TMP, "quality-recipe-"));
});
afterEach(async () => fs.remove(workspace));

async function writeScripts(scripts: Record<string, string>): Promise<void> {
  await fs.writeJson(path.join(workspace, "package.json"), { scripts });
}

describe("resolveProjectQualityRecipe · sanidade contra o próprio nexos-cli", () => {
  it("resolve a receita completa e determinística deste repo", async () => {
    const result = await resolveProjectQualityRecipe(process.cwd());
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.recipes).toEqual([
      { category: "typecheck", gate: "typecheck", command: "npm", args: ["run", "typecheck"] },
      { category: "lint", gate: "lint", command: "npm", args: ["run", "lint"] },
      // `test:all` saiu do package.json em 9f4edf64, junto com `test:engine`,
      // quando o runtime Python sem consumidor deixou de ser distribuído. A
      // receita passou a resolver `test`, corretamente — e este teste ficou
      // com a expectativa antiga por um commit, reprovando por dado velho e
      // não por defeito. Achado por verificação independente em árvore limpa,
      // não pela suíte de quem fez a mudança: quem muda o package.json não
      // costuma desconfiar do teste que lê o package.json.
      { category: "test", gate: "test", command: "npm", args: ["run", "test"] },
      { category: "build", gate: "build", command: "npm", args: ["run", "build"] },
      { category: "secret-scan", gate: "secret-scan", command: "npm", args: ["run", "scan:secrets"] },
    ]);
    // lint continua NAO obrigatorio (REQUIRED_QUALITY_CATEGORIES nao muda) - mas este
    // repo passou a declarar um de verdade (oxlint), entao agora resolve. LINT ABSENT
    // != QUALITY FAILED continua valendo: a ausencia nunca foi o que faltava aqui.
    expect(REQUIRED_QUALITY_CATEGORIES).not.toContain("lint");
    expect(result.recipes.map((r) => r.category)).toContain("lint");
  });
});

describe("Counterfactual B — categoria obrigatória ausente → INCOMPLETE", () => {
  it("falta de script de build é reportada por categoria, não engolida", async () => {
    await writeScripts({
      typecheck: "tsc --noEmit",
      test: "vitest run",
      "scan:secrets": "node scripts/scan-secrets.mjs",
      // build ausente de propósito
    });
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["build"]);
    expect(result.recipes.map((r) => r.category)).toEqual(["typecheck", "test", "secret-scan"]);
  });

  it("um projeto que declara SÓ build (a receita original media 'length>0' como completa) continua INCOMPLETE", async () => {
    // Este é o defeito original medido: `resolveDeliveryGateRecipes` só lançava
    // quando `recipes.length === 0` — UM gate qualquer contava como completo.
    await writeScripts({ build: "tsc" });
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.complete).toBe(false);
    expect(result.recipes.map((r) => r.category)).toEqual(["build"]);
    expect(result.missing).toEqual(["typecheck", "test", "secret-scan"]);
    // "build" resolveu (não está em missing) — mas isso não torna a receita completa.
  });

  it("múltiplas categorias obrigatórias ausentes são nomeadas, todas, não só a primeira", async () => {
    await writeScripts({ typecheck: "tsc --noEmit" });
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["test", "build", "secret-scan"]);
  });
});

describe("Counterfactual C — renomear a IMPLEMENTAÇÃO preserva a CATEGORIA declarada", () => {
  it("mudar o que o script 'build' executa não muda o gate resolvido", async () => {
    await writeScripts({
      typecheck: "tsc --noEmit",
      test: "vitest run",
      build: "tsc",
      "scan:secrets": "node scripts/scan-secrets.mjs",
    });
    const before = await resolveProjectQualityRecipe(workspace);

    // RENOMEIA a implementação: o script "build" agora roda outra coisa
    // inteiramente (um binário diferente, com flags diferentes) — a categoria
    // declarada (a CHAVE "build" em package.json) não muda.
    await writeScripts({
      typecheck: "tsc --noEmit",
      test: "vitest run",
      build: "webpack --config webpack.prod.js && cp -r dist-webpack dist",
      "scan:secrets": "node scripts/scan-secrets.mjs",
    });
    const after = await resolveProjectQualityRecipe(workspace);

    const buildBefore = before.recipes.find((r) => r.category === "build");
    const buildAfter = after.recipes.find((r) => r.category === "build");
    expect(buildAfter).toEqual(buildBefore);
    expect(buildAfter).toEqual({ category: "build", gate: "build", command: "npm", args: ["run", "build"] });
    expect(after.complete).toBe(before.complete);
  });
});

describe("Counterfactual E — nenhuma receita declarável → BLOCKED/INCOMPLETE", () => {
  it("diretório sem package.json nenhum resolve para INCOMPLETE, nunca lança nem finge 'um gate basta'", async () => {
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.complete).toBe(false);
    expect(result.recipes).toEqual([]);
    expect(result.missing).toEqual(REQUIRED_QUALITY_CATEGORIES);
  });

  it("package.json presente mas sem scripts também é INCOMPLETE", async () => {
    await fs.writeJson(path.join(workspace, "package.json"), { name: "empty-project" });
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(REQUIRED_QUALITY_CATEGORIES);
  });

  it("package.json malformado (JSON inválido) degrada para INCOMPLETE, não crash", async () => {
    await fs.writeFile(path.join(workspace, "package.json"), "{ not valid json");
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.complete).toBe(false);
    expect(result.recipes).toEqual([]);
  });
});

describe("ordem determinística", () => {
  it("QUALITY_CATEGORIES e a ordem de recipes resolvidos são a mesma", async () => {
    await writeScripts({
      "scan:secrets": "node scripts/scan-secrets.mjs",
      build: "tsc",
      test: "vitest run",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
    });
    const result = await resolveProjectQualityRecipe(workspace);
    expect(result.recipes.map((r) => r.category)).toEqual([...QUALITY_CATEGORIES]);
  });
});
