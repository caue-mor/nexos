/**
 * 03e (iteração 4, orquestrador — "teto que não libera a thread é teto de
 * papel") — prova causal do cancelamento cooperativo: `loadFamilyForResolution`
 * checa `deadlineAtMs` (`Date.now()` absoluto) entre arquivos e PARA sozinho,
 * sem depender de um `setTimeout` externo (`withDeadline`, medido sob
 * contenção real como impreciso — o timer do racer atrasa, a promise
 * perdedora nunca aprende que perdeu).
 *
 *   PARTIAL != LOADED · PARTIAL nunca vira RESOLVED
 *
 * `resolveHeadsBySource`/`readFamiliesFrom` tratam PARTIAL como UNREADABLE —
 * dado incompleto nunca vira head resolvido com confiança, porque o record
 * que supersede um dos já carregados pode estar entre os arquivos NÃO lidos.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { loadFamilyForResolution, resolveHeadsBySource } from "../src/lib/capsule/head-resolver.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "coop-cancel-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

async function writeRecords(count: number): Promise<void> {
  const dir = forProject(root).familyDir("KnowledgeRecord");
  await fs.ensureDir(dir);
  for (let i = 0; i < count; i++) {
    const id = newRecordId("KnowledgeRecord");
    const record = { ...makeGotcha(), id, project_id: projectId, provenance: { source_ref: `conversa:synthetic-${i}`, producer_id: "human:steve", submitted_at: "2026-08-12T12:00:00.000Z" } } as CapsuleRecord;
    await fs.writeFile(path.join(dir, `${id}.yaml`), serializeCanonical(record));
  }
}

describe("cancelamento cooperativo — loadFamilyForResolution para sozinho ao estourar deadlineAtMs", () => {
  it("deadline já vencido antes do primeiro arquivo -> PARTIAL com zero records, nunca varre nada", async () => {
    await writeRecords(200);
    const result = await loadFamilyForResolution(root, "KnowledgeRecord", undefined, undefined, Date.now() - 1);
    expect(result.state).toBe("PARTIAL");
    if (result.state === "PARTIAL") expect(result.records.length).toBe(0);
  });

  it("deadline no meio do scan -> PARTIAL com ALGUNS records, não todos", async () => {
    await writeRecords(300);
    // Sem deadline: mede quanto tempo o scan completo leva, para calibrar um
    // corte no MEIO (não no início nem no fim) de forma determinística.
    const t0 = Date.now();
    const full = await loadFamilyForResolution(root, "KnowledgeRecord");
    const fullMs = Math.max(1, Date.now() - t0);
    expect(full.state).toBe("LOADED");
    const totalRecords = full.state === "LOADED" ? full.records.length : 0;
    expect(totalRecords).toBe(300);

    const t1 = Date.now();
    const partial = await loadFamilyForResolution(
      root,
      "KnowledgeRecord",
      undefined,
      undefined,
      t1 + Math.max(1, Math.floor(fullMs / 2))
    );
    expect(partial.state).toBe("PARTIAL");
    if (partial.state === "PARTIAL") {
      expect(partial.records.length).toBeGreaterThan(0);
      expect(partial.records.length).toBeLessThan(totalRecords);
    }
  });

  it("sem deadline (undefined) -> comportamento de sempre, varre tudo (opt-in preservado)", async () => {
    await writeRecords(50);
    const result = await loadFamilyForResolution(root, "KnowledgeRecord");
    expect(result.state).toBe("LOADED");
    if (result.state === "LOADED") expect(result.records.length).toBe(50);
  });

  it("resolveHeadsBySource trata PARTIAL como UNREADABLE — nunca resolve head sobre dado incompleto", async () => {
    await writeRecords(200);
    const report = await resolveHeadsBySource(root, "KnowledgeRecord", undefined, Date.now() - 1);
    expect(report.state).toBe("UNREADABLE");
    if (report.state === "UNREADABLE") {
      expect(report.issues[0]?.code).toBe("SCAN_DEADLINE_COOPERATIVE_CUTOFF");
    }
  });

  it("readCurrentRecords com deadlineAtMs vencido -> ok:false, nunca dados parciais silenciosos", async () => {
    await writeRecords(200);
    const result = await readCurrentRecords(root, {
      families: ["KnowledgeRecord"],
      deadlineAtMs: Date.now() - 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "SCAN_DEADLINE_COOPERATIVE_CUTOFF")).toBe(true);
    }
  });

  it("readCurrentRecords com deadlineAtMs folgado -> ok:true, comportamento normal", async () => {
    await writeRecords(20);
    const result = await readCurrentRecords(root, {
      families: ["KnowledgeRecord"],
      deadlineAtMs: Date.now() + 30_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records.length).toBe(20);
  });
});
