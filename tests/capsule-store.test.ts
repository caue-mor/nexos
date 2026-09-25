/**
 * C2.2.5c — ProjectCapsuleStore.
 *
 *   SERIALIZE COMPLETELY → PUBLISH EXACTLY ONCE → NEVER OVERWRITE → RECOVER IDEMPOTENTLY
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  publishCanonical,
  publishSuperseding,
  releaseOrphanedClaim,
  claimTargetFor,
  StoreBoundaryError,
  HeadRaceExhaustedError,
  type FaultPoint,
} from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { serializeCanonical, parseCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId, newProjectId } from "../src/lib/capsule/ids.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { makeDecision, makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;
let projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c22c-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

/** Record admitido coerente com a capsule criada no beforeEach. */
function admitted(overrides: Record<string, unknown> = {}): CapsuleRecord {
  return makeDecision({ project_id: projectId, ...overrides });
}

/** Cria um proposal em .local/proposals e devolve seu path. */
async function withProposal(record: CapsuleRecord): Promise<string> {
  const p = forProject(root).proposals();
  await fs.ensureDir(p);
  const file = path.join(p, `${record.id}.yaml`);
  await fs.writeFile(file, serializeCanonical(record));
  return file;
}

const faultAt = (point: FaultPoint) => (p: FaultPoint) => {
  if (p === point) throw new Error(`FAULT_INJECTED:${point}`);
};

// ─── C01-C03 · publicação normal ────────────────────────────────────────────

