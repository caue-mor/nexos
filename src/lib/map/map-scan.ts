/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — orquestração de I/O
 * do Project Map: define o ESCOPO real do repositório (A6), classifica
 * materiais que não são código da app (A7), roda os detectores puros
 * (routes/database/auth/integrations) por arquivo, resolve o grafo de
 * imports (relativo + alias de tsconfig/jsconfig + externo — A8), funde com
 * `graphify-out/graph.json` quando presente, e monta a cobertura por área
 * (A9) + o fingerprint de conteúdo do escopo (A13).
 *
 *   FULL RESCAN, NÃO INCREMENTAL — ponytail: routes/database/graph/auth/
 *   integrations refazem a varredura inteira a cada `nexos map`. O contrato
 *   só exige incrementalidade para o project.json de stack (P1.3); manter
 *   incrementalidade correta para o resto (arestas que somem quando um
 *   arquivo para de importar algo, sinais que desaparecem) é problema maior
 *   que o tamanho de projeto que este MVP precisa suportar agora. Upgrade
 *   cabível: se o full rescan ficar caro, aplicar o mesmo filtro por
 *   `changedFiles` que o stack já usa.
 */
import { readFile, readdir, lstat, access, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { forProject } from "../capsule/paths.js";
import { systemGitRunner } from "../capsule/git-boundary.js";
import { detectRoutesInFile, stripCommentLines, type RouteFact } from "./routes.js";
import { detectDatabaseInFile, validatePrismaSchema, type DatabaseFact } from "./database.js";
import { extractImportRefs, mergeGraphifyEdges, type GraphEdge, type EdgeResolution } from "./import-graph.js";
import { detectAuthSignalsInFile, isTestFile } from "./auth.js";
import { detectIntegrationSignalsInFile } from "./integrations.js";
import { isEvidenceEligible } from "./evidence-scope.js";
import { parseTsconfigAliases, candidatesForAlias, type TsconfigAliasConfig } from "./tsconfig-resolve.js";
import { classifyMaterials, upgradeVendored, isUnderExcludedMaterial, type MaterialEntry } from "./materials.js";
import { sha1Of, computeSourceFingerprint, assignStableIds, type FingerprintEntry } from "./fingerprint.js";
import { CLASSIFIED_DEPENDENCY_NAMES, type MapFact } from "./stack-detector.js";
import type { AreaCoverage, CoverageArea, CoverageReport, ScanErrorEntry, SkippedFile } from "./coverage.js";

/** Só usado quando NÃO há Git (A6) — com Git, `git ls-files -co --exclude-standard` já resolve isto pela config real do `.gitignore`. */
const NO_GIT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".nexos",
  "graphify-out",
  ".turbo",
  ".venv",
  "__pycache__",
  "target",
]);

/** Sempre fora de escopo, MESMO com Git — são artefatos do próprio NexOS/Graphify, nunca código da app. */
const ALWAYS_SKIP_PREFIXES = [".nexos/", "graphify-out/"];

const MAX_FILE_BYTES = 1_048_576; // 1 MiB

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(rootPath: string): Promise<boolean> {
  const runner = systemGitRunner();
  const res = await runner.run(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.code === 0 && res.stdout.trim() === "true";
}

async function listViaGit(rootPath: string): Promise<string[] | undefined> {
  const runner = systemGitRunner();
  const res = await runner.run(["-C", rootPath, "ls-files", "-co", "--exclude-standard", "-z"]);
  if (!res.ok || res.code !== 0) return undefined;
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * `git status --porcelain -uall` fora de `.nexos/` — fato COMPARTILHADO entre
 * `freshness.ts` e `project-map.ts` (nexos://gotcha/map-scan-ts-isgitrepo-rev-parse-is-inside-work-tree-ainda-duplicado-fora-do-trio-lifecycle-freshness-refresh,
 * eixo "status --porcelain -uall 2x"). Só exclui `.nexos/` — o mesmo nível
 * que `project-map.ts` sempre usou; `freshness.ts` aplica seu PRÓPRIO filtro
 * adicional (bootstrap-only) por cima do resultado, sem mudar o que já
 * calculava. `[]` quando git está indisponível ou o comando falha — nunca
 * força rescan por um sinal que não conseguiu medir.
 */
export async function gitStatusPorcelainOutsideNexos(rootPath: string): Promise<string[]> {
  const runner = systemGitRunner();
  const res = await runner.run(["-C", rootPath, "status", "--porcelain", "-uall"]);
  if (!res.ok || res.code !== 0) return [];
  const out: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.length < 4) continue;
    const raw = line.slice(3);
    const parts = raw.includes(" -> ") ? raw.split(" -> ") : [raw];
    for (const part of parts) {
      const clean = part.trim().replace(/^"|"$/g, "");
      if (clean.length > 0 && !clean.startsWith(".nexos/")) out.push(clean);
    }
  }
  return out;
}

