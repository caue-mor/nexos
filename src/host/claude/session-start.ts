/**
 * C2.4.4.3 — Claude SessionStart adapter (ADR-059).
 *
 * A ÚNICA peça que conhece vocabulário de Claude. O Builder e a composição
 * permanecem host-neutral:
 *
 *   BUILD BRIEF != DELIVER BRIEF TO CLAUDE
 *   HOST ADAPTER  -> traduz binding do host para input NexOS
 *   PROJECT RESOLVER -> continua autoridade de root/identity
 *
 * ─── a decisão que este arquivo existe para aplicar ────────────────────────
 *
 *   CLAUDE_PROJECT_DIR  =  identidade      (doc: "the project root",
 *                                           "regardless of the working
 *                                            directory when the hook runs")
 *   input.cwd           =  observação      (doc: "Current working directory
 *                                            when the hook is invoked")
 *
 *   HOST PROJECT ROOT != LIVE HOOK CWD
 *   SESSION PROJECT BINDING != INCIDENTAL DIRECTORY CHANGE
 *
 * Um `cd` feito para investigar um arquivo não é declaração de troca de projeto.
 * Resolver a partir de `input.cwd` recolocaria o defeito L2 — medido ao vivo na
 * 4.4.1, quando um `cd ~/.claude` fez o boot legado trocar o projeto da sessão
 * para `$HOME`.
 *
 *   MISSING HOST PROJECT BINDING != FALL BACK TO LIVE CWD
 *
 * Sem `CLAUDE_PROJECT_DIR` o adapter FALHA. Cair no `cwd` seria reintroduzir o
 * L2 pela porta dos fundos, em silêncio.
 *
 * NÃO lê, para montar CONHECIMENTO do brief: CLAUDE.md · MEMORY.md ·
 * state.md · gotchas.md · settings.json · settings.local.json · .mcp.json ·
 * skills · agents. Não conhece P1..P4.
 *
 * Corte presence/capability/observations
 * (nexos://decision/p0-corte-presence-capability-observations): o loader de
 * `host/surface-resolver.js` (drift de wiring, warnings `HOST_SURFACE_*` — ambos removidos em `0c0dc91e`), a
 * observação `session.started`/`session.ended` (`HostObservation`), o aviso
 * de autonomous mode (`gate-health.js`/`autonomous-mode-projection.js`) e o
 * disparo do cache warmer detached (`cache-warmer.ts`) saíram todos deste
 * adapter — cada um dependia de um módulo removido no mesmo corte. O que
 * resta: identidade (`CLAUDE_PROJECT_DIR`), o brief de conhecimento, e as
 * leituras de apresentação (checkpoint, evidência, nome do projeto).
 */
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildSessionBriefForCwd,
  withDeadline,
  BOOT_KNOWLEDGE_FAMILIES,
  KNOWLEDGE_DEADLINE_MS,
  type KnowledgeContextLoader,
} from "../../lib/bootstrap-context.js";
import { assembleContext } from "../../lib/context-assembler.js";
import {
  currentProjectStateHead,
  presentationCacheFile,
  writePresentedId,
} from "../../lib/host/state-presentation.js";
import { resolveProject, type ProjectResolution } from "../../lib/project-resolver.js";
import {
  classifyProjectLifecycleForResolution,
  computeLifecycleGitFacts,
  formatLifecycleLine,
  type ProjectLifecycleGitFacts,
} from "../../lib/capsule/project-lifecycle.js";
import { extractDecisionTitles } from "../../lib/capsule/repair.js";
import { readCurrentRecords, contentOf, type CurrentRecord, type Anomaly } from "../../lib/capsule/reader.js";
import {
  readManifestProjectName,
  listYaml,
  type IntegrityIssue,
} from "../../lib/capsule/integrity.js";
import { forProject } from "../../lib/capsule/paths.js";
import type { RecordFamily } from "../../lib/capsule/ids.js";
import type { CapsuleRecord } from "../../lib/capsule/schemas.js";
import { resolveNamedEvidence, type NamedEvidenceStatus } from "../../lib/evidence.js";
import { resolveCheckpointPresentation } from "../../lib/capsule/checkpoint.js";
import {
  writeSessionStarted,
  findPreviousSession,
  formatPreviousSessionLine,
} from "../../lib/capsule/session-events.js";
import { resolveReadRoot } from "../../lib/capsule/authority.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty, type IntegrityCache } from "../../lib/capsule/integrity-cache.js";
import { describeAgentProjection } from "../../lib/host/agent-projection-report.js";
import { detectStaleRuntime, formatStaleRuntimeWarning } from "../../lib/host/stale-runtime.js";
import { detectAssetDrift, formatAssetDriftWarning } from "../../lib/host/asset-drift.js";
import { loadEvidenceCache, saveEvidenceCacheIfDirty, type EvidenceCache } from "../../lib/evidence-cache.js";
import type { SessionBrief, BriefWarning } from "../../lib/session-brief.js";
import {
  readMapSummary,
  summarizeFieldsToOneLiner,
  truncateOneLiner,
  type MapSummary,
} from "../../lib/map/hot-brief.js";
import { checkMapFreshness, refreshMapIfStale, type MapFreshness } from "../../lib/map/freshness.js";
import { shownMarkerFile } from "./memory-recall.js";

/**
 * Mesmo escape hatch de `parseHostSurfaceDeadlineMs`, mesma razão (03b): a
 * sonda real (`assembleContext` sobre `BOOT_KNOWLEDGE_FAMILIES`) mede
 * 1,3-1,5s ISOLADA neste repositório (1035 `knowledge` + 81 `decisions`) e
 * infla sob contenção da suíte inteira rodando em paralelo — o MESMO efeito
 * que A12 já documentou para a sonda de superfície do host. `process.env`
 * real nunca tem isto setado: o hook em produção continua no teto padrão de
 * `KNOWLEDGE_DEADLINE_MS`.
 */
function parseKnowledgeDeadlineMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.NEXOS_KNOWLEDGE_DEADLINE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Fontes de SessionStart. `fork` existe a partir do Claude Code 2.1.214. */
export const SESSION_START_SOURCES = [
  "startup",
  "resume",
  "clear",
  "compact",
  "fork",
] as const;

export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

export class SessionStartAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStartAdapterError";
  }
}

export interface SessionStartInput {
  readonly hook_event_name?: unknown;
  readonly source?: unknown;
  /** Observacional. NUNCA alimenta a resolução de identidade. */
  readonly cwd?: unknown;
  readonly session_id?: unknown;
  /**
   * Registro de sessão (18/09) — `hooks.md`, "Additional Agent-Related
   * Fields": presente SÓ quando a sessão foi lançada com `--agent <nome>`.
   * Ausente no caso comum (sessão interativa sem `--agent`). NUNCA um
   * segundo canal de identidade de projeto/binding.
   */
  readonly agent_type?: unknown;
}

export interface SessionStartResult {
  /** Bytes exatos do Builder. O transporte NÃO re-serializa. */
  readonly serialized: string;
  /**
   * Projeção legível do brief — o que de fato entra em
   * `hookSpecificOutput.additionalContext` (ver `toHookOutput`). `serialized`
   * continua sendo os bytes crus do Builder, intactos, para quem precisa do
   * `SessionBrief` estruturado; esta string é a APRESENTAÇÃO, montada por
   * `buildAdditionalContext` a partir do mesmo brief.
   */
  readonly additionalContext: string;
  readonly source: SessionStartSource;
  readonly projectDir: string;
  /**
   * `true` quando a leitura COMPARTILHADA de `KnowledgeRecord` estourou o
   * teto e `primePresentationCache` não teve o que procurar. NUNCA calado:
   * `claudeSessionStart` reporta em stderr quando `true` — "falha aqui não
   * pode custar o brief" não é o mesmo que "falha aqui nunca aparece em
   * lugar nenhum".
   */
  readonly primeDegraded: boolean;
  /**
   * Registro de sessão (18/09) — presente só quando a escrita FALHOU
   * (timeout ou erro). Linha pronta para stderr, mesmo contrato de
   * `primeDegraded`/`diagnosticoPrime`: falha aqui nunca afeta
   * `additionalContext`, só a visibilidade em stderr.
   */
  readonly sessionRecordDiagnostic?: string;
}

/**
 * 03c (host event observation, continuação) — teto da leitura
 * COMPARTILHADA de `KnowledgeRecord`. Substitui, para o caminho automático,
 * o teto que antes vivia só dentro de `assembleContext`/
 * `currentProjectStateHead` de forma independente (dois relógios para a
 * MESMA classe de I/O). Medido (13/09, 1035 `knowledge` + 81 `decisions`
 * reais): ~1,4s — mesma calibragem de `KNOWLEDGE_DEADLINE_MS`
 * (`bootstrap-context.ts`), que continua existindo como TETO PRÓPRIO de
 * `assembleContext` para quem chama `buildSessionBriefForCwd` SEM passar
 * por este adapter (`nexos boot`, testes diretos).
 */
const KNOWLEDGE_READ_DEADLINE_MS = 2_000;

/**
 * 03e (D — brief parcial) — reserva subtraída do orçamento restante antes de
 * calcular o teto de round 2 (`round2BudgetMs`, `runSessionStartAdapter`).
 * Cobre `buildAdditionalContext` (síncrono, string building sobre um brief já
 * em memória) + `JSON.stringify` do envelope + a escrita de stdout — nenhuma
 * dessas etapas faz I/O de disco novo. 150ms é generoso de propósito: mesmo
 * que a montagem em si custe uma fração disso, a folga absorve o desvio
 * medido entre o relógio EXTERNO (harness) e o INTERNO
 * (`performance.now()`) sem arriscar estourar o teto de 2700ms por causa da
 * própria montagem final.
 */
const ROUND2_ASSEMBLY_RESERVE_MS = 150;

/**
 * `ONE FAMILY READ PER SESSIONSTART · NOT ONE PER CONSUMER` — a leitura
 * ÚNICA de `BOOT_KNOWLEDGE_FAMILIES` (`KnowledgeRecord`/`Decision`/
 * `Research`, `bootstrap-context.ts`) que conhecimento (`assembleKnowledge`),
 * o head de `project_state` (`currentProjectStateHead`, um `.find()` por
 * `sourceRef` dentro do MESMO conjunto — `project_state` só existe em
 * `KnowledgeRecord`, então as outras duas families do preload nunca colidem
 * com essa busca) e o prime de apresentação (`primePresentationCache`)
 * compartilham. `unavailable` (sem Capsule canônica) é DIFERENTE de
 * `timeout` (leitura tentada, não coube no teto) — mesma distinção de
 * `HostSurfaceUnknownReason`/`KnowledgeAssembly.timedOut`: "não tentei"
 * nunca sai byte-idêntico a "tentei e não deu tempo".
 *
 * `families: ["KnowledgeRecord"]` sozinho — a primeira versão desta fatia —
 * era um DEFEITO medido em `tests/decision-continuity.test.ts`: `Decision`
 * parou de aparecer no brief (linha "Preservar marcador ..." e
 * `CONTINUITY_CONTEXT_INCOMPLETE` sumiram) porque o preload só cobria a
 * family que `currentProjectStateHead` precisa, não as TRÊS que o pack de
 * conhecimento apresenta. `BOOT_KNOWLEDGE_FAMILIES` é a MESMA constante que
 * `assembleKnowledge` já usava sem preload — reusada aqui, não duplicada,
 * para as duas leituras nunca divergirem de novo.
 */
type SharedKnowledgeRead =
  | { readonly kind: "unavailable" }
  | { readonly kind: "timeout" }
  | { readonly kind: "ready"; readonly records: readonly CurrentRecord[]; readonly anomalies: readonly Anomaly[] };

/**
 * `integrityCache` — 03e, JÁ CARREGADA pelo chamador (`runSessionStartAdapter`,
 * `ONE LOAD · ONE SAVE` — orquestrador mediu o defeito anterior: esta leitura
 * e `resolveCheckpointPresentation` carregavam/gravavam o MESMO arquivo de
 * ~3,7MB cada uma, DUAS vezes por SessionStart). `identity.identitySource ===
 * "manifest"` já provou que `rootPath` é o checkout de trabalho de um projeto
 * governado, nunca um clone de inspeção (`reader.ts`, docstring do módulo, e
 * `tests/capsule-acceptance.test.ts` A03 — mesmo princípio).
 *
 * `deadlineMs` — 03e (candidato 5, orquestrador): default
 * `KNOWLEDGE_READ_DEADLINE_MS`, byte-idêntico a antes desta fatia. O
 * chamador (`runSessionStartAdapter`) passa `Math.min(KNOWLEDGE_READ_DEADLINE_MS,
 * round1BudgetMs)` — nunca MAIS que o teto medido, só MENOS quando o
 * orçamento do processo já está mais apertado que 2s.
 */
async function readSharedKnowledge(
  identity: ProjectResolution,
  integrityCache: IntegrityCache | undefined,
  deadlineMs: number = KNOWLEDGE_READ_DEADLINE_MS
): Promise<SharedKnowledgeRead> {
  if (identity.identitySource !== "manifest" || !identity.rootPath) return { kind: "unavailable" };
  /**
   * 03e (iteração 4, orquestrador — cancelamento cooperativo) — `withDeadline`
   * abaixo continua existindo (decide o que ENTRA no brief, nunca quanto o
   * scan vive por conta própria), mas `deadlineAtMs` faz o PRÓPRIO loop de
   * `loadFamilyForResolution` (`head-resolver.ts`) checar `Date.now()` entre
   * arquivos e parar sozinho — não depende de um `setTimeout` externo, que
   * mede-se atrasar sob contenção real de CPU. `Date.now() + deadlineMs`:
   * converte o orçamento RELATIVO (já derivado do processo em
   * `runSessionStartAdapter`) num relógio de parede ABSOLUTO, o que o loop
   * consegue checar sem saber nada sobre orçamento de processo.
   */
  const outcome = await withDeadline(
    readCurrentRecords(identity.rootPath, {
      families: BOOT_KNOWLEDGE_FAMILIES,
      includeGlobal: true,
      integrityCache,
      deadlineAtMs: Date.now() + deadlineMs,
    }),
    deadlineMs
  );
  if (outcome.outcome === "timeout") return { kind: "timeout" };
  if (!outcome.value.ok) return { kind: "unavailable" };
  return { kind: "ready", records: outcome.value.records, anomalies: outcome.value.anomalies };
}

