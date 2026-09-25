/**
 * P1.3i (nexos://decision/p1-3i-install-environment-boundary) — ENVIRONMENT
 * INSTALL != PROJECT LIFECYCLE. `nexos install` só conhece `~/.claude`, é
 * determinístico/não-interativo, e nunca lê o projeto atual.
 *
 * Testes A-F do contrato (checkpoint chk_01M2NQ4XBE80SQ60Z38QCM65X1). Mecanismo
 * de subprocesso: mesmo padrão de `tests/commands-root-from-subdir.test.ts`
 * (`spawnSync` com o loader tsx, `env.HOME` isolado) — nunca toca `~/.claude`
 * real. Teste F (uninstall cancelado) é a exceção: roda EM PROCESSO com
 * `@clack/prompts` mockado, porque um `confirm()` interativo não tem como ser
 * cancelado de fora de um subprocesso sem TTY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = path.resolve(__dirname, "..");
const TMP_BASE = fs.realpathSync(os.tmpdir());

function cli(cwd: string, home: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(repo, "dist/index.js"), ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    }
  );
}

async function freshLab(prefix: string): Promise<{ home: string; project: string }> {
  const lab = await fs.mkdtemp(path.join(TMP_BASE, prefix));
  const home = path.join(lab, "home");
  const project = path.join(lab, "project");
  await fs.ensureDir(home);
  await fs.ensureDir(project);
  return { home, project };
}

interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly sha256?: string;
  readonly mtimeMs?: number;
}

/** Snapshot recursivo: path -> sha256 + mtimeMs (+ presença de diretórios). */
async function snapshotTree(root: string): Promise<TreeEntry[]> {
  if (!(await fs.pathExists(root))) return [];
  const out: TreeEntry[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push({ path: rel, kind: "dir" });
        await walk(full, rel);
      } else {
        const [stat, content] = await Promise.all([fs.stat(full), fs.readFile(full)]);
        out.push({
          path: rel,
          kind: "file",
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  await walk(root, "");
  return out;
}

async function hashDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!(await fs.pathExists(dir))) return out;
  async function walk(d: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else out.set(rel, crypto.createHash("sha256").update(await fs.readFile(full)).digest("hex"));
    }
  }
  await walk(dir, "");
  return out;
}

function totalsOf(stdout: string): Record<string, number> {
  const m = stdout.match(/create: (\d+)\s+update: (\d+)\s+unchanged: (\d+)\s+preserve: (\d+)\s+remove: (\d+)/);
  if (!m) throw new Error(`totals line não encontrada em stdout:\n${stdout}`);
  return { create: Number(m[1]), update: Number(m[2]), unchanged: Number(m[3]), preserve: Number(m[4]), remove: Number(m[5]) };
}

/** Modo POSIX (últimos 3 dígitos octais) de cada path absoluto, indexado pelo próprio path. */
async function modesOf(paths: readonly string[]): Promise<Record<string, number>> {
  const entries = await Promise.all(paths.map(async (p) => [p, (await fs.stat(p)).mode & 0o777] as const));
  return Object.fromEntries(entries);
}

// ─── A ───────────────────────────────────────────────────────────────────

describe("A — install --dry-run é read-only, de qualquer cwd", () => {
  it("HOME vazio: exit 0, sem Greenfield/Brownfield, lista o plano, .nexos não existe no cwd, HOME e cwd inalterados", async () => {
    const { home, project } = await freshLab("p1-3i-a-empty-");
    const beforeHome = await snapshotTree(home);
    const beforeProject = await snapshotTree(project);

    const r = cli(project, home, ["install", "--dry-run"]);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Greenfield|Brownfield/);
    expect(r.stdout).toContain("agents/nexos-master.md");
    expect(r.stdout).toContain("settings.json");
    expect(await fs.pathExists(path.join(project, ".nexos"))).toBe(false);
    expect(await fs.pathExists(path.join(home, ".claude"))).toBe(false);
    expect(await snapshotTree(home)).toEqual(beforeHome);
    expect(await snapshotTree(project)).toEqual(beforeProject);
  });

  it("HOME pré-populado (instalação real já existe): dry-run continua read-only, mesmo texto sem Greenfield/Brownfield", async () => {
    const { home, project } = await freshLab("p1-3i-a-populated-");
    expect(cli(project, home, ["install"]).status).toBe(0);

    const beforeHome = await snapshotTree(home);
    const beforeProject = await snapshotTree(project);

    const r = cli(project, home, ["install", "--dry-run"]);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Greenfield|Brownfield/);
    expect(r.stdout).toContain("agents/nexos-master.md");
    expect(r.stdout).toContain("settings.json");
    expect(await fs.pathExists(path.join(project, ".nexos"))).toBe(false);
    expect(await snapshotTree(home)).toEqual(beforeHome);
    expect(await snapshotTree(project)).toEqual(beforeProject);
  });
});

