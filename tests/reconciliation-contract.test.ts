/**
 * PROJECT BOOTSTRAP + RECONCILIATION V1 — fatia 2: os contrafactuais do
 * contrato de reconciliação (CF-R1..CF-R7).
 *
 * CF-R8 (EXÉRCITO real intocado) não mora aqui — depende de uma árvore fora
 * do repo (`~/ProjetoExercicitoDeUmHomemSo`), que não existe em CI nem na
 * máquina de outro operador. Foi provado manualmente contra a cópia em
 * `/tmp/exercito-copia` e `/tmp/exercito-reconciliable`, com checksum
 * agregado do original antes/depois — ver relatório da fatia.
 *
 * Os sete daqui são self-contained sob `os.tmpdir()`, mesmo padrão de C12.4
 * (`migration-classifier.test.ts`).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  classifyForReconciliation,
  initializeForReconciliation,
} from "../src/lib/capsule/migration-classifier.js";
import { inspectProjectNexOSState } from "../src/lib/project-state-inspector.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { forProject } from "../src/lib/capsule/paths.js";

const REPO = path.resolve(__dirname, "..");

async function arvore(entradas: string[]): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-cfr-"));
  for (const e of entradas) {
    if (e.endsWith(".yaml") || e.endsWith(".gitignore")) await fs.outputFile(path.join(tmp, ".nexos", e), "x");
    else await fs.ensureDir(path.join(tmp, ".nexos", e));
  }
  return tmp;
}

/** Hash agregado por CONTEÚDO de arquivo — diretório vazio não pesa, de propósito. */
async function hashTree(dir: string): Promise<string> {
  const h = createHash("sha256");
  async function walk(d: string): Promise<void> {
    const entradas = (await fs.readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const e of entradas) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else h.update(path.relative(dir, full)).update(await fs.readFile(full));
    }
  }
  await walk(dir);
  return h.digest("hex");
}

/**
 * `inspectProjectNexOSState` só olha para `.nexos` quando `resolveProject`
 * consegue estabelecer um root (git, marker ou manifest) — sem isso o
 * resultado é `NO_PROJECT` por design (C2.1), não `LEGACY_RECONCILABLE`. Um
 * `.git` vazio é a evidência mais barata; mesmo padrão de
 * `project-state-inspector.test.ts` (`mkGitProject`).
 */
async function arvoreComGit(entradas: string[]): Promise<string> {
  const root = await arvore(entradas);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CF-R1 · LEGACY_RECONCILABLE migra para CANONICAL", () => {
  it("inspectProjectNexOSState confirma CANONICAL depois da reconciliação", async () => {
    const root = await arvoreComGit(["memory", "logs", "dev-scripts"]);
    expect((await inspectProjectNexOSState(root)).state).toBe("LEGACY_RECONCILABLE");

    await initializeForReconciliation(root, { projectName: "cf-r1" });

    const depois = await inspectProjectNexOSState(root);
    expect(depois.state).toBe("CANONICAL");
    expect(depois.identitySource).toBe("manifest");
    await fs.remove(root);
  });
});

describe("CF-R2 · LEGACY_CONFLICTING bloqueia com a lista exata", () => {
  it("nada escrito, nada movido — árvore byte-idêntica antes/depois", async () => {
    const root = await arvore(["memory", "logs", "mystery"]);
    const antes = await hashTree(root);

    const pre = await classifyForReconciliation(root);
    expect(pre.reconcilable).toBe(false);
    expect(pre.conflicting).toEqual(["mystery"]);

    await expect(initializeForReconciliation(root, { projectName: "cf-r2" })).rejects.toThrow(
      /FAIL CLOSED.*mystery/
    );

    expect(await hashTree(root)).toBe(antes);
    await fs.remove(root);
  });
});

describe("CF-R3 · rollback de migração parcial", () => {
  it("falha forçada entre criar diretórios e o commit reverte por completo", async () => {
    const root = await arvore(["memory"]);
    await fs.outputFile(path.join(root, ".nexos", "memory", "x.md"), "legado real");
    const antes = await hashTree(root);
    const p = forProject(root);

    const original = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [target] = args;
      if (typeof target === "string" && target === p.manifest()) {
        throw new Error("falha forçada — disco cheio (simulado)");
      }
      return original(...args);
    });

    await expect(initializeForReconciliation(root, { projectName: "cf-r3" })).rejects.toThrow(
      /falha forçada/
    );
    vi.restoreAllMocks();

    // migração parcial revertida — árvore idêntica à original (só o legado)
    expect(await hashTree(root)).toBe(antes);
    expect(await fs.pathExists(p.manifest())).toBe(false);
    expect(await fs.pathExists(p.recordsRoot())).toBe(false);

    // retry converge — a mesma reconciliação completa normalmente depois
    const r2 = await initializeForReconciliation(root, { projectName: "cf-r3" });
    expect(r2.created).toBe(true);
    expect(await fs.pathExists(p.manifest())).toBe(true);
    await fs.remove(root);
  });
});

