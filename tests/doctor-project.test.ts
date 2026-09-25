/**
 * G1 (docs/visao-nexos-project-operating-model.md Parte 3.3/3.4) —
 * `nexos doctor --project [--json]`. Aceite A1–A8, A10.
 *
 * `os.homedir()` mockado para o ARQUIVO INTEIRO (mesmo padrão de
 * `tests/install-surface-contract.test.ts`) — isola `CLAUDE_DIR`
 * (`~/.claude`) de qualquer instalação real da máquina que roda a suíte.
 * `GLOBAL_ROOT`/`NEXOS_HOME` já são isolados globalmente por
 * `tests/isolate-nexos-home.ts` (setupFiles) — os dois mecanismos convivem:
 * `constants.ts` real (por trás do mock de `constants.js`) lê `os.homedir()`
 * já mockado para calcular `CLAUDE_DIR`.
 *
 * Toda fixture de PROJETO mora em `$TMPDIR` (`fs.mkdtemp`), nunca no
 * checkout real deste repo. `beforeEach` reinstala um `~/.claude` LIMPO e
 * COMPLETO antes de cada teste (a superfície global só varia de propósito no
 * teste A7).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const TMP = fs.realpathSync(os.tmpdir());
const FAKE_HOME = fs.mkdtempSync(path.join(TMP, "doctor-project-home-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => FAKE_HOME }, homedir: () => FAKE_HOME };
});

const { buildProjectDoctorReport } = await import("../src/lib/doctor/project-doctor.js");
const { doctorProject } = await import("../src/commands/doctor.js");
const { computeInstallPlan, applyInstallPlan } = await import("../src/lib/installer.js");
const { CLAUDE_DIR, INSTALL_TARGETS, NEXOS_MARKER } = await import("../src/lib/constants.js");
const { init } = await import("../src/commands/init.js");
const { map: runMap } = await import("../src/commands/map.js");
const { runBoot } = await import("../src/commands/boot.js");
const { planRepair } = await import("../src/lib/capsule/repair.js");
const { resolveProject } = await import("../src/lib/project-resolver.js");

afterAll(async () => {
  await fs.remove(FAKE_HOME);
});

// ─── superfície global — completa e sem drift antes de CADA teste ──────────

beforeEach(async () => {
  await fs.remove(CLAUDE_DIR);
  await applyInstallPlan(await computeInstallPlan());
});

// ─── helpers ────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.remove(d).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(TMP, `doctor-project-${prefix}-`));
  dirs.push(dir);
  return dir;
}

async function git(args: string[], cwd: string): Promise<void> {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function mkGitProject(prefix: string): Promise<string> {
  const dir = await tmpDir(prefix);
  await git(["init", "-q"], dir);
  await git(["config", "user.email", "t@t.com"], dir);
  await git(["config", "user.name", "t"], dir);
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n");
  await git(["add", "README.md"], dir);
  await git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/** `nexos init` silencioso (mesmo padrão de `tests/repair.test.ts` `repairSilently`). */
async function initSilently(dir: string): Promise<void> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await init({ cwd: dir, registerGlobally: false });
  } finally {
    spy.mockRestore();
  }
}

/** `nexos map` silencioso — mesmo padrão de `initSilently`. */
async function mapSilently(dir: string): Promise<void> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMap({ cwd: dir });
  } finally {
    spy.mockRestore();
  }
}

/**
 * Snapshot conteúdo+mtime da árvore inteira — prova de "nada foi escrito"
 * (mesmo padrão de `tests/boot.test.ts`). `.git/` fica de fora: `git
 * status`/`git diff` (chamados por `checkMapFreshness`/
 * `computeLifecycleGitFacts`, ambos reusados por este módulo) fazem o
 * PRÓPRIO git tocar o mtime de `.git/index` ao refrescar o stat-cache —
 * comportamento do git em QUALQUER leitura, byte-idêntico (hash confere),
 * nunca uma escrita do doctor. `ZERO WRITE BY DOCTOR != ZERO GIT INDEX
 * REFRESH` — o segundo é do git, não deste código.
 */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(current, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        /**
         * Tamanho + mtime, sem ler conteúdo: toda escrita muda o mtime. MEDIDO
         * 24/09: hashear o conteúdo lia o ~/.claude inteiro (18.791 arquivos,
         * 3,9 GB, 3,3 GB de transcripts) duas vezes por execução e o teste
         * estourou os 30 s sob carga — custo que crescia com a máquina do dev,
         * não com o doctor.
         */
        const st = await fs.stat(full);
        out.set(rel, `${st.size}:${st.mtimeMs}`);
      }
    }
  }
  await walk(dir);
  return out;
}

function expectNoWrite(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.entries()]).toEqual([...before.entries()]);
}

/**
 * O `.nexos` REAL deste repo tem escritores vivos fora do doctor em `.local/`
 * (estado operacional da máquina): o hook de recall grava
 * `.local/retrieval.jsonl`, a statusLine grava `.local/runtime/` e o hot path
 * do prompt grava `.local/derived/integrity-cache.json`. MEDIDO 24/09: cada
 * prompt do dono durante o `nexos verify` reprovou este teste com o doctor
 * inocente, um escritor diferente por vez. Aqui `.local/` sai do retrato
 * inteiro; o "zero escrita" do doctor em `.local/` continua provado pelos
 * testes deste arquivo que rodam em diretório temporário, sem escritor vivo.
 */
