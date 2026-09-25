/**
 * P1.2 — Project Lifecycle (nexos://decision/p1-2-project-lifecycle).
 *
 *   CLASSIFY != EXECUTE
 *   REPORT != REPAIR
 *
 * Uma função pura, `classifyProjectLifecycle`, que olha para o que já existe
 * (a fronteira do P1.1, `classifyCapsule` do initializer, `classifyForReconciliation`
 * do migration-classifier) e devolve UMA situação e UM procedimento — nunca
 * executa nada. `BOOTSTRAP` e `MIGRATE_REPAIR` são nomes de procedimento, não
 * chamadas: quem os IMPLEMENTA é P1.3. Este módulo é só a camada de
 * classificação + relato, um nível acima do que `project-state-inspector.ts`
 * já decide (`ProjectNexOSState`) — reusa as MESMAS primitivas, nunca
 * reimplementa `.nexos` do zero.
 *
 * `BINDING_MISMATCH` NUNCA vira reparo automático aqui: cai em
 * `LEGACY_DEGRADED` com `plan.humanDecisionRequired` — "adotar este diretório
 * ou apontar o certo" é escolha humana, nunca dedução.
 */
import { readFile } from "node:fs/promises";
import {
  resolveProject,
  InvalidManifestError,
  detectLinkedWorktreeMainIdentity,
  immediateGitChildren,
  type ProjectResolution,
} from "../project-resolver.js";
import { classifyCapsule, type CapsuleState } from "./initializer.js";
import { classifyForReconciliation, removableLegacyEntries } from "./migration-classifier.js";
import { listKnownFamilyYamlFiles } from "./reader.js";
import { parseCanonical } from "./codec.js";
import { validateManifest } from "./schemas.js";
import { systemGitRunner, type GitRunner } from "./git-boundary.js";

export type ProjectLifecycleSituation = "NO_PROJECT" | "NEW" | "LEGACY_DEGRADED" | "HEALTHY";
export type ProjectLifecycleProcedure = "NONE" | "BOOTSTRAP" | "MIGRATE_REPAIR" | "REFRESH";

export interface LifecyclePlan {
  /** LEGACY_DEGRADED — o que MIGRATE_REPAIR (P1.3) precisa preservar. */
  readonly preserve?: readonly string[];
  /** LEGACY_DEGRADED — o que MIGRATE_REPAIR (P1.3) precisa reconstruir. */
  readonly rebuild?: readonly string[];
  /**
   * LEGACY_DEGRADED — candidatos a MIGRATE_REPAIR (`removableLegacyEntries` +
   * famílias fora do schema). Chamava-se `remove` — `repair.ts:planRepair`
   * (pós-670-arquivos, nexos://gotcha/nexos-init-repair-apagaria-670-arquivos-nos-projetos-do-dono-403-fora-do-git-alem-de-memory-remove-logs-e-familias-fora-do-schema-sem-arquivar)
   * hoje ARQUIVA (cópia com hash verificado em `.nexos/.local/legacy-archive/`
   * antes de sair do lugar) TUDO que aparece aqui — `logs`/`memory`/famílias
   * fora do schema viram `kind: "archive_path"`, nunca `"remove_path"` (esse
   * kind é só para `RETIRED_ENTRY_NAMES`, que nem passa por este campo).
   * `DECLARED "remove" != WHAT REPAIR ACTUALLY DOES` — o nome antigo mentia
   * por estrutura, mesmo com o preview textual (`formatLifecycleLine`) já
   * certo desde P1.3i/B7.
   */
  readonly archive?: readonly string[];
  /** LEGACY_DEGRADED por BINDING_MISMATCH — nunca reparado sozinho. */
  readonly humanDecisionRequired?: string;
  /** HEALTHY/REFRESH — `git diff --name-only` desde `last_mapped_commit`. */
  readonly changedFiles?: readonly string[];
  /** HEALTHY/REFRESH — o `last_mapped_commit` usado como base do diff. */
  readonly sinceCommit?: string;
}

