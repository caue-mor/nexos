/**
 * 03e (iteração 4, orquestrador — "CACHE NÃO É AUTORIDADE") — prova causal
 * de `validatorFingerprint` (`capsule/integrity-cache.ts`,
 * `lib/evidence-cache.ts`): a chave de versão de cada cache deriva do
 * CONTEÚDO dos módulos validadores (`schemas.ts`+`codec.ts` para
 * integridade; `evidence.ts` para Evidence), não de um inteiro manual que
 * alguém precisa lembrar de bumpar.
 *
 *   FORGETTING TO BUMP != FILE DID NOT CHANGE
 *
 * Não edita `schemas.ts`/`codec.ts`/`evidence.ts` de verdade (mudaria o
 * comportamento da suíte inteira) — simula "o validador mudou" escrevendo
 * no disco um cache com uma tag de versão DIFERENTE da atual, e prova que
 * `loadIntegrityCache`/`loadEvidenceCache` tratam isso como MISS TOTAL
 * (cache vazio, nunca um HIT calculado sob regras potencialmente velhas).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty } from "../src/lib/capsule/integrity-cache.js";
import { loadCanonicalRecord, type IntegrityIssue } from "../src/lib/capsule/integrity.js";
import { loadEvidenceCache } from "../src/lib/evidence-cache.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "cache-version-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("integrity-cache — versão deriva do CONTEÚDO do validador, miss total no descompasso", () => {
  it("round-trip normal (mesmo processo, mesmo fingerprint) — HIT preserva entradas", async () => {
    const dir = forProject(root).familyDir("KnowledgeRecord");
    await fs.ensureDir(dir);
    const id = newRecordId("KnowledgeRecord");
    const record = { ...makeGotcha(), id, project_id: projectId } as CapsuleRecord;
    const filePath = path.join(dir, `${id}.yaml`);
    await fs.writeFile(filePath, serializeCanonical(record));

    const cache = await loadIntegrityCache(root);
    const issues: IntegrityIssue[] = [];
    await loadCanonicalRecord(filePath, `${id}.yaml`, "KnowledgeRecord", projectId, new Map(), issues, cache);
    expect(cache.dirty).toBe(true);
    await saveIntegrityCacheIfDirty(cache);

    const reloaded = await loadIntegrityCache(root);
    expect(reloaded.entries.size).toBe(1);
  });

  it("versão em disco DIVERGENTE da atual (simula validador mudado sem bump) — miss total, cache vazio", async () => {
    const cacheFile = path.join(forProject(root).derived(), "integrity-cache.json");
    await fs.ensureDir(path.dirname(cacheFile));
    await fs.writeFile(
      cacheFile,
      `${JSON.stringify({
        version: "1:fingerprint-de-um-validador-que-nunca-existiu",
        entries: { deadbeef: { fake: "record — nunca deveria ser lido como válido" } },
      })}\n`,
      "utf-8"
    );

    const reloaded = await loadIntegrityCache(root);
    expect(reloaded.entries.size).toBe(0); // MISS TOTAL — nunca reaproveita a entrada sob versão divergente
  });

  it("cache SEM campo version (formato pré-fingerprint) — miss total, nunca lança", async () => {
    const cacheFile = path.join(forProject(root).derived(), "integrity-cache.json");
    await fs.ensureDir(path.dirname(cacheFile));
    await fs.writeFile(cacheFile, `${JSON.stringify({ version: 1, entries: {} })}\n`, "utf-8");

    const reloaded = await loadIntegrityCache(root);
    expect(reloaded.entries.size).toBe(0);
  });
});

describe("evidence-cache — MESMO mecanismo, validador é evidence.ts (evidenceRecordSchema)", () => {
  it("versão em disco DIVERGENTE da atual (simula validador mudado sem bump) — miss total, cache vazio", async () => {
    const cacheFile = path.join(forProject(root).derived(), "evidence-cache.json");
    await fs.ensureDir(path.dirname(cacheFile));
    await fs.writeFile(
      cacheFile,
      `${JSON.stringify({
        version: "1:fingerprint-de-um-validador-que-nunca-existiu",
        entries: { deadbeef: { fake: "record — nunca deveria ser lido como válido" } },
      })}\n`,
      "utf-8"
    );

    const reloaded = await loadEvidenceCache(root);
    expect(reloaded.entries.size).toBe(0);
  });
});
