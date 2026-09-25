/**
 * MEM-SEARCH — a superfície de recuperação por ASSUNTO.
 *
 *   RETRIEVAL ENGINE EXISTS != RETRIEVAL IS REACHABLE
 *   PROJECT FACT != GLOBAL FACT
 *
 * Os quatro contrafactuais que fazem a busca significar alguma coisa. Sem o
 * negativo, "acha tudo" passaria por correto; sem o de isolamento, memória de um
 * projeto vazaria no outro e ninguém veria.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { memory } from "../src/commands/memory.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-28T12:00:00.000Z";

let ws: string;
let rootA: string;
let rootB: string;
let idA: string;
let idB: string;

function captureStdout(): { text: () => string; restore: () => void } {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  return { text: () => out, restore: () => spy.mockRestore() };
}

function rec(
  projectId: string,
  sourceRef: string,
  kind: string,
  content: Record<string, string>
): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind,
    scope: "project",
    origin: "migration",
    provenance: { source_ref: sourceRef, producer_id: "produtor-de-teste", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
    content,
  } as CapsuleRecord;
}

/** Roda a busca e devolve o que o comando IMPRIMIU — a superfície real. */
async function buscar(cwd: string, search: string): Promise<string> {
  const cap = captureStdout();
  try {
    await memory({ cwd, search });
    return cap.text();
  } finally {
    cap.restore();
  }
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "mem-search-"));
  rootA = path.join(ws, "projeto-a");
  rootB = path.join(ws, "projeto-b");
  await fs.ensureDir(rootA);
  await fs.ensureDir(rootB);
  idA = (await initializeCapsule(rootA, { projectName: "projeto-a" })).projectId;
  idB = (await initializeCapsule(rootB, { projectName: "projeto-b" })).projectId;

  await publishCanonical(
    rootA,
    rec(idA, "nexos://gotcha/awk-nul", "gotcha", {
      title: "awk do macOS trunca em byte NUL silenciosamente",
      failure_mode: "o texto apos o NUL some do output com exit 0 e stderr vazio",
      rule: "nunca confiar em exit 0 de filtro de texto sobre conteudo binario",
    })
  );
  await publishCanonical(
    rootA,
    rec(idA, "nexos://state/atual", "project_state", {
      title: "estado do projeto A",
      current_state: "quatro nodes fechados",
      next_action: "escolher o proximo alvo",
    })
  );
  await publishCanonical(
    rootB,
    rec(idB, "nexos://gotcha/outro-projeto", "gotcha", {
      title: "awk do macOS trunca em byte NUL — registro do projeto B",
      failure_mode: "mesma classe de falha, outro Store",
    })
  );

  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
  process.exitCode = undefined;
});

describe("MEM-SEARCH · nexos memory --search", () => {
  it("POSITIVO: recupera por assunto, sem filename nem id", async () => {
    const out = await buscar(rootA, "awk trunca byte NUL no macos");
    expect(out).toContain("awk do macOS trunca em byte NUL silenciosamente");
  });

  it("PROVENIÊNCIA: cada resultado sai com why, source_ref, producer_id e project_id", async () => {
    const out = await buscar(rootA, "awk trunca byte NUL no macos");
    expect(out).toContain("why:");
    expect(out).toContain("termo(s) do intent");
    expect(out).toContain("source_ref:");
    expect(out).toContain("nexos://gotcha/awk-nul");
    expect(out).toContain("producer_id:");
    expect(out).toContain("produtor-de-teste");
    expect(out).toContain("project_id:");
    expect(out).toContain(idA);
  });

  it("NEGATIVO: assunto sem relação não devolve o record", async () => {
    const out = await buscar(rootA, "kubernetes ingress nginx annotations");
    expect(out).not.toContain("awk do macOS");
    expect(out).toContain("nenhum record casou");
  });

  it("NEGATIVO: project_state não entra só pelo bônus de kind", async () => {
    /**
     * `PESO_KIND` dá 100 a `project_state` mesmo sem termo em comum — correto no
     * boot ("onde paramos"), falso positivo fixo no topo de uma busca.
     */
    const out = await buscar(rootA, "awk trunca byte NUL no macos");
    expect(out).not.toContain("estado do projeto A");
  });

  it("ISOLAMENTO: o Store do projeto B nunca aparece na busca do projeto A", async () => {
    const out = await buscar(rootA, "awk trunca byte NUL no macos");
    expect(out).not.toContain("registro do projeto B");
    expect(out).not.toContain(idB);
  });

  it("LEITURA PURA: buscar não cria nem altera nenhum arquivo do Store", async () => {
    const antes = await fs.readdir(path.join(rootA, ".nexos", "records", "knowledge"));
    await buscar(rootA, "awk trunca byte NUL no macos");
    await buscar(rootA, "kubernetes ingress nginx annotations");
    const depois = await fs.readdir(path.join(rootA, ".nexos", "records", "knowledge"));
    expect(depois.sort()).toEqual(antes.sort());
  });

  it("assunto vazio é recusado — busca vazia devolveria o Store inteiro", async () => {
    const cap = captureStdout();
    try {
      await memory({ cwd: rootA, search: "   " });
    } finally {
      cap.restore();
    }
    expect(process.exitCode).toBe(1);
  });
});