async function listViaWalk(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = path.join(rootPath, rel);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && NO_GIT_SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push(childRel); // devolvido para virar SkippedFile("symlink_not_followed") no lstat de baixo — nunca seguido.
      } else if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk("");
  return out;
}

interface ScopeResult {
  readonly files: readonly string[]; // paths incluídos (conteúdo já seguro de ler)
  readonly contents: ReadonlyMap<string, Buffer>;
  readonly skipped: readonly SkippedFile[];
  readonly errors: readonly ScanErrorEntry[];
}

/**
 * A6 — define o escopo real: Git decide por `ls-files`, sem Git anda com
 * exclusões fixas; nunca segue symlink; binário e >1MB ficam de fora com
 * motivo registrado.
 *
 * `knownGitRepo` (nexos://gotcha/map-scan-ts-isgitrepo-rev-parse-is-inside-work-tree-ainda-duplicado-fora-do-trio-lifecycle-freshness-refresh)
 * — `true` quando o CHAMADOR já provou isto pelo MESMO fato que
 * `computeLifecycleGitFacts` calcula (`headCommit` presente só existe se
 * `git rev-parse HEAD` funcionou, o que exige estar numa árvore git), mesma
 * técnica já usada em `freshness.ts:checkMapFreshness`. Dispensa o
 * `isGitRepo` PRÓPRIO deste módulo — `undefined`/`false` mantém o
 * comportamento de sempre (mede aqui, nunca assume "não é git" sem medir).
 */