function semEscritoresVivos(snap: Map<string, string>): Map<string, string> {
  return new Map([...snap].filter(([rel]) => !rel.startsWith(".local/")));
}

/** `snapshotTree(CLAUDE_DIR)` — prova de zero escrita no HOME (isolado), além da árvore do projeto. */
async function snapshotHome(): Promise<Map<string, string>> {
  return snapshotTree(CLAUDE_DIR);
}

/** Fixture LEGACY_DEGRADED SEM manifest — formato M4 do inventário (mesma forma de `legacyNoManifestFixture` em `tests/repair.test.ts`). */
async function legacyM4Fixture(dir: string): Promise<void> {
  const capsule = path.join(dir, ".nexos");
  await fs.ensureDir(path.join(capsule, "logs"));
  await fs.ensureDir(path.join(capsule, "memory", "project"));
  await fs.writeFile(path.join(capsule, "logs", "old.log"), "log legado\n");
  await fs.writeFile(
    path.join(capsule, "memory", "project", "decisions.md"),
    "## ADR-001: Stack escolhida\ntexto sem record correspondente no Store\n"
  );
  await fs.writeFile(path.join(capsule, "memory", "project", "research.md"), "pesquisa legada\n");
}

// ─── A1 — git sem .nexos → NOT_ADOPTED, plano CREATE→nexos init, zero escrita ─

describe("G1 A1 · diretório com git e sem .nexos", () => {
  it("NOT_ADOPTED + plano CREATE→nexos init; hash da árvore e do HOME idênticos", async () => {
    const dir = await mkGitProject("a1");
    const before = await snapshotTree(dir);
    const homeBefore = await snapshotHome();

    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("NOT_ADOPTED");
    expect(report.plan.some((p) => p.action === "CREATE" && p.command === "nexos init")).toBe(true);

    expectNoWrite(before, await snapshotTree(dir));
    expectNoWrite(homeBefore, await snapshotHome());
  });

  it("contrafactual — sem .nexos nem git, `resolveProject` não acha fronteira: doctor --project não inventa projeto", async () => {
    const dir = await tmpDir("a1-no-boundary");
    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("UNSUPPORTED");
    expect(report.plan).toEqual([]);
  });
});

// ─── A2 — depois de nexos init → HEALTHY; nexos boot CANONICAL ─────────────

