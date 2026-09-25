/**
 * Critério 1 — CANONICAL WRITE SAFETY.
 *
 *   WRITER AND READER MUST ACCEPT THE SAME UNIT
 *   INVALID RECORD MUST NOT TOUCH THE STORE
 *
 * O defeito medido em 14/08: `publishCanonical` aceitou dois records que o
 * reader rejeitou (`content` sem campo substantivo, `supersedes` como array).
 * Um Store validado só na saída acumula corrupção que ninguém vê até tentar ler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical, StoreBoundaryError } from "../src/lib/capsule/store.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { validateRecord } from "../src/lib/capsule/schemas.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { forProject } from "../src/lib/capsule/paths.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-14T23:00:00.000Z";
let ws: string;
let root: string;
let projectId: string;

function base(content: Record<string, unknown>, over: Record<string, unknown> = {}): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "agent",
    provenance: { source_ref: "src#A", producer_id: "test", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: ["src#A"],
    created_at: NOW,
    version: 1,
    content,
    ...over,
  } as CapsuleRecord;
}

/** Conta TUDO que existe sob `.nexos`, inclusive staging — nada pode sobrar. */
async function arquivosDaCapsule(raiz: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(raiz, full));
    }
  };
  await walk(path.join(raiz, ".nexos"));
  return out.sort();
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "ws-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("write safety · positivo", () => {
  it("record válido publica e o reader o encontra", async () => {
    const r = base({ title: "ok", failure_mode: "algo quebra" });
    const res = await publishCanonical(root, r);
    expect(res.outcome).toBe("CREATED");

    const lido = await readCurrentRecords(root);
    expect(lido.ok && lido.records).toHaveLength(1);
  });
});

describe("write safety · negativo (fail-closed)", () => {
  /** Os dois casos REAIS que passaram pelo writer antes desta correção. */
  const invalidos: [string, () => CapsuleRecord][] = [
    ["content sem campo substantivo", () => base({ title: "só título" })],
    [
      "supersedes como array em vez de string",
      () => base({ title: "t", failure_mode: "f" }, { supersedes: ["knw_01AAAAAAAAAAAAAAAAAAAAAAAA"] }),
    ],
    ["kind inexistente", () => base({ title: "t", failure_mode: "f" }, { kind: "inventado" })],
    ["origin fora do enum", () => base({ title: "t", failure_mode: "f" }, { origin: "session" })],
    ["provenance ausente", () => base({ title: "t", failure_mode: "f" }, { provenance: undefined })],
  ];

  for (const [nome, mk] of invalidos) {
    it(`rejeita: ${nome}`, async () => {
      const antes = await arquivosDaCapsule(root);
      await expect(publishCanonical(root, mk())).rejects.toThrow(StoreBoundaryError);
      /** Nem canônico, nem staging, nem `.tmp` órfão. */
      expect(await arquivosDaCapsule(root)).toEqual(antes);
    });
  }

  it("a mensagem diz que nada foi escrito", async () => {
    await expect(publishCanonical(root, base({ title: "só título" }))).rejects.toThrow(
      /Nada foi escrito|FAIL CLOSED/
    );
  });
});

describe("write safety · simetria writer↔reader", () => {
  /**
   * A referência é EXTERNA aos dois: `validateRecord`, o schema canônico.
   * Perguntar ao writer se o reader concorda seria comparar A com A.
   */
  it("o que o schema aprova, o writer aceita e o reader lê", async () => {
    const r = base({ title: "t", failure_mode: "f" });
    expect(validateRecord(r).ok).toBe(true);
    await expect(publishCanonical(root, r)).resolves.toMatchObject({ outcome: "CREATED" });
    const lido = await readCurrentRecords(root);
    expect(lido.ok && lido.records).toHaveLength(1);
  });

  it("o que o schema reprova, o writer recusa — sem assimetria", async () => {
    const r = base({ title: "só título" });
    expect(validateRecord(r).ok).toBe(false);
    await expect(publishCanonical(root, r)).rejects.toThrow();
  });
});

describe("write safety · contrafactual", () => {
  /**
   * Prova que o gate MATA a mutação: um record inválido escrito DIRETO no disco,
   * contornando `publishCanonical`, é exatamente o estado que existiria sem a
   * validação no writer — e o reader o denuncia como UNREADABLE.
   *
   * `A GATE THAT CANNOT GO RED IS NOT A GATE`.
   */
  it("record inválido que chega ao disco por fora deixa o Store ILEGÍVEL", async () => {
    const invalido = base({ title: "só título" });
    const destino = forProject(root).recordPath("KnowledgeRecord", invalido.id);
    await fs.ensureDir(path.dirname(destino));
    await fs.writeFile(destino, JSON.stringify(invalido), "utf-8");

    const lido = await readCurrentRecords(root);
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.reason).toBe("UNREADABLE");
  });
});
