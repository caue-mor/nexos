/**
 * nexos://decision/claude-md-bloco-gerenciado — ligação do bloco gerenciado
 * no `nexos init` (CLAUDE.md do projeto) e no `nexos install` (CLAUDE.md
 * global). Tudo em tmpdir; o install roda em subprocesso com HOME isolado
 * (mesmo mecanismo de install-statusline.test.ts), nunca toca ~/.claude real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { init, PROJECT_CLAUDE_MD_BODY } from "../src/commands/init.js";
import { inspectClaudeMdBlock, renderClaudeMdBlock, LEGACY_UNMARKED_SIGNATURES } from "../src/lib/claude-md-block.js";

const repo = path.resolve(__dirname, "..");
const TMP_BASE = fs.realpathSync(os.tmpdir());

describe("nexos init — CLAUDE.md do projeto", () => {
  let dir: string;
  const claudeMd = () => path.join(dir, "CLAUDE.md");
  const initAqui = () => init({ cwd: dir, registerGlobally: false });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(TMP_BASE, "claude-md-init-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(dir);
  });

  it("projeto novo: título e stack FORA do bloco, bloco íntegro", async () => {
    await initAqui();
    const text = await fs.readFile(claudeMd(), "utf-8");
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toMatch(/### Stack\n- /);
    const inspection = inspectClaudeMdBlock(text, PROJECT_CLAUDE_MD_BODY);
    expect(inspection.state).toBe("intact");
    expect(inspection.hasExternalContent).toBe(true);
  });

  it("init de novo num projeto já canônico com bloco íntegro: CLAUDE.md byte-idêntico", async () => {
    await initAqui();
    const before = await fs.readFile(claudeMd());
    await initAqui();
    expect(await fs.readFile(claudeMd())).toEqual(before);
  });

  it("bloco desatualizado num projeto já canônico: só o corpo do bloco muda, fora dele fica byte a byte", async () => {
    await initAqui();
    const prefix = "# Meu projeto\n\nregras minhas\n\n";
    const suffix = "\n\n## Minhas notas\nnão mexer\n";
    await fs.writeFile(claudeMd(), `${prefix}${renderClaudeMdBlock("## NexOS\n\ntexto antigo do NexOS\n")}${suffix}`);
    await initAqui();
    expect(await fs.readFile(claudeMd(), "utf-8")).toBe(`${prefix}${renderClaudeMdBlock(PROJECT_CLAUDE_MD_BODY)}${suffix}`);
  });

  it("projeto já canônico sem CLAUDE.md: o init que o cria nunca diz 'nada foi tocado'", async () => {
    await initAqui();
    await fs.remove(claudeMd());
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    await initAqui();
    const out = logs.join("\n");
    expect(await fs.pathExists(claudeMd())).toBe(true);
    expect(out).toMatch(/\+ CLAUDE\.md/);
    expect(out).not.toMatch(/nada foi tocado/);
  });

  it("bloco editado à mão: preservado byte a byte e reportado", async () => {
    await initAqui();
    const edited = renderClaudeMdBlock(PROJECT_CLAUDE_MD_BODY).replace("## NexOS", "## NexOS (minha versão)");
    await fs.writeFile(claudeMd(), edited);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    await initAqui();
    expect(await fs.readFile(claudeMd(), "utf-8")).toBe(edited);
    expect(logs.join("\n")).toMatch(/CLAUDE\.md preservado, nada escrito: .*editado à mão/);
  });

  it("seção NexOS antiga sem marcador (template anterior do init): preservada, sem bloco duplicado", async () => {
    await initAqui();
    const legacy = `# Projeto antigo\n\n## NexOS\n\n${LEGACY_UNMARKED_SIGNATURES[0]}\n\n### Stack\n- node\n`;
    await fs.writeFile(claudeMd(), legacy);
    await initAqui();
    expect(await fs.readFile(claudeMd(), "utf-8")).toBe(legacy);
  });
});

function cli(home: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(repo, "dist/index.js"), ...args],
    {
      cwd: home,
      encoding: "utf8",
      timeout: 60_000,
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    }
  );
}

describe("nexos install — CLAUDE.md global", () => {
  const assetBody = () => fs.readFile(path.join(repo, "assets", "CLAUDE.md"), "utf-8");

  it("CLAUDE.md do usuário que só CITA NexOS: bloco anexado, texto do usuário como prefixo exato, 2ª instalação sem mudança", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "claude-md-install-"));
    const userText = "# NexOS — Regras de Trabalho\n\nminhas regras pessoais\n";
    await fs.outputFile(path.join(home, ".claude", "CLAUDE.md"), userText);

    const first = cli(home, ["install"]);
    expect(first.status, first.stderr).toBe(0);
    const after = await fs.readFile(path.join(home, ".claude", "CLAUDE.md"), "utf-8");
    expect(after.startsWith(userText)).toBe(true);
    expect(inspectClaudeMdBlock(after, await assetBody()).state).toBe("intact");

    const second = cli(home, ["install", "--dry-run"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).not.toMatch(/(create|update)\s+CLAUDE\.md/);
    await fs.remove(home);
  }, 120_000);

  it("bloco global editado à mão: preserve + aviso de conflito no dry-run e no install, arquivo byte-idêntico", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "claude-md-install-conflict-"));
    const edited = `minhas regras\n\n${renderClaudeMdBlock(await assetBody()).replace("NexOS", "NexOS editado")}\n`;
    await fs.outputFile(path.join(home, ".claude", "CLAUDE.md"), edited);

    const dry = cli(home, ["install", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/preserve\s+CLAUDE\.md/);
    expect(dry.stdout).toMatch(/Conflito no bloco gerenciado do CLAUDE\.md: .*editado à mão/);

    const real = cli(home, ["install"]);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).toMatch(/Conflito no bloco gerenciado do CLAUDE\.md/);
    expect(await fs.readFile(path.join(home, ".claude", "CLAUDE.md"), "utf-8")).toBe(edited);
    await fs.remove(home);
  }, 120_000);
});
