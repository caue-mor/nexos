/**
 * C2.1 — ProjectResolver · testes discriminantes
 *
 * Contrato: .nexos/memory/project/c2-1-contract.md
 *
 * Estes testes provam o CONTRATO EXTERNO. Nenhum importa detalhe interno do
 * resolver além da função pública `resolveProject`. O teste 12 é o mais
 * importante: prova que identidade de projeto é resolvível SEM memória de
 * projeto e SEM memória de host.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveProject, InvalidManifestError, bootstrapLocator } from "../src/lib/project-resolver.js";
import { GLOBAL_ROOT } from "../src/lib/constants.js";
import { moduleImports, RESOLVER_ALLOWED_MODULES, RESOLVER_FORBIDDEN } from "./ast-boundary.js";

// tmpdir real: em macOS /var/folders -> /private/var/folders. Resolver o symlink
// aqui evita que TODO fixture vire acidentalmente um teste de symlink.
const TMP_BASE = fs.realpathSync(os.tmpdir());

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(TMP_BASE, "c21-"));
});

afterEach(async () => {
  await fs.remove(workspace);
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Cria um diretório de projeto. Nada aqui usa o resolver. */
async function mkProject(
  name: string,
  opts: {
    manifest?: string;
    git?: { remote?: string };
    marker?: boolean;
    nested?: string;
  } = {}
): Promise<string> {
  const root = path.join(workspace, name);
  await fs.ensureDir(root);

  if (opts.manifest !== undefined) {
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), opts.manifest);
  }
  if (opts.marker) {
    await fs.writeJson(path.join(root, "package.json"), { name });
  }
  if (opts.git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    if (opts.git.remote) {
      execFileSync("git", ["remote", "add", "origin", opts.git.remote], { cwd: root });
    }
  }
  if (opts.nested) {
    await fs.ensureDir(path.join(root, opts.nested));
  }
  return root;
}

/**
 * Manifest V1 COMPLETO. Antes emitia apenas `version: 1` + `project` — um
 * documento que o ManifestSchema nunca aceitaria. Passava porque o leitor
 * artesanal só extraía `project.id` e ignorava o resto do documento.
 */
function manifestWithId(id: string): string {
  return (
    `schema_version: 1\nproject:\n  id: ${id}\n  name: fixture\n` +
    `capsule:\n  format_version: 1\n`
  );
}

/**
 * Rótulo legível → id canônico determinístico (`prj_` + 26 chars Crockford).
 * Os fixtures usavam `prj_canon_alpha`, que não é canônico nem bootstrap —
 * aceito só porque nada validava o formato.
 */
function canonId(label: string): string {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const digest = crypto.createHash("sha256").update(label).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[digest[i]! % 32];
  return `prj_${out}`;
}

