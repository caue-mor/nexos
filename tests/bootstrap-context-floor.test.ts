/**
 * D11 (revisão do coordenador) — A9: o piso de `kind: gotcha` sobrevive ao
 * corte por estouro do BRIEF SERIALIZADO, não só ao corte do pack cru.
 *
 *   FLOOR IN THE PACK != FLOOR IN THE BRIEF
 *
 * Medido no Store real: `couberNoBrief` cortava sempre o ÚLTIMO item do
 * array pra caber em `SESSION_BRIEF_MAX_BYTES`, e como o desempate de
 * `pontuar()` por `source_ref` colocava gotcha depois de Decision, aumentar
 * o orçamento do CONHECIMENTO (mais Decision admitida no pack) fazia o corte
 * do BRIEF comer os gotcha primeiro — o piso existia no pack e sumia no
 * brief. Este teste força o estouro (muitas Decision, orçamento de
 * conhecimento generoso) e prova que gotcha não zera.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import { SESSION_BRIEF_MAX_BYTES } from "../src/lib/session-brief.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-20T00:00:00.000Z";
let ws: string;
let root: string;

function envelope(pid: string, family: string, sourceRef: string, createdAt: string = NOW) {
  return {
    schema_version: 1 as const,
    project_id: pid,
    family,
    scope: "project" as const,
    origin: "migration" as const,
    provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: createdAt },
    lifecycle: "immutable" as const,
    portability: "portable" as const,
    regenerable: false as const,
    admission: { status: "admitted" as const, approved_by: "human:test", approved_at: createdAt },
    sensitivity: { classification: "internal" as const, checked_at: createdAt, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: createdAt,
    version: 1,
  };
}

function decisionOf(pid: string, sourceRef: string, i: number, createdAt: string = NOW): CapsuleRecord {
  return {
    ...envelope(pid, "Decision", sourceRef, createdAt),
    id: newRecordId("Decision"),
    content: {
      title: `ADR-${String(i).padStart(3, "0")} decisao legada sobre o modulo de faturamento`,
      decision: `Optou-se por manter a abordagem X no modulo ${i} por compatibilidade retroativa com o pipeline de pagamentos existente e evitar migracao disruptiva agora.`,
    },
  } as unknown as CapsuleRecord;
}

/**
 * `pattern` (KnowledgeRecord) não tem `title` no schema — é o único kind, entre
 * as families não-append-only, sem esse campo. Serve pra imitar o título vazio
 * dos `host-observation` reais sem violar o schema.
 */
function patternOf(pid: string, sourceRef: string, i: number, createdAt: string = NOW): CapsuleRecord {
  return {
    ...envelope(pid, "KnowledgeRecord", sourceRef, createdAt),
    id: newRecordId("KnowledgeRecord"),
    kind: "pattern",
    content: {
      context: "contexto generico de reuso observado em producao",
      practice: `pratica ${i}: aplicar retry exponencial com jitter no cliente HTTP do servico ${i}`,
      expected_effect: "reducao de timeouts em cascata durante picos de carga",
      applicability: "servicos que dependem de APIs externas com SLA variavel",
      evidence: `medido em producao no incidente ${i}`,
    },
  } as unknown as CapsuleRecord;
}

function contractOf(pid: string, sourceRef: string, i: number, createdAt: string = NOW): CapsuleRecord {
  return {
    ...envelope(pid, "ProjectContract", sourceRef, createdAt),
    id: newRecordId("ProjectContract"),
    content: {
      title: `contrato ${i}: escopo fechado de auditoria de faturamento`,
      requirements: [`requisito de auditoria ${i}`],
      status: "open",
    },
  } as unknown as CapsuleRecord;
}

function gotcha(pid: string, sourceRef: string, i: number): CapsuleRecord {
  return {
    ...envelope(pid, "KnowledgeRecord", sourceRef),
    id: newRecordId("KnowledgeRecord"),
    kind: "gotcha",
    content: {
      title: `gotcha ${i}: falha operacional em producao`,
      failure_mode: `token expira antes do refresh completar no fluxo ${i}, causando 401 intermitente`,
      rule: `sempre renovar o token com margem de 30s antes da expiracao nominal`,
    },
  } as unknown as CapsuleRecord;
}