/**
 * `input` é ENTRADA NÃO CONFIÁVEL — vem de stdin. Valida forma antes de usar.
 * `projectDir` vem do ambiente, não do input.
 */
export async function runSessionStartAdapter(
  input: SessionStartInput,
  env: NodeJS.ProcessEnv,
  /**
   * 03e (D — brief parcial) — INSTRUMENTO DE TESTE, mesmo idioma de
   * `gateHealthRunner`: produção nunca passa isto (`runSessionStartWithWatchdog`
   * chama com o default `performance.now()`). Permite injetar quanto tempo
   * de processo já "decorreu" para provar o orçamento de round 2
   * deterministicamente, sem depender de timing real de wall-clock em teste.
   */
  nowMs?: () => number,
  /**
   * 03e (cold-path) — teto que `remainingProcessBudgetMs` usa para derivar os
   * orçamentos de round 1/round 2. Default `PROCESS_WATCHDOG_MS`, byte-idêntico
   * ao comportamento de antes desta fatia para os 4300+ testes que chamam este
   * adapter DIRETO, sem `runSessionStartWithWatchdog`. Produção sempre recebe
   * um valor explícito (`resolveProcessCeiling`, chamado pelo watchdog ANTES
   * deste adapter rodar) — `PROCESS_WATCHDOG_MS` ou `PROCESS_WATCHDOG_COLD_MS`,
   * nunca um terceiro número inventado aqui.
   */
  ceilingMs: number = PROCESS_WATCHDOG_MS,
  /**
   * 03e (cold-path) — identity + cache compartilhado JÁ RESOLVIDOS por
   * `resolveProcessCeiling` (o MESMO veredito frio/quente que escolheu
   * `ceilingMs`) — `ONE LOAD · ONE SAVE PER SESSIONSTART` continua valendo
   * mesmo com a checagem de frio adicionada: sem isto, o load de ~3,7MB
   * aconteceria DUAS vezes por abertura (uma para decidir o teto, outra aqui).
   * `undefined` (chamada direta de teste, sem watchdog) faz o adapter resolver
   * do zero exatamente como antes desta fatia.
   */
  preloaded?: {
    readonly identity: ProjectResolution;
    readonly sharedReadRoot: string | undefined;
    readonly sharedIntegrityCache: IntegrityCache | undefined;
  }
): Promise<SessionStartResult> {
  if (input.hook_event_name !== "SessionStart") {
    throw new SessionStartAdapterError(
      `evento inesperado: ${JSON.stringify(input.hook_event_name)}. ` +
        "Este adapter só responde por SessionStart."
    );
  }

  const source = input.source;
  if (typeof source !== "string" || !isSessionStartSource(source)) {
    throw new SessionStartAdapterError(
      `source inválido: ${JSON.stringify(source)}. ` +
        `Esperado um de: ${SESSION_START_SOURCES.join(", ")}`
    );
  }

  /**
   * `EXPLICIT CURRENT LIFECYCLE != AUTOMATICALLY ACCEPT FUTURE SOURCES`.
   * Uma fonte nova em versão futura do host deve falhar de forma visível, não
   * entrar por omissão.
   */
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw new SessionStartAdapterError(
      "CLAUDE_PROJECT_DIR ausente ou vazio. O adapter NÃO usa input.cwd como " +
        "fallback: MISSING HOST PROJECT BINDING != FALL BACK TO LIVE CWD. " +
        "Cair no cwd reintroduziria a corrupção de identidade (L2) em silêncio."
    );
  }

  /**
   * C1.1a-wire, reordenado pela 03 (host event observation) —
   *
   *   FAIL-OPEN EM OBSERVAÇÃO: A PUBLICAÇÃO DE session.started NÃO PODE
   *   DEPENDER DO BRIEF COMPLETO
   *
   * Antes desta fatia, `observeSessionStart` só rodava DEPOIS do brief
   * inteiro (conhecimento + checkpoint + evidência + prime de cache) já
   * montado — e cada uma dessas etapas lê o MESMO Store sem deadline
   * (`assembleContext`/`currentProjectStateHead`, ambos medidos em 8s contra
   * 3688 records). Um Store grande o bastante atrasava a trilha de sessão
   * pelo MESMO tanto que atrasava o brief — e se o processo morresse por
   * timeout do host no meio do caminho, nem o brief nem `session.started`
   * saíam. A observação só precisa de IDENTIDADE (`resolveProject`, ~dezenas
   * de ms) — nunca do conhecimento canônico — então resolve-se uma vez aqui
   * e a publicação roda em PARALELO com a montagem do brief, não depois dela.
   */
  /**
   * `cacheGitFacts: true` — lote resolver (defeito 2, reprovação do
   * verifier): `resolveProject` é estritamente read-only por padrão; este é
   * o ÚNICO par de chamadores (aqui e `resolveProcessCeiling` abaixo) que
   * opta pela gravação do cache derivado de `git_root_commit`, porque são o
   * caminho QUENTE medido (2x por processo de SessionStart). Nenhum outro
   * chamador de `resolveProject` no repositório passa esta opção.
   */
  const identity = preloaded?.identity ?? (await resolveProject({ cwd: projectDir, cacheGitFacts: true }));
  const currentSessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  /** Registro de sessão (18/09) — `session-events.ts` grava `null` quando ausente, nunca infere. */
  const currentAgentType = typeof input.agent_type === "string" && input.agent_type.trim() ? input.agent_type : null;

  /**
   * nexos://decision/recall-continuidade-indice-por-janela — `compact`/`clear`
   * apagam o contexto do MODELO (é o que essas fontes significam); o marker
   * de dedup do recall (`memory-recall.ts`) vive fora desse contexto, em
   * `/tmp`, então sobreviveria sozinho e a sessão continuaria em silêncio
   * sobre tudo que já tinha mostrado antes do apagão. Melhor esforço
   * (`.catch`): falha aqui custa, no pior caso, uma janela de dedup que não
   * reabre — nunca o SessionStart inteiro.
   */
  if ((source === "compact" || source === "clear") && currentSessionId) {
    await rm(shownMarkerFile(identity.bootstrapLocator, currentSessionId), { force: true }).catch(() => undefined);
  }

  /**
   * 03e — `ONE LOAD · ONE SAVE PER SESSIONSTART`, o cache compartilhado entre
   * `readSharedKnowledge` (round 1) e `resolveCheckpointPresentation`
   * (round 2). Antes desta fatia cada uma carregava/gravava o MESMO arquivo
   * de `.nexos/.local/derived/integrity-cache.json` (~3,7MB) por conta
   * própria — orquestrador mediu o defeito e apontou `reader.ts:599-601` e
   * `checkpoint.ts:885-887`. `sharedReadRoot` resolvido AQUI, uma vez, é o
   * MESMO root que os dois caminhos internos (`readCurrentRecords`/
   * `resolveCheckpointHead`) recalculam por conta própria via
   * `resolveReadRoot` para as próprias listagens de diretório — resolver de
   * novo ali é barato e nunca uma segunda fonte de verdade; aqui só decide
   * ONDE o cache compartilhado vive. `identity.identitySource === "manifest"`
   * é o MESMO gate que já provou (abaixo, para `observeSessionStart`) que
   * `projectDir` é o checkout de trabalho, nunca um clone de inspeção.
   */
  const sharedReadRoot = preloaded
    ? preloaded.sharedReadRoot
    : identity.identitySource === "manifest" && identity.rootPath
      ? await resolveReadRoot(identity.rootPath)
      : undefined;
  const sharedIntegrityCache = preloaded
    ? preloaded.sharedIntegrityCache
    : sharedReadRoot
      ? await loadIntegrityCache(sharedReadRoot)
      : undefined;
  /**
   * 03e — mesmo padrão do cache de integridade acima, para Evidence
   * (`.nexos/.local/evidence/*.json`, 600 arquivos no repo real, custo
   * medido pelo orquestrador em 160-290ms). Evidence é write-once — um HIT
   * por hash de conteúdo nunca fica desatualizado.
   */
  const sharedEvidenceCache = sharedReadRoot ? await loadEvidenceCache(sharedReadRoot) : undefined;

  /**
   * 03e (candidatos 3/5, orquestrador) — round 1 (esta leitura + o
   * `Promise.all` interno de `buildSessionBriefForCwd`, logo abaixo) tinha
   * dois tetos FIXOS somados sequencialmente (`KNOWLEDGE_READ_DEADLINE_MS`
   * 2000ms, depois até o teto de host surface, 1000ms) — até 3000ms
   * (`HOST_SURFACE_DEADLINE_MS` não existe mais: o subsistema saiu em `0c0dc91e`)
   * PIOR CASO, sozinho, já maior que `PROCESS_WATCHDOG_MS` (2700ms): sob
   * contenção real, round 1 podia estourar o orçamento do processo INTEIRO
   * antes de round 2 (já protegido por `round2BudgetMs`, item D) sequer
   * começar — o watchdog do processo então descartava tudo, inclusive o
   * que round 1 já tinha pronto, trocando por `minimalDegradedContext`.
   *
   *   ROUND 1'S OWN FIXED CEILINGS CAN EXCEED THE WHOLE PROCESS BUDGET
   *
   * `Math.min(TETO_FIXO, orçamentoRestante)` em cada teto de round 1 — nunca
   * MAIS que o valor já medido e documentado em `bootstrap-context.ts`, só
   * MENOS quando o processo já gastou mais do que sobra para terminar dentro
   * de `PROCESS_WATCHDOG_MS`. MESMA reserva de `round2BudgetMs`
   * (`ROUND2_ASSEMBLY_RESERVE_MS`) — não uma segunda constante: round 2 já
   * degrada sozinho até 0 (item D) quando não sobra nada, então a única
   * reserva que round 1 precisa proteger é a montagem final + stdout.
   * Recomputado DUAS vezes (antes da leitura compartilhada, de novo antes de
   * `buildSessionBriefForCwd`) porque os dois estágios são SEQUENCIAIS
   * (`.then`), não concorrentes — o relógio andou entre os dois.
   */
  const round1KnowledgeBudgetMs = Math.max(
    0,
    remainingProcessBudgetMs(ceilingMs, nowMs ?? (() => 0)) - ROUND2_ASSEMBLY_RESERVE_MS
  );

  /**
   * 03c — `ONE FAMILY READ PER SESSIONSTART`. `briefPromise` é ENCADEADA
   * (`.then`), não sequenciada por `await` bloqueante: a leitura compartilhada
   * já começa aqui — só a MONTAGEM do brief espera o resultado dela, porque
   * precisa saber o que preencher em `readKnowledgeContext`.
   */
  /**
   * 03e (cold-path) — `KNOWLEDGE_READ_DEADLINE_MS` (2000ms) foi calibrado
   * sobre leitura QUENTE (cache populado: `loadCanonicalRecord` bate no HIT
   * e pula parse+validate+serialize). Sob cache FRIO essa MESMA leitura é
   * CPU-bound de verdade (`integrity-cache.ts`, docstring de topo) e
   * genuinamente precisa de mais parede — um teto por estágio que não escala
   * com `ceilingMs` reproduziria o defeito medido (5/5 `KNOWLEDGE_TIMEOUT` a
   * 1,77x) mesmo com o teto do PROCESSO já alargado para 8000ms: o estágio
   * ainda morreria em 2000ms, MUITO antes do processo ter permissão de
   * continuar. Escala proporcional ao MESMO fator que alargou `ceilingMs` —
   * quente (`ceilingMs === PROCESS_WATCHDOG_MS`) preserva os 2000ms
   * byte-idênticos a antes desta fatia; frio (`PROCESS_WATCHDOG_COLD_MS`,
   * 8000/2700 ≈ 2,96x) dá ~5926ms, dentro da folga que
   * `round1KnowledgeBudgetMs` já reserva para round 2 depois. `Math.min` com
   * `round1KnowledgeBudgetMs` continua sendo a rede de segurança: NUNCA mais
   * que o orçamento de processo restante, só o NUMERADOR fixo que muda.
   */
  const knowledgeReadDeadlineMs = Math.min(
    Math.round(KNOWLEDGE_READ_DEADLINE_MS * (ceilingMs / PROCESS_WATCHDOG_MS)),
    round1KnowledgeBudgetMs
  );
  const sharedKnowledgePromise = readSharedKnowledge(identity, sharedIntegrityCache, knowledgeReadDeadlineMs);
  const briefPromise = sharedKnowledgePromise.then((sharedKnowledge) => {
    const readKnowledgeContext: KnowledgeContextLoader =
      sharedKnowledge.kind === "ready"
        ? (req) =>
            assembleContext({
              ...req,
              preloadedRead: { records: sharedKnowledge.records, anomalies: sharedKnowledge.anomalies },
            })
        : /** `timeout`/`unavailable` — nada pré-carregado. Para `timeout`,
           * `knowledgeDeadlineMs: 0` abaixo faz a corrida de
           * `raceKnowledge` (`bootstrap-context.ts`) vencer IMEDIATAMENTE
           * pelo lado do relógio, sem esperar de novo por uma leitura que
           * já sabemos que não coube no teto — esta promise nunca resolver
           * é inofensivo, nunca é aguardada até o fim. Para `unavailable`,
           * o próprio gate `identitySource === "manifest"` dentro de
           * `buildSessionBriefForCwd` já pula a chamada inteira. */
          () => new Promise<never>(() => {});
    const round1BriefBudgetMs = Math.max(
      0,
      remainingProcessBudgetMs(ceilingMs, nowMs ?? (() => 0)) - ROUND2_ASSEMBLY_RESERVE_MS
    );
    return buildSessionBriefForCwd({
      cwd: projectDir,
      readKnowledgeContext,
      knowledgeDeadlineMs:
        sharedKnowledge.kind === "timeout"
          ? 0
          : (parseKnowledgeDeadlineMs(env) ?? Math.min(KNOWLEDGE_DEADLINE_MS, round1BriefBudgetMs)),
    });
  });

  const [briefResult, sharedKnowledge] = await Promise.all([briefPromise, sharedKnowledgePromise]);
  const { serialized, brief } = briefResult;
  /**
   * P1.5b — movida para ANTES do round 2 (era calculada depois, na composição
   * final): B5 precisa saber, ANTES de decidir se vale ler o legado
   * `.nexos/memory/project/state.md`, se já existe um head canônico de
   * `project_state` — `sharedKnowledge.records` já está em mãos aqui, sem
   * I/O extra nenhum por adiantar o cálculo.
   */
  const currentStateLine = deriveCurrentStateLine(
    sharedKnowledge.kind === "ready" ? sharedKnowledge.records : []
  );

  /**
   * As quatro leituras abaixo são independentes entre si — nenhuma usa o
   * resultado de outra — incluindo `primePresentationCache`, que só precisa
   * do `brief` já resolvido acima e da leitura COMPARTILHADA já resolvida,
   * nunca de `checkpointPresentation`/`evidence`/`autonomousWarning`.
   * `Promise.all` em vez de sequência: mesma lógica de
   * `buildSessionBriefForCwd` (`bootstrap-context.ts`) — pior caso é o MAIOR
   * teto entre elas, não a soma.
   *
   * DEFEITO A (`primePresentationCache`) — sem isto, o primeiro
   * `UserPromptSubmit` da sessão reemitia o `project_state` inteiro segundos
   * depois de `additionalContext` já ter mostrado a mesma base: o cache de
   * apresentação só era escrito pelo `claude-user-prompt-submit`, e no
   * primeiro prompt ele estava vazio. `presented` checa se o item REALMENTE
   * entrou no texto (nunca quando o orçamento cortou o item —
   * `BUDGET EXCEEDED -> DROP AN ITEM` em `buildAdditionalContext` — ou
   * quando não há Capsule canônica): gravar sem ter mostrado nada
   * silenciaria o próximo prompt sobre um estado que o usuário nunca viu.
   */
  /**
   * 03e (D — brief parcial, orquestrador) — os tetos de round 2 derivam do
   * ORÇAMENTO RESTANTE do processo (não de um número fixo), com reserva para
   * montagem (`buildAdditionalContext`) e stdout. Round 1 (leitura
   * compartilhada + `buildSessionBriefForCwd`, acima) passou pela MESMA
   * derivação (candidatos 3/5): seus tetos internos
   * (`KNOWLEDGE_READ_DEADLINE_MS`/ — o teto de host surface saiu com o subsistema/
   * `KNOWLEDGE_DEADLINE_MS`) agora são `Math.min(tetoFixo, orçamentoRestante)`,
   * nunca mais que o valor medido, só menos sob contenção real — antes desta
   * fatia eram fixos e SOMADOS sequencialmente (até 3000ms pior caso, sozinho
   * já maior que `PROCESS_WATCHDOG_MS`). Round 2 nunca teve teto próprio —
   * era um `Promise.all` bloqueante, e se a SOMA das cinco leituras
   * ultrapassasse o que sobrava do orçamento de 2700ms, o watchdog do
   * PROCESSO (`runSessionStartWithWatchdog`) descartava TUDO — inclusive o
   * `brief` que round 1 já tinha entregue — trocando por
   * `minimalDegradedContext`, sem nome de projeto, sem nada.
   *
   *   BUDGET-DERIVED STAGE DEADLINE FIRES BEFORE THE PROCESS WATCHDOG
   *   PARTIAL BRIEF WITH WHAT RESOLVED != BLANK FALLBACK
   *
   * Cada leitura de round 2 corre com o MESMO teto (`round2BudgetMs`,
   * calculado UMA vez aqui) — uma leitura lenta (evidência, 600 arquivos no
   * repo real) nunca bloqueia uma rápida (nome do projeto) de aparecer: cada
   * `withDeadline` corre INDEPENDENTE. O que não coube some do texto com uma
   * nota explícita (`buildOmittedNote` abaixo) — nunca em silêncio, e nunca
   * como se tivesse sido tentado e falhado (é "sem orçamento", não "erro").
   * O watchdog do processo continua existindo, mas vira ÚLTIMO RECURSO: só
   * dispara se round 1 sozinho já estourar o teto inteiro — caso em que não
   * há brief nenhum para compor parcialmente.
   */
  /**
   * `nowMs ?? (() => 0)` — NUNCA o default de `remainingProcessBudgetMs`
   * (`performance.now()` cru). MEDIDO: os 4300+ testes que chamam
   * `runSessionStartAdapter` DIRETO (sem `runSessionStartWithWatchdog`, per o
   * próprio contrato do adapter — "os testes chamam DIRETO, sem watchdog")
   * rodam dentro do MESMO processo compartilhado do vitest, que já tem
   * MINUTOS de vida quando um teste no meio da suíte executa —
   * `performance.now()` cru leria isso como "orçamento já estourado" e
   * cortaria round 2 em TODO teste, não só nos que testam timing de verdade.
   * `() => 0` = "nenhum tempo decorrido" = orçamento cheio, byte-idêntico ao
   * comportamento de antes desta fatia para quem não passa `nowMs`.
   * `runSessionStartWithWatchdog` (produção) passa o relógio REAL
   * explicitamente — nunca depende deste default propagar sozinho.
   */
  const round2BudgetMs = Math.max(
    0,
    remainingProcessBudgetMs(ceilingMs, nowMs ?? (() => 0)) - ROUND2_ASSEMBLY_RESERVE_MS
  );

  /**
   * 03e (nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver)
   * — `computeLifecycleGitFacts(identity)` UMA vez por processo, disparado
   * AGORA (a promise já começa a rodar) e repassado para
   * `classifyProjectLifecycleForResolution` E `resolveMapSummary` (que o
   * encaminha a `checkMapFreshness`/`refreshMapIfStale`/
   * `refreshProjectMapIncremental`) dentro do MESMO `Promise.all` abaixo — os
   * dois consumidores só fazem `await` na MESMA promise, nenhuma serialização
   * extra no caminho crítico (`Promise.all` continua disparando tudo junto).
   * Sem isto: 3x `git rev-parse HEAD` + 3x `git diff --name-only` pelo MESMO
   * `last_mapped_commit`..HEAD, medido na auditoria (10 spawns de git x86 sob
   * Rosetta só nesta trilha).
   */
  const gitFactsPromise = computeLifecycleGitFacts(identity);

  const [
    checkpointOutcome,
    projectNameOutcome,
    evidenceOutcome,
    primeOutcome,
    lifecycleOutcome,
    mapSummaryOutcome,
    legacyStateNoteOutcome,
    staleRuntimeOutcome,
    assetDriftOutcome,
    previousSessionOutcome,
  ] = await Promise.all([
      /**
       * 03e — o MESMO `sharedIntegrityCache` que `readSharedKnowledge` já usou
       * em round 1, nunca uma cópia nova: `commands/boot.ts` continua chamando
       * sem segundo argumento (`undefined` — sem cache, comportamento de sempre).
       */
      withDeadline(resolveCheckpointPresentation(projectDir, sharedIntegrityCache), round2BudgetMs),
      /**
       * P1.3i (B3) — `identity.rootPath`, NUNCA `projectDir` cru: num
       * redirect (subpasta de um projeto canônico, `H1`), `projectDir` é
       * `CLAUDE_PROJECT_DIR` — a subpasta em si, sem manifest nem mapa
       * próprios. `identity` já é a resolução (round 1) que subiu até a
       * fronteira REAL; ler `forProject(projectDir)` ali procurava
       * `.nexos/manifest.yaml`/`map/*` num diretório que nunca os teve,
       * perdendo nome e mapa do projeto — medido na auditoria da jornada (H1).
       */
      withDeadline(readProjectName(brief, identity.rootPath), round2BudgetMs),
      withDeadline(resolveDeclaredEvidence(brief, projectDir, sharedEvidenceCache), round2BudgetMs),
      withDeadline(
        primePresentationCache({
          identity,
          sessionId: currentSessionId ?? "",
          presented: (brief.knowledge?.items ?? []).some((item) => item.source_ref === "nexos://project-state"),
          preloadedRecords: sharedKnowledge.kind === "ready" ? sharedKnowledge.records : undefined,
        }),
        round2BudgetMs
      ),
      /**
       * P1.2 (nexos://decision/p1-2-project-lifecycle) — reusa `identity` (JÁ
       * resolvida acima, round 1) — nunca um segundo `resolveProject()` pelo
       * mesmo fato. Reporta só: `classifyProjectLifecycleForResolution` nunca
       * escreve, nunca executa BOOTSTRAP/MIGRATE_REPAIR (P1.3). `gitFactsPromise`
       * — o MESMO fato que `resolveMapSummary` abaixo também aguarda, nunca um
       * segundo `computeLifecycleGitFacts` (03e).
       */
      withDeadline(
        gitFactsPromise.then((gitFacts) => classifyProjectLifecycleForResolution(identity, gitFacts)),
        round2BudgetMs
      ),
      /**
       * P1.5 (nexos://decision/p1-5-hot-brief) — seções 2+3 do HOT. Projeto
       * NEW (sem `.nexos/map/*` ainda) degrada para `{}` — `resolveMapSummary`
       * nunca lança, cada leitura é independente. `identity` inteira (B3 +
       * C1, fatia C): além de `rootPath`, precisa de `identitySource` para
       * nunca tentar `refreshMapIfStale` sobre um diretório sem manifest
       * (`writeFreshProjectMap` LANÇA sem um `.nexos/manifest.yaml` válido —
       * NEW/bootstrap não pode disparar isso por conta própria). `round2BudgetMs`
       * passado TAMBÉM para dentro: `resolveMapSummary` usa o MESMO orçamento
       * para o `withDeadline` interno do refresh, então o `withDeadline`
       * externo aqui é rede de segurança (checkMapFreshness/leitura travando
       * antes de chegar lá), não o teto principal. `gitFactsPromise` — o
       * MESMO fato que `classifyProjectLifecycleForResolution` acima também
       * aguarda (03e).
       */
      withDeadline(
        gitFactsPromise.then((gitFacts) => resolveMapSummary(identity, round2BudgetMs, gitFacts)),
        round2BudgetMs
      ),
      /**
       * P1.3i (B5) — só vale a leitura best-effort de
       * `.nexos/memory/project/state.md` quando NÃO há head canônico de
       * `project_state` ainda (`currentStateLine`, já calculado acima, sem
       * I/O extra). Com canônico presente, o legado nunca aparece como
       * estado — `Promise.resolve(undefined)` evita um `stat`/`readFile`
       * que ninguém vai mostrar.
       */
      withDeadline(
        currentStateLine === undefined ? resolveLegacyStateNote(identity.rootPath) : Promise.resolve(undefined),
        round2BudgetMs
      ),
      /**
       *   MANUAL PATH SEES != AUTOMATIC PATH SEES
       *
       * `nexos boot` avisa quando o binário em execução não é o build deste
       * worktree; o SessionStart não avisava, e é ELE que abre toda sessão.
       * Quem só abre o Claude Code nunca via o aviso — e um runtime velho lê o
       * Store de hoje com o schema de ontem, o que já produziu
       * `INVALID_SCHEMA ×8` sobre um Store que estava íntegro.
       *
       * MEDIDO: 120ms no primeiro processo (page cache frio da árvore
       * instalada), mediana 52ms depois. Contra PROCESS_WATCHDOG_MS de
       * 2700ms, ~4,4% do teto — e entra no mesmo `Promise.all` do round 2,
       * cujo pior caso é o maior teto, nunca a soma.
       */
      withDeadline(detectStaleRuntime(identity.rootPath), round2BudgetMs),
      /**
       *   INSTALLED CODE != INSTALLED ASSETS
       *
       * Pacote e assets são duas instalações independentes: atualizar o npm
       * não projeta agents/skills/rules/hooks. Quem não digita `nexos install`
       * trabalha com a versão antiga deles sem nenhum sinal. Medido aqui hoje:
       * assets 6.5.1 contra pacote 6.5.2, visível só por `doctor --project`.
       * Uma leitura de JSON pequeno — a fatia do health que cabe no orçamento.
       */
      withDeadline(detectAssetDrift(), round2BudgetMs),
      /**
       * A linha "última sessão" estava desligada desde o corte de 14/09, que
       * removeu de onde ela vinha. A family `Session` devolveu o dado, então
       * ela volta — com a sessão CORRENTE excluída: dizer ao agente que a
       * sessão anterior é ele mesmo é pior que não dizer nada.
       *
       * `input.session_id` ausente (payload sem sessão) devolve `undefined`
       * sem tocar o disco: sem id corrente não há como excluir a própria
       * sessão, e mostrar a si mesmo como anterior é o defeito que este
       * argumento existe para impedir.
       */
      withDeadline(
        typeof input.session_id === "string" && input.session_id !== ""
          ? findPreviousSession(identity.rootPath, input.session_id)
          : Promise.resolve(undefined),
        round2BudgetMs
      ),
    ]);
  const checkpointPresentation = checkpointOutcome.outcome === "resolved" ? checkpointOutcome.value : undefined;
  /**
   * Registro de sessão (18/09) — `writeSessionStarted` (`session-events.ts`)
   * NUNCA lança (fail-open absoluto, ver docstring do módulo); `withDeadline`
   * aqui é rede de segurança adicional contra disco lento, não proteção
   * contra exceção. Roda DEPOIS de `checkpointPresentation` para reusar o
   * `id` já resolvido (`CheckpointPresentation.id`) — nunca uma segunda
   * chamada a `resolveCheckpointHead`. Gate idêntico ao resto do arquivo
   * (`identity.identitySource === "manifest"`): sem Capsule canônica não há
   * onde publicar, e sem `session_id` não há o que correlacionar.
   *
   * Falha NUNCA chega ao `additionalContext` — só a `sessionRecordDiagnostic`
   * abaixo, surfaced em stderr por `runSessionStartWithWatchdog` (mesmo
   * contrato de `diagnosticoPrime`).
   */
  let sessionRecordDiagnostic: string | undefined;
  if (identity.identitySource === "manifest" && identity.rootPath && identity.canonicalProjectId && currentSessionId) {
    const outcome = await withDeadline(
      writeSessionStarted({
        rootPath: identity.rootPath,
        projectId: identity.canonicalProjectId,
        sessionId: currentSessionId,
        cwd: identity.rootPath,
        agentRef: currentAgentType,
        checkpointId: checkpointPresentation?.id ?? null,
      }),
      round2BudgetMs
    );
    if (outcome.outcome === "timeout") {
      sessionRecordDiagnostic =
        "[nexos claude-session-start] registro de sessão não publicado: estourou o teto de round 2\n";
    } else if (!outcome.value.ok) {
      sessionRecordDiagnostic = `[nexos claude-session-start] registro de sessão não publicado: ${outcome.value.detail}\n`;
    }
  }
  const projectName = projectNameOutcome.outcome === "resolved" ? projectNameOutcome.value : undefined;
  const evidence = evidenceOutcome.outcome === "resolved" ? evidenceOutcome.value : undefined;
  const primeDegraded = primeOutcome.outcome === "resolved" ? primeOutcome.value.degraded : true;
  const legacyStateLines =
    legacyStateNoteOutcome.outcome === "resolved" ? legacyStateNoteOutcome.value : undefined;
  const lifecycleLine =
    lifecycleOutcome.outcome === "resolved" ? formatLifecycleLine(lifecycleOutcome.value) : undefined;
  const mapSummary = mapSummaryOutcome.outcome === "resolved" ? mapSummaryOutcome.value : {};
  const staleRuntime = staleRuntimeOutcome.outcome === "resolved" ? staleRuntimeOutcome.value : null;
  const staleRuntimeLine = formatStaleRuntimeWarning(staleRuntime);
  const assetDrift = assetDriftOutcome.outcome === "resolved" ? assetDriftOutcome.value : null;
  const assetDriftLine = formatAssetDriftWarning(assetDrift);
  const previousSession =
    previousSessionOutcome.outcome === "resolved" ? previousSessionOutcome.value : undefined;
  const lastSessionLine =
    previousSession === undefined ? undefined : formatPreviousSessionLine(previousSession);

  /**
   * `SAVE FINAL`, depois que AMBOS os consumidores do cache compartilhado já
   * terminaram (round 1 e round 2) — cobre o que sobrou desde o último
   * flush periódico (`loadFamilyForResolution`, `head-resolver.ts` — a
   * DEFESA de verdade contra o processo morrer no meio, ver a docstring de
   * `IntegrityCache.rootPath`). Um `timeout` em `checkpointOutcome` não
   * impede este save: `resolveCheckpointPresentation` pode ter ficado com o
   * cache POPULADO mesmo sem terminar a montagem da apresentação —
   * `withDeadline` não cancela o loser, ele continua rodando e ainda grava
   * no MESMO objeto `sharedIntegrityCache` até terminar.
   */
  if (sharedIntegrityCache) {
    await saveIntegrityCacheIfDirty(sharedIntegrityCache);
  }
  if (sharedReadRoot && sharedEvidenceCache) {
    await saveEvidenceCacheIfDirty(sharedReadRoot, sharedEvidenceCache);
  }
  /**
   * P1.5b (fix nexos://decision/p1-5-hot-brief) — HOT nunca mostra
   * "Tarefa bloqueada"/"Capabilities da tarefa" de um head BLOCKED/
   * HUMAN_REQUIRED: `CheckpointPresentation.blocked` (ver checkpoint.ts)
   * já resolve isso sem resolver novo — `nexos boot` continua mostrando
   * `taskLine` de qualquer estado, sem mudança.
   */
  /**
   * Best-effort, mesma doutrina de `collectGit`: um erro aqui NUNCA pode
   * derrubar o brief — sem projeção no projeto (a maioria) a função devolve
   * string vazia depois de um `pathExists`, então o custo do caso comum é uma
   * chamada de stat.
   */
  let agentProjectionLine = "";
  try {
    agentProjectionLine = await describeAgentProjection(identity.rootPath);
  } catch {
    agentProjectionLine = "";
  }

  const hotTaskLine = checkpointPresentation?.blocked ? undefined : checkpointPresentation?.taskLine;
  const hotCapabilityLines = checkpointPresentation?.blocked ? undefined : checkpointPresentation?.capabilityLines;
  const baseAdditionalContext = buildAdditionalContext(
    brief,
    projectName,
    evidence,
    hotTaskLine,
    hotCapabilityLines,
    lastSessionLine,
    lifecycleLine,
    mapSummary.mapSummaryLine,
    mapSummary.architectureSummaryLines,
    currentStateLine,
    legacyStateLines,
    mapSummary.coverageLine,
    mapSummary.staleLine,
    agentProjectionLine
  );

  const omittedNote = buildOmittedNote({
    checkpoint: checkpointOutcome.outcome === "timeout",
    evidence: evidenceOutcome.outcome === "timeout",
  });

  // O aviso de runtime vai ANTES do brief: se o processo que montou o brief
  // pode estar errado, quem lê precisa saber disso antes de ler o resto.
  const additionalContext = [omittedNote, staleRuntimeLine, assetDriftLine, baseAdditionalContext]
    .filter(Boolean)
    .join("\n\n");

  return {
    serialized,
    additionalContext,
    source,
    projectDir,
    primeDegraded,
    ...(sessionRecordDiagnostic ? { sessionRecordDiagnostic } : {}),
  };
}