describe("G1 A2 · depois de nexos init", () => {
  it("HEALTHY; nexos boot CANONICAL", async () => {
    const dir = await mkGitProject("a2");
    await initSilently(dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("HEALTHY");
    expect(report.projectId).toBeDefined();

    const boot = await runBoot({ cwd: dir });
    expect(boot.state).toBe("CANONICAL");
  });

  it("zero escrita — INSPECT/PLAN não tocam a árvore do projeto nem do HOME", async () => {
    const dir = await mkGitProject("a2-zw");
    await initSilently(dir);
    const before = await snapshotTree(dir);
    const homeBefore = await snapshotHome();

    await buildProjectDoctorReport({ cwd: dir });

    expectNoWrite(before, await snapshotTree(dir));
    expectNoWrite(homeBefore, await snapshotHome());
  });
});

// ─── memoria-nunca-sai-da-maquina — aviso, nunca bloqueio ──────────────────

describe("G1 · git-memória (nexos://decision/memoria-nunca-sai-da-maquina)", () => {
  it("projeto recém-iniciado — nada rastreado no git, sem item de plano", async () => {
    const dir = await mkGitProject("mem-clean");
    await initSilently(dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("HEALTHY");
    expect(report.evidence.find((e) => e.area === "git-memoria")?.detail).toContain(
      "nenhum de .nexos/records, .nexos/memory, .nexos/evidence rastreado"
    );
    expect(report.plan.find((p) => p.area === "git-memoria")).toBeUndefined();
  });

  it("records rastreado no git — AVISA (evidence + plano com o remédio), continua HEALTHY", async () => {
    const dir = await mkGitProject("mem-tracked");
    await initSilently(dir);
    await fs.outputFile(path.join(dir, ".nexos", "records", "decisions", "dec_teste.yaml"), "x: 1\n");
    await git(["add", "-f", ".nexos/records/decisions/dec_teste.yaml"], dir);
    await git(["commit", "-q", "-m", "records rastreado (simula C12.2 revogada)"], dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    // AVISO, NUNCA BLOQUEIO: o rastro de uma versão anterior não derruba o estado.
    expect(report.state).toBe("HEALTHY");
    const evidencia = report.evidence.find((e) => e.area === "git-memoria");
    expect(evidencia?.detail).toContain("1 caminho(s) rastreado(s) no git");
    expect(evidencia?.detail).toContain(".nexos/records/decisions/dec_teste.yaml");

    const item = report.plan.find((p) => p.area === "git-memoria");
    expect(item?.action).toBe("UPDATE");
    expect(item?.command).toBe("git rm -r --cached --ignore-unmatch .nexos/records .nexos/memory .nexos/evidence");
  });

  /**
   * MEDIDO (dogfooding no nexos-cli real, 2026-09-24): 2770 records reais
   * rastreados produziam um `detail` de ~340KB sem teto — inviável em
   * terminal ou `--json`. Sete arquivos bastam para provar o corte em 5 +
   * sufixo "e mais N", sem pagar o custo de uma fixture com milhares.
   */
  it("mais de 5 rastreados — amostra de 5 + contagem, nunca a lista inteira", async () => {
    const dir = await mkGitProject("mem-many");
    await initSilently(dir);
    for (let i = 0; i < 7; i++) {
      await fs.outputFile(path.join(dir, ".nexos", "records", "decisions", `dec_${i}.yaml`), "x: 1\n");
    }
    await git(["add", "-f", ".nexos/records"], dir);
    await git(["commit", "-q", "-m", "sete records rastreados"], dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    const evidencia = report.evidence.find((e) => e.area === "git-memoria");
    expect(evidencia?.detail).toContain("7 caminho(s) rastreado(s) no git");
    expect(evidencia?.detail).toContain("e mais 2");
    expect(evidencia?.detail?.match(/dec_\d\.yaml/g)).toHaveLength(5);

    const item = report.plan.find((p) => p.area === "git-memoria");
    expect(item?.detail).toBe("7 caminho(s) rastreado(s) no git — tira do índice sem apagar arquivo");
  });
});

describe("G1 · memória que o git NÃO ignoraria (preventivo, antes do commit)", () => {
  it("evidence rastreado também é memória — entra no aviso git-memoria", async () => {
    const dir = await mkGitProject("mem-evidence");
    await initSilently(dir);
    await fs.outputFile(path.join(dir, ".nexos", "evidence", "ev.json"), "{}\n");
    await git(["add", "-f", ".nexos/evidence/ev.json"], dir);
    await git(["commit", "-q", "-m", "evidence rastreado"], dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence.find((e) => e.area === "git-memoria")?.detail).toContain(".nexos/evidence/ev.json");
  });

  it("depois do init — as 3 pastas de memória ignoradas, sem item de plano", async () => {
    const dir = await mkGitProject("mem-ign-ok");
    await initSilently(dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence.find((e) => e.area === "gitignore-memoria")?.detail).toBe(
      ".nexos/records, .nexos/memory, .nexos/evidence ignorados pelo git"
    );
    expect(report.plan.find((p) => p.area === "gitignore-memoria")).toBeUndefined();
  });

  it("sem a regra no .gitignore — AVISA antes de qualquer commit, plano UPDATE→nexos init", async () => {
    const dir = await mkGitProject("mem-ign-falta");
    await initSilently(dir);
    await fs.remove(path.join(dir, ".gitignore"));

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("HEALTHY");
    expect(report.evidence.find((e) => e.area === "gitignore-memoria")?.detail).toBe(
      "não ignorado(s) pelo git — o próximo git add levaria memória: .nexos/records, .nexos/memory, .nexos/evidence"
    );
    const item = report.plan.find((p) => p.area === "gitignore-memoria");
    expect(item?.action).toBe("UPDATE");
    expect(item?.command).toBe("nexos init");
  });
});

describe("G1 · negação que reinclui memória — o doctor aponta a linha, não promete o init", () => {
  it("negação depois no .gitignore raiz: evidência com origem:linha, plano sem comando", async () => {
    const dir = await mkGitProject("mem-neg-raiz");
    await initSilently(dir);
    await fs.appendFile(path.join(dir, ".gitignore"), "!.nexos/records/\n");
    await fs.ensureDir(path.join(dir, ".nexos", "records"));

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence.find((e) => e.area === "gitignore-memoria")?.detail).toMatch(
      /reincluído por negação em \.gitignore:\d+ \(!\.nexos\/records\/\)/
    );
    const item = report.plan.find((p) => p.area === "gitignore-memoria");
    expect(item?.detail).toContain("remova a negação");
    expect(item?.command).toBeUndefined();
  });

  it("negação no .nexos/.gitignore aninhado também é apontada", async () => {
    const dir = await mkGitProject("mem-neg-aninhado");
    await initSilently(dir);
    await fs.appendFile(path.join(dir, ".nexos", ".gitignore"), "!memory/\n");
    await fs.ensureDir(path.join(dir, ".nexos", "memory"));

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence.find((e) => e.area === "gitignore-memoria")?.detail).toContain(
      "reincluído por negação em .nexos/.gitignore:"
    );
    expect(report.plan.find((p) => p.area === "gitignore-memoria")?.command).toBeUndefined();
  });
});

describe("G1 · Dockerfile sem .dockerignore vaza memória para a imagem", () => {
  it("sem Dockerfile — nenhuma evidência de dockerignore", async () => {
    const dir = await mkGitProject("docker-none");
    await initSilently(dir);

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence.find((e) => e.area === "dockerignore")).toBeUndefined();
  });

  it("Dockerfile presente SEM .dockerignore — AVISA, plano UPDATE→nexos init", async () => {
    const dir = await mkGitProject("docker-leak");
    await initSilently(dir);
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nCOPY . .\n");

    const report = await buildProjectDoctorReport({ cwd: dir });
    // Um Dockerfile novo, não commitado, deixa o map stale por conta própria
    // (DRIFTED) — ortogonal ao que este teste prova: aviso, nunca DEGRADED.
    expect(report.state).not.toBe("DEGRADED");
    expect(report.evidence.find((e) => e.area === "dockerignore")?.detail).toContain("memória entraria na imagem");
    const item = report.plan.find((p) => p.area === "dockerignore");
    expect(item?.action).toBe("UPDATE");
    expect(item?.command).toBe("nexos init");
  });

  it("Dockerfile presente COM .dockerignore excluindo .nexos — sem aviso, sem item de plano", async () => {
    const dir = await mkGitProject("docker-ok");
    await initSilently(dir);
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22\n");
    await fs.writeFile(path.join(dir, ".dockerignore"), "node_modules\n.nexos\n");

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence.find((e) => e.area === "dockerignore")?.detail).toBe(
      "Dockerfile presente e .dockerignore exclui .nexos"
    );
    expect(report.plan.find((p) => p.area === "dockerignore")).toBeUndefined();
  });
});

