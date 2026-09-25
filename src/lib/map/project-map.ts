/**
 * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — I/O do Project
 * Map: le manifests/probes, chama `detectStackFacts` (puro), funde com o
 * mapa anterior no modo incremental e escreve `.nexos/map/project.json`.
 *
 *   IDEMPOTENT: rodar duas vezes sem nada mudar produz bytes IDÊNTICOS
 *   INCREMENTAL: com `changedFiles`, só os paths TOCADOS são lidos de novo
 *
 * P1.4 fatia A (A13/A15) — "nada mudou" deixou de ser só `git diff HEAD`:
 * `refreshProjectMapIncremental` também confere `git status --porcelain
 * -uall` fora de `.nexos/` (mudança sem commit, rename, exclusão, arquivo
 * não rastreado) e, quando há qualquer sujeira, decide se REALMENTE mudou
 * comparando o `source_fingerprint` recém-calculado contra o gravado — só
 * escreve quando o conteúdo observado é diferente do último mapa. Isso
 * mantém o caminho rápido (árvore limpa, HEAD parado → zero escrita, zero
 * scan) e ainda assim nunca perde uma mudança sem commit.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { forProject } from "../capsule/paths.js";
import { parseCanonical } from "../capsule/codec.js";
import { validateManifest } from "../capsule/schemas.js";
import { updateManifestLastMappedCommit } from "../capsule/initializer.js";
import { resolveProject } from "../project-resolver.js";
import { computeLifecycleGitFacts, type ProjectLifecycleGitFacts } from "../capsule/project-lifecycle.js";
import {
  detectStackFacts,
  sortFacts,
  PATH_PROBE_PATHS,
  DETECTOR_WATCHED_PATHS,
  type MapFact,
  type RawPackageJson,
  type RawTextFile,
  type StackDetectorInput,
} from "./stack-detector.js";
import { scanProjectStructure, writeMapArtifacts, writeCoverageJson, gitStatusPorcelainOutsideNexos, type MapScanResult } from "./map-scan.js";
import { computeSourceFingerprint, assignStableIds } from "./fingerprint.js";
import { generateArchitectureMd } from "./architecture.js";
import { resolveRouteSyntaxFramework } from "./routes.js";
import type { ScanErrorEntry } from "./coverage.js";

export interface ProjectMapOptions {
  /** `git diff --name-only <last_mapped_commit> HEAD` — presente junto com `previousFacts` ativa o modo incremental. */
  readonly changedFiles?: readonly string[];
  /** Fatos do `.nexos/map/project.json` anterior — carregados pelo chamador (`readExistingMap`). */
  readonly previousFacts?: readonly MapFact[];
}

export interface ProjectMapResult {
  readonly facts: readonly MapFact[];
  /** Paths (relativos, posix) efetivamente lidos nesta chamada — vazio só é possível se `changedFiles` não tocou nada observável. */
  readonly reprocessed: readonly string[];
  /** A10 — manifest presente mas ILEGÍVEL (ex.: `package.json` com JSON inválido). Nunca confundido com manifest AUSENTE. */
  readonly errors: readonly ScanErrorEntry[];
}

function touchedBy(probePath: string, changedFiles: readonly string[]): boolean {
  return changedFiles.some((f) => f === probePath || f.startsWith(`${probePath}/`));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf-8");
  } catch {
    return undefined;
  }
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * A10 — `package.json` AUSENTE (não existe) é silencioso (fato normal, sem
 * manifest de JS/TS); `package.json` PRESENTE mas com JSON inválido é ERRO —
 * as duas situações eram indistinguíveis antes desta fatia (`readJson`
 * engolia qualquer falha, incluindo parse quebrado, como "ausente").
 */
