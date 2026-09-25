/**
 * `PARSE FAILURE != ABSENT FIELD`.
 *
 * Antes desta guarda, `extractFrontmatter` devolvia `null` em TRÊS condições
 * distintas — sem frontmatter, frontmatter truncado, YAML inválido — e o
 * chamador fazia `?? ""`. As três viravam indistinguíveis de "o autor não
 * escreveu description", e as ações são opostas: escrever a descrição,
 * consertar o delimitador, consertar o YAML.
 *
 * MEDIDO no host real ao descobrir isto: dos 199 itens que o audit reportava
 * "sem description", UM era o caso que o rótulo descrevia. 112 tinham
 * description legível — e o Claude Code as lê normalmente. Um scanner que não
 * enxerga o que o runtime enxerga não mede o runtime, mede a si mesmo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { scanAll } from "../src/lib/capabilities/scan.js";
import type { CapabilityItem } from "../src/lib/capabilities/types.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, claudeDir: string, homeDir: string, root: string;

async function skill(nome: string, conteudo: string): Promise<void> {
  const dir = path.join(claudeDir, "skills", nome);
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, "SKILL.md"), conteudo);
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "caps-fm-"));
  homeDir = path.join(ws, "home");
  claudeDir = path.join(homeDir, ".claude");
  root = path.join(ws, "project");
  await fs.ensureDir(path.join(claudeDir, "skills"));
  await fs.ensureDir(root);
});
afterEach(async () => {
  await fs.remove(ws);
});

const acha = (items: readonly CapabilityItem[], n: string): CapabilityItem | undefined =>
  items.find((i) => i.name === n);

describe("frontmatter malformado não vira 'sem description'", () => {
  it("UNTERMINATED: abertura sem fechamento — o host lê, nós também", async () => {
    /** Caso REAL medido: o `---` de fechamento grudou no último valor. */
    await skill("sem-fecho", `---\nname: sem-fecho\ndescription: vale como descricao\nmetadata:\n  verified: 2026-07-19---\n\n# Corpo\n`);
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const it0 = acha(items, "sem-fecho");
    expect(it0?.description).toBe("vale como descricao");
    expect(it0?.frontmatter_issue).toBe("UNTERMINATED");
  });

  it("INVALID_YAML: description recuperada E o defeito continua nomeado", async () => {
    /** `[a, b` abre sequência de fluxo e nunca fecha — o parser estrito lança. */
    await skill("yaml-quebrado", `---\nname: yaml-quebrado\ndescription: usa quando [a, b\nquebrado: {sem-fecho\n---\n\n# Corpo\n`);
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const it0 = acha(items, "yaml-quebrado");
    expect(it0?.frontmatter_issue).toBe("INVALID_YAML");
    expect(it0?.description).toBe("usa quando [a, b");
  });

  it("NO_DESCRIPTION: parse ok e campo ausente continua vazio, SEM issue", async () => {
    await skill("sem-desc", `---\nname: sem-desc\n---\n\n# Corpo\n`);
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const it0 = acha(items, "sem-desc");
    expect(it0?.description).toBe("");
    expect(it0?.frontmatter_issue).toBeUndefined();
  });

  it("íntegro não ganha issue — a guarda não pode marcar arquivo são", async () => {
    await skill("ok", `---\nname: ok\ndescription: tudo certo\n---\n\n# Corpo\n`);
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const it0 = acha(items, "ok");
    expect(it0?.description).toBe("tudo certo");
    expect(it0?.frontmatter_issue).toBeUndefined();
  });

  it("UNTERMINATED nunca inventa campo a partir do corpo markdown", async () => {
    /** Sem `description:` no bloco, não há o que recuperar — e o corpo não vira frontmatter. */
    await skill("so-corpo", `---\nname: so-corpo\n\n# Titulo do corpo\n\ndescription: isto esta no CORPO, nao no frontmatter\n`);
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const it0 = acha(items, "so-corpo");
    expect(it0?.description).toBe("");
  });
});