// ─── A3 — cópia de legado (M4) → LEGACY, mesmas contagens de init --repair --dry-run ─

describe("G1 A3 · cópia de projeto legado (M4 — sem manifest, memory/+logs/)", () => {
  it("LEGACY + ARCHIVE/PRESERVE com as mesmas contagens de planRepair (init --repair --dry-run); hash idêntico", async () => {
    const dir = await mkGitProject("a3");
    await legacyM4Fixture(dir);
    const before = await snapshotTree(dir);
    const homeBefore = await snapshotHome();

    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("LEGACY");

    // mesma fonte que `nexos init --repair --dry-run` usa — mesmas contagens por construção,
    // mas a asserção prova que o wiring realmente chama planRepair, não uma cópia divergente.
    const resolution = await resolveProject({ cwd: dir });
    const directPlan = await planRepair(dir, resolution.bindingStatus, { forced: false }, resolution.rootSource);

    const archiveItems = report.plan.filter((p) => p.action === "ARCHIVE");
    const preserveItems = report.plan.filter((p) => p.action === "PRESERVE");
    expect(archiveItems.length).toBe(directPlan.archive.length);
    expect(preserveItems.length).toBe(directPlan.keep.length);
    expect(directPlan.archive).toContain("logs");

    expectNoWrite(before, await snapshotTree(dir));
    expectNoWrite(homeBefore, await snapshotHome());
  });
});

// ─── A4 — commit novo depois do map; CLAUDE.md sem bloco → DRIFTED ─────────

describe("G1 A4 · commit novo depois do map; CLAUDE.md sem bloco NexOS", () => {
  it("DRIFTED com UPDATE→nexos map e UPDATE do bloco", async () => {
    const dir = await mkGitProject("a4");
    await initSilently(dir);
    // desde o G3 o init escreve o bloco; a premissa "sem bloco" é criada aqui.
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# fixture sem bloco NexOS\n");

    // muda um arquivo REAL (fora de .nexos) e commita — map fica genuinamente
    // stale (fingerprint diverge de verdade, nunca a falsa-alarme que dispara
    // convergeLastMappedCommit em checkMapFreshness).
    await fs.writeFile(path.join(dir, "README.md"), "# fixture\n\nmudou de verdade.\n");
    await git(["add", "README.md"], dir);
    await git(["commit", "-q", "-m", "muda readme"], dir);
    const before = await snapshotTree(dir);
    const homeBefore = await snapshotHome();

    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("DRIFTED");
    expect(report.plan.some((p) => p.action === "UPDATE" && p.command === "nexos map")).toBe(true);
    expect(report.plan.some((p) => p.action === "UPDATE" && p.area === "claude-md")).toBe(true);

    expectNoWrite(before, await snapshotTree(dir));
    expectNoWrite(homeBefore, await snapshotHome());
  });
});

// ─── A5 — manifest.yaml ilegível → CORRUPT, nenhum APPLY além de reportar ──

describe("G1 A5 · manifest.yaml ilegível", () => {
  it("CORRUPT; plano só reporta (KEEP), hash idêntico", async () => {
    const dir = await mkGitProject("a5");
    await fs.ensureDir(path.join(dir, ".nexos"));
    await fs.writeFile(path.join(dir, ".nexos", "manifest.yaml"), "{{{ isto não é YAML válido ]]]\n");
    const before = await snapshotTree(dir);
    const homeBefore = await snapshotHome();

    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("CORRUPT");
    expect(report.plan.every((p) => p.action === "KEEP")).toBe(true);
    expect(report.plan.length).toBeGreaterThan(0);

    expectNoWrite(before, await snapshotTree(dir));
    expectNoWrite(homeBefore, await snapshotHome());
  });
});

// ─── A6 — worktree ligado a projeto já adotado → CONFLICT ──────────────────

describe("G1 A6 · worktree git ligado a um checkout já adotado", () => {
  it("CONFLICT (reusa a mesma detecção de REFUSE_LINKED_WORKTREE)", async () => {
    const main = await mkGitProject("a6-main");
    await initSilently(main);

    const worktreeDir = path.join(path.dirname(main), `${path.basename(main)}-worktree`);
    dirs.push(worktreeDir);
    await git(["branch", "a6-side"], main);
    await git(["worktree", "add", worktreeDir, "a6-side"], main);

    const before = await snapshotTree(worktreeDir);
    const homeBefore = await snapshotHome();
    const report = await buildProjectDoctorReport({ cwd: worktreeDir });

    expect(report.state).toBe("CONFLICT");
    expect(report.plan.some((p) => p.action === "CONFLICT")).toBe(true);

    expectNoWrite(before, await snapshotTree(worktreeDir));
    expectNoWrite(homeBefore, await snapshotHome());
  });
});

