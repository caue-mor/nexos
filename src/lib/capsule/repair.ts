/**
 * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — MIGRATE_REPAIR:
 * a metade do contrato que repara um `.nexos` LEGACY_DEGRADED existente.
 *
 *   PLAN FIRST, WRITE SECOND
 *   BINDING_MISMATCH NEVER SELF-REPAIRS
 *   ORPHAN PROOF GATES DELETION, NEVER THE OTHER WAY AROUND
 *
 * `planRepair` é pura (recebe inspeção já feita, nunca toca disco).
 * `applyRepair` executa exatamente o plano — sem decisão nova no caminho da
 * escrita. `nexos init --dry-run` chama só `planRepair`; `--repair` chama os
 * dois, na ordem.
 */
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { forProject } from "./paths.js";
import { parseCanonical } from "./codec.js";
import { validateManifest, type ManifestBinding } from "./schemas.js";
import {
  boundaryKindOf,
  computeBinding,
  detectLinkedWorktreeMainIdentity,
  resolveProject,
  type BindingStatus,
  type LinkedWorktreeMainIdentity,
  type RootSource,
} from "../project-resolver.js";
import { classifyForReconciliation, initializeForReconciliation, removableLegacyEntries } from "./migration-classifier.js";
import { writeFreshProjectMap, refreshProjectMapIncremental } from "../map/project-map.js";
import {
  archiveTree,
  countTree,
  listFilesRecursive,
  newArchiveTimestamp,
  type ArchiveVerifyResult,
} from "./legacy-archive.js";

// ─── órfãos de memory/ ──────────────────────────────────────────────────────

export interface MemoryTitleRef {
  readonly kind: "gotcha" | "decision";
  readonly title: string;
  readonly heading: string;
  /** `GOTCHA-017` / `ADR-001` — chave estável, casa mesmo quando o título divergir em texto. */
  readonly anchor: string;
}

/**
 * Pós-MVP — ANCORADOS POR LINHA, de propósito. `\s` (inclusive `\s*`) casa
 * `\n` em JS regex mesmo dentro de um match iniciado por `^`/`gm`: um
 * heading sem o delimitador na MESMA linha (`## ADR-3` sem `:`, medido em
 * `1-demandas`) deixava `[^:]+`/`[^\]]+` — que também não excluem `\n` —
 * varrerem até o PRÓXIMO `:`/`]` do ARQUIVO INTEIRO, produzindo um "título"
 * multilinha falso (22 em `1-demandas`, 0 headings reais). Trocado `\s` por
 * `[ \t]` (só espaço/tab) e acrescentado `\n` às classes negadas — o mesmo
 * fix que `docs/pos-mvp-migracao-legado-inventario.md` §4/§10 mede como
 * `^##[ \t]*(ADR-[^:\n]+):`.
 */
const GOTCHA_HEADING = /^###[ \t]*\[(GOTCHA-[^\]\n]+)\][ \t]*(.+)$/gm;
const DECISION_HEADING = /^##[ \t]*(ADR-[^:\n]+):[ \t]*(.+)$/gm;

export function extractGotchaTitles(gotchasMd: string): MemoryTitleRef[] {
  return [...gotchasMd.matchAll(GOTCHA_HEADING)].map((m) => ({
    kind: "gotcha" as const,
    anchor: (m[1] ?? "").trim().toUpperCase(),
    title: (m[2] ?? "").trim(),
    heading: (m[0] ?? "").trim(),
  }));
}

export function extractDecisionTitles(decisionsMd: string): MemoryTitleRef[] {
  return [...decisionsMd.matchAll(DECISION_HEADING)].map((m) => ({
    kind: "decision" as const,
    anchor: (m[1] ?? "").trim().toUpperCase(),
    title: (m[2] ?? "").trim(),
    heading: (m[0] ?? "").trim(),
  }));
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface OrphanCheckResult {
  readonly totalTitles: number;
  readonly orphans: readonly MemoryTitleRef[];
  /** `true` só quando `orphans` está vazio — condição necessária para remover `memory/`. */
  readonly safeToRemove: boolean;
}

/**
 * P1.3b (fix do verifier) — chaves do Store já normalizadas: `titles` em
 * minúsculo/espaço colapsado, `anchors` em maiúsculo (`GOTCHA-017`/`ADR-001`).
 */
export interface StoreKeys {
  readonly titles: ReadonlySet<string>;
  readonly anchors: ReadonlySet<string>;
}

/**
 * PURA: um título de `memory/*.md` "tem record" se seu ANCHOR (`GOTCHA-N`/
 * `ADR-N`, estável entre convenções de `source_ref`) OU seu título
 * normalizado batem no Store. Anchor é a chave primária — dois migradores
 * diferentes (`c12-gotcha-migrator`/`c12-adr-migrator`) regravam `title` com
 * formatação própria (ex.: `"ADR-001: Stack ..."` no record vs `"Stack ..."`
 * no heading de `memory/decisions.md`), então texto sozinho sub-detecta.
 */
export function checkMemoryOrphans(titles: readonly MemoryTitleRef[], store: StoreKeys): OrphanCheckResult {
  const orphans = titles.filter((t) => !store.anchors.has(t.anchor) && !store.titles.has(normalizeTitle(t.title)));
  return { totalTitles: titles.length, orphans, safeToRemove: orphans.length === 0 };
}

/**
 * I/O: lê `memory/project/gotchas.md` + `decisions.md` (ausência de
 * qualquer um dos dois não é erro — vira zero títulos daquele tipo) e o
 * Store atual (`records/knowledge/*.yaml` com `kind: gotcha`,
 * `records/decisions/*.yaml`) para montar as chaves já canônicas.
 */
export async function scanMemoryOrphans(rootPath: string): Promise<OrphanCheckResult> {
  const memoryRoot = path.join(rootPath, ".nexos", "memory", "project");
  const gotchasMd = await readIfExists(path.join(memoryRoot, "gotchas.md"));
  const decisionsMd = await readIfExists(path.join(memoryRoot, "decisions.md"));

  const titles: MemoryTitleRef[] = [
    ...(gotchasMd ? extractGotchaTitles(gotchasMd) : []),
    ...(decisionsMd ? extractDecisionTitles(decisionsMd) : []),
  ];

  const store = await readStoreKeys(rootPath);
  return checkMemoryOrphans(titles, store);
}

async function readIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf-8");
  } catch {
    return undefined;
  }
}

