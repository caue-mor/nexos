/**
 * O ciclo de vida da PROPOSTA: a corrida que a duplica, e a promoção que a
 * aposenta.
 *
 *   DEDUPE NA PROPOSTA != DEDUPE NA ESCRITA
 *   PROMOTED != RETIRED
 *
 * `dedupeCandidate` roda ANTES de `publishCanonical`. Duas invocações
 * concorrentes leem o Store antes de qualquer uma publicar, as duas veem NOVEL,
 * e o acervo ganha o par que o próprio guard reprovaria.
 *
 * MEDIDO fora deste arquivo, com dois PROCESSOS de verdade contra uma cópia do
 * Store real deste repo: mesmo fato, ids `knw_01M15SSDJK7RGF…` e
 * `knw_01M15SSDJKFAP7…` — o MESMO milissegundo no ULID — 268 → 270 arquivos,
 * ambos `(NOVEL)`. Aqui a corrida é reproduzida em processo e FIXADA no pior
 * caso pela barreira em `publishCanonical` (abaixo): `Promise.all` sozinho só
 * torce pela intercalação.
 *
 * O NEGATIVO é o que dá sentido ao positivo: se a reconciliação depreciasse por
 * "parecido", dois fatos DIFERENTES propostos juntos perderiam um dos dois — e
 * um teste que só olhasse o caso duplicado aprovaria essa destruição.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { readCurrentRecords, contentOf, isDeprecated } from "../src/lib/capsule/reader.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { memory } from "../src/commands/memory.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

/**
 * Este arquivo testa ESCOPO de promoção (global vs project), não o gate de
 * autoridade — que tem arquivo próprio (`memory-promote-authority.test.ts`).
 * Sem este mock, todo `memory({ promote })` daqui seria recusado por
 * `requestHumanApproval`: um teste roda sem terminal controlador, exatamente
 * como um agente. Foi assim que o gate foi MEDIDO funcionando — 5 testes deste
 * arquivo passaram a falhar no instante em que `humanApproved: true` saiu de
 * `memory.ts`. O mock simula o humano que respondeu "y"; ele existe só aqui,
 * e não há caminho de produção que o alcance.
 */
vi.mock("../src/lib/host/human-presence.js", () => ({
  requestHumanApproval: () => ({ approved: true, approvedBy: "human:tty", why: "aprovado (mock de teste)" }),
}));

/**
 * Barreira de 2 em `publishCanonical`: nenhuma proposta escreve antes de as
 * DUAS terem passado pelo dedupe pré-escrita de `memory.ts`. Sem ela a corrida
 * era sorte — MEDIDO 24/09: 2 de 240 corridas sob CPU saturada serializaram (a
 * segunda leu o Store já com a primeira e o dedupe barrou ANTES de escrever,
 * `exitCode` 0) e "4 arquivos" virou 2. Código correto, vermelho falso; e o
 * NEGATIVO passava sem corrida nenhuma. Armada só por `corrida()`.
 */
let barreira: { faltam: number; abrir: () => void; aberta: Promise<void> } | null = null;
vi.mock("../src/lib/capsule/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capsule/store.js")>();
  return {
    ...actual,
    publishCanonical: async (...args: Parameters<typeof actual.publishCanonical>) => {
      const b = barreira;
      if (b) {
        b.faltam -= 1;
        if (b.faltam === 0) {
          barreira = null;
          b.abrir();
        }
        await b.aberta;
      }
      return actual.publishCanonical(...args);
    },
  };
});


const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-29T00:00:00.000Z";
const FATO = "Guard que roda antes da escrita nao sobrevive a duas leituras concorrentes do Store";

let root: string;
let projectId: string;

/** Silencia o clack: o que se mede aqui é o Store, não a saída. */
function mudo(): () => void {
  const s = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const l = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    s.mockRestore();
    l.mockRestore();
  };
}

async function propor(fact: string): Promise<void> {
  // T7a (§6.2): `--scope global` agora exige `--subject` — nunca derivado do fato.
  await memory({
    cwd: root,
    fact,
    evidence: "tests/memory-propose-race.test.ts",
    scope: "global",
    subject: "corrida de propostas concorrentes",
  });
}

/** As duas propostas concorrentes, com as duas leituras antes de qualquer escrita. */
async function corrida(a: string, b: string): Promise<void> {
  let abrir = (): void => undefined;
  const aberta = new Promise<void>((r) => {
    abrir = r;
  });
  barreira = { faltam: 2, abrir, aberta };
  const restaurar = mudo();
  try {
    await Promise.all([propor(a), propor(b)]);
  } finally {
    restaurar();
    barreira = null;
  }
}

/** Candidatos que a LEITURA corrente ainda entrega — depreciado não conta. */
async function candidatosCorrentes(): Promise<string[]> {
  const r = await readCurrentRecords(root);
  if (!r.ok) throw new Error("store ilegível");
  return r.records
    .filter((x) => (x.record as { kind?: string }).kind === "memory_candidate")
    .filter((x) => !isDeprecated(x.record))
    .map((x) => String(contentOf(x.record)["fact"] ?? ""));
}

