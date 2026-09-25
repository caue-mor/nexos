/**
 * PROJECT BOOTSTRAP + RECONCILIATION V1 — fatia 1: o inspetor de estado.
 *
 * Composição pura sobre primitivas que já existem — nenhuma máquina de
 * estados nova é inventada aqui:
 *
 *   resolveProject()             quem é o projeto (se algum) — C2.1
 *   classifyCapsule()            `.nexos` é uma Capsule V1 válida?
 *   classifyForReconciliation()  `.nexos` legado é reconciliável? — C12.4
 *   readCurrentRecords()         o Store por trás do manifest é legível? — N1
 *
 * Mora em `src/lib/`, ao lado de `bootstrap-context.ts`: mesmo papel — I/O de
 * composição sobre `project-resolver.ts` + `capsule/*` — sem virar primitiva
 * nova dentro de `capsule/`. `bootstrap-context.ts` compõe para montar um
 * brief; este módulo compõe para responder uma pergunta mais simples e
 * anterior: "em que estado o NexOS está aqui?".
 *
 * Só LÊ. Nenhum diretório é criado, nenhum manifest é escrito, nada é
 * reparado — isso é `initializer.ts` / `migration-classifier.ts`.
 *
 *   INSPECT != INITIALIZE != RECONCILE
 */
import { resolveProject, InvalidManifestError, bootstrapLocator } from "./project-resolver.js";
import type { IdentitySource, ProjectResolution } from "./project-resolver.js";
import { classifyCapsule } from "./capsule/initializer.js";
import type { CapsuleClassification } from "./capsule/initializer.js";
import { classifyForReconciliation } from "./capsule/migration-classifier.js";
import type { ReconciliationPreflight } from "./capsule/migration-classifier.js";
import { readCurrentRecords, type ReadResult } from "./capsule/reader.js";
import { readManifestProjectId } from "./capsule/integrity.js";
import type { IntegrityIssue } from "./capsule/integrity.js";
import { forProject } from "./capsule/paths.js";

export type ProjectNexOSState =
  | "CANONICAL"
  | "ABSENT"
  | "LEGACY_RECONCILABLE"
  | "LEGACY_CONFLICTING"
  | "INVALID"
  | "NO_PROJECT";

export interface ProjectNexOSInspection {
  readonly state: ProjectNexOSState;
  readonly rootPath: string;
  /** `undefined` em `NO_PROJECT` — não há projeto, não há identidade a devolver. */
  readonly projectId: string | undefined;
  readonly identitySource: IdentitySource;
  /** Motivo exato, herdado da primitiva que decidiu — nunca reformulado. */
  readonly reason: string;
  /** Presente e exata SÓ em `LEGACY_CONFLICTING` — a lista de entradas não reconhecidas. */
  readonly conflicting?: string[];
  /**
   * A leitura do Store que ESTE módulo já fez para responder N1 ("o Store por
   * trás do manifest é legível?"), devolvida para quem precisar dela a seguir.
   *
   *   FILTRO POR KIND NÃO É LEITURA PARCIAL
   *
   * `readCurrentRecords` lê todas as famílias e filtra depois, então quem
   * lesse de novo pagaria a leitura inteira outra vez. Medido em `nexos boot`
   * na máquina do dono, carga de 0,38 por núcleo:
   *
   *     inspectProjectNexOSState   3404 ms   (esta leitura está aqui dentro)
   *     storeRead do chamador      2615 ms   (a mesma leitura, de novo)
   *
   * ADITIVO e OPCIONAL: campo novo no retorno, nenhum parâmetro de entrada
   * mudou, nenhum chamador existente precisa fazer nada. `undefined` quando o
   * caminho não chegou a ler (sem projeto, manifest inválido) ou quando a
   * leitura falhou — nesse caso o estado já é `INVALID` e não há o que reusar.
   */
  readonly storeRead?: ReadResult;
  /**
   * `INVALID` cuja causa é "manifest válido, Store não legível" — distinto das
   * outras INVALID (manifest ilegível/ausente) SEM casar string de mensagem.
   * Ver `storeUnreadableInspection`.
   */
  readonly storeUnreadable?: true;
  /** Códigos crus das issues que tornaram o Store ilegível — só com `storeUnreadable`. */
  readonly storeIssues?: readonly string[];
}

/**
 * As DUAS rotas que descobrem "manifest válido, Store não legível" —
 * `canonicalOrInvalid` aqui e `resolveAfterLostRace` em `commands/boot.ts` —
 * montam o INVALID por esta função. Uma definição só: listas e mensagens
 * duplicadas entre módulos já divergiram uma vez neste node
 * (`LEGACY_TOLERATED_ENTRIES` vs `ALLOWED_ENTRIES`).
 *
 * `storeUnreadable` existe porque quem consome precisa distinguir ESTA causa
 * das outras INVALID antes de acusar o Store — `commands/boot.ts` a usa para
 * perguntar primeiro se o culpado é o runtime em execução.
 */
