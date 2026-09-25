/**
 * Harness V1 slice 1 — produtor de `ProjectCheckpoint`.
 *
 * ADR-038 (honrado, não revisitado): `ProjectCheckpoint` é a unidade de
 * execução. Sem `ExecutionNode` novo — o id (`chk_`, `ids.ts`), o diretório
 * (`checkpoints/`, `paths.ts`), a aresta (`previous_checkpoint_id`) e a
 * validação topológica (`integrity.ts:440-500`) já existem. Este módulo é o
 * produtor que faltava, não um modelo novo.
 *
 *   HOST EXECUTES · NEXOS GOVERNS · HARNESS ORCHESTRATES
 *
 * Este arquivo é orquestração de estado — NUNCA despacha para um host, nunca
 * chama `verifyFromEvidence`. Isso é slice 2, com consumidor.
 *
 * Persistência reusa `store.ts:290 publishSuperseding` — mesmo CAS
 * (no-clobber, claim-then-publish) que `state.ts`/`gotcha.ts` usam. Cada
 * checkpoint novo é um record IMUTÁVEL (ADR-049): "transição" nunca reescreve
 * um checkpoint existente, sempre PUBLICA um novo, encadeado por
 * `previous_checkpoint_id`. `lifecycle: "append-only"` — a chain cresce,
 * nunca supersede um nó anterior (`supersedes` fica de fora: essa é a
 * semântica de "mesmo conteúdo, versão nova", e não é o que uma cadeia causal
 * de execução representa).
 *
 * Cabeça da chain é computada por `scanIntegrity()` (`checkpointHeads`) — não
 * há um segundo cálculo de topologia aqui. `LIGAR, NÃO RECONSTRUIR`.
 */
import { readFile } from "node:fs/promises";
import { forProject } from "./paths.js";
import { newRecordId, parseRecordId, type RecordFamily } from "./ids.js";
import { parseCanonical } from "./codec.js";
import { validateRecord, type CapsuleRecord, type CheckpointState } from "./schemas.js";
import { scanIntegrity, readManifestProjectId, type IntegrityIssue } from "./integrity.js";
import { sha1Hex, type IntegrityCache } from "./integrity-cache.js";
import { resolveReadRoot } from "./authority.js";
import { resolveHeadsBySource, headFor } from "./head-resolver.js";
import {
  publishSuperseding,
  StoreBoundaryError,
  HeadRaceExhaustedError,
  type PublishOutcome,
} from "./store.js";
import {
  applyCheckpointTransition,
  applyCheckpointRetry,
  isTerminalState,
  nextStatesOf,
  type CheckpointTransitionVerdict,
} from "./checkpoint-transition.js";
import { assembleContext, type ContextPack } from "../context-assembler.js";
import type { VerificationBasis } from "./verification-basis.js";

/**
 * Uma lineage por projeto nesta fatia (ADR-046: sem `current_checkpoint_id`
 * mutável, status corrente é SEMPRE derivado da topologia). O valor só serve
 * para nomear o claim de CAS (`claimPath` em `store.ts`) — a aresta real é
 * `previous_checkpoint_id`, não este `source_ref`.
 */
export const CHECKPOINT_SOURCE_REF = "nexos://checkpoint";
const PRODUCER_ID = "nexos-checkpoint";

/** Códigos de `integrity.ts` que descrevem a topologia de checkpoint. */
const CHECKPOINT_TOPOLOGY_CODES = new Set<string>([
  "CHECKPOINT_SELF_LOOP",
  "CHECKPOINT_CYCLE",
  "DANGLING_PREDECESSOR",
  "PREDECESSOR_WRONG_FAMILY",
  "PREDECESSOR_WRONG_PROJECT",
]);

function isCheckpointRelevant(issue: IntegrityIssue, checkpointsDir: string): boolean {
  if (CHECKPOINT_TOPOLOGY_CODES.has(issue.code)) return true;
  if (issue.recordId && parseRecordId(issue.recordId)?.family === "ProjectCheckpoint") return true;
  if (issue.filePath?.startsWith(checkpointsDir)) return true;
  return false;
}

export interface CheckpointHeadInfo {
  readonly id: string;
  /** Âncora de continuidade derivada da cadeia íntegra; não concede autoridade. */
  readonly originCheckpointId?: string;
  readonly state: CheckpointState;
  readonly statement: string;
  readonly contractId: string | undefined;
  /** Contador de RETRY desta linhagem (`schemas.ts` content.attempt) — nunca o `maxAttempts` de CAS do Store. */
  readonly attempt: number;
  /**
   * D3 — quem solicitou a transição que produziu ESTE head. `undefined` é
   * UNKNOWN e nada mais: todo checkpoint anterior a 2026-08-27 não tem ator, e
   * deduzi-lo do estado seria inventar o fato que a métrica vai conferir.
   */
  readonly actorRef: string | undefined;
  /**
   * D9 — o nó do PLANO que esta linhagem executa. `undefined` = não declarado,
   * e o dispatch recusa por `NODE_UNMAPPED` em vez de escolher um nó.
   */
  readonly planNodeId: string | undefined;
  /**
   * C1 — capabilities que ESTA tarefa exige, vocabulário cru do registry
   * (ver `schemas.ts` `content.required_capabilities`). `undefined` = não
   * declarado, do mesmo jeito que `planNodeId`: ausência nunca vira lista
   * vazia inventada.
   */
  readonly requiredCapabilities: readonly string[] | undefined;
  /**
   * O elo que ESTE head sucede — `record.previous_checkpoint_id`, já existe
   * no envelope, só não era exposto aqui. `undefined` só na raiz da chain
   * (`previous_checkpoint_id: null`). Consumidor: `doctor.ts`
   * `medirEvidenciaDeCheckpoint` — a evidência que fechou `VERIFYING ->
   * SUCCEEDED` foi produzida com `subject_ref` = id do elo VERIFYING (que
   * virou ESTE `previousCheckpointId`), nunca o id novo que o SUCCEEDED nasce
   * com. `LIGAR, NÃO RECONSTRUIR`: lido do MESMO record que os outros campos,
   * nenhum resolvedor novo.
   */
  readonly previousCheckpointId: string | undefined;
}

export type CheckpointHeadResolution =
  | { readonly kind: "EMPTY" }
  | ({ readonly kind: "HEAD" } & CheckpointHeadInfo)
  /** Válida por construção (ADR-046) — nunca desempatada por relógio. */
  | { readonly kind: "DIVERGED"; readonly heads: readonly string[] }
  /** Topologia quebrada (ciclo/órfão/projeto estrangeiro) — a chain não é lida. */
  | { readonly kind: "UNHEALTHY"; readonly detail: string };