/** Snapshot conteúdo+mtime de uma árvore, para provar "nada foi escrito". */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string) {
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

/** Monta um HOME falso com armadilhas em ~/.claude e memória de projeto. */
async function mkTrapHome(label: string): Promise<string> {
  const home = path.join(workspace, `home-${label}`);
  const claude = path.join(home, ".claude");
  await fs.ensureDir(path.join(claude, "projects", `-trap-${label}`, "memory"));
  await fs.writeFile(
    path.join(claude, "projects", `-trap-${label}`, "memory", "MEMORY.md"),
    `# TRAP ${label}\nproject id: TRAPPED_BY_${label}\n`
  );
  await fs.writeFile(path.join(claude, "CLAUDE.md"), `# TRAP ${label}\n`);
  await fs.writeJson(path.join(claude, "settings.json"), { trap: label });
  await fs.ensureDir(path.join(home, ".nexos", "memory", "project"));
  await fs.writeFile(
    path.join(home, ".nexos", "memory", "project", "state.md"),
    `# TRAP state ${label}\ncanonical id: TRAPPED_BY_${label}\n`
  );
  await fs.writeFile(
    path.join(home, ".nexos", "memory", "project", "gotchas.md"),
    `# TRAP gotchas ${label}\n`
  );
  return home;
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

// ─── 1. capsule na raiz → canonical ID ──────────────────────────────────────

describe("1 · capsule na raiz", () => {
  it("usa o project.id do manifest como identidade canônica", async () => {
    const root = await mkProject("alpha", { manifest: manifestWithId(canonId("alpha")), git: {} });

    const r = await resolveProject({ cwd: root });

    expect(r.canonicalProjectId).toBe(canonId("alpha"));
    expect(r.identitySource).toBe("manifest");
    expect(r.rootSource).toBe("manifest");
    expect(r.rootPath).toBe(root);
    expect(r.manifestPath).toBe(path.join(root, ".nexos", "manifest.yaml"));
  });
});

// ─── 2. cwd aninhado → acha capsule da raiz ─────────────────────────────────

describe("2 · cwd aninhado", () => {
  it("sobe a árvore e resolve para a raiz que tem o manifest", async () => {
    const root = await mkProject("beta", {
      manifest: manifestWithId(canonId("beta")),
      nested: path.join("src", "components", "deep"),
      git: {},
    });
    const deep = path.join(root, "src", "components", "deep");

    const r = await resolveProject({ cwd: deep });

    expect(r.rootPath).toBe(root);
    expect(r.canonicalProjectId).toBe(canonId("beta"));
    expect(r.rootSource).toBe("manifest");
  });

  it("cwd aninhado e cwd na raiz produzem a MESMA resolução", async () => {
    const root = await mkProject("beta2", {
      manifest: manifestWithId(canonId("beta2")),
      nested: "a/b/c",
      git: {},
    });

    const fromRoot = await resolveProject({ cwd: root });
    const fromDeep = await resolveProject({ cwd: path.join(root, "a", "b", "c") });

    expect(fromDeep).toEqual(fromRoot);
  });
});

// ─── 3. projeto sem capsule → bootstrap locator ─────────────────────────────

describe("3 · projeto sem capsule", () => {
  it("cai para bootstrap locator e NÃO inventa canonical ID", async () => {
    const root = await mkProject("gamma", { marker: true });

    const r = await resolveProject({ cwd: root });

    expect(r.identitySource).toBe("bootstrap");
    expect(r.canonicalProjectId).toBeUndefined();
    expect(r.manifestPath).toBeUndefined();
    expect(r.bootstrapLocator).toMatch(/^prj_[0-9a-f]{12}$/);
  });
});

// ─── 4. determinismo ────────────────────────────────────────────────────────

describe("4 · determinismo", () => {
  it("mesma path resolvida 2× produz o mesmo locator", async () => {
    const root = await mkProject("delta", { marker: true });

    const a = await resolveProject({ cwd: root });
    const b = await resolveProject({ cwd: root });

    expect(a.bootstrapLocator).toBe(b.bootstrapLocator);
    expect(a).toEqual(b);
  });
});

// ─── 5 e 6. projeto movido ──────────────────────────────────────────────────

describe("5+6 · projeto movido", () => {
  it("COM manifest: canonical ID sobrevive; pathHash muda", async () => {
    const before = await mkProject("epsilon", { manifest: manifestWithId(canonId("eps")), git: {} });
    const beforeResolution = await resolveProject({ cwd: before });

    const after = path.join(workspace, "moved-epsilon");
    await fs.move(before, after);
    const afterResolution = await resolveProject({ cwd: after });

    // canonical NÃO muda — o manifest viaja junto
    expect(afterResolution.canonicalProjectId).toBe(beforeResolution.canonicalProjectId);
    expect(afterResolution.canonicalProjectId).toBe(canonId("eps"));

    // pathHash / locator MUDAM — dependem do path
    expect(afterResolution.bootstrapLocator).not.toBe(beforeResolution.bootstrapLocator);
    expect(afterResolution.aliases.pathHash).not.toBe(beforeResolution.aliases.pathHash);
  });

  it("SEM manifest: mover o projeto muda a identidade (não há canonical a preservar)", async () => {
    const before = await mkProject("zeta", { marker: true });
    const beforeResolution = await resolveProject({ cwd: before });

    const after = path.join(workspace, "moved-zeta");
    await fs.move(before, after);
    const afterResolution = await resolveProject({ cwd: after });

    expect(afterResolution.bootstrapLocator).not.toBe(beforeResolution.bootstrapLocator);
    expect(afterResolution.canonicalProjectId).toBeUndefined();
  });
});

// ─── 7. projeto sem git ─────────────────────────────────────────────────────

describe("7 · projeto sem git", () => {
  it("resolve normalmente e não expõe gitRemote", async () => {
    const root = await mkProject("eta", { marker: true });
    expect(await fs.pathExists(path.join(root, ".git"))).toBe(false);

    const r = await resolveProject({ cwd: root });

    expect(r.rootPath).toBe(root);
    expect(r.bootstrapLocator).toMatch(/^prj_[0-9a-f]{12}$/);
    expect(r.aliases.gitRemote).toBeUndefined();
    expect(r.rootSource).toBe("project-marker");
  });

  it("sem git e sem marker: NO_PROJECT (rootSource none), ainda determinístico", async () => {
    const root = path.join(workspace, "theta");
    await fs.ensureDir(root);

    const r = await resolveProject({ cwd: root });

    expect(r.rootSource).toBe("none");
    expect(r.rootPath).toBe(root);
    expect(r.bootstrapLocator).toMatch(/^prj_[0-9a-f]{12}$/);
  });
});

// ─── 8. mesmo basename ──────────────────────────────────────────────────────

describe("8 · mesmo basename em paths diferentes", () => {
  it("não colidem", async () => {
    await fs.ensureDir(path.join(workspace, "w1"));
    await fs.ensureDir(path.join(workspace, "w2"));
    const a = path.join(workspace, "w1", "same-name");
    const b = path.join(workspace, "w2", "same-name");
    await fs.ensureDir(a);
    await fs.ensureDir(b);

    const ra = await resolveProject({ cwd: a });
    const rb = await resolveProject({ cwd: b });

    expect(path.basename(ra.rootPath)).toBe(path.basename(rb.rootPath));
    expect(ra.bootstrapLocator).not.toBe(rb.bootstrapLocator);
  });
});

// ─── 9. clones / worktrees — git remote NUNCA é identidade ──────────────────
//
// Correção do contrato (Steve, 12/08): a regra NÃO é "clones nunca compartilham
// identidade" nem "mesmo remote ⇒ mesma identidade". A regra é que o remote não
// participa da decisão. Sem manifest, paths diferentes ⇒ locators diferentes.
// COM o mesmo manifest, clones PODEM compartilhar canonical id — porque o
// manifest afirma explicitamente que são o mesmo projeto lógico.

describe("9 · clones e worktrees", () => {
  const REMOTE = "git@github.com:acme/same-repo.git";

  it("9a · SEM manifest, mesmo remote em paths diferentes → locators DIFERENTES", async () => {
    const a = await mkProject("clone-a", { git: { remote: REMOTE }, marker: true });
    const b = await mkProject("clone-b", { git: { remote: REMOTE }, marker: true });

    const ra = await resolveProject({ cwd: a });
    const rb = await resolveProject({ cwd: b });

    expect(ra.aliases.gitRemote).toBe(REMOTE);
    expect(rb.aliases.gitRemote).toBe(REMOTE);
    expect(ra.bootstrapLocator).not.toBe(rb.bootstrapLocator);
    expect(ra.canonicalProjectId).toBeUndefined();
    expect(rb.canonicalProjectId).toBeUndefined();
  });

  it("9b · COM o mesmo manifest, clones COMPARTILHAM canonical project.id", async () => {
    const shared = manifestWithId(canonId("shared"));
    const a = await mkProject("wt-a", { git: { remote: REMOTE }, manifest: shared });
    const b = await mkProject("wt-b", { git: { remote: REMOTE }, manifest: shared });

    const ra = await resolveProject({ cwd: a });
    const rb = await resolveProject({ cwd: b });

    expect(ra.canonicalProjectId).toBe(canonId("shared"));
    expect(rb.canonicalProjectId).toBe(canonId("shared"));
    // ...e continuam distinguíveis por path
    expect(ra.bootstrapLocator).not.toBe(rb.bootstrapLocator);
  });

  it("9c · remote diferente com MESMO path não altera a identidade", async () => {
    // Prova que o remote não entra no cálculo: dois projetos com o mesmo
    // conteúdo de path relativo mas remotes distintos; e o mesmo projeto com o
    // remote trocado mantém locator idêntico.
    const root = await mkProject("iota", { git: { remote: REMOTE }, marker: true });
    const first = await resolveProject({ cwd: root });

    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/OTHER.git"], {
      cwd: root,
    });
    const second = await resolveProject({ cwd: root });

    expect(second.bootstrapLocator).toBe(first.bootstrapLocator);
    expect(second.aliases.pathHash).toBe(first.aliases.pathHash);
    expect(second.aliases.gitRemote).not.toBe(first.aliases.gitRemote);
  });

  /**
   * P1.3i (B1) — o bug medido: `nexos init` numa pasta vazia (sem `.git`)
   * grava `binding: {kind: explicit, path_hash}`. Um `git init`+commit
   * DEPOIS, no MESMO path, fazia `bindingMatches` comparar `stored.path_hash`
   * contra `computeBinding(..., kind: "git", hasGit: true)` — que, com git
   * presente, sempre prefere `git_root_commit` e nunca gera `path_hash` — a
   * comparação `stored.path_hash === undefined` dava sempre falso.
   * MISMATCH para sempre, mesmo sem NENHUMA mudança de path.
   */
  it("9e · B1 — binding explicit+path_hash continua BOUND após `git init`+commit no MESMO path", async () => {
    const { initializeCapsule } = await import("../src/lib/capsule/initializer.js");
    const root = path.join(workspace, "sem-git-depois-com-git");
    await fs.ensureDir(root);

    const before = await resolveProject({ cwd: root });
    expect(before.rootSource).toBe("none"); // pasta vazia, sem marker nem git — bootstrap

    const { projectId } = await initializeCapsule(root, { projectName: "sem-git-depois-com-git" });
    const afterInit = await resolveProject({ cwd: root });
    expect(afterInit.bindingStatus).toBe("bound");
    expect(afterInit.canonicalProjectId).toBe(projectId);
    // manifest presente na fronteira -> rootSource "manifest" (git/marker só
    // decidem `rootSource` na AUSÊNCIA de manifest — ver `resolveProject`).
    expect(afterInit.rootSource).toBe("manifest");

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "# x\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

    const afterGit = await resolveProject({ cwd: root });
    expect(afterGit.canonicalProjectId).toBe(projectId);
    // O BUG: antes do fix, isto virava "mismatch" só porque `.git` passou a
    // existir — nenhum path mudou, nenhuma decisão humana rodou.
    expect(afterGit.bindingStatus).toBe("bound");
    expect(afterGit.rootSource).toBe("manifest");
  });

  it("9d · git root é usado como root quando não há manifest nem marker", async () => {
    const root = await mkProject("kappa", { git: {}, nested: "src/deep" });

    const r = await resolveProject({ cwd: path.join(root, "src", "deep") });

    expect(r.rootPath).toBe(root);
    expect(r.rootSource).toBe("git-root");
  });
});