/**
 * Nome legível do projeto, para a única linha da projeção que precisa dele.
 *
 * `manifest.project.name` é obrigatório no schema (`ManifestSchema`,
 * `schemas.ts:1731`) mas só existe quando `identity_source === "manifest"` —
 * projeto em bootstrap não tem manifest nenhum para ler. Fora desse gate,
 * `forProject(rootPath).manifest()` apontaria para um arquivo que nunca
 * existiu, e a leitura falharia de qualquer forma.
 *
 *   PRESENTATION READ FAILURE != BOOT FAILURE
 *
 * Qualquer falha aqui (path não-absoluto, manifest ilegível, race de
 * remoção) devolve `undefined` e nunca propaga — o chamador degrada para o
 * id, e o brief estruturado (`serialized`) já saiu ileso antes desta leitura
 * acontecer.
 *
 * P1.3i (B3) — `rootPath` é `identity.rootPath` (a fronteira que o Resolver
 * REALMENTE encontrou), não mais `CLAUDE_PROJECT_DIR` cru. Numa subpasta de
 * projeto canônico (`H1`: `CLAUDE_PROJECT_DIR` = subpasta, sem manifest
 * próprio) a versão anterior lia `forProject(projectDir)` — a subpasta em
 * si — e nunca achava o manifest, perdendo o nome do projeto inteiro.
 * Medido na auditoria da jornada.
 */
