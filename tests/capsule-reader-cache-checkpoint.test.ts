/**
 * O cache de integridade cobria todas as famílias MENOS a maior delas.
 *
 *     CACHE LIGADO NÃO É CACHE USADO
 *
 * MEDIDO em 2026-09-19 no Store real deste repositório: 2231 arquivos, dos
 * quais 460 (21%) são `ProjectCheckpoint` — a família mais numerosa. Com o
 * cache carregado e quente, ela era a única a pagar parse + validate +
 * re-serialize em TODA leitura, porque `projectCheckpointHead` passava
 * `undefined` fixo no parâmetro `cache` de `loadFamilyForResolution`.
 *
 * Não havia decisão excluindo checkpoint: nenhum teste, nenhuma nota, nenhuma
 * linha de docstring. Era omissão — o parâmetro existe desde 03e e este
 * chamador nunca o preencheu. O cache é content-addressed por sha1 do conteúdo
 * bruto e só guarda o que já foi provado schema-válido E canônico, então vale
 * para qualquer família por construção.
 *
 * Efeito medido no Store real: leitura completa com cache quente caiu de
 * 2847ms para ~2374ms. O resto do custo é um SEGUNDO percurso do Store, dentro
 * da mesma chamada, que esta fatia deliberadamente NÃO tocou (ver o comentário
 * em `reader.ts`, na linha de `resolveCheckpointHead`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { loadIntegrityCache } from "../src/lib/capsule/integrity-cache.js";
import { initializeGlobalRoot } from "../src/lib/capsule/initializer.js";
import { GLOBAL_ROOT } from "../src/lib/constants.js";
import { makeCheckpoint, makeGotcha } from "./capsule-fixtures.js";

let ws: string;
let raiz: string;

/** Uma chain de 4 checkpoints + 2 gotchas: duas famílias, um cache. */
async function montarStore(): Promise<void> {
  const init = await initializeCapsule(raiz, { projectName: "cache-checkpoint" });
  expect(init.projectId).toBeTruthy();
  const doProjeto = { project_id: init.projectId };

  let anterior: string | null = null;
  for (const passo of ["primeiro", "segundo", "terceiro", "quarto"]) {
    const chk = makeCheckpoint(passo, anterior, doProjeto);
    await publishCanonical(raiz, chk);
    anterior = chk.id;
  }
  for (const regra of ["nunca confie no primeiro stack", "medir antes de afirmar"]) {
    await publishCanonical(raiz, makeGotcha({ ...doProjeto, source_ref: `nexos://gotcha/${regra.replace(/ /g, "-")}` }));
  }
}

const familiasNoCache = (cache: { entries: Map<string, { record: { family: string } }> }): Set<string> =>
  new Set([...cache.entries.values()].map((e) => e.record.family));

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-cache-chk-"));
  raiz = path.join(ws, "projeto");
  await fs.ensureDir(raiz);
  await montarStore();
});

afterEach(async () => {
  await fs.remove(ws);
});

describe("o cache de integridade cobre ProjectCheckpoint", () => {
  it("uma leitura com cache popula entradas da família de checkpoint", async () => {
    const cache = await loadIntegrityCache(raiz);
    expect(cache.entries.size).toBe(0);

    const r = await readCurrentRecords(raiz, { integrityCache: cache });
    expect(r.ok).toBe(true);

    /**
     * O ASSERT QUE FALHA SE A CORREÇÃO FOR REVERTIDA. Com `undefined` fixo no
     * lugar do cache, `ProjectCheckpoint` nunca aparece aqui — a leitura
     * funciona igual, só custa parse a cada vez, e nenhum teste notava.
     */
    expect(familiasNoCache(cache).has("ProjectCheckpoint")).toBe(true);
  });

  /** CONTROLE POSITIVO — a correção não podia derrubar quem já estava coberto. */
  it("as outras famílias continuam entrando no cache", async () => {
    const cache = await loadIntegrityCache(raiz);
    await readCurrentRecords(raiz, { integrityCache: cache });
    expect(familiasNoCache(cache).has("KnowledgeRecord")).toBe(true);
  });

  /**
   * CONTROLE NEGATIVO, e o que de fato importa: o cache muda o CUSTO, nunca o
   * que o Store afirma. Foi este invariante que reprovou a segunda metade da
   * otimização (76% de ganho, descartada por emitir uma anomalia que a leitura
   * sem cache não emite).
   */
  it("com cache e sem cache devolvem o mesmo Store", async () => {
    const cache = await loadIntegrityCache(raiz);
    const com = await readCurrentRecords(raiz, { integrityCache: cache });
    const sem = await readCurrentRecords(raiz, {});
    if (!com.ok || !sem.ok) throw new Error("leitura falhou nos dois caminhos");

    const chave = (rs: typeof com.records): string[] =>
      rs.map((x) => `${x.family}|${x.sourceRef}|${x.record.id}|${x.admission}`).sort();

    expect(chave(com.records)).toEqual(chave(sem.records));
    expect(com.anomalies.map((a) => a.state).sort()).toEqual(sem.anomalies.map((a) => a.state).sort());
  });

  /**
   * O CASO QUE FALTAVA, e a falta era minha.
   *
   *     MEDI != TRAVEI
   *
   * A primeira versão deste arquivo provava "com cache == sem cache" só para a
   * leitura do projeto, e o commit afirmou que o invariante estava travado
   * "incluindo `includeGlobal`". Não estava: `includeGlobal` não aparecia no
   * arquivo. A prova existia — num script fora do repositório, que ninguém
   * roda de novo. A verificação independente refutou, e com razão: um teste
   * que passa nos DOIS estados do defeito não é guard.
   *
   * É neste caminho que a segunda metade da otimização (cache também em
   * `resolveCheckpointHead`, medida em -76%) diverge: a partição global faz
   * `resolveCheckpointHead` re-resolver authority por dentro e resolver um head
   * que a leitura por family daquele root não contém.
   *
   *     MESMO ROOT PEDIDO != MESMO ROOT LIDO
   */
  it("com cache e sem cache devolvem o mesmo Store TAMBÉM com includeGlobal", async () => {
    await initializeGlobalRoot(GLOBAL_ROOT);

    const cache = await loadIntegrityCache(raiz);
    const com = await readCurrentRecords(raiz, { includeGlobal: true, integrityCache: cache });
    const sem = await readCurrentRecords(raiz, { includeGlobal: true });
    if (!com.ok || !sem.ok) throw new Error("leitura falhou nos dois caminhos");

    const chave = (rs: typeof com.records): string[] =>
      rs.map((x) => `${x.family}|${x.sourceRef}|${x.record.id}`).sort();
    const anomalia = (as: typeof com.anomalies): string[] =>
      as.map((a) => `${a.family}|${a.sourceRef}|${a.state}`).sort();

    expect(chave(com.records)).toEqual(chave(sem.records));
    /** A anomalia fantasma que reprovou a otimização aparecia SÓ aqui. */
    expect(anomalia(com.anomalies)).toEqual(anomalia(sem.anomalies));
  });

  /** Ler duas vezes com o MESMO cache não inventa nem perde record. */
  it("a segunda leitura com cache quente devolve o mesmo conjunto", async () => {
    const cache = await loadIntegrityCache(raiz);
    const primeira = await readCurrentRecords(raiz, { integrityCache: cache });
    const segunda = await readCurrentRecords(raiz, { integrityCache: cache });
    if (!primeira.ok || !segunda.ok) throw new Error("leitura falhou");
    expect(segunda.records.length).toBe(primeira.records.length);
    expect(segunda.records.length).toBeGreaterThan(0);
  });
});
