/**
 * `nexos capabilities` — leitor. LEITURA PURA das superfícies nativas do
 * Claude Code (`~/.claude/skills`, `<root>/.claude/skills`,
 * `installed_plugins.json` + `enabledPlugins`, `agents/`, `commands/`,
 * `mcpServers` em `~/.claude.json` e `<root>/.mcp.json`, `lspServers` de
 * plugin, `skillOverrides`). Nunca escreve, nunca executa, nunca resolve
 * política — isso é `analyze.ts` e o Store (decisions/evidence).
 *
 *   PRESENCE != REGISTRATION
 *   OBSERVED SURFACE != CAPABILITY REGISTRY
 *
 * Cada função aceita os diretórios injetados (`claudeDir`/`homeDir`/`root`)
 * — mesmo padrão de `memory-authority.ts`/`memory-surfaces.ts`: produção usa
 * as constantes reais (`CLAUDE_DIR`, `os.homedir()`), teste injeta uma
 * fixture. Sem isso não há como testar A1.1/A1.3/A1.6 sem tocar o `$HOME`
 * real de quem roda o teste.
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { CLAUDE_DIR } from "../constants.js";
import type { CapabilityHealth, CapabilityItem, CapabilityIssue, OverrideValue } from "./types.js";

// ─── frontmatter ────────────────────────────────────────────────────────────

/** Como o frontmatter estava MALFORMADO, quando estava. Ausente = íntegro. */
export type FrontmatterIssue = "UNTERMINATED" | "INVALID_YAML";

interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly issue?: FrontmatterIssue;
}

/**
 * Último recurso quando o YAML do bloco inteiro não parseia: extrai SÓ o bloco
 * da chave `description` e parseia isolado.
 *
 * Existe porque o host LÊ arquivos que o parser estrito rejeita — medido em
 * 110 peças deste host, 109 com `description` recuperável. Um scanner que não
 * enxerga o que o runtime enxerga não mede o runtime, mede a si mesmo.
 */
