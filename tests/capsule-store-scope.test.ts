/**
 * T3 (plano de memória em camadas v3.2) — Store resolve o path por scope.
 * `scope.kind === "global"` cai em `GLOBAL_ROOT` sem eleição de authority;
 * `scope.kind !== "global"` segue exatamente o caminho de antes de T3
 * (regressão zero). Doc: `nexos_aios_sdk_v1/docs/13_MEMORY_SCOPE_LAYERED_DECISION.md`,
 * seção T3 e §3.1/§3.2. Decision record `dec_01M1ZYE3FBD5366JT9A7APTMQV` é a
 * autoridade.
 *
 * Ordem dos testes é DELIBERADA: "manifest ausente" precisa rodar antes de
 * qualquer teste que inicialize o root global, e "record global" precisa
 * rodar antes do teste de projeto que popula `NEXOS_HOME/projects/` — os
 * dois compartilham o MESMO `GLOBAL_ROOT`/`NEXOS_HOME` isolados (uma vez por
 * arquivo, não por teste; ver `tests/isolate-nexos-home.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { subjectRef } from "../src/lib/capsule/schemas.js";
import { GLOBAL_ROOT, NEXOS_HOME } from "../src/lib/constants.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c22c-scope-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

/** Mesma fixture de sempre, sem `project_id` — o caso `scope.kind === "global"`. */
function globalRecord(overrides: Record<string, unknown> = {}): CapsuleRecord {
  const { project_id: _projectId, content: baseContent, ...semProjeto } = makeGotcha() as unknown as Record<
    string,
    unknown
  >;
  return {
    ...semProjeto,
    scope: { kind: "global", ref: null },
    subject: "gerenciador de pacotes",
    subject_ref: subjectRef("gerenciador de pacotes"),
    /**
     * T7a/T7b (§6.4, §9 I31) — todo `KnowledgeRecord` global exige
     * `content.generality` e `content.verification_status="unverified"`.
     * Este arquivo testa resolução de root por scope (T3), não promoção; o
     * default aqui só mantém a fixture válida contra o invariante novo.
     */
    content: {
      generality: "vale para qualquer projeto — fixture de teste",
      verification_status: "unverified",
      ...(baseContent as Record<string, unknown>),
    },
    ...overrides,
  } as CapsuleRecord;
}

describe("I1 · NEXOS_HOME === join(GLOBAL_ROOT, \".nexos\")", () => {
  it("a relação é a fórmula declarada, não dois os.homedir() independentes", () => {
    expect(NEXOS_HOME).toBe(path.join(GLOBAL_ROOT, ".nexos"));
  });
});

describe("T3 · manifest global ausente", () => {
  it("falha ao publicar e a mensagem nomeia o bootstrap do root global (T4)", async () => {
    // Garante ausência independente da ordem de outros arquivos de teste —
    // GLOBAL_ROOT é isolado por ARQUIVO, não por `it()`.
    await fs.remove(forProject(GLOBAL_ROOT).capsuleDir());

    await expect(
      publishCanonical(path.join(ws, "irrelevante"), globalRecord())
    ).rejects.toThrow(/root global.*T4|T4.*root global/i);
  });
});

describe("T3 · record global publica em GLOBAL_ROOT sem authority", () => {
  it("aterrissa em forProject(GLOBAL_ROOT) e não elege authority", async () => {
    await initializeCapsule(GLOBAL_ROOT, { projectName: "global" });

    const authorityProjectsDir = path.join(NEXOS_HOME, "projects");
    expect(await fs.pathExists(authorityProjectsDir)).toBe(false);

    const record = globalRecord();
    const res = await publishCanonical(path.join(ws, "irrelevante"), record);

    expect(res.outcome).toBe("CREATED");
    expect(res.authority).toEqual({ activeRoot: GLOBAL_ROOT, outcome: "CONFIRMED" });
    expect(res.canonicalPath).toBe(
      forProject(GLOBAL_ROOT).recordPath("KnowledgeRecord", record.id)
    );
    expect(await fs.pathExists(authorityProjectsDir)).toBe(false);
  });
});

describe("T3 · record project — regressão zero", () => {
  it("mesmo path e mesma authority de antes de T3", async () => {
    const root = path.join(ws, "proj");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "proj" });

    const record = makeGotcha({ project_id: init.projectId });
    const res = await publishCanonical(root, record);

    expect(res.outcome).toBe("CREATED");
    expect(res.authority?.outcome).toBe("CLAIMED");
    expect(res.authority?.activeRoot).toBe(root);
    expect(res.canonicalPath).toBe(forProject(root).recordPath("KnowledgeRecord", record.id));
  });
});
