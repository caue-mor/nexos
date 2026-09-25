/**
 * C2.2.5 — aceitação consolidada contra o Storage Contract.
 *
 * NÃO reexecuta os 166 units. Prova EFEITOS CRUZADOS que nenhuma suíte isolada
 * enxerga: transporte real por git, movimentação de diretório, troca de remote,
 * host sem git, e o ciclo proposal → publish → recovery ligando Paths + Codec +
 * Store + Integrity + Resolver.
 *
 * A premissa que esta rodada existe para atacar:
 *   CINCO PEÇAS APROVADAS ISOLADAMENTE != SISTEMA CORRETO
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { resolveProject } from "../src/lib/project-resolver.js";
import {
  initializeCapsule,
  classifyCapsule,
  CapsuleInitError,
} from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { scanIntegrity } from "../src/lib/capsule/integrity.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { resolveCheckpointPresentation } from "../src/lib/capsule/checkpoint.js";
import { inspectGitBoundary } from "../src/lib/capsule/git-boundary.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { isBootstrapLocator, isCanonicalProjectId } from "../src/lib/capsule/ids.js";
import { makeDecision, makeCheckpoint } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
const REPO = path.resolve(__dirname, "..");
let ws: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

async function makeRepo(name: string): Promise<string> {
  const dir = path.join(ws, name);
  await fs.ensureDir(dir);
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.email", "test@nexos.local");
  git(dir, "config", "user.name", "nexos-test");
  git(dir, "config", "core.excludesFile", "/dev/null");
  return dir;
}

/** Commita exatamente o que o git enxerga — inclusive a ausência de dir vazio. */
function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

const sha = (buf: string | Buffer) => createHash("sha256").update(buf).digest("hex");

const withProject = (r: CapsuleRecord, projectId: string): CapsuleRecord =>
  ({ ...r, project_id: projectId }) as CapsuleRecord;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "acc-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

// ─── A · fresh clone ────────────────────────────────────────────────────────

describe("A · transporte por git", () => {
  it("A01 · fresh clone de capsule VAZIA continua válido", async () => {
    const origem = await makeRepo("origem");
    const init = await initializeCapsule(origem, { projectName: "vazio" });
    commitAll(origem, "capsule vazia");

    const clone = path.join(ws, "clone");
    execFileSync("git", ["clone", "-q", origem, clone]);

    /**
     * Git não transporta diretório vazio. Um capsule sem records ainda não tem
     * arquivo nenhum sob records/ — então o clone chega SEM essa árvore.
     * `PHYSICAL EMPTY DIRECTORY != CANONICAL INFORMATION`: exigir a pasta como
     * condição de validade tornaria todo capsule novo inválido ao viajar.
     */
    expect(await fs.pathExists(path.join(clone, ".nexos", "manifest.yaml"))).toBe(true);
    expect(await fs.pathExists(forProject(clone).localRoot())).toBe(false);

    const classificacao = await classifyCapsule(clone);
    expect(classificacao.state).toBe("VALID_TARGET");

    const resolvido = await resolveProject({ cwd: clone });
    expect(resolvido.canonicalProjectId).toBe(init.projectId);
    expect(resolvido.identitySource).toBe("manifest");
  });

  it("A02 · primeiro publish no clone vazio funciona sem re-inicializar", async () => {
    const origem = await makeRepo("origem");
    const init = await initializeCapsule(origem, { projectName: "vazio" });
    commitAll(origem, "capsule vazia");

    const clone = path.join(ws, "clone");
    execFileSync("git", ["clone", "-q", origem, clone]);

    /**
     * `initialize != materialize missing local/runtime dirs after transport`.
     * O capsule já existe; o Store cria os parents de que precisa.
     */
    const rec = withProject(makeDecision(), init.projectId);
    const r = await publishCanonical(clone, rec);

    expect(r.outcome).toBe("CREATED");
    expect(await fs.pathExists(r.canonicalPath)).toBe(true);
    expect((await scanIntegrity(clone)).ok).toBe(true);
  });

  it("A03 · clone COM record canônico preserva verdade e deixa o local para trás", async () => {
    const origem = await makeRepo("origem");
    const init = await initializeCapsule(origem, { projectName: "cheio" });
    const rec = withProject(makeDecision(), init.projectId);
    await publishCanonical(origem, rec);
    commitAll(origem, "com decision");

    const clone = path.join(ws, "clone");
    execFileSync("git", ["clone", "-q", origem, clone]);

    const resolvido = await resolveProject({ cwd: clone });
    expect(resolvido.canonicalProjectId).toBe(init.projectId);

    const scan = await scanIntegrity(clone);
    expect(scan.ok).toBe(true);
    expect(scan.recordsScanned).toBe(1);

    // PORTABLE TRUTH TRAVELS · LOCAL STATE DOES NOT
    expect(await fs.pathExists(forProject(clone).localRoot())).toBe(false);

    /**
     * 03e (regressão do vazamento medido no repo real, commit 571ed08) —
     * `readCurrentRecords`/`resolveCheckpointPresentation` são os DOIS call
     * sites que ganharam cache opt-in (`reader.ts`/`checkpoint.ts`); sem o
     * segundo argumento (opt-in explícito), NENHUM dos dois pode materializar
     * `.nexos/.local/` sobre este MESMO clone — mesmo invariante de
     * `scanIntegrity` acima, agora provado para os dois chamadores que
     * realmente carregam/gravam o cache.
     */
    const semOptIn = await readCurrentRecords(clone);
    expect(semOptIn.ok).toBe(true);
    await resolveCheckpointPresentation(clone);
    expect(await fs.pathExists(forProject(clone).localRoot())).toBe(false);

    expect((await inspectGitBoundary(clone)).state).toBe("HEALTHY");

    /**
     * K · o clone vive em outro realpath, logo com outro pathHash — e o
     * manifest chega byte a byte idêntico. Identidade viaja; alias derivado do
     * caminho é recalculado no destino e não contamina o documento.
     */
    const origemResolvida = await resolveProject({ cwd: origem });
    expect(resolvido.aliases.pathHash).not.toBe(origemResolvida.aliases.pathHash);
    expect(sha(await fs.readFile(forProject(clone).manifest()))).toBe(
      sha(await fs.readFile(forProject(origem).manifest()))
    );
  });
});