function descriptionDeUltimoRecurso(raw: string): string | undefined {
  const lines = raw.split("\n");
  const inicio = lines.findIndex((l) => l.startsWith("description:"));
  if (inicio === -1) return undefined;
  const bloco = [lines[inicio] as string];
  /** Continuação de escalar em bloco (`>-`, `|`) é INDENTADA; a próxima chave começa na coluna 0. */
  for (let k = inicio + 1; k < lines.length; k++) {
    if (/^\S/.test(lines[k] as string)) break;
    bloco.push(lines[k] as string);
  }
  try {
    const parsed: unknown = parseYaml(bloco.join("\n"), { logLevel: "error" });
    if (!isRecord(parsed)) return undefined;
    return asString(parsed.description)?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Frontmatter YAML completo (não o parser ad-hoc de `agent/registry.ts` —
 * aquele não resolve mapas aninhados, e `metadata.stacks`/`metadata.port_ref`
 * são exatamente isso). `yaml` já é dependência do pacote — REUSE, não CREATE.
 */
function extractFrontmatter(text: string): Frontmatter | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return frontmatterSemFechamento(lines);

  const raw = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  try {
    /**
     * `logLevel: "error"` — arquivos reais têm frontmatter com placeholder de
     * template (`granola-meeting.md`: `date: {{date}}`) que o parser YAML
     * aceita degradando (stringifica a chave) mas avisa via `console.warn` por
     * padrão. É um WARNING sobre um documento de terceiro, não um erro deste
     * leitor — silenciar aqui evita poluir stderr de quem roda `nexos
     * capabilities`, sem esconder falha real (`parseYaml` ainda lança em YAML
     * genuinamente inválido, e o `catch` abaixo degrada para `null`).
     */
    const parsed: unknown = parseYaml(raw, { logLevel: "error" });
    return { data: isRecord(parsed) ? parsed : {}, body };
  } catch {
    /**
     * `PARSE FAILURE != ABSENT FIELD`. Antes isto devolvia `null` e o chamador
     * fazia `?? ""` — YAML quebrado virava indistinguível de "o autor não
     * escreveu description", e as ações são opostas (consertar o YAML × escrever
     * a descrição). Agora o defeito é NOMEADO e o campo é recuperado quando dá.
     * Mesma disciplina de `conformance.ts` (`IGNORED != INVALID`).
     */
    const desc = descriptionDeUltimoRecurso(raw);
    return { data: desc === undefined ? {} : { description: desc }, body, issue: "INVALID_YAML" };
  }
}

/**
 * Bloco aberto com `---` e sem linha de fechamento. O host TOLERA e lê o
 * frontmatter assim mesmo — medido em 3 skills deste host, cujas descrições
 * aparecem na listagem. Recupera pelo MAIOR prefixo que parseia, para nunca
 * inventar campo a partir do corpo markdown.
 */
function frontmatterSemFechamento(lines: readonly string[]): Frontmatter | null {
  /**
   * SÓ o bloco CONTÍGUO depois do `---` de abertura. A primeira linha em branco
   * encerra — sem isso a varredura desce pelo corpo markdown e um
   * `description:` escrito na PROSA vira frontmatter. O teste
   * "nunca inventa campo a partir do corpo markdown" pegou exatamente isso na
   * primeira versão desta função.
   */
  let fim = 1;
  while (fim < lines.length && (lines[fim] as string).trim() !== "") fim++;
  if (fim <= 1) return null;

  /** Do maior para o menor: a última linha pode estar corrompida (`valor---`). */
  for (let k = fim; k > 1; k--) {
    try {
      const parsed: unknown = parseYaml(lines.slice(1, k).join("\n"), { logLevel: "error" });
      if (isRecord(parsed) && asString(parsed.description) !== undefined) {
        return { data: parsed, body: lines.slice(fim).join("\n"), issue: "UNTERMINATED" };
      }
    } catch {
      /* prefixo maior que não parseia — tenta um menor */
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const strings = v.filter((x): x is string => typeof x === "string");
  return strings.length > 0 ? strings : undefined;
}

async function sha256File(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

// ─── diretórios ─────────────────────────────────────────────────────────────

export interface ScanRoots {
  /** `~/.claude` real por padrão — injetável só para teste. */
  readonly claudeDir?: string;
  /** `os.homedir()` real por padrão — só para o que lê fora de `.claude` (ex.: `~/.claude.json`). */
  readonly homeDir?: string;
  /** `PATH` real por padrão — injetável para testar `binaryOnPath` sem depender do `$PATH` de quem roda o teste. */
  readonly pathEnv?: string;
  readonly pathSep?: string;
}

function resolveClaudeDir(opts: ScanRoots): string {
  return opts.claudeDir ?? CLAUDE_DIR;
}
function resolveHomeDir(opts: ScanRoots): string {
  return opts.homeDir ?? os.homedir();
}

// ─── skills ─────────────────────────────────────────────────────────────────
//
// Descoberta alinhada à doc oficial (code.claude.com/docs/en/skills.md,
// lida 2026-09-17 — "Where skills live", "Where synced skills load", "Load
// skills in monorepos and subdirectories", "How a skill gets its command
// name"), achado do verifier em A1.1: a versão anterior deste arquivo só
// olhava `<dir>/<nome>/SKILL.md` (profundidade fixa) e perdia skills
// sincronizadas da conta claude.ai e skills de projeto aninhadas.

const SKILL_LISTING_CAP = 1536;

/** `(nomeDoDiretório, nomeDoFrontmatter) -> nome reportado`. Ver `How a skill gets its command name`. */
type SkillNameResolver = (dirName: string, frontmatterName: string | undefined) => string;

const NAME_FROM_DIRECTORY: SkillNameResolver = (dirName) => dirName;

/**
 * `Plugin skills/ subdirectory` / `Plugin root SKILL.md` — frontmatter
 * `name` OU nome do diretório, SEMPRE prefixado por `<plugin-name>:`, exceto
 * quando o `name` já começa com esse prefixo (doc: "Claude Code doesn't add
 * the prefix again").
 *
 *   INVOCATION PREFIX != REGISTRY ID
 *
 * Achado no próprio teste de fixture (guarda de duplo-prefixo): o prefixo
 * de invocação real é o NOME NU do plugin (`plugin.name`, ex. "plugin-a"),
 * NUNCA `plugin.id` (`plugin.name@marketplace`, ex. "plugin-a@market-a") —
 * a doc mostra sempre `/plugin-name:skill-name`, nunca marketplace no meio.
 * `plugin.id` continua correto em `CapabilityItem.plugin_id` (é a chave real
 * de `installed_plugins.json`/`enabledPlugins`), só não é o que vira texto
 * de comando.
 */
function qualifyPluginSkillName(pluginName: string, dirName: string, frontmatterName: string | undefined): string {
  const base = frontmatterName ?? dirName;
  return base.startsWith(`${pluginName}:`) ? base : `${pluginName}:${base}`;
}

/**
 * Lista subpastas candidatas de `dir` — SEGUE symlink (`fs.stat`, não o
 * `Dirent` de `readdir`, que reflete `lstat` e nunca marca um link como
 * diretório): doc oficial, "Symlinked folders" — "Claude Code reads
 * SKILL.md from the target". Sem isso, uma skill pessoal symlinkada (medido
 * neste disco: `~/.claude/skills/cua-driver` -> `~/.cua-driver/skills/
 * cua-driver`) some do inventário mesmo estando ATIVA na sessão real.
 */
async function listSkillCandidateDirs(dir: string): Promise<readonly { readonly dirName: string; readonly skillDir: string }[]> {
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { dirName: string; skillDir: string }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      const stat = await fs.stat(full).catch(() => undefined);
      isDir = stat?.isDirectory() ?? false;
    }
    if (isDir) out.push({ dirName: entry.name, skillDir: full });
  }
  return out;
}

/**
 * UM `SKILL.md` já localizado em `skillDir`.
 *
 *   CASE-INSENSITIVE LOOKUP != CASE-SENSITIVE NAME MATCH
 *
 * Medido neste disco (APFS, case-insensitive/case-preserving):
 * `fs.pathExists(path.join(dir, "SKILL.md"))` resolve `SKILL.MD` e
 * `skill.md` também — a mesma armadilha para QUALQUER filesystem
 * case-insensitive. Comparar a STRING devolvida por `readdir` (nunca o path
 * resolvido) é o que reproduz `find -name SKILL.md` byte a byte, e é a
 * mesma leitura que um host case-sensitive (Linux) faria.
 */
/**
 * Diretório de skill cujo arquivo existe com OUTRO case — invisível ao host e,
 * até agora, invisível ao audit também.
 *
 *   NÃO DESCOBERTA != INEXISTENTE
 *
 * MEDIDO em 2026-09-19 na máquina do dono: `database--postgres-schema-design`
 * guarda `SKILL.MD` (16 KB) e `design-principles` guarda `skill.md` (11 KB).
 * Nenhuma das duas aparece na listagem de skills do host, e nenhuma aparecia
 * no audit — 236 descobertas contra 244 diretórios, e a diferença passava como
 * se fossem pastas de apoio.
 *
 * O scan está CERTO em não carregá-las: `buildSkillItem` compara a string do
 * `readdir` byte a byte para reproduzir o que um host case-sensitive faz. O
 * defeito era só o silêncio — duas skills íntegras, com conteúdo, mortas no
 * disco, e ninguém tinha como saber. O audit existe exatamente para isso.
 */
export async function listSkillDirsComCaseErrado(
  dir: string
): Promise<readonly { readonly dirName: string; readonly encontrado: string; readonly file: string }[]> {
  const candidates = await listSkillCandidateDirs(dir);
  const out: { dirName: string; encontrado: string; file: string }[] = [];
  for (const { dirName, skillDir } of candidates) {
    if (dirName.toLowerCase() === "synced") continue;
    const inner: readonly string[] = await fs.readdir(skillDir).catch((): readonly string[] => []);
    if (inner.includes("SKILL.md")) continue;
    const errado = inner.find((f) => f.toLowerCase() === "skill.md");
    if (errado) out.push({ dirName, encontrado: errado, file: path.join(skillDir, errado) });
  }
  return out;
}

async function buildSkillItem(
  skillDir: string,
  resolveName: SkillNameResolver,
  source: CapabilityItem["source"],
  pluginId: string | undefined,
  enabled: boolean,
  override: OverrideValue | undefined
): Promise<CapabilityItem | undefined> {
  const inner: readonly string[] = await fs.readdir(skillDir).catch((): readonly string[] => []);
  if (!inner.includes("SKILL.md")) return undefined;
  const file = path.join(skillDir, "SKILL.md");

  const text = await fs.readFile(file, "utf-8").catch(() => undefined);
  if (text === undefined) return undefined;
  const fm = extractFrontmatter(text);
  const frontmatterName = asString(fm?.data.name);
  const name = resolveName(path.basename(skillDir), frontmatterName);
  const description = asString(fm?.data.description) ?? "";
  const metadata = isRecord(fm?.data.metadata) ? (fm!.data.metadata as Record<string, unknown>) : undefined;

  return {
    kind: "skill",
    id: `skill:${source}:${pluginId ?? ""}:${name}`,
    name,
    source,
    ...(pluginId ? { plugin_id: pluginId } : {}),
    invocation: "Skill tool",
    file,
    description,
    ...(asStringArray(fm?.data.paths) ? { paths: asStringArray(fm?.data.paths) } : {}),
    ...(asString(fm?.data.compatibility) ? { compatibility: asString(fm?.data.compatibility) } : {}),
    ...(override ? { override } : {}),
    ...(fm?.issue ? { frontmatter_issue: fm.issue } : {}),
    listing_chars: Math.min(description.length, SKILL_LISTING_CAP) + name.length,
    content_hash: await sha256File(file),
    enabled,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * `<dir>/*\/SKILL.md` — pessoal (`~/.claude/skills`), projeto na raiz
 * (`<root>/.claude/skills`), ou `skills/` de UM plugin já resolvido.
 * Diretório ausente é ZERO skills, nunca erro — caso comum.
 *
 * `"synced"` é nome RESERVADO (doc oficial) — pulado aqui sempre que
 * `pluginId` está ausente: é tratado à parte por `scanSyncedSkillDir`, com
 * profundidade e nomeação PRÓPRIAS (`anthropic-skills:<nome>`), nunca como
 * uma skill pessoal comum chamada "synced".
 *
 * `overrides` (`skillOverrides`) só se aplica a pessoal/projeto — doc:
 * plugin usa `/plugin`, não `skillOverrides`. Quem chama para um plugin
 * passa `{}`.
 */
export async function scanSkillDir(
  dir: string,
  source: CapabilityItem["source"],
  overrides: Readonly<Record<string, OverrideValue>>,
  pluginId?: string,
  pluginEnabled = true,
  resolveName: SkillNameResolver = NAME_FROM_DIRECTORY
): Promise<readonly CapabilityItem[]> {
  const candidates = await listSkillCandidateDirs(dir);
  const out: CapabilityItem[] = [];
  for (const { dirName, skillDir } of candidates) {
    if (!pluginId && dirName.toLowerCase() === "synced") continue;
    const override = overrides[dirName];
    const enabled = pluginEnabled && override !== "off";
    const item = await buildSkillItem(skillDir, resolveName, source, pluginId, enabled, override);
    if (item) out.push(item);
  }
  return out;
}

/**
 * `~/.claude/skills/synced/<sync-id>/<nome>/SKILL.md` — skills da conta
 * claude.ai (doc oficial, "Where synced skills load"): baixadas em segundo
 * plano por sessão autenticada, um nível MAIS FUNDO que uma skill pessoal
 * comum. Nome SEMPRE `anthropic-skills:<nome-do-diretório>` — prefixo FIXO
 * do host (doc: "How a skill gets its command name" → "prefixed with
 * `anthropic-skills:`"), nunca o id de sincronização (UUID interno sem
 * significado para quem lê a lista). `source: "personal"` — deliberado:
 * são skills ATIVAS nesta máquina/conta, não um quarto `CapabilitySource`
 * só para isto (o id/nome já deixam a origem clara via o prefixo).
 * `skillOverrides` não se aplica (gerido pela conta claude.ai, não pelo
 * settings.json local) — sempre `enabled: true` aqui.
 */
export async function scanSyncedSkillDir(claudeDir: string): Promise<readonly CapabilityItem[]> {
  const syncedRoot = path.join(claudeDir, "skills", "synced");
  if (!(await fs.pathExists(syncedRoot))) return [];
  const syncIdEntries = await fs.readdir(syncedRoot, { withFileTypes: true }).catch(() => []);
  const out: CapabilityItem[] = [];
  for (const syncIdEntry of syncIdEntries) {
    if (!syncIdEntry.isDirectory()) continue;
    const candidates = await listSkillCandidateDirs(path.join(syncedRoot, syncIdEntry.name));
    for (const { skillDir } of candidates) {
      const item = await buildSkillItem(
        skillDir,
        (dirName) => `anthropic-skills:${dirName}`,
        "personal",
        undefined,
        true,
        undefined
      );
      if (item) out.push(item);
    }
  }
  return out;
}

/** Diretórios que nunca valem a pena descer para achar `.claude/skills` aninhado — build output, dependências, VCS. */
const SKIP_NESTED_SCAN_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "coverage",
  ".turbo",
  ".cache",
]);
/** ponytail: teto fixo de profundidade para o walk de `.claude/skills` aninhado — monorepo real raramente passa disso; upgrade (configurável) se um caso real pedir. */
const MAX_NESTED_SKILLS_DEPTH = 8;

/**
 * `<root>/**\/.claude/skills/<nome>/SKILL.md`, EXCETO `<root>/.claude/skills`
 * (já coberto por `scanSkillDir` na raiz — doc oficial, "Load skills in
 * monorepos and subdirectories" / linha "Nested" da tabela de localização).
 *
 * Nome reportado SEMPRE qualificado por path (`<subdir-posix>:<nome>`) —
 * simplificação deliberada (ponytail): o host só qualifica de verdade
 * quando há COLISÃO de nome com outra skill; decidir isso exigiria montar a
 * árvore inteira ANTES de nomear qualquer item. Qualificar sempre garante
 * nome único no relatório sem esse custo, ao preço de reportar um prefixo
 * de path mesmo quando o host mostraria o nome nu — nunca inventa ausência
 * de colisão, só é mais conservador que o host real.
 */
export async function scanNestedProjectSkills(
  root: string,
  overrides: Readonly<Record<string, OverrideValue>>
): Promise<readonly CapabilityItem[]> {
  const out: CapabilityItem[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_NESTED_SKILLS_DEPTH) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".claude") {
        const relSubdir = path.relative(root, dir);
        if (relSubdir) {
          const qualifier = relSubdir.split(path.sep).join("/");
          const candidates = await listSkillCandidateDirs(path.join(dir, entry.name, "skills"));
          for (const { dirName, skillDir } of candidates) {
            const override = overrides[dirName];
            const item = await buildSkillItem(
              skillDir,
              () => `${qualifier}:${dirName}`,
              "project",
              undefined,
              override !== "off",
              override
            );
            if (item) out.push(item);
          }
        }
        continue;
      }
      if (SKIP_NESTED_SCAN_DIR_NAMES.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".claude")) continue;
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }

  await visit(root, 0);
  return out;
}

