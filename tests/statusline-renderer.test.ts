/**
 * nexos://decision/statusline-global-terminal-observability,
 * nexos://decision/statusline-renderer-escolha — `assets/statusline/nexos-statusline.mjs`
 * é copiado byte a byte para `~/.claude/statusline/` (installer.ts,
 * `planAssetComponent`), então testar o arquivo do pacote testa exatamente
 * o que roda instalado. Zero dependências: exercitado via `spawnSync` puro,
 * nunca importado como módulo (ele nem é parte do grafo TS do pacote).
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const RENDERER = path.resolve(__dirname, "..", "assets", "statusline", "nexos-statusline.mjs");
const TMP_BASE = fs.realpathSync(os.tmpdir());

/**
 * `CLAUDE_CONFIG_DIR` SEMPRE isolado (default: `TMP_BASE`, garantidamente
 * sem `.ponytail-active`) — sem isto, o renderer leria o flag REAL da
 * própria sessão (`~/.claude/.ponytail-active`, presente e "full" nesta
 * máquina) e todo cenário sem ponytail explícito ficaria não-determinístico.
 */
function run(
  payload: unknown,
  cwd?: string,
  envOverride?: Record<string, string | undefined>
): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [RENDERER], {
    input: payload === undefined ? "" : JSON.stringify(payload),
    encoding: "utf8",
    cwd: cwd ?? TMP_BASE,
    env: { ...process.env, NO_COLOR: "1", CLAUDE_CONFIG_DIR: TMP_BASE, ...envOverride },
    timeout: 5000,
  });
  return { stdout: r.stdout, status: r.status };
}

async function freshDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(TMP_BASE, prefix));
}