// ─── inventário fail-closed de memory/ (qualquer arquivo, qualquer formato) ──

/** Duas localizações reconhecidas para os arquivos de índice: raiz e `project/`. */
const MEMORY_INDEX_LOCATIONS = ["", "project"] as const;

/** Índice de LINKS — convenção vigente: `- [título](caminho/relativo.md)`. */
const LINK_INDEX_LINE = /^-\s*\[(.+?)\]\(([^)]+)\)\s*$/gm;

export interface MemoryInventory {
  readonly totalFiles: number;
  /** Caminhos relativos a `memory/` que nenhum índice explica. */
  readonly unrecognized: readonly string[];
  readonly titles: readonly MemoryTitleRef[];
}

/**
 * Título+anchor de um índice em QUALQUER um dos dois formatos conhecidos:
 * heading legado (`### [GOTCHA-N] título` / `## ADR-N: título`) ou índice de
 * links (`- [título](caminho)`, a convenção vigente — cada linha aponta para
 * um arquivo em `gotchas/`/`decisions/`, nunca concatena o corpo no índice).
 * Somar as duas listas nunca produz falso positivo: os padrões não se
 * sobrepõem — um heading não casa a sintaxe de link, e vice-versa.
 */
function extractIndexTitles(kind: "gotcha" | "decision", content: string): MemoryTitleRef[] {
  const headings = kind === "gotcha" ? extractGotchaTitles(content) : extractDecisionTitles(content);
  const links: MemoryTitleRef[] = [...content.matchAll(LINK_INDEX_LINE)].map((m) => ({
    kind,
    anchor: "",
    title: (m[1] ?? "").trim(),
    heading: (m[0] ?? "").trim(),
  }));
  return [...headings, ...links];
}

/**
 * Alvos dos links de um índice, resolvidos relativo ao DIRETÓRIO do índice —
 * `[título](gotchas/x.md)` em `memory/gotchas.md` aponta para
 * `memory/gotchas/x.md`; o mesmo link em `memory/project/gotchas.md` aponta
 * para `memory/project/gotchas/x.md`.
 */
function linkTargets(content: string, indexDirRelToMemory: string): string[] {
  return [...content.matchAll(LINK_INDEX_LINE)].map((m) =>
    path.normalize(path.join(indexDirRelToMemory, (m[2] ?? "").trim()))
  );
}

/**
 * FAIL-CLOSED — inventário de TODO arquivo sob `memory/` (qualquer
 * profundidade), nas duas localizações de índice conhecidas (`memory/` e
 * `memory/project/`). Um arquivo só é "reconhecido" quando é um índice
 * (`gotchas.md`/`decisions.md`) com conteúdo entendido por um dos dois
 * formatos, OU o alvo de um link desse índice. Qualquer outro arquivo —
 * `state.md`, `research/*`, `session-journal/*`, um índice em formato
 * desconhecido, um arquivo solto não referenciado — fica em `unrecognized`.
 *
 *   ZERO TITLES != EVERYTHING MIGRATED
 *   FILE PRESENT != FILE UNDERSTOOD
 *
 * Medido: com os dois formatos de heading como único vocabulário, um índice
 * real no formato de links (a convenção vigente — CLAUDE.md memory rules:
 * "cada linha aponta para um arquivo") batia zero nos dois regexes — 0
 * título, 0 órfão, `safeToRemove: true` trivialmente — e `applyRepair`
 * apagava `memory/` inteiro, `state.md`/`research/`/`session-journal/`
 * incluídos, sem UMA prova de que o conteúdo tinha equivalente no Store.
 * `planRepair` passa a exigir `unrecognized.length === 0` ALÉM de
 * `checkMemoryOrphans(...).safeToRemove` antes de propor remoção.
 */
