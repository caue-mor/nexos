/**
 * 03c (host event observation, continuação) — `ONE FAMILY READ PER
 * SESSIONSTART · NOT ONE PER CONSUMER`.
 *
 * Antes desta fatia: `assembleKnowledge` (conhecimento),
 * `currentProjectStateHead` (head de `project_state`) e
 * `primePresentationCache` (prime de apresentação) liam `KnowledgeRecord`
 * de forma INDEPENDENTE — três chamadas a `readCurrentRecords` para a MESMA
 * family, na MESMA sessão. Este teste conta as chamadas de verdade (spy
 * sobre o módulo real, não sobre uma suposição) e prova que caiu para UMA.
 *
 *   SEM `preloadedRead` (context-assembler.ts) E `preloadedRecords`
 *   (state-presentation.ts) FECHANDO SOBRE A LEITURA COMPARTILHADA
 *   (session-start.ts), ESTE TESTE CONTA 3, NÃO 1 — a prova de que a
 *   consolidação é real, não decorativa.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

interface RecordedCall {
  readonly families?: readonly string[];
}

const recordedCalls: RecordedCall[] = [];

vi.mock("../src/lib/capsule/reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capsule/reader.js")>();
  return {
    ...actual,
    readCurrentRecords: async (rootPath: string, options: Parameters<typeof actual.readCurrentRecords>[1]) => {
      recordedCalls.push({ families: options?.families });
      return actual.readCurrentRecords(rootPath, options);
    },
  };
});

const { runSessionStartAdapter } = await import("../src/host/claude/session-start.js");
const { initializeCapsule } = await import("../src/lib/capsule/initializer.js");
const { publishCanonical } = await import("../src/lib/capsule/store.js");
const { makeGotcha } = await import("./capsule-fixtures.js");

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;

beforeEach(async () => {
  recordedCalls.length = 0;
  ws = await fs.mkdtemp(path.join(TMP_BASE, "shared-knowledge-read-"));
  root = path.join(ws, "project");
  await fs.ensureDir(root);
});
afterEach(async () => {
  await fs.remove(ws);
});

/**
 * Casa a leitura COMPARTILHADA (`families: ["KnowledgeRecord"]`, session-
 * start.ts) E qualquer leitura de FALLBACK que `assembleContext` faria por
 * conta própria caso o preload não tivesse chegado (`families:
 * BOOT_KNOWLEDGE_FAMILIES = ["KnowledgeRecord","Decision","Research"]`,
 * bootstrap-context.ts) — as duas formas contam como "leu KnowledgeRecord".
 * Um filtro que exigisse family ÚNICA passaria por acidente com a
 * consolidação desfeita, porque a chamada de fallback pede TRÊS families.
 */
const isKnowledgeRead = (c: RecordedCall) => (c.families ?? []).includes("KnowledgeRecord");

describe("readCurrentRecords(families: [KnowledgeRecord]) — uma leitura por SessionStart", () => {
  it("Store com project_state + gotchas -> exatamente 1 leitura de KnowledgeRecord no SessionStart inteiro", async () => {
    const init = await initializeCapsule(root, { projectName: "shared-read" });
    for (let i = 0; i < 10; i++) {
      await publishCanonical(
        root,
        makeGotcha({
          project_id: init.projectId,
          provenance: { source_ref: `conversa:${i}`, producer_id: "human:steve", submitted_at: "2026-08-12T12:00:00.000Z" },
        })
      );
    }

    const r = await runSessionStartAdapter(
      { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: "shared-1" },
      { CLAUDE_PROJECT_DIR: root }
    );

    void r;
    const knowledgeReads = recordedCalls.filter(isKnowledgeRead);
    expect(knowledgeReads).toHaveLength(1);
  });

  it("Store sem Capsule canônica -> zero leituras de KnowledgeRecord (nada a ler)", async () => {
    await fs.writeJson(path.join(root, "package.json"), { name: "sem-capsule" });

    await runSessionStartAdapter(
      { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: "shared-2" },
      { CLAUDE_PROJECT_DIR: root }
    );

    expect(recordedCalls.filter(isKnowledgeRead)).toHaveLength(0);
  });
});
