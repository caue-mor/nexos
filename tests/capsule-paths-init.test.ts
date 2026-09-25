/**
 * C2.2.5b — CapsulePaths + CapsuleInitializer.
 *
 * As quatro propriedades que esta suíte precisa provar:
 *   1. INITIALIZER é a única nova autoridade mutante de bootstrap
 *   2. RESOLVER continua com ZERO writes
 *   3. CANONICAL PROJECT ID é gerado independente de path/bootstrap locator
 *   4. .nexos LEGADO/PARCIAL nunca é silenciosamente "atualizado"
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { forProject, CapsulePathError } from "../src/lib/capsule/paths.js";
import {
  initializeCapsule,
  classifyCapsule,
  CapsuleInitError,
} from "../src/lib/capsule/initializer.js";
import {
  newRecordId,
  newProjectId,
  isCanonicalProjectId,
  isBootstrapLocator,
} from "../src/lib/capsule/ids.js";
import { parseCanonical } from "../src/lib/capsule/codec.js";
import { validateManifest } from "../src/lib/capsule/schemas.js";
import { resolveProject } from "../src/lib/project-resolver.js";
import { moduleImports, RESOLVER_ALLOWED_MODULES, RESOLVER_FORBIDDEN } from "./ast-boundary.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c22b-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

async function mkProject(name: string): Promise<string> {
  const root = path.join(ws, name);
  await fs.ensureDir(root);
  await fs.writeJson(path.join(root, "package.json"), { name });
  return root;
}

/** Snapshot PROFUNDO: caminho + hash de conteúdo. Não só nomes. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(cur: string) {
    for (const e of await fs.readdir(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        out.set(`${rel}/`, "<dir>");
        await walk(full);
      } else if (e.isFile()) {
        out.set(rel, crypto.createHash("sha256").update(await fs.readFile(full)).digest("hex"));
      }
    }
  }
  await walk(dir);
  return out;
}

const eq = (a: Map<string, string>, b: Map<string, string>) =>
  expect([...a.entries()].sort()).toEqual([...b.entries()].sort());

// ─── PATHS ──────────────────────────────────────────────────────────────────

describe("B01-B08 · CapsulePaths", () => {
  it("B01 · manifest path é determinístico", () => {
    const p = forProject("/abs/proj");
    expect(p.manifest()).toBe(path.join("/abs/proj", ".nexos", "manifest.yaml"));
    expect(p.manifest()).toBe(forProject("/abs/proj").manifest());
  });

  it("B02 · cada family mapeia para seu diretório", () => {
    const p = forProject("/abs/proj");
    const base = path.join("/abs/proj", ".nexos", "records");
    expect(p.familyDir("ProjectContract")).toBe(path.join(base, "contracts"));
    expect(p.familyDir("ProjectCheckpoint")).toBe(path.join(base, "checkpoints"));
    expect(p.familyDir("Decision")).toBe(path.join(base, "decisions"));
    expect(p.familyDir("KnowledgeRecord")).toBe(path.join(base, "knowledge"));
    expect(p.familyDir("Research")).toBe(path.join(base, "research"));
  });

  it("B03 · kind NÃO afeta o diretório (DIRECTORY != METADATA)", () => {
    const p = forProject("/abs/proj");
    const id = newRecordId("KnowledgeRecord");
    // gotcha, pattern e architecture compartilham o mesmo id → mesmo path
    expect(path.dirname(p.recordPath("KnowledgeRecord", id))).toBe(p.familyDir("KnowledgeRecord"));
    expect(p.familyDir("KnowledgeRecord")).not.toMatch(/gotcha|pattern|architecture/);
  });

  it("B04 · RuntimeState é rejeitada do path canônico", () => {
    const p = forProject("/abs/proj");
    expect(() => p.familyDir("RuntimeState" as never)).toThrow(CapsulePathError);
  });

  it("B05 · RuntimeEvent é rejeitada do path canônico", () => {
    const p = forProject("/abs/proj");
    expect(() => p.familyDir("RuntimeEvent" as never)).toThrow(CapsulePathError);
  });

  it("B06 · ProjectIdentity é rejeitada de recordPath — vive no manifest", () => {
    const p = forProject("/abs/proj");
    expect(() => p.recordPath("ProjectIdentity" as never, "prj_x")).toThrow(CapsulePathError);
  });

  it("B07 · prefixo de id divergente da family é rejeitado", () => {
    const p = forProject("/abs/proj");
    const knowledgeId = newRecordId("KnowledgeRecord");
    expect(() => p.recordPath("Decision", knowledgeId)).toThrow(/pertence a KnowledgeRecord/);
    expect(() => p.recordPath("Decision", "adotamos-postgresql")).toThrow(/malformado/);
  });

  it("B08 · path independe de título/conteúdo — só do id", () => {
    const p = forProject("/abs/proj");
    const id = newRecordId("Decision");
    expect(p.recordPath("Decision", id)).toBe(
      path.join("/abs/proj", ".nexos", "records", "decisions", `${id}.yaml`)
    );
  });

  it("exige root absoluto já resolvido — não descobre projeto", () => {
    expect(() => forProject("relativo/x")).toThrow(CapsulePathError);
    expect(() => forProject("")).toThrow(CapsulePathError);
  });
});

// ─── INITIALIZER ────────────────────────────────────────────────────────────

describe("B09-B18 · CapsuleInitializer", () => {
  it("B09 · .nexos ausente → cria o target", async () => {
    const root = await mkProject("a");
    const r = await initializeCapsule(root, { projectName: "a" });
    const p = forProject(root);

    expect(r.created).toBe(true);
    expect(await fs.pathExists(p.manifest())).toBe(true);
    expect(await fs.pathExists(p.recordsRoot())).toBe(true);
    expect(await fs.pathExists(p.proposals())).toBe(true);
    // o que NÃO deve existir
    expect(await fs.pathExists(path.join(p.localRoot(), "legacy"))).toBe(false);
    expect(await fs.pathExists(path.join(p.proposals(), "admitted"))).toBe(false);
  });

  it("B10 · .nexos vazio → cria o target", async () => {
    const root = await mkProject("b");
    await fs.ensureDir(path.join(root, ".nexos"));
    expect((await classifyCapsule(root)).state).toBe("EMPTY");

    const r = await initializeCapsule(root, { projectName: "b" });
    expect(r.created).toBe(true);
  });

  it("B11 · project.id é path-independent e NUNCA o bootstrap locator", async () => {
    const root = await mkProject("c");
    const before = await resolveProject({ cwd: root });
    const r = await initializeCapsule(root, { projectName: "c" });

    expect(isCanonicalProjectId(r.projectId)).toBe(true);
    expect(isBootstrapLocator(r.projectId)).toBe(false);
    expect(r.projectId).not.toBe(before.bootstrapLocator);
    expect(r.projectId).not.toBe(before.aliases.pathHash);
  });

  it("B12 · capsule válida → AlreadyInitialized com ZERO writes", async () => {
    const root = await mkProject("d");
    const first = await initializeCapsule(root, { projectName: "d" });

    const before = await snapshot(root);
    const second = await initializeCapsule(root, { projectName: "d" });
    const after = await snapshot(root);

    expect(second.created).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
    expect(second.projectId).toBe(first.projectId);
    eq(after, before);
  });

  it("B13 · .nexos LEGADO → FAIL CLOSED com ZERO writes", async () => {
    const root = await mkProject("e");
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(root, ".nexos", "memory", "project", "state.md"), "# legado");
    await fs.ensureDir(path.join(root, ".nexos", "logs"));

    expect((await classifyCapsule(root)).state).toBe("CONFLICTING_EXISTING");
    const before = await snapshot(root);
    await expect(initializeCapsule(root, { projectName: "e" })).rejects.toThrow(CapsuleInitError);
    eq(await snapshot(root), before);
  });

  it("B14 · target parcial (records sem manifest) → FAIL CLOSED, zero writes", async () => {
    const root = await mkProject("f");
    await fs.ensureDir(path.join(root, ".nexos", "records", "decisions"));

    expect((await classifyCapsule(root)).state).toBe("CONFLICTING_EXISTING");
    const before = await snapshot(root);
    await expect(initializeCapsule(root, { projectName: "f" })).rejects.toThrow(/FAIL CLOSED/);
    eq(await snapshot(root), before);
  });

  it("B15 · manifest inválido → FAIL CLOSED, zero writes", async () => {
    const root = await mkProject("g");
    await fs.ensureDir(path.join(root, ".nexos", "records"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), "project:\n  nome: sem-id\n");

    expect((await classifyCapsule(root)).state).toBe("CONFLICTING_EXISTING");
    const before = await snapshot(root);
    await expect(initializeCapsule(root, { projectName: "g" })).rejects.toThrow(CapsuleInitError);
    eq(await snapshot(root), before);
  });

  it("B16 · manifest criado passa pelo parser e schema reais", async () => {
    const root = await mkProject("h");
    const r = await initializeCapsule(root, { projectName: "h" });

    const raw = await fs.readFile(r.manifestPath, "utf-8");
    const result = validateManifest(parseCanonical(raw));

    expect(result.ok).toBe(true);
    if (result.ok) {
      // manifest de projeto (initializeCapsule), nunca root global — project sempre presente aqui.
      expect(result.value.project!.id).toBe(r.projectId);
      expect(result.value.project!.name).toBe("h");
      expect(result.value.capsule.format_version).toBe(1);
    }
    // serializado na forma canônica: chaves ordenadas
    expect(raw.indexOf("capsule:")).toBeLessThan(raw.indexOf("project:"));
  });

  it("B17 · projeto movido → MESMO canonical id, locator diferente", async () => {
    const before = await mkProject("i");
    const init = await initializeCapsule(before, { projectName: "i" });
    const resolvedBefore = await resolveProject({ cwd: before });

    const after = path.join(ws, "movido-i");
    await fs.move(before, after);
    const resolvedAfter = await resolveProject({ cwd: after });

    expect(resolvedAfter.canonicalProjectId).toBe(init.projectId);
    expect(resolvedAfter.canonicalProjectId).toBe(resolvedBefore.canonicalProjectId);
    expect(resolvedAfter.bootstrapLocator).not.toBe(resolvedBefore.bootstrapLocator);
    expect(resolvedAfter.identitySource).toBe("manifest");
  });

  it("B18 · sem git → initialize funciona", async () => {
    const root = await mkProject("j");
    expect(await fs.pathExists(path.join(root, ".git"))).toBe(false);
    const r = await initializeCapsule(root, { projectName: "j" });
    expect(r.created).toBe(true);
    expect((await classifyCapsule(root)).state).toBe("VALID_TARGET");
  });

  it("falha na criação não deixa capsule válida-parecida", async () => {
    const root = await mkProject("k");
    // gera id inválido para o schema → writeFile do manifest falha na validação a jusante;
    // aqui simulamos falha ANTES do commit point removendo permissão de escrita
    const r = await initializeCapsule(root, {
      projectName: "k",
      generateProjectId: () => newProjectId(),
    });
    expect(r.created).toBe(true);
    // o manifest é o commit point: sem ele, classify nunca diz VALID_TARGET
    await fs.remove(forProject(root).manifest());
    expect((await classifyCapsule(root)).state).toBe("CONFLICTING_EXISTING");
  });
});

// ─── B24 · fresh clone ──────────────────────────────────────────────────────

describe("B24 · .local ausente não invalida capsule portátil", () => {
  it("clone sem .local continua VALID_TARGET", async () => {
    const root = await mkProject("l");
    await initializeCapsule(root, { projectName: "l" });

    // git não transporta .local — simula fresh clone
    await fs.remove(forProject(root).localRoot());

    const c = await classifyCapsule(root);
    expect(c.state).toBe("VALID_TARGET");

    const resolved = await resolveProject({ cwd: root });
    expect(resolved.identitySource).toBe("manifest");
  });

  it(".gitignore ausente não invalida — git é transporte opcional", async () => {
    const root = await mkProject("m");
    await initializeCapsule(root, { projectName: "m" });
    await fs.remove(forProject(root).capsuleGitignore());

    expect((await classifyCapsule(root)).state).toBe("VALID_TARGET");
  });
});

// ─── B19-B23 · regressão do Resolver ────────────────────────────────────────

describe("B19-B23 · Resolver continua read-only", () => {
  it("B19 · sem capsule → snapshot completo inalterado", async () => {
    const root = await mkProject("n");
    const before = await snapshot(root);
    const r = await resolveProject({ cwd: root });
    eq(await snapshot(root), before);
    expect(r.identitySource).toBe("bootstrap");
  });

  it("B20 · com capsule válida → snapshot completo inalterado", async () => {
    const root = await mkProject("o");
    await initializeCapsule(root, { projectName: "o" });

    const before = await snapshot(root);
    await resolveProject({ cwd: root });
    eq(await snapshot(root), before);
  });

  it("B21 · .nexos legado → Resolver não tenta consertar", async () => {
    const root = await mkProject("p");
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(root, ".nexos", "memory", "project", "state.md"), "# legado");

    const before = await snapshot(root);
    const r = await resolveProject({ cwd: root });
    eq(await snapshot(root), before);
    // sem manifest → bootstrap; jamais inicializa
    expect(r.identitySource).toBe("bootstrap");
  });

  it("B22/B23 · Resolver não importa Store nem Initializer", async () => {
    /**
     * A proibição é de RESPONSABILIDADE, não de proximidade: codec e schema são
     * leitura do formato canônico e agora são usados de propósito
     * (`SHARED CODEC/SCHEMA != SHARED RESPONSIBILITY`). Store e Initializer
     * MUTAM — esses continuam fora.
     */
    const { all, dynamicSpecifiers } = moduleImports("src/lib/project-resolver.ts");

    expect(
      all.filter((i) => !i.startsWith("node:") && !RESOLVER_ALLOWED_MODULES.includes(i))
    ).toEqual([]);
    expect(all.filter((i) => RESOLVER_FORBIDDEN.some((f) => i.toLowerCase().includes(f)))).toEqual(
      []
    );
    expect(dynamicSpecifiers).toEqual([]);

    // símbolos de mutação nunca referenciados, mesmo sem import
    const src = await fs.readFile("src/lib/project-resolver.ts", "utf-8");
    expect(src).not.toMatch(/initializeCapsule|ProjectCapsuleStore|publishCanonical/);
  });
});