export async function scanMemoryInventory(rootPath: string): Promise<MemoryInventory> {
  const memoryRoot = path.join(rootPath, ".nexos", "memory");
  const allFiles = await listFilesRecursive(memoryRoot);

  const titles: MemoryTitleRef[] = [];
  const recognized = new Set<string>();

  for (const loc of MEMORY_INDEX_LOCATIONS) {
    for (const [basename, kind] of [
      ["gotchas.md", "gotcha"],
      ["decisions.md", "decision"],
    ] as const) {
      const relPath = path.join(loc, basename);
      const content = await readIfExists(path.join(memoryRoot, relPath));
      if (content === undefined) continue;

      const entries = extractIndexTitles(kind, content);
      if (entries.length === 0) {
        // Índice presente mas vazio (0 bytes/só espaço) é reconhecido — nada
        // para provar. Índice com CONTEÚDO que nenhum dos dois formatos
        // entende é layout desconhecido: some da lista de reconhecidos.
        if (content.trim().length === 0) recognized.add(relPath);
        continue;
      }
      recognized.add(relPath);
      titles.push(...entries);
      for (const target of linkTargets(content, loc)) recognized.add(target);
    }
  }

  const unrecognized = allFiles.filter((f) => !recognized.has(f));
  return { totalFiles: allFiles.length, unrecognized, titles };
}

/**
 * P1.3b (fix do verifier, era `readStoreTitles`) — o bug: filtrava
 * `KnowledgeRecord` por `source_ref: nexos://gotcha/...` antes de extrair o
 * título. 463 dos 593 `kind: gotcha` reais usam a convenção LEGADA do
 * migrador (`source_ref: .nexos/memory/project/gotchas.md#GOTCHA-N`) — o
 * gate rejeitava a família inteira e `storeTitles` saía vazio, fazendo TODO
 * título de `memory/` aparecer órfão. Correção: gate por `kind: gotcha` (não
 * por `source_ref`), e extrai o ANCHOR de QUALQUER convenção reconhecida
 * (nova `nexos://gotcha/...` não tem anchor numérico — só título; legada
 * `{gotchas,decisions}.md#ANCHOR` tem os dois).
 */
async function readStoreKeys(rootPath: string): Promise<StoreKeys> {
  const p = forProject(rootPath);
  const titles = new Set<string>();
  const anchors = new Set<string>();

  const gotchaDir = p.familyDir("KnowledgeRecord");
  for (const file of await listYamlFiles(gotchaDir)) {
    const record = await extractRecordKeys(file, "gotcha");
    if (!record) continue;
    if (record.title) titles.add(normalizeTitle(record.title));
    if (record.anchor) anchors.add(record.anchor);
  }

  const decisionDir = p.familyDir("Decision");
  for (const file of await listYamlFiles(decisionDir)) {
    const record = await extractRecordKeys(file, undefined);
    if (!record) continue;
    if (record.title) titles.add(normalizeTitle(record.title));
    if (record.anchor) anchors.add(record.anchor);
  }

  return { titles, anchors };
}

async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".yaml")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

const LEGACY_SOURCE_REF_ANCHOR = /(?:gotchas|decisions)\.md#([A-Za-z0-9_-]+)/;

/**
 * Extração deliberadamente TEXTUAL (não `parseCanonical` + schema completo)
 * — este módulo só precisa de título+anchor para comparar contra
 * `memory/*.md`. `expectedKind` opcional: quando presente, o arquivo só
 * conta se `kind:` bater EXATAMENTE (usado para `KnowledgeRecord`, que
 * carrega outros `kind` além de gotcha — `Decision` não precisa, o
 * diretório já é a family inteira).
 */
async function extractRecordKeys(
  file: string,
  expectedKind: string | undefined
): Promise<{ readonly title?: string; readonly anchor?: string } | undefined> {
  const raw = await readIfExists(file);
  if (!raw) return undefined;
  if (expectedKind) {
    const kindMatch = /^kind:\s*(\S+)/m.exec(raw);
    if (kindMatch?.[1] !== expectedKind) return undefined;
  }
  const sourceRefMatch = /source_ref:\s*(\S+)/.exec(raw);
  const anchorMatch = sourceRefMatch ? LEGACY_SOURCE_REF_ANCHOR.exec(sourceRefMatch[1] ?? "") : null;
  const titleMatch = /title:\s*(.+)/.exec(raw);
  return {
    title: titleMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
    anchor: anchorMatch?.[1]?.toUpperCase(),
  };
}

// ─── o plano ────────────────────────────────────────────────────────────────

export interface RepairAction {
  /**
   * Pós-MVP — `archive_path` substitui `remove_path` para TODO legado
   * (`memory/`, `logs/`, `records/<família fora do schema>`): a origem só
   * sai do lugar depois de copiada para `.nexos/.local/legacy-archive/` e
   * verificada byte a byte (`legacy-archive.ts`). `remove_path` continua
   * existindo só para `RETIRED_ENTRY_NAMES` — arquivos de formato/projeção
   * já retirados por decisão tomada (`project-effects.yaml`/`project.yaml`),
   * nunca conteúdo legado com informação a preservar.
   */
  readonly kind: "write_binding" | "remove_path" | "archive_path" | "keep_path";
  readonly detail: string;
  readonly path?: string;
}

