/**
 * P1.5 (nexos://decision/p1-5-hot-brief) — resumo HOT do Project Map para o
 * SessionStart. As funções ORIGINAIS (`formatMapSummaryLine`/
 * `extractArchitectureSummaryLines`/`truncateOneLiner`/
 * `summarizeFieldsToOneLiner`) continuam PURAS — recebem o que
 * `session-start.ts` já leu, nunca tocam disco.
 *
 * P1.4 fatia A (A14) — `readMapSummary(rootPath)` é a exceção deliberada:
 * função de CONVENIÊNCIA que FAZ a leitura (`project.json`/`routes.json`/
 * `database.json`/`architecture.md`/`coverage.json`) e devolve o resumo já
 * honesto — para quem (fatia C) não quer reimplementar a leitura de 5
 * arquivos só para mostrar 3 linhas. Mapa ausente/ilegível em qualquer
 * pedaço → aquele pedaço do resumo vira `undefined`/lista vazia, nunca lança.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { forProject } from "../capsule/paths.js";
import { deriveComponents } from "./architecture.js";
import type { MapFact } from "./stack-detector.js";
import type { GraphEdge } from "./import-graph.js";
import type { CoverageReport } from "./coverage.js";

const MAX_ARCHITECTURE_LINES = 5;
const MAX_ONE_LINER_CHARS = 140;

/**
 * "Mapa: tipo X · stack Y · entrypoints Z · routes N · tabelas N · componentes N"
 * — uma linha, nunca o array de fatos inteiro. `undefined` quando não há
 * fato nenhum (mapa ausente ou vazio) — a seção some, não fabrica "0 de tudo".
 */
export function formatMapSummaryLine(
  facts: readonly MapFact[],
  routeCount: number,
  tableCount: number,
  serviceCount: number
): string | undefined {
  if (facts.length === 0 && routeCount === 0 && tableCount === 0 && serviceCount === 0) return undefined;

  const isCli = facts.some((f) => f.fact === "cli_entrypoint");
  const hasWebFramework = facts.some((f) => f.fact === "framework");
  const type = isCli ? "CLI" : hasWebFramework || routeCount > 0 ? "web/serviço" : undefined;

  const languages = facts.filter((f) => f.fact === "language").map((f) => f.value);
  const frameworks = facts.filter((f) => f.fact === "framework").map((f) => f.value);
  const stack = [...languages, ...frameworks];

  const entrypoints = facts.filter((f) => f.fact === "entrypoint" || f.fact === "cli_entrypoint").map((f) => f.value);

  const parts = [
    type ? `tipo ${type}` : undefined,
    stack.length > 0 ? `stack ${stack.join("+")}` : undefined,
    entrypoints.length > 0 ? `entrypoints ${entrypoints.slice(0, 3).join(",")}` : undefined,
    `routes ${routeCount} · tabelas ${tableCount} · componentes ${serviceCount}`,
  ].filter((p): p is string => p !== undefined);

  return `Mapa: ${parts.join(" · ")}`;
}

/**
 * Primeiras `maxLines` linhas de CONTEÚDO (não cabeçalho `#`, não boilerplate,
 * NUNCA a seção UNKNOWN) de `architecture.md`. Para na primeira linha da
 * lista de perguntas sem fato — essa lista É a seção UNKNOWN, mesmo sem
 * cabeçalho `#` bater antes dela sob o teto de linhas.
 */
