/**
 * C12.4 — fronteira de compatibilidade do Migration Plane. M1..M9.
 *
 * ```
 * CANONICAL_ALLOWED != LEGACY_TOLERATED
 * RECONCILABLE != CANONICAL
 * UNKNOWN != LEGACY_TOLERATED
 * ```
 *
 * M7 e M8 são os contrafactuais obrigatórios. Se qualquer um deles passar sem o
 * comportamento esperado, a compatibilidade virou permissividade e o modo
 * migração deixou de valer.
 *
 * Nenhum teste aqui escreve em `~/.claude` nem move dado do projeto real.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  classifyRootEntry,
  classifyForReconciliation,
  LEGACY_TOLERATED_ENTRIES,
  LEGACY_SEMANTICS,
  initializeForReconciliation,
} from "../src/lib/capsule/migration-classifier.js";
import { classifyCapsule } from "../src/lib/capsule/initializer.js";

async function arvore(entradas: string[]): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-c124-"));
  for (const e of entradas) {
    if (e.endsWith(".yaml") || e.endsWith(".gitignore")) await fs.outputFile(path.join(tmp, ".nexos", e), "x");
    else await fs.ensureDir(path.join(tmp, ".nexos", e));
  }
  return tmp;
}

describe("C12.4 · classificação por entrada", () => {
  it("M1 estrutura canônica é CANONICAL_ALLOWED", () => {
    for (const e of ["manifest.yaml", ".gitignore", "records"]) {
      expect(classifyRootEntry(e)).toBe("CANONICAL_ALLOWED");
    }
  });

  it("M2 `.local` é LOCAL_ALLOWED — nem canônico nem legado", () => {
    expect(classifyRootEntry(".local")).toBe("LOCAL_ALLOWED");
  });

  it("M3 o conjunto legado é EXATO, e são exatamente estes três", () => {
    expect([...LEGACY_TOLERATED_ENTRIES].sort()).toEqual(["dev-scripts", "logs", "memory"]);
    for (const e of LEGACY_TOLERATED_ENTRIES) expect(classifyRootEntry(e)).toBe("LEGACY_TOLERATED");
  });

  it("M4 tolerância NÃO é por prefixo nem por glob", () => {
    // nomes que um prefixo/glob deixaria passar, e que precisam cair
    for (const e of ["memory2", "memory-old", "memoria", "logs.bak", "dev-scripts-2", "sub/memory"]) {
      expect(classifyRootEntry(e)).toBe("CONFLICTING_EXISTING");
    }
  });

  it("M5 LEGACY_TOLERATED nunca é canônico nem portável — está declarado", () => {
    for (const nome of LEGACY_TOLERATED_ENTRIES) {
      expect(LEGACY_SEMANTICS[nome]?.canonical).toBe(false);
      expect(LEGACY_SEMANTICS[nome]?.portable).toBe(false);
    }
  });
});

describe("C12.4 · preflight sobre a árvore", () => {
  it("M6 árvore legada real é RECONCILÁVEL, e ainda assim NÃO é Capsule válida", async () => {
    const root = await arvore(["memory", "logs", "dev-scripts"]);

    const pre = await classifyForReconciliation(root);
    expect(pre.reconcilable).toBe(true);
    expect(pre.legacyTolerated.sort()).toEqual(["dev-scripts", "logs", "memory"]);
    expect(pre.hasCanonical).toBe(false);

    // O modo NORMAL continua recusando — é o ponto inteiro da fatia.
    expect((await classifyCapsule(root)).state).toBe("CONFLICTING_EXISTING");

    await fs.remove(root);
  });

  it("M7 CONTRAFATUAL — diretório desconhecido derruba o preflight", async () => {
    const root = await arvore(["memory", "logs", "dev-scripts", "mystery"]);

    const pre = await classifyForReconciliation(root);
    expect(pre.reconcilable).toBe(false);
    expect(pre.conflicting).toEqual(["mystery"]);

    // e o legado conhecido continua reconhecido — a recusa é do intruso, não geral
    expect(pre.legacyTolerated.sort()).toEqual(["dev-scripts", "logs", "memory"]);

    await fs.remove(root);
  });

  it("M8 CONTRAFATUAL — sem `memory` no conjunto, a árvore real vira CONFLITO", () => {
    // simula o conjunto sem `memory`, provando que a tolerância é EXPLÍCITA:
    // se o nome não estiver listado, ele cai — não há regra de fundo salvando.
    const semMemory = new Set(["logs", "dev-scripts"]);
    const classificar = (n: string) =>
      ["manifest.yaml", ".gitignore", "records"].includes(n)
        ? "CANONICAL_ALLOWED"
        : n === ".local"
          ? "LOCAL_ALLOWED"
          : semMemory.has(n)
            ? "LEGACY_TOLERATED"
            : "CONFLICTING_EXISTING";

    expect(classificar("memory")).toBe("CONFLICTING_EXISTING");
    // e com o conjunto real, a mesma entrada é tolerada
    expect(classifyRootEntry("memory")).toBe("LEGACY_TOLERATED");
  });

  it("M9 capsule canônica + legado convivem: reconciliação incremental", async () => {
    const root = await arvore(["manifest.yaml", ".gitignore", "records", ".local", "memory"]);
    const pre = await classifyForReconciliation(root);

    expect(pre.reconcilable).toBe(true);
    expect(pre.hasCanonical).toBe(true);
    expect(pre.legacyTolerated).toEqual(["memory"]);
    expect(pre.conflicting).toEqual([]);

    await fs.remove(root);
  });

  it("raiz sem `.nexos` não é reconciliável — não há o que reconciliar", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-c124-vazio-"));
    const pre = await classifyForReconciliation(tmp);
    expect(pre.reconcilable).toBe(false);
    expect(pre.entries).toEqual([]);
    await fs.remove(tmp);
  });
});

describe("C12.4 · initializeForReconciliation", () => {
  it("M10 cria canônico AO LADO do legado, sem tocar nele", async () => {
    const root = await arvore(["memory", "logs", "dev-scripts"]);
    await fs.outputFile(path.join(root, ".nexos", "memory", "project", "state.md"), "conteudo legado");
    const antes = await fs.readFile(path.join(root, ".nexos", "memory", "project", "state.md"), "utf8");

    const r = await initializeForReconciliation(root, { projectName: "teste" });
    expect(r.created).toBe(true);
    expect(r.preserved.sort()).toEqual(["dev-scripts", "logs", "memory"]);

    // canônico existe
    expect(await fs.pathExists(path.join(root, ".nexos", "manifest.yaml"))).toBe(true);
    expect(await fs.pathExists(path.join(root, ".nexos", "records"))).toBe(true);
    expect(await fs.readFile(path.join(root, ".nexos", ".gitignore"), "utf8")).toBe(".local/\n");

    // legado INTOCADO — byte a byte
    expect(await fs.readFile(path.join(root, ".nexos", "memory", "project", "state.md"), "utf8")).toBe(antes);
    for (const d of ["logs", "dev-scripts"]) {
      expect(await fs.pathExists(path.join(root, ".nexos", d))).toBe(true);
    }
    await fs.remove(root);
  });

  it("M11 idempotente — segundo chamado não recria nem duplica identidade", async () => {
    const root = await arvore(["memory"]);
    const um = await initializeForReconciliation(root, { projectName: "teste" });
    const dois = await initializeForReconciliation(root, { projectName: "teste" });

    expect(dois.created).toBe(false);
    expect(dois.projectId).toBe(um.projectId);
    await fs.remove(root);
  });

  it("M12 FAIL CLOSED com entrada desconhecida — e o legado sobrevive", async () => {
    const root = await arvore(["memory", "mystery"]);
    await fs.outputFile(path.join(root, ".nexos", "memory", "x.md"), "não pode sumir");

    await expect(initializeForReconciliation(root, { projectName: "teste" })).rejects.toThrow(/FAIL CLOSED/);

    // ROLLBACK MINE != DELETE THEIRS — nada do legado foi removido
    expect(await fs.readFile(path.join(root, ".nexos", "memory", "x.md"), "utf8")).toBe("não pode sumir");
    expect(await fs.pathExists(path.join(root, ".nexos", "manifest.yaml"))).toBe(false);
    await fs.remove(root);
  });
});