/**
 * `<plugin>/SKILL.md` na RAIZ do plugin, sem subpasta `skills/` — doc
 * oficial, "Plugin root SKILL.md": o plugin inteiro é uma skill só. Nome:
 * frontmatter `name`, com o próprio nome do plugin como fallback.
 */
export async function scanPluginRootSkill(
  pluginInstallPath: string,
  pluginId: string,
  pluginFallbackName: string,
  enabled: boolean
): Promise<CapabilityItem | undefined> {
  return buildSkillItem(
    pluginInstallPath,
    (dirName, frontmatterName) => qualifyPluginSkillName(pluginFallbackName, dirName, frontmatterName ?? pluginFallbackName),
    "plugin",
    pluginId,
    enabled,
    undefined
  );
}

/**
 * `Symlinked folders` (doc oficial) — "Claude Code ... loads the skill once
 * even if several locations point at the same target." Aplica-se só a
 * pessoal/projeto (plugin "handle symlinks differently", fora do escopo
 * medido aqui): dedupe pelo REAL path do `SKILL.md`, mantendo a PRIMEIRA
 * ocorrência (ordem de entrada já reflete a precedência pessoal > projeto
 * usada no resto do scanner).
 */
async function dedupeSkillsBySymlinkTarget(items: readonly CapabilityItem[]): Promise<readonly CapabilityItem[]> {
  const seen = new Set<string>();
  const out: CapabilityItem[] = [];
  for (const item of items) {
    const file = item.file;
    if (!file) {
      out.push(item);
      continue;
    }
    const real = await fs.realpath(file).catch(() => file);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(item);
  }
  return out;
}