export interface ProjectLifecycleResult {
  readonly situation: ProjectLifecycleSituation;
  /** Cada motivo que contribuiu para a situação — uma linha de teste por motivo (DoD). */
  readonly reasons: readonly string[];
  readonly procedure: ProjectLifecycleProcedure;
  readonly plan?: LifecyclePlan;
  /** NO_PROJECT — o diretório observado (B7: mensagem legível cita o path). */
  readonly rootPath?: string;
  /**
   * NO_PROJECT — C11 (fatia C, orquestrador): subdiretórios IMEDIATOS com
   * `.git` próprio (`immediateGitChildren`, `project-resolver.ts`) — a pasta
   * observada é um AGREGADOR (HOME, workspace com vários repos), não uma
   * pasta genuinamente vazia. `undefined`/`[]` — pasta sem nenhum repositório
   * filho — é o único caso em que sugerir `nexos init` faz sentido.
   */
  readonly noProjectSiblings?: readonly string[];
  /** HEALTHY — `.nexos/memory` tolerado presente com identidade já BOUND (B4): nota, nunca degradação. */
  readonly legacyMemoryPreserved?: true;
  /** NEW num worktree git ligado a um checkout principal já inicializado com o MESMO histórico (B2). */
  readonly linkedWorktreeMain?: {
    readonly mainCheckoutPath: string;
    readonly mainProjectId: string;
  };
}

/**
 * O que `classifyCapsule` + `classifyForReconciliation` + a varredura de
 * `records/` já sabem sobre `.nexos` — composto por `inspectCapsuleForLifecycle`
 * (I/O), consumido puro por `classifyProjectLifecycle`.
 */
export interface CapsuleLifecycleInspection {
  readonly capsuleState: CapsuleState;
  /** `memory`/`logs`/`dev-scripts` presentes na raiz de `.nexos`. */
  readonly legacyTolerated: readonly string[];
  /** Entradas na raiz de `.nexos` que não são canônicas, locais nem legado tolerado. */
  readonly conflicting: readonly string[];
  /** Diretórios em `.nexos/records/` fora de `CANONICAL_FAMILIES` (ex.: `host-observations`). */
  readonly recordFamiliesOutsideSchema: readonly string[];
}

export interface ProjectLifecycleGitFacts {
  readonly lastMappedCommit?: string;
  /** `git diff --name-only <lastMappedCommit> HEAD` — `undefined` quando não há o que comparar. */
  readonly changedSinceLastMapped?: readonly string[];
  /**
   * P1.3 — HEAD atual, JÁ lido por `computeLifecycleGitFacts` para calcular o
   * diff. Exposto para quem precisa AVANÇAR `last_mapped_commit` depois de um
   * refresh incremental de verdade (`project-map.ts`) — evita um segundo
   * `git rev-parse HEAD` pelo MESMO fato.
   */
  readonly headCommit?: string;
}

const DEGRADED_PRESERVE = ["decisions", "gotchas", "knowledge válido", "research", "identidade correta"] as const;
const DEGRADED_REBUILD = ["map", "índices", "cache", "brief", "architecture"] as const;

/**
 * A função pura do contrato. Sem I/O, sem relógio — `resolution` e
 * `capsuleInspection` já são fatos observados; `gitFacts` já é o resultado de
 * um `git diff` que o CHAMADOR rodou (ver `computeLifecycleGitFacts`).
 */