// ─── A7 — HOME com instalação antiga/hook faltando; statusLine alheia ──────

describe("G1 A7 · HOME com instalação antiga ou hook faltando; statusLine alheia", () => {
  it("PARTIAL ou DRIFTED, com UPDATE→nexos install; statusLine preservada como CONFLICT", async () => {
    const dir = await mkGitProject("a7");
    await initSilently(dir);

    // instalação antiga: marcador de versão desatualizado.
    await fs.writeJson(NEXOS_MARKER, { version: "0.0.1", installedAt: "2020-01-01T00:00:00.000Z" }, { spaces: 2 });
    // hook faltando: remove um hook real do pacote.
    const hookFiles = (await fs.readdir(INSTALL_TARGETS.hooks)).filter((f) => f.endsWith(".sh") || f.endsWith(".js"));
    expect(hookFiles.length).toBeGreaterThan(0);
    await fs.remove(path.join(INSTALL_TARGETS.hooks, hookFiles[0]!));
    // statusLine de outro dono — nunca sobrescrita.
    const settingsPath = path.join(CLAUDE_DIR, "settings.json");
    const settings = await fs.readJson(settingsPath);
    settings.statusLine = { type: "command", command: "minha-statusline-alheia.sh" };
    await fs.writeJson(settingsPath, settings, { spaces: 2 });

    // Snapshot SÓ depois da corrupção deliberada acima (que é setup de
    // fixture, não escrita do doctor) — prova que `buildProjectDoctorReport`
    // não muta o HOME (nem "corrige" o statusLine alheio) por conta própria.
    const homeBefore = await snapshotHome();
    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(["PARTIAL", "DRIFTED"]).toContain(report.state);
    expect(report.plan.some((p) => p.action === "UPDATE" && p.command === "nexos install")).toBe(true);
    const conflictItem = report.plan.find((p) => p.action === "CONFLICT" && p.area === "global-install");
    expect(conflictItem?.detail).toContain("minha-statusline-alheia.sh");

    expectNoWrite(homeBefore, await snapshotHome());
  });
});

// ─── A8 — custo: sem rede, sem LLM; p50 ≤ 2s no repositório nexos-cli ──────

describe("G1 A8 · custo", () => {
  /**
   * Sob a suíte inteira o p50 passou de 2 s (2220 ms, 24/09) com o doctor
   * isolado em 777 ms — a carga era dos outros workers. Repetir absorve pico
   * passageiro; regressão real reprova nas 3 tentativas (medido por mutação:
   * doctor gravando em .nexos e doctor +2500 ms). `retry.condition` do vitest
   * 5.0.1 foi testado para repetir só o teto de tempo e foi ignorado.
   */
  it("p50 ≤ 2s em 6 execuções no repositório nexos-cli; zero escrita em .nexos/ e no HOME", { retry: 2 }, async () => {
    const repoRoot = process.cwd();
    const nexosDir = path.join(repoRoot, ".nexos");
    const before = semEscritoresVivos(await snapshotTree(nexosDir));
    const homeBefore = await snapshotHome();

    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      await buildProjectDoctorReport({ cwd: repoRoot });
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;

    expectNoWrite(before, semEscritoresVivos(await snapshotTree(nexosDir)));
    expectNoWrite(homeBefore, await snapshotHome());

    expect(p50).toBeLessThanOrEqual(2000);
  });
});

// ─── DEFEITO 1 (reprovação do verifier) — falso-alarme de map staleness nunca escreve ─