// ─── agents / commands (arquivos .md soltos ou em subpastas namespaced) ────

async function walkMarkdown(dir: string): Promise<readonly string[]> {
  if (!(await fs.pathExists(dir))) return [];
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await visit(dir);
  return out;
}

async function readNamedMarkdownItem(
  kind: "agent" | "command",
  file: string,
  dir: string,
  source: CapabilityItem["source"],
  pluginId: string | undefined,
  enabled: boolean
): Promise<CapabilityItem | undefined> {
  const text = await fs.readFile(file, "utf-8").catch(() => undefined);
  if (text === undefined) return undefined;
  const fm = extractFrontmatter(text);
  const rel = path.relative(dir, file).replace(/\.md$/, "");
  /** Namespacing de comando: `consider/10-10-10.md` → `consider:10-10-10` (o mesmo separador que o host usa). */
  const derivedName = rel.split(path.sep).join(":");
  const name = asString(fm?.data.name) ?? derivedName;
  const description = asString(fm?.data.description) ?? "";

  return {
    kind,
    id: `${kind}:${source}:${pluginId ?? ""}:${name}`,
    name,
    source,
    ...(pluginId ? { plugin_id: pluginId } : {}),
    invocation: kind === "agent" ? "Task tool" : "/comando",
    file,
    description,
    ...(fm?.issue ? { frontmatter_issue: fm.issue } : {}),
    listing_chars: description.length + name.length,
    content_hash: await sha256File(file),
    enabled,
  };
}

/** `agents/*.md` — não recursivo (agentes não têm namespace por subpasta neste host). */
export async function scanAgentDir(
  dir: string,
  source: CapabilityItem["source"],
  pluginId?: string,
  enabled = true
): Promise<readonly CapabilityItem[]> {
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: CapabilityItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const item = await readNamedMarkdownItem("agent", path.join(dir, entry.name), dir, source, pluginId, enabled);
    if (item) out.push(item);
  }
  return out;
}

/**
 * `commands/**\/*.md` — recursivo (namespace por subpasta, ex.: `consider:10-10-10`).
 *
 * `overrides` entra aqui pela MESMA razão que entra em `scanSkillDir`:
 *
 *   COMMAND FILE É SKILL EM FORMATO ANTIGO
 *
 * A doc do host (skills.md) diz que `.claude/commands/deploy.md` e
 * `.claude/skills/deploy/SKILL.md` "both create /deploy and work the same
 * way", e `skillOverrides` casa por NOME. MEDIDO em 2026-09-19: sem isto, um
 * bloco de 470 entradas `off` no settings pessoal aparecia como 195 no audit,
 * e o relatório dizia ao usuário que 167 peças não podiam ser desligadas por
 * configuração. `undefined` preserva o comportamento de quem não passa nada
 * (plugin, que a doc mantém fora — ali o controle é `/plugin`).
 */