export interface RepairPlan {
  readonly bindingAction:
    | "UNBOUND_TO_BOUND"
    | "ALREADY_BOUND"
    | "REFUSE_MISMATCH"
    | "CREATE_IDENTITY"
    | "REFUSE_NO_CAPSULE"
    | "REFUSE_LINKED_WORKTREE";
  readonly newBinding?: ManifestBinding;
  readonly newLastMappedCommit?: string;
  /** Só presente em `CREATE_IDENTITY` — nome para o manifest que `applyRepair` ainda vai criar. */
  readonly projectName?: string;
  /** `RETIRED_ENTRY_NAMES` — `rm` direto, sem cópia (nunca legado com informação). */
  readonly remove: readonly string[];
  /** Legado que sai do lugar via `archiveTree` — cópia verificada antes da remoção da origem. */
  readonly archive: readonly string[];
  readonly keep: readonly string[];
  readonly preserved: readonly string[];
  readonly memoryOrphans?: OrphanCheckResult;
  readonly actions: readonly RepairAction[];
}

export class RepairRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairRefusedError";
  }
}

/** Nomes retirados de `CANONICAL_ENTRIES` por decisão já tomada — removidos por nome explícito, nunca "entrada desconhecida" genérica. */
const RETIRED_ENTRY_NAMES: ReadonlySet<string> = new Set(["project-effects.yaml", "project.yaml"]);

/**
 * Monta o plano — LEITURA apenas. `bindingStatus` vem de `resolveProject`
 * (P1.1): `mismatch` faz o plano recusar (`REFUSE_MISMATCH`) sem calcular
 * remoção nenhuma — `init --repair` sem `--adopt-here`/`--bind` PARA aqui.
 *
 * P1.3c — `bindingStatus === "none"` (manifest AUSENTE, não só sem binding)
 * é um terceiro caso, distinto de UNBOUND_TO_BOUND: não há manifest para
 * gravar binding EM CIMA, a identidade inteira precisa nascer. `rootSource`
 * (de `ProjectResolution`, default `"git-root"` — todo teste/chamador que não
 * passa o valor real repara dentro de uma fronteira de verdade) distingue
 * "fronteira encontrada, manifest ausente" (`CREATE_IDENTITY` é viável) de
 * NO_PROJECT (nenhuma fronteira — nada para adotar, `REFUSE_NO_CAPSULE`).
 */