async function resolveScope(rootPath: string, knownGitRepo?: boolean): Promise<ScopeResult> {
  const viaGit = (knownGitRepo || (await isGitRepo(rootPath))) ? await listViaGit(rootPath) : undefined;
  const rawList = viaGit ?? (await listViaWalk(rootPath));
  const candidates = rawList.filter((p) => !ALWAYS_SKIP_PREFIXES.some((prefix) => p.startsWith(prefix)));

  const files: string[] = [];
  const contents = new Map<string, Buffer>();
  const skipped: SkippedFile[] = [];
  const errors: ScanErrorEntry[] = [];

  for (const relFile of candidates) {
    const abs = path.join(rootPath, relFile);
    let stats;
    try {
      stats = await lstat(abs);
    } catch {
      skipped.push({ path: relFile, reason: "not_on_disk" });
      continue;
    }
    if (stats.isSymbolicLink()) {
      skipped.push({ path: relFile, reason: "symlink_not_followed" });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ path: relFile, reason: "not_a_regular_file" });
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) {
      skipped.push({ path: relFile, reason: `too_large (${stats.size} bytes > ${MAX_FILE_BYTES})` });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(abs);
    } catch (err) {
      errors.push({ path: relFile, detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (buffer.subarray(0, 8000).includes(0)) {
      skipped.push({ path: relFile, reason: "binary" });
      continue;
    }

    files.push(relFile);
    contents.set(relFile, buffer);
  }

  return { files, contents, skipped, errors };
}

// ─── workspaces declarados (para A7) ────────────────────────────────────────

async function readWorkspaceGlobs(rootPath: string): Promise<string[]> {
  const globs: string[] = [];
  try {
    const raw = JSON.parse(await readFile(path.join(rootPath, "package.json"), "utf-8")) as Record<string, unknown>;
    const ws = raw.workspaces;
    if (Array.isArray(ws)) globs.push(...ws.filter((w): w is string => typeof w === "string"));
    else if (ws && typeof ws === "object" && Array.isArray((ws as Record<string, unknown>).packages)) {
      globs.push(...((ws as Record<string, unknown>).packages as unknown[]).filter((w): w is string => typeof w === "string"));
    }
  } catch {
    // package.json ausente/ilegível para este propósito — sem workspace declarado, ponto.
  }
  try {
    const raw = await readFile(path.join(rootPath, "pnpm-workspace.yaml"), "utf-8");
    /** ponytail: parser fixo do formato comum `packages:\n  - "glob"` — não é YAML completo. */
    const lines = raw.split("\n");
    const idx = lines.findIndex((l) => /^packages\s*:/.test(l.trim()));
    if (idx >= 0) {
      for (let i = idx + 1; i < lines.length; i++) {
        const m = /^\s*-\s*["']?([^"'#]+)["']?/.exec(lines[i] ?? "");
        if (!m) break;
        const glob = m[1]?.trim();
        if (glob) globs.push(glob);
      }
    }
  } catch {
    // sem pnpm-workspace.yaml — normal.
  }
  return globs;
}

/**
 * V4 — SÓ `dependencies` (nunca `devDependencies`): uma lib de teste/build
 * importada em código de teste/config não é "usada pelo app". `undefined`
 * quando `package.json` está ausente/ilegível — mesma degradação silenciosa
 * de `readWorkspaceGlobs`, sem erro novo pra isto.
 */
async function readProdDependencyNames(rootPath: string): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(rootPath, "package.json"), "utf-8")) as Record<string, unknown>;
    const deps = raw.dependencies;
    if (!deps || typeof deps !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * V4 (direcionamento consolidado §8, achado do orquestrador) — dependência de
 * RUNTIME (`dependencies`, nunca `devDependencies`) que o grafo de imports
 * (`graph`, já resolvido por `resolveSpecifier` acima) prova que o código
 * incluído realmente importa. `CLASSIFIED_DEPENDENCY_NAMES` evita duplicar o
 * que já é fato de framework/orm/integration/auth/test_framework — isto é só
 * para o que sobra: biblioteca/serviço declarado E usado, sem detector
 * próprio. Declarada e NUNCA importada não gera fato nenhum (nem aqui nem em
 * lugar nenhum) — `UNKNOWN`/ausência, nunca um fato de uso inventado.
 */
function computeDependencyUsageFacts(
  dependencies: Readonly<Record<string, string>> | undefined,
  graph: readonly GraphEdge[]
): MapFact[] {
  if (!dependencies) return [];
  const consumersByPackage = new Map<string, string[]>();
  for (const edge of graph) {
    if (edge.resolution !== "external" || edge.package === undefined) continue;
    if (!(edge.package in dependencies)) continue;
    if (CLASSIFIED_DEPENDENCY_NAMES.has(edge.package)) continue;
    const files = consumersByPackage.get(edge.package) ?? [];
    if (!files.includes(edge.from)) files.push(edge.from);
    consumersByPackage.set(edge.package, files);
  }
  const facts: MapFact[] = [];
  for (const [pkg, files] of [...consumersByPackage].sort(([a], [b]) => a.localeCompare(b))) {
    facts.push({
      fact: "dependency_used",
      value: pkg,
      certainty: "OBSERVED",
      provenance: { file: files[0] as string, field: "import" },
      files: files.slice(0, 5),
      fileCount: files.length,
    });
  }
  return facts;
}

// ─── resolução de import (relativo + alias + externo) — A8 ─────────────────

const RELATIVE_CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

async function resolveAgainstDisk(base: string, rootPath: string): Promise<string | undefined> {
  const swapped = base.replace(/\.jsx$/, ".tsx").replace(/\.js$/, ".ts");
  const bases = swapped === base ? [base] : [base, swapped];
  for (const b of bases) {
    for (const suffix of RELATIVE_CANDIDATE_SUFFIXES) {
      const candidate = suffix ? `${b}${suffix}` : b;
      if (await exists(path.join(rootPath, candidate))) return candidate;
    }
  }
  return undefined;
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

interface Resolved {
  readonly to?: string;
  readonly resolution: EdgeResolution;
  readonly package?: string;
}

async function resolveSpecifier(
  fromFile: string,
  specifier: string,
  rootPath: string,
  aliasConfig: TsconfigAliasConfig | undefined
): Promise<Resolved> {
  if (specifier.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    const to = await resolveAgainstDisk(base, rootPath);
    return to ? { to, resolution: "resolved" } : { resolution: "unresolved" };
  }

  const aliasCandidates = aliasConfig ? candidatesForAlias(specifier, aliasConfig) : [];
  for (const candidateBase of aliasCandidates) {
    const to = await resolveAgainstDisk(candidateBase, rootPath);
    if (to) return { to, resolution: "resolved" };
  }
  if (aliasCandidates.length > 0) return { resolution: "unresolved" }; // casou um padrão de alias, mas nada existe no disco

  return { resolution: "external", package: packageNameOf(specifier) };
}

// ─── orquestração principal ─────────────────────────────────────────────────

export interface MapScanResult {
  readonly routes: readonly RouteFact[];
  readonly database: readonly DatabaseFact[];
  readonly graph: readonly GraphEdge[];
  readonly authFacts: readonly MapFact[];
  readonly integrationFacts: readonly MapFact[];
  /** V4 — `dependency_used`: dependência de runtime (`dependencies`) provada por import real, sem detector próprio. */
  readonly dependencyFacts: readonly MapFact[];
  readonly materials: readonly MaterialEntry[];
  readonly coverage: CoverageReport;
  readonly sourceEntries: readonly FingerprintEntry[];
  readonly filesScanned: number;
}

/**
 * As extensões de que o extrator de imports consegue tirar aresta.
 *
 *   SEM ARESTA POSSÍVEL NÃO É "ISOLADO", É "NÃO PARTICIPA"
 *
 * MEDIDO em 2026-09-19 neste repo: dos 245 nós sem nenhuma aresta, 190 eram
 * `.md` e 242 no total eram arquivos que NUNCA poderiam ter import — a tela
 * do mapa chamava todos de "isolados" e o dono leu, com razão, como poluição.
 * Isolado de verdade (código que ninguém usa e que não usa ninguém) eram 3.
 *
 * `.mts`/`.cts` entraram aqui porque a ausência deles era CEGUEIRA, não
 * ruído: os 5 workers de `tests/fixtures/*.mts` têm até 11 imports cada e
 * apareciam como isolados por o extrator nunca os ler.
 *
 * `.sql` fica de fora: entra no scan de banco, e um arquivo SQL não importa
 * módulo nenhum — incluí-lo devolveria o mesmo falso isolado que esta
 * separação existe para matar.
 *
 * Extensão é METADE da régua. A outra metade é material excluído: as arestas
 * de `tests/fixtures/` e afins JÁ eram filtradas do grafo (`graph =
 * mergedGraph.filter(!isUnderExcludedMaterial)`) enquanto os nós entravam
 * inteiros — o mesmo arquivo entrava como nó e saía como aresta, e o que
 * sobrava na tela era um isolado de mentira. `linkable` responde "participa
 * do grafo?", e quem o scan exclui não participa.
 */
const GRAPH_LINKABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
]);

