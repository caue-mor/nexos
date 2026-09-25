/**
 * Achado da leitura do AIOX (docs/pos-mvp-aiox-camada-trabalho.md, NEXT-1):
 * os agentes herdaram do donor a regra de resolver dependências em
 * `.nexos/tasks/shared/` e listavam 19 arquivos que o pacote nunca publicou.
 *
 *   DECLARED DEPENDENCY != SHIPPED FILE
 *   Dependência declarada e ausente faz o agente ler nada e improvisar.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";

const AGENTS = path.resolve(__dirname, "..", "assets", "agents");

/** Caminhos de LEITURA dentro de `.nexos/` que o pacote não publica. */
const CAMINHOS_AUSENTES = /\.nexos\/(tasks|checklists|templates|data|core)\//g;

async function agentFiles(): Promise<string[]> {
  return (await fs.readdir(AGENTS)).filter((f) => f.endsWith(".md")).sort();
}

describe("agentes do pacote — nenhuma dependência morta", () => {
  it("nenhum agente manda ler caminho que o pacote não traz", async () => {
    for (const file of await agentFiles()) {
      const text = await fs.readFile(path.join(AGENTS, file), "utf-8");
      // A frase que EXPLICA a ausência cita os caminhos de propósito; o que não
      // pode voltar é instrução de leitura. Removo as linhas da explicação.
      const linhas = text
        .split("\n")
        .filter((l) => !/git ls-files|Nunca leia caminho|não publica|legado global/.test(l));
      const achados = [...linhas.join("\n").matchAll(CAMINHOS_AUSENTES)].map((m) => m[0]);
      expect(achados, `${file} cita caminho ausente: ${achados.join(", ")}`).toEqual([]);
    }
  });

  it("nenhum agente declara bloco `dependencies:` com arquivos .md ausentes do pacote", async () => {
    const existentes = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name.endsWith(".md")) existentes.add(entry.name);
      }
    };
    await walk(path.resolve(__dirname, "..", "assets"));

    for (const file of await agentFiles()) {
      const text = await fs.readFile(path.join(AGENTS, file), "utf-8");
      const bloco = /\ndependencies:\n([\s\S]*?)(\n[a-z_-]+:|\n#|$)/.exec(text)?.[1] ?? "";
      const citados = [...bloco.matchAll(/^\s*-\s*([a-z0-9-]+\.md)\s*$/gm)].map((m) => m[1]!);
      const ausentes = citados.filter((c) => !existentes.has(c));
      expect(ausentes, `${file} declara dependência ausente: ${ausentes.join(", ")}`).toEqual([]);
    }
  });

  it("nenhum agente manda LER arquivo (.md/.yaml/.html) que o pacote não tem", async () => {
    const { execFileSync } = await import("node:child_process");
    const repo = path.resolve(__dirname, "..");
    const versionados = new Set(
      execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf-8" })
        .split("\n")
        .filter(Boolean)
        .map((f) => path.basename(f))
    );
    /** Projeções legadas citadas de propósito ("não leia como estado"). */
    const LEGADO_CITADO = new Set([
      // Arquivo do PROJETO do usuário em exemplo de bundler (`parcel build src/index.html`),
      // não dependência do pacote. Antes passava por acaso: docs/visual-sdk/prototype/index.html
      // existe no repo privado e some no export público (medido 24/09).
      "index.html",
      "state.md",
      "gotchas.md",
      "decisions.md",
      "patterns.md",
      "MEMORY.md",
      "PROXIMA-SESSAO.md",
      "TESES-MORTAS.md",
    ]);

    for (const file of await agentFiles()) {
      const text = await fs.readFile(path.join(AGENTS, file), "utf-8");
      /**
       * Isenção CIRÚRGICA, nunca por linha: a primeira versão deste teste
       * descartava a linha inteira que contivesse `docs/` e todo comentário —
       * o verificador provou que uma dependência morta na MESMA linha de um
       * caminho `docs/`, ou dentro de qualquer comentário, ficava invisível.
       * Agora sai só o VALOR de `output:`, só o TOKEN do caminho produzido, e
       * só o comentário de proveniência (que cita arquivo do donor por
       * exigência da MIT). Todo o resto continua sendo escaneado.
       */
      const lidas = text
        .replace(/<!--(?:(?!-->)[\s\S])*?Proveni[êe]ncia[\s\S]*?-->/g, "")
        .replace(/output:\s*"[^"]*"/g, "output: \"\"")
        .replace(/[\w.@-]*docs\/[\w./{}-]+/g, "");
      const citados = [...lidas.matchAll(/([a-z0-9][a-z0-9._-]*\.(?:md|yaml|html))/gi)].map((m) => m[1]!);
      const ausentes = [...new Set(citados)].filter(
        (c) => !versionados.has(c) && !LEGADO_CITADO.has(c)
      );
      expect(ausentes, `${file} cita arquivo ausente do pacote: ${ausentes.join(", ")}`).toEqual([]);
    }
  });

  it("a régua de tier tem precedência declarada sobre a classe de design do architect", async () => {
    const arch = await fs.readFile(path.join(AGENTS, "nexos-architect.md"), "utf-8");
    expect(arch).toContain("A régua de tier do trabalho é T0–T4");
  });
});

describe("skills do pacote — nenhum script ou arquivo morto citado", () => {
  /**
   * Medido em 2026-09-17: `development--clean-code` mandava rodar
   * `~/.claude/skills/testing-patterns/scripts/test_runner.py`, que nunca
   * existiu no pacote (a skill só tinha SKILL.md). Skill instalada que manda
   * rodar script ausente é a mesma classe de defeito das dependências mortas
   * dos agentes.
   */
  it("nenhuma skill cita caminho em ~/.claude/skills que o pacote não instala", async () => {
    const SKILLS_DIR = path.resolve(__dirname, "..", "assets", "skills");
    const dirs = (await fs.readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory());
    for (const dir of dirs) {
      for (const file of await fs.readdir(path.join(SKILLS_DIR, dir.name))) {
        if (!file.endsWith(".md")) continue;
        const text = await fs.readFile(path.join(SKILLS_DIR, dir.name, file), "utf-8");
        /**
         * Só COMANDO conta, e a análise é por LINHA: `2>/dev/null` e
         * placeholder ficam FORA do trecho casado pela regex, então filtrar o
         * match não bastava. `ls ~/.claude/skills/expertise/ 2>/dev/null` com
         * degradação declarada (create-plans) é descoberta opcional; `python
         * ~/.claude/skills/x/scripts/y.py` quebra se o arquivo não existir.
         */
        const citados = text
          .split("\n")
          .filter((linha) => !linha.includes("2>/dev/null"))
          .flatMap((linha) =>
            [...linha.matchAll(/(?:python3?|node|bash|sh|cat)\s+~\/\.claude\/skills\/([\w.@/<>[\]-]+)/g)].map((m) => m[1]!)
          )
          // Placeholder é placeholder: filtra o CAMINHO, nunca a linha —
          // `**negrito**` de markdown tem asterisco e escondia script real.
          .filter((caminho) => !/[[<*]/.test(caminho));
        for (const citado of citados) {
          const [skill, ...resto] = citado.split("/");
          const alvo = path.join(SKILLS_DIR, `development--${skill}`, ...resto);
          const alternativo = path.join(SKILLS_DIR, skill!, ...resto);
          const existe = (await fs.pathExists(alvo)) || (await fs.pathExists(alternativo));
          expect(existe, `${dir.name}/${file} cita ~/.claude/skills/${citado}, ausente do pacote`).toBe(true);
        }
      }
    }
  });
});