export async function scanCommandDir(
  dir: string,
  source: CapabilityItem["source"],
  pluginId?: string,
  enabled = true,
  overrides?: Readonly<Record<string, OverrideValue>>
): Promise<readonly CapabilityItem[]> {
  const files = await walkMarkdown(dir);
  const out: CapabilityItem[] = [];
  for (const file of files) {
    const item = await readNamedMarkdownItem("command", file, dir, source, pluginId, enabled);
    if (!item) continue;
    const override = overrides?.[item.name];
    out.push(
      override === undefined
        ? item
        : { ...item, override, ...(override === "off" ? { enabled: false } : {}) }
    );
  }
  return out;
}

// ─── settings.json (skillOverrides / enabledPlugins) ───────────────────────

interface SettingsChainOptions {
  readonly claudeDir: string;
  readonly root?: string;
}

/**
 * `project` (`<root>/.claude/settings.json`) vence sobre `user`
 * (`~/.claude/settings.json`) — mesma direção de precedência de
 * `memory-authority.ts`, restrita às DUAS chaves que este leitor usa (não a
 * cadeia `managed`/`local` inteira: aquelas ficam fora do escopo de
 * `capabilities`, que nunca decide política, só lê fato).
 */
async function readSettingsKey<T>(claudeDir: string, root: string | undefined, key: string): Promise<T | undefined> {
  const files = [
    ...(root ? [path.join(root, ".claude", "settings.json")] : []),
    path.join(claudeDir, "settings.json"),
  ];
  for (const file of files) {
    if (!(await fs.pathExists(file))) continue;
    try {
      const raw: unknown = await fs.readJson(file);
      if (isRecord(raw) && key in raw) return raw[key] as T;
    } catch {
      continue;
    }
  }
  return undefined;
}

const VALID_OVERRIDES: readonly OverrideValue[] = ["on", "off", "name-only", "user-invocable-only"];

export async function readSkillOverrides(opts: SettingsChainOptions): Promise<Readonly<Record<string, OverrideValue>>> {
  const raw = await readSettingsKey<Record<string, unknown>>(opts.claudeDir, opts.root, "skillOverrides");
  if (!isRecord(raw)) return {};
  const out: Record<string, OverrideValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && (VALID_OVERRIDES as readonly string[]).includes(value)) {
      out[name] = value as OverrideValue;
    }
  }
  return out;
}

export async function readEnabledPlugins(opts: SettingsChainOptions): Promise<Readonly<Record<string, boolean>>> {
  const project = opts.root
    ? await readSettingsKey<Record<string, unknown>>(opts.claudeDir, opts.root, "enabledPlugins")
    : undefined;
  const user = await fs.pathExists(path.join(opts.claudeDir, "settings.json")).then(async (exists) => {
    if (!exists) return undefined;
    try {
      const raw = await fs.readJson(path.join(opts.claudeDir, "settings.json"));
      return isRecord(raw) && isRecord(raw.enabledPlugins) ? (raw.enabledPlugins as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  });
  const merged: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(user ?? {})) if (typeof v === "boolean") merged[k] = v;
  for (const [k, v] of Object.entries(project ?? {})) if (typeof v === "boolean") merged[k] = v;
  return merged;
}

// ─── plugins instalados ─────────────────────────────────────────────────────

export interface InstalledPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly scope: string;
  readonly installPath: string;
  readonly version: string;
  readonly installedAt?: string;
  readonly enabled: boolean;
}

/**
 * `~/.claude/plugins/installed_plugins.json` — `plugins["<nome>@<market>"]`
 * é um ARRAY (uma entrada por escopo/versão); a mais recente por
 * `installedAt` é a que importa para o inventário — instalação repetida não
 * deve virar duplicata falsa no relatório.
 */
export async function readInstalledPlugins(claudeDir: string, root?: string): Promise<readonly InstalledPluginEntry[]> {
  const file = path.join(claudeDir, "plugins", "installed_plugins.json");
  if (!(await fs.pathExists(file))) return [];
  const raw: unknown = await fs.readJson(file).catch(() => undefined);
  if (!isRecord(raw) || !isRecord(raw.plugins)) return [];

  const enabled = await readEnabledPlugins({ claudeDir, root });
  const out: InstalledPluginEntry[] = [];
  for (const [id, value] of Object.entries(raw.plugins)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const latest = [...value]
      .filter(isRecord)
      .sort((a, b) => String(a.installedAt ?? "").localeCompare(String(b.installedAt ?? "")))
      .at(-1);
    if (!latest) continue;
    const at = id.indexOf("@");
    const name = at === -1 ? id : id.slice(0, at);
    const marketplace = at === -1 ? "" : id.slice(at + 1);
    out.push({
      id,
      name,
      marketplace,
      scope: asString(latest.scope) ?? "user",
      installPath: asString(latest.installPath) ?? "",
      version: asString(latest.version) ?? "unknown",
      ...(asString(latest.installedAt) ? { installedAt: asString(latest.installedAt) } : {}),
      enabled: enabled[id] === true,
    });
  }
  return out;
}

// ─── mcp ─────────────────────────────────────────────────────────────────

/**
 * Só `name` + o binário do `command` (quando `stdio`) — NUNCA `args`/`env`:
 * é onde credencial de MCP mora (`OAUTH_TOKEN`, chave de API). `redigir()`
 * (evidence.ts) protege stdout de execução; aqui a defesa é mais simples —
 * o campo nem é lido.
 *
 *   BINÁRIO PRESENTE != SERVIDOR RESPONDE
 *
 * `health` aqui é OBSERVADO SEM EXECUTAR — declarar pré-condição, nunca
 * tentar e reportar a falha (isso seria o NexOS invocando capability do
 * host, invertendo `CLAUDE EXECUTES, NEXOS UNDERSTANDS`,
 * nexos://decision/p1-0-remover-authorization-layer).
 *
 * Por isso binário no `$PATH` vira `unknown`, NUNCA `connected`. Medido em
 * 2026-09-19 nesta máquina: `notebooklm` é `stdio` com `command: "uvx"`,
 * `uvx` está em `~/.local/bin/uvx`, e o servidor falhou
 * com `CONNECTION_CLOSED` na mesma sessão. Chamar aquilo de `connected`
 * seria o chute otimista que este campo existe para não dar.
 *
 * O único estado que o filesystem decide sozinho é o negativo:
 * `stdio` cujo binário não existe NÃO pode subir. Esse vira `missing-binary`.
 * `http`/`sse` não tem sequer isso — sem executar, é `unknown`.
 */
