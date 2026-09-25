/**
 * `nexos capabilities` — Onda 1, R1 (docs/pos-mvp-matriz-capabilities.md §1).
 * A1.1–A1.6: leitor read-only das superfícies nativas do Claude Code.
 *
 * Fixture PRÓPRIA (`claudeDir`/`homeDir`/`root` injetados — `scan.ts` nunca
 * usa `CLAUDE_DIR`/`os.homedir()` reais quando estes são passados): o `$HOME`
 * real de quem roda o teste nunca é tocado nem lido pelos testes A1.1–A1.4.
 * A1.6 usa a MESMA fixture para provar que nada foi escrito.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { scanAll, binaryOnPath } from "../src/lib/capabilities/scan.js";
import { groupDuplicates, groupVariants, suggestCapabilities } from "../src/lib/capabilities/analyze.js";
import { loadCapabilityCatalog, suggestForRoot } from "../src/lib/capabilities/catalog.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, claudeDir: string, homeDir: string, root: string;

const SKILL_MD = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody.\n`;

async function buildFixture(): Promise<void> {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "caps-"));
  homeDir = path.join(ws, "home");
  claudeDir = path.join(homeDir, ".claude");
  root = path.join(ws, "project");

  // ─── personal skills ──────────────────────────────────────────────────
  await fs.ensureDir(path.join(claudeDir, "skills", "personal-skill-a"));
  await fs.outputFile(
    path.join(claudeDir, "skills", "personal-skill-a", "SKILL.md"),
    SKILL_MD("personal-skill-a", "Does a personal thing.")
  );
  await fs.ensureDir(path.join(claudeDir, "skills", "dup-personal"));
  await fs.outputFile(path.join(claudeDir, "skills", "dup-personal", "SKILL.md"), SKILL_MD("dup", "Exact duplicate fixture."));
  await fs.outputFile(
    path.join(claudeDir, "skills", "with-paths-and-compat", "SKILL.md"),
    SKILL_MD(
      "with-paths-and-compat",
      "Declares paths and compatibility.",
      'paths: ["**/*.sql", "migrations/**"]\ncompatibility: "Requires PostgreSQL 14+"\n'
    )
  );
  // mesmo nome final, fonte diferente (plugin-a abaixo), conteúdo DIFERENTE — VARIANT, nunca DUPLICATE.
  await fs.outputFile(
    path.join(claudeDir, "skills", "variant-skill", "SKILL.md"),
    SKILL_MD("variant-skill", "Personal, edited version.")
  );

  // ─── skill sincronizada da conta claude.ai ("Where synced skills load") ──
  await fs.outputFile(
    path.join(claudeDir, "skills", "synced", "acct-sync-id-123", "synced-skill-a", "SKILL.md"),
    SKILL_MD("synced-skill-a", "Downloaded from claude.ai account.")
  );

  // ─── skill pessoal SYMLINKADA ("Symlinked folders") ────────────────────
  const symlinkTargetDir = path.join(ws, "outside-skills", "real-skill-location");
  await fs.outputFile(path.join(symlinkTargetDir, "SKILL.md"), SKILL_MD("symlinked-skill", "Lives outside ~/.claude/skills."));
  await fs.ensureDir(path.join(claudeDir, "skills"));
  await fs.symlink(symlinkTargetDir, path.join(claudeDir, "skills", "symlinked-skill"), "dir");

  // ─── personal agents/commands ─────────────────────────────────────────
  await fs.ensureDir(path.join(claudeDir, "agents"));
  await fs.outputFile(path.join(claudeDir, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code.\n---\nBody\n");
  await fs.ensureDir(path.join(claudeDir, "commands", "consider"));
  await fs.outputFile(path.join(claudeDir, "commands", "deploy.md"), "---\ndescription: Deploys the app.\n---\nBody\n");
  await fs.outputFile(path.join(claudeDir, "commands", "consider", "pareto.md"), "---\ndescription: Applies pareto.\n---\nBody\n");

  // ─── settings.json (skillOverrides + enabledPlugins) ──────────────────
  await fs.outputJson(path.join(claudeDir, "settings.json"), {
    skillOverrides: { "personal-skill-a": "on", "off-skill": "off" },
    enabledPlugins: { "plugin-a@market-a": true, "plugin-b@market-a": false },
  });

  // ─── ~/.claude.json (mcpServers de usuário) ───────────────────────────
  await fs.outputJson(path.join(homeDir, ".claude.json"), {
    mcpServers: { "user-mcp": { command: "user-mcp-binary" } },
  });

  // ─── plugins instalados ────────────────────────────────────────────────
  const pluginAPath = path.join(claudeDir, "plugins", "cache", "market-a", "plugin-a", "1.0.0");
  const pluginBPath = path.join(claudeDir, "plugins", "cache", "market-a", "plugin-b", "1.0.0");
  const pluginCPath = path.join(claudeDir, "plugins", "cache", "market-a", "typescript-lsp-fixture", "1.0.0");
  const pluginRootOnlyPath = path.join(claudeDir, "plugins", "cache", "market-a", "plugin-root-only", "1.0.0");

  await fs.outputJson(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "plugin-a@market-a": [
        { scope: "user", installPath: pluginAPath, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" },
      ],
      "plugin-b@market-a": [
        { scope: "user", installPath: pluginBPath, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" },
      ],
      "typescript-lsp-fixture@market-a": [
        { scope: "user", installPath: pluginCPath, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" },
      ],
      "plugin-root-only@market-a": [
        { scope: "user", installPath: pluginRootOnlyPath, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" },
      ],
    },
  });

  // plugin-a: skill + agent + command + mcp + lsp (python), ENABLED
  await fs.ensureDir(path.join(pluginAPath, "skills", "plugin-skill"));
  await fs.outputFile(path.join(pluginAPath, "skills", "plugin-skill", "SKILL.md"), SKILL_MD("plugin-skill", "A skill from plugin-a."));
  await fs.outputFile(
    path.join(pluginAPath, "skills", "variant-skill", "SKILL.md"),
    SKILL_MD("variant-skill", "Plugin donor, original version — different body from the personal copy.")
  );
  // diretório "internal-dir-name", frontmatter name "fancy-name" -> name reportado deve ser "plugin-a:fancy-name" (frontmatter vence, doc oficial).
  await fs.outputFile(
    path.join(pluginAPath, "skills", "internal-dir-name", "SKILL.md"),
    SKILL_MD("fancy-name", "Frontmatter name overrides the directory name for plugin skills.")
  );
  // frontmatter já vem com o prefixo do plugin -> NÃO duplica (doc oficial, guarda de duplo-prefixo).
  await fs.outputFile(
    path.join(pluginAPath, "skills", "already-prefixed", "SKILL.md"),
    SKILL_MD("plugin-a:already-prefixed-name", "Frontmatter name already carries the plugin prefix.")
  );
  await fs.ensureDir(path.join(pluginAPath, "agents"));
  await fs.outputFile(path.join(pluginAPath, "agents", "plugin-agent.md"), "---\ndescription: Plugin agent.\n---\nBody\n");
  await fs.ensureDir(path.join(pluginAPath, "commands"));
  await fs.outputFile(path.join(pluginAPath, "commands", "plugin-cmd.md"), "---\ndescription: Plugin command.\n---\nBody\n");
  await fs.outputJson(path.join(pluginAPath, ".mcp.json"), { mcpServers: { "plugin-mcp": { command: "plugin-mcp-binary" } } });
  await fs.ensureDir(path.join(pluginAPath, ".claude-plugin"));
  await fs.outputJson(path.join(pluginAPath, ".claude-plugin", "plugin.json"), {
    name: "plugin-a",
    lspServers: { python: { command: "pyright-lsp-fixture-binary" } },
  });

  // plugin-b: DISABLED, mesma skill exata de dup-personal (triplica com o projeto abaixo)
  await fs.ensureDir(path.join(pluginBPath, "skills", "dup-plugin"));
  await fs.outputFile(path.join(pluginBPath, "skills", "dup-plugin", "SKILL.md"), SKILL_MD("dup", "Exact duplicate fixture."));

  // typescript-lsp-fixture: INSTALADO, sem `enabledPlugins`, binário nunca no PATH da fixture (A1.4)
  await fs.ensureDir(path.join(pluginCPath, ".claude-plugin"));
  await fs.outputJson(path.join(pluginCPath, ".claude-plugin", "plugin.json"), {
    name: "typescript-lsp-fixture",
    lspServers: { typescript: { command: "typescript-language-server-fixture" } },
  });

  // marketplace cacheado — plugin catalogado mas NUNCA instalado (rust)
  await fs.ensureDir(path.join(claudeDir, "plugins", "marketplaces", "market-a", ".claude-plugin"));
  await fs.outputJson(path.join(claudeDir, "plugins", "marketplaces", "market-a", ".claude-plugin", "marketplace.json"), {
    name: "market-a",
    plugins: [{ name: "rust-lsp-fixture", lspServers: { rust: { command: "rust-analyzer-fixture-binary" } } }],
  });

  // plugin-root-only: SEM subpasta skills/ — o plugin INTEIRO é a skill ("Plugin root SKILL.md").
  await fs.outputFile(
    path.join(pluginRootOnlyPath, "SKILL.md"),
    SKILL_MD("root-skill-name", "The whole plugin is a single skill, no skills/ subdirectory.")
  );

  // ─── projeto ────────────────────────────────────────────────────────────
  await fs.ensureDir(path.join(root, ".claude", "skills", "project-skill"));
  await fs.outputFile(
    path.join(root, ".claude", "skills", "project-skill", "SKILL.md"),
    SKILL_MD("project-skill", "Handles bug triage and test failure root cause. Use when a test fails without a clear cause.")
  );
  await fs.ensureDir(path.join(root, ".claude", "skills", "dup-project"));
  await fs.outputFile(path.join(root, ".claude", "skills", "dup-project", "SKILL.md"), SKILL_MD("dup", "Exact duplicate fixture."));
  await fs.outputJson(path.join(root, ".mcp.json"), { mcpServers: { "project-mcp": { url: "http://localhost:1234" } } });

  // ─── skill de projeto ANINHADA em subpasta (monorepo) ───────────────────
  await fs.outputFile(
    path.join(root, "apps", "web", ".claude", "skills", "nested-skill", "SKILL.md"),
    SKILL_MD("nested-skill", "Loads only in sessions started in or below apps/web.")
  );
  // node_modules dentro do projeto NUNCA deve ser descido — se descesse, este arquivo apareceria como skill.
  await fs.outputFile(
    path.join(root, "node_modules", "some-dep", ".claude", "skills", "should-be-ignored", "SKILL.md"),
    SKILL_MD("should-be-ignored", "Must never be discovered — node_modules is skipped.")
  );

  // ─── SKILL.md órfão: pasta pessoal sem SKILL.md próprio, contendo OUTRA
  // pasta com SKILL.md um nível fundo demais. `find -name SKILL.md` acha
  // (é só grep de nome), mas nenhuma versão real do host carrega isto —
  // não há `~/.claude/skills/orphan-container/SKILL.md`. Caso real medido:
  // `~/.claude/skills/expertise/iphone-apps/SKILL.md` nesta máquina.
  await fs.outputFile(
    path.join(claudeDir, "skills", "orphan-container", "nested-too-deep", "SKILL.md"),
    SKILL_MD("nested-too-deep", "Never loaded — one level too deep for the personal skills location.")
  );

  await fs.ensureDir(path.join(root, ".nexos", "map"));
  await fs.outputJson(path.join(root, ".nexos", "map", "project.json"), {
    facts: [{ fact: "language", value: "javascript/typescript", certainty: "OBSERVED", provenance: { file: "package.json" } }],
  });
}

beforeEach(buildFixture);
afterEach(async () => {
  await fs.remove(ws);
});

// ─── A1.1 · contagem bate com leitura independente ─────────────────────────

/** `find <dir> -name SKILL.md` reproduzido em Node: recursivo, nome EXATO, sem seguir symlink (paridade com o `find` real, sem `-L`). */
async function findSkillMdRecursive(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
    }
  }
  await visit(dir);
  return out;
}

