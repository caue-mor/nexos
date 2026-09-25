/**
 * Quanto TRABALHO uma leitura do Store faz — em contagem, não em milissegundos.
 *
 *     MEDI != TRAVEI
 *
 * O ganho de `f6aefb7c` (encadear o cache de integridade na family
 * ProjectCheckpoint) foi medido por um script fora do repositório. A
 * verificação independente apontou o óbvio: script em `$TMPDIR` não é evidência
 * reproduzível, e a suíte inteira tem ZERO asserções de tempo — nenhum teste
 * pegaria uma regressão de latência na leitura do Store.
 *
 * Asserção de tempo também não é a resposta: a própria `vitest.config.ts`
 * documenta que esta suíte já sofreu com contenção de CPU, e um teto em
 * milissegundos vira flake no primeiro runner mais lento.
 *
 *     CONTAR TRABALHO É DETERMINÍSTICO · CRONOMETRAR NÃO É
 *
 * Então o que se trava aqui é o número de `parseCanonical` por leitura — que
 * foi exatamente o instrumento que achou o defeito: com o cache 100% quente
 * (2231 hits, 0 miss) o Store real ainda pagava 2246 parses, porque
 * `resolveCheckpointHead` percorria a capsule uma SEGUNDA vez.
 *
 *     STORE LIDO UMA VEZ != STORE PERCORRIDO UMA VEZ
 *
 * O segundo percurso foi eliminado depois (`resolveCheckpointHeadNoRoot`), e
 * este arquivo é o que impede que ele volte sem ninguém notar — foi assim que
 * ele existiu por tanto tempo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

let parses = 0;
vi.mock("../src/lib/capsule/codec.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/capsule/codec.js")>();
  return {
    ...real,
    parseCanonical: (...args: Parameters<typeof real.parseCanonical>) => {
      parses += 1;
      return real.parseCanonical(...args);
    },
  };
});

const { initializeCapsule } = await import("../src/lib/capsule/initializer.js");
const { publishCanonical } = await import("../src/lib/capsule/store.js");
const { readCurrentRecords } = await import("../src/lib/capsule/reader.js");
const { loadIntegrityCache } = await import("../src/lib/capsule/integrity-cache.js");
const { makeCheckpoint, makeGotcha } = await import("./capsule-fixtures.js");

const CHECKPOINTS = 6;
const GOTCHAS = 4;

let ws: string;
let raiz: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-percurso-"));
  raiz = path.join(ws, "projeto");
  await fs.ensureDir(raiz);

  const init = await initializeCapsule(raiz, { projectName: "percurso" });
  const doProjeto = { project_id: init.projectId };

  let anterior: string | null = null;
  for (let i = 0; i < CHECKPOINTS; i++) {
    const chk = makeCheckpoint(`passo ${i}`, anterior, doProjeto);
    await publishCanonical(raiz, chk);
    anterior = chk.id;
  }
  for (let i = 0; i < GOTCHAS; i++) {
    await publishCanonical(raiz, makeGotcha({ ...doProjeto, source_ref: `nexos://gotcha/regra-${i}` }));
  }
});

afterEach(async () => {
  await fs.remove(ws);
});

/** Parses gastos por UMA leitura, com o cache já quente (nenhum miss). */
async function parsesEmRegime(): Promise<number> {
  const cache = await loadIntegrityCache(raiz);
  await readCurrentRecords(raiz, { integrityCache: cache }); // aquece
  parses = 0;
  const r = await readCurrentRecords(raiz, { integrityCache: cache });
  expect(r.ok).toBe(true);
  return parses;
}

describe("trabalho de uma leitura do Store, em contagem", () => {
  it("com cache quente, a family de checkpoint não é reparseada — e o segundo percurso aparece", async () => {
    const emRegime = await parsesEmRegime();

    /**
     * O ASSERT QUE FALHA SE `f6aefb7c` FOR REVERTIDO. Sem o cache encadeado em
     * `projectCheckpointHead`, os 6 checkpoints voltam a ser parseados pelo
     * PRIMEIRO percurso, somando-se aos do segundo.
     */
    /**
     * MEDIDO, o mesmo Store de 10 records, três estados do código:
     *
     *     sem cache na family de checkpoint      33 parses
     *     com cache na family (f6aefb7c)         27 parses   (-6 = os checkpoints)
     *     sem o segundo percurso (causa raiz)     9 parses   (-18)
     *
     * O piso que existia aqui — `>= CHECKPOINTS + GOTCHAS` — documentava o
     * segundo percurso do Store e dizia, por escrito, que sairia no dia em que
     * alguém consertasse `MESMO ROOT PEDIDO != MESMO ROOT LIDO`. Esse dia foi
     * o mesmo: `resolveCheckpointHeadNoRoot` opera no read root já resolvido,
     * a preferência por `cache.rootPath` deixa de trocar o root por baixo, e o
     * percurso inteiro desaparece. O piso caiu com 9 contra 10 — falhou por ser
     * ALTO demais, exatamente como previsto.
     *
     * Teto em 12: pega qualquer volta do percurso (27 ou 33) com folga larga, e
     * ainda assim aperta o suficiente para acusar um percurso parcial.
     */
    expect(emRegime).toBeLessThan(12);

  });

  /**
   * CONTROLE — sem cache nenhum, o mesmo Store custa os DOIS percursos. Sem
   * isto, um cache que silenciosamente parasse de funcionar passaria no teste
   * acima com folga, porque `toBeLessThan` sozinho nunca acusa trabalho
   * a MENOS do que o esperado.
   */
  it("sem cache, a mesma leitura paga os dois percursos", async () => {
    parses = 0;
    await readCurrentRecords(raiz, {});
    const semCache = parses;

    const comCache = await parsesEmRegime();
    expect(semCache).toBeGreaterThan(comCache);
  });
});