export function storeUnreadableInspection(
  rootPath: string,
  projectId: string,
  issues: readonly IntegrityIssue[]
): ProjectNexOSInspection {
  const codes = issues.map((i) => i.code);
  return {
    state: "INVALID",
    rootPath,
    projectId,
    identitySource: "manifest",
    storeUnreadable: true,
    storeIssues: codes,
    reason: `Store irrecuperável: ${codes.join(", ") || "leitura falhou"}`,
  };
}

export async function inspectProjectNexOSState(cwd?: string): Promise<ProjectNexOSInspection> {
  let resolution: ProjectResolution;
  try {
    resolution = await resolveProject({ cwd });
  } catch (error) {
    if (!(error instanceof InvalidManifestError)) throw error; // erro real (I/O, cwd inexistente) — não é estado de projeto.

    // `classifyCapsule` roda o MESMO parse+validate, sem lançar — a `reason`
    // canônica vem dele, não de uma reformulação da mensagem do throw.
    const capsule = await classifyCapsule(error.rootPath);
    return {
      state: "INVALID",
      rootPath: error.rootPath,
      projectId: bootstrapLocator(error.rootPath),
      identitySource: "bootstrap",
      reason: capsule.reason,
    };
  }

  /**
   * `rootSource === "none"` é EXATAMENTE "sem fronteira" (P1.1,
   * nexos://decision/p1-1-resolver-fronteira-e-binding) — nem `.git`, nem
   * marker, em nenhum ancestral. Sem isso não há root confiável para
   * inspecionar `.nexos`; nada é lido além do que `resolveProject` já leu.
   *
   *   NO_PROJECT != CONTEXTO DE OUTRO PROJETO
   *   PROJECT UNKNOWN -> ZERO PROJECT CONTEXT
   *
   * Não há fallback para `$HOME` nem para "último projeto" nem para `cwd`
   * emprestado (`cwd-fallback` foi removido — P1.1): o `rootPath` devolvido é
   * sempre o `realPath` desta chamada. `projectId` fica `undefined` de
   * propósito — devolver o hash do path aqui daria a algo que o próprio
   * inspetor está dizendo "não é projeto" uma identidade que um consumidor
   * poderia usar como chave. Se um consumidor futuro precisar do locator
   * mesmo sem projeto, ele chama `bootstrapLocator()` diretamente — não é
   * responsabilidade deste inspetor emprestar identidade a um estado que
   * nega ter uma.
   */
  if (resolution.rootSource === "none") {
    return {
      state: "NO_PROJECT",
      rootPath: resolution.realPath,
      projectId: undefined,
      identitySource: resolution.identitySource,
      reason: "sem fronteira de projeto (.git ou marker) entre o cwd e a raiz do filesystem",
    };
  }

  /**
   *     PROJECT_ID OBSERVATION == CAPSULE CLASSIFICATION OBSERVATION
   *
   * `resolution.canonicalProjectId` é o parse do manifest feito em T0, dentro
   * de `resolveProject()` (caminhada de árvore até a raiz) — a partir daqui
   * NUNCA alimenta `projectId` nem `identitySource`. Só dois valores entram
   * no resultado: `resolution.bootstrapLocator` (função pura do path — não
   * lê filesystem de novo, não fica stale) para os estados sem manifest
   * canônico NESTA observação, e a identidade que `observeCapsule` produz a
   * partir da MESMA leitura que decidiu o `state`. Ver `observeCapsule` —
   * núcleo único, compartilhado com `resolveCanonicalNow`, para não repetir
   * a corrida de duas leituras separadas do mesmo disco que causava o TOCTOU
   * de identidade (`projectId(T0) + capsuleState(T1)`, um híbrido que nunca
   * existiu no disco em nenhum instante).
   */
  const observation = await observeCapsule(resolution.realPath);
  const { capsule } = observation;

  if (capsule.state === "ABSENT" || capsule.state === "EMPTY") {
    // `EMPTY` (`.nexos` existe e está vazio) colapsa em `ABSENT`: as duas
    // formas não carregam manifest nem legado, e `initializeCapsule` já as
    // trata de forma equivalente (nenhuma delas é `CONFLICTING_EXISTING`).
    return {
      state: "ABSENT",
      rootPath: resolution.realPath,
      projectId: resolution.bootstrapLocator,
      identitySource: "bootstrap",
      reason: capsule.reason,
    };
  }

  if (observation.canonical) {
    return canonicalOrInvalid(resolution.realPath, observation.canonical);
  }

  if (observation.canonicalParseFailed) {
    /**
     * FAIL CLOSED. A classificação viu manifest tolerável ao lado de legado
     * (`canonicalDespiteLegacy` true na listagem de `classifyForReconciliation`),
     * mas o parse desta MESMA observação não devolveu id — o manifest sumiu
     * ou quebrou na janela entre aquela listagem e a leitura de
     * `readManifestProjectId`. NÃO empresta `resolution.canonicalProjectId`
     * (T0, stale) nem promove `bootstrapLocator` a `CANONICAL` — esse
     * híbrido é exatamente o defeito que este núcleo elimina. Degrada para
     * INVALID com a `reason` da primitiva que falhou, mesma forma do catch
     * de `InvalidManifestError` acima.
     */
    return {
      state: "INVALID",
      rootPath: resolution.realPath,
      projectId: resolution.bootstrapLocator,
      identitySource: "bootstrap",
      reason: observation.canonicalParseFailed.reason,
    };
  }

  // capsule.state === "CONFLICTING_EXISTING" e não elegível a canônico nesta
  // observação — o preflight já feito por `observeCapsule` distingue
  // "tolerável" de "bloqueia".
  const preflight = observation.preflight!;

  if (!preflight.reconcilable) {
    return {
      state: "LEGACY_CONFLICTING",
      rootPath: resolution.realPath,
      projectId: resolution.bootstrapLocator,
      identitySource: "bootstrap",
      reason: capsule.reason,
      conflicting: preflight.conflicting,
    };
  }

  return {
    state: "LEGACY_RECONCILABLE",
    rootPath: resolution.realPath,
    projectId: resolution.bootstrapLocator,
    identitySource: "bootstrap",
    reason: capsule.reason,
  };
}