function mcpItemFromEntry(
  name: string,
  entry: unknown,
  source: CapabilityItem["source"],
  opts: ScanRoots = {}
): CapabilityItem | undefined {
  if (!isRecord(entry)) return undefined;
  const command = asString(entry.command);
  const transport = asString(entry.type) ?? (command ? "stdio" : asString(entry.url) ? "http" : "unknown");
  const health: CapabilityHealth = command && !binaryOnPath(command, opts) ? "missing-binary" : "unknown";
  return {
    kind: "mcp",
    id: `mcp:${source}:${name}`,
    name,
    source,
    invocation: "servidor MCP",
    description: `transporte ${transport}`,
    listing_chars: name.length,
    enabled: true,
    health,
  };
}

export async function readUserMcpServers(homeDir: string, opts: ScanRoots = {}): Promise<readonly CapabilityItem[]> {
  const file = path.join(homeDir, ".claude.json");
  if (!(await fs.pathExists(file))) return [];
  const raw: unknown = await fs.readJson(file).catch(() => undefined);
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return [];
  return Object.entries(raw.mcpServers)
    .map(([name, entry]) => mcpItemFromEntry(name, entry, "personal", opts))
    .filter((x): x is CapabilityItem => x !== undefined);
}

/**
 * Os servidores MCP que NÃO estão em `mcpServers` e mesmo assim sobem na sessão.
 *
 *     O INVENTÁRIO VIA UM ARQUIVO DE CONFIG NÃO É O INVENTÁRIO DA SESSÃO
 *
 * MEDIDO em 2026-09-20: `nexos capabilities --kind mcp` enxergava 9 servidores e
 * 90 caracteres, enquanto a sessão carregava **472 ferramentas em 49
 * servidores**. Os 40 que faltavam nunca estiveram em `mcpServers` — vêm de
 * outras duas chaves do mesmo `~/.claude.json`, e por isso a cegueira passou
 * despercebida: o arquivo era o certo, a chave é que era uma só.
 *
 *     mcpServers                9   stdio/http declarados pelo usuário
 *     claudeAiMcpEverConnected 15   conectores da conta (Canva, Meta Ads, …)
 *     mcpNeedsAuthNoticed      26   servidores de plugin (`plugin:categoria:nome`)
 *                             ───
 *                              50   e 49 expuseram ferramenta na sessão medida
 *
 * O efeito de não ver isso não era cosmético: todo cálculo de custo de
 * superfície do NexOS media o catálogo de skills (144.055 chars, fonte exata) e
 * ignorava MCP, cujo piso só de NOMES já é 20.685 chars.
 *
 * O QUE ESTA FUNÇÃO NÃO PODE DAR, e por isso não finge dar: estas duas chaves
 * registram que o host CONHECE o servidor, nunca quantas ferramentas ele expõe
 * nem o tamanho do schema. `AVAILABLE != CONSUMED`, e um nome em lista não é
 * conexão. Contagem de ferramentas e custo de schema continuam `UNKNOWN` até
 * alguém ler o manifesto da sessão — que é fonte do host, não do disco.
 */
export async function readHostKnownMcpServers(homeDir: string): Promise<readonly CapabilityItem[]> {
  const file = path.join(homeDir, ".claude.json");
  if (!(await fs.pathExists(file))) return [];
  const raw: unknown = await fs.readJson(file).catch(() => undefined);
  if (!isRecord(raw)) return [];

  /** `mcpServers` já é lido por `readUserMcpServers` — aqui só o que ele não vê. */
  const declarados = new Set(isRecord(raw.mcpServers) ? Object.keys(raw.mcpServers) : []);
  const itens: CapabilityItem[] = [];

  const nomesDe = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : isRecord(v) ? Object.keys(v) : [];

  for (const [chave, origem, rotulo] of [
    ["claudeAiMcpEverConnected", "personal", "conector da conta"],
    ["mcpNeedsAuthNoticed", "plugin", "servidor de plugin"],
  ] as const) {
    for (const name of nomesDe(raw[chave])) {
      if (declarados.has(name)) continue;
      itens.push({
        kind: "mcp",
        id: `mcp:${origem}:${name}`,
        name,
        source: origem,
        invocation: "servidor MCP",
        /**
         * `health: "unknown"` sempre, e deliberadamente: estas chaves dizem que
         * o host já viu o servidor, jamais que ele subiu nesta sessão. Declarar
         * `connected` aqui seria o chute otimista que `mcpItemFromEntry`
         * também recusa a dar.
         */
        description: `${rotulo} — ferramentas e schema não observáveis pelo disco`,
        listing_chars: name.length,
        enabled: true,
        health: "unknown",
      });
    }
  }
  return itens;
}

export async function readProjectMcpServers(root: string, opts: ScanRoots = {}): Promise<readonly CapabilityItem[]> {
  const file = path.join(root, ".mcp.json");
  if (!(await fs.pathExists(file))) return [];
  const raw: unknown = await fs.readJson(file).catch(() => undefined);
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return [];
  return Object.entries(raw.mcpServers)
    .map(([name, entry]) => mcpItemFromEntry(name, entry, "project", opts))
    .filter((x): x is CapabilityItem => x !== undefined);
}

// ─── lsp (componente `lspServers` do `plugin.json`) ────────────────────────

export interface LspComponent {
  readonly pluginId: string;
  readonly language: string;
  readonly command: string;
}

/** `.claude-plugin/plugin.json` de UM plugin já resolvido em disco (instalado ou só cacheado num marketplace). */
async function readLspServersFromPluginJson(pluginJsonFile: string, pluginId: string): Promise<readonly LspComponent[]> {
  const raw: unknown = await fs.readJson(pluginJsonFile).catch(() => undefined);
  if (!isRecord(raw) || !isRecord(raw.lspServers)) return [];
  const out: LspComponent[] = [];
  for (const [language, def] of Object.entries(raw.lspServers)) {
    if (!isRecord(def)) continue;
    const command = asString(def.command);
    if (command) out.push({ pluginId, language, command });
  }
  return out;
}