// ─── B/K · movimentação ─────────────────────────────────────────────────────

describe("B · identidade sobrevive à movimentação", () => {
  it("A04 · mover o projeto preserva id canônico e NÃO reescreve o manifest", async () => {
    const antes = path.join(ws, "antes");
    await fs.ensureDir(antes);
    const init = await initializeCapsule(antes, { projectName: "movel" });

    const r1 = await resolveProject({ cwd: antes });
    const bytesAntes = await fs.readFile(forProject(antes).manifest());

    const depois = path.join(ws, "depois");
    await fs.move(antes, depois);

    const r2 = await resolveProject({ cwd: depois });
    const bytesDepois = await fs.readFile(forProject(depois).manifest());

    expect(r2.canonicalProjectId).toBe(init.projectId);
    expect(r2.canonicalProjectId).toBe(r1.canonicalProjectId);
    // MOVE → ZERO MANIFEST REWRITE — bytes, não só o id
    expect(sha(bytesDepois)).toBe(sha(bytesAntes));
    // o alias derivado do path muda; a identidade não
    expect(r2.aliases.pathHash).not.toBe(r1.aliases.pathHash);
  });
});

// ─── C · remote não é identidade ────────────────────────────────────────────

describe("C · git remote nunca vira identidade", () => {
  it("A05 · trocar o remote preserva id canônico e bytes do manifest", async () => {
    const root = await makeRepo("comremote");
    const init = await initializeCapsule(root, { projectName: "remoto" });
    git(root, "remote", "add", "origin", "https://example.invalid/a.git");

    const r1 = await resolveProject({ cwd: root });
    const m1 = sha(await fs.readFile(forProject(root).manifest()));
    expect(r1.aliases.gitRemote).toBe("https://example.invalid/a.git");

    git(root, "remote", "set-url", "origin", "https://example.invalid/b.git");

    const r2 = await resolveProject({ cwd: root });
    const m2 = sha(await fs.readFile(forProject(root).manifest()));

    // GIT_REMOTE_AS_IDENTITY = 0 provado por comportamento, não por grep
    expect(r2.canonicalProjectId).toBe(init.projectId);
    expect(r2.canonicalProjectId).toBe(r1.canonicalProjectId);
    expect(m2).toBe(m1);
    // o alias acompanha — e continua sendo só alias
    expect(r2.aliases.gitRemote).toBe("https://example.invalid/b.git");
  });
});