export type CheckpointWorkContext =
  | { readonly kind: "current"; readonly origin: string }
  | { readonly kind: "closed"; readonly origin: string }
  | { readonly kind: "undetermined" };

/**
 * Contrato único de contexto para writer, listagem, boot, recall e retomada.
 * FAILED encerra uma tentativa, não o objetivo: mantém contexto para retry.
 * SUCCEEDED encerra aplicabilidade atual; READY attempt=1 após um terminal
 * já recebeu outra origem pelo resolvedor. Não há estado CANCELLED neste
 * schema, e uma cadeia ilegível/ausente não prova encerramento. Nenhum desses
 * estados concede autoridade de execução.
 */
export function checkpointWorkContext(head: CheckpointHeadResolution): CheckpointWorkContext {
  if (head.kind !== "HEAD" || !head.originCheckpointId) return { kind: "undetermined" };
  return { kind: head.state === "SUCCEEDED" ? "closed" : "current", origin: head.originCheckpointId };
}

/**
 * `LIGAR, NÃO RECONSTRUIR`: a topologia inteira (self-loop, ciclo, predecessor
 * órfão, predecessor de outro projeto, divergência) já é validada por
 * `scanIntegrity()`. Esta função só INTERPRETA o veredito para a family
 * `ProjectCheckpoint` e, quando há exatamente um head saudável, lê o
 * conteúdo desse UM arquivo — não recomputa nada que o scanner já decidiu.
 *
 * Issues de OUTRAS families (um gotcha corrompido, por exemplo) não bloqueiam
 * a leitura da chain de checkpoint — `GLOBAL CAPSULE HEALTH != CHECKPOINT
 * CHAIN HEALTH`, o mesmo princípio que separa `checkCapabilityIntentTopology`
 * do resto do scanner.
 *
 * Authority-aware: `rootPath` é o CANDIDATO, resolvido para onde a authority
 * (se houver registro) diz que a chain mora de verdade
 * (`resolveReadRoot`, `authority.ts`) — sem isto, um checkout B REDIRECTED via
 * `advanceCheckpoint`/`publishSuperseding` escrevia em A e este leitor
 * continuava enxergando a PRÓPRIA partição vazia de B: `EMPTY` num checkout
 * que só nunca escreveu localmente, chain de verdade invisível.
 *
 * Ponto de entrada de UM TIRO — `dispatch.ts`, `doctor.ts`, `resumeCheckpoint`
 * chamam esta função uma vez por operação. O laço de CAS (`headForCas`,
 * abaixo) NÃO reusa este símbolo: ele recebe o read root JÁ resolvido pelo
 * chamador (`advanceCheckpoint`/`retryCheckpoint`) e opera direto em
 * `resolveCheckpointHeadAt`, para não re-resolver authority a cada tentativa
 * — ver a docstring de `headForCas`.
 *
 * `options.cache?.rootPath` — 03e (candidato 2, orquestrador): quando o
 * CHAMADOR já carregou o cache compartilhado via `loadIntegrityCache(sharedReadRoot)`
 * (`session-start.ts`), `cache.rootPath` JÁ É o resultado de
 * `resolveReadRoot` para o MESMO `rootPath` candidato — só
 * `resolveCheckpointPresentation` passa cache, e só com o cache que
 * `session-start.ts` construiu a partir de `identity.rootPath` (o mesmo
 * candidato). Reusar evita repetir a MESMA leitura de manifest + registry de
 * authority (`readManifestProjectId` + `peekActiveRoot`, I/O real) que
 * `sharedReadRoot` já pagou uma vez. Sem cache (todo outro chamador —
 * `dispatch.ts`/`doctor.ts`/CAS), comportamento idêntico a antes.
 */
export async function resolveCheckpointHead(
  rootPath: string,
  options: ResolveCheckpointHeadOptions = {}
): Promise<CheckpointHeadResolution> {
  const readRoot = options.cache?.rootPath ?? (await resolveReadRoot(rootPath));
  return resolveCheckpointHeadAt(readRoot, options.families, options.cache);
}

/**
 * A MESMA resolução, para quem JÁ resolveu o read root e não pode aceitar
 * outro no lugar dele.
 *
 *     MESMO ROOT PEDIDO != MESMO ROOT LIDO
 *
 * MEDIDO em 2026-09-19. A linha acima prefere `options.cache?.rootPath` ao
 * `rootPath` pedido, e a docstring explica por quê: o cache carrega junto o
 * root que `resolveReadRoot` já devolveu para o MESMO candidato, então reusar
 * economiza uma leitura de manifest + registry de authority. A premissa —
 * "só `resolveCheckpointPresentation` passa cache, e sempre com o cache do
 * próprio candidato" — é verdadeira hoje e **quebra em silêncio** no primeiro
 * chamador que passar um cache de outro root: o root do cache vence o root
 * pedido, sem erro, sem aviso.
 *
 * Foi exatamente o que aconteceu ao encadear o cache em `readCurrentRecords`:
 * na partição `includeGlobal`, `projectCheckpointHead` chamava com o read root
 * GLOBAL e recebia de volta o head do PROJETO, porque o cache era do projeto.
 * A leitura por family (root global) não continha esse head, e nascia uma
 * anomalia `MALFORMED` FALSA — o record existia, só não naquele root.
 *
 * Quem já tem o read root resolvido não passa por essa preferência. É o mesmo
 * idioma que `headForCas` usa há tempo ("recebe o read root JÁ resolvido pelo
 * chamador... para não re-resolver authority a cada tentativa"); a diferença é
 * que ali era economia e aqui é CORREÇÃO.
 */
export async function resolveCheckpointHeadNoRoot(
  readRoot: string,
  options: ResolveCheckpointHeadOptions = {}
): Promise<CheckpointHeadResolution> {
  return resolveCheckpointHeadAt(readRoot, options.families, options.cache);
}

export interface ResolveCheckpointHeadOptions {
  /**
   * Escopo de `scanIntegrity` (`integrity.ts`) — DEFAULT é a capsule inteira,
   * o mesmo que sempre rodou aqui. Um consumidor barato (linha de apresentação
   * de sessão, nunca o CAS) pode restringir a `["ProjectCheckpoint"]`: MESMO
   * validador, entrada menor. `dispatch.ts`/`doctor.ts`/`headForCas` continuam
   * chamando sem escopo — eles precisam da capsule inteira para não perder
   * corrupção de outra family que hoje já é reportada como `UNHEALTHY`.
   */
  readonly families?: readonly RecordFamily[];
  /**
   * 03e — OPT-IN, ver a MESMA docstring de `ScanIntegrityOptions.cache`
   * (`integrity.ts`). Só `resolveCheckpointPresentation` (session-start.ts)
   * liga isto — sabe que está sobre o checkout de trabalho local.
   * `dispatch.ts`/`doctor.ts`/CAS nunca passam cache.
   */
  readonly cache?: IntegrityCache;
}