/**
 * Descobre plugins com `lspServers` — instalados (via `installed_plugins.json`)
 * E catalogados em marketplace cacheado, mesmo sem estar instalado (é assim
 * que `--for` sabe recomendar `typescript-lsp` quando ele nem foi instalado
 * ainda). Nada aqui INSTALA nada — só lê `plugin.json`/`marketplace.json`.
 */
export async function discoverLspComponents(
  claudeDir: string,
  installed: readonly InstalledPluginEntry[]
): Promise<readonly LspComponent[]> {
  const out: LspComponent[] = [];
  const seen = new Set<string>();

  for (const plugin of installed) {
    if (!plugin.installPath) continue;
    const pluginJson = path.join(plugin.installPath, ".claude-plugin", "plugin.json");
    if (!(await fs.pathExists(pluginJson))) continue;
    for (const c of await readLspServersFromPluginJson(pluginJson, plugin.id)) {
      seen.add(c.pluginId);
      out.push(c);
    }
  }

  const marketplacesDir = path.join(claudeDir, "plugins", "marketplaces");
  if (await fs.pathExists(marketplacesDir)) {
    const entries = await fs.readdir(marketplacesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const marketplaceJson = path.join(marketplacesDir, entry.name, ".claude-plugin", "marketplace.json");
      const raw: unknown = await fs.readJson(marketplaceJson).catch(() => undefined);
      if (!isRecord(raw) || !Array.isArray(raw.plugins)) continue;
      for (const p of raw.plugins) {
        if (!isRecord(p) || !isRecord(p.lspServers)) continue;
        const name = asString(p.name);
        if (!name) continue;
        const pluginId = `${name}@${entry.name}`;
        if (seen.has(pluginId)) continue;
        seen.add(pluginId);
        for (const [language, def] of Object.entries(p.lspServers)) {
          if (!isRecord(def)) continue;
          const command = asString(def.command);
          if (command) out.push({ pluginId, language, command });
        }
      }
    }
  }
  return out;
}

/**
 * `$PATH` real por padrão — injetável (`opts.pathEnv`) para não depender do
 * `$PATH` de quem roda o teste.
 *
 *   COMANDO COM BARRA NÃO É PROCURADO NO $PATH
 *
 * Mesma regra de qualquer shell: `command` que já carrega separador é um
 * caminho, e resolvê-lo contra o `$PATH` produz lixo — `path.join("/usr/bin",
 * "/Users/x/bin/uvx")` vira `/usr/bin/Users/x/bin/uvx`, que nunca existe.
 *
 * Medido em 2026-09-19 na máquina do dono: sem este ramo, os MCP `pencil`
 * (`/Users/.../mcp-server-darwin-arm64`) e `browser-use`
 * (`/Users/.../.local/bin/uvx`) eram reportados `missing-binary` com os dois
 * binários presentes no disco. Alarme falso é pior que silêncio: manda
 * procurar defeito onde não há.
 */
export function binaryOnPath(command: string, opts: ScanRoots = {}): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const sep = opts.pathSep ?? path.delimiter;
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, command);
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function lspItemFromComponent(component: LspComponent, installedIds: ReadonlySet<string>, enabledIds: ReadonlySet<string>, opts: ScanRoots = {}): CapabilityItem {
  const installed = installedIds.has(component.pluginId);
  const enabled = enabledIds.has(component.pluginId);
  const onPath = binaryOnPath(component.command, opts);
  const health: CapabilityHealth = !installed ? "not-installed" : !onPath ? "missing-binary" : "connected";
  return {
    kind: "lsp",
    id: `lsp:plugin:${component.pluginId}`,
    name: component.pluginId,
    source: "plugin",
    plugin_id: component.pluginId,
    invocation: "language server",
    description: `${component.language} via ${component.command}`,
    listing_chars: component.pluginId.length,
    enabled: installed && enabled,
    health,
  };
}

// ─── orquestração de baixo nível para catálogo completo ────────────────────

export interface RawScan {
  readonly items: readonly CapabilityItem[];
  readonly issues: readonly CapabilityIssue[];
}

