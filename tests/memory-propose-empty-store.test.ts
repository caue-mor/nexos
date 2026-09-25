/**
 * MEM-PROPOSE-EMPTY — `propor()` deriva `project_id` do MANIFEST, nunca dos
 * records.
 *
 *   MANIFEST IS IDENTITY · RECORDS ARE CONTENT
 *   EMPTY STORE != NO CAPSULE
 *
 * `records.find(r => typeof r.project_id === "string")?.project_id ?? ""`
 * devolvia "" contra um Store recém-criado por `nexos init` — zero records,
 * manifest válido — e abortava com "projeto sem Capsule canônica" uma capsule
 * que EXISTE. O positivo mede exatamente esse caso normal de pós-init; o
 * contrafactual garante que a mudança não afrouxou o gate: sem manifest,
 * continua recusando.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { readCurrentRecords, contentOf } from "../src/lib/capsule/reader.js";
import { memory } from "../src/commands/memory.js";

const TMP = fs.realpathSync(os.tmpdir());

let root: string;

/** Silencia o clack: o que se mede aqui é o Store, não a saída. */
function mudo(): () => void {
  const s = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const l = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    s.mockRestore();
    l.mockRestore();
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "mem-empty-"));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(root);
  process.exitCode = undefined;
});

describe("nexos memory --fact contra Store vazio", () => {
  it("POSITIVO: manifest válido, zero records — candidato nasce com o project_id do manifest", async () => {
    const { projectId } = await initializeCapsule(root, { projectName: "projeto-vazio" });

    /** `records/` está lá (esqueleto do init), mas sem NENHUM arquivo dentro. */
    const antes = await readCurrentRecords(root);
    expect(antes.ok).toBe(true);
    if (antes.ok) expect(antes.records).toHaveLength(0);

    const restaurar = mudo();
    try {
      await memory({
        cwd: root,
        fact: "Store vazio pos-init tem manifest valido e zero records",
        evidence: "tests/memory-propose-empty-store.test.ts",
      });
    } finally {
      restaurar();
    }

    expect(process.exitCode).not.toBe(1);

    const depois = await readCurrentRecords(root);
    if (!depois.ok) throw new Error("store ilegível");
    const candidatos = depois.records.filter(
      (r) => (r.record as { kind?: string }).kind === "memory_candidate"
    );
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]!.record.project_id).toBe(projectId);
    expect(contentOf(candidatos[0]!.record)["fact"]).toBe(
      "Store vazio pos-init tem manifest valido e zero records"
    );
  });

  it("CONTRAFACTUAL: sem manifest, continua recusando com Capsule ausente", async () => {
    /** Nenhum `nexos init` rodou aqui — só um diretório vazio. */
    const restaurar = mudo();
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await memory({
        cwd: root,
        fact: "fato que nao deveria ser proposto sem capsule",
        evidence: "tests/memory-propose-empty-store.test.ts",
      });
    } finally {
      restaurar();
      erro.mockRestore();
    }

    expect(process.exitCode).toBe(1);

    const r = await readCurrentRecords(root);
    if (!r.ok) return; // sem `.nexos/records` nem para ler — também prova que nada foi escrito.
    expect(r.records).toHaveLength(0);
  });
});