export async function planRepair(
  rootPath: string,
  bindingStatus: BindingStatus,
  adopt: { readonly forced: boolean } = { forced: false },
  rootSource: RootSource = "git-root"
): Promise<RepairPlan> {
  if (bindingStatus === "mismatch" && !adopt.forced) {
    return {
      bindingAction: "REFUSE_MISMATCH",
      remove: [],
      archive: [],
      keep: [],
      preserved: [],
      actions: [
        {
          kind: "keep_path",
          detail:
            "binding do manifest diverge do repositório observado agora — nexos init recusa " +
            "sem --adopt-here (adota este diretório) ou --bind ROOT (aponta o certo)",
        },
      ],
    };
  }

  const preflight = await classifyForReconciliation(rootPath);

  if (bindingStatus === "none") {
    if (rootSource === "none") {
      return refuseNoCapsule(
        "sem fronteira de projeto (.git ou marker) até a raiz do filesystem — " +
          "`nexos init --repair` não tem o que adotar aqui. Rode a partir de um diretório de projeto real."
      );
    }
    /**
     * P1.3c fix (verifier D1) — ABSENT e EMPTY (`.nexos` inexistente ou sem
     * NENHUMA entrada) checam PRIMEIRO: `classifyForReconciliation` devolve
     * `reconcilable: false` HARDCODED para ABSENT (nunca derivado de
     * `conflicting`, que fica `[]`) — checar `!preflight.reconcilable` antes
     * produzia "entrada(s) não reconhecida(s): " com a lista vazia, mensagem
     * sem sentido nenhum para uma árvore que não tem UMA entrada sequer.
     * `entries.length === 0` cobre ABSENT e EMPTY pelo mesmo teste; só DEPOIS
     * disso "não reconciliável" significa o que diz: entradas REAIS, uma
     * delas CONFLICTING_EXISTING.
     */
    if (preflight.entries.length === 0) {
      return refuseNoCapsule(
        "`.nexos` ausente ou vazio — nada para reparar aqui. Rode `nexos init` para criar `.nexos/manifest.yaml`."
      );
    }
    if (!preflight.reconcilable) {
      return refuseNoCapsule(
        `\`.nexos\` tem entrada(s) não reconhecida(s): ${preflight.conflicting.join(", ")} — ` +
          "resolva manualmente e rode `nexos init` (sem --repair)."
      );
    }
    /**
     * Pós-MVP (P1.3i B2 estendido a `--repair`) — mesma checagem que
     * `init.ts` já aplica no caminho `nexos init` puro (`.nexos`
     * ABSENT/EMPTY), agora também no caminho `--repair`/`--dry-run`: um
     * `.nexos` LEGACY (M4 — manifest ausente, memory/logs presentes) num
     * worktree git LINKED ao MESMO histórico de um checkout que já tem
     * `manifest.yaml` não pode ganhar um SEGUNDO `project.id`. Medido
     * (`docs/pos-mvp-migracao-legado-inventario.md` §8.2): 7 worktrees de
     * `projeto-A` sem manifest, cada `--repair` criando uma identidade
     * nova e arquivando o `memory/` de cada um separadamente — a MESMA
     * história virando 7 projetos. Recusa cedo, antes de montar qualquer
     * ação de arquivamento: a identidade é o problema, não o legado.
     */
    const foreignIdentity = await detectLinkedWorktreeMainIdentity(rootPath);
    if (foreignIdentity) {
      return refuseLinkedWorktree(foreignIdentity);
    }
  }

  const capsuleDir = forProject(rootPath).capsuleDir();

  const remove: string[] = [];
  const archive: string[] = [];
  const keep: string[] = [];
  const actions: RepairAction[] = [];

  // logs — sempre arquivável (LEGACY_TOLERATED, removalCandidate true):
  // cópia verificada em .nexos/.local/legacy-archive/<timestamp>/logs antes
  // de sair de .nexos/logs (`archiveTree`, aplicado em `applyRepair`).
  if (preflight.legacyTolerated.includes("logs")) {
    const count = await countTree(path.join(capsuleDir, "logs"));
    archive.push("logs");
    actions.push({
      kind: "archive_path",
      detail:
        `logs (legado tolerado, evidência local, não migra — ${count.files} arquivo(s), ${count.bytes} byte(s)) ` +
        "arquivado com hash verificado em .nexos/.local/legacy-archive/<timestamp>/logs antes de sair do lugar",
      path: "logs",
    });
  }
  // dev-scripts — nunca tocado neste ciclo, mesmo sendo legado tolerado.
  if (preflight.legacyTolerated.includes("dev-scripts")) {
    keep.push("dev-scripts");
    actions.push({ kind: "keep_path", detail: "dev-scripts intocado neste ciclo (P1.3)", path: "dev-scripts" });
  }
  // entradas verdadeiramente desconhecidas: só nomes retirados por decisão já
  // tomada (`project-effects.yaml` — ADR-071; `project.yaml` — P1.3c) são
  // removidos direto (formato/projeção retirado, nunca legado com
  // informação a preservar — não passa por archive); o resto de
  // `conflicting` fica listado, nunca apagado às cegas.
  for (const name of preflight.conflicting) {
    if (RETIRED_ENTRY_NAMES.has(name)) {
      remove.push(name);
      actions.push({ kind: "remove_path", detail: `${name} (formato/projeção retirado — decisão já tomada)`, path: name });
    } else {
      keep.push(name);
      actions.push({ kind: "keep_path", detail: `entrada desconhecida "${name}" — decisão humana, não removida às cegas`, path: name });
    }
  }

  // famílias de record fora do schema (host-observations etc.) — arquivadas por inteiro.
  const outsideSchema = await recordFamiliesOutsideSchema(rootPath);
  for (const family of outsideSchema) {
    const count = await countTree(path.join(capsuleDir, "records", family));
    archive.push(`records/${family}`);
    actions.push({
      kind: "archive_path",
      detail:
        `records/${family} (família fora do schema atual — ${count.files} arquivo(s), ${count.bytes} byte(s)) ` +
        `arquivado com hash verificado em .nexos/.local/legacy-archive/<timestamp>/records/${family} antes de sair do lugar`,
      path: `records/${family}`,
    });
  }

  // memory/ — só entra em `archive` se TODO arquivo sob memory/ (qualquer
  // profundidade, qualquer formato de índice reconhecido) foi contabilizado
  // E a prova de órfãos por título/anchor for limpa. `scanMemoryInventory`
  // é FAIL-CLOSED: qualquer arquivo fora do que os dois formatos de índice
  // conhecidos explicam derruba a remoção — `scanMemoryOrphans` sozinho
  // (só heading legado, só memory/project/) deixava passar zero-título
  // trivial para layout desconhecido.
  let memoryOrphans: OrphanCheckResult | undefined;
  if (preflight.legacyTolerated.includes("memory") || (await pathExists(path.join(capsuleDir, "memory")))) {
    const inventory = await scanMemoryInventory(rootPath);
    const store = await readStoreKeys(rootPath);
    memoryOrphans = checkMemoryOrphans(inventory.titles, store);
    if (inventory.unrecognized.length === 0 && memoryOrphans.safeToRemove) {
      const count = await countTree(path.join(capsuleDir, "memory"));
      archive.push("memory");
      actions.push({
        kind: "archive_path",
        detail:
          `memory/ (${memoryOrphans.totalTitles} título(s), 0 órfão — todos têm record no Store; ` +
          `${count.files} arquivo(s), ${count.bytes} byte(s)) arquivado com hash verificado em ` +
          ".nexos/.local/legacy-archive/<timestamp>/memory antes de sair do lugar",
        path: "memory",
      });
    } else {
      keep.push("memory");
      /** Motivos nunca se escondem um do outro — um pode ter os dois. */
      const motivos: string[] = [];
      if (inventory.unrecognized.length > 0) {
        motivos.push(
          `${inventory.unrecognized.length} arquivo(s) não reconhecido(s): ${inventory.unrecognized
            .slice(0, 3)
            .join(", ")}`
        );
      }
      if (!memoryOrphans.safeToRemove) {
        motivos.push(`${memoryOrphans.orphans.length}/${memoryOrphans.totalTitles} título(s) sem record no Store`);
      }
      actions.push({ kind: "keep_path", detail: `memory/ preservado — ${motivos.join("; ")}`, path: "memory" });
    }
  }

  if (bindingStatus === "none") {
    const { detectProjectInfo } = await import("../project-info.js");
    const projectName = (await detectProjectInfo(rootPath)).name;
    actions.push({
      kind: "write_binding",
      detail: `identidade ausente — cria .nexos/manifest.yaml (${projectName}) via reconciliação, legado tolerado preservado ao lado`,
    });
    return {
      bindingAction: "CREATE_IDENTITY",
      projectName,
      remove,
      archive,
      keep,
      preserved: ["decisions", "knowledge", "checkpoints", "research"],
      memoryOrphans,
      actions,
    };
  }

  const kind = await boundaryKindOf(rootPath);
  const newBinding =
    bindingStatus === "unbound" || (bindingStatus === "mismatch" && adopt.forced)
      ? await computeBinding(rootPath, kind)
      : undefined;
  /**
   * P1.3 — "gravar binding e last_mapped_commit no manifest existente"
   * (contrato). Só quando `newBinding` também está sendo gravado — um
   * manifest já BOUND não tem sua identidade nem seu mapeamento tocados por
   * este reparo (REFRESH incremental, P1.2, é quem avança
   * `last_mapped_commit` depois disso).
   */
  const newLastMappedCommit = newBinding && kind === "git" ? await readHeadCommitBestEffort(rootPath) : undefined;
  if (newBinding) {
    actions.push({
      kind: "write_binding",
      detail: `binding gravado no manifest existente (${newBinding.kind}, UNBOUND → BOUND)`,
    });
  }

  return {
    bindingAction: bindingStatus === "bound" ? "ALREADY_BOUND" : "UNBOUND_TO_BOUND",
    newBinding,
    newLastMappedCommit,
    remove,
    archive,
    keep,
    preserved: ["decisions", "knowledge", "checkpoints", "research", "identidade (project.id)"],
    memoryOrphans,
    actions,
  };
}

