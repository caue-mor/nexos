/**
 * A2.1 — `nexos memory --eval <golden.yaml>`: régua reproduzível de
 * recuperação (recall@5, MRR), com ponto de encaixe para retriever externo
 * por comando (`--retriever-cmd`).
 *
 *   MECHANICAL VERIFICATION NEEDS A NUMBER, NOT A PARECER
 *
 * Mesmo padrão de `tests/memory-search.test.ts`: capsule isolada em tmpdir,
 * `initializeCapsule` + `publishCanonical`, saída capturada via spy em
 * `process.stdout.write` (cobre `console.log` também).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { memory } from "../src/commands/memory.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-09-17T00:00:00.000Z";

let ws: string;
let root: string;

function captureStdout(): { text: () => string; restore: () => void } {
  let out = "";
  /**
   * Dois pontos de saída: `p.log`/`p.intro` (clack) escrevem via
   * `process.stdout.write`; a saída `--json` usa `console.log` direto (mesma
   * convenção de `decision.ts`/`relevant-files.ts`) — sob o Vitest,
   * `console.log` não passa pelo `process.stdout.write` monkey-patchado
   * (o runner intercepta `console` antes), então precisa de spy próprio.
   */
  const spyWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  const spyLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
  });
  return {
    text: () => out,
    restore: () => {
      spyWrite.mockRestore();
      spyLog.mockRestore();
    },
  };
}

function rec(projectId: string, sourceRef: string, kind: string, content: Record<string, string>): CapsuleRecord {
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

async function rodarEval(cwd: string, arquivo: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cap = captureStdout();
  try {
    await memory({ cwd, eval: arquivo, ...extra });
    return cap.text();
  } finally {
    cap.restore();
  }
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "mem-eval-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  const { projectId } = await initializeCapsule(root, { projectName: "proj" });

  await publishCanonical(
    root,
    rec(projectId, "nexos://gotcha/fake-a", "gotcha", {
      title: "primeiro gotcha de teste",
      rule: "regra do primeiro gotcha",
    })
  );
  await publishCanonical(
    root,
    rec(projectId, "nexos://gotcha/fake-b", "gotcha", {
      title: "segundo gotcha de teste, sobre widget quebrado",
      rule: "widget quebrado precisa de retry",
    })
  );

  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
  process.exitCode = undefined;
});

const GOLDEN_BASICO = [
  "version: 1",
  "cases:",
  "  - id: c1",
  "    type: exact",
  '    query: "widget quebrado retry"',
  '    expected_source_ref: "nexos://gotcha/fake-b"',
  "",
].join("\n");

describe("A2.1 · nexos memory --eval", () => {
  it("imprime sha256 do golden, recall@5 e MRR", async () => {
    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(arquivo, GOLDEN_BASICO, "utf8");

    const out = await rodarEval(root, arquivo);
    expect(out).toContain("sha256:");
    expect(out).toContain(createHash("sha256").update(GOLDEN_BASICO, "utf8").digest("hex"));
    expect(out).toContain("recall@5");
    expect(out).toContain("MRR");
    expect(out).toContain("hit rank=1");
    expect(process.exitCode).toBeUndefined();
  });

  it("--json imprime métricas estruturadas, incluindo sha256 e por-caso", async () => {
    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(arquivo, GOLDEN_BASICO, "utf8");

    const out = await rodarEval(root, arquivo, { json: true });
    const parsed = JSON.parse(out) as {
      sha256: string;
      total: number;
      recallAt5: number;
      mrr: number;
      results: { id: string; rank: number | null }[];
    };
    expect(parsed.sha256).toBe(createHash("sha256").update(GOLDEN_BASICO, "utf8").digest("hex"));
    expect(parsed.total).toBe(1);
    expect(parsed.recallAt5).toBe(1);
    expect(parsed.mrr).toBe(1);
    expect(parsed.results[0]).toMatchObject({ id: "c1", rank: 1 });
  });

  it("golden set com id duplicado é recusado, nada roda", async () => {
    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(
      arquivo,
      ["version: 1", "cases:", "  - id: dup", '    type: exact', '    query: "a"', '    expected_source_ref: "x"', "  - id: dup", '    type: exact', '    query: "b"', '    expected_source_ref: "y"', ""].join("\n"),
      "utf8"
    );
    const out = await rodarEval(root, arquivo);
    expect(out).toContain("duplicado");
    expect(process.exitCode).toBe(1);
  });

  it("YAML inválido reporta erro, não lança e não escreve nada", async () => {
    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(arquivo, "isto: [nao fecha", "utf8");
    const antes = await fs.readdir(path.join(root, ".nexos", "records", "knowledge"));
    const out = await rodarEval(root, arquivo);
    expect(out.toLowerCase()).toContain("inválido");
    expect(process.exitCode).toBe(1);
    const depois = await fs.readdir(path.join(root, ".nexos", "records", "knowledge"));
    expect(depois.sort()).toEqual(antes.sort());
  });

  it("A2.4 · LEITURA PURA — --eval não cria, apaga nem altera nenhum record do Store", async () => {
    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(arquivo, GOLDEN_BASICO, "utf8");
    const antes = await fs.readdir(path.join(root, ".nexos", "records", "knowledge"));
    await rodarEval(root, arquivo);
    await rodarEval(root, arquivo, { json: true });
    const depois = await fs.readdir(path.join(root, ".nexos", "records", "knowledge"));
    expect(depois.sort()).toEqual(antes.sort());
  });

  it("--retriever-cmd: pergunta vai no stdin, array JSON de source_refs volta no stdout", async () => {
    const script = path.join(ws, "fake-retriever.mjs");
    /** Ignora a query, sempre devolve os dois fakes NA ORDEM ERRADA (b antes de a) — prova que quem ranqueia é o script, não o motor interno. */
    await fs.writeFile(
      script,
      [
        "process.stdin.resume();",
        "let data = '';",
        "process.stdin.on('data', (c) => { data += c; });",
        "process.stdin.on('end', () => {",
        "  if (!data.trim()) process.exit(2);",
        "  console.log(JSON.stringify(['nexos://gotcha/fake-b', 'nexos://gotcha/fake-a']));",
        "});",
      ].join("\n"),
      "utf8"
    );

    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(
      arquivo,
      ["version: 1", "cases:", "  - id: c1", "    type: exact", '    query: "qualquer coisa"', '    expected_source_ref: "nexos://gotcha/fake-a"', ""].join("\n"),
      "utf8"
    );

    const out = await rodarEval(root, arquivo, { retrieverCmd: `node "${script}"`, json: true });
    const parsed = JSON.parse(out) as { results: { id: string; rank: number | null }[]; retriever: string };
    expect(parsed.retriever).toBe("external");
    expect(parsed.results[0]).toMatchObject({ id: "c1", rank: 2 });
  });

  it("--retriever-cmd que sai com erro marca o caso como falho, sem derrubar o eval inteiro", async () => {
    const script = path.join(ws, "broken-retriever.mjs");
    await fs.writeFile(script, "process.stdin.resume(); process.exit(1);", "utf8");

    const arquivo = path.join(ws, "golden.yaml");
    await fs.writeFile(arquivo, GOLDEN_BASICO, "utf8");

    const out = await rodarEval(root, arquivo, { retrieverCmd: `node "${script}"`, json: true });
    const parsed = JSON.parse(out) as { results: { id: string; rank: number | null; error?: string }[] };
    expect(parsed.results[0]!.rank).toBeNull();
    expect(parsed.results[0]!.error).toBeTruthy();
  });
});