async function readPackageJsonSafe(target: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(target, "utf-8");
  } catch {
    return {};
  }
  try {
    return { data: JSON.parse(raw) as Record<string, unknown> };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Le só o que `watched` pede. No modo cheio, `watched` é
 * `DETECTOR_WATCHED_PATHS` inteiro; no incremental, só os paths tocados por
 * `changedFiles` — arquivo não tocado nunca é aberto de novo.
 */
async function gatherInput(
  rootPath: string,
  watched: ReadonlySet<string>
): Promise<{ input: StackDetectorInput; errors: ScanErrorEntry[] }> {
  const probes: Record<string, boolean> = {};
  for (const p of PATH_PROBE_PATHS) {
    if (watched.has(p)) probes[p] = await exists(path.join(rootPath, p));
  }

  const errors: ScanErrorEntry[] = [];
  let packageJson: RawPackageJson | undefined;
  if (watched.has("package.json")) {
    const { data: raw, error } = await readPackageJsonSafe(path.join(rootPath, "package.json"));
    if (error) errors.push({ path: "package.json", detail: `JSON inválido: ${error}` });
    if (raw) {
      packageJson = {
        path: "package.json",
        dependencies: asStringRecord(raw.dependencies),
        devDependencies: asStringRecord(raw.devDependencies),
        scripts: asStringRecord(raw.scripts),
        bin: raw.bin,
        main: typeof raw.main === "string" ? raw.main : undefined,
      };
    }
  }

  let lockfile: StackDetectorInput["lockfile"];
  if (watched.has("package-lock.json") && (await exists(path.join(rootPath, "package-lock.json")))) {
    lockfile = { path: "package-lock.json", manager: "npm" };
  } else if (watched.has("pnpm-lock.yaml") && (await exists(path.join(rootPath, "pnpm-lock.yaml")))) {
    lockfile = { path: "pnpm-lock.yaml", manager: "pnpm" };
  } else if (watched.has("yarn.lock") && (await exists(path.join(rootPath, "yarn.lock")))) {
    lockfile = { path: "yarn.lock", manager: "yarn" };
  }

  const pyproject = watched.has("pyproject.toml") ? await readTextFile(rootPath, "pyproject.toml") : undefined;
  const requirementsTxt = watched.has("requirements.txt") ? await readTextFile(rootPath, "requirements.txt") : undefined;
  const goMod = watched.has("go.mod") ? await readTextFile(rootPath, "go.mod") : undefined;
  const cargoToml = watched.has("Cargo.toml") ? await readTextFile(rootPath, "Cargo.toml") : undefined;

  return { input: { packageJson, lockfile, pyproject, requirementsTxt, goMod, cargoToml, probes }, errors };
}

async function readTextFile(rootPath: string, rel: string): Promise<RawTextFile | undefined> {
  const raw = await readText(path.join(rootPath, rel));
  return raw !== undefined ? { path: rel, raw } : undefined;
}

/**
 * Monta os fatos do Project Map. PURA em relação ao resultado anterior (não
 * relê o que já sabe no modo incremental); I/O real acontece aqui, nunca em
 * `stack-detector.ts`.
 */
export async function buildProjectMap(rootPath: string, options: ProjectMapOptions = {}): Promise<ProjectMapResult> {
  const incremental = options.previousFacts !== undefined && options.changedFiles !== undefined;
  const watchedList = incremental
    ? DETECTOR_WATCHED_PATHS.filter((p) => touchedBy(p, options.changedFiles as readonly string[]))
    : DETECTOR_WATCHED_PATHS;
  const watched = new Set(watchedList);

  const { input, errors } = await gatherInput(rootPath, watched);
  const freshFacts = detectStackFacts(input);

  if (!incremental) {
    return { facts: freshFacts, reprocessed: [...watched].sort(), errors };
  }

  const kept = (options.previousFacts as readonly MapFact[]).filter((f) => !watched.has(f.provenance.file));
  return { facts: sortFacts([...kept, ...freshFacts]), reprocessed: [...watched].sort(), errors };
}

interface ProjectJsonMeta {
  readonly facts?: readonly MapFact[];
  readonly sourceFingerprint?: string;
  readonly filesExamined?: number;
  readonly lastMappedCommit?: string;
}

async function readProjectJsonMeta(rootPath: string): Promise<ProjectJsonMeta | undefined> {
  const raw = await readText(forProject(rootPath).mapProjectJson());
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      facts: Array.isArray(parsed.facts) ? (parsed.facts as MapFact[]) : undefined,
      sourceFingerprint: typeof parsed.source_fingerprint === "string" ? parsed.source_fingerprint : undefined,
      filesExamined: typeof parsed.files_examined === "number" ? parsed.files_examined : undefined,
      lastMappedCommit: typeof parsed.last_mapped_commit === "string" ? parsed.last_mapped_commit : undefined,
    };
  } catch {
    return undefined;
  }
}

/** `.nexos/map/project.json` já existente — `undefined` quando ausente/ilegível (primeira execução). */
export async function readExistingMap(rootPath: string): Promise<readonly MapFact[] | undefined> {
  return (await readProjectJsonMeta(rootPath))?.facts;
}