// ─── M · host sem git ───────────────────────────────────────────────────────

describe("M · núcleo opera sem git", () => {
  it("A06 · fluxo completo em processo com PATH sem git", async () => {
    const vazio = path.join(ws, "path-vazio");
    await fs.ensureDir(vazio);
    /**
     * `no-git-flow.mts` chama `initializeCapsule`/`publishCanonical` de
     * verdade — subprocesso real, fora do module runner do Vitest, então o
     * `vi.mock` de `tests/isolate-nexos-home.ts` (que isola `NEXOS_HOME` só
     * DENTRO do processo do Vitest) não alcança aqui. Sem um `HOME` próprio,
     * este teste escrevia `authority.yaml` no `~/.nexos/projects` REAL a
     * cada rodada (MEDIDO em 05/09) — mesmo padrão já usado em
     * `session-init-hook.test.ts` (`env: { HOME: home, ... }`).
     */
    const homeIsolado = path.join(ws, "home-a06");
    await fs.ensureDir(homeIsolado);

    /**
     * Subprocesso: a ausência precisa valer para o processo inteiro. PATH
     * *ausente* não serve — o execvp cai no default do sistema e acha o git.
     */
    const saida = execFileSync(
      process.execPath,
      ["--import", "tsx/esm", path.join(REPO, "tests", "fixtures", "no-git-flow.mts")],
      {
        cwd: REPO,
        encoding: "utf-8",
        env: { ...process.env, PATH: vazio, HOME: homeIsolado },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const r = JSON.parse(saida.trim().split("\n").at(-1)!);
    expect(r.gitAbsent).toBe(true); // premissa
    expect(r.bootstrapWorks).toBe(true);
    expect(r.gitRemoteUndefined).toBe(true);
    expect(r.initializeWorks).toBe(true);
    expect(r.canonicalWorks).toBe(true);
    expect(r.publishWorks).toBe(true);
    expect(r.integrityWorks).toBe(true);
    expect(r.boundaryState).toBe("GIT_UNAVAILABLE");
    expect(r.boundaryApplicable).toBe(false);
    expect(r.boundaryNullMeasurements).toBe(true);
  }, 60_000);
});

// ─── D/E · ciclo de proposal ────────────────────────────────────────────────

describe("D/E · proposal → canônico", () => {
  it("A07 · proposal admitido vira canônico e o proposal some", async () => {
    const root = path.join(ws, "prop");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "prop" });

    const rec = withProject(makeDecision(), init.projectId);
    const proposalPath = path.join(forProject(root).proposals(), `${rec.id}.yaml`);
    await fs.writeFile(proposalPath, serializeCanonical(rec));

    const r = await publishCanonical(root, rec, { proposalPath });

    expect(r.outcome).toBe("CREATED");
    expect(await fs.pathExists(r.canonicalPath)).toBe(true);
    expect(await fs.pathExists(proposalPath)).toBe(false);
  });

  it("A07b · material local rejeitado NÃO vira canônico por presença", async () => {
    const root = path.join(ws, "rej");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "rej" });

    const rec = withProject(makeDecision(), init.projectId);
    const rejeitado = path.join(forProject(root).rejectedProposals(), `${rec.id}.yaml`);
    await fs.writeFile(rejeitado, serializeCanonical(rec));

    // nenhum publish é chamado — presença em .local não promove nada
    const scan = await scanIntegrity(root);
    expect(scan.recordsScanned).toBe(0);
    expect(await fs.pathExists(forProject(root).recordPath("Decision", rec.id))).toBe(false);
    expect(scan.ok).toBe(true);
  });

  it("A08a · E2 · crash ANTES do publish não deixa canônico parcial", async () => {
    const root = path.join(ws, "crash-antes");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "crash-antes" });

    const rec = withProject(makeDecision(), init.projectId);
    const proposalPath = path.join(forProject(root).proposals(), `${rec.id}.yaml`);
    await fs.writeFile(proposalPath, serializeCanonical(rec));

    await expect(
      publishCanonical(root, rec, {
        proposalPath,
        onFault: (p) => {
          if (p === "BEFORE_PUBLISH") throw new Error("queda simulada antes do publish");
        },
      })
    ).rejects.toThrow(/antes do publish/);

    // nenhum canônico — nem completo, nem parcial
    expect(await fs.pathExists(forProject(root).recordPath("Decision", rec.id))).toBe(false);
    expect(await fs.pathExists(proposalPath)).toBe(true);
    const scan = await scanIntegrity(root);
    expect(scan.recordsScanned).toBe(0);
    expect(scan.ok).toBe(true);
  });

  it("A08 · crash APÓS publish converge por retry idempotente", async () => {
    const root = path.join(ws, "crash");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "crash" });

    const rec = withProject(makeDecision(), init.projectId);
    const proposalPath = path.join(forProject(root).proposals(), `${rec.id}.yaml`);
    await fs.writeFile(proposalPath, serializeCanonical(rec));

    await expect(
      publishCanonical(root, rec, {
        proposalPath,
        onFault: (p) => {
          if (p === "AFTER_PUBLISH") throw new Error("queda simulada após publish");
        },
      })
    ).rejects.toThrow(/queda simulada/);

    const canonico = forProject(root).recordPath("Decision", rec.id);
    const bytesApos = await fs.readFile(canonico, "utf-8");
    expect(await fs.pathExists(proposalPath)).toBe(true); // proposal sobrevive

    const retry = await publishCanonical(root, rec, { proposalPath });
    expect(retry.outcome).toBe("ALREADY_PUBLISHED");
    expect(await fs.pathExists(proposalPath)).toBe(false);
    expect(await fs.readFile(canonico, "utf-8")).toBe(bytesApos); // bytes intactos
    expect((await scanIntegrity(root)).ok).toBe(true);
  });
});