/** Núcleo sem authority — opera exatamente no root recebido, já resolvido. */
async function resolveCheckpointHeadAt(
  readRoot: string,
  families?: readonly RecordFamily[],
  cache?: IntegrityCache
): Promise<CheckpointHeadResolution> {
  const report = await scanIntegrity(readRoot, { ...(families ? { families } : {}), cache });
  const checkpointsDir = forProject(readRoot).familyDir("ProjectCheckpoint");
  const relevant = report.issues.filter((i) => isCheckpointRelevant(i, checkpointsDir));

  if (relevant.length > 0) {
    return {
      kind: "UNHEALTHY",
      detail: relevant.map((i) => `${i.code}: ${i.detail}`).join(" | "),
    };
  }

  if (report.checkpointHeads.length === 0) return { kind: "EMPTY" };
  if (report.checkpointHeads.length > 1) {
    return { kind: "DIVERGED", heads: report.checkpointHeads };
  }

  const head = await loadCheckpointHead(readRoot, report.checkpointHeads[0]!, cache);
  if (head.kind !== "HEAD") return head;
  // Reusa os elos imutáveis já validados pelo scanner. Não cria task_id,
  // inferência pelo texto do prompt ou um campo canônico redundante.
  let cursor = head;
  const visited = new Set<string>();
  while (cursor.previousCheckpointId) {
    if (visited.has(cursor.id)) return { kind: "UNHEALTHY", detail: "cadeia mudou durante leitura da origem" };
    visited.add(cursor.id);
    const previous = await loadCheckpointHead(readRoot, cursor.previousCheckpointId, cache);
    if (previous.kind !== "HEAD") return previous;
    // O produtor reinicia attempt=1 apenas para trabalho novo. Retry aumenta
    // attempt; refinamento de statement/plano não troca a identidade.
    if (cursor.state === "READY" && cursor.attempt === 1 && isTerminalState(previous.state)) break;
    cursor = previous;
  }
  return { ...head, originCheckpointId: cursor.id };
}

/**
 * `cache` — 03e, SÓ LEITURA aqui (nunca grava): `scanIntegrity`, chamado
 * IMEDIATAMENTE antes em `resolveCheckpointHeadAt`, já populou o MESMO cache
 * com toda entrada PROVADA canônica (via `loadCanonicalRecord`, que verifica
 * `isCanonicalForm` antes de gravar). Esta função nunca checa forma canônica
 * — se ela gravasse cache por conta própria, um checkpoint schema-válido mas
 * NÃO-canônico entraria como se fosse canônico, e uma leitura futura via
 * `scanIntegrity` erraria `NON_CANONICAL_SERIALIZATION` silenciosamente. Cache
 * MISS aqui (arquivo alterado depois do scan, ou nunca provado canônico) cai
 * no caminho de sempre — nunca menos correto que antes desta fatia.
 */
async function loadCheckpointHead(
  rootPath: string,
  id: string,
  cache?: IntegrityCache
): Promise<CheckpointHeadResolution> {
  const filePath = forProject(rootPath).recordPath("ProjectCheckpoint", id);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    return { kind: "UNHEALTHY", detail: `head "${id}" não pôde ser lido: ${String(error)}` };
  }

  const cached = cache?.entries.get(sha1Hex(raw));
  let record: CapsuleRecord;
  if (cached) {
    record = cached.record;
  } else {
    let parsed: unknown;
    try {
      parsed = parseCanonical(raw);
    } catch (error) {
      return { kind: "UNHEALTHY", detail: `head "${id}" não é YAML canônico válido: ${String(error)}` };
    }

    const validated = validateRecord(parsed);
    if (!validated.ok) {
      return { kind: "UNHEALTHY", detail: `head "${id}" falhou o schema: ${validated.errors.join("; ")}` };
    }
    record = validated.value;
  }
  if (record.family !== "ProjectCheckpoint") {
    return { kind: "UNHEALTHY", detail: `head "${id}" não é ProjectCheckpoint (family="${record.family}")` };
  }

  return {
    kind: "HEAD",
    id: record.id,
    state: record.content.state,
    statement: record.content.statement,
    contractId: record.content.contract_id,
    attempt: record.content.attempt,
    actorRef: record.content.actor_ref,
    planNodeId: record.content.plan_node_id,
    requiredCapabilities: record.content.required_capabilities,
    previousCheckpointId: record.previous_checkpoint_id ?? undefined,
  };
}

/** Veredito da proposta contra o head — EMPTY tem regra própria (sem `atual` para comparar). */
function verdictFor(
  head: { readonly kind: "EMPTY" } | { readonly kind: "HEAD"; readonly state: CheckpointState },
  proposed: CheckpointState
): CheckpointTransitionVerdict {
  if (head.kind === "EMPTY") {
    return proposed === "PENDING"
      ? { allowed: true, why: "cadeia vazia — primeiro checkpoint nasce PENDING" }
      : {
          allowed: false,
          why: `cadeia vazia só aceita "PENDING" como primeiro estado; recebeu "${proposed}"`,
        };
  }
  return applyCheckpointTransition(head.state, proposed);
}

export class CheckpointDivergedError extends Error {
  constructor(readonly heads: readonly string[]) {
    super(
      `chain de checkpoint divergente: ${heads.length} heads (${heads.join(", ")}) — ` +
        "reconciliação explícita necessária; RECENCY != AUTHORITY (ADR-046)"
    );
    this.name = "CheckpointDivergedError";
  }
}

export class CheckpointChainUnhealthyError extends Error {
  constructor(detail: string) {
    super(`cadeia de checkpoint não íntegra: ${detail}`);
    this.name = "CheckpointChainUnhealthyError";
  }
}

/**
 * Adapter para `publishSuperseding.readHead` — chamado a CADA tentativa do
 * CAS, inclusive em retry. DIVERGED/UNHEALTHY viram exceção (nunca um valor
 * "vazio" fingido) porque `readHead` só pode devolver `Head | undefined`, e
 * `undefined` já tem o significado "cadeia vazia" — usá-lo também para
 * "cadeia quebrada" confundiria os dois.
 *
 * Recebe `readRoot` JÁ RESOLVIDO pelo chamador (`advanceCheckpoint`/
 * `retryCheckpoint`), nunca o `projectRoot` cru — de propósito: resolver
 * authority (`resolveReadRoot`, manifest + `peekActiveRoot`) É I/O, e este
 * adapter roda a CADA tentativa do laço de CAS. Resolver aqui dentro
 * adicionaria I/O ao caminho quente E poderia mudar o alvo NO MEIO de uma
 * corrida entre tentativas — a authority é resolvida UMA VEZ por chamada de
 * `advanceCheckpoint`/`retryCheckpoint`, fora do laço, e todas as tentativas
 * leem o MESMO root.
 */