describe("C01-C03 · publish", () => {
  it("C01 · record admitido publica", async () => {
    const r = admitted();
    const res = await publishCanonical(root, r);

    expect(res.outcome).toBe("CREATED");
    expect(await fs.pathExists(res.canonicalPath)).toBe(true);
    expect(res.canonicalPath).toBe(forProject(root).recordPath("Decision", r.id));
  });

  it("C02 · bytes canônicos == serializeCanonical(record)", async () => {
    const r = admitted();
    const res = await publishCanonical(root, r);
    expect(await fs.readFile(res.canonicalPath, "utf-8")).toBe(serializeCanonical(r));
  });

  it("C03 · staging fica em .local/publish, nunca sob records/", async () => {
    const r = admitted();
    await publishCanonical(root, r);
    const p = forProject(root);

    const underRecords = await fs.readdir(p.familyDir("Decision"));
    expect(underRecords.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(p.publishStaging()).toContain(path.join(".local", "publish"));
  });
});

// ─── C04-C08 · no-clobber e idempotência ────────────────────────────────────

describe("C04-C08 · no-clobber e recuperação idempotente", () => {
  it("C04/C05/C06 · bytes diferentes no mesmo id → CONFLICT, nada muda", async () => {
    const id = newRecordId("Decision");
    const a = admitted({ id, content: { title: "PostgreSQL", context: "c", decision: "d", consequences: ["x"] } });
    const b = admitted({ id, content: { title: "SQLite", context: "c", decision: "d", consequences: ["x"] } });

    const first = await publishCanonical(root, a);
    expect(first.outcome).toBe("CREATED");

    const proposal = await withProposal(b);
    const second = await publishCanonical(root, b, { proposalPath: proposal });

    expect(second.outcome).toBe("CONFLICT");
    // C05 · bytes antigos intactos
    expect(await fs.readFile(first.canonicalPath, "utf-8")).toBe(serializeCanonical(a));
    // C06 · proposal preservado para diagnóstico
    expect(await fs.pathExists(proposal)).toBe(true);
  });

  it("C07/C08 · mesmos bytes → ALREADY_PUBLISHED e proposal removido", async () => {
    const r = admitted();
    await publishCanonical(root, r);

    const proposal = await withProposal(r);
    const again = await publishCanonical(root, r, { proposalPath: proposal });

    expect(again.outcome).toBe("ALREADY_PUBLISHED");
    expect(await fs.readFile(again.canonicalPath, "utf-8")).toBe(serializeCanonical(r));
    expect(await fs.pathExists(proposal)).toBe(false);
  });
});

// ─── C09-C13 · fault injection ──────────────────────────────────────────────

describe("C09-C13 · falhas e recuperação", () => {
  it("C09 · falha AFTER_TEMP_WRITE → canônico ausente", async () => {
    const r = admitted();
    const proposal = await withProposal(r);
    const canonical = forProject(root).recordPath("Decision", r.id);

    await expect(
      publishCanonical(root, r, { proposalPath: proposal, onFault: faultAt("AFTER_TEMP_WRITE") })
    ).rejects.toThrow(/FAULT_INJECTED/);

    expect(await fs.pathExists(canonical)).toBe(false);
    expect(await fs.pathExists(proposal)).toBe(true);
  });

  it("C10 · falha BEFORE_PUBLISH → canônico ausente, proposal permanece", async () => {
    const r = admitted();
    const proposal = await withProposal(r);
    const canonical = forProject(root).recordPath("Decision", r.id);

    await expect(
      publishCanonical(root, r, { proposalPath: proposal, onFault: faultAt("BEFORE_PUBLISH") })
    ).rejects.toThrow(/FAULT_INJECTED/);

    expect(await fs.pathExists(canonical)).toBe(false);
    expect(await fs.pathExists(proposal)).toBe(true);
  });

  it("C11 · falha AFTER_PUBLISH → canônico COMPLETO e proposal permanece", async () => {
    const r = admitted();
    const proposal = await withProposal(r);
    const canonical = forProject(root).recordPath("Decision", r.id);

    await expect(
      publishCanonical(root, r, { proposalPath: proposal, onFault: faultAt("AFTER_PUBLISH") })
    ).rejects.toThrow(/FAULT_INJECTED/);

    expect(await fs.pathExists(canonical)).toBe(true);
    expect(await fs.readFile(canonical, "utf-8")).toBe(serializeCanonical(r));
    expect(await fs.pathExists(proposal)).toBe(true);
  });

  it("C12 · retry após C11 → ALREADY_PUBLISHED, proposal removido, canônico intacto", async () => {
    const r = admitted();
    const proposal = await withProposal(r);
    const canonical = forProject(root).recordPath("Decision", r.id);

    await publishCanonical(root, r, {
      proposalPath: proposal,
      onFault: faultAt("AFTER_PUBLISH"),
    }).catch(() => {});
    const bytesAfterCrash = await fs.readFile(canonical, "utf-8");

    const retry = await publishCanonical(root, r, { proposalPath: proposal });

    expect(retry.outcome).toBe("ALREADY_PUBLISHED");
    expect(await fs.readFile(canonical, "utf-8")).toBe(bytesAfterCrash);
    expect(await fs.pathExists(proposal)).toBe(false);
  });

  it("C13 · nenhum canônico parcial em nenhum ponto de falha", async () => {
    const points: FaultPoint[] = ["AFTER_TEMP_WRITE", "BEFORE_PUBLISH", "AFTER_PUBLISH"];
    for (const point of points) {
      const r = admitted({ id: newRecordId("Decision") });
      const canonical = forProject(root).recordPath("Decision", r.id);

      await publishCanonical(root, r, { onFault: faultAt(point) }).catch(() => {});

      if (await fs.pathExists(canonical)) {
        // se existe, tem que estar COMPLETO — nunca meio escrito
        expect(await fs.readFile(canonical, "utf-8")).toBe(serializeCanonical(r));
      }
    }
  });

  it("falha BEFORE_PROPOSAL_CLEANUP → canônico completo, proposal sobrevive", async () => {
    const r = admitted();
    const proposal = await withProposal(r);

    await expect(
      publishCanonical(root, r, {
        proposalPath: proposal,
        onFault: faultAt("BEFORE_PROPOSAL_CLEANUP"),
      })
    ).rejects.toThrow();

    expect(await fs.readFile(forProject(root).recordPath("Decision", r.id), "utf-8")).toBe(
      serializeCanonical(r)
    );
    expect(await fs.pathExists(proposal)).toBe(true);
  });
});

// ─── C14-C15 · concorrência ─────────────────────────────────────────────────

describe("C14-C15 · concorrência", () => {
  it("C14 · dois records DIFERENTES no mesmo id → exatamente um vence", async () => {
    const id = newRecordId("Decision");
    const a = admitted({ id, content: { title: "PostgreSQL", context: "c", decision: "d", consequences: ["x"] } });
    const b = admitted({ id, content: { title: "SQLite", context: "c", decision: "d", consequences: ["x"] } });

    const [ra, rb] = await Promise.all([
      publishCanonical(root, a),
      publishCanonical(root, b),
    ]);

    const outcomes = [ra.outcome, rb.outcome].sort();
    expect(outcomes).toEqual(["CONFLICT", "CREATED"]);

    // bytes finais são de A OU de B — jamais mistura
    const final = await fs.readFile(forProject(root).recordPath("Decision", id), "utf-8");
    expect([serializeCanonical(a), serializeCanonical(b)]).toContain(final);
  });

  it("C15 · dois records IDÊNTICOS concorrentes → sem conflito, bytes corretos", async () => {
    const r = admitted();
    const [x, y] = await Promise.all([
      publishCanonical(root, r),
      publishCanonical(root, r),
    ]);

    expect([x.outcome, y.outcome].sort()).toEqual(["ALREADY_PUBLISHED", "CREATED"]);
    expect(await fs.readFile(forProject(root).recordPath("Decision", r.id), "utf-8")).toBe(
      serializeCanonical(r)
    );
  });
});

// ─── C16-C20 · fronteira do Store ───────────────────────────────────────────

describe("C16-C20 · fronteira", () => {
  it("C16 · family não canônica é rejeitada", async () => {
    await expect(
      publishCanonical(root, admitted({ family: "RuntimeState", id: "rst_x" }))
    ).rejects.toThrow();
  });

  it("C17 · record NÃO admitido é rejeitado", async () => {
    await expect(
      publishCanonical(root, admitted({ admission: { status: "proposed" } }))
    ).rejects.toThrow(StoreBoundaryError);
    await expect(
      publishCanonical(root, admitted({ admission: { status: "rejected" } }))
    ).rejects.toThrow(/Admissão é da AdmissionPolicy/);
  });

  it("C18 · family/id divergentes são rejeitados", async () => {
    const knowledgeId = newRecordId("KnowledgeRecord");
    await expect(
      publishCanonical(root, admitted({ id: knowledgeId }))
    ).rejects.toThrow(StoreBoundaryError);
  });

  it("C19 · staging removido após sucesso", async () => {
    await publishCanonical(root, admitted());
    const leftovers = await fs.readdir(forProject(root).publishStaging());
    expect(leftovers).toHaveLength(0);
  });

  it("C20 · proposal removido SOMENTE após publicação bem-sucedida", async () => {
    const r = admitted();
    const proposal = await withProposal(r);
    expect(await fs.pathExists(proposal)).toBe(true);

    await publishCanonical(root, r, { proposalPath: proposal });
    expect(await fs.pathExists(proposal)).toBe(false);
  });

  it("publica outras families canônicas no diretório certo", async () => {
    const g = makeGotcha({ project_id: projectId });
    const res = await publishCanonical(root, g);
    expect(res.canonicalPath).toContain(path.join("records", "knowledge"));
  });
});

// ─── C21-C23 · regressão de fronteira ───────────────────────────────────────

describe("C21-C23 · independência de git e host", () => {
  it("C21 · publica sem git no projeto", async () => {
    expect(await fs.pathExists(path.join(root, ".git"))).toBe(false);
    const res = await publishCanonical(root, admitted());
    expect(res.outcome).toBe("CREATED");
  });

  it("C22/C23 · store.ts não referencia ~/.claude nem state/memory", async () => {
    const src = await fs.readFile("src/lib/capsule/store.ts", "utf-8");
    expect(src).not.toMatch(/\.claude|CLAUDE_|state\.md|gotchas\.md|MEMORY\.md/);
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    /**
     * `../constants.js` é permitido a partir de T3 (plano de memória em
     * camadas v3.2) — só `GLOBAL_ROOT`, mesma constante que `authority.ts`
     * já importa de lá (`NEXOS_HOME`). Continua sem `./` fora de `capsule/`.
     */
    expect(
      imports.filter(
        (i) => !i.startsWith("node:") && !i.startsWith("./") && i !== "../constants.js"
      )
    ).toEqual([]);
  });
});

// ─── C24-C33 · publishSuperseding — CAS sobre o head ────────────────────────
//
// B7-A..G, B3-bis e B6 do node de recuperação: mesma disciplina de C14/C15
// (concorrência), mas sobre a primitiva de LINHAGEM, não sobre no-clobber cru.

describe("C24-C33 · publishSuperseding — CAS sobre o head", () => {
  const KIND = "gotcha";
  const NOW = "2026-08-19T00:00:00.000Z";

  async function headAtual(sourceRef: string): Promise<{ id: string } | undefined> {
    const r = await readCurrentRecords(root, { kind: KIND });
    if (!r.ok) return undefined;
    const atual = r.records.find((x) => x.sourceRef === sourceRef);
    return atual ? { id: (atual.record as { id: string }).id } : undefined;
  }

  function buildRecordFor(sourceRef: string, value: string) {
    return (head: { id: string } | undefined): CapsuleRecord =>
      makeGotcha({
        project_id: projectId,
        id: newRecordId("KnowledgeRecord"),
        provenance: { source_ref: sourceRef, producer_id: "cas-test", submitted_at: NOW },
        content: { title: value, mitigation: "cas-test", evidence: "cas-test" },
        ...(head ? { supersedes: head.id } : {}),
      });
  }

  async function write(sourceRef: string, value: string) {
    return publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef,
      readHead: () => headAtual(sourceRef),
      buildRecord: buildRecordFor(sourceRef, value),
    });
  }

  async function currentRecordsFor(sourceRef: string) {
    const r = await readCurrentRecords(root, { kind: KIND });
    if (!r.ok) throw new Error(`leitura falhou: ${r.issues.map((i) => i.code).join(", ")}`);
    return r.records.filter((x) => x.sourceRef === sourceRef);
  }

  it("B7-A · dois concorrentes no MESMO source_ref → 1 head canônico, 0 anomalias", async () => {
    const ref = "nexos://cas-test/b7a";
    const [a, b] = await Promise.all([write(ref, "a"), write(ref, "b")]);

    expect([a.outcome, b.outcome]).toEqual(["CREATED", "CREATED"]);
    expect(a.record.id).not.toBe(b.record.id);

    const heads = await currentRecordsFor(ref);
    expect(heads).toHaveLength(1);
  });

  it("B7-B · cinco concorrentes no MESMO source_ref → mesma invariante", async () => {
    const ref = "nexos://cas-test/b7b";
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => write(ref, `v${n}`)));

    expect(results.every((r) => r.outcome === "CREATED")).toBe(true);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(5);

    const heads = await currentRecordsFor(ref);
    expect(heads).toHaveLength(1);
  });

  it("B7-C · source_refs DIFERENTES em paralelo não se bloqueiam", async () => {
    const refs = ["nexos://cas-test/b7c-1", "nexos://cas-test/b7c-2"] as const;

    const t0 = Date.now();
    await Promise.all(refs.map((ref) => write(ref, "x")));
    const paralelo = Date.now() - t0;

    const t1 = Date.now();
    for (const ref of refs) await write(ref, "y");
    const sequencial = Date.now() - t1;

    // eslint-disable-next-line no-console
    console.log(`B7-C tempos: paralelo=${paralelo}ms sequencial=${sequencial}ms`);

    for (const ref of refs) {
      const heads = await currentRecordsFor(ref);
      expect(heads).toHaveLength(1);
    }
  });

  it("B7-D · vencedor publica → supersessão legítima seguinte funciona", async () => {
    const ref = "nexos://cas-test/b7d";
    await write(ref, "v1");
    const head1 = await headAtual(ref);

    const r2 = await write(ref, "v2");
    expect(r2.outcome).toBe("CREATED");
    expect((r2.record as { supersedes?: string }).supersedes).toBe(head1!.id);

    const heads = await currentRecordsFor(ref);
    expect(heads).toHaveLength(1);
  });

  it("B3-bis · falha DENTRO de buildRecord (Defeito 1) → claim liberado, escrita seguinte funciona", async () => {
    const ref = "nexos://cas-test/b3bis";
    const target = claimTargetFor(root, "KnowledgeRecord", ref, undefined);

    await expect(
      publishSuperseding(root, {
        family: "KnowledgeRecord",
        sourceRef: ref,
        readHead: () => headAtual(ref),
        buildRecord: () => {
          throw new StoreBoundaryError("simulando falha DENTRO de buildRecord");
        },
      })
    ).rejects.toThrow(/simulando falha/);

    /** Sem o fix do Defeito 1, este claim ficaria órfão para sempre. */
    expect(await fs.pathExists(target)).toBe(false);

    const retry = await write(ref, "depois-da-falha");
    expect(retry.outcome).toBe("CREATED");
  });

  it("B7-F · claim órfão → leitura permanece íntegra (records > 0, 0 anomalias)", async () => {
    const ref = "nexos://cas-test/b7f";
    await write(ref, "v1");
    const head1 = await headAtual(ref);

    /** Crash simulado ENTRE claim e publish: órfão puro, nenhum record novo. */
    const target = claimTargetFor(root, "KnowledgeRecord", ref, head1!.id);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, `${head1!.id}\n`);

    const r = await readCurrentRecords(root, { kind: KIND });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records.length).toBeGreaterThan(0);
      expect(r.anomalies).toEqual([]);
    }
  });

  it("B7-G · nenhum cenário devolve dois códigos de sucesso para irmãos divergentes", async () => {
    const ref = "nexos://cas-test/b7g";
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => write(ref, `v${i}`)));

    expect(results.every((r) => r.outcome === "CREATED")).toBe(true);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(N);

    const heads = await currentRecordsFor(ref);
    expect(heads).toHaveLength(1);
  });

  it("B6 · N escritas sequenciais → 1 claim novo por escrita, sem poda (Defeito 3)", async () => {
    const ref = "nexos://cas-test/b6";
    const claimsDir = path.join(forProject(root).localRoot(), "head-claims", "KnowledgeRecord");

    const before = (await fs.pathExists(claimsDir)) ? (await fs.readdir(claimsDir)).length : 0;
    const N = 6;
    for (let i = 0; i < N; i++) await write(ref, `seq-${i}`);
    const after = (await fs.readdir(claimsDir)).length;

    expect(after - before).toBe(N);
  });

  it("HeadRaceExhaustedError · maxAttempts esgotado sob contenção artificial não escreve nada", async () => {
    const ref = "nexos://cas-test/exhausted";
    const target = claimTargetFor(root, "KnowledgeRecord", ref, undefined);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, "ROOT\n");

    const erro = await publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef: ref,
      readHead: () => headAtual(ref),
      buildRecord: buildRecordFor(ref, "nunca-publica"),
      maxAttempts: 2,
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(HeadRaceExhaustedError);
    const exausto = erro as HeadRaceExhaustedError;

    /**
     * O erro precisa ENTREGAR o alvo do reparo: sem o path, o operador teria que
     * hashear `source_ref` na mão. E precisa nomear o reparo — `releaseOrphanedClaim`
     * não tem superfície de CLI, então a mensagem é o único caminho até a ação.
     */
    expect(exausto.claimTarget).toBe(target);
    expect(exausto.parentId).toBeUndefined();
    expect(exausto.message).toContain(target);
    expect(exausto.message).toContain("REPARO:");
    /** Nunca voltar a afirmar o que o laço não mede. */
    expect(exausto.message).not.toContain("concorrência persistente");

    const heads = await currentRecordsFor(ref);
    expect(heads).toHaveLength(0);
  });

  it("claim liberado à mão · head ausente volta a publicar como CREATED", async () => {
    const ref = "nexos://cas-test/exhausted-then-released";
    const target = claimTargetFor(root, "KnowledgeRecord", ref, undefined);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, "ROOT\n");

    await expect(
      publishSuperseding(root, {
        family: "KnowledgeRecord",
        sourceRef: ref,
        readHead: () => headAtual(ref),
        buildRecord: buildRecordFor(ref, "barrado"),
        maxAttempts: 2,
      })
    ).rejects.toThrow(HeadRaceExhaustedError);

    await fs.remove(target);

    const { outcome } = await publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef: ref,
      readHead: () => headAtual(ref),
      buildRecord: buildRecordFor(ref, "publicado"),
      maxAttempts: 2,
    });

    expect(outcome).toBe("CREATED");
    expect(await currentRecordsFor(ref)).toHaveLength(1);
  });
});