function stateOf(pid: string): CapsuleRecord {
  return {
    ...envelope(pid, "KnowledgeRecord", "nexos://project_state/head"),
    id: newRecordId("KnowledgeRecord"),
    kind: "project_state",
    content: {
      title: "estado",
      current_state: "em andamento",
      next_action: "continuar",
    },
  } as unknown as CapsuleRecord;
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "n2-a9-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("A9 · piso de gotcha sobrevive ao corte do brief serializado", () => {
  it("orçamento de conhecimento GENEROSO não zera gotcha no brief final", async () => {
    const pid = (await initializeCapsule(root, { projectName: "proj" })).projectId;
    await publishCanonical(root, stateOf(pid));
    /** 60 Decision — o bastante pra estourar 12288B serializados quando o
     * orçamento de conhecimento é generoso o suficiente pra admitir todas
     * no pack. */
    for (let i = 0; i < 60; i++) {
      await publishCanonical(root, decisionOf(pid, `.dec${String(i).padStart(3, "0")}`, i));
    }
    for (let i = 0; i < 8; i++) {
      await publishCanonical(root, gotcha(pid, `nexos://gotcha/${String(i).padStart(2, "0")}`, i));
    }

    /** Orçamento de conhecimento bem acima do que qualquer brief real usa —
     * exatamente o "aumentar o orçamento" que zerava gotcha antes do fix. */
    const knowledgeBudgetBytes = 40 * 1024;
    const r = await buildSessionBriefForCwd({ cwd: root, knowledgeBudgetBytes });

    /** O estouro realmente aconteceu — senão o teste não prova nada. */
    expect(r.byteLength).toBeLessThanOrEqual(SESSION_BRIEF_MAX_BYTES);

    const items = r.brief.knowledge?.items ?? [];
    const gotchaRefs = items.filter((i) => i.source_ref.startsWith("nexos://gotcha/"));
    expect(gotchaRefs.length).toBeGreaterThan(0);
  });

  it("varredura de orçamento: gotcha nunca cai a zero em nenhum dos 4 pontos", async () => {
    const pid = (await initializeCapsule(root, { projectName: "proj" })).projectId;
    await publishCanonical(root, stateOf(pid));
    for (let i = 0; i < 60; i++) {
      await publishCanonical(root, decisionOf(pid, `.dec${String(i).padStart(3, "0")}`, i));
    }
    for (let i = 0; i < 8; i++) {
      await publishCanonical(root, gotcha(pid, `nexos://gotcha/${String(i).padStart(2, "0")}`, i));
    }

    for (const knowledgeBudgetBytes of [8192, 10240, 12288, 16384]) {
      const r = await buildSessionBriefForCwd({ cwd: root, knowledgeBudgetBytes });
      const items = r.brief.knowledge?.items ?? [];
      const gotchaCount = items.filter((i) => i.source_ref.startsWith("nexos://gotcha/")).length;
      expect(gotchaCount, `budget=${knowledgeBudgetBytes} zerou gotcha`).toBeGreaterThan(0);
    }
  });
});