// ─── 10. symlink → realpath antes do hash ───────────────────────────────────

describe("10 · symlink", () => {
  it("resolve realpath antes de hashear: link e alvo têm o MESMO locator", async () => {
    const real = await mkProject("lambda", { marker: true });
    const link = path.join(workspace, "lambda-link");
    await fs.symlink(real, link, "dir");

    const viaReal = await resolveProject({ cwd: real });
    const viaLink = await resolveProject({ cwd: link });

    expect(viaLink.realPath).toBe(real);
    expect(viaLink.bootstrapLocator).toBe(viaReal.bootstrapLocator);
    expect(viaLink.aliases.pathHash).toBe(viaReal.aliases.pathHash);
  });
});

// ─── 11. manifest inválido → erro explícito ─────────────────────────────────

describe("11 · manifest inválido", () => {
  const cases: Array<[string, string]> = [
    ["sem bloco project", "version: 1\nname: x\n"],
    ["project sem id", "version: 1\nproject:\n  name: x\n"],
    ["id vazio", "version: 1\nproject:\n  id:\n"],
    ["id só espaços", "version: 1\nproject:\n  id:    \n"],
    ["arquivo vazio", ""],
    ["lixo", "\u0000\u0001 not yaml at all {{{\n"],
  ];

  for (const [label, content] of cases) {
    it(`lança erro explícito: ${label}`, async () => {
      const root = await mkProject(`bad-${label.replace(/\W+/g, "-")}`, { manifest: content, git: {} });

      await expect(resolveProject({ cwd: root })).rejects.toThrow(/manifest/i);
    });
  }

  it("NUNCA faz fallback silencioso para bootstrap quando o manifest é inválido", async () => {
    const root = await mkProject("mu", { manifest: "project:\n  name: no-id\n", marker: true });

    // se houvesse fallback, isto resolveria com identitySource "bootstrap"
    await expect(resolveProject({ cwd: root })).rejects.toThrow();
  });
});

// ─── 12. BOUNDARY — o teste que mais importa ────────────────────────────────
//
// PROJECT IDENTITY must be resolvable
//   without PROJECT MEMORY
//   and without HOST MEMORY