async function headForCas(readRoot: string): Promise<CheckpointHeadInfo | undefined> {
  const resolution = await resolveCheckpointHeadAt(readRoot);
  switch (resolution.kind) {
    case "EMPTY":
      return undefined;
    case "HEAD":
      return resolution;
    case "DIVERGED":
      throw new CheckpointDivergedError(resolution.heads);
    case "UNHEALTHY":
      throw new CheckpointChainUnhealthyError(resolution.detail);
  }
}

export interface AdvanceCheckpointOptions {
  readonly projectRoot: string;
  /** Estado proposto para o NOVO checkpoint. */
  readonly state: CheckpointState;
  /**
   * Obrigatório na raiz da chain e quando o head é terminal e `state` é
   * `READY` (`SUCCEEDED`/`FAILED -> READY` é TAREFA NOVA, decisão do operador
   * 2026-09-07 — ver `checkpoint-transition.ts`) — nenhum dos dois casos tem
   * o que herdar. Nas demais transições, herdado do head quando omitido.
   */
  readonly statement?: string;
  /** Herdado do head quando omitido, EXCETO em tarefa nova a partir de um terminal — não herdado. */
  readonly contractId?: string;
  /**
   * D3 — quem SOLICITOU esta transição (papel ou identidade do agente).
   *
   *   ACTOR != PRODUCER
   *
   * NÃO é herdado do head, ao contrário de `statement` e `contractId`: herdar
   * ator faria o verifier fechar um checkpoint carimbado com o nome do builder,
   * que é precisamente o fato que `WHO BUILDS DOES NOT CLOSE` precisa detectar.
   * Ausente = UNKNOWN, nunca inferido.
   */
  readonly actorRef?: string;
  /**
   * D9 — o nó do PLANO que esta linhagem executa. HERDADO do head quando
   * omitido, como `statement` e `contractId` e ao contrário de `actorRef`: a
   * linhagem inteira é o MESMO trabalho planejado, e obrigar cada transição a
   * repetir a chave à mão faria o primeiro esquecimento devolver o dispatch a
   * `NODE_UNMAPPED` no meio da execução — perder a chave a meio caminho é pior
   * que nunca tê-la, porque acontece depois de o trabalho já ter começado.
   * EXCEÇÃO: tarefa nova a partir de um terminal (`SUCCEEDED`/`FAILED ->
   * READY`) não herda — é OUTRO trabalho planejado, não a mesma linhagem.
   */
  readonly planNodeId?: string;
  /**
   * C1 — capabilities que esta linhagem exige. HERDADO do head quando
   * omitido, mesma regra de `planNodeId` e pelo mesmo motivo: repetir a
   * declaração a cada transição faria o primeiro esquecimento apagar um
   * requisito já declarado no meio do trabalho. EXCEÇÃO igual: tarefa nova
   * a partir de um terminal não herda.
   */
  readonly requiredCapabilities?: readonly string[];
  /**
   * Base portátil de verificação (`verification-basis.ts`) que sustenta ESTA
   * transição — tipicamente `SUCCEEDED`, montada pelo caller a partir de
   * `verifyFromEvidence` (`commands/checkpoint.ts`).
   *
   *   PROOF OF THIS TRANSITION != PROOF OF THE LINEAGE
   *
   * NÃO herdada do head, mesma categoria de `actorRef` e pelo mesmo motivo:
   * herdar faria uma transição sem evidência nova carregar a prova de uma
   * transição anterior, apagando a diferença entre "provado agora" e "provado
   * antes". Gravada em `content.verification` só quando o chamador passa.
   */
  readonly verification?: readonly VerificationBasis[];
  /**
   * Só com `state: "SUPERSEDED"` e obrigatório nele: `nexos://decision/<chave>`
   * de uma decisão VIVA no Store — nexos://decision/checkpoint-estado-substituido.
   */
  readonly supersededBy?: string;
}

export type AdvanceCheckpointResult =
  | { readonly ok: true; readonly outcome: PublishOutcome; readonly record: CapsuleRecord; readonly attempts: number }
  | { readonly ok: false; readonly reason: "DIVERGED"; readonly heads: readonly string[] }
  | { readonly ok: false; readonly reason: "CHAIN_UNHEALTHY"; readonly detail: string }
  | { readonly ok: false; readonly reason: "TRANSITION_REJECTED"; readonly why: string }
  | { readonly ok: false; readonly reason: "MISSING_STATEMENT" }
  | { readonly ok: false; readonly reason: "MISSING_SUPERSEDED_BY" }
  | { readonly ok: false; readonly reason: "SUPERSEDED_BY_NOT_FOUND"; readonly ref: string }
  | { readonly ok: false; readonly reason: "SUPERSEDED_BY_ONLY_WITH_SUPERSEDED" }
  | { readonly ok: false; readonly reason: "STORE_ERROR"; readonly detail: string };

/**
 * Publica o PRÓXIMO checkpoint da chain: a raiz (quando a chain está vazia) ou
 * uma transição a partir do head atual.
 *
 * Identidade fixa por chamada (`id`, abaixo do laço de CAS) — só
 * `previous_checkpoint_id` e o conteúdo herdado mudam entre tentativas, mesmo
 * padrão de `state.ts`/`gotcha.ts`.
 *
 * A transição é validada DUAS vezes, de propósito: uma leitura rápida ANTES
 * de entrar no CAS (falha cedo, sem tocar disco, no caso comum) e outra
 * DENTRO de `buildRecord`, contra o head FRESCO de cada tentativa — é essa
 * segunda checagem que decide a disputa de "duas transições concorrentes para
 * o mesmo estado": o segundo escritor perde o claim, re-lê o head (já
 * avançado pelo primeiro) e sua transição original deixa de ser válida.
 *
 * `readRoot` é resolvido UMA VEZ aqui — antes da checagem rápida E antes do
 * laço de CAS — e reusado em `headForCas` a cada tentativa. Ver a docstring
 * de `headForCas` para o motivo.
 */