/**
 * FATIA 1 / PASSO 1 — POINTER DEDUPE (`couberNoBrief`, bootstrap-context.ts).
 *
 * Medido no Store real: 31 `host-observation` do boot têm `source_ref`
 * IDÊNTICO (`nexos://host/claude_code/session-start` — o evento que os une,
 * não o record individual) e conteúdo distinto. O dedupe por CONTEÚDO do
 * assembler (`context-assembler.ts:464`) está certo pro propósito dele e
 * deixa todos passarem como items distintos; cada corte por orçamento em
 * `couberNoBrief` empurrava mais um ponteiro pra lista sem checar se aquela
 * referência já tinha um — 22 ponteiros no brief real, 14 idênticos.
 *
 *   POINTER LIST DEDUPES BY REFERENCE, NOT BY OCCURRENCE
 *
 * Reproduzir >1 `HostObservation` real chegando a `draft.items` não é possível
 * hoje: essa family é `APPEND_ONLY` (só assim vários records sobrevivem sob o
 * MESMO source_ref sem virar `DIVERGED` em `resolvePartitions` —
 * head-resolver.ts exige no máximo 1 head por par `(family, source_ref)`), mas
 * o schema dela não tem NENHUM campo que bata com `CAMPOS_UTEIS`
 * (`context-assembler.ts`) — verificado contra as 5 families append-only.
 * Sem um campo útil, o record vira `NO_SIGNAL` e nem chega a `pack.items`
 * (confirmado empiricamente antes deste teste). A única forma de ter N>1
 * records CURRENT sob o MESMO source_ref com conteúdo aproveitável é
 * espalhá-los por families DIFERENTES — partições de head-resolution são por
 * family, então `Decision`, `KnowledgeRecord` (kind `pattern`) e
 * `ProjectContract` sob o mesmo source_ref não colidem entre si. É o teto
 * arquitetural: 3, não N>=6 — as demais families sem overlap de conteúdo
 * (`Research`, `ProjectCheckpoint`) ou fora de escopo (Capability Plane).
 *
 * `created_at` antigo nos 3 compartilhados garante que sejam os PRIMEIROS
 * candidatos a corte: o desempate de `comparar()` usa recência antes de `id`,
 * e `id` é ULID (aleatório entre runs) — sem isso o teste seria instável.
 */
describe("D11 · pointers de couberNoBrief dedupam por source_ref repetido", () => {
  it("um source_ref cortado varias vezes vira UM ponteiro, e 'omitted' nao e reduzido", async () => {
    const pid = (await initializeCapsule(root, { projectName: "proj" })).projectId;
    const OLD = "2020-01-01T00:00:00.000Z";
    const SHARED = "nexos://host/claude_code/session-start";

    await publishCanonical(root, decisionOf(pid, SHARED, 1, OLD));
    await publishCanonical(root, patternOf(pid, SHARED, 2, OLD));
    await publishCanonical(root, contractOf(pid, SHARED, 3, OLD));

    const totalPadding = 60;
    for (let i = 0; i < totalPadding; i++) {
      await publishCanonical(root, decisionOf(pid, `.dec${String(i).padStart(3, "0")}`, i));
    }

    const knowledgeBudgetBytes = 40 * 1024;
    const r = await buildSessionBriefForCwd({ cwd: root, knowledgeBudgetBytes });

    /** O estouro (e portanto o corte) realmente aconteceu. */
    expect(r.byteLength).toBeLessThanOrEqual(SESSION_BRIEF_MAX_BYTES);

    const knowledge = r.brief.knowledge;
    expect(knowledge).toBeDefined();

    const pointers = knowledge?.pointers ?? [];
    const sharedPointers = pointers.filter((p) => p.source_ref === SHARED);
    expect(sharedPointers).toHaveLength(1);

    /**
     * Invariante do laço: cada volta de `couberNoBrief` tira 1 de `items` e
     * soma 1 em `omitted` — a soma dos dois é constante e igual ao total de
     * records elegiveis publicados (todos pontuam >0 com intent vazio e todos
     * tem campo util). Se o dedupe de ponteiro tivesse, por engano, deixado de
     * contar um corte como omitido, esta soma cairia abaixo do total.
     *
     * `2`, não `3` (03b, host event observation) — `assembleKnowledge`
     * (`bootstrap-context.ts`) passou a restringir a leitura a
     * `BOOT_KNOWLEDGE_FAMILIES` (`KnowledgeRecord`/`Decision`/`Research`).
     * `contractOf` (`ProjectContract`) nunca é lida por esta chamada: o
     * record existe no Store, mas fica FORA do universo de `draft.items`
     * antes mesmo da pontuação — não é um corte por orçamento (não soma em
     * `omitted`), é ausência na fonte. Só `decisionOf`/`patternOf`, sob o
     * MESMO `SHARED`, chegam a `couberNoBrief` para o dedupe testar.
     */
    const totalEligible = 2 + totalPadding;
    const itemsCount = knowledge?.items.length ?? 0;
    const omitted = knowledge?.omitted ?? 0;
    expect(itemsCount + omitted).toBe(totalEligible);
    expect(omitted).toBeGreaterThan(0);
  });
});
