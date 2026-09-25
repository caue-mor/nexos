/**
 * knw_01M2R7JXZ5V1Y4BHRT2ARX4G3V — `nexos doctor` completo lia e validava o
 * Store do projeto (`readCurrentRecords`) e resolvia o head de checkpoint
 * (`resolveCheckpointHead`, escopo cheio via `scanIntegrity`) várias vezes na
 * MESMA execução. Este teste conta as chamadas de verdade (spy sobre o
 * módulo real, mesmo padrão de
 * `tests/session-start-shared-knowledge-read.test.ts`) e prova que, dado o
 * `preloadedRead`/`preloadedHead` que `doctor()` agora monta uma vez e
 * repassa, os dois pares de checks que antes liam de novo não leem.
 *
 *   SEM `preloadedRead`/`preloadedHead` FECHANDO SOBRE A LEITURA
 *   COMPARTILHADA, O SEGUNDO `it()` DE CADA `describe` CONTA 2, NÃO 1 — a
 *   prova de que o primeiro mede o mecanismo real, não um acidente de
 *   fixture vazia.
 *
 * `doctor()` não roda aqui — depende do host inteiro (`detectClaudeCode`,
 * `ASSETS_DIR`, `INSTALL_TARGETS`) e não aceita `rootPath` (usa
 * `process.cwd()`), mesmo limite já documentado em
 * `tests/doctor-health.test.ts`. O describe final fecha essa lacuna com o
 * MESMO idioma que aquele arquivo já usa (asserção sobre o TEXTO da função):
 * prova que `doctor()` de fato monta `storeRead`/`checkpointHead` uma vez e
 * repassa aos quatro checks, não só que as funções SUPORTAM o preload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

let readCalls = 0;
let headCalls = 0;

vi.mock("../src/lib/capsule/reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capsule/reader.js")>();
  return {
    ...actual,
    readCurrentRecords: async (...args: Parameters<typeof actual.readCurrentRecords>) => {
      readCalls++;
      return actual.readCurrentRecords(...args);
    },
  };
});

vi.mock("../src/lib/capsule/checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capsule/checkpoint.js")>();
  return {
    ...actual,
    resolveCheckpointHead: async (...args: Parameters<typeof actual.resolveCheckpointHead>) => {
      headCalls++;
      return actual.resolveCheckpointHead(...args);
    },
  };
});

const {
  medirStoreCanonico,
  medirVazamentoEntreProjetos,
  medirEvidenciaDeCheckpoint,
  medirQuemFechaNaoConstroi,
} = await import("../src/commands/doctor.js");
const { readCurrentRecords } = await import("../src/lib/capsule/reader.js");
const { resolveCheckpointHead } = await import("../src/lib/capsule/checkpoint.js");
const { initializeCapsule } = await import("../src/lib/capsule/initializer.js");

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-09-17T12:00:00.000Z";
let workspace: string;
let root: string;
let projectId: string;

beforeEach(async () => {
  readCalls = 0;
  headCalls = 0;
  workspace = await fs.mkdtemp(path.join(TMP, "doctor-dedup-"));
  root = path.join(workspace, "project");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "doctor-dedup" })).projectId;
});

afterEach(async () => {
  await fs.remove(workspace);
});

/** Mesma fixture de `tests/doctor-health.test.ts` (`knowledge()`) — duas
 * publicações do MESMO `source_ref` sem `supersedes` produzem lineage
 * DIVERGED, a anomalia que `withFailOnAnomaly` precisa reproduzir. */
function conflictingKnowledge(): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "agent",
    provenance: {
      source_ref: "nexos://doctor/conflicting-lineage",
      producer_id: "doctor-dedup-test",
      submitted_at: NOW,
    },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "policy:doctor-dedup-test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "test" },
    evidence_refs: ["test:doctor-dedup"],
    created_at: NOW,
    version: 1,
    content: { title: "conflict", failure_mode: "dois heads sem supersessão" },
  } as CapsuleRecord;
}