async function arquivosDeRecord(): Promise<string[]> {
  return fs.readdir(path.join(root, ".nexos", "records", "knowledge"));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "mem-race-"));
  projectId = (await initializeCapsule(root, { projectName: "projeto-race" })).projectId;

  /**
   * `propor` deriva o `project_id` de um record existente e RECUSA capsule
   * vazia ("projeto sem Capsule canônica"). A semente é sobre outro assunto de
   * propósito: se ela colidisse com `FATO`, o dedupe barraria as duas
   * propostas antes da escrita e a corrida nunca aconteceria — o teste passaria
   * medindo o guard errado.
   */
  await publishCanonical(root, {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "migration",
    provenance: {
      source_ref: "nexos://gotcha/semente",
      producer_id: "produtor-de-teste",
      submitted_at: NOW,
    },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    created_at: NOW,
    version: 1,
    content: { title: "semente", rule: "assunto sem relacao alguma com corrida de propostas" },
  } as CapsuleRecord);
});

describe("proposta concorrente do mesmo fato", () => {
  it("POSITIVO: duas concorrentes do mesmo fato deixam UMA linhagem corrente", async () => {
    await corrida(FATO, FATO);

    const correntes = await candidatosCorrentes();
    expect(correntes.filter((f) => f === FATO)).toHaveLength(1);
  });

  it("append-only: o record que perdeu a corrida continua no disco", async () => {
    await corrida(FATO, FATO);

    /**
     * Semente + os DOIS candidatos + o sucessor que deprecia o perdedor. Nada
     * foi removido: retirar de circulação é PUBLICAR.
     */
    expect(await arquivosDeRecord()).toHaveLength(4);
  });

  it("proveniência: o perdedor registra por quê, contra quem e por qual ator", async () => {
    await corrida(FATO, FATO);

    const r = await readCurrentRecords(root, { includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    const depreciados = r.records.filter((x) => isDeprecated(x.record));
    expect(depreciados).toHaveLength(1);

    const dep = (depreciados[0]!.record as { deprecation?: { reason: string; actor_ref: string } })
      .deprecation;
    expect(dep?.reason).toMatch(/duplicata de knw_/);
    expect(dep?.reason).toMatch(/corrida de propostas concorrentes/);
    expect(dep?.actor_ref).toBe("policy:nexos-memory-deprecate");
  });

  it("NEGATIVO: fatos diferentes propostos juntos sobrevivem os dois", async () => {
    const outro = "Mascara de input e visual e o banco recebe sempre o valor cru sem formatacao";
    await corrida(FATO, outro);

    const correntes = await candidatosCorrentes();
    expect(correntes).toHaveLength(2);
    expect(correntes.sort()).toEqual([FATO, outro].sort());
  });
});

describe("promoção aposenta a proposta", () => {
  /** O id do candidato recém-proposto — só ele é `memory_candidate` corrente. */
  async function idDoCandidato(): Promise<string> {
    const r = await readCurrentRecords(root);
    if (!r.ok) throw new Error("store ilegível");
    const c = r.records.find((x) => (x.record as { kind?: string }).kind === "memory_candidate");
    if (!c) throw new Error("nenhum candidato corrente");
    return c.record.id;
  }

  it("o candidato sai de circulação e o promovido fica", async () => {
    const restaurar = mudo();
    try {
      await propor(FATO);
      const id = await idDoCandidato();
      await memory({ cwd: root, promote: id, why: "medido nesta fatia" });
    } finally {
      restaurar();
    }

    /**
     * O par candidato+promoção dizendo a mesma coisa, os DOIS correntes, é
     * exatamente o que foi medido no Store real (7 pares, 6 em 1.000).
     */
    expect(await candidatosCorrentes()).toHaveLength(0);

    /** `CAMPO_DO_FATO.gotcha === "rule"` — o promovido não guarda `fact`. */
    const r = await readCurrentRecords(root, { kind: "gotcha" });
    if (!r.ok) throw new Error("store ilegível");
    expect(r.records.some((x) => String(contentOf(x.record)["rule"] ?? "") === FATO)).toBe(true);
  });

  it("a origem continua caminhável pelo source_ref do promovido", async () => {
    let id = "";
    const restaurar = mudo();
    try {
      await propor(FATO);
      id = await idDoCandidato();
      await memory({ cwd: root, promote: id, why: "medido nesta fatia" });
    } finally {
      restaurar();
    }

    const r = await readCurrentRecords(root, { kind: "gotcha" });
    if (!r.ok) throw new Error("store ilegível");
    expect(r.records.some((x) => x.sourceRef === `nexos://promoted-from/${id}`)).toBe(true);

    /** Append-only: aposentar não apaga. O arquivo do candidato segue lá. */
    expect(await arquivosDeRecord()).toContain(`${id}.yaml`);
  });
});