const ROUTE_DB_GRAPH_EXTENSIONS = new Set([...GRAPH_LINKABLE_EXTENSIONS, ".sql"]);

export interface ScanProjectStructureOptions {
  /** G3.4 — resultado de `resolveRouteSyntaxFramework` sobre os fatos de
   *  stack já computados pelo chamador (`buildProjectMap`, roda antes desta
   *  varredura nos dois pontos de chamada). `undefined` preserva o rótulo
   *  genérico `express-fastify` de hoje. */
  readonly detectedRouteFramework?: string;
  /** Ver `resolveScope` — repassado pelo chamador que já provou o fato (ex.:
   *  `refreshProjectMapIncremental` via `gitFacts.headCommit`). */
  readonly knownGitRepo?: boolean;
}

export async function scanProjectStructure(
  rootPath: string,
  options: ScanProjectStructureOptions = {}
): Promise<MapScanResult> {
  const scope = await resolveScope(rootPath, options.knownGitRepo);
  const workspaceGlobs = await readWorkspaceGlobs(rootPath);
  const rawMaterials = classifyMaterials(scope.files, workspaceGlobs);

  const aliasConfig = await loadAliasConfig(rootPath);

  const rawRoutes: RouteFact[] = [];
  const rawDatabase: DatabaseFact[] = [];
  const rawAuth: MapFact[] = [];
  const rawIntegrations: MapFact[] = [];
  const ownEdges: GraphEdge[] = [];
  /** V2 — `schema.prisma` sintaticamente inválido vira erro de ÁREA (database), nunca fato inventado. */
  const databaseValidationErrors: ScanErrorEntry[] = [];

  for (const relFile of scope.files) {
    const content = scope.contents.get(relFile);
    if (content === undefined) continue;
    const text = content.toString("utf-8");

    /**
     * `tests/` entra no import-graph (arestas reais, úteis) mas NÃO nos
     * detectores de routes/database/auth/integrations: fixtures destes
     * MESMOS detectores guardam sintaxe de exemplo como string literal —
     * texto de dado, não código de registro real. Medido rodando `nexos map`
     * neste repositório antes desta fatia.
     */
    if (!isTestFile(relFile)) {
      rawRoutes.push(...detectRoutesInFile(relFile, text, options.detectedRouteFramework));
      rawDatabase.push(...detectDatabaseInFile(relFile, text));
      if (relFile.endsWith("schema.prisma")) {
        const validation = validatePrismaSchema(stripCommentLines(text));
        if (!validation.ok) {
          databaseValidationErrors.push({ path: relFile, detail: `linha ${validation.line}: ${validation.reason}` });
        }
      }
      rawAuth.push(...detectAuthSignalsInFile(relFile, text));
      rawIntegrations.push(...detectIntegrationSignalsInFile(relFile, text));
    }

    const seenPairs = new Set<string>();
    for (const ref of extractImportRefs(relFile, text)) {
      const resolved = await resolveSpecifier(relFile, ref.specifier, rootPath, aliasConfig);
      const dedupeKey = resolved.to ?? `${resolved.resolution}:${ref.specifier}`;
      if (seenPairs.has(dedupeKey)) continue; // A8 — não duplica alias e relativo para o mesmo alvo (nem repete o mesmo specifier externo/unresolved)
      seenPairs.add(dedupeKey);
      ownEdges.push({
        from: relFile,
        specifier: ref.specifier,
        ...(resolved.to !== undefined ? { to: resolved.to } : {}),
        resolution: resolved.resolution,
        ...(resolved.package !== undefined ? { package: resolved.package } : {}),
        certainty: "OBSERVED",
        ...(ref.typeOnly ? { typeOnly: true as const } : {}),
        provenance: { file: relFile, source: "import-scan" },
      });
    }
  }

  const graphifyEdges = await readGraphifyFileEdges(rootPath);
  const mergedGraph = mergeGraphifyEdges(ownEdges, graphifyEdges);

  // A7 — reference_or_example confirmado como consumido pelo app vira vendored_dependency.
  const importedDirs = new Set<string>();
  const referenceDirs = rawMaterials.filter((m) => m.kind === "reference_or_example");
  for (const edge of mergedGraph) {
    if (edge.resolution !== "resolved" || edge.to === undefined) continue;
    for (const material of referenceDirs) {
      if ((edge.to === material.path || edge.to.startsWith(`${material.path}/`)) && edge.from !== material.path && !edge.from.startsWith(`${material.path}/`)) {
        importedDirs.add(material.path);
      }
    }
  }
  const materials = upgradeVendored(rawMaterials, importedDirs);

  const routes = rawRoutes.filter((r) => !isUnderExcludedMaterial(r.file, materials, true));
  const database = rawDatabase.filter((d) => !isUnderExcludedMaterial(d.file, materials, true));
  const authFacts = rawAuth.filter((f) => !isUnderExcludedMaterial(f.provenance.file, materials, true));
  const integrationFacts = aggregateEndpointFacts(rawIntegrations.filter((f) => !isUnderExcludedMaterial(f.provenance.file, materials, true)));
  const graph = mergedGraph.filter((e) => !isUnderExcludedMaterial(e.from, materials, false));
  const dependencyFacts = computeDependencyUsageFacts(await readProdDependencyNames(rootPath), graph);

  const sourceEntries: FingerprintEntry[] = scope.files.map((p) => ({ path: p, sha1: sha1Of(scope.contents.get(p) as Buffer) }));

  const coverage = buildCoverage(scope.files, scope.skipped, [...scope.errors, ...databaseValidationErrors]);

  return {
    routes,
    database,
    graph,
    authFacts,
    integrationFacts,
    dependencyFacts,
    materials,
    coverage,
    sourceEntries,
    filesScanned: scope.files.length,
  };
}

