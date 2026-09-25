/**
 * `--json` de leitura em state, research e gotcha — contrato de máquina para a
 * projeção Store → vault (pedido do console, 23/09). Só leitura: combinar com
 * escrita é recusado em JSON, e a saída é JSON puro em stdout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { state } from "../src/commands/state.js";
import { research } from "../src/commands/research.js";
import { gotcha } from "../src/commands/gotcha.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { readManifestProjectId, type IntegrityIssue } from "../src/lib/capsule/integrity.js";
import { makeProjectState, makeGotcha, makeResearch, makeDecision } from "./capsule-fixtures.js";

let root: string;
const NOW_FIXO = "2026-08-12T00:00:00.000Z";

/** Mesmo `project_id` do manifest da fixture — `publishCanonical` exige que bata. */
async function projectId(raiz: string): Promise<string> {
  const issues: IntegrityIssue[] = [];
  const id = await readManifestProjectId(forProject(raiz).manifest(), issues);
  if (typeof id !== "string") throw new Error("manifest ilegível na fixture de teste");
  return id;
}

async function capturar(fn: () => Promise<void>): Promise<{ out: unknown; exit: number | undefined }> {
  const linhas: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void linhas.push(a.join(" ")));
  const antes = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return { out: JSON.parse(linhas.join("\n")), exit: process.exitCode as number | undefined };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = antes;
  }
}

const calado = async (fn: () => Promise<void>) => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "read-json-"));
  await calado(() => init({ cwd: root, registerGlobally: false }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(root);
});

describe("--json de leitura", () => {
  it("state: sem estado devolve null; com estado devolve campos, identidade e trabalho resolvido", async () => {
    expect((await capturar(() => state({ cwd: root, json: true }))).out).toEqual({ state: null });
    await calado(() => state({ cwd: root, set: "fatia A pronta", next: "fatia B" }));
    const { out } = await capturar(() => state({ cwd: root, json: true }));
    const s = (out as { state: Record<string, unknown> }).state;
    expect(s).toMatchObject({ current_state: "fatia A pronta", next_action: "fatia B", source_ref: "nexos://project-state", work: "CONTINUE" });
    expect(typeof s.id).toBe("string");
    expect(typeof s.created_at).toBe("string");
  });

  it("research: lista o acervo e, com --search, só o que casa, com score", async () => {
    await calado(() => research({ cwd: root, question: "como o langfuse recebe traces", findings: "endpoint otlp http", source: ["https://langfuse.com/docs"], claim: ["endpoint otlp"], confidence: ["OFFICIAL"] }));
    await calado(() => research({ cwd: root, question: "cor do grafo do obsidian", findings: "azul e laranja", source: ["https://help.obsidian.md"], claim: ["cores do grafo"], confidence: ["OFFICIAL"] }));
    const todos = (await capturar(() => research({ cwd: root, json: true }))).out as { research: unknown[] };
    expect(todos.research).toHaveLength(2);
    const busca = (await capturar(() => research({ cwd: root, json: true, search: "langfuse" }))).out as {
      research: Array<Record<string, unknown>>;
    };
    expect(busca.research).toHaveLength(1);
    expect(busca.research[0]).toMatchObject({ question: "como o langfuse recebe traces", score: 1 });

    /**
     * HIGH #2 (rodada 3) — `contentOf` só extrai campo STRING; `sources` é
     * array e saía descartado. Sem fonte, o consumidor (projeção Store ->
     * vault) não distingue pesquisa de opinião com id.
     */
    expect(Array.isArray(busca.research[0]!.sources)).toBe(true);
    expect(busca.research[0]!.sources).toMatchObject([
      { source_url: "https://langfuse.com/docs", claim: "endpoint otlp", confidence: "OFFICIAL" },
    ]);
  });

  it("gotcha: lista os gotchas correntes", async () => {
    await calado(() => gotcha({ cwd: root, title: "hook lento trava o prompt", rule: "HOOK LENTO NAO TRAVA O PROMPT" }));
    const { out } = (await capturar(() => gotcha({ cwd: root, json: true }))) as { out: { gotchas: Array<Record<string, unknown>> } };
    expect(out.gotchas).toHaveLength(1);
    expect(out.gotchas[0]).toMatchObject({ title: "hook lento trava o prompt" });
  });

  it("combinar --json com escrita é recusado em JSON, sem escrever", async () => {
    for (const fn of [
      () => state({ cwd: root, json: true, set: "x" }),
      () => research({ cwd: root, json: true, question: "q", findings: "f" }),
      () => gotcha({ cwd: root, json: true, title: "t" }),
    ]) {
      const { out, exit } = await capturar(fn);
      expect(out).toMatchObject({ error: "JSON_SO_LEITURA" });
      expect(exit).toBe(1);
    }
    expect((await capturar(() => state({ cwd: root, json: true }))).out).toEqual({ state: null });
  });
});

