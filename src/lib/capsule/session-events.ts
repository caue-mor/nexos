/**
 * Registro de sessão (18/09) — os DOIS eventos da family `Session`
 * (`schemas.ts`): `started` (produzido por `session-start.ts`) e `closed`
 * (produzido por `session-close.ts`). Ver a docstring de `SessionStartedSchema`
 * em `schemas.ts` para o desenho completo (event-log, não chain; por quê
 * `publishCanonical` sem CAS; por quê `scope.kind === "session"`).
 *
 * FAIL-OPEN ABSOLUTO: as duas funções aqui NUNCA lançam. Disco cheio,
 * permissão, Store ilegível, `project_id` não resolvido — tudo vira
 * `{ok:false, detail}`. O registro de sessão é útil; o brief do SessionStart
 * (e o silêncio esperado do SessionEnd) é o produto — nenhum dos dois pode
 * depender desta escrita.
 */
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { newRecordId } from "./ids.js";
import { publishCanonical } from "./store.js";
import { forProject } from "./paths.js";
import { parseCanonical } from "./codec.js";
import { listYaml, type IntegrityIssue } from "./integrity.js";
import {
  validateRecord,
  type CapsuleRecord,
  type SessionStartedSchema,
  type SessionClosedSchema,
  type SessionForgottenSchema,
} from "./schemas.js";

type SessionStarted = z.infer<typeof SessionStartedSchema>;
type SessionClosed = z.infer<typeof SessionClosedSchema>;
type SessionForgotten = z.infer<typeof SessionForgottenSchema>;

const PRODUCER_START = "nexos-session-start";
const PRODUCER_CLOSE = "nexos-session-close";
const PRODUCER_FORGET = "nexos-sessions-forget";

/**
 * `source_ref` de um evento de sessão.
 *
 *   ONE SOURCE_REF PER EVENT != ONE SOURCE_REF PER LINEAGE
 *
 * Era derivado só de `session_id` + `kind`, e a docstring de
 * `SessionStartedSchema` já prometia que cada evento tem o seu, "nunca
 * reusado por outro record". A promessa não se sustentava: o host dispara
 * SessionStart mais de uma vez para a MESMA sessão, e dois records passavam a
 * disputar o mesmo `source_ref` — que é exatamente o que `head-resolver.ts`
 * chama de DIVERGED e o `doctor` reporta como CANONICAL_STORE_UNREADABLE.
 *
 * MEDIDO no Store deste projeto, 5 linhagens com 2 heads, em dois cenários:
 * 9 segundos de intervalo com conteúdo idêntico (disparo duplo) e 15 horas
 * com `checkpoint_id` diferente (resume). Nenhum é corrupção — os records
 * estão certos; quebrou a unicidade.
 *
 * O id do próprio record é o discriminador: já existe, é ULID, não custa
 * scan da family nem CAS — preserva o motivo declarado de não haver chain
 * aqui (o orçamento de 2700ms do SessionStart). A correlação entre eventos
 * continua sendo `scope.ref`, nunca o `source_ref`, como o desenho diz.
 */
const sourceRefDoEvento = (sessionId: string, kind: string, recordId: string): string =>
  `nexos://session/${sessionId}/${kind}/${recordId}`;

export interface SessionEventResult {
  readonly ok: boolean;
  /** Presente só quando `ok === false` — motivo, nunca o brief/stdout. */
  readonly detail?: string;
}

export interface WriteSessionStartedParams {
  readonly rootPath: string;
  readonly projectId: string;
  readonly sessionId: string;
  /** `identity.rootPath` no instante do SessionStart — observação, não identidade (ver session-close.ts). */
  readonly cwd: string;
  /** `input.agent_type ?? null` — nunca inferido de correlação de session_id (ver schemas.ts). */
  readonly agentRef: string | null;
  /** Head de `ProjectCheckpoint` já resolvido por quem chama (`CheckpointPresentation.id`) — nunca uma segunda resolução aqui. */
  readonly checkpointId: string | null;
}