// ─── Defeito 2 · publishSuperseding — claim na partição de authority ───────
//
// A `authority` aqui é a mesma authority única por `project_id` de
// `capsule-authority.test.ts` (ADR-070-adj): dois roots do mesmo project_id,
// um deles REDIRECTED para o outro. ANTES desta correção, `publishSuperseding`
// reivindicava o claim sempre em `forProject(rootPath)` — o candidato — mesmo
// quando o record, via `publishCanonical`, ia parar em `authority.activeRoot`.
// Assim que um segundo root do mesmo project_id era REDIRECTED, os dois
// paravam de compartilhar claim: cada um "vencia" sua própria corrida vazia.

describe("Defeito 2 · publishSuperseding — claim segue a authority, não o candidato", () => {
  const KIND = "gotcha";
  const NOW = "2026-09-05T00:00:00.000Z";

  async function makeAuthorityRoot(dirName: string, id: string): Promise<string> {
    const r = path.join(ws, dirName);
    await fs.ensureDir(r);
    await initializeCapsule(r, { projectName: dirName, generateProjectId: () => id });
    return r;
  }

  function buildRecordFor(id: string, ref: string, value: string) {
    return (head: { id: string } | undefined): CapsuleRecord =>
      makeGotcha({
        project_id: id,
        id: newRecordId("KnowledgeRecord"),
        provenance: { source_ref: ref, producer_id: "cas-test-defeito2", submitted_at: NOW },
        content: { title: value, mitigation: "cas-test", evidence: "cas-test" },
        ...(head ? { supersedes: head.id } : {}),
      });
  }

  it("claim de B aterrissa na MESMA partição do record (activeRoot = A), nunca em B", async () => {
    const id = newProjectId();
    const rootA = await makeAuthorityRoot("defeito2-A", id);
    const rootB = await makeAuthorityRoot("defeito2-B", id);
    const ref = "nexos://cas-test/defeito2-partition";

    // Primeiro publish, via A: primeiro contato com este project_id — CLAIMED, activeRoot = A.
    const first = await publishSuperseding(rootA, {
      family: "KnowledgeRecord",
      sourceRef: ref,
      readHead: async () => undefined,
      buildRecord: buildRecordFor(id, ref, "v1-de-A"),
    });
    expect(first.outcome).toBe("CREATED");

    // Segundo publish, via B, supersedendo o head — lido diretamente de A: `readCurrentRecords`
    // não é ciente de authority (lê `forProject(rootPath)` cru), então um caller que já sabe
    // onde a authority mora lê de lá. Fora do escopo desta correção (afeta LEITURA, não o claim).
    const headViaA = await readCurrentRecords(rootA, { kind: KIND });
    if (!headViaA.ok) throw new Error("leitura falhou");
    const atual = headViaA.records.find((x) => x.sourceRef === ref);
    if (!atual) throw new Error("head não encontrado em A");
    const head = { id: (atual.record as { id: string }).id };

    const second = await publishSuperseding(rootB, {
      family: "KnowledgeRecord",
      sourceRef: ref,
      readHead: async () => head,
      buildRecord: buildRecordFor(id, ref, "v2-de-B"),
    });
    expect(second.outcome).toBe("CREATED");
    /** O record de B aterrissa sob A (REDIRECTED) — mesma invariante de capsule-authority.test.ts. */
    expect(second.canonicalPath.startsWith(forProject(rootA).recordsRoot())).toBe(true);

    /**
     * A PROVA do Defeito 2: o claim desta transição (sourceRef, parentId=head.id)
     * precisa existir na partição de A (activeRoot) — nunca na de B. SEM a
     * correção, `publishSuperseding(rootB, ...)` reivindicava sob
     * `forProject(rootB)` (o candidato cru): este par de asserções falha —
     * `targetEmA` ausente, `targetEmB` presente.
     */
    const targetEmA = claimTargetFor(rootA, "KnowledgeRecord", ref, head.id);
    const targetEmB = claimTargetFor(rootB, "KnowledgeRecord", ref, head.id);
    expect(await fs.pathExists(targetEmA)).toBe(true);
    expect(await fs.pathExists(targetEmB)).toBe(false);
  });

  it("dois roots do MESMO project_id disputam o MESMO sourceRef, concorrentes → 1 head canônico (nunca DIVERGED)", async () => {
    const id = newProjectId();
    const rootA = await makeAuthorityRoot("defeito2-race-A", id);
    const rootB = await makeAuthorityRoot("defeito2-race-B", id);
    const ref = "nexos://cas-test/defeito2-race";

    /**
     * Estabelece authority = A deterministicamente, com um source_ref de
     * AQUECIMENTO, ANTES da corrida real — isola o Defeito 2 (partição do
     * claim) da resolução do PRIMEIRO contato de authority para um
     * project_id novo, que é ela própria uma corrida SEPARADA e pré-existente
     * (`resolveActiveRoot` usa write+rename, não `link()` no-clobber, no
     * caminho CLAIMED). Sem isto, este teste mediria as duas coisas
     * misturadas e poderia ficar instável por um motivo que não é este.
     */
    await publishSuperseding(rootA, {
      family: "KnowledgeRecord",
      sourceRef: "nexos://cas-test/defeito2-race-aquecimento",
      readHead: async () => undefined,
      buildRecord: buildRecordFor(id, "nexos://cas-test/defeito2-race-aquecimento", "aquecimento"),
    });

    /**
     * `readHead` lê SEMPRE de `rootA` para os dois lados — de propósito.
     * `readCurrentRecords` (reader.ts) não é ciente de authority: lê
     * `forProject(rootPath)` cru, e todo record deste `project_id` aterrissa
     * fisicamente sob `rootA` (a authority estabelecida no aquecimento). Se B
     * lesse de `forProject(rootB)` (sempre vazio), nunca enxergaria o head que
     * A publica, giraria para sempre tentando a MESMA transição ROOT já
     * reivindicada, e estouraria `HeadRaceExhaustedError` por um motivo
     * ORTOGONAL ao Defeito 2 (visibilidade de leitura entre roots, gap
     * pré-existente e fora de escopo — não é o que este teste mede).
     * Ler sempre de `rootA` isola exatamente o que se quer provar: que o
     * CLAIM de B, e não a leitura, agora vive na partição certa.
     */
    async function headAtualViaA(): Promise<{ id: string } | undefined> {
      const r = await readCurrentRecords(rootA, { kind: KIND });
      if (!r.ok) return undefined;
      const atual = r.records.find((x) => x.sourceRef === ref);
      return atual ? { id: (atual.record as { id: string }).id } : undefined;
    }

    const [a, b] = await Promise.all([
      publishSuperseding(rootA, {
        family: "KnowledgeRecord",
        sourceRef: ref,
        readHead: headAtualViaA,
        buildRecord: buildRecordFor(id, ref, "de-A"),
      }),
      publishSuperseding(rootB, {
        family: "KnowledgeRecord",
        sourceRef: ref,
        readHead: headAtualViaA,
        buildRecord: buildRecordFor(id, ref, "de-B"),
      }),
    ]);

    expect([a.outcome, b.outcome]).toEqual(["CREATED", "CREATED"]);
    expect(a.record.id).not.toBe(b.record.id);

    /**
     * A e B convergem para a MESMA authority (A, estabelecida no aquecimento) —
     * o resultado físico é visível de qualquer um dos dois roots. SEM a
     * correção do Defeito 2, os dois reivindicavam em partições diferentes
     * (`forProject(rootA)` vs `forProject(rootB)`), "venciam" cada um sua
     * própria corrida vazia, e produziam DOIS heads sem `supersedes` entre
     * si — DIVERGED, exatamente a falha que `HeadRaceExhaustedError`/o CAS
     * existem para impedir.
     */
    const current = await readCurrentRecords(rootA, { kind: KIND });
    if (!current.ok) throw new Error("leitura falhou");
    expect(current.records.filter((x) => x.sourceRef === ref)).toHaveLength(1);
  });
});