describe("A1.1 · contagem bate com leitura independente", () => {
  it("agents/commands/plugins/mcp: diferença 0 contra JSON/readdir direto", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });

    const installedPluginsJson = await fs.readJson(path.join(claudeDir, "plugins", "installed_plugins.json"));
    expect(items.filter((i) => i.kind === "plugin")).toHaveLength(Object.keys(installedPluginsJson.plugins).length);

    const userMcpJson = await fs.readJson(path.join(homeDir, ".claude.json"));
    expect(items.filter((i) => i.kind === "mcp" && i.source === "personal")).toHaveLength(
      Object.keys(userMcpJson.mcpServers).length
    );

    expect(items.filter((i) => i.kind === "agent" && i.source === "personal")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "command" && i.source === "personal")).toHaveLength(2);
  });

  it("skills pessoais: reconta contra find ~/.claude/skills -name SKILL.md (sem -maxdepth) e explica a diferença", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const personalSkills = items.filter((i) => i.kind === "skill" && i.source === "personal");
    const foundByFind = await findSkillMdRecursive(path.join(claudeDir, "skills"));

    /**
     * A fixture deliberadamente contém as DUAS classes de desvio medidas no
     * A1.1 real (verifier, máquina real: 255 `find` × 247 scanner, explicado
     * por 9 órfãos excluídos e 1 symlink incluído — diff líquido -8):
     *
     *   +1 GANHO — `symlinked-skill`: `find` sem `-L` nunca segue symlink;
     *      o scanner segue (doc oficial, "Symlinked folders"), então conta
     *      uma skill que `find` perde.
     *   -1 PERDA — `orphan-container/nested-too-deep`: `find -name SKILL.md`
     *      acha por NOME, cego a estrutura; o scanner só reconhece
     *      `<claudeDir>/skills/<nome>/SKILL.md` (um nível), então
     *      corretamente NUNCA conta um `SKILL.md` dois níveis abaixo sem um
     *      `SKILL.md` no nível imediato — não é uma skill carregável, é só
     *      um arquivo com esse nome (caso real medido:
     *      `~/.claude/skills/expertise/iphone-apps/SKILL.md`).
     *
     * Nesta fixture as duas classes têm 1 exemplar cada — o líquido é 0 por
     * CONSTRUÇÃO da fixture, não porque as duas classes sempre se cancelam
     * na máquina real (lá, 1 symlink × 9 órfãos, diff líquido -8).
     */
    const knownGainFromSymlinks = 1;
    const knownLossFromOrphans = 1;
    expect(personalSkills.length).toBe(foundByFind.length + knownGainFromSymlinks - knownLossFromOrphans);

    // A skill órfã nunca aparece no relatório, sob nenhum nome.
    expect(personalSkills.some((s) => s.name.includes("nested-too-deep"))).toBe(false);
    expect(personalSkills.some((s) => s.name.includes("orphan-container"))).toBe(false);
  });
});

