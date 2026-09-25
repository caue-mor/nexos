/**
 * CONSOLE — consumo do Event Schema do Visual SDK.
 *
 * Contrato de origem: `docs/visual-sdk/sdk/events.ts` (EventEnvelope v0.1).
 * Este módulo é o PRIMEIRO CONSUMIDOR real dele: até aqui o arquivo estava
 * entre os três únicos arquivos de código isolados do projeto — 13 tipos
 * declarados, zero importadores.
 *
 * DECISÃO QUE GOVERNA (nexos://decision/event-schema-ligar-vertical-minima):
 *
 *   EVENT != TRUTH · EVENT != STORE
 *
 * Um evento diz que ALGO ACONTECEU. Quem precisa do estado canônico consulta
 * a autoridade — o Store. Por isso este módulo NÃO deriva estado do fluxo de
 * eventos: ele apenas traduz o que o Store já registrou para o vocabulário
 * que as superfícies entendem.
 *
 * E por isso o primeiro produtor não foi inventado: a family `Session` já é
 * um event-log declarado ("started e closed são dois kind da MESMA family",
 * schemas.ts), com `source_ref` próprio por evento. Ligar o contrato ao que
 * já acontece é a vertical; criar um barramento novo seria a segunda
 * autoridade.
 */

/** Campos que o EventEnvelope do SDK exige. Fonte: sdk/events.ts. */
export const ENVELOPE_REQUIRED = /** @type {const} */ (['id', 'ts', 'type', 'payload']);

/** Tipos que ESTE consumidor entende hoje. Um evento fora da lista não é silenciado. */
export const KNOWN_TYPES = /** @type {const} */ ([
  'session.started',
  'session.closed',
  'session.forgotten',
]);

export class EventContractError extends Error {}

/**
 * Valida contra o contrato do SDK. Envelope inválido FALHA — silenciar aqui
 * seria repetir o defeito que esta vertical existe para expor.
 * @param {any} e
 */
export function assertEnvelope(e) {
  if (e === null || typeof e !== 'object') throw new EventContractError('envelope não é objeto');
  for (const k of ENVELOPE_REQUIRED) {
    if (e[k] === undefined || e[k] === null) throw new EventContractError(`envelope sem campo obrigatório: ${k}`);
  }
  if (typeof e.type !== 'string' || !e.type.includes('.')) {
    throw new EventContractError(`type deve ser "dominio.acao", recebido: ${String(e.type)}`);
  }
  return e;
}

/**
 * Record da family Session → EventEnvelope.
 *
 * `sessionId` vem de `scope.ref`, NUNCA do `id` do record: o id é um ULID novo
 * a cada publicação, e dois eventos da mesma sessão têm ids diferentes. Está
 * escrito no schema — "correlacionam-se por scope.ref, nunca pelo id".
 *
 * @param {any} record
 */
export function sessionRecordToEvent(record) {
  if (record === null || typeof record !== 'object') throw new EventContractError('record não é objeto');
  const kind = record.kind ?? record.content?.kind ?? null;
  if (!kind) throw new EventContractError('record de sessão sem kind');

  const type = `session.${kind}`;
  const envelope = {
    id: record.id ?? null,
    ts: record.created_at ?? null,
    type,
    sessionId: record.scope?.ref ?? null,
    workspaceId: record.project_id ?? null,
    payload: {
      host: record.content?.host ?? null,
      cwd: record.content?.cwd ?? null,
      agentRef: record.content?.agent_ref ?? null,
      checkpointId: record.content?.checkpoint_id ?? null,
    },
    /** Tipo fora do vocabulário conhecido é MARCADO, não descartado. */
    known: KNOWN_TYPES.includes(type),
  };
  return assertEnvelope(envelope);
}

/**
 * @param {Array<any>} records
 */
export function projectSessionEvents(records) {
  if (!Array.isArray(records)) throw new EventContractError('records não é lista');
  const events = [];
  const rejected = [];
  for (const r of records) {
    try { events.push(sessionRecordToEvent(r)); }
    catch (err) { rejected.push({ id: r?.id ?? '(sem id)', why: err.message }); }
  }
  events.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

  return {
    events, rejected, byType,
    unknownTypes: [...new Set(events.filter((e) => !e.known).map((e) => e.type))],
    stats: { total: events.length, rejected: rejected.length, types: Object.keys(byType).length },
    contract: 'docs/visual-sdk/sdk/events.ts — EventEnvelope v0.1',
  };
}