describe("doctor — uma leitura do Store, reusada entre checks", () => {
  it("medirStoreCanonico + medirVazamentoEntreProjetos com a mesma leitura pré-carregada: 1 chamada a readCurrentRecords, não 2", async () => {
    const storeRead = await readCurrentRecords(root);
    expect(readCalls).toBe(1);

    await medirStoreCanonico(root, storeRead);
    await medirVazamentoEntreProjetos(root, storeRead);

    expect(readCalls).toBe(1);
  });

  it("sem preloadedRead, cada check lê por conta própria — prova que o teste acima mede o mecanismo real, não um acidente", async () => {
    await medirStoreCanonico(root);
    await medirVazamentoEntreProjetos(root);

    expect(readCalls).toBe(2);
  });

  /**
   * `withFailOnAnomaly` (`lib/doctor/checks.ts`) replica LOCALMENTE o gate
   * que `readCurrentRecords(rootPath, { failOnAnomaly: true })` aplicaria —
   * este teste é a prova exigida pelo handoff: reusar a leitura
   * COMPARTILHADA (sem `failOnAnomaly`) não muda o veredito de
   * `medirStoreCanonico` num projeto com anomalia real (lineage DIVERGED,
   * mesma fixture de `tests/doctor-health.test.ts`).
   */
  it("projeto com lineage DIVERGED: o veredito de medirStoreCanonico é idêntico com e sem preloadedRead", async () => {
    await publishCanonical(root, conflictingKnowledge());
    await publishCanonical(root, conflictingKnowledge());

    const semPreload = await medirStoreCanonico(root);
    const comPreload = await medirStoreCanonico(root, await readCurrentRecords(root));

    expect(semPreload.status).toBe("fail");
    expect(semPreload.code).toBe("CANONICAL_STORE_UNREADABLE");
    expect(semPreload.message).toContain("DIVERGED");
    expect(comPreload).toEqual(semPreload);
  });
});

describe("doctor — uma resolução de checkpoint head, reusada entre checks", () => {
  it("medirEvidenciaDeCheckpoint + medirQuemFechaNaoConstroi com o mesmo head pré-carregado: 1 chamada a resolveCheckpointHead, não 2", async () => {
    const head = await resolveCheckpointHead(root);
    expect(headCalls).toBe(1);

    await medirEvidenciaDeCheckpoint(root, head);
    await medirQuemFechaNaoConstroi(root, head);

    expect(headCalls).toBe(1);
  });

  it("sem preloadedHead, cada check resolve por conta própria — prova que o teste acima mede o mecanismo real", async () => {
    await medirEvidenciaDeCheckpoint(root);
    await medirQuemFechaNaoConstroi(root);

    expect(headCalls).toBe(2);
  });
});

/**
 * `FUNCTION SUPPORTS PRELOAD != COMMAND USES PRELOAD` — os quatro `it()`
 * acima provam o mecanismo; este prova que `doctor()` de fato o aciona.
 * Mesmo idioma de `tests/doctor-health.test.ts` ("doctor() realmente empurra
 * o check"), mesmo teto documentado lá: pega remoção/desconexão do preload,
 * não pegaria os argumentos movidos para um ramo inalcançável.
 */
describe("doctor() realmente reusa storeRead/checkpointHead — não só as funções suportam", () => {
  it("doctor() monta storeRead e checkpointHead uma vez cada e repassa aos quatro checks", async () => {
    const fonte = await fs.readFile(
      path.join(process.cwd(), "src", "commands", "doctor.ts"),
      "utf-8"
    );
    expect(fonte).toMatch(/const storeRead[^\n]*=\s*await readCurrentRecords\(process\.cwd\(\)\)/);
    expect(fonte).toMatch(/medirStoreCanonico\(process\.cwd\(\),\s*storeRead\)/);
    expect(fonte).toMatch(/medirVazamentoEntreProjetos\(process\.cwd\(\),\s*storeRead\)/);
    expect(fonte).toMatch(/const checkpointHead[^\n]*=\s*await resolveCheckpointHead\(process\.cwd\(\)\)/);
    expect(fonte).toMatch(/medirEvidenciaDeCheckpoint\(process\.cwd\(\),\s*checkpointHead\)/);
    expect(fonte).toMatch(/medirQuemFechaNaoConstroi\(process\.cwd\(\),\s*checkpointHead\)/);
  });
});
