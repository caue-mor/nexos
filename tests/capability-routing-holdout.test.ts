/**
 * A RÉGUA NÃO PODE MUDAR EM SILÊNCIO.
 *
 * Este holdout arbitra a aceitação do defeito #2/B. Um acceptance cuja régua
 * pode ser editada por quem é medido por ela não é acceptance — e a tentação
 * é concreta: basta "ajustar um caso" para o gate passar.
 *
 * Vivia em `/tmp` até 2026-09-21, dependendo de o sistema não limpar o
 * diretório. Versionado aqui byte a byte, com o mesmo sha256.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/capability-routing/capability-routing-holdout-v1.json"
);

/** SHA-256 do CONTEÚDO, não commit git — ver PROVENANCE.md. */
const SHA256 = "f7da8ca2bc906a9084148a26a0d1dfcee45c042240044f330679784da035b5f4";

describe("holdout de capability routing · a régua é imutável", () => {
  it("o conteúdo bate com o sha256 congelado", () => {
    const buf = fs.readFileSync(FIXTURE);
    expect(
      createHash("sha256").update(buf).digest("hex"),
      "a régua de aceitação do defeito #2/B mudou. Se foi intencional, é um " +
        "holdout NOVO, com identidade nova e independência nova — não uma edição desta."
    ).toBe(SHA256);
  });

  it("a composição que os gates pressupõem continua valendo", () => {
    /**
     * A raiz é um objeto com `tasks`, não um array. Presumi array na primeira
     * versão e o teste quebrou com "casos.filter is not a function" — leitura
     * do formato, não do conteúdo. O holdout carrega também `holdout_version`,
     * `created`, `catalog_source` e `rules`, que este teste não julga.
     */
    const raiz = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as {
      readonly tasks: readonly Record<string, unknown>[];
    };
    const casos = raiz.tasks;
    expect(Array.isArray(casos), "o holdout deixou de expor `tasks` como lista").toBe(true);
    const noMatch = casos.filter((c) => c.expected === "NO_ELIGIBLE_CAPABILITY");
    expect(casos, "36 tarefas").toHaveLength(36);
    expect(noMatch, "5 casos NO_ELIGIBLE — o gate exige 5/5").toHaveLength(5);
    expect(casos.length - noMatch.length, "31 positivas — o gate exige >= 30/31").toBe(31);
  });

  it("nenhum caso carrega rótulo DISABLED/GAP — essa distinção é UNKNOWN de propósito", () => {
    const cru = fs.readFileSync(FIXTURE, "utf-8");
    expect(
      /CAPABILITY_DISABLED|CAPABILITY_GAP/.test(cru),
      "alguém rotulou os no-match para fazer o gate 4 passar: isso contamina a independência do holdout"
    ).toBe(false);
  });
});