// ─── A1.1 (fatia discovery) · sincronizada, symlink, aninhada, plugin-root ─

describe("A1.1 · descoberta alinhada à doc oficial (skills.md)", () => {
  it("skill sincronizada da conta claude.ai entra como anthropic-skills:<nome>, sempre enabled", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const synced = items.find((i) => i.kind === "skill" && i.name === "anthropic-skills:synced-skill-a");
    expect(synced).toBeDefined();
    expect(synced?.source).toBe("personal");
    expect(synced?.enabled).toBe(true);
  });

  it("nome literal 'synced' nunca vira skill pessoal comum — é a localização reservada", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    expect(items.find((i) => i.kind === "skill" && i.name === "synced")).toBeUndefined();
  });

  it("skill pessoal symlinkada é seguida e contada", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const symlinked = items.find((i) => i.kind === "skill" && i.name === "symlinked-skill");
    expect(symlinked).toBeDefined();
    expect(symlinked?.source).toBe("personal");
  });

  it("skill de projeto aninhada (apps/web/.claude/skills/) entra com nome qualificado por path", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const nested = items.find((i) => i.kind === "skill" && i.name === "apps/web:nested-skill");
    expect(nested).toBeDefined();
    expect(nested?.source).toBe("project");
  });

  it("node_modules dentro do projeto nunca é descido em busca de .claude/skills aninhado", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    expect(items.some((i) => i.kind === "skill" && i.name.includes("should-be-ignored"))).toBe(false);
  });

  it("plugin root SKILL.md (sem subpasta skills/) vira <plugin-name>:<nome> — prefixo é o NOME NU do plugin, nunca <nome>@<marketplace>", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const rootSkill = items.find((i) => i.kind === "skill" && i.name === "plugin-root-only:root-skill-name");
    expect(rootSkill).toBeDefined();
    // `plugin_id` (provenance/enabled-lookup) continua qualificado por marketplace — só o NOME de invocação não é.
    expect(rootSkill?.plugin_id).toBe("plugin-root-only@market-a");
  });

  it("skill de plugin: frontmatter name vence o nome do diretório, sempre prefixado pelo NOME NU do plugin", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const named = items.find((i) => i.kind === "skill" && i.name === "plugin-a:fancy-name");
    expect(named).toBeDefined();
    // o nome do diretório ("internal-dir-name") nunca aparece — frontmatter venceu.
    expect(items.some((i) => i.kind === "skill" && i.name.includes("internal-dir-name"))).toBe(false);
  });

  it("skill de plugin: frontmatter name que já traz o prefixo do plugin não duplica", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const named = items.find((i) => i.kind === "skill" && i.name === "plugin-a:already-prefixed-name");
    expect(named).toBeDefined();
    expect(items.some((i) => i.name.startsWith("plugin-a:plugin-a:"))).toBe(false);
  });

  it("skill pessoal/projeto comum reporta o nome do DIRETÓRIO, nunca o frontmatter name (How a skill gets its command name)", async () => {
    await fs.outputFile(
      path.join(claudeDir, "skills", "directory-wins", "SKILL.md"),
      SKILL_MD("totally-different-frontmatter-name", "Directory name governs the command for personal/project skills.")
    );
    const { items } = await scanAll(root, { claudeDir, homeDir });
    expect(items.find((i) => i.kind === "skill" && i.name === "directory-wins")).toBeDefined();
    expect(items.some((i) => i.kind === "skill" && i.name === "totally-different-frontmatter-name")).toBe(false);
  });
});

