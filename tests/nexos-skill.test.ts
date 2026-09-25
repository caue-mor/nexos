/**
 * G2 da vertical /nexos — aceite A9 (nexos://decision/primeira-vertical-nexos-autorizada,
 * nexos://decision/nexos-project-shim-ate-paridade): `/nexos` é a entrada
 * canônica e `nexos-project` fica só como atalho deprecated sem procedimento
 * próprio. O catálogo derivado (skills.json, skills-index.md) precisa bater
 * com o diretório — a 1A adicionou duas skills sem atualizá-lo.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validarSkills } from "../src/lib/conformance.js";

const ASSETS = path.resolve(__dirname, "..", "assets");
const SKILLS = path.join(ASSETS, "skills");

async function skillDirs(): Promise<string[]> {
  const entries = await fs.readdir(SKILLS, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await fs.pathExists(path.join(SKILLS, entry.name, "SKILL.md")))) dirs.push(entry.name);
  }
  return dirs.sort();
}

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

describe("catálogo de skills derivado do diretório", () => {
  it("skills.json lista exatamente os diretórios com SKILL.md", async () => {
    const json = (await fs.readJson(path.join(ASSETS, "skills.json"))) as { skills: { dir: string }[] };
    expect(json.skills.map((s) => s.dir).sort()).toEqual(await skillDirs());
  });

  it("skills-index.md tem uma linha por skill instalada e o total declarado bate", async () => {
    const index = await fs.readFile(path.join(ASSETS, "skills-index.md"), "utf-8");
    const rows = [...index.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]).sort();
    const dirs = await skillDirs();
    const names = await Promise.all(
      dirs.map(async (dir) => {
        const fm = frontmatter(await fs.readFile(path.join(SKILLS, dir, "SKILL.md"), "utf-8"));
        return [dir, fm.name ?? dir];
      })
    );
    const accepted = new Set(names.flat());
    expect(rows.length).toBe(dirs.length);
    for (const row of rows) expect(accepted.has(row), `linha sem skill: ${row}`).toBe(true);
    expect(index).toContain(`**Total installed:** ${dirs.length} skills.`);
  });
});

describe("/nexos — entrada canônica (A9)", () => {
  it("skill `nexos` existe, passa no validador e carrega o procedimento do NexOS Mode", async () => {
    const text = await fs.readFile(path.join(SKILLS, "nexos", "SKILL.md"), "utf-8");
    expect(frontmatter(text).name).toBe("nexos");
    const flat = text.replace(/\s+/g, " ");
    for (const obrigatorio of [
      "nexos doctor --project --json",
      "sem cumprimentar e parar",
      "Nunca rode `nexos init` para descobrir o estado",
      "zero subagentes",
      "Escritor único",
      "bloco gerenciado",
      "--repair --dry-run",
      "nexos verify --subject",
      "Nunca mudar `~/.claude` (instalação global) sem autorização explícita",
    ]) {
      expect(flat, obrigatorio).toContain(obrigatorio);
    }
    const achados = (await validarSkills(SKILLS)).filter((f) => f.file.includes("nexos") && f.severity === "ERROR");
    expect(achados).toEqual([]);
  });

  it("nexos-project é atalho DEPRECATED, sem procedimento próprio, apontando para `nexos`", async () => {
    const text = await fs.readFile(path.join(SKILLS, "nexos-project", "SKILL.md"), "utf-8");
    expect(frontmatter(text).description.startsWith("DEPRECATED")).toBe(true);
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(body).toContain("skill `nexos`");
    for (const comando of ["nexos init", "nexos map", "nexos state --set", "nexos decision --key"]) {
      expect(body, `shim não pode ter procedimento: ${comando}`).not.toContain(comando);
    }
    expect(body.trim().split("\n").length).toBeLessThanOrEqual(20);
  });
});

/**
 * Verificação do G2 achou `nexos memory --propose` citado na skill sem existir
 * na CLI — nenhum gate conferia comando citado contra comando real. Cada
 * `nexos <subcomando> --flag` da skill precisa aparecer no `--help` daquele
 * subcomando; flag isolada numa linha herda o último comando citado nela.
 */
