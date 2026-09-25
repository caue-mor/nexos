/**
 * T7a + T7b — rota explícita `--to global`, com subject e generality
 * declarados, e a marca de não-verificado (T7b/I31).
 *
 * Plano: `nexos_aios_sdk_v1/docs/13_MEMORY_SCOPE_LAYERED_DECISION.md` §6.2,
 * §6.3, §6.4, §8.2; invariantes I13/I15/I22/I24/I31 (§9). `GLOBAL_ROOT`/
 * `NEXOS_HOME` já vêm isolados por `tests/isolate-nexos-home.ts` (setup
 * global) — um tmpdir por ARQUIVO de teste, nunca o `$HOME` real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule, initializeGlobalRoot } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { readCurrentRecords, contentOf } from "../src/lib/capsule/reader.js";
import { buildMemoryCandidate } from "../src/lib/capsule/memory-candidate.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { memory } from "../src/commands/memory.js";
import { CapsuleRecordSchema, subjectRef, type CapsuleRecord } from "../src/lib/capsule/schemas.js";

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

import { GLOBAL_ROOT } from "../src/lib/constants.js";

const TMP = fs.realpathSync(os.tmpdir());
const AT = "2026-09-09T00:00:00.000Z";

let root: string;
let projectId: string;

/** Silencia o clack — o que se mede aqui é o Store, não a saída (mesmo padrão de memory-propose-race.test.ts). */
function mudo(): () => void {
  const s = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const l = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    s.mockRestore();
    l.mockRestore();
  };
}

/** Publica um candidato direto no Store do projeto — sem passar por `propor()`. */
async function publicarCandidato(input: {
  readonly fact: string;
  readonly memoryScope?: "project" | "role" | "global";
  readonly subject?: string;
}): Promise<string> {
  const id = newRecordId("KnowledgeRecord");
  const c = buildMemoryCandidate({
    projectId,
    fact: input.fact,
    originNote: "teste T7a",
    evidence: "evidência de teste",
    proposedKind: "gotcha",
    recordId: id,
    observedAt: AT,
  });
  const content = (c as unknown as { content: Record<string, unknown> }).content;
  if (input.memoryScope !== undefined) content["memory_scope"] = input.memoryScope;
  if (input.subject !== undefined) {
    const envelope = c as unknown as { subject?: string; subject_ref?: string };
    envelope.subject = input.subject;
    envelope.subject_ref = subjectRef(input.subject);
  }
  await publishCanonical(root, c);
  return id;
}

async function candidatosCorrentes(): Promise<readonly CapsuleRecord[]> {
  const r = await readCurrentRecords(root);
  if (!r.ok) throw new Error("store do projeto ilegível");
  return r.records
    .map((x) => x.record)
    .filter((rec) => (rec as { kind?: string }).kind === "memory_candidate");
}

async function gotchasNoProjeto(): Promise<readonly CapsuleRecord[]> {
  const r = await readCurrentRecords(root, { kind: "gotcha" });
  if (!r.ok) throw new Error("store do projeto ilegível");
  // exclui a semente do `beforeEach` — ela existe só para `propor()` achar um `project_id`.
  return r.records.map((x) => x.record).filter(naoEhSemente);
}

function naoEhSemente(rec: CapsuleRecord): boolean {
  return rec.provenance.source_ref !== "nexos://gotcha/semente";
}

async function gotchasNoGlobal(): Promise<readonly CapsuleRecord[]> {
  const r = await readCurrentRecords(root, { includeGlobal: true, kind: "gotcha" });
  if (!r.ok) throw new Error("store composto ilegível");
  return r.records
    .map((x) => x.record)
    .filter((rec) => typeof rec.scope !== "string" && rec.scope.kind === "global");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "mem-promote-global-"));
  projectId = (await initializeCapsule(root, { projectName: "t7a" })).projectId;
  await initializeGlobalRoot(GLOBAL_ROOT);

  /**
   * `propor()` deriva `project_id` de um record EXISTENTE no Store
   * (memory.ts) e recusa capsule vazia — sem esta semente, o teste de
   * `--scope role` explícito recusaria pelo motivo ERRADO ("projeto sem
   * Capsule canônica"), mascarando se a recusa nova (role) de fato rodou.
   * Mesmo padrão de `tests/memory-propose-race.test.ts`.
   */
  await publishCanonical(root, {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "migration",
    provenance: { source_ref: "nexos://gotcha/semente", producer_id: "produtor-de-teste", submitted_at: AT },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:test", approved_at: AT },
    sensitivity: { classification: "internal", checked_at: AT, checker_version: "t1" },
    created_at: AT,
    version: 1,
    content: { title: "semente", rule: "assunto sem relação com os testes desta fatia" },
  } as CapsuleRecord);
});