/**
 * HIGH #1 (rodada 3) — os três comandos liam `readCurrentRecords` sem olhar
 * `r.anomalies`: uma linhagem DIVERGED/MALFORMED saía como `{"state": null}`
 * / `{"gotchas": []}` / `{"research": []}` com exit 0, indistinguível de um
 * Store vazio. Reprodução do revisor: dois heads para o MESMO `source_ref`,
 * sem `supersedes` entre eles — DIVERGED por construção (mesmo mecanismo de
 * `tests/project-state.test.ts` "recovery de Store DIVERGED").
 */
describe("--json de leitura · Store DIVERGED nunca parece Store vazio", () => {
  /** Duas publicações no MESMO `source_ref` (default da fixture), sem `supersedes` entre elas — DIVERGED por construção, igual `tests/project-state.test.ts`. */
  it("state: dois heads no mesmo source_ref → STORE_DIVERGENTE, exit 1, nunca {state: null}", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeProjectState({ project_id: pid }));
    await publishCanonical(root, makeProjectState({ project_id: pid }));

    const { out, exit } = await capturar(() => state({ cwd: root, json: true }));
    expect(out).toMatchObject({
      error: "STORE_DIVERGENTE",
      detail: [{ id: "nexos://project-state", tipo: "DIVERGED" }],
    });
    expect(exit).toBe(1);
  });

  it("gotcha: dois heads no mesmo source_ref → STORE_DIVERGENTE, nunca {gotchas: []}", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeGotcha({ project_id: pid }));
    await publishCanonical(root, makeGotcha({ project_id: pid }));

    const { out, exit } = await capturar(() => gotcha({ cwd: root, json: true }));
    expect(out).toMatchObject({ error: "STORE_DIVERGENTE" });
    expect((out as { detail: Array<{ tipo: string }> }).detail.some((d) => d.tipo === "DIVERGED")).toBe(true);
    expect(exit).toBe(1);
  });

  it("research: dois heads no mesmo source_ref → STORE_DIVERGENTE, nunca {research: []}", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeResearch({ project_id: pid }));
    await publishCanonical(root, makeResearch({ project_id: pid }));

    const { out, exit } = await capturar(() => research({ cwd: root, json: true }));
    expect(out).toMatchObject({ error: "STORE_DIVERGENTE" });
    expect((out as { detail: Array<{ tipo: string }> }).detail.some((d) => d.tipo === "DIVERGED")).toBe(true);
    expect(exit).toBe(1);
  });
});

/**
 * N1 (MEDIUM, revisão independente rodada 2) — `state.ts`/`gotcha.ts` liam
 * sem `families`, e `kind` filtra `records`, nunca `anomalies`
 * (`reader.ts`): uma anomalia em QUALQUER family lida (por padrão, todas)
 * derrubava `state --json`/`gotcha --json` com `STORE_DIVERGENTE`, mesmo
 * com a partição que o comando de fato expõe saudável. Reprodução do
 * revisor: dois heads de `Decision` no mesmo `source_ref` — família que nem
 * `state` nem `gotcha` expõem.
 */