export async function scanAll(root: string, opts: ScanRoots = {}): Promise<RawScan> {
  const claudeDir = resolveClaudeDir(opts);
  const homeDir = resolveHomeDir(opts);
  const issues: CapabilityIssue[] = [];

  const overrides = await readSkillOverrides({ claudeDir, root });
  const installedPlugins = await readInstalledPlugins(claudeDir, root);

  /**
   * A1.1 (achado do verifier) — quatro fontes de skill pessoal/projeto, não
   * uma: raiz pessoal, `synced/` (conta claude.ai), raiz do projeto, e
   * `.claude/skills` aninhado em subpastas do projeto (monorepo). Dedupe por
   * symlink target roda sobre o conjunto INTEIRO (doc: dedup vale pra
   * "enterprise, personal, or project location" junto) antes de seguir.
   */
  const personalSkillsRaw = await scanSkillDir(path.join(claudeDir, "skills"), "personal", overrides);
  const syncedSkills = await scanSyncedSkillDir(claudeDir);
  const projectSkillsRaw = await scanSkillDir(path.join(root, ".claude", "skills"), "project", overrides);
  const nestedProjectSkills = await scanNestedProjectSkills(root, overrides);
  const personalAndProjectSkills = await dedupeSkillsBySymlinkTarget([
    ...personalSkillsRaw,
    ...syncedSkills,
    ...projectSkillsRaw,
    ...nestedProjectSkills,
  ]);

  const personalAgents = await scanAgentDir(path.join(claudeDir, "agents"), "personal");
  const projectAgents = await scanAgentDir(path.join(root, ".claude", "agents"), "project");
  const personalCommands = await scanCommandDir(path.join(claudeDir, "commands"), "personal", undefined, true, overrides);
  const projectCommands = await scanCommandDir(path.join(root, ".claude", "commands"), "project", undefined, true, overrides);
  const userMcp = await readUserMcpServers(homeDir, opts);
  /**
   * Os que sobem na sessão sem estar em `mcpServers`. Sem isto o inventário
   * reportava 9 servidores enquanto a sessão carregava 49 — e o cálculo de
   * custo de superfície ignorava a maior superfície do host.
   */
  const hostKnownMcp = await readHostKnownMcpServers(homeDir);
  const projectMcp = await readProjectMcpServers(root, opts);

  const pluginItems: CapabilityItem[] = [];
  for (const plugin of installedPlugins) {
    if (!plugin.installPath) {
      issues.push({ code: "PLUGIN_INSTALL_PATH_MISSING", detail: plugin.id });
      continue;
    }
    /**
     * INSTALLPATH DECLARADO != INSTALLPATH EXISTE.
     *
     * A guarda acima só pergunta se o CAMPO está setado. Um plugin cujo
     * `installPath` está gravado e cujo diretório NUNCA foi baixado passava
     * por aqui e era reportado `health=connected`, contribuindo zero skill,
     * zero agente e zero comando — em silêncio.
     *
     * MEDIDO em 2026-09-22: ligar um plugin escrevendo `enabledPlugins` no
     * `settings.json`, sem rodar `claude plugin install`, produz exatamente
     * isso. `skill-creator@claude-plugins-official` aparecia como
     * `✔ enabled` no host, registrado em `installed_plugins.json`, com
     * `health=connected` neste catálogo — e
     * `~/.claude/plugins/cache/.../skill-creator/c447c3207a42` não existia.
     * CINCO camadas afirmando "instalado e ligado" sobre arquivo ausente.
     *
     * É o mesmo defeito que o detector de referência quebrada tinha: confiar
     * na DECLARAÇÃO em vez de conferir o disco. O catálogo existe justamente
     * para não mentir sobre isto.
     */
    if (!(await fs.pathExists(plugin.installPath))) {
      issues.push({ code: "PLUGIN_INSTALL_PATH_ABSENT", detail: `${plugin.id} -> ${plugin.installPath}` });
      continue;
    }
    const enabled = plugin.enabled;
    /**
     * `skillOverrides` não vale para plugin (doc oficial: plugin usa
     * `/plugin`, não `skillOverrides`) — `{}`, nunca o mapa pessoal/projeto,
     * que colidiria por acaso se um skill de plugin tivesse o MESMO nome de
     * diretório que uma entrada pessoal.
     */
    pluginItems.push(
      ...(await scanSkillDir(path.join(plugin.installPath, "skills"), "plugin", {}, plugin.id, enabled, (dirName, fmName) =>
        qualifyPluginSkillName(plugin.name, dirName, fmName)
      )),
      ...(await scanAgentDir(path.join(plugin.installPath, "agents"), "plugin", plugin.id, enabled)),
      ...(await scanCommandDir(path.join(plugin.installPath, "commands"), "plugin", plugin.id, enabled))
    );
    /** "Plugin root SKILL.md" — o plugin inteiro pode SER uma skill, sem subpasta `skills/`. */
    const rootSkill = await scanPluginRootSkill(plugin.installPath, plugin.id, plugin.name, enabled);
    if (rootSkill) pluginItems.push(rootSkill);
    const mcpJson = path.join(plugin.installPath, ".mcp.json");
    if (await fs.pathExists(mcpJson)) {
      const raw: unknown = await fs.readJson(mcpJson).catch(() => undefined);
      if (isRecord(raw) && isRecord(raw.mcpServers)) {
        for (const name of Object.keys(raw.mcpServers)) {
          pluginItems.push({
            kind: "mcp",
            id: `mcp:plugin:${plugin.id}:${name}`,
            name,
            source: "plugin",
            plugin_id: plugin.id,
            invocation: "servidor MCP",
            listing_chars: name.length,
            enabled,
          });
        }
      }
    }
  }

  const lspComponents = await discoverLspComponents(claudeDir, installedPlugins);
  const installedIds = new Set(installedPlugins.map((p) => p.id));
  const enabledIds = new Set(installedPlugins.filter((p) => p.enabled).map((p) => p.id));
  const lspItems = lspComponents.map((c) => lspItemFromComponent(c, installedIds, enabledIds, opts));

  /**
   * `health` pergunta ao DISCO, não ao registro.
   *
   *   INSTALLPATH DECLARADO != INSTALLPATH EXISTE
   *
   * A versão anterior derivava `connected` de `p.installPath` ser uma string
   * não vazia. MEDIDO em 2026-09-22 neste host: SETE plugins registrados em
   * `installed_plugins.json` apontavam para diretório inexistente — dois
   * ligados na mesma sessão só por escrita em `enabledPlugins` (o download
   * nunca rodou) e cinco antigos com versão `unknown`. Todos apareciam
   * `health=connected`, contribuindo zero skill, zero agente e zero comando.
   *
   * `connected` sobre arquivo ausente é a mentira mais cara que um catálogo
   * pode contar: é exatamente a pergunta que ele existe para responder.
   */
  const pluginPathExists = new Map<string, boolean>();
  for (const p of installedPlugins) {
    pluginPathExists.set(p.id, p.installPath ? await fs.pathExists(p.installPath) : false);
  }
  const pluginCatalogItems: CapabilityItem[] = installedPlugins.map((p) => ({
    kind: "plugin",
    id: `plugin:${p.id}`,
    name: p.name,
    source: "plugin",
    plugin_id: p.id,
    invocation: "plugin",
    file: p.installPath || undefined,
    description: `${p.marketplace} · versão ${p.version} · escopo ${p.scope}`,
    listing_chars: p.name.length,
    enabled: p.enabled,
    health: !p.installPath
      ? "unknown"
      : !pluginPathExists.get(p.id)
        ? "not-installed"
        : p.enabled
          ? "connected"
          : "not-installed",
  }));

  const items = [
    ...personalAndProjectSkills,
    ...personalAgents,
    ...projectAgents,
    ...personalCommands,
    ...projectCommands,
    ...userMcp,
    ...hostKnownMcp,
    ...projectMcp,
    ...pluginItems,
    ...pluginCatalogItems,
    ...lspItems,
  ];

  return { items, issues };
}
