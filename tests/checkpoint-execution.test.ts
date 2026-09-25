/**
 * Harness V1 slice 1 — a cadeia de estados e o resume, ANTES de qualquer
 * dispatch real. `HOST EXECUTES · NEXOS GOVERNS · HARNESS ORCHESTRATES`.
 *
 * Cinco contrafactuais obrigatórios: transição impossível, resume,
 * integridade da cadeia (wiring com `integrity.ts`), projeto estrangeiro,
 * dispatch duplicado (CAS de `store.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  advanceCheckpoint,
  resumeCheckpoint,
  resolveCheckpointHead,
  retryCheckpoint,
} from "../src/lib/capsule/checkpoint.js";
import { applyCheckpointTransition } from "../src/lib/capsule/checkpoint-transition.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId, newProjectId } from "../src/lib/capsule/ids.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { makeCheckpoint } from "./capsule-fixtures.js";
import { scanIntegrity } from "../src/lib/capsule/integrity.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "chk-exec-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

const withProject = (r: CapsuleRecord): CapsuleRecord => ({ ...r, project_id: projectId }) as CapsuleRecord;

/** Escreve direto no disco — FABRICA corrupção/ataque que o produtor jamais escreveria sozinho. */
async function writeRaw(fileName: string, content: string): Promise<void> {
  const dir = forProject(root).familyDir("ProjectCheckpoint");
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, fileName), content);
}

async function countCheckpointFiles(): Promise<number> {
  const dir = forProject(root).familyDir("ProjectCheckpoint");
  return (await fs.pathExists(dir)) ? (await fs.readdir(dir)).length : 0;
}

// ─── caminho feliz ──────────────────────────────────────────────────────────