describe("--json de leitura · N1 — anomalia de OUTRA family nunca derruba a saída", () => {
  it("state --json ignora Decision DIVERGED — só a própria partição de project_state pode derrubar", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeDecision({ project_id: pid }));
    await publishCanonical(root, makeDecision({ project_id: pid })); // mesmo source_ref default -> DIVERGED em "Decision"
    await calado(() => state({ cwd: root, set: "saudavel", next: "seguir" }));

    const { out, exit } = await capturar(() => state({ cwd: root, json: true }));
    expect(out).not.toMatchObject({ error: "STORE_DIVERGENTE" });
    expect((out as { state: Record<string, unknown> }).state).toMatchObject({ current_state: "saudavel" });
    expect(exit).toBeUndefined();
  });

  it("gotcha --json ignora Decision DIVERGED — só a family KnowledgeRecord pode derrubar", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeDecision({ project_id: pid }));
    await publishCanonical(root, makeDecision({ project_id: pid }));
    await calado(() => gotcha({ cwd: root, title: "gotcha saudavel", rule: "REGRA X" }));

    const { out, exit } = await capturar(() => gotcha({ cwd: root, json: true }));
    expect(out).not.toMatchObject({ error: "STORE_DIVERGENTE" });
    expect((out as { gotchas: unknown[] }).gotchas).toHaveLength(1);
    expect(exit).toBeUndefined();
  });

  /**
   * Revisão independente da rodada 3 (HIGH): o filtro por `family` sozinho
   * deixava `project_state` — MESMA family `KnowledgeRecord` — derrubar
   * `gotcha --json`. Sessões paralelas com `nexos state --set` produzem esse
   * DIVERGED na vida normal. O caso contrário (gotcha DIVERGED derruba) é o
   * teste "gotcha: dois heads no mesmo source_ref" acima.
   */
  it("gotcha --json ignora project_state DIVERGED — outro kind na MESMA family", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeProjectState({ project_id: pid }));
    await publishCanonical(root, makeProjectState({ project_id: pid }));
    await calado(() => gotcha({ cwd: root, title: "gotcha saudavel", rule: "REGRA X" }));

    const { out, exit } = await capturar(() => gotcha({ cwd: root, json: true }));
    expect(out).not.toMatchObject({ error: "STORE_DIVERGENTE" });
    expect((out as { gotchas: unknown[] }).gotchas).toHaveLength(1);
    expect(exit).toBeUndefined();
  });

  /**
   * Verificador da rodada 3 (HIGH sobre fd8116f6): excluir por PREFIXO de
   * `source_ref` engolia o DIVERGED de um gotcha cujo `source_ref` colide com o
   * de outro kind — possível antes do guard de `--source-ref` em `gotcha.ts`,
   * ou por escritor fora da CLI. O filtro decide pelo `kind` real dos heads.
   */
  it("gotcha DIVERGED com source_ref de project_state continua derrubando gotcha --json", async () => {
    const pid = await projectId(root);
    const colide = { source_ref: "nexos://project-state", producer_id: "legado-pre-guard", submitted_at: NOW_FIXO };
    await publishCanonical(root, makeGotcha({ project_id: pid, provenance: colide }));
    await publishCanonical(root, makeGotcha({ project_id: pid, provenance: colide }));

    const { out, exit } = await capturar(() => gotcha({ cwd: root, json: true }));
    expect(out).toMatchObject({ error: "STORE_DIVERGENTE" });
    expect(exit).toBe(1);
  });

  it("STORE_DIVERGENTE de verdade (a própria partição) agora carrega family no detail", async () => {
    const pid = await projectId(root);
    await publishCanonical(root, makeProjectState({ project_id: pid }));
    await publishCanonical(root, makeProjectState({ project_id: pid }));

    const { out } = await capturar(() => state({ cwd: root, json: true }));
    expect(out).toMatchObject({ detail: [{ family: "KnowledgeRecord" }] });
  });
});
