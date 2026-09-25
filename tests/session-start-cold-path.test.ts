/**
 * 03e (cold-path, decisão do dono `dec_01M2FPAZKXR96QHAR18DCKKNC7`,
 * checkpoint `chk_01M2EE9N5EEET94B5PFPHBGTDN`) — o SessionStart ganha um teto
 * de PROCESSO maior (`PROCESS_WATCHDOG_COLD_MS`) só quando o cache de
 * validação compartilhado (`capsule/integrity-cache.ts`) está frio ou
 * inválido; aberturas com cache continuam sob o teto padrão
 * (`PROCESS_WATCHDOG_MS`, 2700ms).
 *
 * Cinco provas causais, a mesma matriz da decisão:
 *   frio ⇒ teto frio · quente ⇒ 2700 · cache corrompido ⇒ frio ·
 *   poucos arquivos novos ⇒ quente · validador alterado ⇒ frio
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  runSessionStartWithWatchdog,
  detectColdCache,
  PROCESS_WATCHDOG_MS,
  PROCESS_WATCHDOG_COLD_MS,
} from "../src/host/claude/session-start.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty } from "../src/lib/capsule/integrity-cache.js";
import { loadCanonicalRecord, type IntegrityIssue } from "../src/lib/capsule/integrity.js";
import { makeGotcha, makeCheckpoint } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";
import type { RecordFamily } from "../src/lib/capsule/ids.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "session-start-cold-path-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

/** Escreve um `KnowledgeRecord` real em disco e devolve o caminho do arquivo. */
async function writeKnowledgeRecord(root: string, projectId: string, title: string): Promise<string> {
  const dir = forProject(root).familyDir("KnowledgeRecord");
  await fs.ensureDir(dir);
  const id = newRecordId("KnowledgeRecord");
  const record = { ...makeGotcha({ content: { ...makeGotcha().content, title } }), id, project_id: projectId } as CapsuleRecord;
  const filePath = path.join(dir, `${id}.yaml`);
  await fs.writeFile(filePath, serializeCanonical(record));
  return filePath;
}

/** Popula o cache compartilhado com N dos M arquivos escritos, salva e recarrega. */
async function populateCache(
  root: string,
  projectId: string,
  files: readonly string[],
  family: RecordFamily = "KnowledgeRecord"
): Promise<void> {
  const cache = await loadIntegrityCache(root);
  const issues: IntegrityIssue[] = [];
  for (const filePath of files) {
    await loadCanonicalRecord(filePath, path.basename(filePath), family, projectId, new Map(), issues, cache);
  }
  expect(issues).toEqual([]);
  await saveIntegrityCacheIfDirty(cache);
}

/** Escreve um `ProjectCheckpoint` real em disco (family que o boot NÃO lê) e devolve o caminho. */
async function writeCheckpointRecord(root: string, projectId: string, statement: string): Promise<string> {
  const dir = forProject(root).familyDir("ProjectCheckpoint");
  await fs.ensureDir(dir);
  const record = { ...makeCheckpoint(statement, null), project_id: projectId } as CapsuleRecord;
  const filePath = path.join(dir, `${record.id}.yaml`);
  await fs.writeFile(filePath, serializeCanonical(record));
  return filePath;
}

const payload = (projectDir: string) => ({
  session_id: "s1",
  hook_event_name: "SessionStart",
  source: "startup",
  cwd: projectDir,
});