export function extractArchitectureSummaryLines(architectureMd: string, maxLines = MAX_ARCHITECTURE_LINES): string[] {
  const out: string[] = [];
  for (const raw of architectureMd.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("Gerado deterministicamente")) continue;
    if (line.startsWith("Perguntas de aceite sem fato")) break;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

/**
 * Corta `raw` em `maxChars`, na última palavra inteira (só se a fronteira
 * passar de char 40 — evita cortar string curta no meio), com reticências.
 * Base de `summarizeFieldsToOneLiner` e da linha "Estado:" (P1.5b) — a MESMA
 * truncagem em ambos os usos, nunca uma segunda regra de corte.
 */
export function truncateOneLiner(raw: string, maxChars = MAX_ONE_LINER_CHARS): string {
  if (raw.length <= maxChars) return raw;
  const cut = raw.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * UMA linha de "regra" para um item de conhecimento — NUNCA o corpo.
 * Gotcha já tem `fields.rule` (curto, escrito para isso); Decision e outros
 * kinds só têm o texto inteiro em `fields.decision` (ou o campo que o
 * migrador gravou) — trunca em `MAX_ONE_LINER_CHARS`, cortando na última
 * palavra inteira, com reticências. Nunca deixa o corpo inteiro atravessar.
 */
export function summarizeFieldsToOneLiner(fields: Readonly<Record<string, string>>): string | undefined {
  const raw = fields.rule ?? fields.decision ?? fields.detail ?? fields.summary;
  return raw ? truncateOneLiner(raw) : undefined;
}

// ─── A14 — readMapSummary(rootPath): a única função deste módulo que lê disco ──

export interface MapSummary {
  /** Ex.: "rotas 6 em 4 arquivo(s) · modelos 11 · enums 6 (prisma/postgresql, remoto não verificado)". `undefined` quando não há rota nem modelo. */
  readonly mapSummaryLine?: string;
  readonly architectureSummaryLines: readonly string[];
  /** Área não analisada/erro escrita por extenso — `undefined` quando toda área coberta está `analyzed`/`partial` (nada de anormal a dizer). */
  readonly coverageLine?: string;
}

async function readJsonSafe<T>(target: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function readTextSafe(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf-8");
  } catch {
    return undefined;
  }
}

interface RouteJson {
  readonly file?: string;
}
interface DatabaseEntityJson {
  readonly kind?: string;
  readonly name?: string;
}

function buildRichMapSummaryLine(
  routes: readonly RouteJson[],
  entities: readonly DatabaseEntityJson[],
  ormFact: MapFact | undefined,
  datasourceEntity: DatabaseEntityJson | undefined,
  serviceCount: number
): string | undefined {
  const parts: string[] = [];
  if (routes.length > 0) {
    const files = new Set(routes.map((r) => r.file).filter((f): f is string => Boolean(f)));
    parts.push(`rotas ${routes.length} em ${files.size} arquivo(s)`);
  }
  const models = entities.filter((e) => e.kind === "model" || e.kind === "table");
  if (models.length > 0) {
    let dbPart = `modelos ${models.length}`;
    const enums = entities.filter((e) => e.kind === "enum");
    if (enums.length > 0) dbPart += ` · enums ${enums.length}`;
    if (ormFact && datasourceEntity?.name) dbPart += ` (${ormFact.value}/${datasourceEntity.name}, remoto não verificado)`;
    parts.push(dbPart);
  }
  if (serviceCount > 0) parts.push(`componentes ${serviceCount}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const MAX_COVERAGE_LINE_CHARS = 240;

/**
 * Rodada de correção R4/R5 — área não `analyzed`/`partial` escrita por
 * extenso, MAS: (R4) qualquer erro registrado (mesmo um que não mudou o
 * status de nenhuma área — ex.: `package.json` corrompido, que afeta
 * dependência declarada, não a varredura de arquivo) sempre aparece; (R5)
 * áreas com o MESMO status+detail se agrupam numa linha só (a cópia real
 * repetia a mesma frase 5x em C++/pasta vazia) e a linha final nunca passa
 * de `MAX_COVERAGE_LINE_CHARS`.
 */
function buildCoverageLine(coverage: CoverageReport | undefined): string | undefined {
  if (!coverage) return undefined;
  const flagged = coverage.areas.filter((a) => a.status !== "analyzed" && a.status !== "partial");

  const groups: { readonly status: string; readonly detail: string; readonly areas: string[] }[] = [];
  for (const a of flagged) {
    const existing = groups.find((g) => g.status === a.status && g.detail === a.detail);
    if (existing) existing.areas.push(a.area);
    else groups.push({ status: a.status, detail: a.detail, areas: [a.area] });
  }
  const groupParts = groups.map((g) => `${g.areas.join("/")} ${g.status} — ${g.detail}`);

  const errorNote =
    coverage.errors.length > 0
      ? `erro(s): ${coverage.errors
          .slice(0, 3)
          .map((e) => e.path)
          .join(", ")}${coverage.errors.length > 3 ? ` e mais ${coverage.errors.length - 3}` : ""}`
      : undefined;

  const parts = [...groupParts, ...(errorNote ? [errorNote] : [])];
  if (parts.length === 0) return undefined;

  const line = `Cobertura: ${parts.join(" · ")}`;
  return line.length > MAX_COVERAGE_LINE_CHARS ? `${line.slice(0, MAX_COVERAGE_LINE_CHARS - 3)}...` : line;
}

export async function readMapSummary(rootPath: string): Promise<MapSummary> {
  const p = forProject(rootPath);
  const project = await readJsonSafe<{ facts?: MapFact[] }>(p.mapProjectJson());
  const routesJson = await readJsonSafe<{ routes?: RouteJson[] }>(p.mapRoutesJson());
  const databaseJson = await readJsonSafe<{ entities?: DatabaseEntityJson[] }>(p.mapDatabaseJson());
  const graphJson = await readJsonSafe<{ edges?: (GraphEdge & { id: string })[] }>(p.mapGraphJson());
  const architectureMd = await readTextSafe(p.mapArchitectureMd());
  const coverage = await readJsonSafe<CoverageReport>(path.join(p.mapRoot(), "coverage.json"));

  const facts = project?.facts ?? [];
  const routes = routesJson?.routes ?? [];
  const entities = databaseJson?.entities ?? [];
  const edges = graphJson?.edges ?? [];
  const serviceCount = deriveComponents(edges).size;
  const ormFact = facts.find((f) => f.fact === "orm");
  const datasourceEntity = entities.find((e) => e.kind === "datasource");

  const rawArchitectureLines = architectureMd ? extractArchitectureSummaryLines(architectureMd) : [];
  /**
   * R5 — se TODAS as linhas extraídas são "UNKNOWN — ...", a cobertura já
   * fala por elas (`coverageLine`); repetir "UNKNOWN" 5x aqui é ruído, não
   * informação nova. Uma lista MISTA (algum fato real + algum UNKNOWN)
   * continua completa — só o caso 100% UNKNOWN vira lista vazia.
   */
  const architectureSummaryLines =
    rawArchitectureLines.length > 0 && rawArchitectureLines.every((l) => l.startsWith("UNKNOWN")) ? [] : rawArchitectureLines;

  return {
    mapSummaryLine: buildRichMapSummaryLine(routes, entities, ormFact, datasourceEntity, serviceCount),
    architectureSummaryLines,
    coverageLine: buildCoverageLine(coverage),
  };
}

/**
 * R1 (docs/pos-mvp-matriz-capabilities.md §1) — uma linha de capability no
 * HOT brief foi tentada e REMOVIDA (verifier, achado de custo): medido em
 * ~697ms por `SessionStart` (`scanAll` completo — 231 skills + 272 commands
 * na máquina real) e, hoje, SEMPRE `undefined` — nenhuma skill instalada
 * declara `metadata.stacks`. `NO CONSUMER -> NO CODE`
 * (`nexos://decision/nexos-project-intelligence-os`): o SessionStart deste
 * repo já degrada por orçamento em boa parte das execuções; pagar 697ms por
 * uma linha que nunca aparece é o oposto de "capability sob demanda". O
 * caminho fica em `nexos capabilities --for "<tarefa>"` (comando, não hook)
 * — sob demanda, sem custo em todo boot. Reabrir só quando existir consumidor
 * real (skills do pacote NexOS publicando `metadata.stacks`) e com o custo
 * medido de novo.
 */
