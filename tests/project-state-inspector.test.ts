/**
 * PROJECT BOOTSTRAP + RECONCILIATION V1 — fatia 1: contrafactuais do inspetor.
 *
 * Cada teste é um dos oito CF do node. Fixtures em `/tmp` com `HOME` isolado
 * (CF-7) — nunca no Store real do repo nem em `~/.nexos`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { bootstrapLocator } from "../src/lib/project-resolver.js";
import { newProjectId } from "../src/lib/capsule/ids.js";

/**
 * Ganchos de mutação injetados no MEIO da observação — não antes, não depois.
 * `inspectProjectNexOSState` chama `resolveProject()` (T0) e só então, dentro
 * de `observeCapsule`, chama `classifyCapsule()`/`classifyForReconciliation()`
 * (T1). Os dois mocks abaixo delegam ao módulo real em TODO teste que não seta
 * o gancho correspondente — só os CF de TOCTOU (CF-11/CF-12) os usam. Cada
 * gancho se autoconsome (`= undefined`) no instante em que a primitiva
 * mockada é chamada, então nunca vaza para o próximo teste.
 */
let onClassifyCapsule: (() => Promise<void>) | undefined;
let onClassifyForReconciliation: (() => Promise<void>) | undefined;

vi.mock("../src/lib/capsule/initializer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capsule/initializer.js")>();
  return {
    ...actual,
    classifyCapsule: async (rootPath: string) => {
      const hook = onClassifyCapsule;
      onClassifyCapsule = undefined;
      // Muta ANTES de delegar: CF-11 precisa que a releitura real veja o
      // disco já alterado — é essa releitura que decide `state` E `projectId`
      // juntos, o ponto inteiro do fix.
      if (hook) await hook();
      return actual.classifyCapsule(rootPath);
    },
  };
});

vi.mock("../src/lib/capsule/migration-classifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capsule/migration-classifier.js")>();
  return {
    ...actual,
    classifyForReconciliation: async (rootPath: string) => {
      const result = await actual.classifyForReconciliation(rootPath);
      const hook = onClassifyForReconciliation;
      onClassifyForReconciliation = undefined;
      // Muta DEPOIS da listagem real (que já viu `hasCanonical: true`), ANTES
      // de devolver — reproduz a janela entre `classifyForReconciliation` e
      // `readManifestProjectId` que CF-12 precisa (manifest visto na listagem,
      // sumido na hora de abrir o arquivo).
      if (hook) await hook();
      return result;
    },
  };
});

const { initializeCapsule, initializeGlobalRoot } = await import("../src/lib/capsule/initializer.js");
const { inspectProjectNexOSState, resolveCanonicalNow } = await import(
  "../src/lib/project-state-inspector.js"
);

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

/**
 * `HOME` isolado por teste — o inspetor não lê `HOME` hoje, mas as primitivas
 * que compõe (`resolveProject` em diante) já foram medidas vazando `$HOME`
 * como fallback de identidade (P0 fechado nesta branch). Isolar aqui é a
 * mesma cautela, sem depender de nenhum caminho continuar sem ler `HOME`.
 */
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "pnsi-"));
  const fakeHome = path.join(ws, "__home__");
  await fs.ensureDir(fakeHome);
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  // Rede de segurança: se um teste setar um gancho e falhar antes de disparar
  // a primitiva mockada, ele não sobrevive para o próximo teste.
  onClassifyCapsule = undefined;
  onClassifyForReconciliation = undefined;
  await fs.remove(ws);
});

async function mkGitProject(name: string): Promise<string> {
  const root = path.join(ws, name);
  await fs.ensureDir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** Snapshot conteúdo+mtime da árvore — prova de "nada foi escrito" (CF-8). */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const buf = await fs.readFile(full);
        const st = await fs.stat(full);
        out.set(rel, `${crypto.createHash("sha256").update(buf).digest("hex")}:${st.mtimeMs}`);
      }
    }
  }
  await walk(dir);
  return out;
}

