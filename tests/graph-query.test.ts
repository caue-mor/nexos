/**
 * Project Intelligence V1 — fatia 1. Fixtures pequenas, NUNCA o grafo real da
 * máquina (25 MB, gitignored) — o teste contra o grafo real e o repo real
 * mora em `tests/graph-query-real-graph.test.ts`, separado e skipado quando
 * o artefato não existe (clone limpo).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  loadGraph,
  resolveFreshness,
  rankFiles,
  queryRelevantFiles,
  type GraphData,
  type GraphNode,
  type GraphLink,
} from "../src/lib/graph-query.js";
import type { GitOutcome, GitRunner } from "../src/lib/capsule/git-boundary.js";
import { forProject } from "../src/lib/capsule/paths.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "graph-query-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

// ─── loadGraph ──────────────────────────────────────────────────────────────

describe("loadGraph", () => {
  it("NOT_AVAILABLE quando o arquivo não existe", async () => {
    const r = await loadGraph(path.join(ws, "nope.json"));
    expect(r).toEqual({ ok: false, reason: "NOT_AVAILABLE", detail: expect.any(String) });
  });

  it("MALFORMED quando o JSON é inválido", async () => {
    const p = path.join(ws, "graph.json");
    await fs.writeFile(p, "{ not json");
    const r = await loadGraph(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MALFORMED");
  });

  it("MALFORMED quando faltam nodes/links/built_at_commit", async () => {
    const p = path.join(ws, "graph.json");
    await fs.writeJson(p, { nodes: [], links: [] }); // sem built_at_commit
    const r = await loadGraph(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MALFORMED");
  });

  it("ok quando as chaves de topo estão presentes; descarta nós/links individualmente inválidos", async () => {
    const p = path.join(ws, "graph.json");
    await fs.writeJson(p, {
      nodes: [{ id: "a", label: "A", source_file: "a.ts" }, { label: "sem id" }],
      links: [{ source: "a", target: "b", relation: "calls" }, { relation: "sem source/target" }],
      built_at_commit: "deadbeef",
    });
    const r = await loadGraph(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(1);
      expect(r.graph.links).toHaveLength(1);
      expect(r.graph.built_at_commit).toBe("deadbeef");
    }
  });
});

// ─── resolveFreshness ───────────────────────────────────────────────────────

describe("resolveFreshness", () => {
  it("FRESH: mesmo commit, árvore limpa", () => {
    expect(resolveFreshness("abc", "abc", false)).toBe("FRESH");
  });
  it("STALE: commit diferente", () => {
    expect(resolveFreshness("abc", "def", false)).toBe("STALE");
  });
  it("STALE: mesmo commit, árvore suja", () => {
    expect(resolveFreshness("abc", "abc", true)).toBe("STALE");
  });
  it("STALE: HEAD desconhecido — nunca FRESH sem medir", () => {
    expect(resolveFreshness("abc", undefined, false)).toBe("STALE");
  });
});

// ─── rankFiles (puro) ───────────────────────────────────────────────────────

function graph(nodes: readonly GraphNode[], links: readonly GraphLink[] = []): GraphData {
  return { nodes, links, built_at_commit: "deadbeef" };
}

describe("rankFiles", () => {
  it("match direto por label soma com match de path do mesmo arquivo", () => {
    const g = graph([{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" }]);
    const { items, candidateCount } = rankFiles(g, "boot");
    expect(candidateCount).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toBe("src/commands/boot.ts");
    expect(items[0]?.relation).toBe("direct");
    // label (3) + path (2): "boot.ts" também bate por componente do path.
    expect(items[0]?.score).toBe(5);
    expect(items[0]?.reason).toContain("'boot'");
    expect(items[0]?.reason).toContain("bootProject");
  });

  it("substring casa símbolo PascalCase colapsado (norm_label) mesmo sem igualdade exata", () => {
    const g = graph([
      { id: "n1", label: "CapabilityListOptions", norm_label: "capabilitylistoptions", source_file: "src/commands/capability.ts", file_type: "code" },
    ]);
    const { items } = rankFiles(g, "capability");
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toBe("src/commands/capability.ts");
  });

  it("propaga 1 salto via 'calls' para um arquivo sem match direto", () => {
    const g = graph(
      [
        { id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" },
        { id: "n2", label: "helperFn", norm_label: "helperfn", source_file: "src/lib/helper.ts", file_type: "code" },
      ],
      [{ source: "n1", target: "n2", relation: "calls" }]
    );
    const { items } = rankFiles(g, "boot");
    const helper = items.find((i) => i.path === "src/lib/helper.ts");
    expect(helper).toBeDefined();
    expect(helper?.relation).toBe("calls");
    expect(helper?.score).toBe(2); // RELATION_WEIGHT.calls
    expect(helper?.reason).toContain("calls");
    expect(helper?.reason).toContain("bootProject");
  });

  it("NÃO propaga por 'contains' — ruído estrutural, não relação de código", () => {
    const g = graph(
      [
        { id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" },
        { id: "n2", label: "unrelatedParagraph", norm_label: "unrelatedparagraph", source_file: "docs/notes.md", file_type: "document" },
      ],
      [{ source: "n2", target: "n1", relation: "contains" }]
    );
    const { items } = rankFiles(g, "boot");
    expect(items.some((i) => i.path === "docs/notes.md")).toBe(false);
  });

  it("nó sem source_file (módulo externo) nunca vira candidato nem quebra a propagação", () => {
    const g = graph(
      [
        { id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" },
        { id: "n2", label: "node:os", norm_label: "node:os", file_type: "code" }, // sem source_file
      ],
      [{ source: "n1", target: "n2", relation: "imports" }]
    );
    const { items } = rankFiles(g, "boot");
    expect(items.some((i) => i.path === "node:os")).toBe(false);
    expect(items.find((i) => i.path === "src/commands/boot.ts")).toBeDefined();
  });

  it("task sem termo reconhecível: zero candidatos, nada inventado", () => {
    const g = graph([{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" }]);
    const { items, candidateCount } = rankFiles(g, "zzzznotfound");
    expect(items).toEqual([]);
    expect(candidateCount).toBe(0);
  });

  it("arquivo deletado: continua candidato, mas honestamente marcado exists=false", () => {
    const g = graph([{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" }]);
    const { items } = rankFiles(g, "boot", { fileExists: () => false });
    expect(items[0]?.exists).toBe(false);
  });

  it("limit corta a lista mas candidateCount reporta o total real", () => {
    const g = graph([
      { id: "n1", label: "bootA", norm_label: "boota", source_file: "a-boot.ts", file_type: "code" },
      { id: "n2", label: "bootB", norm_label: "bootb", source_file: "b-boot.ts", file_type: "code" },
      { id: "n3", label: "bootC", norm_label: "bootc", source_file: "c-boot.ts", file_type: "code" },
    ]);
    const { items, candidateCount } = rankFiles(g, "boot", { limit: 1 });
    expect(candidateCount).toBe(3);
    expect(items).toHaveLength(1);
  });

  it("determinístico: mesma query contra o mesmo grafo produz o mesmo resultado", () => {
    const g = graph(
      [
        { id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" },
        { id: "n2", label: "helperFn", norm_label: "helperfn", source_file: "src/lib/helper.ts", file_type: "code" },
      ],
      [{ source: "n1", target: "n2", relation: "calls" }]
    );
    const a = rankFiles(g, "boot");
    const b = rankFiles(g, "boot");
    expect(a).toEqual(b);
  });

  it("nunca vaza o grafo bruto — item não carrega nodes/links", () => {
    const g = graph([{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" }]);
    const { items } = rankFiles(g, "boot");
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      ["changed_since_built", "exists", "path", "provenance", "reason", "relation", "score"].sort()
    );
  });

  /**
   * A3.3 / G3.3 — self-token não pontua sozinho, mas continua contando
   * quando corrobora outro termo real do mesmo candidato.
   */
  describe("selfTokens — nome do próprio projeto não vira ruído sozinho", () => {
    it("candidato casado SÓ pelo self-token cai fora", () => {
      const g = graph([
        { id: "n1", label: "NexosHookRunner", norm_label: "nexoshookrunner", source_file: "src/host/claude/hooks/nexos-runner.ts", file_type: "code" },
      ]);
      const { items, candidateCount } = rankFiles(g, "preciso entender o nexos", { selfTokens: new Set(["nexos"]) });
      expect(items).toEqual([]);
      expect(candidateCount).toBe(0);
    });

    it("sem selfTokens, o mesmo candidato aparece normalmente (comportamento antigo intacto)", () => {
      const g = graph([
        { id: "n1", label: "NexosHookRunner", norm_label: "nexoshookrunner", source_file: "src/host/claude/hooks/nexos-runner.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "preciso entender o nexos");
      expect(items).toHaveLength(1);
    });

    it("self-token JUNTO com termo real continua pontuando (não é descartado)", () => {
      const g = graph([
        { id: "n1", label: "NexosHookRunner", norm_label: "nexoshookrunner", source_file: "src/host/claude/hooks/nexos-runner.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "corrigir o hook do nexos", { selfTokens: new Set(["nexos"]) });
      expect(items).toHaveLength(1);
      expect(items[0]?.reason).toContain("'nexos'");
      expect(items[0]?.reason).toContain("'hook'");
    });
  });

  describe("changed_since_built — honestidade de frescor por item (A3.3)", () => {
    it("path presente no diff vira true; ausente vira false", () => {
      const g = graph([
        { id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" },
        { id: "n2", label: "bootHelper", norm_label: "boothelper", source_file: "src/commands/boot-helper.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "boot", { changedFiles: new Set(["src/commands/boot.ts"]) });
      expect(items.find((i) => i.path === "src/commands/boot.ts")?.changed_since_built).toBe(true);
      expect(items.find((i) => i.path === "src/commands/boot-helper.ts")?.changed_since_built).toBe(false);
    });

    it("changedFiles UNKNOWN propaga UNKNOWN — nunca vira false por omissão", () => {
      const g = graph([{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" }]);
      const { items } = rankFiles(g, "boot", { changedFiles: "UNKNOWN" });
      expect(items[0]?.changed_since_built).toBe("UNKNOWN");
    });

    it("changedFiles ausente (chamador não computou) também vira UNKNOWN, não false", () => {
      const g = graph([{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/commands/boot.ts", file_type: "code" }]);
      const { items } = rankFiles(g, "boot");
      expect(items[0]?.changed_since_built).toBe("UNKNOWN");
    });
  });

  /**
   * Fronteira de palavra — os 4 casos medidos contra o grafo real (handoff
   * 2026-09-06). Substring solto (`haystack.includes(term)`) casava termos
   * curtos da task no MEIO de identificadores sem nenhuma relação com eles —
   * "esta" dentro de `attestACL`/`TargetResolution`, "tres" dentro de
   * `writeSocketResponse`, "dia" dentro de `DialecticEngine`. Cada fixture
   * abaixo reproduz o padrão exato que causava o falso positivo real.
   */
  describe("fronteira de palavra — os 4 casos do handoff (substring != sinal)", () => {
    it("caso 1 — trivial: 'resuma esta frase em tres palavras' não bate em fragmento de símbolo", () => {
      const g = graph([
        // "esta" era substring de "attest"+"ACL" (attestACL) — nada a ver com o pedido.
        { id: "n1", label: "attestACL", norm_label: "attestacl", source_file: "src/lib/presence/broker.ts", file_type: "code" },
        // "tres" era substring de "Socket"+"Response" (writeSocketResponse) — idem.
        { id: "n2", label: "writeSocketResponse", norm_label: "writesocketresponse", source_file: "src/lib/presence/socket.ts", file_type: "code" },
      ]);
      const { items, candidateCount } = rankFiles(g, "resuma esta frase em tres palavras");
      expect(items).toEqual([]);
      expect(candidateCount).toBe(0);
    });

    it("caso 2 — trivial: 'bom dia, tudo bem?' não bate em fragmento de símbolo", () => {
      // "dia" era substring de "Dialectic" (DialecticEngine) — palavra inteira é "dialectic", não "dia".
      const g = graph([
        { id: "n1", label: "DialecticEngine", norm_label: "dialecticengine", source_file: "engine/memory/dialectic.py", file_type: "code" },
      ]);
      const { items, candidateCount } = rankFiles(g, "bom dia, tudo bem?");
      expect(items).toEqual([]);
      expect(candidateCount).toBe(0);
    });

    it("caso 3 — técnico: 'records deprecados' continua trazendo reader/memory/gotcha-migrator (palavra inteira, não regride)", () => {
      const g = graph(
        [
          { id: "n1", label: "readCurrentRecords", norm_label: "readcurrentrecords", source_file: "src/lib/capsule/reader.ts", file_type: "code" },
          { id: "n2", label: "lerRecords", norm_label: "lerrecords", source_file: "src/commands/memory.ts", file_type: "code" },
          { id: "n3", label: "mapearGotchaRecords", norm_label: "mapeargotcharecords", source_file: "src/lib/capsule/gotcha-migrator.ts", file_type: "code" },
        ],
        [{ source: "n1", target: "n2", relation: "calls" }]
      );
      const { items } = rankFiles(g, "corrija o filtro que impede records deprecados de aparecer na leitura corrente");
      const paths = items.map((i) => i.path);
      expect(paths).toContain("src/lib/capsule/reader.ts");
      expect(paths).toContain("src/commands/memory.ts");
      expect(paths).toContain("src/lib/capsule/gotcha-migrator.ts");
    });

    /**
     * Caso 4 — CORRIGIDO pelo coordenador em 2026-09-06: o critério original
     * pedia "sem fragmento" E "mesma lista de antes" ao mesmo tempo, mas a
     * posição antiga de `surface-resolver.ts` neste caso vinha 100% de
     * fragmento ("esta" em `HostSurfaceStage`, "ler" em
     * `DetectStaleRuntimeOptions` — nenhum dos dois é a palavra inteira
     * "esta"/"ler", ambos cruzam fronteira de camelCase). Exigir que
     * `surface-resolver.ts` continuasse aparecendo aqui seria reintroduzir o
     * próprio bug que este fix remove. Critério corrigido: `schemas.ts` e
     * `paths.ts` (sinal real de "manifest", palavra inteira) têm de
     * aparecer; `surface-resolver.ts` NÃO precisa aparecer — sua queda é o
     * comportamento CORRETO, não uma regressão. Se reintroduzir esse arquivo
     * aqui no futuro, é sinal de que o matching voltou a ser substring.
     */
    it("caso 4 — técnico: 'parser/manifest/binding' traz schemas.ts e paths.ts; surface-resolver.ts cai (era ruído de fragmento, queda correta)", () => {
      const g = graph([
        { id: "n1", label: "Manifest", norm_label: "manifest", source_file: "src/lib/capsule/schemas.ts", file_type: "code" },
        { id: "n2", label: ".manifest()", norm_label: ".manifest()", source_file: "src/lib/capsule/paths.ts", file_type: "code" },
        // ambos só casavam por fragmento no código antigo — nenhum contém "esta" ou "ler" como palavra inteira.
        { id: "n3", label: "HostSurfaceStage", norm_label: "hostsurfacestage", source_file: "src/lib/host/surface-resolver.ts", file_type: "code" },
        { id: "n4", label: "DetectStaleRuntimeOptions", norm_label: "detectstaleruntimeoptions", source_file: "src/lib/host/surface-resolver.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "o parser do manifest esta quebrando ao ler o binding");
      const paths = items.map((i) => i.path);
      expect(paths).toContain("src/lib/capsule/schemas.ts");
      expect(paths).toContain("src/lib/capsule/paths.ts");
      // não é regressão: a presença antiga vinha só de fragmento (ver comentário acima).
      expect(paths).not.toContain("src/lib/host/surface-resolver.ts");
    });
  });

  /**
   * Regressão de 45136b6 (handoff 2026-09-06): aquele commit decompôs o
   * LABEL em palavras (`symbolWords`) mas não a QUERY — buscar pelo nome
   * EXATO de um símbolo colado (sem espaço) voltava vazio mesmo com o
   * símbolo presente no grafo, porque `termosDe` sozinho não separa por
   * fronteira de case.
   */
  describe("regressão 45136b6 — query precisa da mesma decomposição do label", () => {
    it("query = nome exato do símbolo colado (camelCase) encontra o arquivo", () => {
      const g = graph([
        { id: "n1", label: "readCurrentRecords", norm_label: "readcurrentrecords", source_file: "src/lib/capsule/reader.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "readCurrentRecords");
      expect(items[0]?.path).toBe("src/lib/capsule/reader.ts");
    });

    it("query = outro nome de símbolo colado, com stopword embutida (for) na fronteira", () => {
      const g = graph([
        { id: "n1", label: "resolveModelForDispatch", norm_label: "resolvemodelfordispatch", source_file: "src/lib/harness/model-routing.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "resolveModelForDispatch");
      expect(items[0]?.path).toBe("src/lib/harness/model-routing.ts");
    });

    it("guard: query natural sem camelCase continua idêntica (união é no-op)", () => {
      const g = graph([
        { id: "n1", label: "readCurrentRecords", norm_label: "readcurrentrecords", source_file: "src/lib/capsule/reader.ts", file_type: "code" },
        { id: "n2", label: "lerRecords", norm_label: "lerrecords", source_file: "src/commands/memory.ts", file_type: "code" },
      ]);
      const { items } = rankFiles(g, "read current records");
      const paths = items.map((i) => i.path);
      expect(paths).toContain("src/lib/capsule/reader.ts");
      expect(paths).toContain("src/commands/memory.ts");
    });
  });
});

// ─── queryRelevantFiles (I/O orquestrado, git fake — sem repo real) ─────────

function fakeGit(opts: {
  head?: string;
  dirty?: boolean;
  revListCount?: number;
  changedFiles?: readonly string[];
  diffFails?: boolean;
}): GitRunner {
  const outcome = (stdout: string, code = 0): GitOutcome => ({ ok: true, code, stdout, stderr: "" });
  return {
    run: async (args: string[]): Promise<GitOutcome> => {
      if (args.includes("rev-parse")) {
        return opts.head !== undefined ? outcome(`${opts.head}\n`) : outcome("", 128);
      }
      if (args.includes("status")) {
        return outcome(opts.dirty ? " M file.ts\n" : "");
      }
      if (args.includes("rev-list")) {
        return opts.revListCount !== undefined ? outcome(`${opts.revListCount}\n`) : outcome("", 128);
      }
      if (args.includes("diff")) {
        if (opts.diffFails) return outcome("", 128);
        return outcome(opts.changedFiles ? `${opts.changedFiles.join("\n")}\n` : "");
      }
      return outcome("");
    },
  };
}

async function writeGraphFixture(root: string, builtAtCommit: string): Promise<void> {
  await fs.ensureDir(path.join(root, "graphify-out"));
  await fs.writeJson(path.join(root, "graphify-out", "graph.json"), {
    nodes: [{ id: "n1", label: "bootProject", norm_label: "bootproject", source_file: "src/boot.ts" }],
    links: [],
    built_at_commit: builtAtCommit,
  });
  await fs.ensureDir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "boot.ts"), "// fixture\n");
}

describe("queryRelevantFiles", () => {
  it("NOT_AVAILABLE quando graphify-out/graph.json não existe — Store não é tocado", async () => {
    const r = await queryRelevantFiles(ws, { task: "boot" });
    expect(r.status).toBe("NOT_AVAILABLE");
    expect(await fs.pathExists(path.join(ws, ".nexos"))).toBe(false);
  });

  it("FRESH: built_at_commit == HEAD e árvore limpa", async () => {
    await writeGraphFixture(ws, "abc123");
    const r = await queryRelevantFiles(ws, { task: "boot", gitRunner: fakeGit({ head: "abc123", dirty: false, revListCount: 0 }) });
    expect(r.status).toBe("FRESH");
    if (r.status === "FRESH" || r.status === "STALE") {
      expect(r.built_at_commit).toBe("abc123");
      expect(r.current_head).toBe("abc123");
      expect(r.summary.graph_age).toBe(0);
      expect(r.items[0]?.path).toBe("src/boot.ts");
    }
  });

  it("STALE: HEAD divergiu do built_at_commit E o conteúdo mudou (sem manifest.json), marcado sem esconder candidatos", async () => {
    await writeGraphFixture(ws, "old111");
    // sem manifest.json: qualquer arquivo indexável que o diff aponte é
    // "não visto por graphify" — mismatch, mantém STALE (ver frescor por conteúdo).
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "new222", dirty: false, revListCount: 79, changedFiles: ["src/boot.ts"] }),
    });
    expect(r.status).toBe("STALE");
    if (r.status === "STALE") {
      expect(r.summary.graph_age).toBe(79);
      expect(r.items.length).toBeGreaterThan(0); // STALE ainda retorna candidatos
    }
  });

  it("FRESH: HEAD divergiu do built_at_commit mas nenhum arquivo mudou de conteúdo (diff vazio) — commit sozinho não é STALE", async () => {
    await writeGraphFixture(ws, "old111");
    const r = await queryRelevantFiles(ws, { task: "boot", gitRunner: fakeGit({ head: "new222", dirty: false, revListCount: 79 }) });
    expect(r.status).toBe("FRESH");
  });

  it("FRESH: commit só de topologia preservada — manifest.json com mtime atual do arquivo reconcilia o STALE por commit", async () => {
    await writeGraphFixture(ws, "old111");
    const bootPath = path.join(ws, "src", "boot.ts");
    await fs.writeFile(bootPath, "// fixture editada, só comentário\n");
    const diskMtime = (await fs.stat(bootPath)).mtimeMs / 1000;
    await fs.writeJson(path.join(ws, "graphify-out", "manifest.json"), {
      "src/boot.ts": { mtime: diskMtime, seen: diskMtime, ast_hash: "x", semantic_hash: "" },
    });
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "new222", dirty: false, revListCount: 1, changedFiles: ["src/boot.ts"] }),
    });
    expect(r.status).toBe("FRESH");
  });

  it("STALE: edição sem graphify update — mtime em disco diverge do manifest.json", async () => {
    await writeGraphFixture(ws, "old111");
    const bootPath = path.join(ws, "src", "boot.ts");
    await fs.writeFile(bootPath, "// editado depois do graphify update\n");
    await fs.writeJson(path.join(ws, "graphify-out", "manifest.json"), {
      // mtime velho — graphify nunca viu esta edição
      "src/boot.ts": { mtime: 1, seen: 1, ast_hash: "x", semantic_hash: "" },
    });
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "new222", dirty: false, revListCount: 1, changedFiles: ["src/boot.ts"] }),
    });
    expect(r.status).toBe("STALE");
  });

  it("A3.3 · STALE: item cujo arquivo mudou desde built_at_commit vem marcado changed_since_built=true; nenhum candidato inexistente", async () => {
    await writeGraphFixture(ws, "old111");
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "new222", dirty: false, revListCount: 3, changedFiles: ["src/boot.ts"] }),
    });
    expect(r.status).toBe("STALE");
    if (r.status !== "STALE") return;
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]?.changed_since_built).toBe(true);
    expect(r.items.every((i) => i.exists)).toBe(true); // fixture não deleta nada — 0 candidato inexistente
  });

  it("A3.3 · diff não resolvível vira UNKNOWN, nunca false por omissão", async () => {
    await writeGraphFixture(ws, "old111");
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "new222", dirty: false, revListCount: 3, diffFails: true }),
    });
    if (r.status === "STALE") expect(r.items[0]?.changed_since_built).toBe("UNKNOWN");
  });

  it("A3.3 · G3.3: token igual ao nome do projeto (manifest.project.name) não pontua sozinho", async () => {
    await fs.ensureDir(path.join(ws, "graphify-out"));
    await fs.writeJson(path.join(ws, "graphify-out", "graph.json"), {
      nodes: [{ id: "n1", label: "AcmeWidgetsRunner", norm_label: "acmewidgetsrunner", source_file: "src/acme-widgets-runner.ts", file_type: "code" }],
      links: [],
      built_at_commit: "abc123",
    });
    await fs.ensureDir(path.join(ws, "src"));
    await fs.writeFile(path.join(ws, "src", "acme-widgets-runner.ts"), "// fixture\n");
    await fs.ensureDir(forProject(ws).capsuleDir());
    await fs.writeFile(
      forProject(ws).manifest(),
      "schema_version: 1\nproject:\n  id: prj_01J8ZQ9WXYZABCDEFGHJKMNPQR\n  name: acme-widgets\ncapsule:\n  format_version: 1\n"
    );
    const r = await queryRelevantFiles(ws, {
      task: "preciso entender o acme",
      gitRunner: fakeGit({ head: "abc123", dirty: false, revListCount: 0 }),
    });
    expect(r.status).toBe("FRESH");
    if (r.status === "FRESH" || r.status === "STALE") expect(r.items).toEqual([]);
  });

  it("STALE: árvore suja com mudança de conteúdo real (mesmo commit)", async () => {
    await writeGraphFixture(ws, "abc123");
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "abc123", dirty: true, changedFiles: ["src/boot.ts"] }),
    });
    expect(r.status).toBe("STALE");
  });

  it("FRESH: git status suja mas diff de conteúdo vazio (ex.: só arquivo untracked) — dirty sozinho não é STALE", async () => {
    await writeGraphFixture(ws, "abc123");
    const r = await queryRelevantFiles(ws, { task: "boot", gitRunner: fakeGit({ head: "abc123", dirty: true }) });
    expect(r.status).toBe("FRESH");
  });

  it("graph_age UNKNOWN quando o git não resolve o intervalo — nunca inventa número", async () => {
    await writeGraphFixture(ws, "unreachable999");
    const r = await queryRelevantFiles(ws, {
      task: "boot",
      gitRunner: fakeGit({ head: "new222", dirty: false, changedFiles: ["src/boot.ts"] }),
    });
    expect(r.status).toBe("STALE");
    if (r.status === "STALE") expect(r.summary.graph_age).toBe("UNKNOWN");
  });

  it("MALFORMED quando o artefato existe mas não tem o formato esperado", async () => {
    await fs.ensureDir(path.join(ws, "graphify-out"));
    await fs.writeJson(path.join(ws, "graphify-out", "graph.json"), { foo: "bar" });
    const r = await queryRelevantFiles(ws, { task: "boot" });
    expect(r.status).toBe("MALFORMED");
  });
});