describe("advanceCheckpoint · caminho feliz", () => {
  it("raiz nasce PENDING, encadeia por previous_checkpoint_id", async () => {
    const r1 = await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.record.family).toBe("ProjectCheckpoint");
    expect((r1.record as { previous_checkpoint_id: string | null }).previous_checkpoint_id).toBeNull();

    const r2 = await advanceCheckpoint({ projectRoot: root, state: "READY" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect((r2.record as { previous_checkpoint_id: string | null }).previous_checkpoint_id).toBe(r1.record.id);
    /** statement herdado do head — não repetido pelo caller. */
    expect((r2.record as { content: { statement: string } }).content.statement).toBe("S1");
  });

  it("raiz sem --statement é recusada: cadeia vazia não tem o que herdar", async () => {
    const r = await advanceCheckpoint({ projectRoot: root, state: "PENDING" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MISSING_STATEMENT");
  });

  it("raiz com estado != PENDING é recusada", async () => {
    const r = await advanceCheckpoint({ projectRoot: root, state: "RUNNING", statement: "S1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("TRANSITION_REJECTED");
  });
});

// ─── CF1 · transição impossível ────────────────────────────────────────────

describe("CF1 · transição impossível", () => {
  it("SUCCEEDED -> RUNNING é recusada — estado terminal", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: root, state: "VERIFYING" });
    const succeeded = await advanceCheckpoint({ projectRoot: root, state: "SUCCEEDED" });
    expect(succeeded.ok).toBe(true);

    const nCheckpointsBefore = await countCheckpointFiles();
    const r = await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("TRANSITION_REJECTED");
    if (r.reason !== "TRANSITION_REJECTED") return;
    expect(r.why).toContain("SUCCEEDED");
    /** Recusa é FAIL CLOSED de verdade: nada novo foi escrito. */
    expect(await countCheckpointFiles()).toBe(nCheckpointsBefore);
  });

  it("PENDING -> SUCCEEDED pula etapa — recusada", async () => {
    const verdict = applyCheckpointTransition("PENDING", "SUCCEEDED");
    expect(verdict.allowed).toBe(false);
  });

  it("FAILED -> READY é permitida no validador puro — única saída de um terminal, nasce TAREFA NOVA (decisão do operador 2026-09-07, não retry automático)", async () => {
    const verdict = applyCheckpointTransition("FAILED", "READY");
    expect(verdict.allowed).toBe(true);
  });

  it("auto-transição (RUNNING -> RUNNING) é recusada", async () => {
    const verdict = applyCheckpointTransition("RUNNING", "RUNNING");
    expect(verdict.allowed).toBe(false);
  });
});

// ─── CF2 · resume ───────────────────────────────────────────────────────────

describe("CF2 · resume — SESSION != EXECUTION", () => {
  it("sessão nova retoma no estado exato do head, sem reexecutar", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "gate de evidência" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    const verifying = await advanceCheckpoint({ projectRoot: root, state: "VERIFYING" });
    expect(verifying.ok).toBe(true);
    if (!verifying.ok) return;

    const nBefore = await countCheckpointFiles();

    /** "Sessão morre" = nada além do filesystem sobrevive; uma leitura pura simula a próxima sessão. */
    const resumed = await resumeCheckpoint(root);
    expect(resumed.kind).toBe("RESUMED");
    if (resumed.kind !== "RESUMED") return;
    expect(resumed.checkpoint.state).toBe("VERIFYING");
    expect(resumed.checkpoint.id).toBe(verifying.record.id);
    expect(resumed.checkpoint.statement).toBe("gate de evidência");

    /** Resumir de novo — idempotente, read-only: zero novo checkpoint. */
    await resumeCheckpoint(root);
    await resumeCheckpoint(root);
    expect(await countCheckpointFiles()).toBe(nBefore);
  });

  it("resume nunca importa caminho de escrita — prova estrutural", async () => {
    const src = await fs.readFile(path.resolve(__dirname, "../src/lib/capsule/checkpoint.ts"), "utf-8");
    const resumeBody = src.slice(src.indexOf("export async function resumeCheckpoint"));
    expect(resumeBody).not.toContain("publishSuperseding(");
    expect(resumeBody).not.toContain("publishCanonical(");
  });

  it("cadeia vazia: resume reporta EMPTY, não inventa checkpoint", async () => {
    const resumed = await resumeCheckpoint(root);
    expect(resumed.kind).toBe("EMPTY");
  });
});

// ─── CF3 · cadeia íntegra (wiring com integrity.ts) ────────────────────────

describe("CF3 · cadeia íntegra — a validação existe e está no caminho de escrita", () => {
  it("previous_checkpoint_id dangling: advanceCheckpoint recusa, não escreve", async () => {
    const orphanPrev = newRecordId("ProjectCheckpoint");
    const orphan = withProject(makeCheckpoint("órfão", orphanPrev, { id: newRecordId("ProjectCheckpoint") }));
    await publishCanonical(root, orphan);

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("UNHEALTHY");
    if (head.kind !== "UNHEALTHY") return;
    expect(head.detail).toContain("DANGLING_PREDECESSOR");

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("CHAIN_UNHEALTHY");
  });

  it("ciclo de checkpoint: advanceCheckpoint recusa, não escreve", async () => {
    const a = newRecordId("ProjectCheckpoint");
    const b = newRecordId("ProjectCheckpoint");
    await writeRaw(`${a}.yaml`, serializeCanonical(withProject(makeCheckpoint("A", b, { id: a }))));
    await writeRaw(`${b}.yaml`, serializeCanonical(withProject(makeCheckpoint("B", a, { id: b }))));

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("UNHEALTHY");
    if (head.kind !== "UNHEALTHY") return;
    expect(head.detail).toContain("CHECKPOINT_CYCLE");

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY", statement: "tentativa" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("CHAIN_UNHEALTHY");
  });
});

// ─── CF4 · projeto estrangeiro ──────────────────────────────────────────────

describe("CF4 · checkpoint de outro project_id não entra na cadeia deste projeto", () => {
  it("predecessor de outro projeto: chain fica UNHEALTHY, nada novo é escrito", async () => {
    const foreignProjectId = newProjectId();
    const foreign = { ...makeCheckpoint("estrangeiro", null), project_id: foreignProjectId } as CapsuleRecord;
    await writeRaw(`${foreign.id}.yaml`, serializeCanonical(foreign));

    /** Aponta pra dentro DESTE projeto, mas o predecessor pertence a outro. */
    const local = withProject(makeCheckpoint("herdeiro", foreign.id));
    await publishCanonical(root, local);

    const nBefore = await countCheckpointFiles();
    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("UNHEALTHY");

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("CHAIN_UNHEALTHY");
    expect(await countCheckpointFiles()).toBe(nBefore);
  });
});

// ─── CF5 · dispatch duplicado — CAS de store.ts ────────────────────────────

describe("CF5 · duas transições concorrentes para RUNNING — a segunda perde", () => {
  it("só um vencedor publica RUNNING; o outro é recusado", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "corrida" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });

    const [a, b] = await Promise.all([
      advanceCheckpoint({ projectRoot: root, state: "RUNNING" }),
      advanceCheckpoint({ projectRoot: root, state: "RUNNING" }),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    if (loser.ok) throw new Error("unreachable");
    expect(loser.reason).toBe("TRANSITION_REJECTED");

    /** Exatamente UM novo checkpoint RUNNING — não dois, não zero. */
    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind !== "HEAD") return;
    expect(head.state).toBe("RUNNING");
  });
});