/**
 * Grava `.nexos/map/project.json` (fatos + metadata) — JSON determinístico
 * (`sortFacts` + `JSON.stringify(..., 2)`), byte-idêntico entre execuções
 * quando nada mudou (mesma exigência de idempotência do contrato). A13:
 * carrega também `source_fingerprint` (sha256 do conteúdo do escopo inteiro,
 * `fingerprint.ts`) + `files_examined` — usados por `refreshProjectMapIncremental`
 * (e por quem quiser medir frescor sem depender só de commit).
 */
export async function writeMapProjectJson(
  rootPath: string,
  facts: readonly MapFact[],
  meta: {
    readonly lastMappedCommit?: string;
    readonly generatedAt: string;
    readonly sourceFingerprint?: string;
    readonly filesExamined?: number;
  }
): Promise<readonly (MapFact & { readonly id: string })[]> {
  const p = forProject(rootPath);
  await mkdir(p.mapRoot(), { recursive: true });
  /**
   * P1.4 — `id` estável DENTRO desta execução (`STACK-1`, `STACK-2`, ...) na
   * MESMA ordem determinística de `sortFacts` — `architecture.ts` cita esses
   * ids (devolvidos aqui para o chamador reusar, nunca recalculados numa
   * segunda leitura). Não sobrevive a um fato novo inserido no meio da
   * ordenação (o array inteiro reindexa), mas `architecture.md` é sempre
   * regenerado junto — nunca uma citação órfã de uma execução anterior.
   */
  const sorted = assignStableIds("STACK", sortFacts(facts), (f) => [f.fact, f.value, f.provenance.file]);
  const body = {
    schema_version: 1,
    generated_at: meta.generatedAt,
    ...(meta.lastMappedCommit !== undefined ? { last_mapped_commit: meta.lastMappedCommit } : {}),
    ...(meta.sourceFingerprint !== undefined ? { source_fingerprint: meta.sourceFingerprint } : {}),
    ...(meta.filesExamined !== undefined ? { files_examined: meta.filesExamined } : {}),
    facts: sorted,
  };
  await writeFile(p.mapProjectJson(), `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  return sorted;
}

/**
 * P1.4 — a metade routes/database/graph/architecture do Project Map, agora
 * também auth/integration/materiais/cobertura (fatia A). Recebe o `scan` JÁ
 * COMPUTADO pelo chamador — nunca varre o disco de novo — para citar os
 * MESMOS `STACK-N` que acabaram de ir pro `project.json`.
 */
async function writeRoutesDbGraphAndArchitecture(
  rootPath: string,
  projectName: string,
  stackFactsWithIds: readonly (MapFact & { readonly id: string })[],
  scan: MapScanResult,
  nowIso: string
): Promise<void> {
  const routesWithIds = assignStableIds("ROUTE", scan.routes, (r) => [r.method, r.path, r.file]);
  const databaseWithIds = assignStableIds("DB", scan.database, (d) => [d.kind, d.name, d.file]);
  const graphWithIds = assignStableIds("EDGE", scan.graph, (e) => [e.from, e.specifier, e.to]);
  await writeMapArtifacts(rootPath, scan, nowIso);

  const architectureMd = generateArchitectureMd({
    projectName,
    facts: stackFactsWithIds,
    routes: routesWithIds,
    database: databaseWithIds,
    graph: graphWithIds,
    materials: scan.materials,
    coverage: scan.coverage,
    generatedAt: nowIso,
  });
  await writeFile(forProject(rootPath).mapArchitectureMd(), architectureMd, "utf-8");
}

/**
 * Orquestra a escrita do Project Map para um manifest RECÉM-escrito
 * (`nexos init` — criação ou reconciliação). Lê `manifest.yaml` de volta
 * (fonte única de `project.id`/`binding`/`last_mapped_commit` — nunca um
 * segundo cálculo) e faz uma varredura CHEIA: primeira execução não tem
 * `previousFacts`/`changedFiles` para ser incremental.
 */
export async function writeFreshProjectMap(rootPath: string): Promise<ProjectMapResult> {
  const p = forProject(rootPath);
  const parsed = validateManifest(parseCanonical(await readFile(p.manifest(), "utf-8")));
  if (!parsed.ok || !parsed.value.project) {
    throw new Error(`[project-map] manifest inválido ou sem project em ${p.manifest()} — nada escrito no map.`);
  }

  const stackResult = await buildProjectMap(rootPath, {});
  const scan = await scanProjectStructure(rootPath, { detectedRouteFramework: resolveRouteSyntaxFramework(stackResult.facts) });
  const combinedFacts = sortFacts([...stackResult.facts, ...scan.authFacts, ...scan.integrationFacts, ...scan.dependencyFacts]);
  const fingerprint = computeSourceFingerprint(scan.sourceEntries);
  const nowIso = new Date().toISOString();

  const stackFactsWithIds = await writeMapProjectJson(rootPath, combinedFacts, {
    lastMappedCommit: parsed.value.last_mapped_commit,
    generatedAt: nowIso,
    sourceFingerprint: fingerprint,
    filesExamined: scan.filesScanned,
  });
  await writeRoutesDbGraphAndArchitecture(rootPath, parsed.value.project.name, stackFactsWithIds, scan, nowIso);
  await writeCoverageJson(rootPath, mergeStackErrors(scan.coverage, stackResult.errors), scan.materials, nowIso);
  return { facts: combinedFacts, reprocessed: stackResult.reprocessed, errors: stackResult.errors };
}

function mergeStackErrors(
  coverage: MapScanResult["coverage"],
  stackErrors: readonly ScanErrorEntry[]
): MapScanResult["coverage"] {
  if (stackErrors.length === 0) return coverage;
  return { ...coverage, errors: [...coverage.errors, ...stackErrors] };
}

export interface IncrementalRefreshResult {
  readonly changed: boolean;
  /** Paths (relativos) efetivamente reprocessados — vazio quando `changed` é `false`. */
  readonly reprocessed: readonly string[];
  readonly newCommit?: string;
}

/**
 * P1.3/P1.4/fatia A — a metade incremental do contrato. Duas fases:
 *
 *   1. SINAL BARATO: HEAD andou desde `last_mapped_commit` (`hasStackDiff`),
 *      `architecture.md` nunca foi gerado (backfill de capsule pré-P1.4), OU
 *      a árvore de trabalho tem sujeira fora de `.nexos/` (`dirty` — A13,
 *      cobre mudança sem commit que `git diff HEAD` não vê). Nenhum dos três
 *      → `changed: false` SEM escanear nada (caminho rápido).
 *
 *   2. VERDADE POR CONTEÚDO: qualquer sinal do passo 1 dispara o scan
 *      completo (routes/database/graph/auth/integrations/materiais/
 *      cobertura + fingerprint). Só then a escrita é decidida — comparando o
 *      fingerprint RECÉM-calculado contra o gravado da última vez. Sujeira
 *      que já foi capturada por uma chamada anterior (nada mudou desde
 *      então) não reescreve nada: `generated_at` fica intocado, byte a byte
 *      (A15 — dois `nexos map` seguidos sem mudança real → diff zero).
 *
 * `precomputedGitFacts` (nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver)
 * — o MESMO `computeLifecycleGitFacts` que `classifyProjectLifecycleForResolution`/
 * `checkMapFreshness` já podem ter calculado para a MESMA fronteira, repassado
 * por `refreshMapIfStale`. `undefined` mantém o comportamento de sempre —
 * `repair.ts`/`commands/init.ts`/`commands/map.ts` continuam chamando sem o
 * segundo argumento, calculado aqui como antes.
 *
 * `precomputedDirtyFiles` (nexos://gotcha/map-scan-ts-isgitrepo-rev-parse-is-inside-work-tree-ainda-duplicado-fora-do-trio-lifecycle-freshness-refresh,
 * eixo "status --porcelain -uall 2x") — `git status --porcelain -uall` fora
 * de `.nexos/` que `checkMapFreshness` (freshness.ts) já rodou para a MESMA
 * fronteira, repassado por `refreshMapIfStale` (`freshness.rawDirtyFiles`,
 * SEM o filtro adicional de bootstrap-only de freshness.ts — o mesmo nível
 * que este módulo sempre usou). `undefined` mantém o comportamento de sempre
 * (mede aqui, como antes).
 */
export async function refreshProjectMapIncremental(
  rootPath: string,
  precomputedGitFacts?: ProjectLifecycleGitFacts,
  precomputedDirtyFiles?: readonly string[]
): Promise<IncrementalRefreshResult> {
  const resolution = await resolveProject({ cwd: rootPath });
  if (resolution.identitySource !== "manifest") return { changed: false, reprocessed: [] };

  const p = forProject(rootPath);
  const architectureMissing = !(await exists(p.mapArchitectureMd()));
  const gitFacts = precomputedGitFacts ?? (await computeLifecycleGitFacts(resolution));
  // Commitar só `.nexos/**` (ex.: o próprio map, numa entrega separada) não é mudança de código — não conta como "HEAD andou".
  const changedOutsideNexos = (gitFacts.changedSinceLastMapped ?? []).filter((f) => !f.startsWith(".nexos/"));
  const hasStackDiff = Boolean(gitFacts.headCommit && changedOutsideNexos.length > 0);
  const dirtyFiles = precomputedDirtyFiles ?? (await gitStatusPorcelainOutsideNexos(rootPath));
  const dirty = dirtyFiles.length > 0;

  if (!hasStackDiff && !architectureMissing && !dirty) {
    return { changed: false, reprocessed: [] };
  }

  const previousMeta = await readProjectJsonMeta(rootPath);
  const previous = previousMeta?.facts ?? [];

  /**
   * Sujeira fora do HEAD não tem como ser mapeada por `git diff HEAD-based`
   * — um `package.json` editado sem commit não aparece ali. Nesse caso o
   * stack faz varredura CHEIA (não incremental); só quando a única razão é
   * o HEAD ter andado (`hasStackDiff` sem `dirty`) o modo incremental
   * original (P1.3) se aplica.
   *
   * R6 (rodada de correção) — `buildProjectMap(rootPath, {})` sozinho
   * reporta TODOS os probes como `reprocessed` (modo cheio não sabe o que
   * mudou, só que precisa reler tudo por segurança). Pra reportar honesto
   * ao usuário, `reprocessed` some por cima com só os probes que os paths
   * REALMENTE tocados (HEAD + sujeira) cruzam — nunca a lista inteira só
   * porque o modo de detecção internamente foi cheio.
   */
  const touchedForReport = [...new Set([...changedOutsideNexos, ...dirtyFiles])];
  const reprocessedForReport = DETECTOR_WATCHED_PATHS.filter((p) => touchedBy(p, touchedForReport)).sort();

  const stackResult = dirty
    ? { ...(await buildProjectMap(rootPath, {})), reprocessed: reprocessedForReport }
    : hasStackDiff
      ? await buildProjectMap(rootPath, { previousFacts: previous, changedFiles: changedOutsideNexos })
      : { facts: previous, reprocessed: [] as readonly string[], errors: [] as ScanErrorEntry[] };

  const scan = await scanProjectStructure(rootPath, {
    detectedRouteFramework: resolveRouteSyntaxFramework(stackResult.facts),
    knownGitRepo: gitFacts.headCommit !== undefined,
  });
  const combinedFacts = sortFacts([...stackResult.facts, ...scan.authFacts, ...scan.integrationFacts, ...scan.dependencyFacts]);
  const fingerprint = computeSourceFingerprint(scan.sourceEntries);
  const lastMappedCommit = gitFacts.headCommit ?? gitFacts.lastMappedCommit ?? previousMeta?.lastMappedCommit;

  const nothingReallyChanged =
    previousMeta !== undefined &&
    !architectureMissing &&
    previousMeta.sourceFingerprint === fingerprint &&
    previousMeta.lastMappedCommit === lastMappedCommit;

  if (nothingReallyChanged) {
    return { changed: false, reprocessed: [] };
  }

  const nowIso = new Date().toISOString();
  const stackFactsWithIds = await writeMapProjectJson(rootPath, combinedFacts, {
    lastMappedCommit,
    generatedAt: nowIso,
    sourceFingerprint: fingerprint,
    filesExamined: scan.filesScanned,
  });
  if (hasStackDiff && gitFacts.headCommit) {
    await updateManifestLastMappedCommit(rootPath, gitFacts.headCommit);
  }

  const parsed = validateManifest(parseCanonical(await readFile(p.manifest(), "utf-8")));
  const projectName = parsed.ok && parsed.value.project ? parsed.value.project.name : rootPath;
  await writeRoutesDbGraphAndArchitecture(rootPath, projectName, stackFactsWithIds, scan, nowIso);
  await writeCoverageJson(rootPath, mergeStackErrors(scan.coverage, stackResult.errors), scan.materials, nowIso);

  return { changed: true, reprocessed: stackResult.reprocessed, newCommit: lastMappedCommit };
}

