/**
 * P1.4 fatia A (A13) — API pública de frescor do Project Map, para a fatia C
 * (SessionStart) decidir se atualiza o mapa sob orçamento sem reimplementar
 * a leitura de manifest/git.
 *
 *   BARATO != GRÁTIS — com Git, o caminho comum (árvore limpa, HEAD parado)
 *   custa só um `git status`. Qualquer sinal de mudança (HEAD andou ou
 *   sujeira fora de `.nexos/`) devolve `stale: true` SEM escanear —
 *   `refreshMapIfStale` é quem decide se vale escanear de verdade, via
 *   `refreshProjectMapIncremental`/`writeFreshProjectMap` (que aí sim
 *   comparam fingerprint antes de escrever qualquer byte — A15). Sem Git, o
 *   único jeito de saber é reler e hashear o escopo inteiro — só faz isso
 *   quando `files_examined` do último mapa está dentro de `maxFiles`;
 *   acima disso devolve `reason: "unknown"` (nunca finge saber).
 *
 * Não importa nada de `project-map.ts` para não criar ciclo (`project-map.ts`
 * já faz sua PRÓPRIA checagem de sujeira, independente desta — ver
 * `hasUncommittedChangesOutsideNexos` lá). `refreshMapIfStale` é quem liga
 * as duas pontas.
 */
import { readFile, writeFile } from "node:fs/promises";
import { forProject } from "../capsule/paths.js";
import { systemGitRunner } from "../capsule/git-boundary.js";
import { resolveProject } from "../project-resolver.js";
import { computeLifecycleGitFacts, type ProjectLifecycleGitFacts } from "../capsule/project-lifecycle.js";
import { updateManifestLastMappedCommit } from "../capsule/initializer.js";
import { computeScopeFingerprint, gitStatusPorcelainOutsideNexos } from "./map-scan.js";
import { writeFreshProjectMap, refreshProjectMapIncremental, readExistingMap } from "./project-map.js";

const DEFAULT_NO_GIT_MAX_FILES = 1500;

/**
 * V5 (a) — artefatos que só `nexos init`/`finishInit` escreve FORA de
 * `.nexos/` (CLAUDE.md, `.gitignore`, `.claude/settings.json`). Mudar só
 * estes arquivos nunca move um fato do Project Map (rotas/schema/grafo) —
 * contar como sinal de "HEAD andou"/"sujeira" força uma confirmação por
 * fingerprint (escaneia o repo inteiro) sem necessidade nenhuma toda vez que
 * o bootstrap grava esses arquivos. Lista curta e literal — cresce só se
 * `finishInit` passar a escrever outra coisa fora de `.nexos/`.
 */
const NEXOS_BOOTSTRAP_ONLY_PATHS = new Set(["CLAUDE.md", ".gitignore", ".claude/settings.json"]);

function isMapRelevant(relPath: string): boolean {
  return !relPath.startsWith(".nexos/") && !NEXOS_BOOTSTRAP_ONLY_PATHS.has(relPath);
}

export type MapFreshnessReason = "no_map" | "head_moved" | "uncommitted_changes" | "fingerprint_changed" | "unknown" | "fresh";

export interface MapFreshness {
  readonly stale: boolean;
  readonly reason: MapFreshnessReason;
  /** Best-effort — presente para `head_moved`/`uncommitted_changes`; ausente quando o sinal não tem lista de paths (`fingerprint_changed`, `unknown`, `no_map`). */
  readonly changedFiles?: readonly string[];
  /**
   * `git status --porcelain -uall` fora de `.nexos/`, SEM o filtro adicional
   * de bootstrap-only deste módulo (`isMapRelevant`) — presente só quando o
   * ramo com Git precisou medir sujeira (`head_moved`/`uncommitted_changes`).
   * Plumbing interno para `refreshMapIfStale` repassar a
   * `refreshProjectMapIncremental` (project-map.ts) sem um segundo spawn de
   * `git status` pelo MESMO fato — não é para leitura externa (use
   * `changedFiles`, já filtrado, para exibição).
   */
  readonly rawDirtyFiles?: readonly string[];
}

interface ProjectJsonMetaLite {
  readonly lastMappedCommit?: string;
  readonly sourceFingerprint?: string;
  readonly filesExamined?: number;
}

async function readProjectJsonMetaLite(rootPath: string): Promise<ProjectJsonMetaLite | undefined> {
  try {
    const raw = JSON.parse(await readFile(forProject(rootPath).mapProjectJson(), "utf-8")) as Record<string, unknown>;
    return {
      lastMappedCommit: typeof raw.last_mapped_commit === "string" ? raw.last_mapped_commit : undefined,
      sourceFingerprint: typeof raw.source_fingerprint === "string" ? raw.source_fingerprint : undefined,
      filesExamined: typeof raw.files_examined === "number" ? raw.files_examined : undefined,
    };
  } catch {
    return undefined;
  }
}