afterEach(async () => {
  await fs.remove(root);
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("I13/I22 — sem --to global, promoção fica no projeto mesmo com memory_scope global", () => {
  it("I13: candidato project-scoped, promovido sem --to, fica no projeto", async () => {
    const id = await publicarCandidato({ fact: "fato de projeto suficientemente longo para o gotcha" });
    const restaurar = mudo();
    try {
      await memory({ cwd: root, promote: id, why: "I13" });
    } finally {
      restaurar();
    }

    const projeto = await gotchasNoProjeto();
    expect(projeto).toHaveLength(1);
    expect((projeto[0]!.scope as { kind?: string }).kind).toBe("project");
    expect(await gotchasNoGlobal()).toHaveLength(0);
  });

  it("I22: candidato memory_scope global, promovido sem --to, fica no projeto — nada publicado no global", async () => {
    const id = await publicarCandidato({
      fact: "fato marcado global mas promovido sem rota explicita",
      memoryScope: "global",
      subject: "assunto i22",
    });
    const restaurar = mudo();
    try {
      await memory({ cwd: root, promote: id, why: "I22" });
    } finally {
      restaurar();
    }

    const projeto = await gotchasNoProjeto();
    expect(projeto).toHaveLength(1);
    expect((projeto[0]!.scope as { kind?: string }).kind).toBe("project");
    expect(await gotchasNoGlobal()).toHaveLength(0);
  });
});

describe("I24 — role nunca vira global", () => {
  it("candidato memory_scope role, promovido com --to global, é recusado e nada é escrito", async () => {
    const id = await publicarCandidato({
      fact: "fato de papel promovido para global por engano",
      memoryScope: "role",
      subject: "assunto i24",
    });
    const restaurar = mudo();
    try {
      await memory({
        cwd: root,
        promote: id,
        to: "global",
        subject: "assunto i24",
        generality: "vale fora do projeto",
        why: "I24",
      });
    } finally {
      restaurar();
    }

    expect(process.exitCode).toBe(1);
    expect(await gotchasNoGlobal()).toHaveLength(0);
    expect(await gotchasNoProjeto()).toHaveLength(0);
  });

  it("--scope role no propor é erro explícito — nada é escrito", async () => {
    const restaurar = mudo();
    try {
      await memory({
        cwd: root,
        fact: "fato proposto com escopo role",
        evidence: "evidência de teste",
        scope: "role",
        role: "nexos-dev",
      });
    } finally {
      restaurar();
    }

    expect(process.exitCode).toBe(1);
    expect(await candidatosCorrentes()).toHaveLength(0);
  });
});

describe("I15 — fail-closed do produtor: --to global exige subject e generality", () => {
  it("--to global sem subject (nem no candidato) recusa e nada é escrito", async () => {
    const id = await publicarCandidato({
      fact: "fato global sem qualquer subject declarado",
      memoryScope: "global",
    });
    const restaurar = mudo();
    try {
      await memory({ cwd: root, promote: id, to: "global", generality: "vale fora do projeto", why: "I15" });
    } finally {
      restaurar();
    }

    expect(process.exitCode).toBe(1);
    expect(await gotchasNoGlobal()).toHaveLength(0);
    expect(await gotchasNoProjeto()).toHaveLength(0);
  });

  it("--to global sem --generality recusa e nada é escrito, mesmo com subject presente", async () => {
    const id = await publicarCandidato({
      fact: "fato global com subject mas sem generality",
      memoryScope: "global",
      subject: "assunto sem generalidade",
    });
    const restaurar = mudo();
    try {
      await memory({ cwd: root, promote: id, to: "global", why: "I15" });
    } finally {
      restaurar();
    }

    expect(process.exitCode).toBe(1);
    expect(await gotchasNoGlobal()).toHaveLength(0);
    expect(await gotchasNoProjeto()).toHaveLength(0);
  });

  it("--to global com memory_scope != global recusa mesmo com subject e generality presentes", async () => {
    const id = await publicarCandidato({
      fact: "fato de projeto promovido para global sem intenção declarada",
      subject: "assunto sem intencao global",
    });
    const restaurar = mudo();
    try {
      await memory({
        cwd: root,
        promote: id,
        to: "global",
        subject: "assunto sem intencao global",
        generality: "vale fora do projeto",
        why: "I15",
      });
    } finally {
      restaurar();
    }

    expect(process.exitCode).toBe(1);
    expect(await gotchasNoGlobal()).toHaveLength(0);
    expect(await gotchasNoProjeto()).toHaveLength(0);
  });

  it("--to com valor diferente de global é erro explícito, nada escrito — nunca cai em project em silêncio", async () => {
    const id = await publicarCandidato({
      fact: "fato promovido com --to grafado errado",
      memoryScope: "global",
      subject: "assunto i15 to invalido",
    });
    const restaurar = mudo();
    try {
      await memory({
        cwd: root,
        promote: id,
        to: "globall",
        subject: "assunto i15 to invalido",
        generality: "vale fora do projeto",
        why: "I15",
      });
    } finally {
      restaurar();
    }

    expect(process.exitCode).toBe(1);
    expect(await gotchasNoGlobal()).toHaveLength(0);
    expect(await gotchasNoProjeto()).toHaveLength(0);
  });
});

describe("caminho feliz — --to global com subject e generality", () => {
  it("publica em GLOBAL_ROOT isolado: scope global, subject/subject_ref, content.generality, marca I31, sem project_id", async () => {
    const id = await publicarCandidato({
      fact: "fato que vale para qualquer projeto com o mesmo gerenciador de pacotes",
      memoryScope: "global",
    });
    const restaurar = mudo();
    try {
      await memory({
        cwd: root,
        promote: id,
        to: "global",
        subject: "gerenciador de pacotes i31",
        generality: "vale para qualquer projeto que use o mesmo gerenciador",
        why: "caminho feliz",
      });
    } finally {
      restaurar();
    }

    expect(process.exitCode).not.toBe(1);
    const globais = await gotchasNoGlobal();
    expect(globais).toHaveLength(1);
    const promovido = globais[0]!;
    expect(promovido.scope).toEqual({ kind: "global", ref: null });
    expect(promovido.project_id).toBeUndefined();
    expect(promovido.subject).toBe("gerenciador de pacotes i31");
    expect(promovido.subject_ref).toBe(subjectRef("gerenciador de pacotes i31"));
    const content = contentOf(promovido);
    expect(content["generality"]).toBe("vale para qualquer projeto que use o mesmo gerenciador");
    expect(content["verification_status"]).toBe("unverified");

    const parsed = CapsuleRecordSchema.safeParse(promovido);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);

    // a proposta saiu de circulação no PROJETO, e só o promovido viajou.
    expect(await candidatosCorrentes()).toHaveLength(0);
  });
});

describe("e2e — propor --scope global --subject X, depois promover --to global --generality Y", () => {
  it("publica em GLOBAL_ROOT isolado com subject_ref de X, generality Y e verification_status unverified", async () => {
    const subject = "e2e assunto global via propor";
    const restaurarPropor = mudo();
    try {
      await memory({
        cwd: root,
        fact: "e2e fato que vale para qualquer projeto, proposto direto com escopo global",
        evidence: "evidência e2e de teste",
        scope: "global",
        subject,
      });
    } finally {
      restaurarPropor();
    }

    // subject/subject_ref foram gravados no ENVELOPE do candidato pelo `propor()` — a promoção não repete `--subject`.
    const candidato = (await candidatosCorrentes()).find((c) => contentOf(c)["memory_scope"] === "global");
    expect(candidato).toBeDefined();
    if (!candidato) return;
    expect(candidato.subject_ref).toBe(subjectRef(subject));

    const restaurarPromover = mudo();
    try {
      await memory({
        cwd: root,
        promote: candidato.id,
        to: "global",
        generality: "e2e vale para qualquer projeto que use o mesmo pacote",
        why: "e2e",
      });
    } finally {
      restaurarPromover();
    }

    expect(process.exitCode).not.toBe(1);
    const ref = subjectRef(subject);
    const globais = (await gotchasNoGlobal()).filter((r) => r.subject_ref === ref);
    expect(globais).toHaveLength(1);
    const promovido = globais[0]!;
    expect(promovido.scope).toEqual({ kind: "global", ref: null });
    expect(promovido.project_id).toBeUndefined();
    expect(promovido.subject_ref).toBe(ref);
    const content = contentOf(promovido);
    expect(content["generality"]).toBe("e2e vale para qualquer projeto que use o mesmo pacote");
    expect(content["verification_status"]).toBe("unverified");
  });
});

describe("contradição — mesma chave (family, kind, subject_ref) já corrente no global", () => {
  /**
   * `GLOBAL_ROOT` é compartilhado por TODO o arquivo (mesmo padrão de
   * `memory-scope.test.ts` T5/T6) — nunca reiniciado entre `it()`. Contar por
   * SUBJECT_REF próprio deste teste, não por tamanho total do array, é o que
   * torna a asserção robusta à ordem de execução dos outros testes deste
   * arquivo que também publicam no global.
   */
  it("segunda promoção com o mesmo subject recusa — conflito não se resolve sozinho", async () => {
    const subject = "assunto disputado i-contradicao";
    const ref = subjectRef(subject);
    const comEsseSubject = async (): Promise<number> =>
      (await gotchasNoGlobal()).filter((r) => r.subject_ref === ref).length;

    const primeiro = await publicarCandidato({
      fact: "primeira versão do fato disputado, suficientemente longa",
      memoryScope: "global",
    });
    const restaurarUm = mudo();
    try {
      await memory({
        cwd: root,
        promote: primeiro,
        to: "global",
        subject,
        generality: "vale fora do projeto",
        why: "primeira promoção",
      });
    } finally {
      restaurarUm();
    }
    expect(await comEsseSubject()).toBe(1);

    const segundo = await publicarCandidato({
      fact: "segunda versão, divergente, do mesmo assunto disputado",
      memoryScope: "global",
    });
    const restaurarDois = mudo();
    try {
      await memory({
        cwd: root,
        promote: segundo,
        to: "global",
        subject,
        generality: "vale fora do projeto",
        why: "segunda promoção",
      });
    } finally {
      restaurarDois();
    }

    expect(process.exitCode).toBe(1);
    // nenhum record NOVO sob a mesma chave — só o primeiro continua no global.
    expect(await comEsseSubject()).toBe(1);
  });
});

describe("schema — I31 e generality são obrigatórios em todo KnowledgeRecord global", () => {
  const base = (): Omit<CapsuleRecord, never> =>
    ({
      schema_version: 1,
      id: newRecordId("KnowledgeRecord"),
      family: "KnowledgeRecord",
      kind: "gotcha",
      scope: { kind: "global", ref: null },
      subject: "assunto de schema",
      subject_ref: subjectRef("assunto de schema"),
      origin: "agent",
      provenance: { source_ref: "nexos://teste/schema-global", producer_id: "test", submitted_at: AT },
      lifecycle: "immutable",
      portability: "portable",
      regenerable: false,
      admission: { status: "admitted", approved_by: "policy:test", approved_at: AT },
      sensitivity: { classification: "internal", checked_at: AT, checker_version: "t-1" },
      created_at: AT,
      version: 1,
      content: {
        title: "gotcha global de teste de schema",
        rule: "regra qualquer",
        generality: "vale fora do projeto",
        verification_status: "unverified",
      },
    }) as unknown as CapsuleRecord;

  it("global KnowledgeRecord com generality e verification_status corretos é válido", () => {
    const parsed = CapsuleRecordSchema.safeParse(base());
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });

  it("global KnowledgeRecord sem generality é INVALID_SCHEMA", () => {
    const r = base() as unknown as { content: Record<string, unknown> };
    delete r.content["generality"];
    const parsed = CapsuleRecordSchema.safeParse(r);
    expect(parsed.success).toBe(false);
  });

  it("I31: global KnowledgeRecord sem a marca de não-verificado é INVALID_SCHEMA", () => {
    const r = base() as unknown as { content: Record<string, unknown> };
    delete r.content["verification_status"];
    const parsed = CapsuleRecordSchema.safeParse(r);
    expect(parsed.success).toBe(false);
  });

  it("I31: global KnowledgeRecord com verification_status diferente de \"unverified\" é INVALID_SCHEMA", () => {
    const r = base() as unknown as { content: Record<string, unknown> };
    r.content["verification_status"] = "verified";
    const parsed = CapsuleRecordSchema.safeParse(r);
    expect(parsed.success).toBe(false);
  });
});