// ─── B ───────────────────────────────────────────────────────────────────

describe("B — superfície de CLI reduzida a --dry-run", () => {
  it("install --help não menciona nenhuma opção/conceito removido", async () => {
    const { home, project } = await freshLab("p1-3i-b-help-");
    const r = cli(project, home, ["install", "--help"]);
    expect(r.status).toBe(0);
    for (const banned of [
      "Greenfield",
      "Brownfield",
      "--profile",
      "--advanced",
      "--yes",
      "--skip-skills",
      "--skip-hooks",
      "nextjs",
      "python",
      "fullstack",
    ]) {
      expect(r.stdout, `--help não deveria mencionar "${banned}"`).not.toContain(banned);
    }
  });

  it("install --yes e install --profile full são rejeitados (exit != 0), não aceitos em silêncio", async () => {
    const { home, project } = await freshLab("p1-3i-b-reject-");
    expect(cli(project, home, ["install", "--yes"]).status).not.toBe(0);
    expect(cli(project, home, ["install", "--profile", "full"]).status).not.toBe(0);
  });

  it("src/commands/install.ts não contém Greenfield/Brownfield/select/confirm/process.cwd", async () => {
    const src = await fs.readFile(path.join(repo, "src", "commands", "install.ts"), "utf-8");
    for (const banned of [/Greenfield/, /Brownfield/, /\bselect\b/, /\bconfirm\b/, /process\.cwd/]) {
      expect(src, `install.ts não deveria bater em ${banned}`).not.toMatch(banned);
    }
  });

  it("src/lib/profiles.ts não existe mais", async () => {
    expect(await fs.pathExists(path.join(repo, "src", "lib", "profiles.ts"))).toBe(false);
  });
});

// ─── C ───────────────────────────────────────────────────────────────────

describe("C — dry-run ignora o lifecycle do projeto (NO_PROJECT / NEW / HEALTHY)", () => {
  it("stdout idêntico em NO_PROJECT, NEW e HEALTHY sob o mesmo HOME; nenhuma fixture muda", async () => {
    const { classifyProjectLifecycleFor } = await import("../src/lib/capsule/project-lifecycle.js");
    const { initializeCapsule } = await import("../src/lib/capsule/initializer.js");

    const lab = await fs.mkdtemp(path.join(TMP_BASE, "p1-3i-c-"));
    const home = path.join(lab, "home");
    await fs.ensureDir(home);

    const noProject = path.join(lab, "no-project");
    const newProject = path.join(lab, "new-project");
    const healthyProject = path.join(lab, "healthy-project");
    await fs.ensureDir(noProject);
    await fs.ensureDir(newProject);
    await fs.ensureDir(healthyProject);

    await fs.writeJson(path.join(newProject, "package.json"), { name: "new-project" });

    await fs.writeJson(path.join(healthyProject, "package.json"), { name: "healthy-project" });
    await initializeCapsule(healthyProject, { projectName: "healthy-project" });

    // Prova a classificação real de cada fixture ANTES do dry-run.
    expect((await classifyProjectLifecycleFor(noProject)).situation).toBe("NO_PROJECT");
    expect((await classifyProjectLifecycleFor(newProject)).situation).toBe("NEW");
    expect((await classifyProjectLifecycleFor(healthyProject)).situation).toBe("HEALTHY");

    const beforeNoProject = await snapshotTree(noProject);
    const beforeNewProject = await snapshotTree(newProject);
    const beforeHealthyProject = await snapshotTree(healthyProject);

    const rNoProject = cli(noProject, home, ["install", "--dry-run"]);
    const rNew = cli(newProject, home, ["install", "--dry-run"]);
    const rHealthy = cli(healthyProject, home, ["install", "--dry-run"]);

    expect(rNoProject.status).toBe(0);
    expect(rNew.status).toBe(0);
    expect(rHealthy.status).toBe(0);
    expect(rNew.stdout).toBe(rNoProject.stdout);
    expect(rHealthy.stdout).toBe(rNoProject.stdout);

    // Nenhuma fixture muda com o dry-run.
    expect(await snapshotTree(noProject)).toEqual(beforeNoProject);
    expect(await snapshotTree(newProject)).toEqual(beforeNewProject);
    expect(await snapshotTree(healthyProject)).toEqual(beforeHealthyProject);

    // Classificação continua a mesma depois — dry-run não mexeu no lifecycle.
    expect((await classifyProjectLifecycleFor(noProject)).situation).toBe("NO_PROJECT");
    expect((await classifyProjectLifecycleFor(newProject)).situation).toBe("NEW");
    expect((await classifyProjectLifecycleFor(healthyProject)).situation).toBe("HEALTHY");
  });
});

