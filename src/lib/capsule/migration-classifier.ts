/**
 * C12.4 — fronteira de compatibilidade do Migration Plane.
 *
 * O modo NORMAL da Capsule continua ESTRITO: `initializeCapsule` recusa árvore
 * legada e isso **não é bug** — é `CREATE != RECONCILE` aplicado corretamente.
 * Este módulo não afrouxa aquele caminho; abre um segundo, explícito, que
 * responde outra pergunta:
 *
 * ```
 * initializeCapsule   "esta árvore JÁ É uma Capsule canônica válida?"
 * este módulo         "esta árvore PODE SER RECONCILIADA?"
 *
 *   RECONCILABLE != CANONICAL
 *   CANONICAL_ALLOWED != LEGACY_TOLERATED
 * ```
 *
 * A tolerância é por CONJUNTO EXATO, nunca por prefixo ou glob. Diretório
 * desconhecido continua derrubando o preflight — `UNKNOWN != LEGACY_TOLERATED`.
 * Sem isso, "modo migração" viraria um modo permissivo, e o FAIL CLOSED que já
 * provou valor (recusou promover o `.nexos` real por cima) perderia o sentido.
 */

import fs from "fs-extra";
import path from "node:path";
import { ConcurrentInitializationError } from "./initializer.js";
import { CANONICAL_ENTRIES, LOCAL_ENTRIES } from "./entries.js";
import type { GitRunner } from "./git-boundary.js";

export type RootEntryClass =
  /** Estrutura da Capsule canônica. */
  | "CANONICAL_ALLOWED"
  /** Legado conhecido, nomeado um a um. Reconciliável, e NUNCA portável por isso. */
  | "LEGACY_TOLERATED"
  /** Área local declarada. */
  | "LOCAL_ALLOWED"
  /** Qualquer outra coisa. Derruba o preflight. */
  | "CONFLICTING_EXISTING";

/**
 * CONJUNTO EXATO, medido na árvore real em 14/08. Cada entrada tem classe
 * semântica própria — ver `LEGACY_SEMANTICS`. Acrescentar nome aqui é decisão
 * explícita, não conveniência de quem topou com um diretório novo.
 */
export const LEGACY_TOLERATED_ENTRIES: ReadonlySet<string> = new Set(["memory", "logs", "dev-scripts"]);

/** O que cada legado tolerado É — e o que ele explicitamente NÃO é. */
export const LEGACY_SEMANTICS: Readonly<
  Record<string, { class: string; canonical: false; portable: false; note: string; removalCandidate: boolean }>
> = {
  memory: {
    class: "LEGACY KNOWLEDGE SOURCE",
    canonical: false,
    portable: false,
    note: "lido pelo Migration Plane; fornece candidatos a record. Não recebe escrita nova depois do cutover de writers.",
    removalCandidate: true,
  },
  logs: {
    class: "LEGACY LOCAL RUNTIME / EVIDENCE",
    canonical: false,
    portable: false,
    note: "EVIDENCE != TRUTH — log não vira verdade por existir. Não migra automaticamente.",
    removalCandidate: true,
  },
  "dev-scripts": {
    class: "LEGACY LOCAL DEVELOPMENT ARTIFACT",
    canonical: false,
    portable: false,
    note: "ferramenta, não conhecimento. Intocado no primeiro ciclo; destino final só com consumer real.",
    /**
     * P1.2 — o ÚNICO legado tolerado que o plano de MIGRATE_REPAIR NÃO lista
     * para remoção: a própria nota acima já diz "intocado no primeiro
     * ciclo". `removalCandidate` deriva dessa semântica já existente, não é
     * um segundo julgamento.
     */
    removalCandidate: false,
  },
};

/**
 * P1.2 (nexos://decision/p1-2-project-lifecycle) — subconjunto de
 * `names` (tipicamente `ReconciliationPreflight.legacyTolerated`) cuja
 * semântica já documentada acima marca como seguro sugerir para remoção num
 * plano de MIGRATE_REPAIR. `dev-scripts` nunca aparece aqui.
 */
export function removableLegacyEntries(names: readonly string[]): string[] {
  return names.filter((name) => LEGACY_SEMANTICS[name]?.removalCandidate === true);
}

export interface ClassifiedEntry {
  name: string;
  class: RootEntryClass;
}