/**
 * A13 — fingerprint do escopo atual, usado por `freshness.ts` dos DOIS lados:
 * (a) projeto SEM Git, onde é a ÚNICA forma de saber se algo mudou — só
 * compensa quando o escopo é pequeno (`maxFiles`), `undefined` acima disso
 * (`freshness.ts` trata como `reason: "unknown"`, nunca como "fresco"); (b)
 * projeto COM Git mas com sinal de sujeira (HEAD andou ou `git status`
 * mostrou algo fora de `.nexos/`) — confirma se o conteúdo observado é
 * REALMENTE diferente do último mapa antes de acusar `stale` (sem isso, um
 * arquivo sem commit que já foi capturado por um refresh anterior faria
 * `checkMapFreshness` nunca convergir para "fresh").
 */
export async function computeScopeFingerprint(
  rootPath: string,
  maxFiles: number,
  knownGitRepo?: boolean
): Promise<{ readonly fingerprint: string; readonly filesExamined: number } | undefined> {
  const scope = await resolveScope(rootPath, knownGitRepo);
  if (scope.files.length > maxFiles) return undefined;
  const entries: FingerprintEntry[] = scope.files.map((p) => ({ path: p, sha1: sha1Of(scope.contents.get(p) as Buffer) }));
  return { fingerprint: computeSourceFingerprint(entries), filesExamined: scope.files.length };
}