// ─── F/G1 · imutabilidade e referência ──────────────────────────────────────

describe("F/G1 · canônico não é sobrescrito e referência quebrada é reportada", () => {
  it("A08c · F · mesmo id com bytes diferentes dá CONFLICT, sem tocar o canônico", async () => {
    const root = path.join(ws, "overwrite");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "ow" });

    const primeiro = withProject(makeDecision(), init.projectId);
    await publishCanonical(root, primeiro);
    const bytesOriginais = await fs.readFile(
      forProject(root).recordPath("Decision", primeiro.id),
      "utf-8"
    );

    // mesmo id, conteúdo diferente — a mudança exigiria novo id + supersedes
    const impostor = {
      ...primeiro,
      content: { ...(primeiro as { content: Record<string, unknown> }).content, title: "outro" },
    } as CapsuleRecord;

    const r = await publishCanonical(root, impostor);
    expect(r.outcome).toBe("CONFLICT");
    expect(r.conflictReason).toMatch(/supersedes/);
    expect(await fs.readFile(r.canonicalPath, "utf-8")).toBe(bytesOriginais);
    expect((await scanIntegrity(root)).ok).toBe(true);
  });

  it("A08d · G1 · remover record REFERENCIADO produz erro explícito de integridade", async () => {
    const root = path.join(ws, "dangling");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "dang" });

    const antigo = withProject(makeDecision(), init.projectId);
    await publishCanonical(root, antigo);
    const novo = withProject(makeDecision({ supersedes: antigo.id }), init.projectId);
    await publishCanonical(root, novo);
    expect((await scanIntegrity(root)).ok).toBe(true);

    await fs.remove(forProject(root).recordPath("Decision", antigo.id));

    const scan = await scanIntegrity(root);
    expect(scan.ok).toBe(false);
    expect(scan.issues.map((i) => i.code)).toContain("DANGLING_SUPERSEDES");
  });
});

// ─── J · divergência ────────────────────────────────────────────────────────

describe("J · divergência integrada", () => {
  it("A09 · chain linear vira um head; fork vira divergência sem virar issue", async () => {
    const root = path.join(ws, "topo");
    await fs.ensureDir(root);
    const init = await initializeCapsule(root, { projectName: "topo" });
    const P = (r: CapsuleRecord) => withProject(r, init.projectId);

    const a = P(makeCheckpoint("A", null));
    await publishCanonical(root, a);
    const b = P(makeCheckpoint("B", a.id));
    await publishCanonical(root, b);

    const linear = await scanIntegrity(root);
    expect(linear.checkpointHeads).toEqual([b.id]);
    expect(linear.divergence).toBe(false);
    expect(linear.ok).toBe(true);

    const c1 = P(makeCheckpoint("C1", b.id));
    const c2 = P(makeCheckpoint("C2", b.id));
    await publishCanonical(root, c1);
    await publishCanonical(root, c2);

    const fork = await scanIntegrity(root);
    expect(fork.divergence).toBe(true);
    expect(fork.checkpointHeads.sort()).toEqual([c1.id, c2.id].sort());
    expect(fork.issues).toEqual([]); // DIVERGENCE != CORRUPTION
    expect(fork.ok).toBe(true);
  });
});