export function classifyProjectLifecycle(
  resolution: ProjectResolution,
  capsuleInspection: CapsuleLifecycleInspection,
  gitFacts: ProjectLifecycleGitFacts = {}
): ProjectLifecycleResult {
  if (resolution.rootSource === "none") {
    return noProjectLifecycle(resolution.rootPath);
  }

  if (capsuleInspection.capsuleState === "ABSENT") {
    return { situation: "NEW", reasons: [".nexos ausente"], procedure: "BOOTSTRAP" };
  }
  if (capsuleInspection.capsuleState === "EMPTY") {
    return { situation: "NEW", reasons: [".nexos existe e está vazio"], procedure: "BOOTSTRAP" };
  }

  const reasons: string[] = [];
  /**
   * C9 (fatia C, orquestrador) — `bindingStatus === "none"` aqui (com
   * `capsuleState` já além de ABSENT/EMPTY, ou seja, HÁ conteúdo em `.nexos`)
   * só acontece quando a fronteira existe (`rootSource !== "none"`, já tratado
   * acima) mas NENHUM `manifest.yaml` foi encontrado nela
   * (`project-resolver.ts`: `manifestAtBoundary === false`) — legado
   * pré-reparo com `.nexos/memory/` e nada mais. A versão anterior nunca
   * reportava isso como motivo: só as entradas legadas toleradas apareciam
   * ("entradas legadas toleradas: memory"), escondendo a causa RAIZ
   * (identidade ausente) atrás do sintoma (pasta tolerada presente). Vai
   * PRIMEIRO na lista — é o motivo principal, os outros são consequência dele.
   */
  if (resolution.bindingStatus === "none") {
    reasons.push(".nexos legado sem manifest.yaml (identidade ausente)");
  }
  if (capsuleInspection.conflicting.length > 0) {
    reasons.push(`entradas não reconhecidas em .nexos: ${capsuleInspection.conflicting.join(", ")}`);
  }
  if (resolution.bindingStatus === "mismatch") {
    reasons.push("binding do manifest diverge do repositório observado agora (BINDING_MISMATCH)");
  }
  if (resolution.bindingStatus === "unbound") {
    reasons.push("manifest v1 sem binding (UNBOUND)");
  }
  /**
   * P1.3 — só entradas legadas REMOVÍVEIS (`removalCandidate`, memory/logs)
   * degradam a situação. `dev-scripts` é tolerado PERMANENTEMENTE (a própria
   * nota em `LEGACY_SEMANTICS` já diz "intocado no primeiro ciclo"; não há
   * ciclo seguinte planejado que o remova) — continuar reportando
   * LEGACY_DEGRADED por causa dele manteria um projeto reparado (MIGRATE_REPAIR
   * já rodou, memory/logs já saíram) preso em degradado para sempre, o que
   * contradiz o próprio contrato de reparo real deste repositório.
   *
   * P1.3i (B4) — `memory/` sozinho, com identidade JÁ BOUND, sai da mesma
   * regra: é legado preservado (referência, `planRepair` já decide remoção por
   * prova de órfãos — `scanMemoryOrphans` — nunca esta classificação), não um
   * motivo de reparo. Sem isto, um `--repair` que preserva `memory/` por ter
   * órfãos ficava preso em LEGACY_DEGRADED PARA SEMPRE: a PRÓPRIA classificação
   * reclassificava `memory/` presente como razão de reparo no segundo
   * `--repair --dry-run`, um laço que nenhum reparo fecha (nenhum órfão nunca
   * ganha record por si só). Identidade AUSENTE/UNBOUND/MISMATCH continua
   * degradando por `memory/` normalmente — ali a Capsule inteira ainda não
   * nasceu, `memory/` é só mais um motivo entre vários para rodar o reparo.
   */
  const removableLegacy = removableLegacyEntries(capsuleInspection.legacyTolerated);
  const boundIdentity = resolution.bindingStatus === "bound";
  const memoryToleratedOnly = boundIdentity && removableLegacy.includes("memory");
  const degradingLegacy = boundIdentity ? removableLegacy.filter((name) => name !== "memory") : removableLegacy;
  if (degradingLegacy.length > 0) {
    reasons.push(`entradas legadas toleradas: ${degradingLegacy.join(", ")}`);
  }
  if (capsuleInspection.recordFamiliesOutsideSchema.length > 0) {
    reasons.push(`famílias de record fora do schema atual: ${capsuleInspection.recordFamiliesOutsideSchema.join(", ")}`);
  }

  if (reasons.length > 0) {
    return degradedLifecycle(reasons, {
      archive: [
        ...removableLegacyEntries(capsuleInspection.legacyTolerated),
        ...capsuleInspection.recordFamiliesOutsideSchema,
      ],
      ...(resolution.bindingStatus === "mismatch"
        ? { humanDecisionRequired: "adotar este diretório ou apontar o certo" }
        : {}),
    });
  }

  return {
    situation: "HEALTHY",
    reasons: [
      "manifest v1 válido",
      "BOUND",
      "estrutura e famílias no schema atual",
      memoryToleratedOnly ? "memory/ preservado como legado (referência, não degrada)" : "sem legado",
    ],
    procedure: "REFRESH",
    ...(memoryToleratedOnly ? { legacyMemoryPreserved: true as const } : {}),
    plan:
      gitFacts.changedSinceLastMapped !== undefined
        ? { changedFiles: gitFacts.changedSinceLastMapped, sinceCommit: gitFacts.lastMappedCommit }
        : undefined,
  };
}