export async function advanceCheckpoint(options: AdvanceCheckpointOptions): Promise<AdvanceCheckpointResult> {
  const { projectRoot } = options;
  const p = forProject(projectRoot);
  const readRoot = await resolveReadRoot(projectRoot);

  const pre = await resolveCheckpointHeadAt(readRoot);
  if (pre.kind === "DIVERGED") return { ok: false, reason: "DIVERGED", heads: pre.heads };
  if (pre.kind === "UNHEALTHY") return { ok: false, reason: "CHAIN_UNHEALTHY", detail: pre.detail };

  const preVerdict = verdictFor(pre, options.state);
  if (!preVerdict.allowed) return { ok: false, reason: "TRANSITION_REJECTED", why: preVerdict.why };

  /** Retirar trabalho sem apontar QUEM decidiu seria o FAILED falso com outro nome. */
  if (options.state === "SUPERSEDED") {
    if (!options.supersededBy) return { ok: false, reason: "MISSING_SUPERSEDED_BY" };
    const decisoes = await resolveHeadsBySource(readRoot, "Decision");
    const alvo = decisoes.state === "RESOLVED" ? headFor(decisoes.bySource, options.supersededBy) : undefined;
    const viva =
      alvo?.state === "CURRENT" &&
      (alvo.record.content as { continuity?: { status?: string } }).continuity?.status !== "revoked";
    if (!viva) return { ok: false, reason: "SUPERSEDED_BY_NOT_FOUND", ref: options.supersededBy };
  } else if (options.supersededBy) {
    return { ok: false, reason: "SUPERSEDED_BY_ONLY_WITH_SUPERSEDED" };
  }

  /** Terminal -> READY é TAREFA NOVA (decisão do operador 2026-09-07): nada a herdar, `statement` obrigatório — mesma regra da raiz vazia. */
  const preIsNewTaskFromTerminal = pre.kind === "HEAD" && isTerminalState(pre.state) && options.state === "READY";
  if ((pre.kind === "EMPTY" || preIsNewTaskFromTerminal) && !options.statement) {
    return { ok: false, reason: "MISSING_STATEMENT" };
  }

  const issues: IntegrityIssue[] = [];
  const projectId = await readManifestProjectId(p.manifest(), issues);
  if (!projectId) {
    return { ok: false, reason: "CHAIN_UNHEALTHY", detail: issues.map((i) => i.detail).join("; ") };
  }

  const id = newRecordId("ProjectCheckpoint");
  const now = new Date().toISOString();

  try {
    const { outcome, record, attempts } = await publishSuperseding(projectRoot, {
      family: "ProjectCheckpoint",
      sourceRef: CHECKPOINT_SOURCE_REF,
      readHead: () => headForCas(readRoot),
      buildRecord: (head) => {
        const verdict = verdictFor(head ? { kind: "HEAD", state: head.state } : { kind: "EMPTY" }, options.state);
        if (!verdict.allowed) throw new StoreBoundaryError(verdict.why);

        /**
         * Terminal -> READY é TAREFA NOVA (decisão do operador 2026-09-07,
         * `checkpoint-transition.ts`): não continua a linhagem, então nada é
         * herdado além do link causal (`previous_checkpoint_id`) — mesmo
         * tratamento da raiz vazia para `statement`, e `attempt` reinicia em 1.
         */
        const newTaskFromTerminal = head !== undefined && isTerminalState(head.state) && options.state === "READY";

        const statement = newTaskFromTerminal ? options.statement : (options.statement ?? head?.statement);
        if (!statement) {
          throw new StoreBoundaryError(
            newTaskFromTerminal
              ? "statement obrigatório: tarefa nova a partir de um terminal não herda enunciado"
              : "statement obrigatório: cadeia vazia não tem o que herdar"
          );
        }
        const contractId = newTaskFromTerminal ? options.contractId : (options.contractId ?? head?.contractId);
        /** D9 — herança explícita: a chave atravessa a transição sem recópia manual (salvo tarefa nova, ver acima). */
        const planNodeId = newTaskFromTerminal ? options.planNodeId : (options.planNodeId ?? head?.planNodeId);
        /** C1 — mesma herança de `planNodeId`, mesma exceção de tarefa nova. */
        const requiredCapabilities = newTaskFromTerminal
          ? options.requiredCapabilities
          : (options.requiredCapabilities ?? head?.requiredCapabilities);
        const attempt = newTaskFromTerminal ? 1 : (head?.attempt ?? 1);

        return {
          schema_version: 1,
          id,
          project_id: projectId,
          family: "ProjectCheckpoint",
          previous_checkpoint_id: head?.id ?? null,
          scope: "project",
          origin: "agent",
          provenance: { source_ref: CHECKPOINT_SOURCE_REF, producer_id: PRODUCER_ID, submitted_at: now },
          lifecycle: "append-only",
          portability: "portable",
          regenerable: false,
          admission: {
            status: "admitted",
            /**
             * SEMPRE `policy:${PRODUCER_ID}` — SELF-EVOLUTION != SELF-TRUST (ADR-036).
             * Sem `--approved-by` (STORE AUTHORITY BOUNDARY V1, Frente B): o caller
             * não fornece proveniência, o Store deriva.
             */
            approved_by: `policy:${PRODUCER_ID}`,
            approved_at: now,
          },
          sensitivity: { classification: "internal", checked_at: now, checker_version: `${PRODUCER_ID}-1` },
          created_at: now,
          version: 1,
          content: {
            statement,
            state: options.state,
            /** Progresso NORMAL herda o attempt do head; tarefa nova de um terminal reinicia em 1; só `retryCheckpoint` incrementa. */
            attempt,
            ...(contractId ? { contract_id: contractId } : {}),
            ...(planNodeId ? { plan_node_id: planNodeId } : {}),
            /** C2 — dedupe + ordem canônica AQUI, uma vez, para todo chamador (CLI repetível inclusa) — nunca confiar que quem chamou já normalizou. */
            ...(requiredCapabilities && requiredCapabilities.length > 0
              ? { required_capabilities: [...new Set(requiredCapabilities)].sort() }
              : {}),
            /**
             * D3 — gravado SÓ quando o chamador declara. Nunca herdado do head:
             * herdar faria o verifier fechar com o carimbo do builder, apagando
             * a própria diferença que `WHO BUILDS DOES NOT CLOSE` mede.
             */
            ...(options.actorRef ? { actor_ref: options.actorRef } : {}),
            /**
             * NÃO herdado do head (ver docstring de `AdvanceCheckpointOptions.verification`)
             * — só gravado quando ESTA chamada traz prova.
             */
            ...(options.verification && options.verification.length > 0
              ? { verification: options.verification }
              : {}),
            ...(options.supersededBy ? { superseded_by: options.supersededBy } : {}),
          },
        } as CapsuleRecord;
      },
    });

    return { ok: true, outcome, record, attempts };
  } catch (error) {
    if (error instanceof CheckpointDivergedError) return { ok: false, reason: "DIVERGED", heads: error.heads };
    if (error instanceof CheckpointChainUnhealthyError) {
      return { ok: false, reason: "CHAIN_UNHEALTHY", detail: error.message };
    }
    if (error instanceof StoreBoundaryError) return { ok: false, reason: "TRANSITION_REJECTED", why: error.message };
    if (error instanceof HeadRaceExhaustedError) return { ok: false, reason: "STORE_ERROR", detail: error.message };
    throw error;
  }
}