describe("inspectProjectNexOSState", () => {
  it("CF-1 CANONICAL — capsule via nexos init, id do manifest, identitySource manifest", async () => {
    const root = await mkGitProject("cf1-canonical");
    const { projectId } = await initializeCapsule(root, { projectName: "cf1" });

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("CANONICAL");
    expect(result.projectId).toBe(projectId);
    expect(result.identitySource).toBe("manifest");
    expect(result.rootPath).toBe(root);
  });

  it("CF-2 ABSENT — .git presente, .nexos ausente", async () => {
    const root = await mkGitProject("cf2-absent");

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("ABSENT");
    expect(result.rootPath).toBe(root);
  });

  it("CF-3 LEGACY_RECONCILABLE — .nexos só com entradas toleradas", async () => {
    const root = await mkGitProject("cf3-legacy-reconcilable");
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(root, ".nexos", "memory", "project", "state.md"), "# legado\n");

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("LEGACY_RECONCILABLE");
    expect(result.conflicting).toBeUndefined();
  });

  it("CF-4 LEGACY_CONFLICTING — entrada desconhecida, lista exata de conflitos", async () => {
    const root = await mkGitProject("cf4-legacy-conflicting");
    await fs.ensureDir(path.join(root, ".nexos", "backups"));
    await fs.writeFile(path.join(root, ".nexos", "audita-prototipo.mjs"), "// legado\n");

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("LEGACY_CONFLICTING");
    expect(result.conflicting).toEqual(["audita-prototipo.mjs", "backups"]);
  });

  it("CF-5 INVALID — manifest presente com YAML corrompido", async () => {
    const root = await mkGitProject("cf5-invalid");
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(
      path.join(root, ".nexos", "manifest.yaml"),
      "schema_version: 1\nproject:\n  id: [unterminated\n"
    );

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("INVALID");
    expect(result.rootPath).toBe(root);
    expect(result.identitySource).toBe("bootstrap");
    expect(result.reason).toMatch(/manifest/i);
  });

  it("CF-6 NO_PROJECT — diretório vazio, sem git, sem marker", async () => {
    const root = path.join(ws, "cf6-no-project");
    await fs.ensureDir(root);

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("NO_PROJECT");
    expect(result.rootPath).toBe(root);
    // PROJECT UNKNOWN -> ZERO PROJECT CONTEXT: sem projeto, sem identidade.
    expect(result.projectId).toBeUndefined();
  });

  it("CF-9 CANONICAL com legado tolerado ao lado — forma real deste repo", async () => {
    // Reproduz a forma medida em produção: capsule canônica de verdade
    // (manifest válido) com `memory/`, `logs/`, `dev-scripts/` tolerados ao
    // lado — a mesma composição de `.nexos/` deste repositório. Prova que a
    // classificação fina (`classifyForReconciliation`) vence a grosseira
    // (`classifyCapsule`) quando as duas discordam.
    const root = await mkGitProject("cf9-canonical-with-legacy");
    const { projectId } = await initializeCapsule(root, { projectName: "cf9" });
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.ensureDir(path.join(root, ".nexos", "logs"));
    await fs.ensureDir(path.join(root, ".nexos", "dev-scripts"));

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("CANONICAL");
    expect(result.projectId).toBe(projectId);
    expect(result.identitySource).toBe("manifest");
  });

  it("CF-7 isolamento — A, depois B, depois A: A não muda e não menciona B", async () => {
    const rootA = await mkGitProject("cf7-a");
    await initializeCapsule(rootA, { projectName: "a" });
    const rootB = await mkGitProject("cf7-b");
    await initializeCapsule(rootB, { projectName: "b" });

    const first = await inspectProjectNexOSState(rootA);
    await inspectProjectNexOSState(rootB);
    const second = await inspectProjectNexOSState(rootA);

    expect(second).toEqual(first);
    expect(first.rootPath).not.toBe(rootB);
    expect(JSON.stringify(first)).not.toContain(rootB);
  });

  it("CF-8 sem escrita — checksum da árvore idêntico antes e depois", async () => {
    const root = await mkGitProject("cf8-no-write");
    await fs.ensureDir(path.join(root, ".nexos", "backups"));
    await fs.writeFile(path.join(root, ".nexos", "audita-prototipo.mjs"), "// legado\n");

    const before = await snapshotTree(root);
    await inspectProjectNexOSState(root);
    const after = await snapshotTree(root);

    expect(after).toEqual(before);
  });

  it("CF-11 mutação entre resolveProject e a releitura — projectId nunca é híbrido T0+T1", async () => {
    // `resolveProject()` (T0) vê `idOriginal`. Antes de `classifyCapsule()`
    // (T1) rodar de fato, o manifest em disco já é outro — `idMutado`. A
    // saída tem de pertencer inteiramente a T1: nem o `state` (que já era
    // CANONICAL antes do fix) nem o `projectId` podem vir de instantes
    // diferentes.
    const root = await mkGitProject("cf11-toctou-swap");
    const { projectId: idOriginal } = await initializeCapsule(root, { projectName: "cf11" });
    const manifestPath = path.join(root, ".nexos", "manifest.yaml");
    const idMutado = newProjectId();

    onClassifyCapsule = async () => {
      const manifest = YAML.parse(await fs.readFile(manifestPath, "utf-8")) as {
        project: { id: string };
      };
      manifest.project.id = idMutado;
      await fs.writeFile(manifestPath, YAML.stringify(manifest, { sortMapEntries: true }));
    };

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("CANONICAL");
    expect(result.projectId).toBe(idMutado);
    expect(result.projectId).not.toBe(idOriginal);
  });

  it("CF-12 canônico que desaparece durante a inspeção — FAIL CLOSED, nunca CANONICAL emprestado", async () => {
    // Mesma forma de CF-9 (legado tolerado ao lado do manifest, força o
    // caminho `classifyForReconciliation`), mas o manifest é removido bem
    // depois de `classifyForReconciliation` já ter visto `hasCanonical: true`
    // na listagem — a janela exata que `readManifestProjectId` cobre dentro
    // de `observeCapsule`. Sem FAIL CLOSED, o resultado seria CANONICAL com
    // identidade emprestada (de T0 ou de bootstrapLocator) para um manifest
    // que não existe mais.
    const root = await mkGitProject("cf12-vanishes-mid-inspection");
    await initializeCapsule(root, { projectName: "cf12" });
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.ensureDir(path.join(root, ".nexos", "logs"));
    await fs.ensureDir(path.join(root, ".nexos", "dev-scripts"));
    const manifestPath = path.join(root, ".nexos", "manifest.yaml");

    onClassifyForReconciliation = async () => {
      await fs.remove(manifestPath);
    };

    const result = await inspectProjectNexOSState(root);

    expect(result.state).toBe("INVALID");
    expect(result.projectId).toBe(bootstrapLocator(root));
    expect(result.identitySource).toBe("bootstrap");
    expect(result.reason).toMatch(/manifest/i);
  });

  it("CF-13 identidade legítima sem regressão — ABSENT e LEGACY_* continuam com bootstrapLocator", async () => {
    const absent = await mkGitProject("cf13-absent");
    const reconciliavel = await mkGitProject("cf13-reconciliavel");
    await fs.ensureDir(path.join(reconciliavel, ".nexos", "memory", "project"));
    const conflitante = await mkGitProject("cf13-conflitante");
    await fs.ensureDir(path.join(conflitante, ".nexos", "backups"));

    const rAbsent = await inspectProjectNexOSState(absent);
    const rReconciliavel = await inspectProjectNexOSState(reconciliavel);
    const rConflitante = await inspectProjectNexOSState(conflitante);

    expect(rAbsent.state).toBe("ABSENT");
    expect(rAbsent.projectId).toBe(bootstrapLocator(absent));
    expect(rAbsent.identitySource).toBe("bootstrap");

    expect(rReconciliavel.state).toBe("LEGACY_RECONCILABLE");
    expect(rReconciliavel.projectId).toBe(bootstrapLocator(reconciliavel));
    expect(rReconciliavel.identitySource).toBe("bootstrap");

    expect(rConflitante.state).toBe("LEGACY_CONFLICTING");
    expect(rConflitante.projectId).toBe(bootstrapLocator(conflitante));
    expect(rConflitante.identitySource).toBe("bootstrap");
  });

  it("CF-14 resolveCanonicalNow sobre manifest scope=global (sem project) — ok:false definido, sem throw", async () => {
    // Regressão do defeito real: `resolveCanonicalNow` (host-memory-check.ts,
    // doctor.ts, verifier-observation.ts) chama `observeCapsule(rootPath)`
    // DIRETO, sem passar por `resolveProject()` — o guard que `readCanonicalProjectId`
    // já tinha para manifest global nunca entra em jogo neste caminho.
    // `~/.nexos` só com o manifest global bootstrado por T4
    // (`initializeGlobalRoot`) é um manifest v1 válido — `classifyCapsule`
    // devolve VALID_TARGET — mas sem `project`, porque scope global nunca tem
    // identidade de projeto (`ManifestSchema.superRefine`). Antes do guard em
    // `observeCapsule`, `capsule.manifest!.project!.id` lançava TypeError em
    // vez de devolver um resultado — exatamente o que `nexos boot`/`doctor`
    // fariam rodando de um subdiretório do HOME sem marcador de projeto.
    const root = await mkGitProject("cf14-global-manifest");
    await initializeGlobalRoot(root);

    const result = await resolveCanonicalNow(root);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/scope="global"/);
      expect(result.reason).toMatch(/sem project/);
    }
  });
});