const MAX_FILES_PER_ENDPOINT = 5;

/**
 * R2 (rodada de correção) — um fato POR HOST, não um por ocorrência: a
 * cópia real do Fintech tinha o mesmo host repetido em dezenas de arquivos,
 * cada um virando um fato próprio (1038 fatos, project.json de 249 KB).
 * Arquivos vão em `files` (com teto) + `fileCount` (total real, pra
 * `architecture.ts` imprimir "... e mais N" sem perder a contagem).
 */
function aggregateEndpointFacts(facts: readonly MapFact[]): MapFact[] {
  const byHost = new Map<string, string[]>();
  const rest: MapFact[] = [];
  for (const f of facts) {
    if (f.provenance.field !== "endpoint_referenced") {
      rest.push(f);
      continue;
    }
    const files = byHost.get(f.value) ?? [];
    if (!files.includes(f.provenance.file)) files.push(f.provenance.file);
    byHost.set(f.value, files);
  }
  const aggregated = [...rest];
  for (const [host, files] of byHost) {
    aggregated.push({
      fact: "integration",
      value: host,
      certainty: "OBSERVED",
      provenance: { file: files[0] as string, field: "endpoint_referenced" },
      files: files.slice(0, MAX_FILES_PER_ENDPOINT),
      fileCount: files.length,
    });
  }
  return aggregated;
}

async function loadAliasConfig(rootPath: string): Promise<TsconfigAliasConfig | undefined> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const raw = await readFile(path.join(rootPath, name), "utf-8");
      const config = parseTsconfigAliases(raw, "");
      if (config) return config;
    } catch {
      // ausente/ilegível — tenta o próximo candidato.
    }
  }
  return undefined;
}

// ─── cobertura por área — A9 ─────────────────────────────────────────────────

const UNSUPPORTED_STACK_SIGNALS = [
  "CMakeLists.txt",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
] as const;
const UNSUPPORTED_EXTENSIONS = new Set([".cpp", ".java", ".rb", ".php", ".cs", ".swift", ".kt"]);

/** R4 — erro de leitura relevante pra ÁREA (ex.: `schema.prisma` ilegível é erro de `database`, mesmo com outros arquivos .ts examinados sem problema). */
function relevantErrorFor(area: CoverageArea, errors: readonly ScanErrorEntry[]): ScanErrorEntry | undefined {
  return errors.find((e) => {
    if (area === "database") return e.path.endsWith("schema.prisma") || e.path.endsWith(".sql");
    if (area === "routes" || area === "graph") return ROUTE_DB_GRAPH_EXTENSIONS.has(path.posix.extname(e.path));
    if (area === "auth" || area === "integrations") return isEvidenceEligible(e.path);
    return false;
  });
}

