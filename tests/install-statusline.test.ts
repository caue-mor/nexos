/**
 * nexos://decision/statusline-global-terminal-observability,
 * nexos://decision/statusline-renderer-escolha — `nexos install` é dono
 * único de `statusLine` em `~/.claude/settings.json`, com preservação de
 * configuração alheia. Mesmo mecanismo de subprocesso de
 * `install-environment-boundary.test.ts` (`spawnSync`, `env.HOME` isolado,
 * loader tsx) — nunca toca `~/.claude` real.
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
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

/** Comando esperado: `node` via PATH (nunca process.execPath fixado — knw_01M2QS5WSTJBSB1CJ6W55NZMAJ) + caminho instalado do renderer. */
function expectedCommand(home: string): string {
  const rendererPath = path.join(home, ".claude", "statusline", "nexos-statusline.mjs");
  return `${tapCommand(home)} | node ${quote(rendererPath)}`;
}

/**
 * Derivação do aviso de contexto na frente de qualquer renderer
 * (nexos://decision/aviso-de-contexto-por-statusline). `|| cat` (MEDIUM #6,
 * rodada 3): `node`/tap ausente não pode fechar o pipe e deixar o renderer
 * (o NexOS ou o de outro dono) lendo EOF — ver `installer.test.ts` para a
 * prova em bash de verdade do fallback.
 */
