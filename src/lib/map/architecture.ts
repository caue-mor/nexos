/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — `architecture.md`
 * determinístico: mesma entrada produz sempre a mesma saída, cada
 * afirmação cita o(s) id(s) de fato que a sustenta, zero componente
 * inventado. Responde as 12 perguntas de aceite; o que não tem fato vai
 * para a seção UNKNOWN explícita — nunca inferido silenciosamente.
 *
 * PURA: recebe os quatro artefatos JÁ montados (facts/routes/database/graph,
 * cada item com `id`), devolve o texto. I/O (ler os JSON, escrever o .md)
 * fica com o chamador (`commands/map.ts`).
 */
import type { MapFact } from "./stack-detector.js";
import type { RouteFact } from "./routes.js";
import type { DatabaseFact } from "./database.js";
import type { GraphEdge } from "./import-graph.js";
import type { MaterialEntry } from "./materials.js";
import type { CoverageReport, CoverageArea } from "./coverage.js";

type Identified<T> = T & { readonly id: string };

export interface ArchitectureInput {
  readonly projectName: string;
  readonly facts: readonly Identified<MapFact>[];
  readonly routes: readonly Identified<RouteFact>[];
  readonly database: readonly Identified<DatabaseFact>[];
  readonly graph: readonly Identified<GraphEdge>[];
  /** Opcional — chamadores antigos (testes) continuam válidos; `generateArchitectureMd` trata ausência como "nada a reportar". */
  readonly materials?: readonly MaterialEntry[];
  readonly coverage?: CoverageReport;
  readonly generatedAt: string;
}

function factsWhere(facts: readonly Identified<MapFact>[], name: string): Identified<MapFact>[] {
  return facts.filter((f) => f.fact === name);
}

function ids(items: readonly { readonly id: string }[]): string {
  return items.map((i) => i.id).join(", ");
}

const FRONTEND_FRAMEWORKS = new Set(["next", "react", "vue"]);
const BACKEND_FRAMEWORKS = new Set(["express", "fastify", "fastapi", "django", "flask", "hono", "nestjs", "koa", "elysia"]);

/** Componentes = subdiretórios imediatos de `src/` observados pelas arestas do grafo — nunca listados sem uma aresta que prove a existência do arquivo. Exportado para `hot-brief.ts` reusar em `readMapSummary` (A14) sem recalcular a mesma regra. */
export function deriveComponents(graph: readonly Identified<GraphEdge>[]): Map<string, string> {
  const components = new Map<string, string>(); // dir -> primeiro edge id que a prova
  for (const edge of graph) {
    const m = /^src\/([^/]+)\//.exec(edge.from);
    if (m?.[1] && !components.has(m[1])) components.set(m[1], edge.id);
  }
  return components;
}

function coverageOf(coverage: CoverageReport | undefined, area: CoverageArea): { readonly status: string; readonly detail: string } | undefined {
  const found = coverage?.areas.find((a) => a.area === area);
  return found ? { status: found.status, detail: found.detail } : undefined;
}

/** Extrai o nome do pacote npm de `provenance.field` (`dependencies.<pkg>`/`devDependencies.<pkg>`) — mesmo campo que `stack-detector.ts` já grava, sem tabela paralela. */
function packageNameFromField(field: string | undefined): string | undefined {
  const m = field ? /^(?:dependencies|devDependencies)\.(.+)$/.exec(field) : null;
  return m?.[1];
}