describe("detectColdCache — unidade, os 5 casos causais da decisão", () => {
  it("cache corrompido (JSON ilegível) ⇒ frio", async () => {
    const root = path.join(ws, "corrupted");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "corrupted" });
    await writeKnowledgeRecord(root, projectId, "arquivo único");

    const cacheFile = path.join(forProject(root).derived(), "integrity-cache.json");
    await fs.ensureDir(path.dirname(cacheFile));
    await fs.writeFile(cacheFile, "{ isto não é JSON válido", "utf-8");

    const cache = await loadIntegrityCache(root);
    expect(cache.coldness.kind).toBe("absent");
    expect(await detectColdCache(cache, root)).toBe(true);
  });

  it("validador alterado (versão em disco divergente) ⇒ frio", async () => {
    const root = path.join(ws, "version-mismatch");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "version-mismatch" });
    await writeKnowledgeRecord(root, projectId, "arquivo único");

    const cacheFile = path.join(forProject(root).derived(), "integrity-cache.json");
    await fs.ensureDir(path.dirname(cacheFile));
    await fs.writeFile(
      cacheFile,
      `${JSON.stringify({ version: "1:fingerprint-de-um-validador-que-nunca-existiu", entries: {} })}\n`,
      "utf-8"
    );

    const cache = await loadIntegrityCache(root);
    expect(cache.coldness.kind).toBe("version_mismatch");
    expect(await detectColdCache(cache, root)).toBe(true);
  });

  it("cache virgem (nunca escrito) ⇒ frio", async () => {
    const root = path.join(ws, "virgin");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "virgin" });

    const cache = await loadIntegrityCache(root);
    expect(cache.coldness.kind).toBe("absent");
    expect(await detectColdCache(cache, root)).toBe(true);
  });

  it("poucos arquivos novos (1 de 10 sem entrada, 10% < limiar de 50%) ⇒ quente", async () => {
    const root = path.join(ws, "sparse-warm");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "sparse-warm" });

    const files: string[] = [];
    for (let i = 0; i < 10; i++) files.push(await writeKnowledgeRecord(root, projectId, `arquivo ${i}`));
    await populateCache(root, projectId, files.slice(0, 9)); // 9/10 cobertos — 1 novo, "poucos"

    const cache = await loadIntegrityCache(root);
    expect(cache.coldness.kind).toBe("populated");
    expect(cache.entries.size).toBe(9);
    expect(await detectColdCache(cache, root)).toBe(false);
  });

  it("muitos arquivos novos (2 de 10 cobertos, 80% > limiar de 50%) ⇒ frio — contraste do caso 'poucos'", async () => {
    const root = path.join(ws, "sparse-cold");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "sparse-cold" });

    const files: string[] = [];
    for (let i = 0; i < 10; i++) files.push(await writeKnowledgeRecord(root, projectId, `arquivo ${i}`));
    await populateCache(root, projectId, files.slice(0, 2)); // só 2/10 cobertos

    const cache = await loadIntegrityCache(root);
    expect(await detectColdCache(cache, root)).toBe(true);
  });

  it("95% knowledge coberto (19/20) ⇒ quente", async () => {
    const root = path.join(ws, "high-coverage-warm");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "high-coverage-warm" });

    const files: string[] = [];
    for (let i = 0; i < 20; i++) files.push(await writeKnowledgeRecord(root, projectId, `arquivo ${i}`));
    await populateCache(root, projectId, files.slice(0, 19)); // 19/20 — 5% descoberto

    const cache = await loadIntegrityCache(root);
    expect(await detectColdCache(cache, root)).toBe(false);
  });

  it("40% knowledge coberto + 100% checkpoint coberto ⇒ frio — outra family não mascara a esparsidade real", async () => {
    const root = path.join(ws, "cross-family-pollution");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "cross-family-pollution" });

    // KnowledgeRecord: só 4/10 no cache — 60% descoberto, acima do limiar sozinho.
    const knowledgeFiles: string[] = [];
    for (let i = 0; i < 10; i++) knowledgeFiles.push(await writeKnowledgeRecord(root, projectId, `arquivo ${i}`));
    await populateCache(root, projectId, knowledgeFiles.slice(0, 4));

    // ProjectCheckpoint: 5/5 no cache — 100% coberto, mas é family que o boot NÃO lê.
    // Antes da correção, `cache.entries.size` somava as duas families (4 + 5 = 9
    // contra 10 arquivos de boot) e mascarava a esparsidade real do knowledge.
    const checkpointFiles: string[] = [];
    for (let i = 0; i < 5; i++) checkpointFiles.push(await writeCheckpointRecord(root, projectId, `checkpoint ${i}`));
    await populateCache(root, projectId, checkpointFiles, "ProjectCheckpoint");

    const cache = await loadIntegrityCache(root);
    expect(cache.entries.size).toBe(9); // 4 knowledge + 5 checkpoint somados — a armadilha do bug antigo
    expect(await detectColdCache(cache, root)).toBe(true);
  });

  it("cache legado sem o campo family em toda entrada ⇒ frio — entrada sem family não conta cobertura de nenhuma", async () => {
    const root = path.join(ws, "legacy-no-family-field");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "legacy-no-family-field" });

    const files: string[] = [];
    for (let i = 0; i < 10; i++) files.push(await writeKnowledgeRecord(root, projectId, `arquivo ${i}`));
    await populateCache(root, projectId, files); // 10/10 — cobertura completa, seria QUENTE em condições normais

    // Simula um cache gravado por código anterior ao campo `family` por entrada
    // (ou corrompido à mão): remove `family` de todo `record` mantendo a `version`
    // válida, para provar que `recordFamilyOf` devolve `undefined` e a entrada
    // deixa de contar cobertura para QUALQUER family.
    const cacheFile = path.join(forProject(root).derived(), "integrity-cache.json");
    const onDisk = JSON.parse(await fs.readFile(cacheFile, "utf-8")) as { version: string; entries: Record<string, Record<string, unknown>> };
    for (const record of Object.values(onDisk.entries)) delete record.family;
    await fs.writeFile(cacheFile, `${JSON.stringify(onDisk)}\n`, "utf-8");

    const cache = await loadIntegrityCache(root);
    expect(cache.coldness.kind).toBe("populated");
    expect(cache.entries.size).toBe(10); // o cache ainda "existe" — só não sabe mais de qual family
    expect(await detectColdCache(cache, root)).toBe(true);
  });
});