describe("CF-R4 · kill -9 no meio da migração", () => {
  it("processo morto entre dirs e commit point nunca vira híbrido silencioso", async () => {
    const root = await arvoreComGit(["memory", "logs"]);
    await fs.outputFile(path.join(root, ".nexos", "memory", "x.md"), "legado real");

    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", path.join(REPO, "tests", "fixtures", "reconcile-kill-worker.mts"), root],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
    );

    const ready = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout esperando READY do worker")), 15_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf-8").includes("READY")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    expect(ready).toBe(true);

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const p = forProject(root);
    // manifest NUNCA foi commitado — morto antes do `wx`
    expect(await fs.pathExists(p.manifest())).toBe(false);

    // núcleo de CF-R4: sem manifest.yaml, hasCanonical é FALSO — nunca um
    // híbrido reportado como canônico só porque records/.local existem
    const preflight = await classifyForReconciliation(root);
    expect(preflight.hasCanonical).toBe(false);
    expect(preflight.reconcilable).toBe(true);

    // estado é EXPLICITAMENTE "ainda reconciliável", nunca CANONICAL
    const inspecao = await inspectProjectNexOSState(root);
    expect(inspecao.state).toBe("LEGACY_RECONCILABLE");

    // legado sobrevive intocado
    expect(await fs.readFile(path.join(root, ".nexos", "memory", "x.md"), "utf-8")).toBe("legado real");

    // retomar converge com segurança
    const r2 = await initializeForReconciliation(root, { projectName: "cf-r4-kill" });
    expect(r2.created).toBe(true);
    expect((await inspectProjectNexOSState(root)).state).toBe("CANONICAL");

    await fs.remove(root);
  }, 30_000);
});

describe("CF-R5 · idempotência — segunda chamada é NOOP", () => {
  it("mesmo project_id, manifest byte-idêntico, nenhum record duplicado", async () => {
    const root = await arvore(["memory"]);
    const r1 = await initializeForReconciliation(root, { projectName: "cf-r5" });
    const p = forProject(root);
    const bytesUm = await fs.readFile(p.manifest());
    const arvoreUm = await hashTree(root);

    const r2 = await initializeForReconciliation(root, { projectName: "cf-r5" });

    expect(r2.created).toBe(false);
    expect(r2.projectId).toBe(r1.projectId);
    expect(await fs.readFile(p.manifest())).toEqual(bytesUm);
    expect(await hashTree(root)).toBe(arvoreUm);
    await fs.remove(root);
  });
});

describe("CF-R6 · preservação — todo arquivo desconhecido sobrevive", () => {
  it("nome, tamanho e hash idênticos após a reconciliação", async () => {
    const root = await arvore(["memory", "logs", "dev-scripts"]);
    const arquivos = [
      [".nexos/memory/project/state.md", "estado antigo"],
      [".nexos/memory/project/decisions.md", "decisao antiga"],
      [".nexos/logs/session-01.log", "log de sessao"],
      [".nexos/dev-scripts/tool.mjs", "console.log(1)"],
    ] as const;
    for (const [rel, conteudo] of arquivos) await fs.outputFile(path.join(root, rel), conteudo);

    const antes = new Map<string, { size: number; hash: string }>();
    for (const [rel] of arquivos) {
      const buf = await fs.readFile(path.join(root, rel));
      antes.set(rel, { size: buf.length, hash: createHash("sha256").update(buf).digest("hex") });
    }

    await initializeForReconciliation(root, { projectName: "cf-r6" });

    for (const [rel, meta] of antes) {
      const full = path.join(root, rel);
      expect(await fs.pathExists(full)).toBe(true);
      const buf = await fs.readFile(full);
      expect(buf.length).toBe(meta.size);
      expect(createHash("sha256").update(buf).digest("hex")).toBe(meta.hash);
    }
    await fs.remove(root);
  });
});

describe("CF-R7 · isolamento — o Store reconciliado não vaza outro projeto", () => {
  it("dois projetos reconciliados independentemente têm project_id e Store isolados", async () => {
    const rootA = await arvore(["memory"]);
    const rootB = await arvore(["memory"]);

    const a = await initializeForReconciliation(rootA, { projectName: "isolado-a" });
    const b = await initializeForReconciliation(rootB, { projectName: "isolado-b" });

    expect(a.projectId).not.toBe(b.projectId);

    const leituraA = await readCurrentRecords(rootA);
    const leituraB = await readCurrentRecords(rootB);
    expect(leituraA.ok && leituraA.records).toHaveLength(0);
    expect(leituraB.ok && leituraB.records).toHaveLength(0);

    await fs.remove(rootA);
    await fs.remove(rootB);
  });
});