export async function readProjectName(brief: SessionBrief, rootPath: string): Promise<string | undefined> {
  if (brief.project.identity_source !== "manifest") return undefined;
  try {
    return await readManifestProjectName(forProject(rootPath).manifest(), []);
  } catch {
    return undefined;
  }
}

/**
 * P1.5 (nexos://decision/p1-5-hot-brief) — seções 2+3 do HOT, agora sobre
 * `readMapSummary` (A14, fatia A): uma leitura honesta de
 * `.nexos/map/{project,routes,database,graph}.json` + `architecture.md` +
 * `coverage.json`, que nunca fabrica zero para área não analisada.
 *
 *   MAP ABSENT != BOOT FAILURE
 *
 * Projeto NEW (nunca rodou `nexos init`/`nexos map`) não tem nenhum destes
 * arquivos — cada leitura falha independente e degrada, a seção
 * correspondente some do texto (nunca "mapa vazio" fabricado). O gate
 * `identity.identitySource !== "manifest"` cobre esse caso ANTES de tocar
 * disco: sem manifest não há `.nexos/map/*` para ler, e — mais importante —
 * `refreshMapIfStale`/`writeFreshProjectMap` LANÇAM sem um manifest válido
 * (`project-map.ts`), então nem vale tentar convergir um mapa para um
 * diretório que nunca foi `nexos init`.
 *
 * P1.3i (B3) — `identity.rootPath`, não `CLAUDE_PROJECT_DIR` cru: mesma
 * correção de `readProjectName` acima, mesma causa (H1 — subpasta sem
 * `.nexos/map/*` próprio nunca encontrava o mapa do projeto canônico).
 *
 * C1 (fatia C, orquestrador) — a leitura deixa de ser só PASSIVA: quando
 * `checkMapFreshness` acusa `stale` e o último mapa examinou um escopo
 * pequeno o bastante (`MAP_REFRESH_MAX_FILES`), tenta convergir
 * (`refreshMapIfStale`) sob o `budgetMs` restante do processo ANTES de
 * montar o resumo — o brief mostra o mapa JÁ atualizado, não uma fotografia
 * velha. Sem caber (escopo grande demais, timeout, ou já sem orçamento),
 * UMA linha honesta (`staleLine`) substitui a seção inteira — nunca falha o
 * SessionStart, nunca finge que o mapa está fresco.
 *
 * `gitFacts` (nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver)
 * — o MESMO `computeLifecycleGitFacts(identity)` que o chamador já calculou
 * (`gitFactsPromise`, `runSessionStartAdapter`), repassado a
 * `checkMapFreshness`/`refreshMapIfStale` em vez de recalculado aqui dentro.
 */
async function resolveMapSummary(
  identity: ProjectResolution,
  budgetMs: number,
  gitFacts?: ProjectLifecycleGitFacts
): Promise<{
  readonly mapSummaryLine?: string;
  readonly architectureSummaryLines?: readonly string[];
  readonly coverageLine?: string;
  readonly staleLine?: string;
}> {
  if (identity.identitySource !== "manifest" || !identity.rootPath) return {};
  const rootPath = identity.rootPath;

  const freshness = await checkMapFreshness(rootPath, { maxFiles: MAP_REFRESH_MAX_FILES, gitFacts });
  if (!freshness.stale) return fromMapSummary(await readMapSummary(rootPath));

  /**
   * `files_examined` do ÚLTIMO `project.json` — não exposto por
   * `checkMapFreshness` (`MapFreshness` só carrega `stale`/`reason`/
   * `changedFiles`), então lido aqui, direto, do MESMO arquivo que
   * `readMapSummary` já lê best-effort logo abaixo. `undefined` (sem
   * `project.json` legível — `no_map`) trata como "dentro do escopo": não há
   * histórico que diga que o projeto é grande, e um projeto que nunca foi
   * mapeado merece a tentativa.
   */
  const filesExamined = await readLastFilesExamined(rootPath);
  const withinScope = filesExamined === undefined || filesExamined <= MAP_REFRESH_MAX_FILES;

  if (withinScope && budgetMs > 0) {
    const refreshOutcome = await withDeadline(
      refreshMapIfStale(rootPath, { maxFiles: MAP_REFRESH_MAX_FILES, freshness, gitFacts }),
      budgetMs
    );
    if (refreshOutcome.outcome === "resolved") return fromMapSummary(await readMapSummary(rootPath));
  }

  return { staleLine: buildStaleMapLine(freshness) };
}

/** Escopo, acima do qual `resolveMapSummary` não tenta convergir o mapa dentro do SessionStart — só avisa. */
const MAP_REFRESH_MAX_FILES = 1500;

function fromMapSummary(summary: MapSummary): {
  readonly mapSummaryLine?: string;
  readonly architectureSummaryLines?: readonly string[];
  readonly coverageLine?: string;
} {
  return {
    mapSummaryLine: summary.mapSummaryLine,
    architectureSummaryLines: summary.architectureSummaryLines,
    coverageLine: summary.coverageLine,
  };
}

async function readLastFilesExamined(rootPath: string): Promise<number | undefined> {
  const projectJson = await readJsonBestEffort(forProject(rootPath).mapProjectJson());
  const filesExamined = projectJson?.files_examined;
  return typeof filesExamined === "number" ? filesExamined : undefined;
}

/**
 * "Mapa desatualizado: N arquivo(s) mudaram (a, b, c…) — `nexos map`
 * atualiza." — até 3 nomes, reticências quando há mais. `changedFiles`
 * ausente (`reason` sem lista de paths: `fingerprint_changed`/`unknown`/
 * `no_map`) degrada para a frase sem contagem nem lista — nunca um "0
 * arquivo(s)" fabricado.
 */
function buildStaleMapLine(freshness: MapFreshness): string {
  const files = freshness.changedFiles;
  if (!files || files.length === 0) {
    return "Mapa desatualizado — `nexos map` atualiza.";
  }
  const shown = files.slice(0, 3);
  const reticencias = files.length > shown.length ? "…" : "";
  return `Mapa desatualizado: ${files.length} arquivo(s) mudaram (${shown.join(", ")}${reticencias}) — \`nexos map\` atualiza.`;
}