// ─── C34-C36 · releaseOrphanedClaim — reparo explícito do operador ──────────

describe("C34-C36 · releaseOrphanedClaim (Defeito 4)", () => {
  const KIND = "gotcha";
  const NOW = "2026-08-19T00:00:00.000Z";

  async function headAtual(sourceRef: string): Promise<{ id: string } | undefined> {
    const r = await readCurrentRecords(root, { kind: KIND });
    if (!r.ok) return undefined;
    const atual = r.records.find((x) => x.sourceRef === sourceRef);
    return atual ? { id: (atual.record as { id: string }).id } : undefined;
  }

  async function write(sourceRef: string, value: string) {
    return publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef,
      readHead: () => headAtual(sourceRef),
      buildRecord: (head) =>
        makeGotcha({
          project_id: projectId,
          id: newRecordId("KnowledgeRecord"),
          provenance: { source_ref: sourceRef, producer_id: "cas-test", submitted_at: NOW },
          content: { title: value, mitigation: "cas-test", evidence: "cas-test" },
          ...(head ? { supersedes: head.id } : {}),
        }),
    });
  }

  it("recusa sem attestDeadWriter — FAIL CLOSED na ambiguidade", async () => {
    const ref = "nexos://cas-test/release-refuse";
    const target = claimTargetFor(root, "KnowledgeRecord", ref, undefined);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, "ROOT\n");

    const semAtestado = { reason: "x" } as unknown as { attestDeadWriter: true; reason: string };
    await expect(releaseOrphanedClaim(target, semAtestado)).rejects.toThrow(StoreBoundaryError);
    expect(await fs.pathExists(target)).toBe(true);
  });

  it("libera o claim nomeado e destrava a próxima escrita, sem tocar records/", async () => {
    const ref = "nexos://cas-test/release-ok";
    await write(ref, "v1");
    const head1 = await headAtual(ref);
    const target = claimTargetFor(root, "KnowledgeRecord", ref, head1!.id);

    /** Escritor que reivindicou e morreu antes de publicar — órfão puro. */
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, `${head1!.id}\n`);

    const antes = await fs.readdir(forProject(root).familyDir("KnowledgeRecord"));

    const result = await releaseOrphanedClaim(target, {
      attestDeadWriter: true,
      reason: "teste: processo confirmado morto",
    });
    expect(result.released).toBe(true);
    expect(result.parentId).toBe(head1!.id);
    expect(await fs.pathExists(target)).toBe(false);

    /** records/ intacto — releaseOrphanedClaim nunca publica nem apaga record. */
    const depois = await fs.readdir(forProject(root).familyDir("KnowledgeRecord"));
    expect(depois).toEqual(antes);

    const retry = await write(ref, "v2");
    expect(retry.outcome).toBe("CREATED");
  });

  it("claim inexistente → released:false, sem lançar", async () => {
    const target = claimTargetFor(root, "KnowledgeRecord", "nexos://cas-test/nao-existe", undefined);
    const result = await releaseOrphanedClaim(target, { attestDeadWriter: true, reason: "x" });
    expect(result.released).toBe(false);
  });
});