export interface RetryCheckpointOptions {
  readonly projectRoot: string;
  /** Mesmo orçamento que `dispatch.ts` resolve (`resolveDispatchBudget`) — este produtor não tem opinião própria de default. */
  readonly maxAttempts: number;
}

export type RetryCheckpointResult =
  | { readonly ok: true; readonly outcome: PublishOutcome; readonly record: CapsuleRecord; readonly attempts: number }
  | { readonly ok: false; readonly reason: "EMPTY" }
  | { readonly ok: false; readonly reason: "DIVERGED"; readonly heads: readonly string[] }
  | { readonly ok: false; readonly reason: "CHAIN_UNHEALTHY"; readonly detail: string }
  | { readonly ok: false; readonly reason: "NOT_FAILED"; readonly state: CheckpointState }
  | { readonly ok: false; readonly reason: "BUDGET_EXHAUSTED"; readonly why: string }
  | { readonly ok: false; readonly reason: "TRANSITION_REJECTED"; readonly why: string }
  | { readonly ok: false; readonly reason: "STORE_ERROR"; readonly detail: string };

/**
 * Publica o checkpoint de RETRY: `FAILED` continua terminal (nada reescrito),
 * um NOVO `chk_` nasce com `previous_checkpoint_id` apontando para o
 * `FAILED` e `attempt` incrementado. Ver `applyCheckpointRetry` — a regra
 * mora lá, este produtor só a aplica com a mesma disciplina de dupla checagem
 * (pré-CAS + dentro de `buildRecord`, contra o head FRESCO) que
 * `advanceCheckpoint` já usa, pelo MESMO motivo: dois retries concorrentes só
 * podem produzir um vencedor.
 *
 * `readRoot`: mesma resolução ÚNICA fora do laço que `advanceCheckpoint` usa
 * — ver a docstring de `headForCas`.
 */
export async function retryCheckpoint(options: RetryCheckpointOptions): Promise<RetryCheckpointResult> {
  const { projectRoot, maxAttempts } = options;
  const p = forProject(projectRoot);
  const readRoot = await resolveReadRoot(projectRoot);

  const pre = await resolveCheckpointHeadAt(readRoot);
  if (pre.kind === "EMPTY") return { ok: false, reason: "EMPTY" };
  if (pre.kind === "DIVERGED") return { ok: false, reason: "DIVERGED", heads: pre.heads };
  if (pre.kind === "UNHEALTHY") return { ok: false, reason: "CHAIN_UNHEALTHY", detail: pre.detail };

  const preVerdict = applyCheckpointRetry(pre.state, pre.attempt, maxAttempts);
  if (!preVerdict.allowed) {
    return pre.state !== "FAILED"
      ? { ok: false, reason: "NOT_FAILED", state: pre.state }
      : { ok: false, reason: "BUDGET_EXHAUSTED", why: preVerdict.why };
  }

  const issues: IntegrityIssue[] = [];
  const projectId = await readManifestProjectId(p.manifest(), issues);
  if (!projectId) {
    return { ok: false, reason: "CHAIN_UNHEALTHY", detail: issues.map((i) => i.detail).join("; ") };
  }

  const id = newRecordId("ProjectCheckpoint");
  const now = new Date().toISOString();

  try {
    const { outcome, record, attempts } = await publishSuperseding(projectRoot, {
      family: "ProjectCheckpoint",
      sourceRef: CHECKPOINT_SOURCE_REF,
      readHead: () => headForCas(readRoot),
      buildRecord: (head) => {
        if (!head) throw new StoreBoundaryError("retry exige uma chain existente — cadeia vazia não tem FAILED para retentar");
        const verdict = applyCheckpointRetry(head.state, head.attempt, maxAttempts);
        if (!verdict.allowed) throw new StoreBoundaryError(verdict.why);

        return {
          schema_version: 1,
          id,
          project_id: projectId,
          family: "ProjectCheckpoint",
          previous_checkpoint_id: head.id,
          scope: "project",
          origin: "agent",
          provenance: { source_ref: CHECKPOINT_SOURCE_REF, producer_id: PRODUCER_ID, submitted_at: now },
          lifecycle: "append-only",
          portability: "portable",
          regenerable: false,
          admission: {
            status: "admitted",
            /** Sem `--approved-by` (Frente B) — sempre derivado, nunca fornecido. */
            approved_by: `policy:${PRODUCER_ID}`,
            approved_at: now,
          },
          sensitivity: { classification: "internal", checked_at: now, checker_version: `${PRODUCER_ID}-1` },
          created_at: now,
          version: 1,
          content: {
            statement: head.statement,
            /** Retry sempre renasce em READY — pronta para o próximo builder dispatch. */
            state: "READY",
            attempt: head.attempt + 1,
            ...(head.contractId ? { contract_id: head.contractId } : {}),
            /**
             * D9 — retry é a MESMA linhagem tentada de novo, logo o MESMO nó de
             * plano. Não herdar aqui faria o retry cair em `NODE_UNMAPPED`
             * exatamente quando o trabalho mais precisa de continuidade.
             */
            ...(head.planNodeId ? { plan_node_id: head.planNodeId } : {}),
            /** C1 — retry é a MESMA linhagem, logo o MESMO requisito — mesma herança que `plan_node_id` acima. */
            ...(head.requiredCapabilities && head.requiredCapabilities.length > 0
              ? { required_capabilities: head.requiredCapabilities }
              : {}),
          },
        } as CapsuleRecord;
      },
    });

    return { ok: true, outcome, record, attempts };
  } catch (error) {
    if (error instanceof CheckpointDivergedError) return { ok: false, reason: "DIVERGED", heads: error.heads };
    if (error instanceof CheckpointChainUnhealthyError) {
      return { ok: false, reason: "CHAIN_UNHEALTHY", detail: error.message };
    }
    if (error instanceof StoreBoundaryError) return { ok: false, reason: "TRANSITION_REJECTED", why: error.message };
    if (error instanceof HeadRaceExhaustedError) return { ok: false, reason: "STORE_ERROR", detail: error.message };
    throw error;
  }
}