function citedCommands(text: string): Map<string, Set<string>> {
  const cited = new Map<string, Set<string>>();
  let emBloco = false;
  /**
   * Dentro de bloco cercado o comando pode estar numa linha e a flag na
   * seguinte — o verificador provou que, resetando o comando a cada linha,
   * uma flag inexistente escrita assim nunca era checada (17/17 verde com
   * `--bogus-flag-doesnt-exist`). Dentro do bloco o comando persiste; fora
   * dele continua por linha, senão qualquer `--flag` de prosa herda o último
   * comando citado páginas antes.
   */
  let noBloco: string | undefined;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      emBloco = !emBloco;
      noBloco = undefined;
      continue;
    }
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (/^\s*nexos\s/.test(line) && spans.length === 0) spans.push(line.trim());
    if (emBloco && spans.length === 0 && /--[a-z]/.test(line)) spans.push(line.trim());
    let current: string | undefined = emBloco ? noBloco : undefined;
    for (const span of spans) {
      const cleaned = span.replace(/"[^"]*"/g, " ").replace(/<[^>]*>/g, " ").trim();
      const tokens = cleaned.split(/\s+/);
      if (tokens[0] === "nexos") {
        const words: string[] = [];
        for (const token of tokens.slice(1)) {
          if (!/^[a-z][a-z-]*$/.test(token)) break;
          words.push(token);
        }
        if (words.length === 0) continue;
        current = words.join(" ");
        if (emBloco) noBloco = current;
        if (!cited.has(current)) cited.set(current, new Set());
      }
      if (!current) continue;
      for (const token of tokens) {
        const flag = /^(--[a-z][a-z-]*)/.exec(token)?.[1];
        if (flag) cited.get(current)?.add(flag);
      }
    }
  }
  return cited;
}

describe("skill /nexos — todo comando citado existe na CLI", async () => {
  const repo = path.resolve(__dirname, "..");
  const text = await fs.readFile(path.join(SKILLS, "nexos", "SKILL.md"), "utf-8");
  const cited = [...citedCommands(text)].map(([command, flags]) => ({ command, flags: [...flags] }));

  it("o extrator acha os comandos da skill (sem isso o teste abaixo seria vácuo)", () => {
    const commands = cited.map((c) => c.command);
    expect(commands).toEqual(expect.arrayContaining(["doctor", "memory", "state", "verify", "init"]));
    expect(cited.find((c) => c.command === "memory")?.flags).toEqual(expect.arrayContaining(["--fact", "--evidence", "--promote"]));
  });

  it.each(cited)("nexos $command aceita $flags", ({ command, flags }) => {
    const r = spawnSync(
      process.execPath,
      [path.join(repo, "dist/index.js"), ...command.split(" "), "--help"],
      { cwd: repo, encoding: "utf-8", timeout: 25_000 }
    );
    expect(r.status, `${command} --help: ${r.stderr}`).toBe(0);
    for (const flag of flags) {
      expect(new RegExp(`${flag}(?![\\w-])`).test(r.stdout), `nexos ${command} não tem ${flag}`).toBe(true);
    }
  }, 30_000);
});

describe("atribuição de terceiros", () => {
  it("todo port_ref de skill e o agente derivado do AIOX têm entrada com licença integral em THIRD_PARTY_NOTICES", async () => {
    const notices = await fs.readFile(path.join(ASSETS, "THIRD_PARTY_NOTICES.md"), "utf-8");
    for (const dir of await skillDirs()) {
      const text = await fs.readFile(path.join(SKILLS, dir, "SKILL.md"), "utf-8");
      if (!/port_ref:/.test(text) || (await fs.pathExists(path.join(SKILLS, dir, "LICENSE.txt")))) continue;
      const repo = /repo:\s*(\S+)/.exec(text)?.[1] ?? "";
      expect(notices, `skill ${dir} (port_ref ${repo}) sem aviso`).toContain(`assets/skills/${dir}/SKILL.md`);
      expect(notices).toContain(`## ${repo}`);
    }
    expect(notices).toContain("assets/agents/nexos-dev.md");
    expect(notices).toContain("Copyright (c) 2025 SynkraAI Inc.");
    expect(notices.match(/Permission is hereby granted/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