function refuseNoCapsule(detail: string): RepairPlan {
  return {
    bindingAction: "REFUSE_NO_CAPSULE",
    remove: [],
    archive: [],
    keep: [],
    preserved: [],
    actions: [{ kind: "keep_path", detail }],
  };
}

/**
 * Pós-MVP (P1.3i B2 estendido) — mesma forma de recusa de
 * `REFUSE_NO_CAPSULE`/`REFUSE_MISMATCH`: nada é tocado, `applyRepair` lança
 * antes de qualquer STAGE/archive. `identity.mainCheckoutPath`/
 * `mainProjectId` vêm de `detectLinkedWorktreeMainIdentity` — já provou
 * "mesmo histórico" via `git_root_commit`, nunca suposição.
 */
function refuseLinkedWorktree(identity: LinkedWorktreeMainIdentity): RepairPlan {
  return {
    bindingAction: "REFUSE_LINKED_WORKTREE",
    remove: [],
    archive: [],
    keep: [],
    preserved: [],
    actions: [
      {
        kind: "keep_path",
        detail:
          "este é um worktree git ligado ao MESMO histórico de um checkout já inicializado — nova identidade recusada. " +
          `checkout principal: ${identity.mainCheckoutPath} · project.id: ${identity.mainProjectId} · ` +
          "compartilhe a identidade: rode os comandos NexOS a partir do checkout principal, ou copie " +
          ".nexos/manifest.yaml dele para este worktree (mesmo git_root_commit — é o mesmo Store).",
      },
    ],
  };
}

