/**
 * `graph.json` precisa listar TODO arquivo do escopo como nó de primeira
 * classe — não só os que alguma aresta toca.
 *
 *   DERIVAR NÓ DE ARESTA APAGA O ARQUIVO ISOLADO
 *
 * MEDIDO no próprio repo em 2026-09-18, antes da correção: `files_scanned`
 * 576 contra 319 nós deriváveis de `from`/`to` — 259 arquivos invisíveis
 * para qualquer consumidor que inferisse os nós das arestas. O teste abaixo
 * reproduz a condição em miniatura (um arquivo que ninguém importa e que não
 * importa ninguém) e falha se a lista voltar a ser derivada.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanProjectStructure, writeMapArtifacts } from "../src/lib/map/map-scan.js";

const execFileAsync = promisify(execFile);
const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function fixture(dir: string): Promise<void> {
  await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
  await fs.outputFile(path.join(dir, "src/a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
  await fs.outputFile(path.join(dir, "src/b.ts"), "export const b = 1;\n");
  // O nó que o defeito apagava: ninguém o importa e ele não importa ninguém.
  await fs.outputFile(path.join(dir, "src/orphan.ts"), "export const orphan = true;\n");
}

async function readGraph(dir: string): Promise<{
  files_scanned: number;
  nodes: { id: string; path: string; last_changed_commit: string | null; certainty: string; linkable: boolean }[];
  edges: { from: string; to?: string }[];
}> {
  return fs.readJson(path.join(dir, ".nexos/map/graph.json"));
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.remove(d);
  }
});

describe("graph.json nodes[]", () => {
  it("lista todo arquivo do escopo, inclusive o isolado, e casa com files_scanned", async () => {
    const dir = await makeTmpDir("nexos-graph-nodes-");
    await fixture(dir);
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir });

    const scan = await scanProjectStructure(dir);
    await writeMapArtifacts(dir, scan, new Date().toISOString());
    const graph = await readGraph(dir);

    expect(graph.nodes.length).toBe(graph.files_scanned);

    const derivaveis = new Set<string>();
    for (const e of graph.edges) {
      derivaveis.add(e.from);
      if (e.to) derivaveis.add(e.to);
    }
    const paths = graph.nodes.map((n) => n.path);
    expect(paths).toContain("src/orphan.ts");
    // NEGATIVE CONTROL do defeito: o órfão NÃO sai das arestas. Se este
    // expect quebrar, a fixture deixou de exercer a condição e o teste
    // vira decorativo.
    expect(derivaveis.has("src/orphan.ts")).toBe(false);

    const orphan = graph.nodes.find((n) => n.path === "src/orphan.ts");
    expect(orphan?.certainty).toBe("OBSERVED");
    expect(orphan?.id).toBe("src/orphan.ts");
    expect(orphan?.last_changed_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sem git, os nós continuam completos e last_changed fica null (não sabido, não 'nunca mudou')", async () => {
    const dir = await makeTmpDir("nexos-graph-nodes-nogit-");
    await fixture(dir);

    const scan = await scanProjectStructure(dir);
    await writeMapArtifacts(dir, scan, new Date().toISOString());
    const graph = await readGraph(dir);

    expect(graph.nodes.length).toBe(graph.files_scanned);
    expect(graph.nodes.map((n) => n.path)).toContain("src/orphan.ts");
    for (const n of graph.nodes) expect(n.last_changed_commit).toBeNull();
  });
});

describe("linkable separa 'ninguém usa' de 'não teria como usar'", () => {
  /**
   *   SEM ARESTA POSSÍVEL NÃO É "ISOLADO", É "NÃO PARTICIPA"
   *
   * MEDIDO no próprio repo em 2026-09-19: 245 nós sem nenhuma aresta, dos
   * quais 190 `.md` — a tela chamava os 245 de "isolados" e o dono leu como
   * poluição, com razão. Isolado de verdade: 3.
   *
   * A régua tem DUAS metades e a segunda é a que ninguém vê: extensão que o
   * extrator lê, E não ser material que o scan já exclui do grafo. Sem a
   * segunda, `tests/fixtures/*.mts` volta a aparecer isolado tendo 12
   * imports — entrava como nó e saía como aresta.
   */
  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) await fs.remove(dir);
  });

  it("markdown não é isolado — é não-participante; código sem uso continua isolado", async () => {
    const dir = await makeTmpDir("graph-linkable-");
    await fixture(dir);
    await fs.outputFile(path.join(dir, "docs/leia.md"), "# nada aqui importa nada\n");
    await fs.outputFile(path.join(dir, "config.json"), "{}\n");

    const scan = await scanProjectStructure(dir);
    await writeMapArtifacts(dir, scan, new Date().toISOString());
    const graph = await readGraph(dir);
    const byPath = new Map(graph.nodes.map((n) => [n.path, n]));

    /** O número que prova: o .md está no inventário E fora do grafo. */
    expect(byPath.get("docs/leia.md")?.linkable).toBe(false);
    expect(byPath.get("config.json")?.linkable).toBe(false);
    /** CONTROLE: o órfão de código continua participando — some o achado real
     *  se `linkable` virar "tem aresta". */
    expect(byPath.get("src/orphan.ts")?.linkable).toBe(true);
    expect(byPath.get("src/a.ts")?.linkable).toBe(true);
  });

  it("material que o scan exclui do grafo não conta como isolado, mesmo tendo import", async () => {
    const dir = await makeTmpDir("graph-linkable-mat-");
    await fixture(dir);
    /** `fixtures/` cai em reference_or_example: as arestas dele já eram
     *  filtradas, então o nó não pode continuar afirmando participação. */
    await fs.outputFile(
      path.join(dir, "tests/fixtures/worker.mts"),
      'import { a } from "../../src/a.js";\nexport const w = a;\n'
    );

    const scan = await scanProjectStructure(dir);
    await writeMapArtifacts(dir, scan, new Date().toISOString());
    const graph = await readGraph(dir);
    const node = graph.nodes.find((n) => n.path === "tests/fixtures/worker.mts");

    expect(node).toBeDefined();
    expect(node?.linkable).toBe(false);
    /** E o motivo é material, não extensão: `.mts` é lido pelo extrator. */
    expect(graph.edges.some((e) => e.from === "tests/fixtures/worker.mts")).toBe(false);
  });
});