/**
 * `siblings` — C11 (fatia C, orquestrador): OPCIONAL e nunca resolvido AQUI —
 * esta função continua PURA/zero I/O (`nexos boot` depende disso: CF-B4,
 * "NO_PROJECT sai ANTES de qualquer leitura adicional"). Quem tem orçamento
 * para um `readdir` raso (`classifyProjectLifecycleForResolution`, usado pelo
 * SessionStart) resolve e passa aqui; o caminho zero-I/O de `boot.ts`
 * continua chamando sem o segundo argumento, comportamento intacto.
 */
export function noProjectLifecycle(rootPath?: string, siblings?: readonly string[]): ProjectLifecycleResult {
  return {
    situation: "NO_PROJECT",
    reasons: ["sem fronteira de projeto (.git ou marker) até a raiz do filesystem"],
    procedure: "NONE",
    ...(rootPath !== undefined ? { rootPath } : {}),
    ...(siblings !== undefined && siblings.length > 0 ? { noProjectSiblings: siblings } : {}),
  };
}

function degradedLifecycle(
  reasons: readonly string[],
  extra: { archive: readonly string[]; humanDecisionRequired?: string }
): ProjectLifecycleResult {
  return {
    situation: "LEGACY_DEGRADED",
    reasons,
    procedure: "MIGRATE_REPAIR",
    plan: {
      preserve: DEGRADED_PRESERVE,
      rebuild: DEGRADED_REBUILD,
      archive: extra.archive,
      ...(extra.humanDecisionRequired !== undefined ? { humanDecisionRequired: extra.humanDecisionRequired } : {}),
    },
  };
}

// ─── composição (I/O) ───────────────────────────────────────────────────────

/**
 * Monta `CapsuleLifecycleInspection` a partir das primitivas que já existem —
 * nenhuma segunda varredura de `.nexos` reimplementada aqui.
 */
export async function inspectCapsuleForLifecycle(rootPath: string): Promise<CapsuleLifecycleInspection> {
  const [capsule, reconciliation] = await Promise.all([
    classifyCapsule(rootPath),
    classifyForReconciliation(rootPath),
  ]);
  const recordFamiliesOutsideSchema: string[] = [];
  await listKnownFamilyYamlFiles(rootPath, (dirName) => recordFamiliesOutsideSchema.push(dirName));

  return {
    capsuleState: capsule.state,
    legacyTolerated: reconciliation.legacyTolerated,
    conflicting: reconciliation.conflicting,
    recordFamiliesOutsideSchema: recordFamiliesOutsideSchema.sort(),
  };
}

/**
 * `last_mapped_commit` do manifest (se houver) + `git diff --name-only`
 * contra o HEAD atual. Best-effort em toda etapa — REFRESH é reporte, nunca
 * bloqueio: qualquer falha de leitura/`git` degrada para "sem gitFacts",
 * nunca derruba a classificação.
 */
export async function computeLifecycleGitFacts(
  resolution: ProjectResolution,
  runner: GitRunner = systemGitRunner()
): Promise<ProjectLifecycleGitFacts> {
  if (!resolution.manifestPath) return {};
  const lastMappedCommit = await readLastMappedCommit(resolution.manifestPath);
  if (!lastMappedCommit) return {};

  const head = await runner.run(["-C", resolution.realPath, "rev-parse", "HEAD"]);
  const headSha = head.ok && head.code === 0 ? head.stdout.trim() : undefined;
  if (!headSha) return { lastMappedCommit };
  if (headSha === lastMappedCommit) return { lastMappedCommit, changedSinceLastMapped: [], headCommit: headSha };

  const diff = await runner.run(["-C", resolution.realPath, "diff", "--name-only", lastMappedCommit, headSha]);
  if (!diff.ok || diff.code !== 0) return { lastMappedCommit, headCommit: headSha };

  const changed = diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { lastMappedCommit, changedSinceLastMapped: changed, headCommit: headSha };
}