async function readHeadCommitBestEffort(rootPath: string): Promise<string | undefined> {
  const { systemGitRunner } = await import("./git-boundary.js");
  const result = await systemGitRunner().run(["-C", rootPath, "rev-parse", "HEAD"]);
  return result.ok && result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function recordFamiliesOutsideSchema(rootPath: string): Promise<string[]> {
  const { listKnownFamilyYamlFiles } = await import("./reader.js");
  const outside: string[] = [];
  await listKnownFamilyYamlFiles(rootPath, (dirName) => outside.push(dirName));
  return outside.sort();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export interface ApplyRepairResult {
  /** Todo item que saiu de `.nexos` nesta chamada — `remove` (rm direto) + `archive` (archiveTree) juntos. */
  readonly removed: readonly string[];
  /**
   * Pós-MVP — subconjunto de `removed` que passou por `archiveTree` (cópia
   * verificada em `.nexos/.local/legacy-archive/`), nunca por `rm` direto.
   * `RÓTULO ARQUIVADO != RÓTULO REMOVIDO` — o CLI (`init.ts`) usa este campo
   * para nunca chamar de "removido" algo que só saiu do lugar original
   * porque uma cópia íntegra dele já existe em outro lugar.
   */
  readonly archived: readonly string[];
  /** Presente sse `archived.length > 0` — pasta de timestamp desta chamada. */
  readonly archiveRoot?: string;
}

/**
 * Executa o plano. Nunca chamado sem `planRepair` antes — `nexos init
 * --repair` sempre monta o plano primeiro (fonte única do que é seguro
 * remover). `REFUSE_MISMATCH`/`REFUSE_NO_CAPSULE` lançam: aplicar um plano
 * recusado seria o próprio bug que este módulo existe para nunca cometer.
 *
 *     PLAN FIRST, WRITE SECOND
 *     STAGE (aditivo) -> VERIFY (relê) -> COMMIT (remove)
 *
 * Ordem estrita, ANALYZE/PLAN já feitos pelo chamador via `planRepair`:
 *   STAGE   identidade (`CREATE_IDENTITY` via `initializeForReconciliation` —
 *           mesmo primitivo de `nexos init`/`nexos boot`; ou grava binding num
 *           manifest já existente) + Project Map (fresh se ainda não há
 *           `.nexos/map/project.json`, incremental — no-op se nada mudou —
 *           quando já há). Só escreve, nunca remove.
 *   VERIFY  relê a identidade que o STAGE acabou de escrever (`resolveProject`
 *           de novo) e confirma que o Project Map existe. Falhar aqui não
 *           apaga nada — a remoção nem começou.
 *   COMMIT  só agora `plan.remove` (rm direto — formatos retirados, nunca
 *           legado) e `plan.archive` (`archiveTree`: copia + verifica sha256
 *           + só então remove a origem, `legacy-archive.ts`) rodam. Um erro
 *           em STAGE/VERIFY propaga sem tocar em `logs/`/`memory/` — o
 *           legado sobrevive intocado a qualquer falha antes deste ponto.
 *           Uma falha de ARQUIVAMENTO (verificação de integridade reprovada)
 *           também vira `RepairRefusedError` — mensagem própria, nunca
 *           confundida com "STAGE/VERIFY falhou" — para o CLI nunca imprimir
 *           stack cru; a origem daquele item específico fica intocada e a
 *           cópia reprovada fica no disco para inspeção (nunca apagada).
 */
export async function applyRepair(
  rootPath: string,
  plan: RepairPlan,
  /**
   * Pós-MVP — injeção de teste, mesmo padrão de `archiveTree(..., verify)`:
   * produção nunca passa nada (usa `verifyArchiveIntegrity` real);
   * `tests/repair.test.ts` injeta um veredito falso para provar, sem mockar
   * módulo nenhum, que uma falha de integridade real vira mensagem limpa
   * aqui — não stack trace cru no CLI.
   */
  options: { readonly archiveVerify?: (source: string, dest: string) => Promise<ArchiveVerifyResult> } = {}
): Promise<ApplyRepairResult> {
  if (plan.bindingAction === "REFUSE_MISMATCH") {
    throw new RepairRefusedError(
      "[applyRepair] BINDING_MISMATCH — nexos init recusa reparo automático. " +
        "Use --adopt-here (adota este diretório) ou --bind ROOT (aponta o certo)."
    );
  }
  if (plan.bindingAction === "REFUSE_NO_CAPSULE") {
    throw new RepairRefusedError(
      `[applyRepair] reparo recusado — ${plan.actions[0]?.detail ?? "sem `.nexos/manifest.yaml` para reparar"}.`
    );
  }
  if (plan.bindingAction === "REFUSE_LINKED_WORKTREE") {
    throw new RepairRefusedError(
      `[applyRepair] IDENTIDADE DUPLICADA EM WORKTREE — ${
        plan.actions[0]?.detail ?? "worktree ligado a um checkout com identidade própria"
      }.`
    );
  }

  const p = forProject(rootPath);

  /**
   * STAGE + VERIFY compartilham um único try/catch: qualquer falha — inclusive
   * um erro cru de filesystem (ex.: `.nexos/map` já existe como ARQUIVO
   * regular, `mkdir` lança `ENOTDIR`) — precisa virar `RepairRefusedError` com
   * mensagem limpa ANTES de chegar no chamador (`nexos init --repair` não pode
   * imprimir stack trace cru). `COMMIT` fica FORA deste bloco de propósito:
   * nada nele pode lançar por engano e ser reclassificado como falha de STAGE.
   */
  try {
    // ─── STAGE — aditivo, nunca remove nada ────────────────────────────────
    if (plan.bindingAction === "CREATE_IDENTITY") {
      if (!plan.projectName) {
        throw new Error("CREATE_IDENTITY sem projectName — planRepair não montou o plano corretamente.");
      }
      await initializeForReconciliation(rootPath, { projectName: plan.projectName });
    } else if (plan.newBinding) {
      await writeBindingAndMappedCommit(rootPath, plan.newBinding, plan.newLastMappedCommit);
    }

    if (await pathExists(p.mapProjectJson())) {
      await refreshProjectMapIncremental(rootPath);
    } else {
      await writeFreshProjectMap(rootPath);
    }

    // ─── VERIFY — relê antes de remover qualquer path legado ───────────────
    /**
     * P1.3c fix (verifier D2) — exige `bindingStatus === "bound"` EXATO, não
     * "diferente de none/mismatch". `"unbound"` (manifest v1 sem binding)
     * passava aqui antes — um caso que o contrato (C3: "manifest + BOUND")
     * nunca aceitou como reparo concluído.
     */
    const verify = await resolveProject({ cwd: rootPath });
    if (verify.identitySource !== "manifest" || verify.bindingStatus !== "bound") {
      throw new Error(
        `resolveProject não confirma manifest BOUND pós-STAGE (bindingStatus=${verify.bindingStatus})`
      );
    }
    if (!(await pathExists(p.mapProjectJson())) || !(await pathExists(p.mapArchitectureMd()))) {
      throw new Error("Project Map incompleto pós-STAGE (project.json/architecture.md ausente)");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RepairRefusedError(`[applyRepair] STAGE/VERIFY falhou — ${reason}. Nenhum path legado foi removido.`);
  }

  // ─── COMMIT — só agora as remoções/arquivamentos do plano ────────────────
  const capsuleDir = p.capsuleDir();
  const removed: string[] = [];
  const archived: string[] = [];
  for (const rel of plan.remove) {
    await rm(path.join(capsuleDir, rel), { recursive: true, force: true });
    removed.push(rel);
  }
  /**
   * Pós-MVP — `plan.archive` (memory/, logs/, records/<família fora do
   * schema>) nunca vai direto para `rm`: `archiveTree` copia para
   * `.nexos/.local/legacy-archive/<timestamp>/<rel>`, verifica sha256 de
   * 100% dos arquivos (origem == destino) e SÓ ENTÃO remove a origem —
   * qualquer divergência aborta sem mover nada (`legacy-archive.ts`).
   * `archiveTree` é idempotente: origem já ausente (item já arquivado por um
   * `--repair` anterior) devolve `skipped: true` sem lançar, então não entra
   * em `removed` de novo.
   *
   * Falha de integridade (ou qualquer outro erro de `archiveTree`) vira
   * `RepairRefusedError` AQUI, item por item — itens já arquivados+removidos
   * antes deste ponto na mesma chamada PERMANECEM removidos (a operação
   * deles genuinamente terminou; não há o que desfazer, `ROLLBACK MINE !=
   * DELETE THEIRS` não se aplica a um sucesso real). Só o item que falhou
   * mantém a origem intocada.
   */
  let archiveRoot: string | undefined;
  if (plan.archive.length > 0) {
    const thisRunArchiveRoot = path.join(p.legacyArchiveRoot(), newArchiveTimestamp());
    for (const rel of plan.archive) {
      try {
        const result = await archiveTree(path.join(capsuleDir, rel), path.join(thisRunArchiveRoot, rel), options.archiveVerify);
        if (!result.skipped) {
          removed.push(rel);
          archived.push(rel);
          archiveRoot = thisRunArchiveRoot;
        }
      } catch (error) {
        /**
         * `ArchiveIntegrityError.message` (legacy-archive.ts) já descreve
         * tudo que o CLI precisa — origem intocada, e o destino EXATO da
         * cópia reprovada (mantida + marcada com o sentinela, OU removida
         * quando o próprio sentinela não pôde ser gravado). Repetir aqui
         * "mantida em X" incondicionalmente estaria ERRADO no segundo caso
         * (a cópia não existe mais) — só prefixamos o contexto do item.
         */
        const reason = error instanceof Error ? error.message : String(error);
        throw new RepairRefusedError(`[applyRepair] ARQUIVAMENTO de "${rel}" falhou — ${reason}`);
      }
    }
  }

  return { removed, archived, ...(archiveRoot !== undefined ? { archiveRoot } : {}) };
}

async function writeBindingAndMappedCommit(
  rootPath: string,
  binding: ManifestBinding,
  lastMappedCommit: string | undefined
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { serializeCanonical } = await import("./codec.js");
  const p = forProject(rootPath);
  const parsed = validateManifest(parseCanonical(await readFile(p.manifest(), "utf-8")));
  if (!parsed.ok) {
    throw new Error(`[applyRepair] manifest inválido em ${p.manifest()}: ${parsed.errors.join("; ")}`);
  }
  const updated = {
    ...parsed.value,
    binding,
    ...(lastMappedCommit !== undefined ? { last_mapped_commit: lastMappedCommit } : {}),
  };
  await writeFile(p.manifest(), serializeCanonical(updated), "utf-8");
}

/** `removableLegacyEntries` reexportado — usado pelo relatório de `nexos init --dry-run`. */
export { removableLegacyEntries };