/**
 * P1.5b (fix nexos://decision/p1-5-hot-brief) — seção 4 do HOT: `current_state`
 * do head `project_state` corrente, dentro de records JÁ EM MÃOS (round 1,
 * `sharedKnowledge.records`) — MESMA fonte que `boot.ts`'s `readProjectState`/
 * "Estado atual:" usa (`nexos://project-state` + `contentOf`), sem um
 * segundo `readCurrentRecords` (ver o comentário no call site: reprocessar
 * todas as famílias canônicas de novo custou ~1-1,5s extra, medido). Só
 * `current_state` (o `--set` atual, nunca `--next`/histórico), truncado com
 * a MESMA regra de `summarizeFieldsToOneLiner` (`truncateOneLiner`).
 * `assembleContext` (`items`) nem sempre inclui o item `project-state` no
 * ranking — quando inclui, o bloco abaixo (linha 844) já renderiza "Estado:"
 * a partir dele e esta linha fica redundante e é omitida. Pura: nunca lança,
 * `records` vazio ou sem o item degrada para `undefined`.
 */
function deriveCurrentStateLine(records: readonly CurrentRecord[]): string | undefined {
  const atual = records.find((x) => x.sourceRef === "nexos://project-state");
  if (!atual) return undefined;
  const currentState = contentOf(atual.record).current_state;
  return currentState ? `Estado: ${truncateOneLiner(currentState, 200)}` : undefined;
}

/**
 * P1.3i (B5) — sem head canônico de `project_state` (checado pelo chamador
 * via `currentStateLine === undefined`, ANTES de chamar isto), um
 * `.nexos/memory/project/state.md` legado (Fintech: pré-cutover para o
 * Store) ainda carrega sinal — a auditoria da jornada mediu o brief dizendo
 * "Tarefa: nenhuma" com esse arquivo cheio de próximos passos ao lado.
 *
 *   LEGACY SIGNAL != CANONICAL STATE
 *
 * A linha deixa isso explícito: "não confirmado", nunca apresentado como se
 * fosse `nexos state` teria dito. Nunca migra nada — só lê e resume. `undefined`
 * quando o legado não existe (a maioria dos projetos: nada a mostrar).
 */
async function resolveLegacyStateNote(rootPath: string): Promise<readonly string[] | undefined> {
  const memoryDir = path.join(rootPath, ".nexos", "memory", "project");
  const stateMdPath = path.join(memoryDir, "state.md");

  let stateMd: string;
  let modifiedAt: Date;
  try {
    stateMd = await readFile(stateMdPath, "utf-8");
    modifiedAt = (await stat(stateMdPath)).mtime;
  } catch {
    return undefined;
  }

  const lines: string[] = [
    `Estado legado (não confirmado): .nexos/memory/project/state.md · modificado ${modifiedAt.toISOString().slice(0, 10)}`,
  ];
  for (const extracted of extractLegacyStateLines(stateMd)) lines.push(`  ${extracted}`);

  try {
    const decisionsMd = await readFile(path.join(memoryDir, "decisions.md"), "utf-8");
    const count = extractDecisionTitles(decisionsMd).length;
    lines.push(`  ver também: .nexos/memory/project/decisions.md (${count} título(s), legado)`);
  } catch {
    // sem decisions.md legado — sem ponteiro, nada a acrescentar.
  }
  return lines;
}

/**
 * Até 2 linhas do markdown legado: prioriza linhas rotuladas
 * Status/Fase/Próximo/Next (o vocabulário real observado no Fintech); na
 * ausência delas, as 2 primeiras não-vazias que não sejam título (`#`).
 * `truncateOneLiner` (`hot-brief.ts`) — mesma regra de corte que o resto do
 * brief usa, nunca uma segunda convenção de truncagem.
 *
 * C5 (fatia C, orquestrador) — o `state.md` real observado (Fintech) carrega
 * o rótulo DENTRO do título markdown (`## Status: FASE 4 …`,
 * `## Fase Atual: Development — próximo: …`), não numa linha de corpo solta.
 * A versão anterior excluía TODA linha começando com `#` do candidato a
 * rotulada — o rótulo real nunca era visto, e o pool caía no fallback
 * genérico (2 primeiras linhas de corpo, que aqui eram entradas soltas de uma
 * lista de commits). O rótulo é testado sobre o título SEM o(s) `#` — e sem
 * exigir dois-pontos IMEDIATAMENTE após a palavra (`Fase Atual:` tem "Atual"
 * entre o rótulo e o `:`) — mas a linha exibida continua sem o markdown de
 * título, mais legível num brief de texto plano.
 */