// ─── A1.2 · cada item tem os campos exigidos ───────────────────────────────

describe("A1.2 · forma do item", () => {
  it("source, invocation, listing_chars sempre presentes; override resolvido de skillOverrides", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    for (const item of items) {
      expect(item.source).toBeDefined();
      expect(item.invocation).toBeDefined();
      expect(typeof item.listing_chars).toBe("number");
    }
    const overridden = items.find((i) => i.kind === "skill" && i.name === "personal-skill-a");
    expect(overridden?.override).toBe("on");

    const catalog = await loadCapabilityCatalog(root, { claudeDir, homeDir });
    expect(catalog.listing_chars_total).toBe(items.reduce((s, i) => s + i.listing_chars, 0));
  });

  it("plugin desabilitado propaga enabled=false para as skills que ele traz", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const pluginBSkill = items.find((i) => i.kind === "skill" && i.plugin_id === "plugin-b@market-a");
    expect(pluginBSkill?.enabled).toBe(false);
    const pluginASkill = items.find((i) => i.kind === "skill" && i.plugin_id === "plugin-a@market-a");
    expect(pluginASkill?.enabled).toBe(true);
  });

  it("paths e compatibility do frontmatter chegam intactos; skill sem os campos deixa ambos undefined", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const withFields = items.find((i) => i.kind === "skill" && i.name === "with-paths-and-compat");
    expect(withFields?.paths).toEqual(["**/*.sql", "migrations/**"]);
    expect(withFields?.compatibility).toBe("Requires PostgreSQL 14+");

    const withoutFields = items.find((i) => i.kind === "skill" && i.name === "personal-skill-a");
    expect(withoutFields?.paths).toBeUndefined();
    expect(withoutFields?.compatibility).toBeUndefined();
  });
});