describe("runSessionStartWithWatchdog — o teto de PROCESSO escolhido de fato governa o orçamento", () => {
  /**
   * MESMO `nowMs` injetado (2900ms "decorridos") nos dois testes abaixo —
   * acima do teto QUENTE (2700ms), abaixo do teto FRIO (8000ms). O único
   * eixo que varia é o estado do cache; o resultado (`degraded`) prova qual
   * teto o watchdog de fato armou.
   */
  const ELAPSED_BETWEEN_CEILINGS = 2_900;

  it("quente (cache populado, cobertura completa) ⇒ teto continua 2700ms — orçamento zerado, degrada", async () => {
    const root = path.join(ws, "warm-watchdog");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "warm-watchdog" });
    const filePath = await writeKnowledgeRecord(root, projectId, "único arquivo");
    await populateCache(root, projectId, [filePath]);

    expect(ELAPSED_BETWEEN_CEILINGS).toBeGreaterThan(PROCESS_WATCHDOG_MS);

    const result = await runSessionStartWithWatchdog(
      payload(root),
      { CLAUDE_PROJECT_DIR: root },
      undefined,
      () => ELAPSED_BETWEEN_CEILINGS
    );

    expect(result.degraded).toBe(true);
  });

  it("frio (cache ausente) ⇒ teto sobe para 8000ms — mesmo orçamento decorrido, brief real entregue", async () => {
    const root = path.join(ws, "cold-watchdog");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "cold-watchdog" });

    expect(ELAPSED_BETWEEN_CEILINGS).toBeLessThan(PROCESS_WATCHDOG_COLD_MS);

    const result = await runSessionStartWithWatchdog(
      payload(root),
      { CLAUDE_PROJECT_DIR: root },
      undefined,
      () => ELAPSED_BETWEEN_CEILINGS
    );

    expect(result.degraded).toBe(false);
    expect(result.hookOutput.hookSpecificOutput.additionalContext).toContain("NexOS");
  });
});
