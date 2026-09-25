/**
 * Project Intelligence V1 — fatia 1: TASK → RELEVANT PROJECT FILES.
 *
 * Lê o grafo estático que o binário externo `graphify` já escreveu em
 * `graphify-out/graph.json` (node-link do NetworkX) e responde "que arquivos
 * deste projeto importam para esta tarefa em texto livre" — sem reindexar,
 * sem watcher, sem invocar o binário `graphify`. Este módulo só CONSOME o
 * artefato; gerá-lo é responsabilidade do provider externo, ainda
 * `provisional` no CapabilityRegistry (esta fatia não promove isso).
 *
 *   GRAPH EXISTS != GRAPH IS FRESH != GRAPH IS THE ANSWER
 *
 * `built_at_commit` diferente do HEAD atual (ou árvore suja) marca a resposta
 * STALE — nunca escondido atrás de um resultado que parece atual. Artefato
 * ausente é `NOT_AVAILABLE`; grafo sem `nodes[]`/`links[]`/`built_at_commit`
 * é `MALFORMED`, com detalhe explícito — nunca um pack vazio silencioso.
 *
 * Ranking V0: pesos simples e determinísticos sobre termos da task casados,
 * por PALAVRA INTEIRA (nunca substring — ver `symbolWords`), contra o label
 * do símbolo, componentes do `source_file`, e a vizinhança de 1 salto por
 * aresta EXTRACTED. Sem PageRank, sem embeddings — nada disso foi medido
 * como necessário, e um baseline exato é o que permite decidir depois se
 * algo mais caro compensa.
 */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { termosDe } from "./context-assembler.js";
import { readManifestProjectId, readManifestProjectName, type IntegrityIssue } from "./capsule/integrity.js";
import { forProject } from "./capsule/paths.js";
import { systemGitRunner, type GitRunner } from "./capsule/git-boundary.js";

// ─── forma do grafo (subconjunto que este módulo usa) ──────────────────────

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly norm_label?: string;
  /** Path relativo ao root do projeto. Ausente em ~119 nós reais (módulos
   *  externos como `node:os`) — esses nunca viram candidato a arquivo. */
  readonly source_file?: string;
  /** `"code"` | `"document"` | `"rationale"` | `"concept"` no grafo real. */
  readonly file_type?: string;
  readonly confidence?: string;
}

export interface GraphLink {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  readonly confidence?: string;
}

export interface GraphData {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
  readonly built_at_commit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asGraphNode(value: unknown): GraphNode | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return undefined;
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.norm_label === "string" ? { norm_label: value.norm_label } : {}),
    ...(typeof value.source_file === "string" ? { source_file: value.source_file } : {}),
    ...(typeof value.file_type === "string" ? { file_type: value.file_type } : {}),
    ...(typeof value.confidence === "string" ? { confidence: value.confidence } : {}),
  };
}

function asGraphLink(value: unknown): GraphLink | undefined {
  if (
    !isRecord(value) ||
    typeof value.source !== "string" ||
    typeof value.target !== "string" ||
    typeof value.relation !== "string"
  ) {
    return undefined;
  }
  return {
    source: value.source,
    target: value.target,
    relation: value.relation,
    ...(typeof value.confidence === "string" ? { confidence: value.confidence } : {}),
  };
}

export type LoadGraphResult =
  | { readonly ok: true; readonly graph: GraphData }
  | { readonly ok: false; readonly reason: "NOT_AVAILABLE" | "MALFORMED"; readonly detail: string };

/** Nós/links individualmente inválidos são descartados, não fatais — o grafo
 *  como um todo só é MALFORMED se as chaves de topo estiverem erradas. */
