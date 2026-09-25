/**
 * 03e (autocura, orquestrador: "teste causal forçando o watchdog no frio") —
 * prova o achado que motivou o flush periódico em `head-resolver.ts`
 * (`loadFamilyForResolution`): `claudeSessionStart` chama `process.exit()`
 * logo após escrever stdout, então um `saveIntegrityCacheIfDirty` que só
 * roda no FIM de round 1 + round 2 nunca é alcançado quando o watchdog do
 * PROCESSO dispara com round 1 (o caso dominante de degradação a frio) ainda
 * em voo — todo o parse já feito naquele scan morria com o processo, sem
 * nunca tocar o disco.
 *
 *   PERIODIC FLUSH DURING THE SCAN != FLUSH ONLY AT THE END
 *
 * Este teste não simula `process.exit()` de verdade (mataria o test runner
 * junto) — em vez disso, prova a metade CAUSAL que está sob controle deste
 * módulo: o arquivo de cache em disco ganha entradas ANTES do scan terminar,
 * não só depois. Combinado com "`withDeadline` nunca cancela o loser"
 * (documentado em `session-start.ts`), isso é suficiente para provar que uma
 * morte de processo no meio do scan preserva o que já foi flushado — a
 * MESMA garantia que os testes de `session-start-watchdog.test.ts` já provam
 * para o watchdog do processo em si, agora estendida à persistência do cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { loadFamilyForResolution } from "../src/lib/capsule/head-resolver.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty } from "../src/lib/capsule/integrity-cache.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "autocura-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

/** Nenhuma janela de flush "quase" — o teto de tentativas é bem maior que o esperado. */
async function pollUntilCacheHasEntries(cacheFile: string, isDone: () => boolean, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await fs.pathExists(cacheFile)) {
      const onDisk = (await fs.readJson(cacheFile)) as { entries?: Record<string, unknown> };
      if (Object.keys(onDisk.entries ?? {}).length > 0) return true;
    }
    if (isDone()) return false; // scan terminou sem nunca termos visto um flush intermediário
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

describe("flush periódico do cache durante loadFamilyForResolution — autocura de verdade", () => {
  it("cache em disco ganha entradas ANTES do scan terminar, não só no final", async () => {
    const dir = forProject(root).familyDir("KnowledgeRecord");
    await fs.ensureDir(dir);
    /** 150 records reais — o bastante para o scan, com validação de schema +
     *  round-trip de forma canônica por arquivo, ultrapassar folgadamente um
     *  intervalo de flush de 20ms (injetado — ver `flushIntervalMs`). */
    const RECORD_COUNT = 150;
    const ids: string[] = [];
    for (let i = 0; i < RECORD_COUNT; i++) {
      const id = newRecordId("KnowledgeRecord");
      const record = { ...makeGotcha(), id, project_id: projectId } as CapsuleRecord;
      await fs.writeFile(path.join(dir, `${id}.yaml`), serializeCanonical(record));
      ids.push(id);
    }

    const cache = await loadIntegrityCache(root);
    const cacheFile = path.join(forProject(root).derived(), "integrity-cache.json");
    expect(await fs.pathExists(cacheFile)).toBe(false); // nada em disco antes do scan

    let scanDone = false;
    const FLUSH_INTERVAL_MS = 20;
    const scanPromise = loadFamilyForResolution(root, "KnowledgeRecord", cache, FLUSH_INTERVAL_MS).then((result) => {
      scanDone = true;
      return result;
    });

    const observedMidScanFlush = await pollUntilCacheHasEntries(cacheFile, () => scanDone, 5_000);
    const result = await scanPromise;

    expect(result.state).toBe("LOADED");
    if (result.state === "LOADED") expect(result.records.length).toBe(RECORD_COUNT);
    expect(observedMidScanFlush).toBe(true);

    /** O flush final (fora do escopo desta função — `session-start.ts` faz
     *  o save de fechamento) não é necessário aqui: mesmo sem ele, o cache
     *  já tem TODAS as entradas, porque o último flush periódico da janela
     *  final cobre o resto. */
    const onDiskFinal = (await fs.readJson(cacheFile)) as { entries?: Record<string, unknown> };
    expect(Object.keys(onDiskFinal.entries ?? {}).length).toBeGreaterThan(0);
  });

  it("sem cache (undefined) — nenhum arquivo é criado, mesmo com muitos records (comportamento de sempre, opt-in preservado)", async () => {
    const dir = forProject(root).familyDir("KnowledgeRecord");
    await fs.ensureDir(dir);
    for (let i = 0; i < 30; i++) {
      const id = newRecordId("KnowledgeRecord");
      const record = { ...makeGotcha(), id, project_id: projectId } as CapsuleRecord;
      await fs.writeFile(path.join(dir, `${id}.yaml`), serializeCanonical(record));
    }

    const result = await loadFamilyForResolution(root, "KnowledgeRecord");
    expect(result.state).toBe("LOADED");
    expect(await fs.pathExists(path.join(forProject(root).derived(), "integrity-cache.json"))).toBe(false);
  });
});