describe("G1 · DEFEITO 1 (reprovação do verifier) — leitura pura mesmo no falso-alarme de map staleness", () => {
  it("git init + nexos init + 2º commit só de binário (fora do fingerprint, map-scan.ts resolveScope) → HEALTHY/map fresh, zero escrita", async () => {
    const dir = await mkGitProject("defeito1");
    await initSilently(dir);

    // Arquivo binário — `resolveScope` (map-scan.ts) exclui do fingerprint
    // de escopo qualquer arquivo com um byte NUL nos primeiros 8000 bytes
    // (reason: "binary"). HEAD anda (git vê o commit, `changedSinceLastMapped`
    // não fica vazio), mas o CONTEÚDO observado pelo fingerprint não muda —
    // exatamente o falso-alarme que `convergeLastMappedCommit`
    // (`lib/map/freshness.ts`) resolvia gravando `last_mapped_commit`/
    // `sourceFingerprint` em disco, mesmo dentro de um comando que promete
    // SOMENTE LEITURA (decisão do dono: só APPLY escreve).
    await fs.writeFile(path.join(dir, "asset.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    await git(["add", "asset.bin"], dir);
    await git(["commit", "-q", "-m", "binario"], dir);

    const before = await snapshotTree(dir);
    const homeBefore = await snapshotHome();

    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("HEALTHY");
    const mapEvidence = report.evidence.find((e) => e.area === "map");
    expect(mapEvidence?.detail).toBe("fresh");

    expectNoWrite(before, await snapshotTree(dir));
    expectNoWrite(homeBefore, await snapshotHome());
  });

  it("contrafactual — SEM `{ converge: false }` no call-site, o mesmo cenário grava .nexos/map/project.json e manifest.yaml", async () => {
    const dir = await mkGitProject("defeito1-contrafactual");
    await initSilently(dir);
    await fs.writeFile(path.join(dir, "asset.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    await git(["add", "asset.bin"], dir);
    await git(["commit", "-q", "-m", "binario"], dir);

    // Reproduz o DEFEITO 1 chamando `checkMapFreshness` exatamente como
    // `project-doctor.ts` chamava ANTES da correção (sem a opção) — prova,
    // no MESMO processo de teste, que a opção é o que faz a diferença, não
    // uma peculiaridade da fixture. `checkMapFreshness(dir)` sozinho (sem
    // `{ converge: false }`) é o comportamento pré-correção reproduzido.
    const { checkMapFreshness } = await import("../src/lib/map/freshness.js");
    const projectJsonPath = path.join(dir, ".nexos", "map", "project.json");
    const manifestPath = path.join(dir, ".nexos", "manifest.yaml");
    const beforeProjectJson = await fs.readFile(projectJsonPath, "utf-8");
    const beforeManifest = await fs.readFile(manifestPath, "utf-8");

    const freshness = await checkMapFreshness(dir); // SEM a opção — reproduz o defeito
    expect(freshness).toEqual({ stale: false, reason: "fresh" });

    const afterProjectJson = await fs.readFile(projectJsonPath, "utf-8");
    const afterManifest = await fs.readFile(manifestPath, "utf-8");
    expect(afterProjectJson).not.toBe(beforeProjectJson); // convergiu — a escrita que o DEFEITO 1 reporta
    expect(afterManifest).not.toBe(beforeManifest);
  });
});

// ─── DEFEITO 2 (cobertura) — doctorProject() e process.exitCode em estados bloqueantes ─

describe("G1 · DEFEITO 2 (cobertura) — doctorProject() seta process.exitCode só em CORRUPT/CONFLICT", () => {
  async function captureExitCode(run: () => Promise<void>): Promise<number | undefined> {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run();
      return process.exitCode;
    } finally {
      spy.mockRestore();
      process.exitCode = savedExitCode;
    }
  }

  it("CONFLICT → exitCode 1", async () => {
    const main = await mkGitProject("defeito2-conflict-main");
    await initSilently(main);
    const worktreeDir = path.join(path.dirname(main), `${path.basename(main)}-worktree-d2`);
    dirs.push(worktreeDir);
    await git(["branch", "d2-side"], main);
    await git(["worktree", "add", worktreeDir, "d2-side"], main);

    const exitCode = await captureExitCode(() => doctorProject({ cwd: worktreeDir }));
    expect(exitCode).toBe(1);
  });

  it("CORRUPT → exitCode 1", async () => {
    const dir = await mkGitProject("defeito2-corrupt");
    await fs.ensureDir(path.join(dir, ".nexos"));
    await fs.writeFile(path.join(dir, ".nexos", "manifest.yaml"), "{{{ não é YAML ]]]\n");

    const exitCode = await captureExitCode(() => doctorProject({ cwd: dir }));
    expect(exitCode).toBe(1);
  });

  it("NOT_ADOPTED (não bloqueante) → process.exitCode nunca setado", async () => {
    const dir = await mkGitProject("defeito2-not-adopted");
    const exitCode = await captureExitCode(() => doctorProject({ cwd: dir }));
    expect(exitCode).toBeUndefined();
  });

  it("HEALTHY (não bloqueante) → process.exitCode nunca setado", async () => {
    const dir = await mkGitProject("defeito2-healthy");
    await initSilently(dir);
    const exitCode = await captureExitCode(() => doctorProject({ cwd: dir }));
    expect(exitCode).toBeUndefined();
  });

  it("contrafactual — tirar CONFLICT de BLOCKING_PROJECT_STATES faria este teste falhar (prova que o teste realmente confere o set)", async () => {
    const main = await mkGitProject("defeito2-contrafactual-main");
    await initSilently(main);
    const worktreeDir = path.join(path.dirname(main), `${path.basename(main)}-worktree-d2b`);
    dirs.push(worktreeDir);
    await git(["branch", "d2b-side"], main);
    await git(["worktree", "add", worktreeDir, "d2b-side"], main);

    const report = await buildProjectDoctorReport({ cwd: worktreeDir });
    // O teste "CONFLICT → exitCode 1" acima SÓ prova o wiring porque o
    // estado observado aqui é realmente CONFLICT — se `classifyProjectLifecycleForResolution`
    // ou `planRepair` parassem de detectar o worktree ligado, este assert
    // falharia PRIMEIRO e apontaria para a causa certa.
    expect(report.state).toBe("CONFLICT");
  });
});

// ─── DEFEITO 3 (cobertura) — as 3 verificações do verifier viram teste ─────

describe("G1 · DEFEITO 3 (cobertura) — UNSUPPORTED/DRIFTED/DEGRADED que o verifier provou manualmente", () => {
  it("UNSUPPORTED — manifest com schema_version mais novo que o suportado por este binário", async () => {
    const dir = await mkGitProject("defeito3-unsupported");
    await fs.ensureDir(path.join(dir, ".nexos"));
    await fs.writeFile(
      path.join(dir, ".nexos", "manifest.yaml"),
      [
        "schema_version: 999",
        "scope: project",
        "project:",
        "  id: prj_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "  name: futuro",
        "capsule:",
        "  format_version: 1",
        "",
      ].join("\n")
    );
    const before = await snapshotTree(dir);

    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("UNSUPPORTED");
    expect(report.reasons.some((r) => r.includes("schema_version"))).toBe(true);
    expect(report.reasons.some((r) => r.includes("999"))).toBe(true);

    expectNoWrite(before, await snapshotTree(dir));
  });

  it("DRIFTED — CLAUDE.md com bloco gerenciado malformado (BEGIN sem END)", async () => {
    const dir = await mkGitProject("defeito3-drifted-malformed");
    await initSilently(dir);
    const claudeMdPath = path.join(dir, "CLAUDE.md");
    const existing = await fs.readFile(claudeMdPath, "utf-8");
    await fs.writeFile(claudeMdPath, `${existing}\n<!-- NEXOS:BEGIN managed -->\nconteúdo sem fechamento\n`);

    const before = await snapshotTree(dir);
    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("DRIFTED");
    expect(report.reasons.some((r) => r.includes("CLAUDE.md: bloco gerenciado em conflito"))).toBe(true);
    const item = report.plan.find((p) => p.area === "claude-md");
    expect(item?.action).toBe("CONFLICT");
    expect(item?.command).toBeUndefined();

    expectNoWrite(before, await snapshotTree(dir));
  });

  it("G3 integrado — init recém-feito: bloco assinado conta como íntegro, nunca como malformado", async () => {
    const dir = await mkGitProject("g3-intact");
    await initSilently(dir);
    const report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.evidence).toContainEqual({ area: "claude-md", detail: "intact" });
    expect(report.plan.some((p) => p.area === "claude-md")).toBe(false);
    expect(report.reasons.some((r) => r.includes("CLAUDE.md"))).toBe(false);
  });

  it("G3 integrado — bloco desatualizado: DRIFTED com UPDATE via nexos init; editado à mão: CONFLICT sem comando", async () => {
    const { renderClaudeMdBlock } = await import("../src/lib/claude-md-block.js");
    const dir = await mkGitProject("g3-outdated");
    await initSilently(dir);
    const claudeMdPath = path.join(dir, "CLAUDE.md");

    await fs.writeFile(claudeMdPath, `# fixture\n\n${renderClaudeMdBlock("## NexOS\n\ncorpo de uma versão antiga\n")}\n`);
    let before = await snapshotTree(dir);
    let report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("DRIFTED");
    expect(report.reasons).toContain("CLAUDE.md: bloco gerenciado desatualizado");
    expect(report.plan).toContainEqual(expect.objectContaining({ action: "UPDATE", area: "claude-md", command: "nexos init" }));
    expectNoWrite(before, await snapshotTree(dir));

    const edited = (await fs.readFile(claudeMdPath, "utf-8")).replace("corpo de uma versão antiga", "corpo editado à mão");
    await fs.writeFile(claudeMdPath, edited);
    before = await snapshotTree(dir);
    report = await buildProjectDoctorReport({ cwd: dir });
    expect(report.state).toBe("DRIFTED");
    const item = report.plan.find((p) => p.area === "claude-md");
    expect(item?.action).toBe("CONFLICT");
    expect(item?.command).toBeUndefined();
    expectNoWrite(before, await snapshotTree(dir));
  });

  it("PROJECT HEALTH != HOST HYGIENE — acervo da MÁQUINA não degrada projeto adotado", async () => {
    /**
     * Piloto do projeto-piloto (2026-09-17): adoção correta, projeto saudável, e o
     * relatório dizia DEGRADED porque `~/.claude/agent-memory` tinha conteúdo
     * sem leitor — acervo da máquina, que pode ser de OUTRO projeto. O dono
     * lia "o projeto que acabei de adotar está degradado". Agora a metade do
     * host é EVIDÊNCIA; só a metade do projeto decide o estado.
     */
    const dir = await mkGitProject("host-hygiene-nao-degrada");
    await initSilently(dir);

    // Sujeira na MÁQUINA (FAKE_HOME é o homedir mockado deste arquivo).
    await fs.ensureDir(path.join(FAKE_HOME, ".claude", "agent-memory"));
    await fs.writeFile(
      path.join(FAKE_HOME, ".claude", "agent-memory", "de-outro-projeto.md"),
      "memória de agente de algum projeto desta máquina\n"
    );

    const before = await snapshotTree(dir);
    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).not.toBe("DEGRADED");
    expect(report.reasons.join(" ")).not.toContain("agent-memory-user");
    const higiene = report.evidence.find((e) => e.area === "host-hygiene");
    expect(higiene?.detail).toContain("agent-memory-user");
    expect(higiene?.detail).toContain("higiene da máquina");

    await fs.remove(path.join(FAKE_HOME, ".claude", "agent-memory"));
    expectNoWrite(before, await snapshotTree(dir));
  });

  /**
   * `ACERVO INERTE != MEMÓRIA CONCORRENTE` — dentro da metade do PROJETO,
   * ainda faltava separar o acervo que ninguém lê nem escreve (legado parado)
   * do que compete de verdade com o Store. Medido no próprio nexos-cli com o
   * 6.4.1: `DEGRADED` por `agent-memory-project=6 project-markdown=70`,
   * enquanto a MESMA saída trazia `lifecycle :: HEALTHY — ... memory/
   * preservado como legado (referência, não degrada)` — o relatório se
   * contradizia sobre o mesmo diretório.
   */
  it("HEALTHY — agent-memory-project CONGELADO (auto memory off) é acervo inerte: evidência, nunca veredito", async () => {
    const dir = await mkGitProject("acervo-congelado");
    await initSilently(dir);

    // `agentMemoryWritable = autoMemoryEnabled` (`memory-surfaces.ts`): auto
    // memory desligado zera o escritor das superfícies de agent-memory, e
    // `readBy` delas é `null` por definição de código. Nem lido nem escrito
    // = congelado (é o estado deste repositório: `.claude/settings.json`).
    await fs.outputJson(path.join(dir, ".claude", "settings.json"), { autoMemoryEnabled: false }, { spaces: 2 });
    await fs.ensureDir(path.join(dir, ".claude", "agent-memory"));
    await fs.writeFile(path.join(dir, ".claude", "agent-memory", "note.md"), "anotação congelada de agente\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-q", "-m", "agent memory congelada"], dir);
    await mapSilently(dir);

    const before = await snapshotTree(dir);
    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("HEALTHY");
    const memoria = report.evidence.find((e) => e.area === "project-memory");
    expect(memoria?.detail).toContain("agent-memory-project=1");
    expect(memoria?.detail).toContain("congeladas: agent-memory-project");
    expect(report.reasons.join(" ")).not.toContain("agent-memory-project");

    expectNoWrite(before, await snapshotTree(dir));
  });

  it("HEALTHY — project-markdown é o legado que o próprio lifecycle isenta ('referência, não degrada')", async () => {
    const dir = await mkGitProject("legado-markdown");
    await initSilently(dir);

    // `.nexos/memory/project` — `writable: true`, `readBy:
    // src/commands/review-memory.ts`, nota literal "o SessionBrief declara
    // NÃO ler daqui": legado de referência, nunca injetado em sessão.
    await fs.ensureDir(path.join(dir, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(dir, ".nexos", "memory", "project", "gotchas.md"), "- armadilha legada\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-q", "-m", "memory markdown legado"], dir);
    await mapSilently(dir);

    const before = await snapshotTree(dir);
    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("HEALTHY");
    const memoria = report.evidence.find((e) => e.area === "project-memory");
    expect(memoria?.detail).toContain("project-markdown=1");
    expect(report.reasons.join(" ")).not.toContain("project-markdown");
    // O lifecycle que isenta o diretório e o veredito precisam concordar.
    expect(report.evidence.find((e) => e.area === "lifecycle")?.detail).toContain("HEALTHY");

    expectNoWrite(before, await snapshotTree(dir));
  });

  it("DEGRADED — agent-memory-project write-only REAL (auto memory LIGADO + subagente com `memory: project`)", async () => {
    const dir = await mkGitProject("defeito3-degraded");
    await initSilently(dir);

    /**
     * Sinal que NÃO pode sumir: superfície que alguém ESCREVE e ninguém lê é
     * acervo órfão crescendo ao lado do Store. `writable = autoMemoryEnabled
     * && declarations.project > 0` — as duas metades precisam estar presentes,
     * senão o caso é congelado (teste acima), não write-only. Commitado e
     * mapeado de novo (`nexos map`) para não se confundir com "map stale"
     * (DRIFTED tem prioridade maior na classificação).
     */
    await fs.outputJson(path.join(dir, ".claude", "settings.json"), { autoMemoryEnabled: true }, { spaces: 2 });
    await fs.ensureDir(path.join(dir, ".claude", "agents"));
    await fs.writeFile(
      path.join(dir, ".claude", "agents", "escritor.md"),
      "---\nname: escritor\ndescription: subagente que grava memória de projeto\nmemory: project\n---\n\ncorpo\n"
    );
    await fs.ensureDir(path.join(dir, ".claude", "agent-memory"));
    await fs.writeFile(path.join(dir, ".claude", "agent-memory", "note.md"), "anotação de agente sem leitor\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-q", "-m", "agent memory sem leitor"], dir);
    await mapSilently(dir);

    const before = await snapshotTree(dir);
    const report = await buildProjectDoctorReport({ cwd: dir });

    expect(report.state).toBe("DEGRADED");
    expect(report.reasons.some((r) => r.includes("Parallel memories"))).toBe(true);
    expect(report.reasons.join(" ")).toContain("sem leitor: agent-memory-project");
    expect(report.reasons.join(" ")).not.toContain("congeladas");

    expectNoWrite(before, await snapshotTree(dir));
  });
});

// ─── contrafactual — sem o modo --project, estes testes não passam ─────────

describe("G1 · contrafactual", () => {
  it("`doctorProject`/`buildProjectDoctorReport` são funções novas — sem elas, todo teste acima falha na importação", () => {
    expect(typeof buildProjectDoctorReport).toBe("function");
    expect(typeof doctorProject).toBe("function");
    expect(doctorProject).not.toBe(undefined);
  });

  it("--json produz um JSON estável e parseável com os campos do contrato", async () => {
    const dir = await mkGitProject("json-contract");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let printed = "";
    spy.mockImplementation((...args: unknown[]) => {
      printed = args.map(String).join(" ");
    });
    try {
      await doctorProject({ json: true, cwd: dir });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(printed);
    expect(parsed.state).toBe("NOT_ADOPTED");
    expect(Array.isArray(parsed.evidence)).toBe(true);
    expect(Array.isArray(parsed.plan)).toBe(true);
    expect(typeof parsed.rootPath).toBe("string");
  });
});