export type ResumeCheckpointResult =
  | { readonly kind: "EMPTY"; readonly continuityIncomplete?: true }
  | { readonly kind: "DIVERGED"; readonly heads: readonly string[]; readonly continuityIncomplete?: true }
  | { readonly kind: "UNHEALTHY"; readonly detail: string; readonly continuityIncomplete?: true }
  | {
      readonly kind: "RESUMED";
      readonly checkpoint: CheckpointHeadInfo;
      /** `undefined` só quando o Store de conhecimento está ilegível — `BOOT MUST DEGRADE, NOT DIE`. */
      readonly context: ContextPack | undefined;
    };

/**
 * `SESSION != EXECUTION`. Uma sessão nova (processo novo, memória de processo
 * zerada) não reexecuta o checkpoint do head — só LÊ onde a chain está.
 * Nenhuma escrita acontece aqui: retomar não é a mesma coisa que despachar
 * (isso é slice 2). Prova disso é estrutural, não um `if`: esta função nunca
 * importa `publishCanonical`/`publishSuperseding`.
 *
 * Contexto adicional é montado com `checkpoint.content.statement` como
 * `intent` (`context-assembler.ts:249`) — furo medido em `session-start.ts:107`
 * era chamar sem intent (scoring roda contra string vazia); aqui o intent
 * real do checkpoint alimenta o assembler desde a primeira chamada.
 */
export async function resumeCheckpoint(
  rootPath: string,
  budgetBytes?: number
): Promise<ResumeCheckpointResult> {
  const resolution = await resolveCheckpointHead(rootPath);
  if (resolution.kind !== "HEAD") {
    // A cadeia ausente/ilegível não apaga as decisões que ainda a referenciam.
    // Reusa o assembler também para comunicar esse contexto indeterminado.
    const assembled = await assembleContext({ projectRoot: rootPath, ...(budgetBytes !== undefined ? { budgetBytes } : {}) });
    return { ...resolution, ...(assembled.ok && assembled.pack.continuityIncomplete ? { continuityIncomplete: true as const } : {}) };
  }

  const assembled = await assembleContext({
    projectRoot: rootPath,
    intent: resolution.statement,
    /** T5 (§4.4, R16) — o head já resolvido É o checkpoint ativo desta retomada. */
    activeTaskRef: resolution.id,
    ...(budgetBytes !== undefined ? { budgetBytes } : {}),
  });

  return {
    kind: "RESUMED",
    checkpoint: {
      id: resolution.id,
      originCheckpointId: resolution.originCheckpointId,
      state: resolution.state,
      statement: resolution.statement,
      contractId: resolution.contractId,
      /** Repassado como veio: resume não é o autor da transição que retoma. */
      actorRef: resolution.actorRef,
      planNodeId: resolution.planNodeId,
      requiredCapabilities: resolution.requiredCapabilities,
      attempt: resolution.attempt,
      previousCheckpointId: resolution.previousCheckpointId,
    },
    context: assembled.ok ? assembled.pack : undefined,
  };
}

const TASK_LINE_TEXT_MAX_CHARS = 120;