export interface ReconciliationPreflight {
  /** Verdadeiro só quando NENHUMA entrada é CONFLICTING_EXISTING. */
  reconcilable: boolean;
  entries: ClassifiedEntry[];
  conflicting: string[];
  legacyTolerated: string[];
  /** `true` quando já existe estrutura canônica — reconciliação incremental. */
  hasCanonical: boolean;
}

export function classifyRootEntry(name: string): RootEntryClass {
  if (CANONICAL_ENTRIES.has(name)) return "CANONICAL_ALLOWED";
  if (LOCAL_ENTRIES.has(name)) return "LOCAL_ALLOWED";
  if (LEGACY_TOLERATED_ENTRIES.has(name)) return "LEGACY_TOLERATED";
  return "CONFLICTING_EXISTING";
}

/**
 * Preflight de reconciliação sobre `<root>/.nexos`. Só LÊ — nenhuma escrita,
 * nenhum diretório criado, nenhum dado movido.
 */
export async function classifyForReconciliation(rootPath: string): Promise<ReconciliationPreflight> {
  const capsuleDir = path.join(rootPath, ".nexos");
  if (!(await fs.pathExists(capsuleDir))) {
    return { reconcilable: false, entries: [], conflicting: [], legacyTolerated: [], hasCanonical: false };
  }

  const names = (await fs.readdir(capsuleDir)).sort();
  const entries: ClassifiedEntry[] = names.map((name) => ({
    name,
    class: classifyRootEntry(name),
  }));

  const conflicting = entries.filter((e) => e.class === "CONFLICTING_EXISTING").map((e) => e.name);

  return {
    reconcilable: conflicting.length === 0,
    entries,
    conflicting,
    legacyTolerated: entries.filter((e) => e.class === "LEGACY_TOLERATED").map((e) => e.name),
    /**
     * `manifest.yaml` especificamente — não "qualquer CANONICAL_ALLOWED".
     *
     *     COMMIT POINT PRESENT != SKELETON DIR PRESENT
     *
     * `records` e `.gitignore` também são CANONICAL_ALLOWED, e
     * `initializeForReconciliation` os cria ANTES do commit point (o manifest,
     * via `wx`). Um `kill -9` entre a criação de `records/` e a escrita do
     * manifest deixava `hasCanonical` true sem nenhum manifest em disco — o
     * híbrido silencioso que CF-R4 proíbe: um consumidor (`nexos state`,
     * `nexos gotcha`, o inspetor de estado) lia `hasCanonical` como "já é
     * canônico" e tentava `readFile(manifest())` sobre um arquivo que não
     * existe. Exigir o nome exato é o mesmo padrão que `classifyCapsule` já
     * usa (`!exists(p.manifest()) -> CONFLICTING_EXISTING`, initializer.ts:70).
     */
    hasCanonical: entries.some((e) => e.name === "manifest.yaml" && e.class === "CANONICAL_ALLOWED"),
  };
}

/**
 * Cria a estrutura canônica numa árvore RECONCILIÁVEL, sem tocar no legado.
 *
 * Caminho separado de `initializeCapsule` de propósito: aquele responde "esta
 * árvore já é canônica?" e recusa legado — comportamento correto, preservado.
 * Este responde "posso instalar o canônico AO LADO do legado tolerado?".
 *
 *   CREATE != RECONCILE
 *
 * Diferenças que importam em relação ao caminho normal:
 *   · exige preflight reconciliável — `CONFLICTING_EXISTING` aborta antes de escrever
 *   · o rollback remove SÓ o que esta chamada criou. `.nexos` já existia e contém
 *     legado: apagá-lo por causa de uma falha aqui destruiria a fonte que o
 *     contrato manda preservar.  ROLLBACK MINE != DELETE THEIRS
 */