// --- CF6 · scanIntegrity escopado por family — MESMO validador, entrada menor ---

describe("scanIntegrity({ families: [\"ProjectCheckpoint\"] }) — escopo, nunca um segundo validador", () => {
  it("devolve os MESMOS issues de checkpoint que o scan completo, sem a corrupção de outra family", async () => {
    const orphanPrev = newRecordId("ProjectCheckpoint");
    const orphan = withProject(makeCheckpoint("órfão", orphanPrev, { id: newRecordId("ProjectCheckpoint") }));
    await publishCanonical(root, orphan);

    /** Corrupção de OUTRA family — só deve aparecer no scan COMPLETO. */
    const knowledgeDir = forProject(root).familyDir("KnowledgeRecord");
    await fs.ensureDir(knowledgeDir);
    await fs.writeFile(path.join(knowledgeDir, `${newRecordId("KnowledgeRecord")}.yaml`), "not: [valid: yaml");

    const full = await scanIntegrity(root);
    const scoped = await scanIntegrity(root, { families: ["ProjectCheckpoint"] });

    const checkpointIssuesFull = full.issues.filter((i) => i.code === "DANGLING_PREDECESSOR");
    expect(checkpointIssuesFull).toHaveLength(1);
    expect(scoped.issues).toEqual(checkpointIssuesFull);
    expect(scoped.checkpointHeads).toEqual(full.checkpointHeads);

    expect(full.issues.some((i) => i.code === "INVALID_YAML")).toBe(true);
    expect(scoped.issues.some((i) => i.code === "INVALID_YAML")).toBe(false);
  });
});

// ─── CF7 · terminal -> READY nasce TAREFA NOVA (decisão do operador 2026-09-07) ───

describe("CF7 · SUCCEEDED -> READY é tarefa nova, terminal permanece imutável", () => {
  /** Cadeia completa até SUCCEEDED, com contract/plan na linhagem para provar que a tarefa nova NÃO herda. */
  async function toSucceeded(): ReturnType<typeof advanceCheckpoint> {
    await advanceCheckpoint({
      projectRoot: root,
      state: "PENDING",
      statement: "S1",
      contractId: "ctr_1",
      planNodeId: "node_1",
    });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: root, state: "VERIFYING" });
    return advanceCheckpoint({ projectRoot: root, state: "SUCCEEDED" });
  }

  it("com statement cria head novo, previous_checkpoint_id = terminal, attempt 1, sem contract/plan herdados", async () => {
    const succeeded = await toSucceeded();
    expect(succeeded.ok).toBe(true);
    if (!succeeded.ok) return;

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY", statement: "S2 - tarefa nova" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect((r.record as { previous_checkpoint_id: string | null }).previous_checkpoint_id).toBe(succeeded.record.id);
    const content = (
      r.record as {
        content: { statement: string; attempt: number; contract_id?: string; plan_node_id?: string };
      }
    ).content;
    expect(content.statement).toBe("S2 - tarefa nova");
    expect(content.attempt).toBe(1);
    expect(content.contract_id).toBeUndefined();
    expect(content.plan_node_id).toBeUndefined();
  });

  it("sem statement é recusado, nada escrito", async () => {
    const succeeded = await toSucceeded();
    expect(succeeded.ok).toBe(true);
    if (!succeeded.ok) return;

    const nBefore = await countCheckpointFiles();
    const r = await advanceCheckpoint({ projectRoot: root, state: "READY" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MISSING_STATEMENT");
    expect(await countCheckpointFiles()).toBe(nBefore);
  });

  it("o record terminal permanece byte a byte idêntico depois da tarefa nova nascer", async () => {
    const succeeded = await toSucceeded();
    expect(succeeded.ok).toBe(true);
    if (!succeeded.ok) return;

    const filePath = forProject(root).recordPath("ProjectCheckpoint", succeeded.record.id);
    const before = await fs.readFile(filePath, "utf-8");

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY", statement: "S2" });
    expect(r.ok).toBe(true);

    const after = await fs.readFile(filePath, "utf-8");
    expect(after).toBe(before);
  });

  it("SUCCEEDED -> RUNNING/VERIFYING/PENDING/BLOCKED/HUMAN_REQUIRED/FAILED continuam recusados", async () => {
    const succeeded = await toSucceeded();
    expect(succeeded.ok).toBe(true);
    if (!succeeded.ok) return;

    for (const state of ["RUNNING", "VERIFYING", "PENDING", "BLOCKED", "HUMAN_REQUIRED", "FAILED"] as const) {
      const r = await advanceCheckpoint({ projectRoot: root, state, statement: "tentativa" });
      expect(r.ok).toBe(false);
    }
  });

  it("resolveCheckpointHead depois da tarefa nova devolve o head READY — UM head, sem DIVERGED", async () => {
    const succeeded = await toSucceeded();
    expect(succeeded.ok).toBe(true);
    if (!succeeded.ok) return;

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY", statement: "S2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind !== "HEAD") return;
    expect(head.state).toBe("READY");
    expect(head.id).toBe(r.record.id);

    const scan = await scanIntegrity(root);
    expect(scan.checkpointHeads).toEqual([r.record.id]);
  });
});