/**
 * D2 — `saveIntegrityCacheIfDirty` escrevia `<target>.<pid>-<random>.tmp`
 * (temp+rename) e, no `catch` que engole falha de gravação (cache é
 * otimização, nunca pode custar a varredura que já rodou), NUNCA apagava o
 * `.tmp` já criado — `temporary` era `const` DENTRO do `try`, inacessível no
 * `catch` (escopo de bloco), então o catch nem tinha como saber o nome do
 * arquivo a apagar. MEDIDO: 3 `.tmp` órfãos, 7,9 MB, achados soltos em
 * `.nexos/.local/derived/`.
 */
describe("saveIntegrityCacheIfDirty — órfão de .tmp quando o rename falha", () => {
  it("falha injetada em fs.rename (depois do write) não deixa .tmp para trás", async () => {
    const derivedDir = forProject(root).derived();
    await fs.ensureDir(derivedDir);

    const original = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      const [src] = args;
      if (typeof src === "string" && src.includes("integrity-cache.json.")) {
        throw new Error("falha forçada — disco cheio (simulado)");
      }
      return original(...args);
    });

    const id = newRecordId("KnowledgeRecord");
    const record = { ...makeGotcha(), id, project_id: projectId } as CapsuleRecord;
    const cache = {
      entries: new Map([[id, { record }]]),
      dirty: true,
      coldness: { kind: "absent" as const },
      rootPath: root,
    };

    // NUNCA lança — falha ao persistir custa uma corrida futura mais lenta, nunca o resultado atual.
    await expect(saveIntegrityCacheIfDirty(cache)).resolves.toBeUndefined();
    renameSpy.mockRestore();

    const arquivos = await fs.readdir(derivedDir);
    const orfaos = arquivos.filter((f) => f.endsWith(".tmp"));
    expect(orfaos, `.tmp órfão(s) deixado(s) para trás: ${orfaos.join(", ")}`).toEqual([]);
    // O rename falhou de propósito — o cache final não existe (nunca escreveu com sucesso).
    expect(await fs.pathExists(path.join(derivedDir, "integrity-cache.json"))).toBe(false);
  });

  it("contrafactual: sem falha injetada, o cache grava normalmente e nenhum .tmp sobra", async () => {
    const derivedDir = forProject(root).derived();
    await fs.ensureDir(derivedDir);

    const id = newRecordId("KnowledgeRecord");
    const record = { ...makeGotcha(), id, project_id: projectId } as CapsuleRecord;
    const cache = {
      entries: new Map([[id, { record }]]),
      dirty: true,
      coldness: { kind: "absent" as const },
      rootPath: root,
    };

    await saveIntegrityCacheIfDirty(cache);

    const arquivos = await fs.readdir(derivedDir);
    expect(arquivos.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await fs.pathExists(path.join(derivedDir, "integrity-cache.json"))).toBe(true);
  });
});