function truncarParaLinha(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

/**
 * A linha "Tarefa:" barata que `session-start.ts` e `boot.ts` imprimem —
 * puramente descritiva sobre uma `CheckpointHeadResolution` já em mãos, nunca
 * escreve e nunca dispara `advanceCheckpoint`.
 *
 *   ONE LINE, NEVER HISTORY
 *
 * Formato por `kind`, decidido pelo handoff que fecha esta fatia: terminal
 * (`SUCCEEDED`/`FAILED`) tem prefixo próprio ("concluída"/"falhou");
 * `BLOCKED`/`HUMAN_REQUIRED` tem prefixo "bloqueada"; todo o resto mostra o
 * estado, a tentativa e as arestas de saída (`nextStatesOf`, sem duplicar a
 * tabela de `checkpoint-transition.ts`).
 *
 * P1.3i (B6) — `EMPTY` devolve `undefined`, não mais o texto
 * "Tarefa: nenhuma (chain vazia)". Chain vazia é o estado NORMAL de um
 * projeto recém-canônico que ainda não abriu nenhum checkpoint — não é uma
 * recusa nem um dado que faltou resolver (ao contrário de `DIVERGED`/
 * `UNHEALTHY`, que continuam com linha própria: ali HÁ algo errado a
 * reportar). `SessionStart`/`nexos boot` já tratam `undefined` como "omitir a
 * linha" (mesmo padrão de `taskLine?: string` em todo o resto do brief) —
 * texto vazio nunca mais chega ao Claude como se fosse informação.
 */
export function describeCheckpointTaskLine(resolution: CheckpointHeadResolution): string | undefined {
  switch (resolution.kind) {
    case "EMPTY":
      return undefined;
    case "DIVERGED":
      return `Tarefa: chain não legível — ${truncarParaLinha(`${resolution.heads.length} heads: ${resolution.heads.join(", ")}`, TASK_LINE_TEXT_MAX_CHARS)}`;
    case "UNHEALTHY":
      return `Tarefa: chain não legível — ${truncarParaLinha(resolution.detail, TASK_LINE_TEXT_MAX_CHARS)}`;
    case "HEAD": {
      const statement = truncarParaLinha(resolution.statement, TASK_LINE_TEXT_MAX_CHARS);
      const origin = resolution.originCheckpointId ? ` · origem ${resolution.originCheckpointId}` : "";
      if (resolution.state === "SUCCEEDED") return `Tarefa concluída: ${statement} · SUCCEEDED · ${resolution.id}${origin}`;
      if (resolution.state === "FAILED") return `Tarefa falhou: ${statement} · FAILED · ${resolution.id}${origin}`;
      const proximo = nextStatesOf(resolution.state).join(" | ");
      if (resolution.state === "BLOCKED" || resolution.state === "HUMAN_REQUIRED") {
        return `Tarefa bloqueada: ${statement} · ${resolution.state} · próximo: ${proximo}${origin}`;
      }
      return `Tarefa: ${statement} · ${resolution.state} · tentativa ${resolution.attempt} · próximo: ${proximo} · ${resolution.id}${origin}`;
    }
  }
}

/**
 * `describeCheckpointTaskLine` com resolução E degradação de I/O embutidas —
 * o par pronto para um caller assíncrono (`session-start.ts`, `boot.ts`).
 * Escopado a `["ProjectCheckpoint"]` (`ScanIntegrityOptions`, `integrity.ts`)
 * de propósito: MESMO validador que `resolveCheckpointHead` sempre foi, só
 * com entrada menor — não há um segundo resolvedor de head aqui.
 *
 *   PRESENTATION READ FAILURE != BOOT FAILURE
 *
 * Mesmo contrato de `resolveDeclaredEvidence`/`readProjectName`
 * (`session-start.ts`): qualquer falha de leitura degrada para a recusa
 * explícita, nunca propaga para o caminho de boot.
 */
export async function resolveCheckpointTaskLine(rootPath: string): Promise<string | undefined> {
  try {
    const resolution = await resolveCheckpointHead(rootPath, { families: ["ProjectCheckpoint"] });
    return describeCheckpointTaskLine(resolution);
  } catch {
    return "Tarefa: NÃO RESOLVIDA";
  }
}

/**
 * C3 — a projeção "Capabilities da tarefa:" que `session-start.ts`,
 * `boot.ts` e `commands/checkpoint.ts` imprimem. Irmã de
 * `describeCheckpointTaskLine`: pura, opera sobre uma
 * `CheckpointHeadResolution` já em mãos, nunca escreve.
 *
 *   HEAD SEM O CAMPO -> NENHUMA LINHA
 *
 * Ao contrário da linha "Tarefa:", uma cadeia EMPTY/DIVERGED/UNHEALTHY não
 * ganha linha de recusa aqui: ausência de capabilities declaradas nunca foi
 * erro a reportar, diferente da ausência de um head legível.
 */
export function describeCheckpointCapabilityLines(resolution: CheckpointHeadResolution): readonly string[] {
  if (resolution.kind !== "HEAD") return [];
  const ids = resolution.requiredCapabilities;
  if (!ids || ids.length === 0) return [];
  return ["Capabilities da tarefa:", ...ids.map((id) => `- ${id}`)];
}

/**
 * `describeCheckpointCapabilityLines` com resolução E degradação de I/O
 * embutidas — mesmo par pronto pra caller assíncrono que
 * `resolveCheckpointTaskLine` já oferece, mesmo escopo
 * (`["ProjectCheckpoint"]`, MESMO validador, entrada menor).
 *
 *   PRESENTATION READ FAILURE != BOOT FAILURE
 *
 * `catch` devolve `[]`: uma falha de leitura aqui custa a lista de
 * capabilities no brief, nunca o brief inteiro.
 */
export async function resolveCheckpointCapabilityLines(rootPath: string): Promise<readonly string[]> {
  try {
    const resolution = await resolveCheckpointHead(rootPath, { families: ["ProjectCheckpoint"] });
    return describeCheckpointCapabilityLines(resolution);
  } catch {
    return [];
  }
}

export interface CheckpointPresentation {
  /** `undefined` só para chain EMPTY (B6) — omitida, nunca "nenhuma (chain vazia)". */
  readonly taskLine: string | undefined;
  readonly capabilityLines: readonly string[];
  /**
   * O id do head resolvido, quando `resolution.kind === "HEAD"` — `undefined`
   * para EMPTY/DIVERGED/UNHEALTHY. Adicionado pro registro de sessão
   * (`Session.content.checkpoint_id`, `session-start.ts`) reusar a MESMA
   * resolução que já paga aqui, em vez de uma segunda chamada a
   * `resolveCheckpointHead` — `taskLine`/`capabilityLines` já derivam do
   * mesmo `resolution`, só nunca expunham o id cru.
   */
  readonly id: string | undefined;
  /**
   * P1.5b (fix nexos://decision/p1-5-hot-brief) — `true` quando o head é
   * BLOCKED/HUMAN_REQUIRED. O corte presence/capability/observations (P0)
   * removeu o execution-graph inteiro: nenhum `planNodeId` referenciado por
   * um head bloqueado é verificável hoje, então todo bloqueio é stale por
   * construção — não há registro vivo para distinguir "nó real" de "nó
   * morto" sem inventar um resolver novo (fora do escopo). `nexos boot`
   * (relatório completo) continua mostrando `taskLine` de qualquer estado,
   * sem mudança; só o brief HOT (`session-start.ts`) usa este campo para
   * omitir a linha — `PRESENTATION READ FAILURE != BOOT FAILURE` aplicado
   * ao inverso: um dado presente mas não-acionável também não é HOT.
   */
  readonly blocked: boolean;
}

/**
 * `resolveCheckpointTaskLine` + `resolveCheckpointCapabilityLines` fundidos
 * numa ÚNICA leitura — `session-start.ts` e `boot.ts` chamavam os dois
 * wrappers em sequência, cada um resolvendo o head de novo. Entre as duas
 * chamadas uma transição concorrente podia fazer "Tarefa:" e "Capabilities da
 * tarefa:" descreverem heads DIFERENTES (`READ TORN ACROSS TWO CALLS`). Mesma
 * degradação dos dois wrappers que substitui nesses dois callers:
 * `PRESENTATION READ FAILURE != BOOT FAILURE`.
 */
/**
 * `cache` — 03e, OPT-IN (default ausente), mesma disciplina de
 * `ReadOptions.integrityCache` (`reader.ts`): `resolveCheckpointPresentation`
 * também é chamada por `commands/boot.ts`, que um humano pode rodar logo após
 * clonar — sem opt-in explícito, cache automático aqui correria o mesmo risco
 * que `scanIntegrity`/`loadFamilyForResolution` já mediram (A03). Esta função
 * só USA — nunca carrega nem grava sozinha (`ONE LOAD · ONE SAVE · CALLER
 * OWNS THE LIFECYCLE`, medido: a versão anterior desta opção era um booleano
 * que fazia esta função carregar/gravar o MESMO arquivo de cache que
 * `readCurrentRecords` já tinha carregado/gravado — DUAS vezes por
 * SessionStart, ~3,7MB cada, orquestrador mediu e apontou). Só
 * `session-start.ts` constrói e persiste o cache, compartilhado com a
 * leitura de knowledge — sabe que está sobre o checkout de trabalho.
 */
export async function resolveCheckpointPresentation(
  rootPath: string,
  cache?: IntegrityCache
): Promise<CheckpointPresentation> {
  try {
    const resolution = await resolveCheckpointHead(rootPath, { families: ["ProjectCheckpoint"], cache });
    return {
      taskLine: describeCheckpointTaskLine(resolution),
      capabilityLines: describeCheckpointCapabilityLines(resolution),
      blocked: resolution.kind === "HEAD" && (resolution.state === "BLOCKED" || resolution.state === "HUMAN_REQUIRED"),
      id: resolution.kind === "HEAD" ? resolution.id : undefined,
    };
  } catch {
    return { taskLine: "Tarefa: NÃO RESOLVIDA", capabilityLines: [], blocked: false, id: undefined };
  }
}
