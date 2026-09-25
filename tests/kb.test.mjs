import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { index, lint } from "../scripts/kb/kb.mjs";

// nexos://decision/obsidian-vault-novo — o lint é o que impede a base de
// apodrecer como o vault antigo (snapshot de 01/04 sem produtor).

const sha = (s) => createHash("sha256").update(s).digest("hex");
let vault;

function escrever(rel, conteudo) {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, conteudo);
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  const pagina = "# Sandboxing\n";
  const llms = "## Configuration\n\n- [Sandboxing](https://x/docs/en/sandboxing.md): isola comandos\n";
  escrever("raw/cc/2026-09-23/en/sandboxing.md", pagina);
  escrever("raw/cc/2026-09-23/llms.txt", llms);
  escrever(
    "raw/cc/2026-09-23/MANIFEST.tsv",
    `${sha(llms)}\thttps://x/docs/llms.txt\t${llms.length}\tllms.txt\n` +
      `${sha(pagina)}\thttps://x/docs/en/sandboxing.md\t${pagina.length}\ten/sandboxing.md\n`,
  );
  escrever(
    "wiki/cc/sandboxing.md",
    "---\ntipo: conceito\nfonte:\n  - raw/cc/2026-09-23/en/sandboxing.md\n---\n# Sandbox\n",
  );
});

describe("kb index", () => {
  it("lista cada página do llms.txt e marca a que já tem nota compilada", () => {
    expect(index(vault, "raw/cc/2026-09-23", "cc")).toEqual({ total: 1, compiladas: 1 });
    const idx = fs.readFileSync(path.join(vault, "wiki/cc/index.md"), "utf8");
    expect(idx).toContain("[[wiki/cc/sandboxing|compilada]]");
    expect(idx).toContain("[[raw/cc/2026-09-23/en/sandboxing.md|bruto]]");
  });
});

describe("kb index — casa pelo caminho, nunca pelo nome final", () => {
  it("agent-sdk/skills e whats-new/index não viram 'compilada' por causa de skills.md e index.md", () => {
    // Medido 23/09 na base real: 5 'compiladas' com 3 notas escritas.
    const llms =
      "- [Skills](https://x/docs/en/skills.md): a\n" +
      "- [SDK skills](https://x/docs/en/agent-sdk/skills.md): b\n" +
      "- [Whats new](https://x/docs/en/whats-new/index.md): c\n";
    escrever("raw/cc/2026-09-23/llms.txt", llms);
    escrever("wiki/cc/skills.md", "---\nfonte: raw/cc/2026-09-23/llms.txt\n---\n");
    expect(index(vault, "raw/cc/2026-09-23", "cc").compiladas).toBe(1);
  });
});

describe("kb index — índice em português", () => {
  it("mantém os subtítulos #### do pt-br.md", () => {
    escrever("raw/cc/2026-09-23/llms.txt", "## Brazilian Portuguese\n\n### Primeiros passos\n\n#### Conceitos\n\n- [Visão geral](https://x/docs/pt/overview.md): a\n");
    index(vault, "raw/cc/2026-09-23", "cc");
    expect(fs.readFileSync(path.join(vault, "wiki/cc/index.md"), "utf8")).toContain("#### Conceitos");
  });
});

describe("kb index — texto externo do llms.txt não injeta HTML", () => {
  it("< e > do título, da descrição e da seção viram entidade", () => {
    const llms = "## Cfg <b>x</b>\n\n- [T <script>](https://x/docs/en/sandboxing.md): d <img src=x>\n";
    escrever("raw/cc/2026-09-23/llms.txt", llms);
    index(vault, "raw/cc/2026-09-23", "cc");
    const saida = fs.readFileSync(path.join(vault, "wiki/cc/index.md"), "utf8");
    expect(saida).not.toMatch(/<(script|img|b)\b/);
    expect(saida).toContain("T &lt;script&gt;");
    expect(saida).toContain("d &lt;img src=x&gt;");
    expect(saida).toContain("Cfg &lt;b&gt;x&lt;/b&gt;");
  });
});

describe("kb lint", () => {
  it("base íntegra e ligada pelo índice: zero achados", () => {
    index(vault, "raw/cc/2026-09-23", "cc");
    expect(lint(vault)).toEqual([]);
  });

  it("link dentro de código não conta, e o alias escapado de tabela ([[alvo\\|texto]]) resolve o alvo", () => {
    index(vault, "raw/cc/2026-09-23", "cc");
    escrever(
      "wiki/cc/index.md",
      fs.readFileSync(path.join(vault, "wiki/cc/index.md"), "utf8") +
        "\nExemplo: `![[x.base]]`\n\n```\n[[tambem-nao-existe]]\n```\n\n| nota |\n|---|\n| [[index\\|índice]] |\n"
    );
    expect(lint(vault)).toEqual([]);
  });

  it("pega bruto alterado, nota sem fonte, fonte inexistente, link quebrado e órfã", () => {
    fs.appendFileSync(path.join(vault, "raw/cc/2026-09-23/en/sandboxing.md"), "editado\n");
    escrever("wiki/cc/sem-fonte.md", "# nada\n[[nao-existe]]\n");
    escrever("wiki/cc/fonte-sumida.md", "---\nfonte: raw/cc/2026-09-23/en/sumiu.md\n---\n[[sem-fonte]]\n");

    const tipos = lint(vault).map(([nivel, tipo]) => `${nivel}:${tipo}`).sort();
    expect(tipos).toEqual([
      "aviso:orfa", // fonte-sumida.md: ninguém aponta para ela
      "aviso:orfa", // sandboxing.md: sem índice, ninguém aponta
      "erro:bruto-alterado",
      "erro:fonte-inexistente",
      "erro:link-quebrado",
      "erro:sem-fonte",
    ]);
  });
});