// ─── C50-C53 · a auto-citação morre NO ESCRITOR, não em cada produtor ────────

/**
 *   A CLAIM IS NOT ITS OWN EVIDENCE
 *
 * A regra existia desde 4336e6f, aplicada à mão em `gotcha.ts` e `state.ts`.
 * Os outros nove chamadores de `publishCanonical` nunca a viram. Estes testes
 * batem no ESCRITOR — se a guarda voltar para os produtores, eles ficam
 * vermelhos independentemente de qual comando publicou.
 */
describe("C50-C53 · publishCanonical remove a auto-citação de evidence_refs", () => {
  /** Lê do DISCO, nunca do valor retornado: o disco é a autoridade. */
  async function noDisco(canonicalPath: string): Promise<{ evidence_refs?: string[] }> {
    return parseCanonical(await fs.readFile(canonicalPath, "utf-8")) as { evidence_refs?: string[] };
  }

  it("C50 · ref idêntica ao próprio source_ref sai — e o campo some, não vira []", async () => {
    const r = admitted({
      provenance: {
        source_ref: "nexos://gotcha/nao-se-autocita",
        producer_id: "produtor-que-nunca-viu-a-regra",
        submitted_at: "2026-08-12T12:00:00.000Z",
      },
      evidence_refs: ["nexos://gotcha/nao-se-autocita"],
    });
    const res = await publishCanonical(root, r);

    const gravado = await noDisco(res.canonicalPath);
    expect(gravado.evidence_refs).toBeUndefined();
    /** `ABSENCE = FIELD ABSENT` — `[]` afirmaria "procurei e não achei". */
    expect("evidence_refs" in gravado).toBe(false);
    /** O record devolvido é o que foi ao disco, não o submetido. */
    expect((res.record as { evidence_refs?: string[] }).evidence_refs).toBeUndefined();
  });

  it("C51 (POSITIVO) · ref EXTERNA sobrevive ao lado da auto-citação removida", async () => {
    const r = admitted({
      provenance: {
        source_ref: "nexos://gotcha/mistura",
        producer_id: "produtor-que-nunca-viu-a-regra",
        submitted_at: "2026-08-12T12:00:00.000Z",
      },
      evidence_refs: ["nexos://gotcha/mistura", "src/lib/capsule/store.ts:302"],
    });
    const res = await publishCanonical(root, r);

    expect((await noDisco(res.canonicalPath)).evidence_refs).toEqual([
      "src/lib/capsule/store.ts:302",
    ]);
  });

  it("C52 (POSITIVO) · source_ref que É um artefato no disco NÃO é auto-citação", async () => {
    /** Os 7 records do gotcha-migrator: o source_ref é um arquivo real, anterior ao record. */
    const ref = ".nexos/memory/project/gotchas.md#GOTCHA-017";
    const r = admitted({
      provenance: {
        source_ref: ref,
        producer_id: "c12-gotcha-migrator",
        submitted_at: "2026-08-12T12:00:00.000Z",
      },
      evidence_refs: [ref],
    });
    const res = await publishCanonical(root, r);

    expect((await noDisco(res.canonicalPath)).evidence_refs).toEqual([ref]);
  });

  it("C53 · vale para quem publica via publishSuperseding, não só na chamada direta", async () => {
    const ref = "nexos://cas-test/autocitacao";
    const { record, canonicalPath } = await publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef: ref,
      readHead: async () => undefined,
      buildRecord: () =>
        makeGotcha({
          project_id: projectId,
          provenance: {
            source_ref: ref,
            producer_id: "produtor-que-nunca-viu-a-regra",
            submitted_at: "2026-08-12T12:00:00.000Z",
          },
          evidence_refs: [ref],
        }),
    });

    expect((record as { evidence_refs?: string[] }).evidence_refs).toBeUndefined();
    expect((await noDisco(canonicalPath)).evidence_refs).toBeUndefined();
  });
});