function extractLegacyStateLines(markdown: string): string[] {
  const linhas = markdown.split("\n").map((l) => l.trim());
  const semTitulo = linhas.map((l) => l.replace(/^#+\s*/, ""));
  const rotuladas = semTitulo.filter((l) => /^(Status|Fase|Pr[oó]ximo|Next)\b.*:/i.test(l));
  const pool = rotuladas.length > 0 ? rotuladas : linhas.filter((l) => l.length > 0 && !l.startsWith("#"));
  return pool.slice(0, 2).map((l) => truncateOneLiner(l, 160));
}

async function readJsonBestEffort(target: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * A projeção que de fato chega ao modelo em `additionalContext`.
 *
 *   BUDGET EXCEEDED -> DROP AN ITEM, NEVER TRUNCATE ONE
 *
 * Cada item de `brief.knowledge` entra por INTEIRO — título, `why` e todos os
 * `fields`, sem cortar nenhum valor. O que sai daqui, em relação ao JSON cru
 * que este adapter entregava antes:
 *
 *   - `version`, `identity_source`, `capabilities` e `warnings` vazio ficam
 *     de fora da leitura — continuam no `SessionBrief` estruturado
 *     (`serialized`), só não valem apresentação em texto nesta fatia.
 *   - `pointers` com `title: ""` não entram: um ponteiro sem título não dá
 *     para decidir se vale abrir, e custa bytes por nada.
 *   - O item `nexos://project-state` (convenção já usada por
 *     `codex-projection.ts`) tem seus campos conhecidos —
 *     `current_state`/`global_goal`/`next_action`/`blocker`/
 *     `decision_question`/`last_verified` — promovidos para linhas de topo
 *     com os rótulos já estabelecidos em `commands/boot.ts` e
 *     `commands/state.ts`, em vez de repetidos também no corpo genérico.
 *   - `gotcha` (`source_ref` sob o namespace `nexos://gotcha/` —
 *     `GOTCHA_SOURCE_PREFIX`, `commands/gotcha.ts`) mostra só `title`, `rule`
 *     e `source_ref` — as PROSAS (`failure_mode`, `cause`, `mitigation`,
 *     `prevention`, `consequence`, `trigger`) ficam de fora DESTA leitura.
 *
 *       CANONICAL GOTCHA = completo · BOOT PROJECTION = acionável e compacta
 *
 *     Isso é seleção de apresentação: o record, o `SessionBrief` estruturado
 *     (`serialized`) e o `ContextPack` do assembler continuam com os sete
 *     campos, intactos — `source_ref` é a chave para ler o resto quando
 *     precisar. Não há `kind` em `BriefKnowledgeItem` (a projeção genérica não
 *     carrega isso); o namespace do `source_ref` já é o discriminador
 *     canônico do gotcha em outro lugar do repo (`gotcha.ts`), então não
 *     precisa virar campo novo aqui.
 */
/**
 * 03e (D — brief parcial) — a nota explícita do que o orçamento de round 2
 * cortou. `NUNCA em silêncio`: um item que não coube tem que aparecer como
 * "sem orçamento", nunca como se tivesse sido tentado e falhado, e nunca
 * como se nem existisse. `undefined` (nada foi cortado — o caso comum, round
 * 2 quase sempre termina bem dentro do que sobra de 2700ms) omite a nota
 * por completo, mesma disciplina de `autonomousWarning`/`lastSessionLine`.
 *
 * `projectName`/`autonomousWarning`/`primeResult` não entram na lista: os
 * dois primeiros já degradam de forma auto-explicativa em
 * `buildAdditionalContext` (a linha inteira some, sem alegar erro) e o
 * terceiro nunca aparece no texto — é otimização de cache, não conteúdo.
 * `checkpoint`/`evidence` SÃO conteúdo que o usuário esperaria ver — por
 * isso ganham nota própria.
 */
/**
 * V3 (direcionamento consolidado §8/§10-H2, achado do orquestrador) — o
 * brief chegava a mostrar o CÓDIGO cru do warning (`"Avisos: FOREIGN_MANIFEST"`)
 * — nenhum código interno pode chegar ao texto entregue ao operador. Mapa
 * literal, um por `BriefWarning` — `FOREIGN_MANIFEST` é tratado à parte
 * (precisa citar caminho/nome do projeto envolvente, não cabe numa frase
 * fixa). Um código nunca visto aqui (drift de versão) vira "aviso interno:
 * <código>" em vez de propagar cru ou lançar.
 */
const WARNING_TRANSLATIONS: Record<Exclude<BriefWarning, "NO_PROJECT" | "FOREIGN_MANIFEST">, string> = {
  CONTINUITY_CONTEXT_INCOMPLETE: "memória de continuidade incompleta — parte dos registros não pôde ser recuperada",
  BINDING_MISMATCH: "vínculo do projeto diverge da fronteira observada agora (binding mismatch)",
  MANIFEST_UNBOUND: "manifest em formato legado, sem vínculo de fronteira declarado",
  KNOWLEDGE_UNREADABLE: "Store canônico existe mas uma leitura de conhecimento falhou",
  KNOWLEDGE_ANOMALOUS: "conhecimento canônico com registros divergentes/malformados — nenhum item válido sobrou",
  KNOWLEDGE_TIMEOUT: "leitura do conhecimento canônico excedeu o tempo limite",
};

function translateWarning(code: BriefWarning, brief: SessionBrief): string {
  if (code === "FOREIGN_MANIFEST") {
    const fm = brief.foreignManifest;
    const onde = fm ? `${fm.rootPath}, ${fm.projectName ?? fm.projectId ?? "id não lido"}` : "caminho não resolvido";
    return (
      `este projeto está dentro de outro projeto NexOS (${onde}) — ` +
      "este repositório tem fronteira própria (.git) e memória separada."
    );
  }
  const known = (WARNING_TRANSLATIONS as Record<string, string | undefined>)[code];
  return known ?? `aviso interno: ${code}`;
}

function buildOmittedNote(cortes: { readonly checkpoint: boolean; readonly evidence: boolean }): string | undefined {
  const itens: string[] = [];
  if (cortes.checkpoint) itens.push("tarefa/checkpoint");
  if (cortes.evidence) itens.push("evidência");
  if (itens.length === 0) return undefined;
  return `Aviso: sem orçamento de processo restante para resolver ${itens.join(" e ")} nesta abertura — brief parcial, nunca reportado como erro.`;
}

export function buildAdditionalContext(
  brief: SessionBrief,
  projectName: string | undefined,
  /**
   * Resultado JÁ RESOLVIDO de `last_verified` — ver `resolveDeclaredEvidence`.
   *
   *   SYNC PRESENTATION · ASYNC RESOLUTION
   *
   * Esta função é síncrona e continua síncrona: quem a chama direto (testes e
   * o adapter) não deve precisar de I/O para montar texto. A resolução, que é
   * assíncrona por natureza (lê o disco local e o HEAD do git), acontece no
   * caller, que já é `async`.
   *
   * Opcional, e o `undefined` NÃO é silêncio: com `last_verified` presente e
   * nenhum status resolvido, a linha sai como recusa explícita
   * (`NÃO RESOLVIDA`). `UNKNOWN != VERIFIED` — um caller que esqueceu de
   * resolver não ganha um `Verificado:` de graça.
   */
  evidence?: NamedEvidenceStatus,
  /**
   * A linha "Tarefa:" JÁ FORMATADA (`resolveCheckpointTaskLine`,
   * `checkpoint.ts`) — mesmo padrão de `evidence` acima: `SYNC PRESENTATION ·
   * ASYNC RESOLUTION`, esta função continua síncrona, e quem precisa de I/O
   * resolve ANTES de chamá-la. `undefined` (chamador que não resolveu) omite
   * a linha por completo — nunca um "NÃO RESOLVIDA" fabricado aqui.
   */
  taskLine?: string,
  /**
   * C1/C3 — as capabilities que a TAREFA declara (`checkpoint.content.
   * required_capabilities`), JÁ FORMATADAS (`resolveCheckpointCapabilityLines`,
   * `checkpoint.ts`) — mesmo padrão de `taskLine`: síncrono aqui, resolução
   * assíncrona no caller. `[]`/`undefined` omite o bloco por completo — nunca
   * um cabeçalho "Capabilities da tarefa:" vazio.
   *
   * `ProjectCapabilityIntent` (a política de capabilities do PROJETO inteiro,
   * `brief.capabilities`) saiu no corte presence/capability/observations
   * (nexos://decision/p0-corte-presence-capability-observations). Este bloco
   * é só a LINHAGEM de checkpoint corrente (`checkpoint.content.
   * required_capabilities`), que sobrevive.
   */
  capabilityLines?: readonly string[],
  /**
   * C2 (host event observation, continuação) — a linha "Última sessão: ..."
   * JÁ FORMATADA (`describeLastSessionOutcome`, `commands/boot.ts`) — MESMA
   * função e MESMO texto que `nexos boot` usa, nunca uma segunda cópia do
   * texto de `UNKNOWN`. Mesmo padrão de `taskLine`: síncrono aqui, resolução
   * (leitura limitada de `HostObservation`) acontece no caller. `undefined`
   * omite a linha — projeto sem nenhuma sessão observada não é aviso.
   */
  lastSessionLine?: string,
  /**
   * P1.2 (nexos://decision/p1-2-project-lifecycle) — `formatLifecycleLine`
   * JÁ formatada (`classifyProjectLifecycleForResolution`, no caller) — mesmo
   * padrão de `taskLine`/`lastSessionLine`: síncrono aqui, classificação
   * assíncrona no caller. `undefined` (deadline estourou ou chamador não
   * resolveu) omite a linha — nunca um procedimento fabricado aqui.
   */
  lifecycleLine?: string,
  /**
   * P1.5 (nexos://decision/p1-5-hot-brief) — seção 2 do HOT: resumo rico do
   * Project Map (`readMapSummary`, A14/`hot-brief.ts`) — os FATOS já
   * formatados ("rotas 6 em 4 arquivo(s) · modelos 11 · enums 6 (…)"), SEM
   * o rótulo "Mapa: " — a função de dados nunca decide apresentação. Este
   * renderer prefixa o rótulo (linha abaixo). Mesmo padrão síncrono de
   * `lifecycleLine`. `undefined` (mapa ausente — projeto NEW, nenhum fato
   * observável, ou leitura estourou o teto) omite a seção inteira, nunca um
   * "Mapa: " sem conteúdo.
   */
  mapSummaryLine?: string,
  /**
   * P1.5 — seção 3 do HOT: até 5 linhas de `architecture.md`
   * (`extractArchitectureSummaryLines`), sem a seção UNKNOWN. `undefined`/
   * `[]` omite a seção — nunca fabrica "arquitetura desconhecida".
   */
  architectureSummaryLines?: readonly string[],
  /**
   * P1.5b (fix nexos://decision/p1-5-hot-brief) — seção 4 do HOT:
   * `resolveCurrentStateLine` (mesma fonte que `boot.ts` usa para "Estado
   * atual:"), JÁ formatada como `Estado: ...` — mesmo padrão síncrono de
   * `lifecycleLine`. Usada só quando o bloco `project_state` de `items`
   * (abaixo) não rendeu "Estado:" — evita duplicar a linha quando o
   * ranking de `assembleContext` já incluiu o item.
   */
  currentStateLine?: string,
  /**
   * P1.3i (B5) — até 4 linhas JÁ FORMATADAS (`resolveLegacyStateNote`) sobre
   * `.nexos/memory/project/state.md` legado — só quando NÃO há head
   * canônico de `project_state` (o caller já garante isso antes de resolver:
   * `currentStateLine === undefined`). `undefined` (sem legado, ou já há
   * canônico) omite o bloco inteiro.
   */
  legacyStateLines?: readonly string[],
  /**
   * C8 (fatia C, orquestrador) — área de cobertura NÃO `analyzed`/`partial`
   * do Project Map, escrita por extenso (`buildCoverageLine`, `hot-brief.ts`)
   * — ex.: "routes unsupported — sem detector para C++". Mostrada no lugar
   * (ou além) da seção "Arquitetura:" quando esta está vazia: um projeto
   * vazio, stack sem detector, ou manifest do app corrompido não deve virar
   * silêncio nem "nada observado ainda" genérico quando HÁ um motivo
   * concreto para dizer. `undefined` (toda área coberta `analyzed`/
   * `partial` — nada de anormal) omite a linha.
   */
  coverageLine?: string,
  /**
   * C1 (fatia C, orquestrador) — "Mapa desatualizado: ..." JÁ FORMATADA
   * (`buildStaleMapLine`, no caller) para quando `checkMapFreshness` acusa
   * `stale` e `refreshMapIfStale` não coube no orçamento do processo (escopo
   * grande demais, timeout, ou orçamento já esgotado). Mesmo padrão síncrono
   * de `lifecycleLine`: só aparece quando o caller decidiu não convergir o
   * mapa dentro deste SessionStart. `undefined` (mapa fresco, ou já
   * convergido com sucesso) omite a linha.
   */
  staleLine?: string,
  /**
   * `MANUAL PATH SEES != AUTOMATIC PATH SEES` — projeção de agentes
   * desatualizada/órfã só aparecia em `nexos boot` (caminho manual), e é o
   * hook que define o que o humano de fato vê. Vazio quando não há projeção
   * (a maioria dos projetos) ou quando ela bate com o canônico.
   */
  agentProjectionLine?: string
): string {
  const lines: string[] = ["NexOS"];
  /**
   * P1.3i (B7) — sem manifest, a linha "Projeto sem identidade canônica ·
   * locator de bootstrap: ..." era jargão duplicado: `lifecycleLine` (abaixo)
   * já é uma frase completa e legível para NO_PROJECT/NEW, incluindo o
   * diretório quando faz sentido. `serialized` (o brief estruturado) continua
   * levando `brief.project.id` intacto — só a APRESENTAÇÃO em texto perde a
   * repetição.
   */
  if (brief.project.identity_source === "manifest") {
    lines.push(`Projeto: ${projectName ? `${projectName} · ${brief.project.id}` : brief.project.id}`);
  }
  if (lifecycleLine) lines.push(lifecycleLine);
  if (mapSummaryLine) lines.push(`Mapa: ${mapSummaryLine}`);
  if (architectureSummaryLines && architectureSummaryLines.length > 0) {
    lines.push("Arquitetura:");
    for (const l of architectureSummaryLines) lines.push(`  ${l}`);
  } else if (!coverageLine && architectureSummaryLines) {
    /**
     * P1.3i (B8) — `architectureSummaryLines` PRESENTE mas VAZIO (não
     * `undefined`) significa: `architecture.md` foi lido, e todo o conteúdo
     * está na seção UNKNOWN (`extractArchitectureSummaryLines` para antes
     * dela) — projeto novo ou stack sem detector, nunca "nada a mostrar em
     * silêncio". `undefined` (arquivo ausente — NEW, nunca mapeado) continua
     * omitindo a seção por completo, sem esta linha.
     *
     * C8 (fatia C, orquestrador) — só o fallback GENÉRICO cede lugar a
     * `coverageLine`: quando o Project Map sabe DIZER por que está vazio
     * (stack sem detector, manifest do app corrompido, projeto vazio), essa
     * frase concreta substitui o "nada observado ainda" — nunca as duas
     * juntas dizendo a mesma coisa de dois jeitos.
     */
    lines.push("Arquitetura: nada observado ainda (projeto novo ou stack sem detector).");
  }
  if (coverageLine) lines.push(coverageLine);
  if (staleLine) lines.push(staleLine);
  if (agentProjectionLine) lines.push(agentProjectionLine);

  const items = brief.knowledge?.items ?? [];
  const projectState = items.find((item) => item.source_ref === "nexos://project-state");
  let estadoRendered = false;
  if (projectState) {
    const fields = projectState.fields;
    if (fields.current_state) {
      lines.push(`Estado: ${fields.current_state}`);
      estadoRendered = true;
    }
    if (fields.global_goal) lines.push(`Objetivo: ${fields.global_goal}`);
    if (fields.next_action) lines.push(`Próxima ação: ${fields.next_action}`);
    if (fields.complete) lines.push(`Conclusão registrada: ${fields.complete}`);
    const blockerOrDecision = [fields.blocker, fields.decision_question].filter(Boolean).join(" · ");
    if (blockerOrDecision) lines.push(`Blocker/decisão: ${blockerOrDecision}`);
    if (fields.last_verified) lines.push(linhaDeEvidencia(fields.last_verified, evidence));
  }
  /**
   * P1.5b — fallback quando `assembleContext` não incluiu `project-state` no
   * ranking de `items` (medido: acontece neste repo) — `resolveCurrentStateLine`
   * já leu o MESMO head por fora, direto do Store. Nunca duplica: só entra
   * quando o bloco acima não rendeu "Estado:".
   */
  if (!estadoRendered && currentStateLine) lines.push(currentStateLine);
  /**
   * P1.3i (B5) — legado só aparece como estado quando NÃO há canônico nem
   * ranking (`estadoRendered`) nem fallback direto (`currentStateLine`) —
   * "Com project_state canônico: legado não aparece como estado."
   */
  if (!estadoRendered && !currentStateLine && legacyStateLines && legacyStateLines.length > 0) {
    lines.push(...legacyStateLines);
  }
  /** UMA linha, sempre depois do bloco `project_state` — nunca histórico. */
  if (taskLine) lines.push(taskLine);
  if (capabilityLines && capabilityLines.length > 0) lines.push(...capabilityLines);
  if (lastSessionLine) lines.push(lastSessionLine);

  /**
   * P1.3i (B7) — `NO_PROJECT` sai da lista de avisos exibida: é redundante
   * com `lifecycleLine`, que já é a frase completa (inclusive citando o
   * diretório). `brief.warnings` estruturado (`serialized`) continua
   * intacto — só a apresentação em texto some com a repetição.
   */
  const avisosExibidos = brief.warnings.filter((w) => w !== "NO_PROJECT");
  if (avisosExibidos.length > 0) {
    lines.push(`Avisos: ${avisosExibidos.map((w) => translateWarning(w, brief)).join(" | ")}`);
  }
  /**
   * P1.1 (nexos://decision/p1-1-resolver-fronteira-e-binding) — o brief curto
   * do NO_PROJECT: sem fronteira nenhuma, a única coisa acionável é apontar
   * os subdiretórios imediatos que TÊM `.git` — candidatos a serem o projeto
   * real que o operador quis abrir.
   *
   * C11 (fatia C, orquestrador) — essa lista SAIU daqui como linha própria:
   * `lifecycleLine` (`formatLifecycleLine`, `project-lifecycle.ts`) agora já
   * inclui os mesmos nomes dentro da frase "Contém repositório(s): ..." —
   * uma segunda linha repetiria a MESMA lista sob um rótulo diferente
   * ("Subpastas com .git: ..."). `brief.noProjectSiblings` estruturado
   * (`serialized`) continua intacto para quem consome o brief bruto; só a
   * apresentação em texto perdeu a duplicata.
   */

  /**
   * P1.5 — seção 5 do HOT: no máximo 5 decisões/gotchas, cada uma título +
   * source_ref (id) + UMA linha de regra. `items` já chega ordenado por
   * recency/marca (o MESMO ranking que `context-assembler.ts` usa para o
   * memory-recall — nenhum retrieval novo aqui, só um corte de exibição).
   * `Object.entries(item.fields)` SUMIU de propósito: era o dump do corpo
   * inteiro de uma Decision (`fields.decision`, 2-3 KB) — o motivo do brief
   * chegar a ~7,9 KB. O corpo continua recuperável por
   * `nexos memory --search`/`nexos decision`, nunca aqui.
   */
  const naoEstado = items.filter((item) => item !== projectState);
  const MAX_ITEMS_HOT = 5;
  const mostrados = naoEstado.slice(0, MAX_ITEMS_HOT);
  const cortadosPeloTeto = Math.max(0, naoEstado.length - mostrados.length);

  for (const item of mostrados) {
    lines.push("");
    lines.push(`- ${item.title} (${item.source_ref})`);
    const regra = summarizeFieldsToOneLiner(item.fields);
    if (regra) lines.push(`  regra: ${regra}`);
  }

  const titledPointers = (brief.knowledge?.pointers ?? []).filter((pointer) => pointer.title.length > 0);
  if (titledPointers.length > 0) {
    lines.push("");
    lines.push("Pointers:");
    for (const pointer of titledPointers) lines.push(`- ${pointer.title} (${pointer.source_ref})`);
  }

  if (brief.knowledge) {
    lines.push("");
    const omitidoTotal = brief.knowledge.omitted + cortadosPeloTeto;
    lines.push(
      `Contexto: ${mostrados.length} itens · ${omitidoTotal} omitidos — nexos memory --search / nexos decision para o corpo`
    );
  }

  //   DESCOBERTA BARATA, CORPO CARO SOB DEMANDA
  //
  // O brief conhecia o que o projeto LEMBRA e não o que ele PODE FAZER: um
  // agente recém-iniciado não sabia que existem capabilities, research ou
  // verificação, nem por qual comando chegar neles. Isso é lacuna de
  // DESCOBERTA, e ela se fecha com três linhas de ponteiro — não carregando
  // o corpo.
  //
  // MEDIDO em 2026-09-18: `capabilities --audit` custa ~840ms de ponta a
  // ponta, contra teto de PROCESS_WATCHDOG_MS (2700ms) que o adapter já gasta
  // com identidade, mapa e Store. Rodar o scan aqui compraria números que
  // quase ninguém usa ao preço do orçamento inteiro — o mesmo motivo pelo qual
  // o Contexto acima mostra 5 itens e aponta o resto.
  lines.push("");
  lines.push(
    "Capacidade (sob demanda, nada carregado aqui): nexos capabilities --for \"<tarefa>\" · nexos research --search <assunto> · nexos verify --subject <chk>"
  );

  return lines.join("\n");
}

/**
 * A linha que o modelo lê sobre verificação. Um id nu está PROIBIDO aqui.
 *
 *   HERDADO != REVERIFICADO   ·   UNKNOWN != VERIFIED
 *
 * `Verificado: ev_…` era o que saía antes, e é inauditável no ponto de
 * consumo: nada no texto permitia perguntar "de qual commit? de quando? a
 * árvore estava limpa?". Medido no Store real deste repo —
 * `ev_01M16MY1SNAKXDY89GV9CBBW83`, gate `test`, árvore SUJA, commit
 * `1c7e029f` — o boot imprimia aquele id como verdade corrente 34 commits
 * depois.
 *
 * Só `OK` escreve `Verificação:`, e escreve com os fatos que a tornam
 * FALSIFICÁVEL: gate, instante, commit curto e estado da árvore. Todo o resto
 * é rótulo de recusa carregando o motivo VERBATIM do validador — nunca
 * omissão, porque uma linha que some deixa o leitor com a impressão de que
 * nada foi declarado.
 */
function linhaDeEvidencia(declarado: string, status: NamedEvidenceStatus | undefined): string {
  if (!status) return `Evidência: NÃO RESOLVIDA (${declarado})`;
  if (status.state === "OK" && status.record) {
    const { gate, finished_at, commit, tree_state } = status.record;
    return `Verificação: ${gate} · ${finished_at} · commit ${commit?.slice(0, 7) ?? "?"} · tree ${tree_state}`;
  }
  if (status.state === "LEGACY") {
    return `Verificação declarada (legado): não validável — ${status.declared}`;
  }
  return `Evidência: ${status.state} — ${status.declared} · ${status.detail}`;
}

/**
 * Resolve o `last_verified` do head de `project_state` ANTES da apresentação.
 *
 *   PRESENTATION READ FAILURE != BOOT FAILURE
 *
 * O `catch` devolve `undefined` de propósito: I/O quebrado ao ler Evidence
 * degrada para a linha explícita `NÃO RESOLVIDA` (`linhaDeEvidencia`), nunca
 * derruba o SessionStart nem — pior — deixa passar um `Verificado:`. Mesmo
 * contrato de `readProjectName` logo acima.
 *
 * `undefined` quando não há `last_verified` nenhum: sem declaração não há o
 * que resolver, e a linha simplesmente não existe.
 */
async function resolveDeclaredEvidence(
  brief: SessionBrief,
  projectDir: string,
  cache: EvidenceCache | undefined
): Promise<NamedEvidenceStatus | undefined> {
  const declared = (brief.knowledge?.items ?? []).find(
    (item) => item.source_ref === "nexos://project-state"
  )?.fields.last_verified;
  if (!declared) return undefined;
  try {
    return await resolveNamedEvidence({ projectRoot: projectDir, declared, cache });
  } catch {
    return undefined;
  }
}

/**
 * Grava, na MESMA chave que `claude-user-prompt-submit` lê (projeto+sessão —
 * `lib/host/state-presentation.ts`), o id de `project_state` que este
 * SessionStart acabou de apresentar. NUNCA lança: prime é otimização de
 * apresentação, não contrato — falha aqui custa uma repetição futura, nunca
 * o brief que já foi entregue antes desta chamada.
 *
 * `identity` — 03e (orquestrador: "eliminar resolveProject/resolveReadRoot
 * repetidos"). ANTES, esta função re-chamava `resolveProject({cwd:
 * params.projectDir})` para obter o MESMO `bootstrapLocator`/`rootPath`/
 * `identitySource` que `runSessionStartAdapter` já tinha em `identity`,
 * calculado segundos antes na MESMA invocação. O comentário original temia
 * "reimplementar o hash aqui torcendo para bater" — risco real se alguém
 * recalculasse `bootstrapLocator` à mão, mas `identity.bootstrapLocator` é o
 * PRÓPRIO campo já resolvido pela função canônica, não uma reimplementação:
 * passar o objeto inteiro elimina a segunda chamada sem reabrir esse risco.
 *
 * `currentProjectStateHead` varre o MESMO Store que o pack de conhecimento —
 * 03c (continuação): em vez de um teto PRÓPRIO sobre uma leitura PRÓPRIA,
 * prime agora recebe `preloadedRecords` da MESMA leitura de `KnowledgeRecord`
 * que o adapter já fez uma vez (`ONE FAMILY READ PER SESSIONSTART`,
 * `runSessionStartAdapter`). Sem records pré-carregados — a leitura
 * compartilhada estourou o SEU teto — prime não tem o que procurar: devolve
 * `degraded: true` em vez de silenciar, porque "falha aqui não pode custar o
 * brief" não é o mesmo que "falha aqui nunca aparece em lugar nenhum".
 */
async function primePresentationCache(params: {
  identity: ProjectResolution;
  sessionId: string;
  presented: boolean;
  preloadedRecords: readonly CurrentRecord[] | undefined;
}): Promise<{ readonly degraded: boolean }> {
  if (!params.presented || params.sessionId.length === 0) return { degraded: false };
  if (!params.preloadedRecords) return { degraded: true };
  if (params.identity.identitySource !== "manifest" || !params.identity.rootPath) return { degraded: false };
  try {
    const head = await currentProjectStateHead(params.identity.rootPath, params.preloadedRecords);
    if (!head) return { degraded: false };
    await writePresentedId(presentationCacheFile(params.identity.bootstrapLocator, params.sessionId), head.id);
    return { degraded: false };
  } catch {
    /* prime é otimização — falha aqui não pode custar o brief, mas ainda é reportável */
    return { degraded: true };
  }
}

function isSessionStartSource(value: string): value is SessionStartSource {
  return (SESSION_START_SOURCES as readonly string[]).includes(value);
}

/**
 * Envelope de saída exigido pelo host. NÃO é escolha estética.
 *
 * A doc: *"Claude Code reads JSON output fields from stdout on every exit code"*
 * e *"With JSON that parses but fails schema validation … it's the same
 * non-blocking error … the `<hook name> hook error` notice carries the
 * validation message."*
 *
 * O brief serializado É JSON válido. Escrito cru no stdout, o host o parseia
 * como structured hook output, não encontra o schema esperado, e o contexto
 * **nunca é adicionado** — o hook vira erro em vez de injetar.
 *
 *   VALID JSON ON STDOUT  ->  PARSED AS HOOK OUTPUT, NOT AS CONTEXT
 *
 * Formato confirmado pelo próprio repo em
 * `assets/hooks/automation--agents-md-loader.json`.
 */
export interface SessionStartHookOutput {
  /**
   * B2, item 4 — campo UNIVERSAL de topo (`hooks.md` §"JSON output": "Warning
   * message shown to the user"), sibling de `hookSpecificOutput`, nunca
   * aninhado nele. Omitido por completo quando não há aviso — nunca
   * `systemMessage: undefined` explícito (ver A11 em
   * `tests/claude-session-start.test.ts`, que exige `Object.keys(out)` sem
   * chaves extras no caminho feliz).
   */
  readonly systemMessage?: string;
  readonly hookSpecificOutput: {
    readonly hookEventName: "SessionStart";
    /** O texto recebido, VERBATIM. `toHookOutput` não formata nem re-serializa. */
    readonly additionalContext: string;
  };
}

/**
 * `systemMessage` é o que o HUMANO vê (`hooks.md` §"JSON output"); o aviso
 * que o MODELO lê é o mesmo texto já prefixado a `additionalContext` por
 * `runSessionStartAdapter` — os dois canais carregam o aviso porque "pare e
 * reporte" é instrução para o agente, e o humano também precisa ver que o
 * modo está inseguro.
 */
export function toHookOutput(additionalContext: string, systemMessage?: string): SessionStartHookOutput {
  return {
    ...(systemMessage !== undefined ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

/**
 * Teto do PROCESSO inteiro (03 — host event observation, continuação) —
 * `TRAVE A ETAPA QUE TRAVAR`.
 *
 * `KNOWLEDGE_DEADLINE_MS`/`PRESENTATION_CACHE_DEADLINE_MS`/
 * o teto de host surface (removido em `0c0dc91e`) cobriam os três pontos que já sabíamos ser
 * lentos. `checkGateHealth` (subprocesso real via `execFile`),
 * `publishCanonical`, `resolveCheckpointPresentation` e
 * `resolveNamedEvidence` NUNCA tiveram teto próprio — threadar um racer por
 * função seria um diff por arquivo para o mesmo problema. Este watchdog
 * envolve `runSessionStartAdapter` INTEIRO: qualquer etapa sem teto próprio
 * que travar ainda cai sob este teto único, sem precisar nomear qual.
 *
 * 2700ms — 300ms de folga contra o orçamento de 3s do processo INTEIRO
 * (`claudeSessionStart`, `process.exit` no callback do stdout) — não mais
 * 2500ms "relativo ao adapter". Medido (13/09): a subida do Node + os
 * imports do próprio hook (tudo que roda ANTES de `runSessionStartAdapter`
 * começar) já consome uma fatia real do relógio do processo — um teto que
 * conta só o tempo do adapter deixa o total estourar 3s mesmo quando o
 * adapter, sozinho, respeitou o seu próprio relógio.
 *
 *   PER-STAGE DEADLINE BOUNDS ONE OPERATION · PROCESS WATCHDOG BOUNDS THE SUM
 *   · GLOBAL CEILING IS ANCHORED AT PROCESS START, NOT AT ADAPTER START
 *
 * Exportada (03e) para `scripts/repro-session-start-host.mts` calcular
 * `headroom` (quanto restava do orçamento quando o alvo terminou) sem
 * duplicar o número — `NÃO-FAZER: subir PROCESS_WATCHDOG_MS` continua valendo
 * porque isto é LEITURA, nunca escrita: o harness nunca importa isto para
 * decidir nada em produção, só para relatar a medição contra o MESMO teto.
 */
export const PROCESS_WATCHDOG_MS = 2_700;

/**
 * Teto do PROCESSO para abertura FRIA (03e — cold-path, decisão do dono
 * `dec_01M2FPAZKXR96QHAR18DCKKNC7`, 2026-09-14: "teto de processo MAIOR só
 * quando o cache de validação está frio ou inválido"). `PROCESS_WATCHDOG_MS`
 * continua sendo o teto de TODA abertura QUENTE — este é o único lugar que
 * troca para o teto largo, e só quando `detectColdCache` prova frio.
 *
 * Medido (commit 87c5be4, máquina calma, `scripts/repro-session-start-host.mts`):
 * frio virgem a 1,77x deu 5/5 `KNOWLEDGE_TIMEOUT` sob o teto de 2700ms — round
 * 1 sozinho (a leitura compartilhada de `KnowledgeRecord`/`Decision`/
 * `Research`, 1035+81 arquivos reais neste repo) não cabia. A 1,44x, 0/5.
 *
 * 8000ms — 2000ms de margem contra o timeout de **10 segundos** configurado
 * À MÃO, em produção, para este hook especificamente (`nexos claude-session-
 * start`, matcher `startup|resume|clear|compact|fork`, `~/.claude/settings.json`
 * do operador) — a MESMA classe de evidência que `CANONICAL_TIMEOUT_SECONDS`
 * (`lib/host/canonical-desired.ts`) já trata como autoritativa para outros
 * hooks ("valores reescritos à mão no host, em produção diária, são a melhor
 * evidência de intenção disponível"). NUNCA o default do host para hooks
 * `command` sem `timeout` declarado (600s, `hooks.md` §"Common fields") — esse
 * default só vale onde o asset não declara nada; `assets/settings.json` agora
 * declara `10` explicitamente para este hook, então 10s é o teto real a
 * respeitar, não 600s.
 *
 *   TETO FRIO < TIMEOUT DO HOST, SEMPRE — NUNCA O CONTRÁRIO
 *
 * Exportada pelo MESMO motivo de `PROCESS_WATCHDOG_MS`: leitura para medição
 * externa (`scripts/repro-session-start-host.mts`), nunca escrita — o harness
 * relata contra o teto, não decide um novo.
 */
export const PROCESS_WATCHDOG_COLD_MS = 8_000;

/**
 * Fração de arquivos das 3 families do boot (`BOOT_KNOWLEDGE_FAMILIES`) SEM
 * entrada no cache compartilhado, acima da qual `detectColdCache` classifica
 * a abertura como FRIA mesmo com `cache.entries.size > 0` (cache existente,
 * versão batendo, mas pequeno demais para o volume atual — ex.: import em
 * massa de `KnowledgeRecord` entre duas sessões).
 *
 * ponytail: erra para o lado de CONTINUAR quente — só classifica frio quando
 * a MAIORIA dos arquivos não tem entrada. "poucos arquivos novos" é a
 * operação NORMAL entre sessões (memória crescendo) e nunca deve pagar o teto
 * largo; um limiar apertado faria o teto frio disparar toda sessão comum,
 * devolvendo exatamente a lentidão que o teto de 2700ms existe para evitar.
 */
const COLD_CACHE_SPARSE_THRESHOLD = 0.5;

/**
 * Detecção de frio BARATA e DETERMINÍSTICA (03e — cold-path), chamada por
 * `resolveProcessCeiling` ANTES de `runSessionStartAdapter` — precisa
 * responder em milissegundos de repouso: `cache.coldness` já veio de graça de
 * `loadIntegrityCache` (nenhuma leitura nova), e `listYaml` é só `readdir` +
 * filtro de extensão, sem parse de conteúdo (mesma função que
 * `resolveLastSessionLine` já usa para `HostObservation`).
 *
 * Frio = cache AUSENTE (`coldness.kind !== "populated"`, cobre "nunca
 * escrito" e "corrompido" — o mesmo `catch` de `loadIntegrityCache` já tratava
 * os dois como o mesmo desfecho) OU versão do validador DIVERGENTE
 * (`"version_mismatch"`) OU vazio (`entries.size === 0`, o caso virgem) OU
 * cobertura ESPARSA (`COLD_CACHE_SPARSE_THRESHOLD`).
 *
 *   CACHE HIT SEM COBERTURA REAL != CACHE QUENTE
 *
 * Só os 3 diretórios LOCAIS de `BOOT_KNOWLEDGE_FAMILIES` — nunca `GLOBAL_ROOT`
 * (`includeGlobal`): esta é uma HEURÍSTICA barata para decidir o TETO do
 * processo, não uma segunda fonte de verdade sobre o que o brief vai
 * efetivamente ler.
 *
 * `cache.entries.size` mistura entradas de QUALQUER family que qualquer
 * leitura já validou nesta árvore (checkpoint, evidência, etc.), não só as 3
 * do boot — medido em produção (03e, node `03_host_event_observation`): 448
 * `KnowledgeRecord` + 316 `ProjectCheckpoint` = 764 entradas somadas contra
 * ~1400 arquivos SÓ de `KnowledgeRecord` classificava QUENTE uma abertura
 * com 60% dos arquivos do boot sem cache — as 316 entradas de checkpoint
 * (family que este boot nem lê) inflavam um denominador que a comparação
 * global tratava como se fosse cobertura real. `countCacheEntriesByFamily`
 * conta cada family separado (via `record.family`, presente em toda
 * `CapsuleRecord`) para que a fração descoberta seja calculada DENTRO de
 * cada family do boot, nunca cruzada com families que o boot não lê.
 *
 *   CACHE ENTRY DE OUTRA FAMILY != COBERTURA DESTA FAMILY
 *
 * Frio se QUALQUER família do boot estiver esparsa — hashear cada arquivo
 * para correspondência exata continua fora de escopo (o próprio custo que o
 * cache existe para evitar, só para decidir um teto).
 */
export async function detectColdCache(cache: IntegrityCache, rootPath: string): Promise<boolean> {
  if (cache.coldness.kind !== "populated") return true;
  if (cache.entries.size === 0) return true;
  const p = forProject(rootPath);
  const issues: IntegrityIssue[] = [];
  const fileCounts = await Promise.all(
    BOOT_KNOWLEDGE_FAMILIES.map((family) => listYaml(p.familyDir(family), issues))
  );
  const cachedByFamily = countCacheEntriesByFamily(cache, BOOT_KNOWLEDGE_FAMILIES);
  return BOOT_KNOWLEDGE_FAMILIES.some((family, index) => {
    const totalFiles = fileCounts[index]?.length ?? 0;
    if (totalFiles === 0) return false;
    const covered = cachedByFamily.get(family) ?? 0;
    const uncoveredFraction = Math.max(0, totalFiles - covered) / totalFiles;
    return uncoveredFraction > COLD_CACHE_SPARSE_THRESHOLD;
  });
}

/**
 * Cobertura do cache POR FAMILY do boot — ver `detectColdCache` acima para o
 * defeito que isto substitui (soma global cruzando families).
 */
function countCacheEntriesByFamily(
  cache: IntegrityCache,
  families: readonly RecordFamily[]
): ReadonlyMap<RecordFamily, number> {
  const counts = new Map<RecordFamily, number>(families.map((family) => [family, 0]));
  for (const entry of cache.entries.values()) {
    const family = recordFamilyOf(entry.record);
    if (family === undefined) continue;
    const current = counts.get(family);
    if (current !== undefined) counts.set(family, current + 1);
  }
  return counts;
}

/**
 * Extração defensiva do `family` de uma entrada de cache. `IntegrityCacheEntry.record`
 * é tipado `CapsuleRecord` (o schema garante `family` sempre presente), mas
 * `loadIntegrityCache` nunca valida o JSON lido do disco contra esse schema —
 * só a forma do envelope `{version, entries}` (`isOnDiskShape`). Um cache
 * gravado por código anterior a este campo, ou corrompido à mão, pode conter
 * uma entrada sem `family` nenhum; `undefined` aqui é o MESMO fail-open que
 * `loadIntegrityCache` já aplica ao arquivo inteiro, só descido ao nível de
 * uma entrada — a entrada simplesmente não conta a favor de NENHUMA family.
 */
function recordFamilyOf(record: CapsuleRecord): RecordFamily | undefined {
  return typeof record === "object" && record !== null && typeof record.family === "string"
    ? (record.family as RecordFamily)
    : undefined;
}

/**
 * Resolução ÚNICA (identity + cache compartilhado + veredito frio/quente),
 * ANTES do watchdog armar — para `runSessionStartAdapter` poder REUSAR o
 * MESMO load em vez de reabrir o arquivo de ~3,7MB uma segunda vez
 * (`ONE LOAD · ONE SAVE PER SESSIONSTART`, mesmo princípio já documentado no
 * topo de `runSessionStartAdapter`). `preloaded` viaja para o adapter mesmo
 * quando a abertura é QUENTE — o ganho de não reler o cache vale para os dois
 * casos, não só o frio.
 *
 * NUNCA lança: esta pré-checagem é otimização de TETO, não contrato — uma
 * falha aqui (identity quebrada, disco lento, o que for) não pode custar o
 * processo inteiro. `catch` devolve o teto FRIO como rede de segurança
 * (fail-open para o lado GENEROSO, nunca para o lado que reproduziria o
 * defeito medido) e `preloaded: undefined`, fazendo o adapter refazer a
 * resolução do zero exatamente como antes desta fatia.
 *
 * Sem deadline próprio, de propósito: as operações aqui (stat, um `readFile`,
 * `readdir`) são inerentemente limitadas pelo SO em operação normal — o
 * contrato desta fatia (decisão do dono) já exige que a detecção seja barata
 * por construção, não que ganhe um segundo watchdog para se proteger de si
 * mesma.
 */
async function resolveProcessCeiling(env: NodeJS.ProcessEnv): Promise<{
  readonly ceilingMs: number;
  readonly preloaded?: {
    readonly identity: ProjectResolution;
    readonly sharedReadRoot: string | undefined;
    readonly sharedIntegrityCache: IntegrityCache | undefined;
  };
}> {
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    /** O adapter valida e lança para esta MESMA condição logo a seguir — o
     *  watchdog só precisa de um teto para embrulhar essa falha, e o teto
     *  QUENTE já basta (o adapter nunca chega perto de estourá-lo aqui). */
    return { ceilingMs: PROCESS_WATCHDOG_MS };
  }
  try {
    // `cacheGitFacts: true` — ver comentário no outro chamador (`runSessionStartAdapter`).
    const identity = await resolveProject({ cwd: projectDir, cacheGitFacts: true });
    if (identity.identitySource !== "manifest" || !identity.rootPath) {
      return { ceilingMs: PROCESS_WATCHDOG_MS, preloaded: { identity, sharedReadRoot: undefined, sharedIntegrityCache: undefined } };
    }
    const sharedReadRoot = await resolveReadRoot(identity.rootPath);
    const sharedIntegrityCache = await loadIntegrityCache(sharedReadRoot);
    const cold = await detectColdCache(sharedIntegrityCache, identity.rootPath);
    return {
      ceilingMs: cold ? PROCESS_WATCHDOG_COLD_MS : PROCESS_WATCHDOG_MS,
      preloaded: { identity, sharedReadRoot, sharedIntegrityCache },
    };
  } catch {
    return { ceilingMs: PROCESS_WATCHDOG_COLD_MS };
  }
}

/**
 * `performance.now()` sem argumento é, em Node, milissegundos desde
 * `performance.timeOrigin` — que os docs do runtime definem como "the high
 * resolution millisecond timestamp at which the current process began".
 * Não é preciso capturar nada no topo do módulo: o relógio já É relativo ao
 * início do processo, de graça.
 *
 * `nowMs` é injetável só para teste (decisão 1: "com tempo decorrido
 * injetado, a trava sai dentro do restante") — produção nunca passa isto.
 */
function remainingProcessBudgetMs(ceilingMs: number, nowMs: () => number = () => performance.now()): number {
  return Math.max(0, ceilingMs - nowMs());
}

const WATCHDOG_SYSTEM_MESSAGE =
  "SessionStart não completou dentro do orçamento do processo — contexto mínimo entregue, degradado";

function minimalDegradedContext(watchdogMs: number): string {
  return [
    "NexOS",
    `AVISO: SessionStart não respondeu dentro do orçamento do processo (${watchdogMs}ms).`,
    "Contexto mínimo entregue — sem conhecimento canônico, checkpoint ou evidência nesta resposta.",
    "session.started pode não ter sido publicado nesta sessão; confira com `nexos boot`.",
  ].join("\n");
}

export interface SessionStartWatchdogResult {
  readonly hookOutput: SessionStartHookOutput;
  /** `true` = o teto do processo disparou; `hookOutput` é o fallback mínimo, não o brief real. */
  readonly degraded: boolean;
  /** Linha pronta para stderr quando o prime de apresentação degradou. `undefined` = nada a reportar. */
  readonly observationDiagnostic?: string;
}

/**
 * `runSessionStartAdapter` sob um teto de PROCESSO, não de estágio. NUNCA
 * lança: estourar o teto vira `degraded: true` com um brief mínimo — nunca
 * uma exceção que `claudeSessionStart` trataria como falha total (o que
 * apagaria até o pouco que já tinha sido resolvido).
 *
 * `runSessionStartAdapter` continua sendo o que os testes chamam DIRETO, sem
 * watchdog e sem `process.exit` — este wrapper é aditivo, nunca substitui o
 * contrato que a suíte de observação (A1-A14, `tests/claude-session-
 * start.test.ts`) já prova sobre o adapter puro.
 */
export async function runSessionStartWithWatchdog(
  input: SessionStartInput,
  env: NodeJS.ProcessEnv,
  /**
   * `undefined` (produção, sempre) — o orçamento vira o RESTANTE do teto
   * global a partir do início do PROCESSO (`remainingProcessBudgetMs`), não
   * um número fixo relativo a este ponto da chamada. Um número EXPLÍCITO
   * (testes) ainda funciona como antes.
   */
  watchdogMs?: number,
  nowMs?: () => number
): Promise<SessionStartWatchdogResult> {
  /**
   * `effectiveNowMs` propagado ao adapter (03e, D) — o MESMO relógio que
   * decide o teto do PROCESSO decide o teto de round 2 (`round2BudgetMs`) por
   * dentro do adapter: um `nowMs` injetado em teste tem que valer para os
   * DOIS níveis, ou um cobriria o outro e o teste não provaria nada sobre
   * round 2. Produção nunca injeta `nowMs` aqui, mas ainda assim resolve
   * `performance.now()` EXPLICITAMENTE antes de repassar — nunca deixa o
   * default do adapter (`() => 0`, pensado para chamadas diretas de teste
   * sem watchdog) propagar por omissão para o caminho real.
   */
  const effectiveNowMs = nowMs ?? (() => performance.now());
  /**
   * 03e (cold-path) — decide o teto ANTES de armar o watchdog, e resolve o
   * mesmo `identity`/cache compartilhado que o adapter reusa logo abaixo
   * (`preloaded`). Roda ANTES de `budget` ser calculado de propósito: em
   * produção `effectiveNowMs` é `performance.now()` ao vivo, então o tempo
   * gasto aqui já entra na conta do orçamento restante — nunca um teto extra
   * por fora do relógio âncorado no início do processo.
   */
  const { ceilingMs, preloaded } = await resolveProcessCeiling(env);
  const budget = watchdogMs ?? remainingProcessBudgetMs(ceilingMs, effectiveNowMs);
  const outcome = await withDeadline(
    runSessionStartAdapter(input, env, effectiveNowMs, ceilingMs, preloaded),
    budget
  );
  if (outcome.outcome === "resolved") {
    const { additionalContext, primeDegraded, sessionRecordDiagnostic } = outcome.value;
    const diagnosticoPrime = primeDegraded
      ? "[nexos claude-session-start] prime de apresentação não executado: leitura compartilhada de KnowledgeRecord estourou o deadline\n"
      : undefined;
    return {
      hookOutput: toHookOutput(additionalContext),
      degraded: false,
      observationDiagnostic: [diagnosticoPrime, sessionRecordDiagnostic].filter(Boolean).join(""),
    };
  }
  /**
   * `degraded: true` — o pior caso possível (fallback cego).
   */
  return {
    hookOutput: toHookOutput(minimalDegradedContext(budget), WATCHDOG_SYSTEM_MESSAGE),
    degraded: true,
  };
}

/**
 * Entrypoint do hook.
 *
 *   ADAPTER WRAPS THE STRING GIVEN, VERBATIM
 *   HOST TRANSPORT DOES NOT RE-SERIALIZE ANYTHING
 *
 * O envelope é do host; o conteúdo, dentro de `additionalContext`, é a
 * projeção legível construída por `buildAdditionalContext` a partir do
 * `SessionBrief` do Builder — não mais o JSON cru do brief (ver o campo
 * `additionalContext` de `SessionStartResult` para o porquê). O `SessionBrief`
 * estruturado continua existindo intacto em `serialized`, para quem precisar
 * dele fora deste hook. Diagnóstico em stderr. Falha ⇒ zero bytes em stdout.
 *
 * `process.exit()` depois do stdout escrito — a segunda metade do "deadline
 * real" da 03 (host event observation). `withDeadline` (`bootstrap-context.ts`)
 * decide o que ENTRA na resposta; não cancela o loser, porque `fs` assíncrono
 * do Node não é abortável sem threadar `AbortController` pelo Store inteiro.
 * Sem forçar a saída, a promise órfã de `assembleContext`/
 * `currentProjectStateHead` — descartada pelo deadline mas ainda rodando —
 * segura o event loop até terminar sozinha: medido, 17s de parede real neste
 * Store (3688 records) mesmo com os dois racers já respondendo em <1s cada.
 * O host mede o PROCESSO, não a promise resolvida — por isso o processo
 * precisa morrer aqui, não só "responder rápido". `runSessionStartAdapter`
 * (chamado direto pelos testes) nunca vê este `process.exit`: só o
 * entrypoint do CLI o executa.
 */
export async function claudeSessionStart(): Promise<void> {
  let input: SessionStartInput;
  try {
    input = parseInput(await readStdin());
  } catch (error) {
    fail(error);
    return;
  }

  try {
    const result = await runSessionStartWithWatchdog(input, process.env);
    /**
     * Diagnóstico em stderr, NUNCA em stdout: stdout é o envelope do host, e
     * qualquer byte extra ali quebra o parse e o contexto nunca é injetado.
     * Só fala quando falhou — `SKIPPED` é condição normal em projeto novo.
     */
    if (result.observationDiagnostic) process.stderr.write(result.observationDiagnostic);
    process.stdout.write(JSON.stringify(result.hookOutput), () => {
      process.exit(process.exitCode ?? 0);
    });
  } catch (error) {
    fail(error);
  }
}

function parseInput(raw: string): SessionStartInput {
  if (raw.trim().length === 0) {
    throw new SessionStartAdapterError("stdin vazio: esperado o payload JSON do hook");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SessionStartAdapterError(
      `stdin não é JSON válido: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SessionStartAdapterError("payload do hook não é um objeto");
  }
  return parsed as SessionStartInput;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Exit 1 é NON-BLOCKING no contrato de hooks do Claude: a sessão continua, e o
 * stderr aparece como aviso. Falhar alto é melhor que entregar brief errado.
 */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[nexos claude-session-start] ${message}\n`);
  process.exitCode = 1;
}