export async function writeSessionStarted(params: WriteSessionStartedParams): Promise<SessionEventResult> {
  try {
    const now = new Date().toISOString();
    const recordId = newRecordId("Session");
    const record: CapsuleRecord = {
      schema_version: 1,
      id: recordId,
      family: "Session",
      kind: "started",
      project_id: params.projectId,
      scope: { kind: "session", ref: params.sessionId },
      origin: "hook",
      provenance: {
        source_ref: sourceRefDoEvento(params.sessionId, "started", recordId),
        producer_id: PRODUCER_START,
        submitted_at: now,
      },
      lifecycle: "immutable",
      portability: "portable",
      regenerable: false,
      admission: { status: "admitted", approved_by: `policy:${PRODUCER_START}`, approved_at: now },
      sensitivity: { classification: "internal", checked_at: now, checker_version: `${PRODUCER_START}-1` },
      created_at: now,
      version: 1,
      content: {
        host: os.hostname(),
        cwd: params.cwd,
        agent_ref: params.agentRef,
        checkpoint_id: params.checkpointId,
      },
    };
    const result = await publishCanonical(params.rootPath, record);
    if (result.outcome === "CONFLICT") {
      return { ok: false, detail: `conflito de id em ${result.canonicalPath} — ULID reusado, não deveria acontecer` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface WriteSessionClosedParams {
  readonly rootPath: string;
  readonly projectId: string;
  readonly sessionId: string;
  /** `input.reason` do payload SessionEnd — `null` quando ausente/inválido. */
  readonly reason: string | null;
}

export async function writeSessionClosed(params: WriteSessionClosedParams): Promise<SessionEventResult> {
  try {
    const now = new Date().toISOString();
    const recordId = newRecordId("Session");
    const record: CapsuleRecord = {
      schema_version: 1,
      id: recordId,
      family: "Session",
      kind: "closed",
      project_id: params.projectId,
      scope: { kind: "session", ref: params.sessionId },
      origin: "hook",
      provenance: {
        source_ref: sourceRefDoEvento(params.sessionId, "closed", recordId),
        producer_id: PRODUCER_CLOSE,
        submitted_at: now,
      },
      lifecycle: "immutable",
      portability: "portable",
      regenerable: false,
      admission: { status: "admitted", approved_by: `policy:${PRODUCER_CLOSE}`, approved_at: now },
      sensitivity: { classification: "internal", checked_at: now, checker_version: `${PRODUCER_CLOSE}-1` },
      created_at: now,
      version: 1,
      content: { reason: params.reason },
    };
    const result = await publishCanonical(params.rootPath, record);
    if (result.outcome === "CONFLICT") {
      return { ok: false, detail: `conflito de id em ${result.canonicalPath} — ULID reusado, não deveria acontecer` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * "Última sessão" (18/09, religando `buildAdditionalContext`'s `lastSessionLine`
 * — desligado desde o corte presence/capability/observations de 14/09, que
 * removeu de onde a linha vinha). Resumo da sessão de TOPO mais recente
 * ANTES da atual — nunca a própria sessão corrente.
 *
 * JANELA LIMITADA, não a family inteira — MEDIDO (18/09, fixture de 1666
 * records/1000 sessões, ritmo de ~1 ano no pico deste repo): ler a family
 * `Session` inteira via `loadFamilyForResolution` custou 757ms p50. Contra
 * `PROCESS_WATCHDOG_MS` (2700ms) já apertado, isso sozinho comeria ~28% do
 * teto por uma linha de "nice to have" — inaceitável. `listYaml` (`readdir` +
 * sort, sem parsear nada) é barato SEMPRE, independente do tamanho da
 * family; só os últimos `PREVIOUS_SESSION_WINDOW` arquivos são de fato lidos
 * e parseados — custo O(janela), nunca O(family).
 *
 * LIMITE DECLARADO, não escondido: se a sessão anterior (e, quando fechada,
 * o evento `closed` correspondente — sempre mais recente que o `started` da
 * MESMA sessão, logo sempre dentro da MESMA janela quando o `started` está)
 * não couber nos últimos `PREVIOUS_SESSION_WINDOW` arquivos da family — só
 * aconteceria sob uma rajada de outras sessões entre a anterior e esta,
 * muito acima do pico medido (9/dia) — a linha some. `ausência omite, nunca
 * inventa`: nunca cai pra uma leitura mais cara pra "ter certeza", e nunca
 * mostra a sessão ERRADA como se fosse a última.
 *
 * `currentSessionId` é filtro EXPLÍCITO, não confiança de ordem de chamada:
 * `/clear`/`/compact` disparam um SessionStart NOVO com o MESMO `session_id`
 * (doc oficial, `source` no payload) — sem o filtro, uma sessão que já
 * escreveu `started` antes de compactar veria A SI MESMA como "a anterior".
 */
const PREVIOUS_SESSION_WINDOW = 30;

export interface PreviousSessionSummary {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly status: "ACTIVE" | "CLOSED";
  /** Presente só quando `status === "CLOSED"`. */
  readonly lastActivityAt: string | undefined;
  readonly checkpointId: string | null;
}

/** `scope.ref` quando `scope.kind === "session"` — `null` pra qualquer outra forma (nunca deveria acontecer nesta family). */
function sessionIdOf(scope: SessionStarted["scope"]): string | null {
  return typeof scope === "object" && scope !== null && scope.kind === "session" ? scope.ref : null;
}

/**
 * Leitura de UM arquivo, fora de `loadFamilyForResolution` de propósito —
 * mesma leitura direta e leve que `checkpoint.ts` (`headForCas`) já usa pra
 * ler um record específico sem pagar cache/seenIds/issues da family inteira
 * (`integrity.ts`). `undefined` em QUALQUER falha (arquivo sumiu entre o
 * `listYaml` e agora, YAML inválido, schema inválido, family errada) —
 * nunca lança, é leitura best-effort de uma linha opcional do brief.
 */
async function readSessionFile(filePath: string): Promise<SessionStarted | SessionClosed | SessionForgotten | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseCanonical(raw);
    const validated = validateRecord(parsed);
    if (!validated.ok) return undefined;
    const record = validated.value;
    if (record.family !== "Session") return undefined;
    return record;
  } catch {
    return undefined;
  }
}

/**
 * NUNCA lança — fail-open absoluto, mesma disciplina de
 * `writeSessionStarted`/`writeSessionClosed`. `undefined` cobre: family
 * vazia/ausente, nenhuma sessão anterior na janela, ou qualquer erro de
 * leitura.
 */
export async function findPreviousSession(
  rootPath: string,
  currentSessionId: string
): Promise<PreviousSessionSummary | undefined> {
  try {
    const dir = forProject(rootPath).familyDir("Session");
    const issues: IntegrityIssue[] = [];
    const files = await listYaml(dir, issues);
    if (files.length === 0) return undefined;

    const window = files.slice(-PREVIOUS_SESSION_WINDOW);
    const bucket = new Map<string, { started?: SessionStarted; closed?: SessionClosed; forgotten?: SessionForgotten }>();
    for (const file of window) {
      const record = await readSessionFile(path.join(dir, file));
      if (!record) continue;
      const sessionId = sessionIdOf(record.scope);
      if (!sessionId) continue;
      const entry = bucket.get(sessionId) ?? {};
      if (record.kind === "started") {
        entry.started = record;
      } else if (record.kind === "forgotten") {
        entry.forgotten = record;
      } else if (!entry.closed || record.created_at > entry.closed.created_at) {
        entry.closed = record;
      }
      bucket.set(sessionId, entry);
    }

    let best: { sessionId: string; started: SessionStarted; closed: SessionClosed | undefined } | undefined;
    for (const [sessionId, entry] of bucket) {
      // `--forget` retira de circulação — nunca vira "última sessão", mesma doutrina de `sessions.ts`.
      if (sessionId === currentSessionId || !entry.started || entry.forgotten) continue;
      if (!best || entry.started.created_at > best.started.created_at) {
        best = { sessionId, started: entry.started, closed: entry.closed };
      }
    }
    if (!best) return undefined;

    return {
      sessionId: best.sessionId,
      startedAt: best.started.created_at,
      status: best.closed ? "CLOSED" : "ACTIVE",
      lastActivityAt: best.closed?.created_at,
      checkpointId: best.started.content.checkpoint_id,
    };
  } catch {
    return undefined;
  }
}

/**
 * Projeção em UMA linha, JÁ FORMATADA — mesmo padrão de `taskLine`/`evidence`
 * (`buildAdditionalContext`, `session-start.ts`): esta função é pura, quem
 * chama resolve o dado antes. `status` sai VERBATIM ("ACTIVE"/"CLOSED") —
 * NUNCA "abandonada"/"morta"/"provavelmente encerrada": o campo é OBSERVADO,
 * e decidir se uma ACTIVE de dias atrás ainda importa é julgamento de quem
 * LÊ, com `startedAt` na mão, nunca deste formatador.
 */
export function formatPreviousSessionLine(summary: PreviousSessionSummary): string {
  const started = summary.startedAt.slice(0, 16).replace("T", " ");
  const checkpoint = summary.checkpointId ? `checkpoint ${summary.checkpointId}` : "sem checkpoint";
  const statusPart =
    summary.status === "CLOSED" && summary.lastActivityAt
      ? `CLOSED (fechou ${summary.lastActivityAt.slice(0, 16).replace("T", " ")})`
      : summary.status;
  return `Última sessão: ${started} · ${statusPart} · ${checkpoint}`;
}

export interface WriteSessionForgottenParams {
  readonly rootPath: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly reason: string;
  /** `ACTOR != PRODUCER` — quem pediu, declarado, nunca inferido (mesmo eixo de `nexos memory --deprecate --by`). */
  readonly actorRef: string;
}

/**
 * `nexos sessions --forget` (18/09) — ver a docstring de `SessionForgottenSchema`
 * (`schemas.ts`) para o porquê deste ser um TERCEIRO evento independente e
 * não uma reescrita/supersessão do `started`/`closed` originais.
 *
 *   DEPRECATED != DELETED · OUT OF CIRCULATION != OUT OF DISK
 *
 * FAIL-OPEN ABSOLUTO, mesma disciplina de `writeSessionStarted`/
 * `writeSessionClosed`: nunca lança.
 */
export async function writeSessionForgotten(params: WriteSessionForgottenParams): Promise<SessionEventResult> {
  try {
    const now = new Date().toISOString();
    const recordId = newRecordId("Session");
    const record: CapsuleRecord = {
      schema_version: 1,
      id: recordId,
      family: "Session",
      kind: "forgotten",
      project_id: params.projectId,
      scope: { kind: "session", ref: params.sessionId },
      origin: "agent",
      provenance: {
        source_ref: sourceRefDoEvento(params.sessionId, "forgotten", recordId),
        producer_id: PRODUCER_FORGET,
        submitted_at: now,
      },
      lifecycle: "immutable",
      portability: "portable",
      regenerable: false,
      admission: { status: "admitted", approved_by: `policy:${PRODUCER_FORGET}`, approved_at: now },
      sensitivity: { classification: "internal", checked_at: now, checker_version: `${PRODUCER_FORGET}-1` },
      created_at: now,
      version: 1,
      content: { reason: params.reason, actor_ref: params.actorRef },
    };
    const result = await publishCanonical(params.rootPath, record);
    if (result.outcome === "CONFLICT") {
      return { ok: false, detail: `conflito de id em ${result.canonicalPath} — ULID reusado, não deveria acontecer` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