async function isGitRepo(rootPath: string): Promise<boolean> {
  const res = await systemGitRunner().run(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.code === 0 && res.stdout.trim() === "true";
}

/**
 * `rawDirty` vem de `gitStatusPorcelainOutsideNexos` (map-scan.ts) — o MESMO
 * spawn que `project-map.ts:refreshProjectMapIncremental` também precisa
 * (nexos://gotcha/map-scan-ts-isgitrepo-rev-parse-is-inside-work-tree-ainda-duplicado-fora-do-trio-lifecycle-freshness-refresh,
 * eixo "status --porcelain -uall 2x"). Este módulo aplica seu PRÓPRIO filtro
 * adicional (`isMapRelevant`, exclui bootstrap-only) por cima do resultado
 * compartilhado — `project-map.ts` não filtra bootstrap-only, então repassar
 * `rawDirty` (não a lista já filtrada aqui) preserva o comportamento dele
 * intacto quando `refreshMapIfStale` reusa o mesmo spawn.
 */
async function uncommittedChangesOutsideNexos(rootPath: string): Promise<{ readonly raw: readonly string[]; readonly mapRelevant: string[] }> {
  const raw = await gitStatusPorcelainOutsideNexos(rootPath);
  return { raw, mapRelevant: raw.filter(isMapRelevant) };
}

/**
 * V5 (b) — quando a confirmação por fingerprint dá igual (nada mudou de
 * verdade, só `last_mapped_commit` ficou para trás), avança SÓ este campo em
 * `.nexos/map/project.json` + `manifest.yaml` — nunca reescreve fatos,
 * `generated_at` ou os demais artefatos do map (isso é trabalho de
 * `refreshProjectMapIncremental`). Sem isto, o mesmo sinal de "HEAD andou"
 * nunca converge e toda sessão seguinte repete a confirmação cara. Escreve
 * só quando o valor muda (A15 — nunca um diff artificial).
 */
async function convergeLastMappedCommit(rootPath: string, commit: string): Promise<void> {
  const p = forProject(rootPath);
  let raw: string;
  try {
    raw = await readFile(p.mapProjectJson(), "utf-8");
  } catch {
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.last_mapped_commit === commit) return;
  parsed.last_mapped_commit = commit;
  await writeFile(p.mapProjectJson(), `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  await updateManifestLastMappedCommit(rootPath, commit);
}

/**
 * A13. Nunca lança — pior caso devolve `{stale: false, reason: "unknown"}`
 * (nunca finge saber que está fresco quando não conseguiu medir, mas também
 * nunca força um refresh caro por um sinal que falhou em coletar).
 *
 * `opts.gitFacts` (nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver)
 * — o MESMO `computeLifecycleGitFacts` que `classifyProjectLifecycleForResolution`
 * já calculou para a MESMA fronteira, repassado pelo chamador
 * (`resolveMapSummary`) em vez de recalculado aqui. `headCommit` presente já
 * PROVA que `rootPath` está dentro de uma árvore git (só `rev-parse HEAD`
 * bem-sucedido devolve isso) — dispensa o `isGitRepo` próprio que seguia
 * abaixo. Sem o fato pronto (`undefined`, ou presente mas sem `headCommit` —
 * `lastMappedCommit` ausente do manifest nunca chegou a rodar `rev-parse`),
 * cai no caminho de sempre: mede aqui mesmo, comportamento intacto.
 */
export async function checkMapFreshness(
  rootPath: string,
  opts: {
    readonly maxFiles?: number;
    readonly gitFacts?: ProjectLifecycleGitFacts;
    /**
     * `nexos doctor --project` (G1, verifier DEFEITO 1) — falso-alarme de
     * staleness (git acusa, fingerprint bate) convergia `last_mapped_commit`
     * em disco mesmo num chamador que promete SOMENTE LEITURA: `.nexos/
     * map/project.json` e `manifest.yaml` mudavam sob um comando de
     * diagnóstico, violando "só APPLY escreve" (decisão do dono). `true`
     * por padrão — SessionStart (`host/claude/session-start.ts`) é quem tem
     * orçamento e mandato para persistir essa convergência barata; nenhum
     * chamador existente muda de comportamento. `false` é opt-in explícito
     * de quem promete leitura pura.
     */
    readonly converge?: boolean;
  } = {}
): Promise<MapFreshness> {
  const converge = opts.converge ?? true;
  const meta = await readProjectJsonMetaLite(rootPath);
  if (!meta) return { stale: true, reason: "no_map" };

  const resolution = await resolveProject({ cwd: rootPath });
  if (resolution.identitySource !== "manifest") return { stale: true, reason: "no_map" };

  const knownGitRepo = opts.gitFacts?.headCommit !== undefined;
  if (knownGitRepo || (await isGitRepo(rootPath))) {
    const gitFacts = opts.gitFacts ?? (await computeLifecycleGitFacts(resolution));
    // Commitar só `.nexos/**` ou artefatos de bootstrap (CLAUDE.md/.gitignore/.claude/settings.json) não move nenhum fato do map — não conta pra "HEAD andou" (V5a).
    const changedOutsideNexos = (gitFacts.changedSinceLastMapped ?? []).filter(isMapRelevant);
    const headMoved = Boolean(gitFacts.headCommit && meta.lastMappedCommit && gitFacts.headCommit !== meta.lastMappedCommit && changedOutsideNexos.length > 0);
    const dirtyResult = await uncommittedChangesOutsideNexos(rootPath);
    const dirty = dirtyResult.mapRelevant;

    if (!headMoved && dirty.length === 0) {
      return { stale: false, reason: "fresh" };
    }

    /**
     * Sinal de sujeira não é prova de mudança REAL — um arquivo sem commit
     * que um `refreshMapIfStale` anterior já capturou continua aparecendo no
     * `git status` para sempre (ninguém commitou), e sem esta confirmação
     * `checkMapFreshness` nunca convergiria para "fresh" de novo. Confirma
     * por fingerprint (mesmo escopo que o scan real usa) antes de acusar —
     * mas só até `maxFiles`: em repositório grande, confirmar por conteúdo
     * TODA vez que git acusa sujeira deixaria de ser barato. Acima do
     * limite, aceita o sinal do git como está (mais falso `stale`
     * ocasional é preferível a um scan caro em todo SessionStart).
     */
    const maxFilesForConfirm = opts.maxFiles ?? DEFAULT_NO_GIT_MAX_FILES;
    const current = await computeScopeFingerprint(rootPath, maxFilesForConfirm, true);
    if (current && meta.sourceFingerprint !== undefined && current.fingerprint === meta.sourceFingerprint) {
      // V5b — confirmado que nada mudou: converge `last_mapped_commit` para o
      // caminho rápido (git-only) resolver "fresh" sem confirmar de novo.
      // `converge === false`: chamador prometeu leitura pura — nenhuma
      // escrita, mesmo neste ramo de convergência (G1 DEFEITO 1).
      if (converge && gitFacts.headCommit && gitFacts.headCommit !== meta.lastMappedCommit) {
        await convergeLastMappedCommit(rootPath, gitFacts.headCommit);
      }
      return { stale: false, reason: "fresh" };
    }
    /**
     * `dirty` primeiro: é o sinal mais específico/acionável. `headMoved` sozinho
     * pode ficar "pendurado" (sempre verdadeiro) quando um refresh anterior viu
     * fingerprint igual e não teve motivo pra avançar `last_mapped_commit` — a
     * PRÓXIMA mudança real ainda é corretamente detectada (o fingerprint muda),
     * só o rótulo prioriza a causa mais provável.
     */
    if (dirty.length > 0) return { stale: true, reason: "uncommitted_changes", changedFiles: dirty, rawDirtyFiles: dirtyResult.raw };
    return { stale: true, reason: "head_moved", changedFiles: changedOutsideNexos, rawDirtyFiles: dirtyResult.raw };
  }

  const maxFiles = opts.maxFiles ?? DEFAULT_NO_GIT_MAX_FILES;
  if (meta.filesExamined !== undefined && meta.filesExamined > maxFiles) {
    return { stale: false, reason: "unknown" };
  }
  const current = await computeScopeFingerprint(rootPath, maxFiles);
  if (!current) return { stale: false, reason: "unknown" };
  if (meta.sourceFingerprint === undefined || current.fingerprint !== meta.sourceFingerprint) {
    return { stale: true, reason: "fingerprint_changed" };
  }
  return { stale: false, reason: "fresh" };
}

export interface RefreshIfStaleResult {
  readonly refreshed: boolean;
  readonly freshness: MapFreshness;
}

/**
 * A13. Só escreve quando `checkMapFreshness` acusa `stale` — e mesmo aí, a
 * escrita de verdade fica a cargo de `refreshProjectMapIncremental`/
 * `writeFreshProjectMap`, que comparam fingerprint ANTES de tocar disco
 * (A15 — dois refresh seguidos sem mudança real não geram diff).
 *
 * V5c — `opts.freshness` deixa o chamador reusar um `checkMapFreshness` que
 * já rodou (ex.: `resolveMapSummary`), em vez de pagar a checagem (que pode
 * incluir a confirmação por fingerprint) DUAS vezes na mesma requisição.
 * Sem o param, o comportamento é idêntico ao de antes (calcula aqui).
 *
 * `opts.gitFacts` — repassado para `checkMapFreshness` (quando esta função
 * ainda precisa calcular `freshness` aqui) E para `refreshProjectMapIncremental`
 * (nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver)
 * — a mesma fatia do fato, nunca um terceiro `computeLifecycleGitFacts`.
 */
export async function refreshMapIfStale(
  rootPath: string,
  opts: { readonly maxFiles?: number; readonly freshness?: MapFreshness; readonly gitFacts?: ProjectLifecycleGitFacts } = {}
): Promise<RefreshIfStaleResult> {
  const freshness = opts.freshness ?? (await checkMapFreshness(rootPath, opts));
  if (!freshness.stale) return { refreshed: false, freshness };

  const hadPreviousMap = (await readExistingMap(rootPath)) !== undefined;
  if (hadPreviousMap) await refreshProjectMapIncremental(rootPath, opts.gitFacts, freshness.rawDirtyFiles);
  else await writeFreshProjectMap(rootPath);

  return { refreshed: true, freshness };
}