/**
 * Manifest válido não basta para CANONICAL: `CAPSULE VALID != STORE
 * READABLE`. Um Store cujo head-resolver não consegue completar a leitura
 * (I0 quebrado, listagem que falhou) é a segunda causa de INVALID descrita no
 * contrato do node. Compartilhado pelos dois caminhos que chegam a "manifest
 * validado" — direto (`VALID_TARGET`) e via legado tolerado reconciliável —
 * para não haver duas definições do que faz algo CANONICAL.
 *
 * Recebe `canonical` já resolvido por `observeCapsule` — nunca um `projectId`
 * separado da leitura que classificou. `identitySource` é sempre `"manifest"`
 * aqui: os dois caminhos que chegam com um `canonical` set passaram por um
 * parse real do manifest nesta observação.
 */
async function canonicalOrInvalid(
  rootPath: string,
  canonical: { readonly projectId: string; readonly reason: string }
): Promise<ProjectNexOSInspection> {
  const store = await readCurrentRecords(rootPath);
  if (!store.ok) {
    return storeUnreadableInspection(rootPath, canonical.projectId, store.issues);
  }
  return {
    /** Leitura legível e já paga — segue junto para o chamador não repetir. */
    storeRead: store,
    state: "CANONICAL",
    rootPath,
    projectId: canonical.projectId,
    identitySource: "manifest",
    reason: canonical.reason,
  };
}

/**
 * `hasCanonical && conflicting.length === 0` — a MESMA precedência descrita
 * acima ("A FINA VENCE"), extraída para não ter uma segunda cópia da decisão
 * em `observeCapsule`. Duas definições do mesmo predicado já divergiram
 * uma vez neste node (`LEGACY_TOLERATED_ENTRIES` vs `ALLOWED_ENTRIES`) — não
 * repetir o padrão para o predicado que decide sobre elas.
 */
function canonicalDespiteLegacy(preflight: ReconciliationPreflight): boolean {
  return preflight.hasCanonical && preflight.conflicting.length === 0;
}

interface CapsuleObservation {
  readonly capsule: CapsuleClassification;
  /** Só presente quando `capsule.state === "CONFLICTING_EXISTING"`. */
  readonly preflight?: ReconciliationPreflight;
  /** Identidade extraída de um parse do manifest feito NESTA observação. */
  readonly canonical?: { readonly projectId: string; readonly reason: string };
  /** Classificação apontava canônico, mas o parse desta janela não devolveu id. */
  readonly canonicalParseFailed?: { readonly reason: string };
}