describe("12 · boundary STATIC — o source não pode nem mencionar host/memory", () => {
  const SRC = path.join(process.cwd(), "src", "lib", "project-resolver.ts");

  it("CLAUDE_PATH_DEPENDENCIES = 0", async () => {
    const src = await fs.readFile(SRC, "utf-8");
    const forbidden = [/\.claude\b/i, /claude[/\\]projects/i, /\bCLAUDE_[A-Z_]+/, /CLAUDE\.md/i];
    const hits = forbidden.filter((re) => re.test(src)).map(String);
    expect(hits).toEqual([]);
  });

  it("STATE_MEMORY_READS = 0", async () => {
    const src = await fs.readFile(SRC, "utf-8");
    const forbidden = [
      /state\.md/i,
      /gotchas\.md/i,
      /decisions\.md/i,
      /MEMORY\.md/i,
      /agent-memory/i,
      /auto-memory/i,
    ];
    const hits = forbidden.filter((re) => re.test(src)).map(String);
    expect(hits).toEqual([]);
  });

  it("GIT_REMOTE_AS_IDENTITY = 0 — remote nunca alimenta um hash", async () => {
    const src = await fs.readFile(SRC, "utf-8");
    const hashLines = src
      .split("\n")
      .filter((l) => /createHash|\.update\(/.test(l))
      .filter((l) => /remote/i.test(l));
    expect(hashLines).toEqual([]);
  });

  it("importa node:* + codec/schema — nunca quem muta ou orquestra", () => {
    /**
     * SHARED CODEC/SCHEMA != SHARED RESPONSIBILITY. Ler o formato canônico é a
     * função do Resolver; manter um leitor paralelo produziu divergência real
     * (A11-A14b da aceitação). O que continua proibido é Store/Initializer.
     *
     * Por AST, não regex: o regex anterior não enxergava `import()` dinâmico.
     */
    const { staticSpecifiers, dynamicSpecifiers, all } = moduleImports(SRC);

    const foraDaAllowlist = all.filter(
      (i) => !i.startsWith("node:") && !RESOLVER_ALLOWED_MODULES.includes(i)
    );
    expect(foraDaAllowlist).toEqual([]);

    const proibidos = all.filter((i) =>
      RESOLVER_FORBIDDEN.some((f) => i.toLowerCase().includes(f))
    );
    expect(proibidos).toEqual([]);

    // a porta dos fundos permanece fechada
    expect(dynamicSpecifiers).toEqual([]);
    expect(staticSpecifiers.length).toBeGreaterThan(0); // guarda contra AST vazio
  });
});

describe("12 · boundary DYNAMIC — HOME com armadilhas não altera nem é tocado", () => {
  it("resultado idêntico sob dois HOMEs armadilhados diferentes", async () => {
    const root = await mkProject("nu", { manifest: manifestWithId(canonId("nu")), git: {} });
    const homeA = await mkTrapHome("A");
    const homeB = await mkTrapHome("B");

    const underA = await withHome(homeA, () => resolveProject({ cwd: root }));
    const underB = await withHome(homeB, () => resolveProject({ cwd: root }));
    const underNoHome = await resolveProject({ cwd: root });

    expect(underA).toEqual(underB);
    expect(underA).toEqual(underNoHome);
    expect(underA.canonicalProjectId).toBe(canonId("nu"));
    expect(JSON.stringify(underA)).not.toMatch(/TRAPPED_BY/);
  });

  it("não escreve nada no HOME armadilhado", async () => {
    const root = await mkProject("xi", { marker: true });
    const home = await mkTrapHome("W");

    const before = await snapshotTree(home);
    await withHome(home, () => resolveProject({ cwd: root }));
    const after = await snapshotTree(home);

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("não escreve nada no próprio projeto — resolve() é READ-ONLY", async () => {
    const root = await mkProject("omicron", {
      manifest: manifestWithId(canonId("omicron")),
      marker: true,
      git: {},
    });

    const before = await snapshotTree(root);
    await resolveProject({ cwd: root });
    const after = await snapshotTree(root);

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  // Lacuna encontrada por mutação (M5, 12/08): o snapshot read-only acima usa
  // fixture COM manifest, mas o caminho onde escrever é plausível é o SEM —
  // "resolve() vê que não existe .nexos e cria". Sem esta variante, um resolver
  // que inicializa capsule passaria no snapshot.
  it("não escreve nada no projeto SEM capsule — nem inicializa", async () => {
    const root = await mkProject("pi", { marker: true, git: {} });

    const before = await snapshotTree(root);
    const r = await resolveProject({ cwd: root });
    const after = await snapshotTree(root);

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
    expect(r.identitySource).toBe("bootstrap");
  });

  it("resolver duas vezes não materializa capsule na segunda passada", async () => {
    const root = await mkProject("pi2", { marker: true });

    const first = await resolveProject({ cwd: root });
    const second = await resolveProject({ cwd: root });

    expect(second).toEqual(first);
    expect(second.identitySource).toBe("bootstrap");
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
  });
});

// ─── explicitRoot — precedência de evidência, não de input ──────────────────

describe("explicitRoot", () => {
  it("sem manifest: rootSource é explicit", async () => {
    const root = await mkProject("rho", { marker: true, nested: "src" });

    const r = await resolveProject({ cwd: path.join(root, "src"), explicitRoot: root });

    expect(r.rootPath).toBe(root);
    expect(r.rootSource).toBe("explicit");
  });

  it("com manifest no root explícito: manifest é a evidência mais forte", async () => {
    const root = await mkProject("sigma", { manifest: manifestWithId(canonId("sigma")) });

    const r = await resolveProject({ cwd: workspace, explicitRoot: root });

    expect(r.rootSource).toBe("manifest");
    expect(r.canonicalProjectId).toBe(canonId("sigma"));
  });

  it("explicitRoot inexistente → erro explícito", async () => {
    await expect(
      resolveProject({ cwd: workspace, explicitRoot: path.join(workspace, "nope") })
    ).rejects.toThrow();
  });
});

// ─── review C2.1 · findings do PR #3 ────────────────────────────────────────

describe("13 · parser do manifest — subset suportado ou erro, nunca ID silencioso", () => {
  /**
   * A C2.1 usa deliberadamente um leitor de SUBSET, não um parser YAML completo
   * (o Manifest V1 ainda não existia). A exigência aqui não é entender YAML
   * inteiro — é nunca derivar um id DIFERENTE em silêncio:
   *
   *   SUPPORTED SUBSET    -> parse correctly
   *   UNSUPPORTED YAML    -> explicit error
   *   NEVER               -> silently derive a different ID
   */
  const idCanonico = canonId("r3");

  it("R1 · comentário inline após o id nunca vaza para dentro do ID", async () => {
    const root = await mkProject("r1", {
      manifest:
        `schema_version: 1\nproject:\n  id: ${idCanonico} # comentário\n  name: fixture\n` +
        `capsule:\n  format_version: 1\n`,
      git: {},
    });

    let devolvido: string | undefined;
    try {
      devolvido = (await resolveProject({ cwd: root })).canonicalProjectId;
    } catch {
      return; // rejeitar explicitamente é resposta válida
    }
    // se aceitou, o valor tem de ser o id — nunca o id + comentário
    expect(devolvido).toBe(idCanonico);
    expect(devolvido).not.toMatch(/#|comentário/);
  });

  it("R2 · project.metadata.id NÃO pode virar project.id", async () => {
    const root = await mkProject("r2", {
      manifest:
        `schema_version: 1\nproject:\n  metadata:\n    id: prj_ERRADO_ANINHADO\n  name: fixture\n` +
        `capsule:\n  format_version: 1\n`,
    });

    let devolvido: string | undefined;
    try {
      devolvido = (await resolveProject({ cwd: root })).canonicalProjectId;
    } catch {
      return; // ausência de project.id direto ⇒ erro explícito é o correto
    }
    expect(devolvido).not.toBe("prj_ERRADO_ANINHADO");
  });

  it("R3 · project.id direto continua sendo aceito", async () => {
    const root = await mkProject("r3", { manifest: manifestWithId(idCanonico), git: {} });
    const r = await resolveProject({ cwd: root });
    expect(r.canonicalProjectId).toBe(idCanonico);
    expect(r.identitySource).toBe("manifest");
  });
});

describe("14 · CANNOT OBSERVE != DOES NOT EXIST", () => {
  /**
   * `catch { return false }` transforma qualquer falha de stat em "não existe".
   * Um manifest ilegível por erro operacional faria a identidade cair para
   * bootstrap/ancestral — mudança SILENCIOSA de identidade a partir de uma
   * condição transitória do filesystem.
   *
   * ELOOP em vez de EACCES: determinístico e independente de permissão
   * (root ignora chmod, e o runner de CI pode ser root).
   */
  it("erro de stat diferente de ENOENT falha explicitamente, sem cair para bootstrap", async () => {
    const root = path.join(workspace, "eloop");
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), { name: "eloop" });
    // .nexos aponta para si mesmo -> stat(.nexos/manifest.yaml) = ELOOP
    await fs.symlink(".nexos", path.join(root, ".nexos"));

    await expect(resolveProject({ cwd: root })).rejects.toThrow();
  });

  it("ENOENT continua significando ausência — projeto sem capsule resolve por bootstrap", async () => {
    const root = await mkProject("sem-capsule", { marker: true });
    const r = await resolveProject({ cwd: root });
    expect(r.identitySource).toBe("bootstrap");
  });
});

describe("15 · symlink APONTANDO PARA FILHO abaixo da raiz do projeto", () => {
  /**
   * Diferente do caso "o próprio root é symlink". Aqui o cwd é um atalho para
   * um subdiretório: subir pelo caminho LEXICAL sai do projeto e nunca encontra
   * o manifest. O walk precisa caminhar a árvore FÍSICA.
   */
  it("resolve para a raiz real do projeto, com identidade do manifest", async () => {
    const repo = await mkProject("repo", {
      manifest: manifestWithId(canonId("symlink-filho")),
      nested: "src",
      git: {},
    });
    const atalho = path.join(workspace, "shortcut");
    await fs.symlink(path.join(repo, "src"), atalho);

    const r = await resolveProject({ cwd: atalho });

    expect(r.rootSource).toBe("manifest");
    expect(r.realPath).toBe(await fs.realpath(repo));
    expect(r.identitySource).toBe("manifest");
    expect(r.canonicalProjectId).toBe(canonId("symlink-filho"));
  });
});


// ─── 16. fronteira de repositório aninhado (F1) ─────────────────────────────
//
//   SUBDIRECTORY OF SAME REPO  -> pode herdar Capsule da raiz
//   DISTINCT NESTED GIT REPO   -> nunca herda Capsule do ancestral

describe("16 · fronteira de repositório aninhado", () => {
  it("a · subdiretório do MESMO repo continua resolvendo para a raiz (não pode regredir)", async () => {
    const root = await mkProject("boundary-a", {
      manifest: manifestWithId(canonId("boundary-a")),
      git: {},
      nested: path.join("src", "deep", "path"),
    });

    const r = await resolveProject({ cwd: path.join(root, "src", "deep", "path") });

    expect(r.rootPath).toBe(root);
    expect(r.canonicalProjectId).toBe(canonId("boundary-a"));
  });

  it("b · repo `.git` aninhado NUNCA herda a Capsule do ancestral", async () => {
    const ancestor = await mkProject("boundary-b-ancestor", {
      manifest: manifestWithId(canonId("boundary-b-ancestor")),
      git: {},
    });
    const nestedRoot = path.join(ancestor, "vendor", "nested-repo");
    await fs.ensureDir(nestedRoot);
    execFileSync("git", ["init", "-q"], { cwd: nestedRoot });
    await fs.writeJson(path.join(nestedRoot, "package.json"), { name: "nested-repo" });
    await fs.ensureDir(path.join(nestedRoot, "src", "deep", "path"));

    const atRoot = await resolveProject({ cwd: nestedRoot });
    expect(atRoot.canonicalProjectId).toBeUndefined();
    expect(atRoot.rootPath).toBe(nestedRoot);
    expect(atRoot.rootSource).toBe("git-root");

    const deep = await resolveProject({ cwd: path.join(nestedRoot, "src", "deep", "path") });
    expect(deep.canonicalProjectId).toBeUndefined();
    expect(deep.rootPath).toBe(nestedRoot);
  });

  it("c · `.git` como ARQUIVO (worktree) marca a MESMA fronteira", async () => {
    const ancestor = await mkProject("boundary-c-ancestor", {
      manifest: manifestWithId(canonId("boundary-c-ancestor")),
      git: {},
    });
    const worktreeRoot = path.join(ancestor, "vendor", "worktree-repo");
    await fs.ensureDir(worktreeRoot);
    await fs.writeFile(path.join(worktreeRoot, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    await fs.ensureDir(path.join(worktreeRoot, "src", "deep"));

    const r = await resolveProject({ cwd: path.join(worktreeRoot, "src", "deep") });

    expect(r.canonicalProjectId).toBeUndefined();
    expect(r.rootPath).toBe(worktreeRoot);
    expect(r.rootSource).toBe("git-root");
  });
});

// ─── 17. GLOBAL ROOT != PROJECT ROOT ────────────────────────────────────────
//
// `~/.nexos/manifest.yaml` (scope: global, criado por `nexos init --global`)
// é o manifest da MÁQUINA, não de um projeto. Um diretório novo sob HOME —
// sem capsule, sem `.git`, sem marker — não pode herdar esse manifest como se
// fosse a Capsule de um projeto (mesma regra que `nexos-binding.sh` já aplica
// ao recusar `$HOME` como raiz).
//
// `GLOBAL_ROOT` chega aqui já isolado por `tests/isolate-nexos-home.ts`
// (setupFiles global, reaplicado por arquivo de teste) — nenhum mock extra
// é necessário neste describe.

const GLOBAL_MANIFEST = "capsule:\n  format_version: 1\nschema_version: 1\nscope: global\n";

describe("17 · GLOBAL ROOT != PROJECT ROOT", () => {
  it("diretório novo sob GLOBAL_ROOT, manifest global NO PRÓPRIO root: bootstrap, sem lançar", async () => {
    await fs.ensureDir(path.join(GLOBAL_ROOT, ".nexos"));
    await fs.writeFile(path.join(GLOBAL_ROOT, ".nexos", "manifest.yaml"), GLOBAL_MANIFEST);
    const sub = path.join(GLOBAL_ROOT, "novo-in-root", "sub");
    await fs.ensureDir(sub);

    const r = await resolveProject({ cwd: sub });

    expect(r.rootSource).toBe("none");
    expect(r.identitySource).toBe("bootstrap");
    expect(r.canonicalProjectId).toBeUndefined();
    expect(r.manifestPath).toBeUndefined();
    expect(r.rootPath).toBe(await fs.realpath(sub));
  });

  it("contrafactual: manifest global FORA do GLOBAL_ROOT continua sendo InvalidManifestError", async () => {
    const projectDir = path.join(GLOBAL_ROOT, "novo-nested");
    await fs.ensureDir(path.join(projectDir, ".nexos"));
    await fs.writeFile(path.join(projectDir, ".nexos", "manifest.yaml"), GLOBAL_MANIFEST);
    // P1.1: fronteira (.git/marker) antes de identidade — sem um marcador
    // próprio, `projectDir` nem seria alcançado como fronteira e o manifest
    // nunca chegaria a ser lido. O marker é o que faz este contrafactual
    // continuar exercitando a validação do manifest, não a ausência dela.
    await fs.writeJson(path.join(projectDir, "package.json"), { name: "novo-nested" });
    const sub = path.join(projectDir, "sub");
    await fs.ensureDir(sub);

    await expect(resolveProject({ cwd: sub })).rejects.toThrow(InvalidManifestError);
  });

  it("projeto real sob GLOBAL_ROOT (scope: project) continua resolvendo pelo manifest", async () => {
    const id = canonId("under-global-root");
    const projectDir = path.join(GLOBAL_ROOT, "proj");
    await fs.ensureDir(path.join(projectDir, ".nexos"));
    await fs.writeFile(path.join(projectDir, ".nexos", "manifest.yaml"), manifestWithId(id));
    // P1.1: fronteira antes de identidade — precisa de marker/`.git` próprio.
    await fs.writeJson(path.join(projectDir, "package.json"), { name: "proj" });

    const r = await resolveProject({ cwd: projectDir });

    expect(r.rootSource).toBe("manifest");
    expect(r.identitySource).toBe("manifest");
    expect(r.canonicalProjectId).toBe(id);
  });

  // Regressão: verifier reprovou o fix anterior no host real. `$HOME` (==
  // `GLOBAL_ROOT`) sendo um repo git de dotfiles fixava `gitDir = HOME` para
  // QUALQUER cwd abaixo dele — só `manifestDir` tinha o guard, `gitDir` e
  // `markerDir` não. `GLOBAL_ROOT` precisa ser transparente para as TRÊS
  // categorias de evidência, não só manifest.

  it("`.git` e marker NO PRÓPRIO GLOBAL_ROOT (dotfiles reais): diretório novo abaixo dele ainda resolve cwd-fallback", async () => {
    await fs.ensureDir(path.join(GLOBAL_ROOT, ".git"));
    await fs.writeJson(path.join(GLOBAL_ROOT, "package.json"), { name: "dotfiles" });
    const sub = path.join(GLOBAL_ROOT, "novo", "sub");
    await fs.ensureDir(sub);

    const r = await resolveProject({ cwd: sub });

    const realSub = await fs.realpath(sub);
    expect(r.rootSource).toBe("none");
    expect(r.identitySource).toBe("bootstrap");
    expect(r.canonicalProjectId).toBeUndefined();
    expect(r.rootPath).toBe(realSub);
    expect(r.bootstrapLocator).toBe(bootstrapLocator(realSub));
  });

  it("projeto real sob GLOBAL_ROOT com `.git` PRÓPRIO (sem manifest) resolve git-root nele mesmo, não em GLOBAL_ROOT", async () => {
    const projectDir = path.join(GLOBAL_ROOT, "own-repo-under-global-root");
    await fs.ensureDir(projectDir);
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    await fs.ensureDir(path.join(projectDir, "src", "deep"));

    const r = await resolveProject({ cwd: path.join(projectDir, "src", "deep") });

    expect(r.rootSource).toBe("git-root");
    expect(r.rootPath).toBe(projectDir);
    expect(r.canonicalProjectId).toBeUndefined();
  });
});

// ─── 18. cache de commit raiz (lote resolver — GIT SPAWN CACHING) ───────────
//
// `resolveProject({..., cacheGitFacts: true})` nunca spawna `git` para
// verificar `binding.git_root_commit` quando o SHA do HEAD atual bate com o
// SHA cacheado sob `.nexos/.local/derived/` — provado por um wrapper de PATH
// que grava cada invocação real de `git` num arquivo (NUNCA `NODE_DEBUG`: ele
// imprime `envPairs` inteiro, inclusive credenciais do processo — incidente
// registrado em `knw_01M2QT4S4ZWHRTH7JB9YHFAXZX`).

function manifestWithBinding(id: string, binding: string): string {
  return `${manifestWithId(id)}binding:\n${binding}`;
}

function gitBinding(commit: string): string {
  return `  kind: git\n  git_root_commit: ${commit}\n`;
}

/** Committer/author date FIXOS — `--amend`/`--exec` de rebase só produzem um
 * SHA garantidamente diferente do original se algo no objeto commit mudar;
 * confiar no timestamp "agora" tem granularidade de 1s e pode colidir. */
const REWRITE_ENV = {
  ...process.env,
  GIT_COMMITTER_DATE: "2030-01-01T00:00:00+0000",
  GIT_AUTHOR_DATE: "2030-01-01T00:00:00+0000",
};

async function commitOnce(root: string, message = "init"): Promise<string> {
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), `# ${message}\n`);
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
}

function rootCommitCacheFile(root: string): string {
  return path.join(root, ".nexos", ".local", "derived", "git-root-commit.json");
}

/**
 * Conta spawns REAIS de `git` sem `NODE_DEBUG` (vazava `envPairs` com
 * credenciais — ver cabeçalho da seção 18). Um shim `git` num diretório
 * temporário, na FRENTE do PATH, grava só `argv[1] argv[2]` (comando +
 * primeiro argumento — o bastante pra distinguir `rev-list` de `config`) e
 * repassa pro `git` real via `exec`. Zero variável de ambiente exposta.
 */
async function withGitSpawnCounter<T>(
  fn: () => Promise<T>
): Promise<{ readonly result: T; readonly calls: readonly string[] }> {
  const wrapDir = await fs.mkdtemp(path.join(TMP_BASE, "git-wrap-"));
  const countLogPath = path.join(wrapDir, "calls.log");
  const realGit = execFileSync("/usr/bin/which", ["git"]).toString().trim();
  const gitShimPath = path.join(wrapDir, "git");
  await fs.writeFile(gitShimPath, `#!/bin/sh\necho "$1 $2" >> "${countLogPath}"\nexec "${realGit}" "$@"\n`);
  await fs.chmod(gitShimPath, 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${wrapDir}:${prevPath ?? ""}`;
  try {
    const result = await fn();
    let calls: string[] = [];
    try {
      calls = (await fs.readFile(countLogPath, "utf-8")).split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      calls = [];
    }
    return { result, calls };
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    await fs.remove(wrapDir);
  }
}

describe("18 · cache de commit raiz", () => {
  it("a · cache quente: bound sobrevive a um PATH sem git de verdade (wrapper conta zero spawns)", async () => {
    const root = await mkProject("sigma", { git: {} });
    const commit = await commitOnce(root);
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("sigma"), gitBinding(commit)));

    const cold = await withGitSpawnCounter(() => resolveProject({ cwd: root, cacheGitFacts: true }));
    expect(cold.result.bindingStatus).toBe("bound");
    expect(cold.calls.some((l) => l.startsWith("rev-list"))).toBe(true);
    expect(await fs.pathExists(rootCommitCacheFile(root))).toBe(true);
    const cacheAfterFirst = await fs.readJson(rootCommitCacheFile(root));
    expect(cacheAfterFirst.rootCommit).toBe(commit);
    expect(cacheAfterFirst.headSha).toBe(commit);

    const warm = await withGitSpawnCounter(() => resolveProject({ cwd: root, cacheGitFacts: true }));
    expect(warm.result.bindingStatus).toBe("bound");
    expect(warm.calls).toEqual([]); // HEAD não mudou — zero spawns de qualquer comando git
  });

  it("a2 · HEAD mudou (novo commit) — exatamente 1 rev-list revalida; raiz continua a mesma", async () => {
    const root = await mkProject("sigma2", { git: {} });
    const commit1 = await commitOnce(root, "um");
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("sigma2"), gitBinding(commit1)));

    await resolveProject({ cwd: root, cacheGitFacts: true }); // aquece o cache (frio)

    await commitOnce(root, "dois"); // HEAD anda; a RAIZ continua commit1
    const afterNewCommit = await withGitSpawnCounter(() => resolveProject({ cwd: root, cacheGitFacts: true }));

    expect(afterNewCommit.result.bindingStatus).toBe("bound"); // raiz real ainda é commit1
    expect(afterNewCommit.calls.filter((l) => l.startsWith("rev-list"))).toHaveLength(1);
  });

  it("b · repo trocado no MESMO caminho invalida o cache — BINDING_MISMATCH continua detectado", async () => {
    const root = await mkProject("tau", { git: {} });
    const commitA = await commitOnce(root, "a");
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("tau"), gitBinding(commitA)));

    const first = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(first.bindingStatus).toBe("bound");
    const cacheAfterFirst = await fs.readJson(rootCommitCacheFile(root));
    expect(cacheAfterFirst.rootCommit).toBe(commitA);

    // cache quente comprovado (mesma técnica do teste a) antes de trocar o repo.
    const warm = await withGitSpawnCounter(() => resolveProject({ cwd: root, cacheGitFacts: true }));
    expect(warm.result.bindingStatus).toBe("bound");
    expect(warm.calls).toEqual([]);

    // "outro repo no mesmo caminho": .git recriado (dev+ino mudam, e o SHA de
    // HEAD é de outra história inteira — não precisa nem olhar inode).
    await fs.remove(path.join(root, ".git"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const commitB = await commitOnce(root, "b");
    expect(commitB).not.toBe(commitA);

    // manifest continua declarando commitA — o resolver precisa perceber que
    // o repo ATUAL (commitB) diverge, não confiar no cache de commitA.
    const third = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(third.bindingStatus).toBe("mismatch");
    const cacheAfterSwap = await fs.readJson(rootCommitCacheFile(root));
    expect(cacheAfterSwap.rootCommit).toBe(commitB);
  });

  it("c · repo sem commits: nada é cacheado até o primeiro commit existir", async () => {
    const root = await mkProject("upsilon", { git: {} });
    await fs.ensureDir(path.join(root, ".nexos"));
    const fakeRoot = "fake".repeat(10); // 40 chars, não-numérico — YAML não coage p/ número
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("upsilon"), gitBinding(fakeRoot)));

    const beforeCommit = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(beforeCommit.bindingStatus).toBe("mismatch"); // HEAD órfão -> current undefined != fakeRoot
    expect(await fs.pathExists(rootCommitCacheFile(root))).toBe(false);

    const realCommit = await commitOnce(root);
    const afterCommit = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(afterCommit.bindingStatus).toBe("mismatch"); // manifest ainda declara o valor fake
    const cache = await fs.readJson(rootCommitCacheFile(root));
    expect(cache.rootCommit).toBe(realCommit); // mas o cache já reflete o commit REAL
    expect(cache.headSha).toBe(realCommit);
  });

  it("d · worktree com `.git` arquivo: bound + cache quente + remote via commondir", async () => {
    const main = await mkProject("phi-main", { git: { remote: "https://example.com/phi.git" } });
    const commit = await commitOnce(main);
    const worktreeRoot = path.join(workspace, "phi-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "phi-wt-branch", worktreeRoot], { cwd: main });
    await fs.ensureDir(path.join(worktreeRoot, ".nexos"));
    await fs.writeFile(
      path.join(worktreeRoot, ".nexos", "manifest.yaml"),
      manifestWithBinding(canonId("phi-worktree"), gitBinding(commit))
    );

    const first = await resolveProject({ cwd: worktreeRoot, cacheGitFacts: true });
    expect(first.bindingStatus).toBe("bound");
    expect(first.aliases.gitRemote).toBe("https://example.com/phi.git");

    const expectedRemote = execFileSync("git", ["-C", worktreeRoot, "config", "--get", "remote.origin.url"])
      .toString()
      .trim();
    expect(first.aliases.gitRemote).toBe(expectedRemote);

    const warm = await withGitSpawnCounter(() => resolveProject({ cwd: worktreeRoot, cacheGitFacts: true }));
    expect(warm.result.bindingStatus).toBe("bound");
    expect(warm.calls).toEqual([]);
  });

  /**
   * DEFEITO 1 (reprovação do verifier, reprodução direta): a assinatura
   * `dev`+`ino` de `.git` NÃO muda quando a raiz é reescrita por `--amend`
   * ou `rebase --root` — só o SHA de HEAD muda, e é nele que o cache agora
   * se ancora.
   */
  it("e · DEFEITO 1: `git commit --amend` na raiz reescreve o commit sem tocar `.git` — MISMATCH", async () => {
    const root = await mkProject("chi-amend", { git: {} });
    const commitA = await commitOnce(root, "raiz");
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("chi-amend"), gitBinding(commitA)));

    const first = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(first.bindingStatus).toBe("bound");

    execFileSync("git", ["commit", "--amend", "--no-edit", "-q"], { cwd: root, env: REWRITE_ENV });
    const commitB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    expect(commitB).not.toBe(commitA); // amend muda o SHA; `.git` continua o MESMO diretório

    const second = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(second.bindingStatus).toBe("mismatch"); // manifest ainda diz commitA; raiz real agora é commitB
    const cache = await fs.readJson(rootCommitCacheFile(root));
    expect(cache.rootCommit).toBe(commitB);
    expect(cache.headSha).toBe(commitB);
  });

  it("f · DEFEITO 1: `git rebase --root` reescreve a raiz sem recriar `.git` — MISMATCH", async () => {
    const root = await mkProject("chi-rebase", { git: {} });
    const commitA = await commitOnce(root, "raiz");
    await commitOnce(root, "filho");
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("chi-rebase"), gitBinding(commitA)));

    const first = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(first.bindingStatus).toBe("bound"); // raiz ainda é commitA — o 2º commit não mexeu nela

    execFileSync("git", ["rebase", "--root", "-x", "git commit --amend --no-edit -q"], {
      cwd: root,
      env: { ...REWRITE_ENV, GIT_SEQUENCE_EDITOR: "true" },
    });
    const newRoot = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root }).toString().trim();
    expect(newRoot).not.toBe(commitA);

    const second = await resolveProject({ cwd: root, cacheGitFacts: true });
    expect(second.bindingStatus).toBe("mismatch");
    const cache = await fs.readJson(rootCommitCacheFile(root));
    expect(cache.rootCommit).toBe(newRoot);
  });
});

// ─── 19. escrita do cache é opt-in (DEFEITO 2, reprovação do verifier) ──────
//
// `resolveProject` sem `cacheGitFacts: true` volta a ser ESTRITAMENTE
// read-only — inclusive quando `binding.git_root_commit` existe e pediria
// verificação. Reproduz e corrige: `nexos init --repair --dry-run` e a
// checagem de ancestral de `nexos init` chamavam `resolveProject` sem a
// opção (nenhuma das duas é `session-start.ts`) e por isso NUNCA escrevem
// o cache, mesmo em projeto git-bound.

describe("19 · escrita do cache é opt-in", () => {
  it("a · sem cacheGitFacts, resolveProject nunca escreve o cache mesmo com binding git_root_commit", async () => {
    const root = await mkProject("omega-optin", { git: {} });
    const commit = await commitOnce(root);
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("omega-optin"), gitBinding(commit)));

    const before = await snapshotTree(root);
    const r = await resolveProject({ cwd: root }); // SEM cacheGitFacts
    const after = await snapshotTree(root);

    expect(r.bindingStatus).toBe("bound"); // continua verificando — só não persiste
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(await fs.pathExists(rootCommitCacheFile(root))).toBe(false);
  });

  it("b · DEFEITO 2: `nexos init --repair --dry-run` não escreve `.nexos/.local` — árvore idêntica", async () => {
    const { init } = await import("../src/commands/init.js");
    const root = await mkProject("omega-dryrun", { git: {} });
    const commit = await commitOnce(root);
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("omega-dryrun"), gitBinding(commit)));

    const before = await snapshotTree(root);
    const exitCodeAntes = process.exitCode;
    try {
      await init({ cwd: root, repair: true, dryRun: true });
    } finally {
      process.exitCode = exitCodeAntes;
    }
    const after = await snapshotTree(root);

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(await fs.pathExists(rootCommitCacheFile(root))).toBe(false);
  });

  it("c · DEFEITO 2: checagem de ancestral de `nexos init` não escreve no `.nexos` do PAI", async () => {
    const { init } = await import("../src/commands/init.js");
    const parent = await mkProject("omega-parent", { git: {} });
    const commit = await commitOnce(parent);
    await fs.ensureDir(path.join(parent, ".nexos"));
    await fs.writeFile(path.join(parent, ".nexos", "manifest.yaml"), manifestWithBinding(canonId("omega-parent"), gitBinding(commit)));

    const child = path.join(parent, "child");
    await fs.ensureDir(child);
    await fs.writeJson(path.join(child, "package.json"), { name: "child" });

    const before = await snapshotTree(parent);
    const exitCodeAntes = process.exitCode;
    try {
      await init({ cwd: child });
      expect(process.exitCode).toBe(1); // recusado: ancestral canônico já existe
    } finally {
      process.exitCode = exitCodeAntes;
    }
    const after = await snapshotTree(parent);

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(await fs.pathExists(rootCommitCacheFile(parent))).toBe(false);
  });
});

// ─── 20. remote lido de `.git/config` sem spawn — paridade com `git config` ─

describe("20 · remote sem spawn", () => {
  it("a · repo comum: aliases.gitRemote bate com `git config --get remote.origin.url`", async () => {
    const root = await mkProject("chi", { git: { remote: "git@github.com:acme/chi.git" }, marker: true });

    const r = await resolveProject({ cwd: root });
    const expected = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"]).toString().trim();

    expect(r.aliases.gitRemote).toBe(expected);
    expect(r.aliases.gitRemote).toBe("git@github.com:acme/chi.git");
  });

  it("b · repo sem remote configurado: undefined, igual ao `git config` (exit != 0)", async () => {
    const root = await mkProject("psi", { git: {}, marker: true });

    const r = await resolveProject({ cwd: root });

    expect(r.aliases.gitRemote).toBeUndefined();
    expect(() =>
      execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], { stdio: "pipe" })
    ).toThrow();
  });

  it("c · worktree linkado: aliases.gitRemote resolve via commondir, bate com `git config` rodado no worktree", async () => {
    const main = await mkProject("omega-main", { git: { remote: "https://example.com/omega.git" } });
    await commitOnce(main);
    const worktreeRoot = path.join(workspace, "omega-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "omega-wt-branch", worktreeRoot], { cwd: main });

    const r = await resolveProject({ cwd: worktreeRoot });
    const expected = execFileSync("git", ["-C", worktreeRoot, "config", "--get", "remote.origin.url"])
      .toString()
      .trim();

    expect(r.aliases.gitRemote).toBe(expected);
    expect(r.aliases.gitRemote).toBe("https://example.com/omega.git");
  });
});