// ─── D ───────────────────────────────────────────────────────────────────

describe("D — install real converge sobre um HOME com settings.json de usuário + hooks legados", () => {
  it("preserva customização do usuário, remove NexOS legado, projeta exatamente o asset", async () => {
    const { home, project } = await freshLab("p1-3i-d-");
    const claudeDir = path.join(home, ".claude");
    await fs.ensureDir(claudeDir);

    const legacySettings = {
      language: "english",
      env: { FOO: "bar" },
      permissions: { allow: ["Bash(ls)"] },
      theme: "dark",
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: `bash ${claudeDir}/hooks/nexos-permission-gate.sh` },
              { type: "command", command: "bash $HOME/.claude/hooks/my-own-guard.sh" },
            ],
          },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/my-own-startup.sh" }] }],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/nexos-memory-sync.sh" }] },
        ],
      },
    };
    await fs.writeJson(path.join(claudeDir, "settings.json"), legacySettings, { spaces: 2 });

    const r = cli(project, home, ["install"]);
    expect(r.status, r.stderr).toBe(0);

    // Todo arquivo de assets/{agents,skills,rules,hooks} presente com hash igual.
    for (const component of ["agents", "skills", "rules", "hooks"] as const) {
      const src = await hashDir(path.join(repo, "assets", component));
      const dest = await hashDir(path.join(claudeDir, component));
      expect(dest, component).toEqual(src);
    }

    expect(await fs.pathExists(path.join(claudeDir, "CLAUDE.md"))).toBe(true);
    expect(await fs.pathExists(path.join(claudeDir, "memory", "MEMORY.md"))).toBe(true);

    const written = await fs.readJson(path.join(claudeDir, "settings.json"));

    // Chaves não-hook do usuário intocadas.
    expect(written.language).toBe("english");
    expect(written.env).toEqual({ FOO: "bar" });
    expect(written.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(written.theme).toBe("dark");

    const flatWritten = flattenHooks(written.hooks);

    // Hooks do usuário preservados.
    expect(flatWritten.some((h) => h.command.includes("my-own-guard.sh"))).toBe(true);
    expect(flatWritten.some((h) => h.command.includes("my-own-startup.sh"))).toBe(true);

    // Handlers NexOS legados removidos.
    expect(flatWritten.some((h) => h.command.includes("nexos-permission-gate.sh"))).toBe(false);
    expect(flatWritten.some((h) => h.command.includes("nexos-memory-sync.sh"))).toBe(false);

    // Zero handler NexOS em PreToolUse (asset não declara nenhum).
    const preToolUseCommands = (flatWritten.filter((h) => h.event === "PreToolUse")).map((h) => h.command);
    expect(preToolUseCommands.every((c) => !c.includes(".claude/hooks/nexos-") && !c.trimStart().startsWith("nexos "))).toBe(
      true
    );

    // Conjunto de handlers NexOS-owned == asset resolvido, exato.
    const assetRaw = await fs.readFile(path.join(repo, "assets", "settings.json"), "utf-8");
    const assetResolved = JSON.parse(assetRaw.replace(/\$HOME/g, home)) as { hooks: Record<string, unknown> };
    const expectedNexosEntries = flattenHooks(assetResolved.hooks)
      .map((h) => `${h.event}::${h.command}`)
      .sort();
    const actualNexosEntries = flatWritten
      .filter((h) => h.command.includes(".claude/hooks/nexos-") || h.command.trimStart().startsWith("nexos "))
      .map((h) => `${h.event}::${h.command}`)
      .sort();
    expect(actualNexosEntries).toEqual(expectedNexosEntries);

    // Nenhum hooks.json/.claude-plugin criado; nenhuma .nexos no cwd.
    const allFiles = (await fs.readdir(claudeDir, { recursive: true }).catch(() => [] as string[])) as string[];
    expect(allFiles.filter((f) => f.endsWith("hooks.json") || f.includes(".claude-plugin"))).toEqual([]);
    expect(await fs.pathExists(path.join(project, ".nexos"))).toBe(false);

    // assets/settings.json (pacote) só declara hooks.
    const assetKeys = Object.keys(JSON.parse(assetRaw));
    expect(assetKeys).toEqual(["hooks"]);
  });
});