/**
 *   ONE AUTHORITY, ONE READ INSTANT
 *
 * Núcleo único de leitura de `.nexos`, consumido por `inspectProjectNexOSState`
 * e por `resolveCanonicalNow` — as duas primitivas respondem perguntas
 * diferentes sobre a MESMA observação, nunca duas observações separadas do
 * mesmo disco. A solução ingênua (cada uma chamando `classifyCapsule` por si)
 * faz 2-3 varreduras do disco em instantes diferentes e reintroduz o TOCTOU
 * entre elas — exatamente o defeito que este núcleo fecha.
 *
 * `classifyCapsule` roda exatamente uma vez aqui. `classifyForReconciliation`
 * e `readManifestProjectId` só quando `CONFLICTING_EXISTING` os exige — mesma
 * precedência "a fina vence a grosseira" de `canonicalDespiteLegacy`.
 *
 * `canonical.projectId` nunca é uma releitura solta: quando `classifyCapsule`
 * já validou o manifest (`VALID_TARGET`), o id sai do MESMO parse — nenhuma
 * chamada extra. Quando o manifest está tolerado ao lado de legado
 * (`classifyCapsule` nem chegou a parsear — para no primeiro entrada
 * desconhecida), `readManifestProjectId` faz o parse direto do arquivo: uma
 * leitura a mais, mas ainda desta chamada, nunca um valor emprestado de
 * `resolveProject`. Se essa leitura falhar (manifest sumiu ou quebrou entre a
 * listagem do preflight e a abertura do arquivo), `canonicalParseFailed` sai
 * setado em vez de `canonical` — quem chama decide o FAIL CLOSED, este núcleo
 * só nunca fabrica identidade.
 */
async function observeCapsule(rootPath: string): Promise<CapsuleObservation> {
  const capsule = await classifyCapsule(rootPath);

  if (capsule.state === "VALID_TARGET") {
    const manifest = capsule.manifest!;
    /**
     * `manifest.project` é opcional na FORMA (`ManifestSchema`, schemas.ts)
     * exatamente para o root global (`scope: "global"`) poder omiti-lo — T4
     * bootstrap desse root grava `manifest.yaml` sem `project` de propósito.
     * Uma asserção não-nula aqui lançava TypeError em produção: `nexos boot`/
     * `doctor` de um subdiretório do HOME sem marcador de projeto caminha até
     * `~/.nexos/manifest.yaml`, que `classifyCapsule` classifica VALID_TARGET
     * (é um manifest v1 válido) sem que exista `project` para ler `.id`.
     * Reusa `canonicalParseFailed` — mesmo campo que já cobre "classificação
     * apontava canônico, mas esta observação não tem id a devolver" — em vez
     * de um estado novo: o motivo de "sem id" aqui é estrutural (scope global,
     * sem project) em vez de I/O, mas o efeito para quem chama é o mesmo,
     * FAIL CLOSED sem throw.
     */
    if (!manifest.project) {
      return {
        capsule,
        canonicalParseFailed: {
          reason:
            `manifest v1 válido, scope="${manifest.scope}" — sem project, não é um Store ` +
            `de projeto (root global não tem identidade de projeto)`,
        },
      };
    }
    return { capsule, canonical: { projectId: manifest.project.id, reason: capsule.reason } };
  }

  if (capsule.state !== "CONFLICTING_EXISTING") {
    return { capsule }; // ABSENT | EMPTY
  }

  const preflight = await classifyForReconciliation(rootPath);
  if (!canonicalDespiteLegacy(preflight)) {
    return { capsule, preflight };
  }

  const issues: IntegrityIssue[] = [];
  const projectId = await readManifestProjectId(forProject(rootPath).manifest(), issues);
  if (!projectId) {
    return {
      capsule,
      preflight,
      canonicalParseFailed: {
        reason: `manifest ilegível: ${issues.map((i) => i.code).join(", ") || "leitura falhou"}`,
      },
    };
  }
  return {
    capsule,
    preflight,
    canonical: { projectId, reason: "manifest v1 válido, legado tolerado ao lado" },
  };
}

export interface CanonicalNow {
  readonly ok: true;
  readonly projectId: string;
  readonly reason: string;
}

export interface NotCanonicalNow {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Uma autoridade só para "esta árvore é canônica agora, com que projectId" —
 * pensada para releituras a partir de um `rootPath` já conhecido (boot.ts,
 * depois de decidir CANONICAL ou depois de perder uma corrida pelo commit
 * point), sem repetir a caminhada de árvore de `resolveProject()`.
 *
 * Wrapper fino sobre `observeCapsule` — MESMA leitura, MESMA precedência, que
 * `inspectProjectNexOSState` usa para decidir CANONICAL. `dev-scripts/`,
 * `logs/`, `memory/` ao lado de um manifest válido continuam CANONICAL aqui,
 * nunca "não observável" só porque `classifyCapsule` sozinho não conhece
 * legado tolerado.
 */
export async function resolveCanonicalNow(rootPath: string): Promise<CanonicalNow | NotCanonicalNow> {
  const observation = await observeCapsule(rootPath);
  if (observation.canonical) {
    return { ok: true, projectId: observation.canonical.projectId, reason: observation.canonical.reason };
  }
  if (observation.canonicalParseFailed) {
    return { ok: false, reason: observation.canonicalParseFailed.reason };
  }
  return { ok: false, reason: observation.capsule.reason };
}