// ─── A1.3 · duplicata exata por hash ────────────────────────────────────────

describe("A1.3 · duplicata detectada por hash", () => {
  it("dup-personal × dup-plugin × dup-project → um grupo DUPLICATE com os 3", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const groups = groupDuplicates(items);
    const tripleGroup = groups.find((g) => g.items.length === 3);
    expect(tripleGroup).toBeDefined();
    const sources = tripleGroup!.items.map((i) => i.source).sort();
    expect(sources).toEqual(["personal", "plugin", "project"]);

    const expectedHash = createHash("sha256")
      .update(await fs.readFile(path.join(claudeDir, "skills", "dup-personal", "SKILL.md")))
      .digest("hex");
    expect(tripleGroup!.content_hash).toBe(expectedHash);
  });

  it("skills sem par não entram em nenhum grupo", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const groups = groupDuplicates(items);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.some((id) => id.includes("personal-skill-a"))).toBe(false);
  });

  it("VARIANT: mesmo nome final, fontes distintas, hash diferente — nunca vira DUPLICATE", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const duplicateGroups = groupDuplicates(items);
    const variantGroups = groupVariants(items);

    const variant = variantGroups.find((g) => g.name === "variant-skill");
    expect(variant).toBeDefined();
    expect(variant!.items).toHaveLength(2);
    expect(new Set(variant!.items.map((i) => i.source))).toEqual(new Set(["personal", "plugin"]));
    expect(new Set(variant!.items.map((i) => i.content_hash)).size).toBe(2);

    // conteúdo diferente -> nunca aparece como DUPLICATE também.
    expect(duplicateGroups.some((g) => g.items.some((i) => i.id.includes("variant-skill")))).toBe(false);
  });

  it("um DUPLICATE exato (mesmo nome, mesmo hash) NÃO vira VARIANT", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const variantGroups = groupVariants(items);
    // dup-personal/dup-plugin/dup-project compartilham hash — mesmo em 3 fontes distintas, não é VARIANT.
    expect(variantGroups.find((g) => g.name === "dup")).toBeUndefined();
  });
});