describe("CF8 · FAILED -> READY: advanceCheckpoint (tarefa nova) e retryCheckpoint (mesma tarefa) coexistem", () => {
  async function toFailed(): ReturnType<typeof advanceCheckpoint> {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: root, state: "VERIFYING" });
    return advanceCheckpoint({ projectRoot: root, state: "FAILED" });
  }

  it("advanceCheckpoint(FAILED -> READY, statement) nasce attempt 1 — tarefa nova", async () => {
    const failed = await toFailed();
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;

    const r = await advanceCheckpoint({ projectRoot: root, state: "READY", statement: "S2 - tentativa nova" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = (r.record as { content: { statement: string; attempt: number } }).content;
    expect(content.statement).toBe("S2 - tentativa nova");
    expect(content.attempt).toBe(1);
  });

  it("retryCheckpoint continua attempt+1, mesmo statement — MESMA tarefa, não tarefa nova", async () => {
    const failed = await toFailed();
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;

    const r = await retryCheckpoint({ projectRoot: root, maxAttempts: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = (r.record as { content: { statement: string; attempt: number } }).content;
    expect(content.statement).toBe("S1");
    expect(content.attempt).toBe(2);
  });
});

// ─── C1 · required_capabilities — herança como plan_node_id ─────────────────

describe("C1 · required_capabilities: READY grava, RUNNING herda, tarefa nova de terminal não herda", () => {
  it("READY com --capability grava content.required_capabilities no YAML, dedupe + ordem canônica", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    const ready = await advanceCheckpoint({
      projectRoot: root,
      state: "READY",
      requiredCapabilities: ["project.structure", "library.docs", "project.structure"],
    });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const content = (ready.record as { content: { required_capabilities?: string[] } }).content;
    /** dedupe (duas ocorrências de `project.structure` viram uma) + ordem lexicográfica. */
    expect(content.required_capabilities).toEqual(["library.docs", "project.structure"]);

    const filePath = forProject(root).recordPath("ProjectCheckpoint", ready.record.id);
    const onDisk = await fs.readFile(filePath, "utf-8");
    expect(onDisk).toContain("required_capabilities:");
  });

  it("filho RUNNING herda required_capabilities sem repetir na chamada", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    await advanceCheckpoint({
      projectRoot: root,
      state: "READY",
      requiredCapabilities: ["project.structure"],
    });
    const running = await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    expect(running.ok).toBe(true);
    if (!running.ok) return;

    const content = (running.record as { content: { required_capabilities?: string[] } }).content;
    expect(content.required_capabilities).toEqual(["project.structure"]);

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind !== "HEAD") return;
    expect(head.requiredCapabilities).toEqual(["project.structure"]);
  });

  it("READY a partir de SUCCEEDED (tarefa nova) NÃO herda required_capabilities", async () => {
    await advanceCheckpoint({
      projectRoot: root,
      state: "PENDING",
      statement: "S1",
      requiredCapabilities: ["project.structure"],
    });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: root, state: "VERIFYING" });
    const succeeded = await advanceCheckpoint({ projectRoot: root, state: "SUCCEEDED" });
    expect(succeeded.ok).toBe(true);
    if (!succeeded.ok) return;

    const novaTarefa = await advanceCheckpoint({
      projectRoot: root,
      state: "READY",
      statement: "S2 - tarefa nova",
    });
    expect(novaTarefa.ok).toBe(true);
    if (!novaTarefa.ok) return;

    const content = (novaTarefa.record as { content: { required_capabilities?: string[] } }).content;
    expect(content.required_capabilities).toBeUndefined();
  });

  it("sem --capability em nenhuma transição, o campo nunca aparece", async () => {
    const r1 = await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(
      (r1.record as { content: { required_capabilities?: string[] } }).content.required_capabilities
    ).toBeUndefined();

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind !== "HEAD") return;
    expect(head.requiredCapabilities).toBeUndefined();
  });
});
