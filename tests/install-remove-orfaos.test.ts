/**
 * Órfão intacto sai no install — decisão do dono, 25/09.
 *
 *   HASH PROVA AUTORIA E INTEGRIDADE · BACKUP TORNA A REMOÇÃO REVERSÍVEL
 *
 * MEDIDO 25/09 (relato da comunidade, 6.3.1 → 7.0.3): o upgrade listava 2.318
 * arquivos "idêntico ao instalado — remover é seguro" e não removia nenhum;
 * 1.822 eram skills antigas que o Claude Code continuava carregando. Agora
 * sai o que o manifesto prova ser nosso e intacto. Fica: o editado no host e
 * o que o settings.json final ainda chama (hook ligado à mão pelo usuário).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = path.resolve(__dirname, "..");
const labs: string[] = [];

const md5 = (s: string): string => crypto.createHash("md5").update(s).digest("hex");

function install(home: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(repo, "dist/index.js"), "install", ...args], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" },
  });
}

afterEach(async () => {
  while (labs.length > 0) await fs.remove(labs.pop() as string);
});

async function hostComOrfaos(): Promise<string> {
  const home = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-orfaos-"));
  labs.push(home);
  const claude = path.join(home, ".claude");
  const arquivos: Record<string, string> = {
    "skills/velha/SKILL.md": "skill antiga",
    "skills/velha/references/ref.md": "referencia antiga",
    "commands/cmd.md": "command antigo",
    "hooks/meu-antigo.sh": "echo antigo",
    "rules/editada.md": "editado pelo usuario",
  };
  for (const [rel, conteudo] of Object.entries(arquivos)) await fs.outputFile(path.join(claude, rel), conteudo);
  await fs.writeJson(path.join(claude, ".nexos-hashes.json"), {
    "skills/velha/SKILL.md": md5("skill antiga"),
    "skills/velha/references/ref.md": md5("referencia antiga"),
    "commands/cmd.md": md5("command antigo"),
    "hooks/meu-antigo.sh": md5("echo antigo"),
    "rules/editada.md": md5("conteudo que o NexOS gravou"),
  });
  await fs.writeJson(path.join(claude, "settings.json"), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/meu-antigo.sh" }] }] },
  });
  return home;
}

describe("nexos install remove órfão intacto", () => {
  it("dry-run lista a remoção e não apaga nada", async () => {
    const home = await hostComOrfaos();
    const r = install(home, ["--dry-run"]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/remove\s+skills\/velha\/SKILL\.md/);
    expect(r.stdout).toMatch(/remove\s+commands\/cmd\.md/);
    expect(await fs.pathExists(path.join(home, ".claude/skills/velha/SKILL.md"))).toBe(true);
  });

  it("remove o intacto com backup, poda o diretório vazio e preserva editado e referenciado", async () => {
    const home = await hostComOrfaos();
    const claude = path.join(home, ".claude");
    const r = install(home);

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(await fs.pathExists(path.join(claude, "skills/velha"))).toBe(false);
    expect(await fs.pathExists(path.join(claude, "commands/cmd.md"))).toBe(false);
    expect(await fs.readFile(path.join(claude, "rules/editada.md"), "utf8")).toBe("editado pelo usuario");
    expect(await fs.readFile(path.join(claude, "hooks/meu-antigo.sh"), "utf8")).toBe("echo antigo");

    const backups = await fs.readdir(path.join(claude, "backups"));
    const backup = path.join(claude, "backups", backups.find((b) => b.startsWith("pre-nexos-install-")) ?? "");
    expect(await fs.readFile(path.join(backup, "skills/velha/SKILL.md"), "utf8")).toBe("skill antiga");
    expect(await fs.readFile(path.join(backup, "commands/cmd.md"), "utf8")).toBe("command antigo");

    const manifesto = (await fs.readJson(path.join(claude, ".nexos-hashes.json"))) as Record<string, string>;
    expect(manifesto["skills/velha/SKILL.md"]).toBeUndefined();
    expect(manifesto["commands/cmd.md"]).toBeUndefined();
    expect(manifesto["rules/editada.md"]).toBe(md5("conteudo que o NexOS gravou"));
    expect(manifesto["hooks/meu-antigo.sh"]).toBe(md5("echo antigo"));

    const segunda = install(home, ["--dry-run"]);
    expect(segunda.stdout).toMatch(/remove: 0/);
  });
});