interface FlatHook {
  readonly event: string;
  readonly command: string;
}

function flattenHooks(hooks: unknown): FlatHook[] {
  const out: FlatHook[] = [];
  if (typeof hooks !== "object" || hooks === null) return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command = (handler as { command?: unknown }).command;
        if (typeof command === "string") out.push({ event, command });
      }
    }
  }
  return out;
}

// ─── E ───────────────────────────────────────────────────────────────────

describe("E — install duas vezes no mesmo HOME é convergente e idempotente", () => {
  it("2ª execução: zero create/update/remove; snapshot idêntico; nenhum handler duplicado", async () => {
    const { home, project } = await freshLab("p1-3i-e-");

    const first = cli(project, home, ["install"]);
    expect(first.status, first.stderr).toBe(0);

    const afterFirst = await snapshotTree(home);

    const second = cli(project, home, ["install"]);
    expect(second.status, second.stderr).toBe(0);

    const totals = totalsOf(second.stdout);
    expect(totals.create).toBe(0);
    expect(totals.update).toBe(0);
    expect(totals.remove).toBe(0);

    const afterSecond = await snapshotTree(home);
    expect(afterSecond).toEqual(afterFirst);

    // Nenhum backup em nenhuma das duas execuções: a 1ª é fresh (sem ~/.claude
    // prévio, backup só acontece com plano mutante E ~/.claude já existente);
    // a 2ª não tem operação mutante nenhuma.
    const backupsDir = path.join(home, ".claude", "backups");
    const backupsAfterBoth = (await fs.pathExists(backupsDir)) ? await fs.readdir(backupsDir) : [];
    expect(backupsAfterBoth).toEqual([]);

    // Nenhum handler duplicado: contagem de handlers do asset == contagem no settings.json escrito.
    const written = await fs.readJson(path.join(home, ".claude", "settings.json"));
    const assetRaw = await fs.readFile(path.join(repo, "assets", "settings.json"), "utf-8");
    const assetResolved = JSON.parse(assetRaw.replace(/\$HOME/g, home)) as { hooks: Record<string, unknown> };
    expect(flattenHooks(written.hooks)).toEqual(flattenHooks(assetResolved.hooks));
  });
});