export function generateArchitectureMd(input: ArchitectureInput): string {
  const { facts, routes, database, graph } = input;
  const materials = input.materials ?? [];
  const coverage = input.coverage;
  const unknown: string[] = [];
  const lines: string[] = [
    `# Architecture — ${input.projectName}`,
    "",
    `Gerado deterministicamente por \`nexos map\` em ${input.generatedAt}. Cada afirmação cita o id do fato ` +
      "que a sustenta (`.nexos/map/project.json`/`routes.json`/`database.json`/`graph.json`). Nada aqui é inventado: " +
      "o que não tem fato está na seção UNKNOWN, no fim.",
    "",
  ];

  // 1. Tipo de projeto
  const cliEntry = factsWhere(facts, "cli_entrypoint");
  const hasWebFramework = facts.some((f) => f.fact === "framework" && (FRONTEND_FRAMEWORKS.has(f.value) || BACKEND_FRAMEWORKS.has(f.value)));
  lines.push("## 1. Tipo de projeto");
  if (cliEntry.length > 0 && routes.length === 0) {
    lines.push(`CLI (entrypoint declarado via \`bin\` do package.json — ${ids(cliEntry)}).`);
  } else if (hasWebFramework || routes.length > 0) {
    lines.push(`Aplicação web/serviço com rotas HTTP observadas (${ids(routes.slice(0, 3))}${routes.length > 3 ? ", ..." : ""}).`);
  } else {
    lines.push("UNKNOWN — sem `cli_entrypoint`, sem framework web, sem rota observada.");
    unknown.push("Tipo de projeto");
  }
  lines.push("");

  // 2. Linguagens e frameworks
  const languages = factsWhere(facts, "language");
  const frameworks = factsWhere(facts, "framework");
  lines.push("## 2. Linguagens e frameworks");
  if (languages.length + frameworks.length > 0) {
    for (const f of languages) lines.push(`- linguagem: ${f.value} (${f.id})`);
    for (const f of frameworks) lines.push(`- framework: ${f.value} (${f.id})`);
  } else {
    lines.push("UNKNOWN — nenhum manifest de ecossistema reconhecido.");
    unknown.push("Linguagens e frameworks");
  }
  lines.push("");

  // 3. Entrypoints
  const entrypoints = [...factsWhere(facts, "entrypoint"), ...cliEntry];
  lines.push("## 3. Entrypoints");
  if (entrypoints.length > 0) {
    for (const f of entrypoints) lines.push(`- ${f.value} (${f.id})`);
  } else {
    lines.push("UNKNOWN — nenhum entrypoint observado (main/bin/src/app/src/index).");
    unknown.push("Entrypoints");
  }
  lines.push("");

  // 4. Frontend
  const frontendFrameworks = frameworks.filter((f) => FRONTEND_FRAMEWORKS.has(f.value));
  const pageRoutes = routes.filter((r) => r.method === "PAGE");
  /**
   * `styling` entra AQUI e não numa seção própria: é um atributo do frontend,
   * e seção nova por fato novo infla o documento sem ajudar quem lê. Sozinho
   * ele também não tira a seção do UNKNOWN — Tailwind instalado não prova que
   * existe UI observada, e o `else` abaixo continua sendo a resposta honesta.
   */
  const stylingFacts = factsWhere(facts, "styling");
  lines.push("## 4. Frontend");
  if (frontendFrameworks.length > 0 || pageRoutes.length > 0) {
    lines.push(
      `Observado via ${ids([...frontendFrameworks, ...pageRoutes.slice(0, 5)])}` +
        (pageRoutes.length > 0 ? ` — ${pageRoutes.length} rota(s) de página.` : ".")
    );
  } else {
    lines.push("UNKNOWN — sem framework de UI nem rota de página observada.");
    unknown.push("Frontend");
  }
  for (const f of stylingFacts) lines.push(`- styling: ${f.value} (${f.id})`);
  lines.push("");

  // 5. Backend
  const backendFrameworks = frameworks.filter((f) => BACKEND_FRAMEWORKS.has(f.value));
  const apiRoutes = routes.filter((r) => r.method !== "PAGE");
  lines.push("## 5. Backend");
  if (backendFrameworks.length > 0 || apiRoutes.length > 0) {
    lines.push(`Observado via ${ids([...backendFrameworks, ...apiRoutes.slice(0, 5)])}` + (apiRoutes.length > 0 ? ` — ${apiRoutes.length} rota(s) de API.` : "."));
  } else {
    lines.push("UNKNOWN — sem framework de backend nem rota de API observada.");
    unknown.push("Backend");
  }
  lines.push("");

  // 6. Routes e APIs
  const routesCoverage = coverageOf(coverage, "routes");
  lines.push("## 6. Routes e APIs");
  if (routes.length > 0) {
    for (const r of routes.slice(0, 20)) lines.push(`- \`${r.method} ${r.path}\` — ${r.file} (${r.id})`);
    if (routes.length > 20) lines.push(`- ... e mais ${routes.length - 20} rota(s), ver routes.json`);
    if (routesCoverage?.status === "partial") lines.push(`- cobertura parcial: ${routesCoverage.detail}`);
  } else if (routesCoverage && routesCoverage.status !== "analyzed") {
    // A9 — zero rota por FALTA DE COBERTURA (stack sem detector, nada examinado) nunca vira "zero rota observada" silencioso.
    lines.push(`${routesCoverage.status.toUpperCase()} — ${routesCoverage.detail}`);
    unknown.push("Routes e APIs");
  } else {
    lines.push("UNKNOWN — zero rota observada (nenhum padrão de Next/Express/Fastify/FastAPI/Django/Flask casou).");
    unknown.push("Routes e APIs");
  }
  lines.push("");

  // 7. Banco, ORM, schema e migrations
  const ormFacts = factsWhere(facts, "orm");
  const dbSchemaFacts = factsWhere(facts, "database_schema");
  const databaseCoverage = coverageOf(coverage, "database");
  lines.push("## 7. Banco, ORM, schema e migrations");
  if (ormFacts.length + dbSchemaFacts.length + database.length > 0) {
    for (const f of [...ormFacts, ...dbSchemaFacts]) lines.push(`- ${f.fact}: ${f.value} (${f.id})`);
    for (const d of database.slice(0, 20)) {
      const physical = d.kind === "model" && d.physicalName ? ` [nome físico: ${d.physicalName}]` : "";
      lines.push(`- ${d.kind} \`${d.name}\`${physical} — ${d.file}:${d.line} (${d.id})`);
    }
    if (database.length > 20) lines.push(`- ... e mais ${database.length - 20} entidade(s), ver database.json`);
    if (database.some((d) => d.kind === "datasource")) {
      lines.push("- estado do banco REMOTO: não verificado (Project Map nunca conecta a banco nem executa código da app).");
    }
  } else if (databaseCoverage && databaseCoverage.status !== "analyzed") {
    lines.push(`${databaseCoverage.status.toUpperCase()} — ${databaseCoverage.detail}`);
    unknown.push("Banco, ORM, schema e migrations");
  } else {
    lines.push("UNKNOWN — nenhum ORM, schema ou migration observado.");
    unknown.push("Banco, ORM, schema e migrations");
  }
  lines.push("");

  // 8. Auth — A11: evidência genérica, nunca "presença = aprovação de segurança".
  const authFacts = factsWhere(facts, "auth");
  const externalPackages = new Set(graph.filter((e) => e.resolution === "external" && e.package).map((e) => e.package as string));
  lines.push("## 8. Auth");
  if (authFacts.length > 0) {
    for (const f of authFacts.slice(0, 20)) {
      const pkg = packageNameFromField(f.provenance.field);
      if (pkg) {
        const usedNote = externalPackages.has(pkg) ? "declarado E importado pelo código incluído" : "declarado — uso no código incluído não confirmado";
        lines.push(`- dependência \`${pkg}\`: ${usedNote} (${f.certainty} — ${f.id})`);
        continue;
      }
      if (f.provenance.field === "candidate_module") {
        const consumers = graph.filter((e) => e.resolution === "resolved" && e.to === f.value).map((e) => e.from);
        const consumerNote = consumers.length > 0 ? `consumido por ${consumers.slice(0, 5).join(", ")}${consumers.length > 5 ? ", ..." : ""}` : "sem consumidor observado no grafo";
        const reason = f.matchedBy && f.matchedBy.length > 0 ? f.matchedBy.join("; ") : "evidência genérica";
        lines.push(`- candidato por nome \`${f.value}\` (${reason}): ${consumerNote} (${f.certainty} — ${f.id})`);
        continue;
      }
      lines.push(`- ${f.value} (${f.certainty} — ${f.id})`);
    }
    if (authFacts.length > 20) lines.push(`- ... e mais ${authFacts.length - 20} fato(s) de auth`);
    lines.push("- presença ≠ aprovação de segurança: candidato por nome é pista, não confirmação de que o código realmente autentica/autoriza.");
  } else {
    lines.push("UNKNOWN — nenhuma dependência, módulo candidato ou leitura de header de auth observada.");
    unknown.push("Auth");
  }
  lines.push("");

  // 9. Serviços e componentes
  const components = deriveComponents(graph);
  lines.push("## 9. Serviços e componentes");
  if (components.size > 0) {
    for (const [dir, edgeId] of [...components.entries()].sort()) lines.push(`- \`src/${dir}/\` (${edgeId})`);
  } else {
    lines.push("UNKNOWN — nenhum componente sob `src/` observado no grafo de imports.");
    unknown.push("Serviços e componentes");
  }
  lines.push("");

  // 10. Integrações externas — A12: uso vs declaração, endpoint referenciado, parcial/mock.
  const integrationFacts = factsWhere(facts, "integration");
  // V4 — dependências de RUNTIME usadas pelo código incluído, sem detector próprio (framework/orm/integration/auth/test_framework já cobrem o resto).
  const dependencyUsedFacts = factsWhere(facts, "dependency_used");
  lines.push("## 10. Integrações externas");
  if (integrationFacts.length > 0) {
    for (const f of integrationFacts.slice(0, 20)) {
      const pkg = packageNameFromField(f.provenance.field);
      if (pkg) {
        const usedNote = externalPackages.has(pkg) ? "declarado E importado pelo código incluído" : "declarado — uso no código incluído não confirmado";
        lines.push(`- dependência \`${pkg}\`: ${usedNote} (${f.certainty} — ${f.id})`);
        continue;
      }
      if (f.provenance.field === "endpoint_referenced") {
        // R2 — um fato por HOST (agregado em map-scan.ts); `files`/`fileCount` cita onde, com teto.
        const files = f.files ?? [f.provenance.file];
        const extra = f.fileCount !== undefined && f.fileCount > files.length ? `, ... e mais ${f.fileCount - files.length}` : "";
        lines.push(`- endpoint referenciado \`${f.value}\` — ${files.join(", ")}${extra} — não verificado em execução (${f.id})`);
        continue;
      }
      if (f.provenance.field === "mock_file" || f.provenance.field === "partial_todo_throw") {
        lines.push(`- parcial/mock: ${f.value} (${f.provenance.field} — ${f.id})`);
        continue;
      }
      lines.push(`- ${f.value} (${f.id})`);
    }
    if (integrationFacts.length > 20) lines.push(`- ... e mais ${integrationFacts.length - 20} fato(s) de integração`);
  } else if (dependencyUsedFacts.length === 0) {
    lines.push("UNKNOWN — nenhum SDK de integração, endpoint ou mock observado.");
    unknown.push("Integrações externas");
  }
  for (const f of dependencyUsedFacts.slice(0, 20)) {
    const files = f.files ?? [f.provenance.file];
    const extra = f.fileCount !== undefined && f.fileCount > files.length ? `, ... e mais ${f.fileCount - files.length}` : "";
    lines.push(`- dependência \`${f.value}\`: usada pelo código (biblioteca ou serviço, não classificado) — ${files.join(", ")}${extra} (${f.certainty} — ${f.id})`);
  }
  if (dependencyUsedFacts.length > 20) lines.push(`- ... e mais ${dependencyUsedFacts.length - 20} dependência(s) usada(s)`);
  lines.push("");

  // 11. Testes e CI
  const testFacts = [...factsWhere(facts, "test_framework"), ...factsWhere(facts, "tests_dir"), ...factsWhere(facts, "ci")];
  lines.push("## 11. Testes e CI");
  if (testFacts.length > 0) {
    for (const f of testFacts) lines.push(`- ${f.fact}: ${f.value} (${f.id})`);
  } else {
    lines.push("UNKNOWN — nenhum framework de teste, diretório de testes ou CI observado.");
    unknown.push("Testes e CI");
  }
  lines.push("");

  // 12. Relações observadas vs inferidas
  const observedEdges = graph.filter((e) => e.certainty === "OBSERVED");
  const inferredEdges = graph.filter((e) => e.certainty === "INFERRED");
  const resolvedEdges = graph.filter((e) => e.resolution === "resolved");
  const externalEdges = graph.filter((e) => e.resolution === "external");
  const unresolvedEdges = graph.filter((e) => e.resolution === "unresolved");
  const observedFacts = facts.filter((f) => f.certainty === "OBSERVED").length;
  const inferredFactsCount = facts.filter((f) => f.certainty === "INFERRED").length;
  lines.push("## 12. Relações observadas vs inferidas");
  lines.push(
    `- fatos de stack: ${observedFacts} OBSERVED, ${inferredFactsCount} INFERRED (project.json).\n` +
      `- arestas de import: ${observedEdges.length} OBSERVED (leitura própria), ${inferredEdges.length} INFERRED ` +
      `(só do Graphify, nenhuma confirmada por scan próprio ainda) — ver graph.json, campo \`provenance.source\`.\n` +
      `- resolução: ${resolvedEdges.length} resolved (arquivo do projeto), ${externalEdges.length} external (pacote/builtin, nunca resolvido contra node_modules), ${unresolvedEdges.length} unresolved (parecia interno, arquivo não encontrado).`
  );
  if (routes.length > 0 && database.length > 0 && observedEdges.length > 0) {
    lines.push(
      "- fluxo frontend → API → serviço → banco: não traçado automaticamente nesta rodada — " +
        "routes.json e database.json existem, mas a costura de rota→arquivo→tabela via arestas " +
        "de import fica para uma iteração futura do gerador (fora do escopo mínimo desta fatia)."
    );
  }
  lines.push("");

  // 13. Materiais fora da app — A7.
  lines.push("## 13. Materiais fora da app");
  if (materials.length > 0) {
    for (const m of materials) lines.push(`- \`${m.path}\` — ${m.kind}: ${m.reason} (evidência: ${m.evidence})`);
  } else {
    lines.push("Nenhum material fora da app identificado — todo o escopo varrido é tratado como código da própria app.");
  }
  lines.push("");

  // 14. Cobertura da varredura — A9: nunca 0 silencioso para área não analisada/erro.
  lines.push("## 14. Cobertura da varredura");
  if (coverage) {
    for (const area of coverage.areas) lines.push(`- ${area.area}: ${area.status} — ${area.detail}`);
    lines.push(`- arquivos examinados: ${coverage.filesExamined}; ignorados: ${coverage.skipped.length}; erros: ${coverage.errors.length}.`);
    if (coverage.errors.length > 0) {
      for (const e of coverage.errors) lines.push(`  - erro em \`${e.path}\`: ${e.detail}`);
    }
  } else {
    lines.push("UNKNOWN — cobertura não computada nesta chamada.");
  }
  lines.push("");

  lines.push("## UNKNOWN");
  if (unknown.length > 0) {
    lines.push("Perguntas de aceite sem fato suficiente nesta execução:");
    for (const q of unknown) lines.push(`- ${q}`);
  } else {
    lines.push("Nenhuma — todas as 12 perguntas de aceite têm fato de suporte nesta execução.");
  }

  return `${lines.join("\n")}\n`;
}