export async function initializeForReconciliation(
  rootPath: string,
  options: { projectName: string; generateProjectId?: () => string }
): Promise<{ created: boolean; projectId: string; manifestPath: string; preserved: string[] }> {
  const pre = await classifyForReconciliation(rootPath);
  if (!pre.reconcilable) {
    throw new Error(
      `[reconciliation] FAIL CLOSED — entradas não classificadas em .nexos: ${pre.conflicting.join(", ")}. ` +
        `UNKNOWN != LEGACY_TOLERATED. Nada foi tocado.`
    );
  }

  const { forProject } = await import("./paths.js");
  const { newProjectId } = await import("./ids.js");
  const { validateManifest } = await import("./schemas.js");
  const { serializeCanonical } = await import("./codec.js");
  const { boundaryKindOf, computeBinding } = await import("../project-resolver.js");
  const { systemGitRunner } = await import("./git-boundary.js");

  const p = forProject(rootPath);

  if (await fs.pathExists(p.manifest())) {
    const existente = await fs.readFile(p.manifest(), "utf8");
    const id = /id:\s*(\S+)/.exec(existente)?.[1] ?? "";
    return { created: false, projectId: id, manifestPath: p.manifest(), preserved: pre.legacyTolerated };
  }

  // P1.1 — mesma disciplina de `initializer.ts`: todo manifest NOVO grava binding.
  const kind = await boundaryKindOf(rootPath);
  const binding = await computeBinding(rootPath, kind);
  /**
   * P1.2 — best-effort: `undefined` sem `.git` (`kind !== "git"`) ou sem HEAD
   * (repo git órfão). REFRESH lê "sem last_mapped_commit" como "nunca
   * mapeado", nunca erro — mesma disciplina de `binding`/`computeBinding`.
   */
  const lastMappedCommit = kind === "git" ? await readHeadCommitBestEffort(rootPath, systemGitRunner()) : undefined;

  const candidate = {
    schema_version: 1 as const,
    project: { id: (options.generateProjectId ?? newProjectId)(), name: options.projectName },
    capsule: { format_version: 1 as const },
    ...(lastMappedCommit !== undefined ? { last_mapped_commit: lastMappedCommit } : {}),
    binding,
  };
  const validado = validateManifest(candidate);
  if (!validado.ok) throw new Error(`[reconciliation] manifest inválido: ${validado.errors.join("; ")}`);

  // Só o que ESTA chamada cria entra na lista de desfazer.
  const criados: string[] = [];
  try {
    for (const dir of [p.recordsRoot(), path.join(p.capsuleDir(), ".local")]) {
      if (!(await fs.pathExists(dir))) {
        await fs.ensureDir(dir);
        criados.push(dir);
      }
    }
    if (!(await fs.pathExists(p.capsuleGitignore()))) {
      await fs.writeFile(p.capsuleGitignore(), ".local/\n", "utf8");
      criados.push(p.capsuleGitignore());
    }
    // commit point exclusivo — mesma semântica do caminho normal
    try {
      await fs.writeFile(p.manifest(), serializeCanonical(validado.value), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConcurrentInitializationError(
          `[reconciliation] outro inicializador publicou o manifest primeiro em ` +
            `${p.manifest()}. Esta chamada perdeu a corrida e NÃO tocou no Store vencedor.`
        );
      }
      throw error;
    }
  } catch (error) {
    /**
     *     ROLLBACK MINE != DELETE THEIRS  (mesmo princípio, agora sob corrida)
     *
     * Perder a corrida pelo commit point não é diferente de perder a corrida
     * pelo `.nexos` ausente (`initializer.ts`): a capsule em disco pertence ao
     * vencedor, que pode ter terminado de escrever `records/`/`.local/` entre
     * o nosso `pathExists` e o `wx` falhar. Rollback incondicional aqui apaga
     * o que o vencedor acabou de commitar — espelha o tratamento de
     * `ConcurrentInitializationError` em `initializer.ts:226`.
     */
    if (!(error instanceof ConcurrentInitializationError)) {
      for (const c of criados.reverse()) await fs.remove(c).catch(() => {});
    }
    throw error;
  }

  return {
    created: true,
    projectId: candidate.project.id,
    manifestPath: p.manifest(),
    preserved: pre.legacyTolerated,
  };
}

/**
 * P1.2 — `git rev-parse HEAD` best-effort, mesma disciplina de
 * `readGitRootCommit`/`readGitRemote` (`project-resolver.ts`): repo git sem
 * commit, `git` ausente do PATH, ou qualquer falha inesperada degrada para
 * `undefined` — nunca impede a criação do manifest.
 */
async function readHeadCommitBestEffort(rootPath: string, runner: GitRunner): Promise<string | undefined> {
  const result = await runner.run(["-C", rootPath, "rev-parse", "HEAD"]);
  return result.ok && result.code === 0 ? result.stdout.trim() || undefined : undefined;
}