function tapCommand(home: string): string {
  return `{ node ${quote(path.join(home, ".claude", "statusline", "nexos-context-tap.mjs"))} || cat; }`;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

describe("nexos install — statusLine ausente", () => {
  it("dry-run mostra o op do renderer; install real cria statusLine com node absoluto + caminho do renderer", async () => {
    const { home, project } = await freshLab("statusline-create-");

    const dry = cli(project, home, ["install", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/create\s+statusline\/nexos-statusline\.mjs/);
    expect(await fs.pathExists(path.join(home, ".claude"))).toBe(false);

    const real = cli(project, home, ["install"]);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).not.toMatch(/Conflito/);

    const rendererDest = path.join(home, ".claude", "statusline", "nexos-statusline.mjs");
    expect(await fs.pathExists(rendererDest)).toBe(true);
    const rendererSrc = await fs.readFile(path.join(repo, "assets", "statusline", "nexos-statusline.mjs"), "utf-8");
    expect(await fs.readFile(rendererDest, "utf-8")).toBe(rendererSrc);

    const settings = await fs.readJson(path.join(home, ".claude", "settings.json"));
    expect(settings.statusLine).toEqual({ type: "command", command: expectedCommand(home) });
  });

  it("segunda instalação é no-op — zero create/update/remove, conteúdo idêntico", async () => {
    const { home, project } = await freshLab("statusline-idempotent-");
    expect(cli(project, home, ["install"]).status).toBe(0);
    const settingsBefore = await fs.readJson(path.join(home, ".claude", "settings.json"));

    const second = cli(project, home, ["install"]);
    expect(second.status, second.stderr).toBe(0);
    const totals = second.stdout.match(/create: (\d+)\s+update: (\d+)\s+unchanged: (\d+)\s+preserve: (\d+)\s+remove: (\d+)/);
    if (!totals) throw new Error(`totals não encontrados em:\n${second.stdout}`);
    expect(Number(totals[1])).toBe(0); // create
    expect(Number(totals[2])).toBe(0); // update
    expect(Number(totals[5])).toBe(0); // remove

    const settingsAfter = await fs.readJson(path.join(home, ".claude", "settings.json"));
    expect(settingsAfter).toEqual(settingsBefore);
  });
});

describe("nexos install — statusLine já NexOS-owned", () => {
  it("comando divergente (versão anterior) é ressincronizado para o comando exato atual", async () => {
    const { home, project } = await freshLab("statusline-resync-");
    expect(cli(project, home, ["install"]).status).toBe(0);

    const settingsPath = path.join(home, ".claude", "settings.json");
    const settings = await fs.readJson(settingsPath);
    const rendererPath = path.join(home, ".claude", "statusline", "nexos-statusline.mjs");
    settings.statusLine = { type: "command", command: `"/opt/old-node" ${quote(rendererPath)}`, padding: 3 };
    await fs.writeJson(settingsPath, settings, { spaces: 2 });

    const r = cli(project, home, ["install"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/Conflito/);

    const written = await fs.readJson(settingsPath);
    expect(written.statusLine).toEqual({ type: "command", command: expectedCommand(home) });
  });
});

describe("nexos install — statusLine de outro dono", () => {
  it("renderer alheio preservado depois da derivação, reporta conflito em dry-run E install real", async () => {
    const { home, project } = await freshLab("statusline-conflict-");
    const claudeDir = path.join(home, ".claude");
    await fs.ensureDir(claudeDir);
    const foreignStatusLine = { type: "command", command: "~/.claude/statusline.sh", padding: 2 };
    await fs.writeJson(
      path.join(claudeDir, "settings.json"),
      { theme: "dark", statusLine: foreignStatusLine, hooks: {} },
      { spaces: 2 }
    );

    const dry = cli(project, home, ["install", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/Conflito.*statusLine/);
    expect(dry.stdout).toContain("~/.claude/statusline.sh");

    const real = cli(project, home, ["install"]);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).toMatch(/Conflito.*statusLine/);
    expect(real.stdout).toContain("~/.claude/statusline.sh");

    const written = await fs.readJson(path.join(claudeDir, "settings.json"));
    expect(written.statusLine).toEqual({ ...foreignStatusLine, command: `${tapCommand(home)} | { ~/.claude/statusline.sh\n}` });
    expect(written.theme).toBe("dark"); // chave alheia fora de statusLine/hooks intocada

    // O renderer AINDA é instalado — preservar o dono do statusLine não bloqueia o resto da superfície.
    expect(await fs.pathExists(path.join(claudeDir, "statusline", "nexos-statusline.mjs"))).toBe(true);
    expect(await fs.pathExists(path.join(claudeDir, "statusline", "nexos-context-tap.mjs"))).toBe(true);
  });

  it("2ª instalação sobre conflito não duplica a derivação nem converge para o renderer NexOS", async () => {
    const { home, project } = await freshLab("statusline-conflict-repeat-");
    const claudeDir = path.join(home, ".claude");
    await fs.ensureDir(claudeDir);
    const foreignStatusLine = { type: "command", command: "/opt/other-tool/statusline" };
    await fs.writeJson(path.join(claudeDir, "settings.json"), { statusLine: foreignStatusLine, hooks: {} }, { spaces: 2 });

    expect(cli(project, home, ["install"]).status).toBe(0);
    const second = cli(project, home, ["install"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/Conflito.*statusLine/);

    const written = await fs.readJson(path.join(claudeDir, "settings.json"));
    expect(written.statusLine).toEqual({ type: "command", command: `${tapCommand(home)} | { /opt/other-tool/statusline\n}` });
  });
});

describe("nexos install — statusLine + hooks + chaves arbitrárias no mesmo settings.json", () => {
  it("chaves arbitrárias, hook alheio e statusLine alheio sobrevivem byte a byte; só statusLine/hooks NexOS mudam", async () => {
    const { home, project } = await freshLab("statusline-combined-");
    const claudeDir = path.join(home, ".claude");
    await fs.ensureDir(claudeDir);

    const foreignStatusLine = { type: "command", command: "/opt/other-tool/statusline", padding: 4 };
    const settingsBefore = {
      language: "english",
      env: { FOO: "bar" },
      theme: "dark",
      statusLine: foreignStatusLine,
      hooks: {
        SomeEvent: [{ hooks: [{ type: "command", command: "keep-me-exactly" }] }],
      },
    };
    await fs.writeJson(path.join(claudeDir, "settings.json"), settingsBefore, { spaces: 2 });

    const r = cli(project, home, ["install"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Conflito.*statusLine/);

    const written = await fs.readJson(path.join(claudeDir, "settings.json"));

    // Fora de statusLine/hooks — intocado.
    expect(written.language).toBe("english");
    expect(written.env).toEqual({ FOO: "bar" });
    expect(written.theme).toBe("dark");

    // statusLine de outro dono — renderer e padding intactos, derivação na frente.
    expect(written.statusLine).toEqual({ ...foreignStatusLine, command: `${tapCommand(home)} | { /opt/other-tool/statusline\n}` });

    // Hook alheio, em evento que o asset NexOS não usa — preservado.
    expect(written.hooks.SomeEvent).toEqual(settingsBefore.hooks.SomeEvent);

    // Hooks NexOS foram adicionados por cima (superfície normal do pacote).
    const assetRaw = await fs.readFile(path.join(repo, "assets", "settings.json"), "utf-8");
    const assetHooks = JSON.parse(assetRaw.replace(/\$HOME/g, home)) as { hooks: Record<string, unknown> };
    for (const event of Object.keys(assetHooks.hooks)) {
      expect(written.hooks[event], event).toBeDefined();
    }
  });
});

describe("nexos install — backup escopado quando statusLine muda o settings.json", () => {
  it("statusLine divergente (NexOS-owned) força backup de settings.json antes da escrita", async () => {
    const { home, project } = await freshLab("statusline-backup-");
    expect(cli(project, home, ["install"]).status).toBe(0);

    const settingsPath = path.join(home, ".claude", "settings.json");
    const settings = await fs.readJson(settingsPath);
    const rendererPath = path.join(home, ".claude", "statusline", "nexos-statusline.mjs");
    settings.statusLine = { type: "command", command: `"/opt/old-node" ${quote(rendererPath)}` };
    await fs.writeJson(settingsPath, settings, { spaces: 2 });

    const backupsDir = path.join(home, ".claude", "backups");
    const before = (await fs.pathExists(backupsDir)) ? await fs.readdir(backupsDir) : [];

    const r = cli(project, home, ["install"]);
    expect(r.status, r.stderr).toBe(0);

    const after = await fs.readdir(backupsDir);
    expect(after.length).toBeGreaterThan(before.length);
  });
});