async function makeGitRepo(dir: string, branch = "main"): Promise<void> {
  await fs.ensureDir(path.join(dir, ".git"));
  await fs.writeFile(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

async function makeNexosProject(dir: string, projectName: string): Promise<void> {
  await fs.ensureDir(path.join(dir, ".nexos"));
  await fs.writeFile(
    path.join(dir, ".nexos", "manifest.yaml"),
    `capsule:\n  format_version: 1\nproject:\n  id: prj_test\n  name: ${projectName}\nschema_version: 1\nscope: project\n`
  );
}

async function writeSnapshot(dir: string, snapshot: Record<string, unknown>): Promise<void> {
  const dest = path.join(dir, ".nexos", ".local", "runtime", "statusline.json");
  await fs.ensureDir(path.dirname(dest));
  await fs.writeJson(dest, snapshot);
}

describe("nexos-statusline.mjs — cenário 1: com NexOS + git, snapshot presente", () => {
  it("linha 1: modelo/effort/ctx/duração/5h; linha 2: branch · NexOS <nome> · <checkpoint_state> · <título>", async () => {
    const dir = await freshDir("sl-c1-");
    await makeGitRepo(dir, "feature/statusline");
    await makeNexosProject(dir, "meu-projeto");
    await writeSnapshot(dir, {
      project_name: "meu-projeto",
      checkpoint_state: "RUNNING",
      state_title: "implementando statusline global",
      generated_at: "2026-09-17T10:00:00.000Z",
    });

    const { stdout, status } = run(
      {
        model: { display_name: "Sonnet 5" },
        effort: { level: "high" },
        context_window: { used_percentage: 8, context_window_size: 200000 },
        cost: { total_duration_ms: 125000 },
        rate_limits: { five_hour: { used_percentage: 23.5 } },
        cwd: dir,
        workspace: { current_dir: dir, project_dir: dir },
      },
      dir
    );

    expect(status).toBe(0);
    expect(stdout).toBe(
      "Sonnet 5 · high · ctx 8% de 200k · 2m5s · 5h 24%\n" +
        "feature/statusline · NexOS meu-projeto · RUNNING · implementando statusline global\n"
    );
  });
});

describe("nexos-statusline.mjs — cenário 2: sem NexOS, com git, context_window null", () => {
  it("ctx UNKNOWN nunca vira 0; segunda linha só a branch", async () => {
    const dir = await freshDir("sl-c2-");
    await makeGitRepo(dir, "main");

    const { stdout, status } = run({
      model: { display_name: "Opus" },
      context_window: { used_percentage: null },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
    });

    expect(status).toBe(0);
    expect(stdout).toBe("Opus · ctx UNKNOWN\nmain\n");
  });
});

describe("nexos-statusline.mjs — cenário 3: com NexOS (sem snapshot ainda), sem git", () => {
  it("fallback 'NexOS <nome do manifest>', sem linha de branch", async () => {
    const dir = await freshDir("sl-c3-");
    await makeNexosProject(dir, "outro-projeto");

    const { stdout, status } = run({
      model: { display_name: "Haiku" },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
    });

    expect(status).toBe(0);
    expect(stdout).toBe("Haiku · ctx UNKNOWN\nNexOS outro-projeto\n");
  });
});

describe("nexos-statusline.mjs — cenário 4: sem NexOS, sem git", () => {
  it("só a linha 1 — segunda linha vazia é omitida por completo", async () => {
    const dir = await freshDir("sl-c4-");

    const { stdout, status } = run({
      model: { display_name: "Sonnet 5" },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
    });

    expect(status).toBe(0);
    expect(stdout).toBe("Sonnet 5 · ctx UNKNOWN\n");
  });
});

describe("nexos-statusline.mjs — segmento Ponytail (requisito do dono: só existe se o flag existir)", () => {
  it("flag ausente — segmento some por completo, sem 'PONYTAIL:OFF'", async () => {
    const dir = await freshDir("sl-pt-absent-");
    const configDir = await freshDir("sl-pt-absent-config-");

    const { stdout, status } = run(
      { model: { display_name: "Sonnet 5" }, workspace: { current_dir: dir, project_dir: dir } },
      dir,
      { CLAUDE_CONFIG_DIR: configDir }
    );

    expect(status).toBe(0);
    expect(stdout).toBe("Sonnet 5 · ctx UNKNOWN\n");
    expect(stdout).not.toContain("PONYTAIL");
  });

  it("flag = 'full' (ou vazio) — badge é 'PONYTAIL', sem sufixo de modo", async () => {
    const dir = await freshDir("sl-pt-full-");
    const configDir = await freshDir("sl-pt-full-config-");
    await fs.writeFile(path.join(configDir, ".ponytail-active"), "full");

    const { stdout, status } = run(
      { model: { display_name: "Sonnet 5" }, workspace: { current_dir: dir, project_dir: dir } },
      dir,
      { CLAUDE_CONFIG_DIR: configDir }
    );

    expect(status).toBe(0);
    expect(stdout).toBe("Sonnet 5 · ctx UNKNOWN\nPONYTAIL\n");
  });

  it("flag vazio (arquivo existe, 1ª linha vazia) — badge é 'PONYTAIL'", async () => {
    const dir = await freshDir("sl-pt-empty-");
    const configDir = await freshDir("sl-pt-empty-config-");
    await fs.writeFile(path.join(configDir, ".ponytail-active"), "");

    const { stdout, status } = run(
      { model: { display_name: "Sonnet 5" }, workspace: { current_dir: dir, project_dir: dir } },
      dir,
      { CLAUDE_CONFIG_DIR: configDir }
    );

    expect(status).toBe(0);
    expect(stdout).toBe("Sonnet 5 · ctx UNKNOWN\nPONYTAIL\n");
  });

  it("flag = 'ultra' — badge é 'PONYTAIL:ULTRA'", async () => {
    const dir = await freshDir("sl-pt-ultra-");
    const configDir = await freshDir("sl-pt-ultra-config-");
    await fs.writeFile(path.join(configDir, ".ponytail-active"), "ultra");

    const { stdout, status } = run(
      { model: { display_name: "Sonnet 5" }, workspace: { current_dir: dir, project_dir: dir } },
      dir,
      { CLAUDE_CONFIG_DIR: configDir }
    );

    expect(status).toBe(0);
    expect(stdout).toBe("Sonnet 5 · ctx UNKNOWN\nPONYTAIL:ULTRA\n");
  });

  it("flag ilegível (diretório no lugar do arquivo) — segmento some, exit 0, sem crash", async () => {
    const dir = await freshDir("sl-pt-illegible-");
    const configDir = await freshDir("sl-pt-illegible-config-");
    await fs.ensureDir(path.join(configDir, ".ponytail-active")); // arquivo esperado, é diretório

    const { stdout, status } = run(
      { model: { display_name: "Sonnet 5" }, workspace: { current_dir: dir, project_dir: dir } },
      dir,
      { CLAUDE_CONFIG_DIR: configDir }
    );

    expect(status).toBe(0);
    expect(stdout).not.toContain("PONYTAIL");
  });

  it("lido via fs, nunca spawn — grep estrutural por child_process/execSync/spawnSync no renderer", async () => {
    const src = await fs.readFile(RENDERER, "utf-8");
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/\bexecSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(/);
  });

  it("sem cor quando NO_COLOR — badge não carrega ANSI próprio", async () => {
    const dir = await freshDir("sl-pt-color-");
    const configDir = await freshDir("sl-pt-color-config-");
    await fs.writeFile(path.join(configDir, ".ponytail-active"), "full");

    const r = spawnSync(process.execPath, [RENDERER], {
      input: JSON.stringify({ model: { display_name: "Sonnet 5" }, workspace: { current_dir: dir, project_dir: dir } }),
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", CLAUDE_CONFIG_DIR: configDir },
      timeout: 5000,
    });

    expect(r.status).toBe(0);
    expect(r.stdout.includes(`${String.fromCharCode(27)}[`)).toBe(false); // ESC — sem regex de caractere de controle
    expect(r.stdout).toContain("PONYTAIL");
  });
});

describe("nexos-statusline.mjs — robustez", () => {
  it("stdin vazio — nunca lança, modelo cai para UNKNOWN, exit 0", () => {
    const { stdout, status } = run(undefined);
    expect(status).toBe(0);
    expect(stdout).toBe("UNKNOWN · ctx UNKNOWN\n");
  });

  it("snapshot corrompido — silencioso (nenhum segmento NexOS), exit 0, sem crash", async () => {
    const dir = await freshDir("sl-corrupt-");
    await makeNexosProject(dir, "p");
    const dest = path.join(dir, ".nexos", ".local", "runtime", "statusline.json");
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, "{ isso nao e json");

    const { stdout, status } = run({
      model: { display_name: "Sonnet 5" },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
    });

    expect(status).toBe(0);
    expect(stdout).toBe("Sonnet 5 · ctx UNKNOWN\n"); // segmento NexOS ausente — silencioso, sem crash
  });

  it("effort ausente — omite o segmento inteiro, nunca imprime 'UNKNOWN' pra um conceito que não existe", () => {
    const { stdout } = run({ model: { display_name: "Sonnet 5" }, context_window: { used_percentage: 50, context_window_size: 200000 } });
    expect(stdout).toBe("Sonnet 5 · ctx 50% de 200k\n");
    expect(stdout).not.toContain("effort");
  });

  it("rate_limits ausente — omite '5h', nunca mostra UNKNOWN para ele", () => {
    const { stdout } = run({ model: { display_name: "Sonnet 5" } });
    expect(stdout).not.toContain("5h");
  });

  it("JSON de entrada inválido (não é o payload esperado) — ainda produz uma linha e sai 0", () => {
    const r = spawnSync(process.execPath, [RENDERER], {
      input: "isto nao e json valido {{{",
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CLAUDE_CONFIG_DIR: TMP_BASE },
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("zero chamada de rede — grep estrutural no renderer por http/fetch", async () => {
    const src = await fs.readFile(RENDERER, "utf-8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/require\(["']https?["']\)/);
    expect(src).not.toMatch(/from ["']node:https?["']/);
  });

  it("worktree: `.git` é arquivo apontando pra gitdir externo — branch lido sem spawnar git", async () => {
    const dir = await freshDir("sl-worktree-");
    const external = await freshDir("sl-worktree-gitdir-");
    const worktreeGitdir = path.join(external, "worktrees", "meu-worktree");
    await fs.ensureDir(worktreeGitdir);
    await fs.writeFile(path.join(worktreeGitdir, "HEAD"), "ref: refs/heads/worktree-branch\n");
    await fs.writeFile(path.join(dir, ".git"), `gitdir: ${worktreeGitdir}\n`);

    const { stdout, status } = run({
      model: { display_name: "Sonnet 5" },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
    });

    expect(status).toBe(0);
    expect(stdout).toContain("worktree-branch");
  });
});