// ─── O · legado ─────────────────────────────────────────────────────────────

describe("O · legado nunca é promovido sozinho", () => {
  it("A10 · .nexos legado/parcial falha FECHADO e permanece intocado", async () => {
    const root = path.join(ws, "legado");
    const legado = path.join(root, ".nexos", "memory", "project");
    await fs.ensureDir(legado);
    await fs.writeFile(path.join(legado, "state.md"), "# estado legado\n");

    const antes = await fs.readFile(path.join(legado, "state.md"), "utf-8");

    expect((await classifyCapsule(root)).state).toBe("CONFLICTING_EXISTING");
    await expect(initializeCapsule(root, { projectName: "legado" })).rejects.toThrow(
      CapsuleInitError
    );

    expect(await fs.readFile(path.join(legado, "state.md"), "utf-8")).toBe(antes);
    expect(await fs.pathExists(path.join(root, ".nexos", "manifest.yaml"))).toBe(false);
    expect(await fs.pathExists(path.join(root, ".nexos", "records"))).toBe(false);
  });
});

// ─── F · manifest V1 real ───────────────────────────────────────────────────

describe("F · Manifest V1 lido com schema real, não extração artesanal", () => {
  async function comManifest(texto: string): Promise<string> {
    const root = path.join(ws, `mf-${Math.abs(hashCode(texto))}`);
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), texto);
    return root;
  }
  function hashCode(s: string): number {
    let h = 0;
    for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
    return h;
  }

  it("A11 · bootstrap locator REJEITADO como manifest.project.id", async () => {
    /**
     * O Initializer gerar `prj_<ULID>` não basta: se o READER aceitar um
     * locator persistido à mão, D7 morre pela porta da frente.
     * `BOOTSTRAP LOCATOR MUST NOT BE VALID AS manifest.project.id`.
     */
    const locator = "prj_a13f52c91d00";
    expect(isBootstrapLocator(locator)).toBe(true);
    expect(isCanonicalProjectId(locator)).toBe(false);

    const root = await comManifest(
      `schema_version: 1\nproject:\n  id: ${locator}\n  name: falso\ncapsule:\n  format_version: 1\n`
    );
    await expect(resolveProject({ cwd: root })).rejects.toThrow(/locator|canônic|canonic|inválid/i);
  });

  it("A12 · schema_version não suportado é REJEITADO, nunca aceito em silêncio", async () => {
    const root = await comManifest(
      `schema_version: 2\nproject:\n  id: prj_01J8ZQ9WXYZABCDEFGHJKMNPQR\n  name: futuro\ncapsule:\n  format_version: 1\n`
    );
    await expect(resolveProject({ cwd: root })).rejects.toThrow(/schema_version|inválid|suport/i);
  });

  it("A13 · capsule.format_version não suportado é REJEITADO", async () => {
    const root = await comManifest(
      `schema_version: 1\nproject:\n  id: prj_01J8ZQ9WXYZABCDEFGHJKMNPQR\n  name: futuro\ncapsule:\n  format_version: 9\n`
    );
    await expect(resolveProject({ cwd: root })).rejects.toThrow(/format_version|inválid|suport/i);
  });

  it("A14 · YAML semanticamente equivalente é aceito, seja qual for a formatação", async () => {
    /**
     * Um leitor por regex de linha entende só o layout que o serializer produz.
     * Flow mapping é o MESMO documento YAML — recusá-lo prova extração
     * artesanal, não validação de schema.
     */
    const id = "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR";
    const root = await comManifest(
      `schema_version: 1\ncapsule: {format_version: 1}\nproject: {id: "${id}", name: 'flow style'}\n`
    );
    const r = await resolveProject({ cwd: root });
    expect(r.canonicalProjectId).toBe(id);
    expect(r.identitySource).toBe("manifest");
  });

  it("A14b · YAML malformado dá erro explícito de manifest inválido", async () => {
    const root = await comManifest("project:\n  id: [nao\n fechado: :\n");
    await expect(resolveProject({ cwd: root })).rejects.toThrow(/manifest/i);
  });
});