async function readLastMappedCommit(manifestPath: string): Promise<string | undefined> {
  try {
    const parsed = validateManifest(parseCanonical(await readFile(manifestPath, "utf-8")));
    return parsed.ok ? parsed.value.last_mapped_commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Variante que reusa um `ProjectResolution` JÁ resolvido pelo chamador
 * (`SESSIONSTART` — `identity` já existe em `runSessionStartAdapter`) — nunca
 * paga um segundo `resolveProject()` pelo mesmo fato.
 *
 * `precomputedGitFacts` (nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver)
 * — o MESMO `computeLifecycleGitFacts(resolution)` que `checkMapFreshness`/
 * `refreshProjectMapIncremental` também precisam, calculado UMA vez pelo
 * chamador (`runSessionStartAdapter`) e repassado aqui. `undefined` mantém o
 * comportamento de sempre (calcula na hora) — chamadores que não têm o fato
 * em mãos (`commands/map.ts`) continuam funcionando sem mudança.
 */
export async function classifyProjectLifecycleForResolution(
  resolution: ProjectResolution,
  precomputedGitFacts?: ProjectLifecycleGitFacts
): Promise<ProjectLifecycleResult> {
  /**
   * C11 (fatia C, orquestrador) — `immediateGitChildren` (mesmo `readdir`
   * raso e não-recursivo que `bootstrap-context.ts` já paga para
   * `brief.noProjectSiblings`) distingue pasta AGREGADORA (HOME, workspace
   * com vários repos) de pasta genuinamente vazia. Só sugerir `nexos init`
   * no segundo caso — numa agregadora, `init` criaria uma identidade ali
   * mesmo quando o usuário quis abrir um dos repositórios filhos.
   */
  if (resolution.rootSource === "none") {
    return noProjectLifecycle(resolution.rootPath, await immediateGitChildren(resolution.realPath));
  }

  const capsuleInspection = await inspectCapsuleForLifecycle(resolution.realPath);
  const gitFacts = precomputedGitFacts ?? (await computeLifecycleGitFacts(resolution));
  const result = classifyProjectLifecycle(resolution, capsuleInspection, gitFacts);

  /**
   * P1.3i (B2) — I/O de enriquecimento, fora do núcleo puro: um NEW
   * (`.nexos` ausente) num worktree git LINKED cujo checkout principal já tem
   * identidade para o MESMO histórico não deveria sugerir `nexos init` aqui —
   * o comando recusaria (ver `init.ts`). Mesmo padrão de `computeLifecycleGitFacts`:
   * a função pura (`classifyProjectLifecycle`) nunca faz I/O de git; só o
   * wrapper assíncrono enriquece o resultado depois.
   */
  if (result.situation === "NEW") {
    const foreign = await detectLinkedWorktreeMainIdentity(resolution.realPath);
    if (foreign) {
      return {
        ...result,
        procedure: "NONE",
        linkedWorktreeMain: { mainCheckoutPath: foreign.mainCheckoutPath, mainProjectId: foreign.mainProjectId },
      };
    }
  }
  return result;
}

/**
 * Variante autocontida — resolve a partir de `cwd`. Usada por chamadores que
 * ainda não têm uma `ProjectResolution` em mãos (`nexos boot`, `nexos init`).
 * Reproduz o MESMO catch de `InvalidManifestError` que
 * `project-state-inspector.ts` já usa: manifest ilegível/inválido nunca
 * propaga como exceção — vira `LEGACY_DEGRADED` reportado.
 */
export async function classifyProjectLifecycleFor(cwd: string): Promise<ProjectLifecycleResult> {
  let resolution: ProjectResolution;
  try {
    resolution = await resolveProject({ cwd });
  } catch (error) {
    if (!(error instanceof InvalidManifestError)) throw error;
    const capsule = await classifyCapsule(error.rootPath);
    return degradedLifecycle([`manifest inválido: ${capsule.reason}`], { archive: [] });
  }
  return classifyProjectLifecycleForResolution(resolution);
}

// ─── apresentação ───────────────────────────────────────────────────────────

/**
 * P1.3i (B7) — uma linha LEGÍVEL por humano, sem jargão interno de
 * implementação ("locator de bootstrap", listas de procedimento cruas). O
 * formato anterior (`Projeto: LEGACY_DEGRADED → migrate/repair: preservar X;
 * reconstruir Y; ...`) é o texto que a auditoria da jornada mediu como
 * DEFEITO — útil para quem já conhece o código, opaco para quem só quer saber
 * "o que eu faço agora". `nexos init --repair --dry-run` continua sendo a
 * fonte do plano DETALHADO (`plan.actions`, impresso por `init.ts`); esta
 * linha é só o resumo que cabe num brief.
 */
export function formatLifecycleLine(result: ProjectLifecycleResult): string {
  switch (result.situation) {
    case "NO_PROJECT": {
      const dir = result.rootPath ?? "diretório atual";
      /**
       * C11 (fatia C, orquestrador) — pasta AGREGADORA (HOME, workspace com
       * vários repos) nunca sugere `nexos init`: criar identidade ali seria
       * exatamente o defeito medido (pasta que contém `p1/.git` ganhando uma
       * Capsule própria quando o usuário queria abrir `p1`). A sugestão de
       * `init` fica reservada para o caso em que não há NENHUM repositório
       * filho — pasta genuinamente vazia.
       */
      if (result.noProjectSiblings && result.noProjectSiblings.length > 0) {
        return (
          `Sem projeto selecionado: ${dir} sem Git nem manifest. Nada foi criado. ` +
          `Contém repositório(s): ${result.noProjectSiblings.join(", ")} — ` +
          "abra o Claude no projeto desejado ou indique o destino."
        );
      }
      return (
        `Sem projeto selecionado: ${dir} sem Git nem manifest. ` +
        "Nada foi criado. Pasta vazia escolhida explicitamente: `nexos init` cria identidade local sem exigir Git."
      );
    }

    case "NEW":
      if (result.linkedWorktreeMain) {
        return (
          "Projeto sem Project Brain aqui — este é um worktree git ligado ao checkout principal " +
          `${result.linkedWorktreeMain.mainCheckoutPath} (projeto ${result.linkedWorktreeMain.mainProjectId} ` +
          "já inicializado lá, mesmo histórico). `nexos init` aqui seria recusado — rode a partir do checkout principal " +
          "ou compartilhe a identidade dele."
        );
      }
      return "Projeto sem Project Brain (.nexos ausente). Adotar não altera código: `nexos init`.";

    case "LEGACY_DEGRADED": {
      const humano = result.plan?.humanDecisionRequired
        ? ` Decisão humana necessária: ${result.plan.humanDecisionRequired}.`
        : "";
      return (
        `Projeto: legado a reparar — ${result.reasons.join("; ")}.${humano} ` +
        "`nexos init --repair --dry-run` mostra o plano; legado é preservado."
      );
    }

    case "HEALTHY": {
      const note = result.legacyMemoryPreserved
        ? " Legado preservado em .nexos/memory (referência, atualidade não confirmada)."
        : "";
      const plan = result.plan;
      /**
       * C6 (fatia C, orquestrador) — `plan.changedFiles` só cobre commits
       * (`git diff --name-only` entre `last_mapped_commit` e HEAD,
       * `computeLifecycleGitFacts`), nunca o working tree. Uma mudança SEM
       * commit passa por aqui com `changedFiles: []` — "nada mudou" seria uma
       * afirmação falsa quando a árvore está suja, e esta linha não tem como
       * saber disso (fonte diferente: `checkMapFreshness`, `map/freshness.ts`,
       * que o SessionStart já consulta separadamente para a linha de mapa).
       *
       *   AFIRMAÇÃO DE MUDANÇA VEM DE UMA FONTE — NUNCA DUAS DIVERGINDO
       *
       * Em vez de arriscar contradizer aquela fonte, `HEALTHY` some com o
       * "desde X" quando não há NADA para reportar — mesma frase curta do
       * caminho sem `plan` nenhum. Quando HÁ arquivos (commitados) para
       * citar, a linha continua positiva (fato observado, nunca "nada
       * mudou").
       */
      if (!plan?.changedFiles || plan.changedFiles.length === 0) return `Projeto: HEALTHY.${note}`;
      const since = plan.sinceCommit?.slice(0, 7) ?? "?";
      const shown = plan.changedFiles.slice(0, 5);
      const resto = plan.changedFiles.length - shown.length;
      return (
        `Projeto: HEALTHY — ${plan.changedFiles.length} arquivo(s) mudado(s) desde ${since}: ${shown.join(", ")}` +
        `${resto > 0 ? ` (+${resto})` : ""}.${note}`
      );
    }
  }
}