// ─── G ───────────────────────────────────────────────────────────────────
//
// P1.3i-fix (chk_01M2NT7Q7QE93GM00VW5AAZG8M) — dois defeitos medidos em
// bbab2884: (1) chmod 755 aplicado a TODO .sh/.py/.js de ~/.claude/hooks/,
// destruindo o modo de arquivo de usuário; (2) backup do install copiava
// agents/skills/.../hooks/ inteiros e travava em QUALQUER symlink em
// qualquer lugar dessas árvores — inclusive um totalmente alheio ao que o
// plano ia tocar (ex.: symlink real do dono em ~/.claude/skills/cua-driver).

describe("G — backup e chmod escopados ao plano (P1.3i-fix)", () => {
  it("(a) modos 644/600 de hooks do usuário ficam intactos depois do install", async () => {
    const { home, project } = await freshLab("p1-3i-g-a-");
    const hooksDir = path.join(home, ".claude", "hooks");
    await fs.ensureDir(hooksDir);
    const guard = path.join(hooksDir, "user-guard.sh");
    const tool = path.join(hooksDir, "user-tool.py");
    await fs.writeFile(guard, "#!/bin/sh\necho guard\n");
    await fs.writeFile(tool, "print('tool')\n");
    await fs.chmod(guard, 0o644);
    await fs.chmod(tool, 0o600);

    const r = cli(project, home, ["install"]);
    expect(r.status, r.stderr).toBe(0);

    expect((await fs.stat(guard)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(tool)).mode & 0o777).toBe(0o600);
  });

  it("(b) symlink de usuário fora do que o plano toca: exit 0, superfície instalada, symlink intacto", async () => {
    const { home, project } = await freshLab("p1-3i-g-b-");
    const claudeDir = path.join(home, ".claude");
    await fs.ensureDir(path.join(claudeDir, "skills"));
    // settings.json pré-existente força pelo menos um op "update" — o
    // gatilho de backup real, mesmo cenário do repro do master.
    await fs.writeJson(path.join(claudeDir, "settings.json"), { hooks: {} }, { spaces: 2 });

    const externalTarget = path.join(home, "external-cua-driver");
    await fs.ensureDir(externalTarget);
    await fs.writeFile(path.join(externalTarget, "marker.txt"), "de fora");
    const symlinkPath = path.join(claudeDir, "skills", "cua-driver");
    await fs.symlink(externalTarget, symlinkPath, "dir");

    const r = cli(project, home, ["install"]);
    expect(r.status, r.stderr).toBe(0);

    const linkStat = await fs.lstat(symlinkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(await fs.realpath(symlinkPath)).toBe(await fs.realpath(externalTarget));
    expect(await fs.pathExists(path.join(symlinkPath, "marker.txt"))).toBe(true);

    // Superfície instalada de verdade — o install não abortou.
    expect(await fs.pathExists(path.join(claudeDir, "agents", "nexos-dev.md"))).toBe(true);
    expect(await fs.pathExists(path.join(claudeDir, "CLAUDE.md"))).toBe(true);
  });

  it("(c) symlink num path que o plano sobrescreveria: exit != 0, zero escrita, nenhum backups/ criado", async () => {
    const { home, project } = await freshLab("p1-3i-g-c-");
    const claudeDir = path.join(home, ".claude");
    await fs.ensureDir(claudeDir);

    // Conteúdo que diverge da projeção do asset -> settings.json vira "update".
    const realSettingsFile = path.join(home, "real-settings.json");
    await fs.writeJson(realSettingsFile, { hooks: {} }, { spaces: 2 });
    await fs.symlink(realSettingsFile, path.join(claudeDir, "settings.json"));

    const before = await snapshotTree(home);

    const r = cli(project, home, ["install"]);

    expect(r.status).not.toBe(0);
    expect(await fs.pathExists(path.join(claudeDir, "backups"))).toBe(false);
    expect(await snapshotTree(home)).toEqual(before);
  });

  it("(d) 2ª execução: sem backup novo, modo do arquivo de usuário continua intacto", async () => {
    const { home, project } = await freshLab("p1-3i-g-d-");
    const hooksDir = path.join(home, ".claude", "hooks");
    await fs.ensureDir(hooksDir);
    const guard = path.join(hooksDir, "user-guard.sh");
    await fs.writeFile(guard, "#!/bin/sh\necho guard\n");
    await fs.chmod(guard, 0o644);

    const first = cli(project, home, ["install"]);
    expect(first.status, first.stderr).toBe(0);
    expect((await fs.stat(guard)).mode & 0o777).toBe(0o644);

    const second = cli(project, home, ["install"]);
    expect(second.status, second.stderr).toBe(0);

    const totals = totalsOf(second.stdout);
    expect(totals.update).toBe(0);
    expect(totals.remove).toBe(0);

    expect((await fs.stat(guard)).mode & 0o777).toBe(0o644);

    const backupsDir = path.join(home, ".claude", "backups");
    const backups = (await fs.pathExists(backupsDir)) ? await fs.readdir(backupsDir) : [];
    expect(backups).toEqual([]);
  });
});

// ─── F ───────────────────────────────────────────────────────────────────
//
// Em processo (não subprocesso): um `p.confirm()` interativo não tem como
// ser cancelado de fora sem TTY. Mocka `@clack/prompts` para devolver o
// símbolo de cancel, e `detector.js`/`backup.js` para nunca tocar disco.

const CANCEL = Symbol("install-environment-boundary:mock-cancel");
const createBackupMock = vi.fn(async () => "/should/not/be/called");

vi.mock("../src/lib/detector.js", () => ({
  detectExistingInstall: vi.fn(async () => ({
    exists: true,
    version: "6.3.2",
    installedAt: "2026-01-01T00:00:00.000Z",
    components: { agents: 5, skills: 116, rules: 6, hooks: 10 },
    hasClaudeMd: true,
    hasSettings: true,
  })),
  detectClaudeCode: vi.fn(async () => true),
}));

vi.mock("../src/lib/backup.js", () => ({
  createBackup: createBackupMock,
  restoreBackup: vi.fn(async () => undefined),
  listBackups: vi.fn(async () => []),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  confirm: vi.fn(async () => CANCEL),
  isCancel: (value: unknown) => value === CANCEL,
}));

describe("F — nexos uninstall com confirm cancelado", () => {
  beforeEach(() => {
    createBackupMock.mockClear();
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("exit 130 (não 0), zero escrita (sem backup, marker intacto)", async () => {
    const removeSpy = vi.spyOn(fs, "remove");
    const { uninstall } = await import("../src/commands/uninstall.js");

    await uninstall();

    expect(process.exitCode).toBe(130);
    expect(createBackupMock).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();
  });

  it("grep estrutural: zero `process.exit(0)` em src/", async () => {
    const files = await listTsFiles(path.join(repo, "src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      expect(content, path.relative(repo, file)).not.toContain("process.exit(0)");
    }
  });
});

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ─── H ───────────────────────────────────────────────────────────────────
//
// P1.3i-fix3 (chk_01M2NX3YET1SRDGA4E7MSST2QT) — dois defeitos medidos depois
// de bbab2884: (1) `planAssetComponent` gravava `destHash` no ramo
// `preserve`, afirmando no ledger que o NexOS escreveu o conteúdo do
// usuário; o próximo plano lia essa afirmação como "bate com o manifesto
// anterior" e promovia para `update` — sobrescrevendo a customização na
// instalação seguinte. (2) o loop de chmod 755 do install alcançava hooks
// `preserve` — um hook NexOS-owned cujo CONTEÚDO o usuário customizou tinha
// o MODO revertido para 755 mesmo sem o conteúdo ser tocado.

describe("H — install converge com PRESERVE e ledger em ponto fixo (P1.3i-fix3)", () => {
  const CUSTOM_KEYS = [
    "agents/nexos-analyst.md",
    "agents/nexos-architect.md",
    "agents/nexos-dev.md",
    "agents/nexos-master.md",
    "skills/development--verification-before-completion/SKILL.md",
    "skills/nexos-handoff/SKILL.md",
    "skills/productivity--requirements-clarity/SKILL.md",
    "skills/workflow-automation--yeet/SKILL.md",
    "rules/mechanical-verification.md",
    "rules/tool-usage.md",
  ];
  const CUSTOM_HOOK = "hooks/nexos-session-close.sh";

  it("PRESERVE nunca vira UPDATE, hashes chega a fixed point, hook customizado não perde o modo, hook/symlink alheios ficam intactos, settings.json fica no ponto fixo da projeção", async () => {
    const { home, project } = await freshLab("p1-3i-h-");
    const claudeDir = path.join(home, ".claude");

    // 1) instalação legítima de base.
    const baseline = cli(project, home, ["install"]);
    expect(baseline.status, baseline.stderr).toBe(0);

    // 2) usuário customiza conteúdo de 10 assets + o hook NexOS-owned, e
    //    derruba o modo do hook customizado para 644 (nunca deve voltar a 755).
    for (const key of CUSTOM_KEYS) {
      await fs.appendFile(path.join(claudeDir, key), "\n<!-- customizacao do usuario -->\n");
    }
    const hookDest = path.join(claudeDir, CUSTOM_HOOK);
    await fs.appendFile(hookDest, "\n# customizacao do usuario\n");
    await fs.chmod(hookDest, 0o644);

    // Os 11 paths PRESERVE (10 assets + o hook) — modo capturado aqui prova
    // que NENHUM dos 11, não só os hooks, tem o modo tocado pelo install.
    const preservedPaths = [...CUSTOM_KEYS.map((key) => path.join(claudeDir, key)), hookDest];

    // 3) hook alheio ao pacote — nunca aparece em plan.ops; controle negativo.
    const foreignHook = path.join(claudeDir, "hooks", "my-own-hook.sh");
    await fs.writeFile(foreignHook, "#!/bin/sh\necho mine\n");
    await fs.chmod(foreignHook, 0o600);

    // 4) symlink alheio dentro de skills/ — nunca tocado pelo plano.
    const externalFile = path.join(home, "external-note.md");
    await fs.writeFile(externalFile, "nota externa\n");
    const symlinkPath = path.join(claudeDir, "skills", "my-own-link.md");
    await fs.symlink(externalFile, symlinkPath);

    // 5) settings.json: chave de usuário + hook próprio no MESMO evento que o
    //    NexOS usa (Stop), já na posição que É o ponto fixo da projeção —
    //    grupo do usuário antes, grupo do NexOS depois (exatamente o que
    //    `projectHooksSettings` produz: strip + reapêndice no fim).
    const settingsPath = path.join(claudeDir, "settings.json");
    const settings = await fs.readJson(settingsPath);
    settings.customUserPref = "mantido";
    const userStopGroup = { hooks: [{ type: "command", command: `bash ${claudeDir}/hooks/my-own-hook.sh` }] };
    settings.hooks.Stop = [userStopGroup, ...settings.hooks.Stop];
    await fs.writeJson(settingsPath, settings, { spaces: 2 });

    const beforeInstall = await snapshotTree(home);
    const modesBeforeDry1 = await modesOf(preservedPaths);

    // -- dry-run #1: os 11 arquivos customizados viram preserve; zero mutação.
    const dry1 = cli(project, home, ["install", "--dry-run"]);
    expect(dry1.status, dry1.stderr).toBe(0);
    const totalsDry1 = totalsOf(dry1.stdout);
    expect(totalsDry1.preserve).toBe(11);
    expect(totalsDry1.update).toBe(0);
    expect(dry1.stdout).toMatch(/unchanged\s+\.nexos-hashes\.json/);
    expect(await snapshotTree(home)).toEqual(beforeInstall);

    // -- install real: preserve não escreve nada; settings.json já é o ponto fixo.
    const install2 = cli(project, home, ["install"]);
    expect(install2.status, install2.stderr).toBe(0);

    const afterInstall = await snapshotTree(home);
    expect(afterInstall).toEqual(beforeInstall);

    expect((await fs.stat(hookDest)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(foreignHook)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(symlinkPath)).toBe(await fs.realpath(externalFile));
    expect(await fs.readJson(settingsPath)).toEqual(settings);
    expect(await modesOf(preservedPaths)).toEqual(modesBeforeDry1);

    // -- dry-run #2: zero create/update/remove — fixed point provado.
    const dry2 = cli(project, home, ["install", "--dry-run"]);
    expect(dry2.status, dry2.stderr).toBe(0);
    const totalsDry2 = totalsOf(dry2.stdout);
    expect(totalsDry2.create).toBe(0);
    expect(totalsDry2.update).toBe(0);
    expect(totalsDry2.remove).toBe(0);
    expect(dry2.stdout).toMatch(/unchanged\s+\.nexos-hashes\.json/);

    // -- 2ª instalação real: sem backup novo, snapshot (sha+mtime) idêntico,
    //    modo do hook customizado e do hook/symlink alheios seguem intactos.
    const backupsDir = path.join(claudeDir, "backups");
    const backupsBefore = (await fs.pathExists(backupsDir)) ? await fs.readdir(backupsDir) : [];

    const install3 = cli(project, home, ["install"]);
    expect(install3.status, install3.stderr).toBe(0);

    const backupsAfter = (await fs.pathExists(backupsDir)) ? await fs.readdir(backupsDir) : [];
    expect(backupsAfter).toEqual(backupsBefore);
    expect(await snapshotTree(home)).toEqual(afterInstall);
    expect((await fs.stat(hookDest)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(foreignHook)).mode & 0o777).toBe(0o600);
    expect(await modesOf(preservedPaths)).toEqual(modesBeforeDry1);
  });

  it("HOME sem .nexos-hashes.json: 10 assets pré-existentes customizados nunca entram no ledger e ficam PRESERVE (P1.3i-fix3, cenário S2 do repro)", async () => {
    const { home, project } = await freshLab("p1-3i-h-noledger-");
    const claudeDir = path.join(home, ".claude");
    const hashesPath = path.join(claudeDir, ".nexos-hashes.json");

    // Usuário já tinha esses 10 arquivos no lugar por conta própria — nunca
    // passaram por um `nexos install`, então não existe ledger nenhum.
    for (const key of CUSTOM_KEYS) {
      const dest = path.join(claudeDir, key);
      await fs.ensureDir(path.dirname(dest));
      await fs.copy(path.join(repo, "assets", key), dest);
      await fs.appendFile(dest, "\n<!-- customizacao do usuario -->\n");
    }
    expect(await fs.pathExists(hashesPath)).toBe(false);

    const beforeContent = new Map(
      await Promise.all(
        CUSTOM_KEYS.map(async (key) => [key, await fs.readFile(path.join(claudeDir, key), "utf-8")] as const)
      )
    );

    // -- dry-run #1: os 10 já nascem preserve (destHash != srcHash, sem manifesto anterior).
    const dry1 = cli(project, home, ["install", "--dry-run"]);
    expect(dry1.status, dry1.stderr).toBe(0);
    expect(totalsOf(dry1.stdout).preserve).toBe(10);
    expect(await fs.pathExists(hashesPath)).toBe(false);

    // -- install real: cria o resto do pacote, mas os 10 continuam preserve.
    const install = cli(project, home, ["install"]);
    expect(install.status, install.stderr).toBe(0);

    for (const key of CUSTOM_KEYS) {
      expect(await fs.readFile(path.join(claudeDir, key), "utf-8"), key).toBe(beforeContent.get(key));
    }

    // O ledger recém-criado NÃO afirma nada sobre os 10 — o NexOS não os escreveu.
    const ledger = await fs.readJson(hashesPath);
    for (const key of CUSTOM_KEYS) {
      expect(Object.hasOwn(ledger, key), key).toBe(false);
    }

    // -- dry-run #2: zero create/update/remove — fixed point mesmo sem ledger prévio.
    const dry2 = cli(project, home, ["install", "--dry-run"]);
    expect(dry2.status, dry2.stderr).toBe(0);
    const totals2 = totalsOf(dry2.stdout);
    expect(totals2.create).toBe(0);
    expect(totals2.update).toBe(0);
    expect(totals2.remove).toBe(0);
    expect(totals2.preserve).toBe(10);
    expect(dry2.stdout).toMatch(/unchanged\s+\.nexos-hashes\.json/);
  });
});