function buildCoverage(files: readonly string[], skipped: readonly SkippedFile[], errors: readonly ScanErrorEntry[]): CoverageReport {
  const supportedFiles = files.filter((f) => ROUTE_DB_GRAPH_EXTENSIONS.has(path.posix.extname(f)));
  const unsupportedSignals = files.filter(
    (f) => (UNSUPPORTED_STACK_SIGNALS as readonly string[]).includes(path.posix.basename(f)) || UNSUPPORTED_EXTENSIONS.has(path.posix.extname(f))
  );

  const areas: AreaCoverage[] = [];
  const codeArea = (area: CoverageArea): AreaCoverage => {
    const err = relevantErrorFor(area, errors);
    if (err) {
      return { area, status: "error", detail: `erro em \`${err.path}\`: ${err.detail}` };
    }
    if (supportedFiles.length === 0 && unsupportedSignals.length > 0) {
      return {
        area,
        status: "unsupported",
        detail: `stack sem detector — visto: ${unsupportedSignals.slice(0, 8).join(", ")}${unsupportedSignals.length > 8 ? `, +${unsupportedSignals.length - 8}` : ""}`,
      };
    }
    if (supportedFiles.length === 0) {
      return { area, status: "not_examined", detail: "nenhum arquivo de linguagem suportada (ts/tsx/js/jsx/py/sql) no escopo" };
    }
    const skippedOfType = skipped.filter((s) => ROUTE_DB_GRAPH_EXTENSIONS.has(path.posix.extname(s.path)));
    if (skippedOfType.length > 0) {
      return { area, status: "partial", detail: `${skippedOfType.length} arquivo(s) relevante(s) fora da varredura: ${skippedOfType.map((s) => `${s.path} (${s.reason})`).join("; ")}` };
    }
    return { area, status: "analyzed", detail: `${supportedFiles.length} arquivo(s) examinado(s)` };
  };

  for (const area of ["routes", "database", "graph"] as const) areas.push(codeArea(area));

  for (const area of ["auth", "integrations"] as const) {
    const err = relevantErrorFor(area, errors);
    if (err) {
      areas.push({ area, status: "error", detail: `erro em \`${err.path}\`: ${err.detail}` });
    } else if (supportedFiles.length === 0) {
      areas.push({ area, status: "not_examined", detail: "nenhum arquivo de código no escopo para observar evidência" });
    } else {
      areas.push({ area, status: "analyzed", detail: `${supportedFiles.length} arquivo(s) examinado(s) por evidência genérica` });
    }
  }

  return { areas, filesExamined: files.length, skipped, errors };
}

export async function writeCoverageJson(rootPath: string, coverage: CoverageReport, materials: readonly MaterialEntry[], generatedAt: string): Promise<void> {
  const p = forProject(rootPath);
  await mkdir(p.mapRoot(), { recursive: true });
  await writeFile(
    path.join(p.mapRoot(), "coverage.json"),
    `${JSON.stringify({ schema_version: 1, generated_at: generatedAt, ...coverage, materials }, null, 2)}\n`,
    "utf-8"
  );
}

/**
 * Grava `routes.json`/`database.json`/`graph.json` — cada entrada ganha um
 * `id` sequencial (`ROUTE-N`/`DB-N`/`EDGE-N`) na ordem em que o scan achou,
 * para `architecture.ts` citar. JSON determinístico
 * (`JSON.stringify(..., 2)`), byte-idêntico entre execuções sobre o MESMO
 * código-fonte.
 */
export async function writeMapArtifacts(rootPath: string, result: MapScanResult, generatedAt: string): Promise<void> {
  const p = forProject(rootPath);
  await mkdir(p.mapRoot(), { recursive: true });

  const routes = assignStableIds("ROUTE", result.routes, (r) => [r.method, r.path, r.file]);
  await writeFile(
    p.mapRoutesJson(),
    `${JSON.stringify({ schema_version: 1, generated_at: generatedAt, routes }, null, 2)}\n`,
    "utf-8"
  );

  const entities = assignStableIds("DB", result.database, (d) => [d.kind, d.name, d.file]);
  await writeFile(
    p.mapDatabaseJson(),
    `${JSON.stringify({ schema_version: 1, generated_at: generatedAt, entities }, null, 2)}\n`,
    "utf-8"
  );

  const edges = assignStableIds("EDGE", result.graph, (e) => [e.from, e.specifier, e.to]);
  const nodes = await buildGraphNodes(rootPath, result.sourceEntries, result.materials);
  await writeFile(
    p.mapGraphJson(),
    `${JSON.stringify({ schema_version: 1, generated_at: generatedAt, files_scanned: result.filesScanned, nodes, edges }, null, 2)}\n`,
    "utf-8"
  );
}

/**
 * Nó de primeira classe do grafo — TODO arquivo do escopo, inclusive o que
 * nenhuma aresta toca.
 *
 *   DERIVAR NÓ DE ARESTA APAGA O ARQUIVO ISOLADO
 *
 * MEDIDO em 2026-09-18 neste repo: `files_scanned` 576 contra 319 nós
 * deriváveis das arestas — 257 arquivos (45%) sumiriam de qualquer
 * visualizador que inferisse os nós a partir de `from`/`to`. Arquivo sem
 * import e sem importador é exatamente o que mais precisa aparecer num mapa,
 * e era o único que não aparecia. A lista já existia em `sourceEntries`
 * (mesma origem de `filesScanned`) e era descartada na escrita.
 *
 * `id` É O PATH, de propósito: as arestas já referenciam arquivo por path em
 * `from`/`to`, então um id sintético exigiria tabela de tradução e quebraria
 * a seleção da UI a cada regeneração. Path é estável entre gerações.
 */