// ─── A1.4 · --for sugere e reporta capability ausente ──────────────────────

describe("A1.4 · --for", () => {
  it("tarefa de teste falhando sem causa clara traz a skill de debugging no top 3, com motivo", async () => {
    const result = await suggestForRoot(root, "teste falhando sem causa clara", { claudeDir, homeDir });
    const names = result.suggestions.map((s) => s.item.name);
    expect(names).toContain("project-skill");
    const hit = result.suggestions.find((s) => s.item.name === "project-skill")!;
    expect(hit.why.length).toBeGreaterThan(0);
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
  });

  it("repo TS sem o binário do LSP no PATH reporta typescript-lsp-fixture como capability ausente (binário faltando)", async () => {
    const result = await suggestForRoot(root, "qualquer tarefa", { claudeDir, homeDir, pathEnv: "" });
    const gap = result.gaps.find((g) => g.name.startsWith("typescript-lsp-fixture"));
    expect(gap).toBeDefined();
    expect(gap!.reason).toMatch(/missing-binary/);
    expect(gap!.remedy).toContain("typescript-language-server-fixture");
  });

  it("binário presente no PATH da fixture → sem gap para essa linguagem", async () => {
    const binDir = path.join(ws, "bin");
    await fs.ensureDir(binDir);
    await fs.outputFile(path.join(binDir, "typescript-language-server-fixture"), "#!/bin/sh\n");
    await fs.chmod(path.join(binDir, "typescript-language-server-fixture"), 0o755);

    expect(binaryOnPath("typescript-language-server-fixture", { pathEnv: binDir })).toBe(true);

    const result = await suggestForRoot(root, "qualquer tarefa", { claudeDir, homeDir, pathEnv: binDir });
    expect(result.gaps.find((g) => g.name.startsWith("typescript-lsp-fixture"))).toBeUndefined();
  });

  it("suggestCapabilities aceita a mesma lista de items que scanAll produziu (sem I/O extra)", async () => {
    const { items } = await scanAll(root, { claudeDir, homeDir });
    const result = suggestCapabilities(items, "teste falhando sem causa clara");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

// ─── A1.6 · zero escrita fora de `.nexos` do projeto ───────────────────────

describe("A1.6 · leitura pura", () => {
  it("hash de settings.json (fixture) idêntico antes/depois de uma varredura completa", async () => {
    const settingsFile = path.join(claudeDir, "settings.json");
    const before = createHash("sha256").update(await fs.readFile(settingsFile)).digest("hex");

    await scanAll(root, { claudeDir, homeDir });
    await loadCapabilityCatalog(root, { claudeDir, homeDir });
    await suggestForRoot(root, "qualquer tarefa", { claudeDir, homeDir });

    const after = createHash("sha256").update(await fs.readFile(settingsFile)).digest("hex");
    expect(after).toBe(before);
  });

  it("nenhum arquivo novo aparece sob claudeDir depois da varredura", async () => {
    const listBefore = await listAllFiles(claudeDir);
    await scanAll(root, { claudeDir, homeDir });
    const listAfter = await listAllFiles(claudeDir);
    expect(listAfter).toEqual(listBefore);
  });
});

async function listAllFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else out.push(full);
    }
  }
  await visit(dir);
  return out.sort();
}