export async function loadGraph(graphPath: string): Promise<LoadGraphResult> {
  let raw: string;
  try {
    raw = await readFile(graphPath, "utf8");
  } catch {
    return { ok: false, reason: "NOT_AVAILABLE", detail: `artefato ausente: ${graphPath}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: "MALFORMED",
      detail: `JSON inválido em ${graphPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.links) ||
    typeof parsed.built_at_commit !== "string" ||
    parsed.built_at_commit.length === 0
  ) {
    return {
      ok: false,
      reason: "MALFORMED",
      detail: `${graphPath} não tem o formato esperado (nodes[]/links[]/built_at_commit string)`,
    };
  }

  const nodes = parsed.nodes.map(asGraphNode).filter((n): n is GraphNode => n !== undefined);
  const links = parsed.links.map(asGraphLink).filter((l): l is GraphLink => l !== undefined);
  return { ok: true, graph: { nodes, links, built_at_commit: parsed.built_at_commit } };
}

// ─── freshness ──────────────────────────────────────────────────────────────

export type Freshness = "FRESH" | "STALE";

/** Puro — testável sem spawnar git. `HEAD` desconhecido nunca é FRESH:
 *  não dá para provar frescor contra um HEAD que não se conseguiu medir. */
export function resolveFreshness(
  builtAtCommit: string,
  currentHead: string | undefined,
  dirty: boolean
): Freshness {
  if (currentHead === undefined) return "STALE";
  return !dirty && currentHead === builtAtCommit ? "FRESH" : "STALE";
}

async function gitHeadAndDirty(
  root: string,
  runner: GitRunner
): Promise<{ head: string | undefined; dirty: boolean }> {
  const headOut = await runner.run(["-C", root, "rev-parse", "HEAD"]);
  const head = headOut.ok && headOut.code === 0 ? headOut.stdout.trim() : undefined;
  const statusOut = await runner.run(["-C", root, "status", "--porcelain"]);
  const dirty = statusOut.ok && statusOut.code === 0 ? statusOut.stdout.trim().length > 0 : false;
  return { head, dirty };
}

/** Distância em commits entre o grafo e o HEAD atual. `UNKNOWN` quando o git
 *  não consegue resolver o intervalo (ex.: `built_at_commit` fora do
 *  histórico local) — nunca inventa um número. */
async function commitsBehind(
  root: string,
  runner: GitRunner,
  builtAtCommit: string,
  head: string
): Promise<number | "UNKNOWN"> {
  const out = await runner.run(["-C", root, "rev-list", "--count", `${builtAtCommit}..${head}`]);
  if (!out.ok || out.code !== 0) return "UNKNOWN";
  const n = Number(out.stdout.trim());
  return Number.isFinite(n) ? n : "UNKNOWN";
}

/**
 * A3.3 — paths com diff contra `builtAtCommit` (commitado OU não: `git diff
 * <commit>`, sem um segundo ref, compara a árvore desse commit direto contra
 * a working tree). `UNKNOWN` quando o git não resolve (`builtAtCommit` fora
 * do histórico local) — nunca inventa "não mudou" por omissão.
 */
async function changedFilesSince(
  root: string,
  runner: GitRunner,
  builtAtCommit: string
): Promise<ReadonlySet<string> | "UNKNOWN"> {
  const out = await runner.run(["-C", root, "diff", "--name-only", builtAtCommit]);
  if (!out.ok || out.code !== 0) return "UNKNOWN";
  return new Set(
    out.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

// ─── frescor por conteúdo ───────────────────────────────────────────────────

/**
 * graphify 0.9.43 não regrava `built_at_commit` em `graph.json` quando um
 * `update` não muda a topologia (ex.: edição só de comentário) — só
 * `manifest.json` (mtime por arquivo já indexado) é regravado. Sem isto,
 * `resolveFreshness` por commit fica STALE PARA SEMPRE depois do primeiro
 * commit sem mudança de topologia, mesmo com o grafo content-wise atual.
 *
 *   COMMIT DIVERGIU != CONTEÚDO DIVERGIU
 *
 * Esta camada reconcilia um STALE do commit puro: para cada arquivo
 * INDEXÁVEL que `git diff` aponta como diferente do `built_at_commit`
 * (commitado ou não — mesma fonte de `changedFilesSince`), compara o mtime
 * atual em disco contra o mtime que `graphify-out/manifest.json` tem
 * registrado. Só sobe STALE de novo se algum arquivo indexável tiver mtime
 * divergente OU não estiver no manifest — nunca por distância de commit
 * sozinha.
 */

interface GraphifyManifestEntry {
  readonly mtime: number;
}

function asManifestEntry(value: unknown): GraphifyManifestEntry | undefined {
  if (!isRecord(value) || typeof value.mtime !== "number") return undefined;
  return { mtime: value.mtime };
}

/** Ausente/malformado → `undefined`: nenhum arquivo pode ser confirmado como
 *  já visto por graphify, então todo indexável muda vira mismatch (conservador). */
async function loadGraphifyManifest(manifestPath: string): Promise<ReadonlyMap<string, number> | undefined> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const out = new Map<string, number>();
  for (const [relPath, value] of Object.entries(parsed)) {
    const entry = asManifestEntry(value);
    if (entry) out.set(relPath, entry.mtime);
  }
  return out;
}

/** `.graphifyignore` é uma lista simples de prefixos de diretório (ver o
 *  arquivo real) — nunca reimplementa matching de `.gitignore`, só a mesma
 *  lista que já decide o que graphify indexa. Ausente → sem exclusão extra. */
async function loadGraphifyIgnorePrefixes(root: string): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, ".graphifyignore"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isGraphifyIndexable(relPath: string, ignorePrefixes: readonly string[]): boolean {
  return !ignorePrefixes.some((prefix) => relPath === prefix || relPath.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

/**
 * Subconjunto de `changedFiles` que é (a) indexável por graphify e (b) tem
 * mtime em disco diferente do que `manifest.json` registrou, ou não consta
 * do manifest. Vazio ⇒ todo arquivo que difere do `built_at_commit` já foi
 * revisto por graphify no estado atual — o STALE por commit é falso positivo.
 */
async function manifestMismatchedFiles(root: string, changedFiles: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const ignorePrefixes = await loadGraphifyIgnorePrefixes(root);
  const indexable = [...changedFiles].filter((f) => isGraphifyIndexable(f, ignorePrefixes));
  if (indexable.length === 0) return new Set();

  const manifest = await loadGraphifyManifest(path.join(root, "graphify-out", "manifest.json"));
  const mismatched = new Set<string>();
  for (const relPath of indexable) {
    const recorded = manifest?.get(relPath);
    if (recorded === undefined) {
      mismatched.add(relPath);
      continue;
    }
    try {
      const diskStat = await stat(path.join(root, relPath));
      // manifest guarda segundos (float); mtimeMs é milissegundos — arredonda
      // os dois pro mesmo grão pra não falhar por ruído de ponto flutuante
      // (medido: ~2.4e-7s de diferença pro mesmo arquivo não tocado).
      if (Math.round(diskStat.mtimeMs) !== Math.round(recorded * 1000)) mismatched.add(relPath);
    } catch {
      mismatched.add(relPath); // arquivo sumiu do disco — mudança real
    }
  }
  return mismatched;
}

/**
 * Frescor isolado (sem ranking) — usado por `nexos graph` (fatia 2), que só
 * precisa do cabeçalho FRESH/STALE de um grafo já carregado, não da fase de
 * ranking que exige uma `task` em texto livre. Mesmo algoritmo de
 * `queryRelevantFiles` (commit puro + reconciliação por conteúdo).
 */
export async function resolveGraphFreshness(
  projectRoot: string,
  builtAtCommit: string,
  gitRunner?: GitRunner
): Promise<{ readonly status: Freshness; readonly current_head: string | undefined }> {
  const runner = gitRunner ?? systemGitRunner();
  const { head, dirty } = await gitHeadAndDirty(projectRoot, runner);
  let status = resolveFreshness(builtAtCommit, head, dirty);
  if (status === "STALE" && head !== undefined) {
    const changedFiles = await changedFilesSince(projectRoot, runner, builtAtCommit);
    if (changedFiles !== "UNKNOWN") {
      const mismatched = await manifestMismatchedFiles(projectRoot, changedFiles);
      if (mismatched.size === 0) status = "FRESH";
    }
  }
  return { status, current_head: head };
}

// ─── ranking V0 ─────────────────────────────────────────────────────────────

const WEIGHT_LABEL = 3;
const WEIGHT_PATH = 2;

/** Peso por tipo de aresta incidente — `calls`/`extends`/`indirect_call`/
 *  `method` denotam uso real de código; `imports`/`references`/`uses` são
 *  sinal mais fraco de acoplamento. Ausente da tabela = peso 1. */
const RELATION_WEIGHT: Readonly<Record<string, number>> = {
  calls: 2,
  indirect_call: 2,
  extends: 2,
  method: 2,
  imports: 1,
  imports_from: 1,
  references: 1,
  uses: 1,
  rationale_for: 1,
};

/** `contains` é hierarquia estrutural (arquivo→símbolo, doc→parágrafo) — 72%
 *  dos links do grafo real medido (24618/34324). Propagar por ele inundaria
 *  a vizinhança de 1 salto com ruído de estrutura, não relação de código. */
const NEIGHBOR_EXCLUDED_RELATIONS = new Set(["contains"]);

const MAX_ITEMS = 50;
const DEFAULT_LIMIT = 10;

interface Hit {
  readonly kind: "label" | "path" | "neighbor";
  readonly term: string;
  /** Texto humano do que casou — nome do símbolo, ou "símbolo em arquivo". */
  readonly detail: string;
  readonly relation?: string;
  readonly provenance: string;
  readonly weight: number;
}

export interface RelevantFileItem {
  readonly path: string;
  /** Diz qual termo casou com o quê e por qual relação — nunca prosa de LLM. */
  readonly reason: string;
  /** `confidence`/`_origin` do grafo quando presente; `UNKNOWN` quando ausente. */
  readonly provenance: string;
  /** `"direct"` (label/path do próprio arquivo) ou a relation do grafo
   *  (`calls`, `imports`, ...) quando o sinal mais forte veio de 1 salto. */
  readonly relation: string;
  /** `false` = o path não existe mais na working tree atual — grafo pode
   *  estar referenciando um arquivo já deletado/renomeado. */
  readonly exists: boolean;
  /**
   * Onda 1B (A3.3) — honestidade de frescor POR ITEM: `true` quando este
   * path específico tem diff contra `built_at_commit` (commitado ou não).
   * `UNKNOWN` quando o git não conseguiu resolver o diff (`builtAtCommit`
   * fora do histórico local, por exemplo) — nunca vira `false` por omissão,
   * mesma disciplina de `graph_age`.
   */
  readonly changed_since_built: boolean | "UNKNOWN";
  readonly score: number;
}

export interface RankOptions {
  readonly limit?: number;
  /** Injetável para teste; produção usa `existsSync` real contra o root. */
  readonly fileExists?: (relPath: string) => boolean;
  /**
   * Onda 1B (G3.3) — tokens do PRÓPRIO nome do projeto (`manifest.project.name`,
   * quebrado em palavras). Um candidato cujo ÚNICO termo casado é um destes
   * tokens é ruído genérico (o nome do projeto aparece em quase todo path/
   * símbolo) e é descartado — mas o token continua contribuindo peso normal
   * quando corrobora outro termo real do mesmo candidato.
   */
  readonly selfTokens?: ReadonlySet<string>;
  /**
   * Onda 1B (A3.3) — path → mudou desde `built_at_commit` (diff real,
   * commitado ou não). `"UNKNOWN"` quando o chamador não conseguiu computar
   * o diff — propaga para `changed_since_built` de TODO item, nunca vira
   * `false` por omissão.
   */
  readonly changedFiles?: ReadonlySet<string> | "UNKNOWN";
}

export interface RankResult {
  readonly items: readonly RelevantFileItem[];
  readonly candidateCount: number;
}

function pathTerms(sourceFile: string): Set<string> {
  const semExtensaoFinal = sourceFile.replace(/\.[^./]+$/, "");
  return termosDe(semExtensaoFinal.replace(/[/_.-]+/g, " "));
}

/**
 * Tokens de PALAVRA INTEIRA de um símbolo (`node.label`) — nunca substring.
 *
 *   SUBSTRING CURTA != SINAL — é ruído: "esta" bate dentro de `attestACL`,
 *   `TargetResolution`, `HostSurfaceStageResultSchema`; "dia" bate dentro de
 *   `DialecticEngine`. Nenhum dos dois tem relação com o símbolo — colidem só
 *   porque a sequência de letras aparece no meio de outra palavra. Medido
 *   contra o grafo real: "resuma esta frase em tres palavras" (pedido trivial,
 *   zero relação com código) trazia 5 arquivos score 6 SÓ por essas colisões.
 *
 * `node.label` preserva case (`CapabilityListOptions`), diferente de
 * `norm_label` (idêntico a `label.toLowerCase()` para símbolos de código —
 * medido: nenhum node `code` do grafo real tem `norm_label` com informação
 * além disso). Cortar em fronteira de palavra exige o case original — usar
 * `norm_label` aqui destruiria a própria informação de que este fix depende.
 *
 * Fronteiras reconhecidas: transição minúscula/dígito→MAIÚSCULA
 * (`fooBar`→foo,Bar), sigla seguida de palavra (`ACLSchema`→ACL,Schema), e
 * qualquer separador não alfanumérico (`.`, `_`, `-`, `()`, `:`). Cada pedaço
 * vira um termo inteiro, comparado por igualdade — nunca por `includes`.
 */
function symbolWords(label: string): Set<string> {
  const withBoundaries = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ");
  return new Set(
    withBoundaries
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => t.toLowerCase())
  );
}

/**
 * Termos da QUERY do usuário, decompostos pela MESMA fronteira de palavra
 * que `symbolWords` aplica ao LABEL do símbolo — correção da regressão
 * introduzida por 45136b6 (handoff 2026-09-06).
 *
 *   LABEL DECOMPOSTO EM PALAVRAS != QUERY DECOMPOSTA DA MESMA FORMA
 *
 * 45136b6 trocou o match de substring por PALAVRA INTEIRA contra
 * `symbolWords(label)`, mas só decompunha o LABEL — a query continuava
 * inteira via `termosDe`. `termosDe("readCurrentRecords")` não separa por
 * case (não é seu trabalho: ela tokeniza texto livre por espaço/pontuação),
 * então o nome vira UM termo colado `readcurrentrecords`, que nunca é igual
 * a nenhuma das palavras {read, current, records} do label. Buscar pelo
 * nome exato de um símbolo — o caso mais óbvio de busca — voltava vazio
 * mesmo com o símbolo presente no grafo.
 *
 * Correção SIMÉTRICA, não uma segunda decomposição: reusa `symbolWords`
 * (mesmas fronteiras de camelCase/acrônimo/separador do label) sobre o
 * texto ORIGINAL da task — preservar case é exigido para achar a fronteira,
 * por isso isto roda ANTES de `termosDe` apagar o case — e reusa `termosDe`
 * (mesmo filtro de stopword/tamanho mínimo já aplicado à query) sobre o
 * resultado, em vez de duplicar essa lista aqui.
 *
 * Para query em linguagem natural sem camelCase (a maioria dos casos,
 * incluindo os 4 testes de fronteira de palavra abaixo) `symbolWords(task)`
 * produz o MESMO split por espaço/pontuação que `termosDe(task)` já
 * produzia — a união é NO-OP nesses casos, o comportamento anterior fica
 * intacto. Só muda quando a query cola um identificador de código sem
 * separador, que é exatamente o caso que estava quebrado.
 */
function queryTerms(task: string): Set<string> {
  const decomposed = [...symbolWords(task)].join(" ");
  return new Set([...termosDe(task), ...termosDe(decomposed)]);
}

/**
 * G3.3 — quebra `manifest.project.name` ("nexos-cli") nas mesmas fronteiras
 * de separador que `pathTerms` já aplica a um path de arquivo, produzindo os
 * tokens genéricos que aparecem em quase todo símbolo/caminho deste projeto
 * (`{"nexos","cli"}`). Nome ausente → conjunto vazio, filtro vira no-op.
 */
function selfReferenceTokens(projectName: string | undefined): ReadonlySet<string> {
  if (!projectName) return new Set();
  return termosDe(projectName.replace(/[-_.]+/g, " "));
}

function buildReason(hits: readonly Hit[]): string {
  const ordenados = [...hits].sort((a, b) => b.weight - a.weight);
  return ordenados
    .slice(0, 4)
    .map((h) => {
      if (h.kind === "label") return `'${h.term}' no símbolo '${h.detail}' (label)`;
      if (h.kind === "path") return `'${h.term}' no caminho do arquivo (path)`;
      return `'${h.term}' via ${h.relation} com '${h.detail}'`;
    })
    .join("; ");
}

/**
 * Puro — nenhum I/O. `fileExists` é injetado (produção: `existsSync` real,
 * testes: fixture) para manter isto testável sem tocar disco.
 */
export function rankFiles(graph: GraphData, task: string, options: RankOptions = {}): RankResult {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_ITEMS));
  const fileExists = options.fileExists ?? ((): boolean => true);
  const taskTerms = queryTerms(task);
  if (taskTerms.size === 0) return { items: [], candidateCount: 0 };

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const byFile = new Map<string, Hit[]>();
  const addHit = (file: string, hit: Hit): void => {
    const list = byFile.get(file);
    if (list) list.push(hit);
    else byFile.set(file, [hit]);
  };

  /**
   * Fase 1 — match direto por label, PALAVRA INTEIRA (`symbolWords`), nunca
   * substring. `termosDe` colapsa `CapabilityListOptions` num termo de task
   * só faria sentido comparar por igualdade de conjunto se o SÍMBOLO também
   * virasse um único token — em vez disso, `symbolWords` corta o símbolo nas
   * fronteiras reais de palavra (case, separador), preservando `capability`
   * como termo próprio sem precisar de substring solto.
   *
   * Restrito a `file_type === "code"`: MEDIDO contra o grafo real — nós
   * `document` (20641 de 28393, a maioria) são frases inteiras de heading
   * (`"6. Como isso não apodrece"`), e mesmo palavra-inteira contra frase
   * inteira faria qualquer termo comum da TASK ("como", "nao", "codigo")
   * bater dentro de qualquer heading do repo, afogando o símbolo de código
   * que a task realmente descreve. Path matching (fase 2) continua
   * irrestrito — um `.md` ainda aparece pelo nome do arquivo.
   */
  const nodeMatchedTerms = new Map<string, ReadonlySet<string>>();
  for (const node of graph.nodes) {
    if (!node.source_file || node.file_type !== "code") continue;
    const words = symbolWords(node.label);
    let matched: Set<string> | undefined;
    for (const term of taskTerms) {
      if (words.has(term)) {
        (matched ??= new Set()).add(term);
        addHit(node.source_file, {
          kind: "label",
          term,
          detail: node.label,
          provenance: node.confidence ?? "UNKNOWN",
          weight: WEIGHT_LABEL,
        });
      }
    }
    if (matched) nodeMatchedTerms.set(node.id, matched);
  }

  /** Fase 2 — componentes do path, uma vez por arquivo distinto (não por nó —
   *  senão um arquivo com 50 símbolos pontuaria 50x pelo mesmo path). */
  const filesSeen = new Set<string>();
  for (const node of graph.nodes) if (node.source_file) filesSeen.add(node.source_file);
  for (const file of filesSeen) {
    const terms = pathTerms(file);
    for (const term of taskTerms) {
      if (terms.has(term)) {
        addHit(file, { kind: "path", term, detail: file, provenance: "UNKNOWN", weight: WEIGHT_PATH });
      }
    }
  }

  /** Fase 3 — vizinhança de 1 salto a partir de símbolos casados na fase 1. */
  for (const link of graph.links) {
    if (NEIGHBOR_EXCLUDED_RELATIONS.has(link.relation)) continue;
    const sourceTerms = nodeMatchedTerms.get(link.source);
    const targetTerms = nodeMatchedTerms.get(link.target);
    const terms = sourceTerms ?? targetTerms;
    if (!terms) continue;
    const matchedId = sourceTerms ? link.source : link.target;
    const otherId = matchedId === link.source ? link.target : link.source;
    const matchedNode = nodeById.get(matchedId);
    const otherNode = nodeById.get(otherId);
    if (!matchedNode?.source_file || !otherNode?.source_file) continue;
    if (otherNode.source_file === matchedNode.source_file) continue;
    for (const term of terms) {
      addHit(otherNode.source_file, {
        kind: "neighbor",
        term,
        detail: `${matchedNode.label} em ${matchedNode.source_file}`,
        relation: link.relation,
        provenance: link.confidence ?? "UNKNOWN",
        weight: RELATION_WEIGHT[link.relation] ?? 1,
      });
    }
  }

  const selfTokens = options.selfTokens ?? new Set<string>();
  const changedFiles = options.changedFiles;

  const candidates = [...byFile.entries()]
    .map(([file, hits]) => {
      const primeiraPorChave = new Map<string, Hit>();
      for (const h of hits) {
        const key = `${h.kind}:${h.term}`;
        if (!primeiraPorChave.has(key)) primeiraPorChave.set(key, h);
      }
      const deduped = [...primeiraPorChave.values()];
      const score = deduped.reduce((acc, h) => acc + h.weight, 0);
      const primary =
        deduped.find((h) => h.kind === "label") ?? deduped.find((h) => h.kind === "neighbor") ?? deduped[0];
      const relation = primary?.kind === "neighbor" ? (primary.relation ?? "UNKNOWN") : "direct";
      const matchedTerms = new Set(deduped.map((h) => h.term));
      return {
        path: file,
        reason: buildReason(deduped),
        provenance: primary?.provenance ?? "UNKNOWN",
        relation,
        score,
        matchedTerms,
      };
    })
    /**
     * G3.3 — o nome do PRÓPRIO projeto aparece em quase todo símbolo/path
     * (medido: 5 arquivos de hook voltavam só pelo termo "nexos"). Um
     * candidato cujos termos casados são TODOS self-token é ruído genérico
     * e cai fora — mas o mesmo token continua valendo peso normal quando
     * corrobora outro termo real do mesmo candidato (`matchedTerms` guarda
     * TODOS os termos, o filtro só olha se sobra algum que não é self-token).
     */
    .filter((c) => selfTokens.size === 0 || [...c.matchedTerms].some((t) => !selfTokens.has(t)));

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const items: RelevantFileItem[] = candidates.slice(0, limit).map(({ matchedTerms: _matchedTerms, ...c }) => ({
    ...c,
    exists: fileExists(c.path),
    changed_since_built: changedFiles === undefined ? "UNKNOWN" : changedFiles === "UNKNOWN" ? "UNKNOWN" : changedFiles.has(c.path),
  }));

  return { items, candidateCount: candidates.length };
}

// ─── consulta completa (I/O) ────────────────────────────────────────────────

export interface RelevantFilesSummary {
  readonly candidate_count: number;
  readonly returned_count: number;
  readonly query_ms: number;
  readonly graph_age: number | "UNKNOWN";
}

export type RelevantFilesResult =
  | { readonly status: "NOT_AVAILABLE"; readonly detail: string }
  | { readonly status: "MALFORMED"; readonly detail: string }
  | {
      readonly status: Freshness;
      readonly project_id: string | undefined;
      readonly built_at_commit: string;
      readonly current_head: string | undefined;
      readonly items: readonly RelevantFileItem[];
      readonly summary: RelevantFilesSummary;
    };

export interface QueryRelevantFilesOptions {
  readonly task: string;
  readonly limit?: number;
  /** Override para teste — produção usa `<root>/graphify-out/graph.json`. */
  readonly graphPath?: string;
  /** Override para teste — produção usa `systemGitRunner()`. */
  readonly gitRunner?: GitRunner;
}

export async function queryRelevantFiles(
  projectRoot: string,
  options: QueryRelevantFilesOptions
): Promise<RelevantFilesResult> {
  const startedAt = Date.now();
  const graphPath = options.graphPath ?? path.join(projectRoot, "graphify-out", "graph.json");
  const loaded = await loadGraph(graphPath);
  if (!loaded.ok) return { status: loaded.reason, detail: loaded.detail };

  const runner = options.gitRunner ?? systemGitRunner();
  const [{ head, dirty }, projectId, projectName] = await Promise.all([
    gitHeadAndDirty(projectRoot, runner),
    readManifestProjectId(forProject(projectRoot).manifest(), [] as IntegrityIssue[]),
    readManifestProjectName(forProject(projectRoot).manifest(), [] as IntegrityIssue[]),
  ]);

  let status = resolveFreshness(loaded.graph.built_at_commit, head, dirty);
  const [graphAge, changedFiles] =
    head === undefined
      ? (["UNKNOWN", "UNKNOWN"] as const)
      : await Promise.all([
          commitsBehind(projectRoot, runner, loaded.graph.built_at_commit, head),
          changedFilesSince(projectRoot, runner, loaded.graph.built_at_commit),
        ]);

  // Reconcilia STALE-por-commit contra conteúdo real (ver "frescor por
  // conteúdo" acima). `changedFiles === "UNKNOWN"` (git não resolveu o diff)
  // nunca vira FRESH por omissão — mantém o STALE puro nesse caso.
  if (status === "STALE" && changedFiles !== "UNKNOWN") {
    const mismatched = await manifestMismatchedFiles(projectRoot, changedFiles);
    if (mismatched.size === 0) status = "FRESH";
  }

  const { items, candidateCount } = rankFiles(loaded.graph, options.task, {
    selfTokens: selfReferenceTokens(projectName),
    changedFiles,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    fileExists: (rel: string): boolean => existsSync(path.join(projectRoot, rel)),
  });

  return {
    status,
    project_id: projectId,
    built_at_commit: loaded.graph.built_at_commit,
    current_head: head,
    items,
    summary: {
      candidate_count: candidateCount,
      returned_count: items.length,
      query_ms: Date.now() - startedAt,
      graph_age: graphAge,
    },
  };
}
