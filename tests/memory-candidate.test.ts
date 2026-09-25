/**
 * D6 — MemoryCandidate. O Store é a verdade; o host é fonte de contexto.
 *
 *   CANDIDATO != MEMÓRIA ADMITIDA
 *   PROMOVER POR SINCRONIZAÇÃO É ADMITIR SEM DECIDIR
 *   EVIDENCE != ASSERTION
 *
 * O acceptance do Memory Engine que estes testes fecham: "transcript de sessão
 * nunca vira memória automaticamente". A defesa não é disciplina — é que o
 * candidato não tem caminho para o contexto ativo sem uma decisão.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  buildMemoryCandidate,
  decideAdmission,
  MemoryCandidateError,
} from "../src/lib/capsule/memory-candidate.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { assembleContext } from "../src/lib/context-assembler.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { resolveCanonicalNow } from "../src/lib/project-state-inspector.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-28T00:00:00.000Z";
let ws: string, root: string;

const candidato = (projectId: string, over: Record<string, unknown> = {}): CapsuleRecord =>
  buildMemoryCandidate({
    projectId,
    fact: "o gate typecheck:all cobre tests/, o tsc --noEmit não",
    originNote: "revisão humana da sessão de 2026-08-27",
    evidence: "tsconfig.check.json vs tsconfig.json",
    proposedKind: "gotcha",
    recordId: newRecordId("KnowledgeRecord"),
    observedAt: NOW,
    ...over,
  } as Parameters<typeof buildMemoryCandidate>[0]);

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "memcand-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await initializeCapsule(root, { projectName: "proj" });
});
afterEach(async () => {
  await fs.remove(ws);
});

async function projectId(): Promise<string> {
  const c = await resolveCanonicalNow(root);
  if (!c.ok) throw new Error("não canônico");
  return c.projectId;
}

describe("o candidato exige origem e evidência", () => {
  it("fato sem origem é recusado — boato com formato de record", async () => {
    const pid = await projectId();
    expect(() => candidato(pid, { originNote: "  " })).toThrow(MemoryCandidateError);
  });

  it("fato sem evidência é recusado — EVIDENCE != ASSERTION", async () => {
    const pid = await projectId();
    expect(() => candidato(pid, { evidence: "" })).toThrow(MemoryCandidateError);
  });

  it("fato vazio é recusado", async () => {
    const pid = await projectId();
    expect(() => candidato(pid, { fact: "   " })).toThrow(MemoryCandidateError);
  });

  it("candidato completo é válido contra o schema canônico", async () => {
    const pid = await projectId();
    await expect(publishCanonical(root, candidato(pid))).resolves.toBeDefined();
  });
});

describe("CANDIDATO != MEMÓRIA ADMITIDA", () => {
  /**
   * O teste central de D6. O candidato está no Store, é válido, e MESMO ASSIM
   * não chega ao contexto do agente — porque promover é um ato, não uma
   * consequência de ter sido escrito.
   */
  it("candidato publicado NÃO entra no contexto ativo", async () => {
    const pid = await projectId();
    await publishCanonical(root, candidato(pid));

    /** Está no Store — a leitura direta o encontra. */
    const store = await readCurrentRecords(root, { kind: "memory_candidate" });
    expect(store.ok && store.records).toHaveLength(1);

    /** E não está no contexto — nenhuma sincronização automática o promoveu. */
    const ctx = await assembleContext({ projectRoot: root, intent: "typecheck gate cobre tests" });
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      const refs = ctx.pack.items.map((i) => i.sourceRef).join(" ");
      expect(refs).not.toContain("memory-candidate");
    }
  });
});

describe("a admissão é uma DECISÃO, nunca um default", () => {
  it("sem aprovação humana, o candidato permanece proposta", async () => {
    const pid = await projectId();
    const v = decideAdmission({ candidate: candidato(pid), humanApproved: false, why: "" });
    expect(v.admit).toBe(false);
    if (!v.admit) expect(v.why).toContain("permanece proposta");
  });

  it("com aprovação, o veredito diz para qual kind promover", async () => {
    const pid = await projectId();
    const v = decideAdmission({ candidate: candidato(pid), humanApproved: true, why: "confirmado na revisão" });
    expect(v.admit).toBe(true);
    if (v.admit) {
      expect(v.targetKind).toBe("gotcha");
      expect(v.why).toBe("confirmado na revisão");
    }
  });

  /** A admissão não adivinha destino — nem quando aprovada. */
  it("proposed_kind inválido não é promovido, mesmo aprovado", async () => {
    const pid = await projectId();
    const quebrado = { ...candidato(pid) } as unknown as { content: Record<string, unknown> };
    quebrado.content = { ...quebrado.content, proposed_kind: "qualquer-coisa" };

    const v = decideAdmission({
      candidate: quebrado as unknown as CapsuleRecord,
      humanApproved: true,
      why: "",
    });
    expect(v.admit).toBe(false);
    if (!v.admit) expect(v.why).toContain("não adivinha destino");
  });

  it("record que não é candidato não tem o que promover", async () => {
    const v = decideAdmission({
      candidate: { kind: "gotcha" } as unknown as CapsuleRecord,
      humanApproved: true,
      why: "",
    });
    expect(v.admit).toBe(false);
    if (!v.admit) expect(v.why).toContain("nada a promover");
  });

  /**
   * `decideAdmission` DEVOLVE o veredito e não escreve nada — mesma disciplina
   * de `applyCandidate`: quem julga não é quem escreve.
   */
  it("decidir não escreve: o Store fica igual antes e depois", async () => {
    const pid = await projectId();
    const c = candidato(pid);
    await publishCanonical(root, c);

    const antes = await readCurrentRecords(root);
    decideAdmission({ candidate: c, humanApproved: true, why: "aprovado" });
    const depois = await readCurrentRecords(root);

    expect(antes.ok && depois.ok).toBe(true);
    if (antes.ok && depois.ok) expect(depois.records.length).toBe(antes.records.length);
  });
});