export interface GraphNode {
  readonly id: string;
  readonly path: string;
  readonly kind: "file";
  /**
   * O extrator de imports consegue tirar aresta deste arquivo? Sem isto, quem
   * desenha o mapa não distingue "código que ninguém usa" (achado) de
   * "markdown, que jamais teria import" (esperado) — e mostra 245 onde há 3.
   */
  readonly linkable: boolean;
  readonly certainty: "OBSERVED";
  readonly provenance: { readonly file: string; readonly source: "map-scan" };
  readonly last_changed_commit: string | null;
  readonly last_changed_at: string | null;
}

/**
 * Última mudança por arquivo em UMA passada de `git log --name-only`
 * (medido: 1.1s para 1256 commits / 26967 linhas neste repo) em vez de um
 * spawn de git por arquivo — 576 spawns seriam o mesmo dado por duas ordens
 * de grandeza a mais de custo. Primeiro aparecimento vence: `git log` já sai
 * do mais recente para o mais antigo.
 *
 * Fail-open deliberado: sem git, fora de work tree, ou root do projeto
 * diferente do root do repositório (paths do `git log` são relativos ao
 * repositório), os campos ficam `null`. `null` é "não sabido", nunca "nunca
 * mudou" — a UI tem que conseguir distinguir os dois.
 */
async function lastChangeByFile(rootPath: string): Promise<Map<string, { commit: string; at: string }>> {
  const out = new Map<string, { commit: string; at: string }>();
  const res = await systemGitRunner().run(["-C", rootPath, "log", "--format=C|%H|%cI", "--name-only", "--no-merges"]);
  if (!res.ok || res.code !== 0) return out;
  let commit = "";
  let at = "";
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("C|")) {
      const parts = line.split("|");
      commit = parts[1] ?? "";
      at = parts[2] ?? "";
      continue;
    }
    if (line === "" || commit === "") continue;
    if (!out.has(line)) out.set(line, { commit, at });
  }
  return out;
}

async function buildGraphNodes(
  rootPath: string,
  sourceEntries: readonly FingerprintEntry[],
  materials: readonly MaterialEntry[]
): Promise<readonly GraphNode[]> {
  const changes = await lastChangeByFile(rootPath);
  return [...sourceEntries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => {
      const change = changes.get(entry.path);
      return {
        id: entry.path,
        path: entry.path,
        kind: "file" as const,
        linkable:
          GRAPH_LINKABLE_EXTENSIONS.has(path.posix.extname(entry.path)) &&
          !isUnderExcludedMaterial(entry.path, materials, false),
        certainty: "OBSERVED" as const,
        provenance: { file: entry.path, source: "map-scan" as const },
        last_changed_commit: change?.commit ?? null,
        last_changed_at: change?.at ?? null,
      };
    });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

const GRAPHIFY_IMPORT_RELATIONS = new Set(["imports", "imports_from", "dynamic_import", "re_exports"]);

/**
 * `graphify-out/graph.json` — formato node-link (networkx): `nodes[].id` +
 * `nodes[].source_file`, `links[].source`/`target` (ids) + `.relation`.
 * Qualquer desvio de forma (ausente, JSON quebrado, campos faltando)
 * devolve `[]` — NUNCA lança. `ausência ou falha do graphify não quebra nada`.
 */
async function readGraphifyFileEdges(rootPath: string): Promise<{ readonly from: string; readonly to: string }[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(rootPath, "graphify-out", "graph.json"), "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    const nodes = parsed?.nodes;
    const links = parsed?.links;
    if (!Array.isArray(nodes) || !Array.isArray(links)) return [];

    const idToFile = new Map<string, string>();
    for (const rawNode of nodes) {
      const node = asRecord(rawNode);
      const id = node?.id;
      const file = node?.source_file;
      if (typeof id === "string" && typeof file === "string") idToFile.set(id, file);
    }

    const edges: { from: string; to: string }[] = [];
    for (const rawLink of links) {
      const link = asRecord(rawLink);
      const relation = link?.relation;
      if (typeof relation !== "string" || !GRAPHIFY_IMPORT_RELATIONS.has(relation)) continue;
      const from = typeof link?.source === "string" ? idToFile.get(link.source) : undefined;
      const to = typeof link?.target === "string" ? idToFile.get(link.target) : undefined;
      if (from && to && from !== to) edges.push({ from, to });
    }
    return edges;
  } catch {
    return [];
  }
}
