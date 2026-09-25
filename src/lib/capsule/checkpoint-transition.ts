/**
 * Harness V1 slice 1 — validador de transição de `ProjectCheckpoint.content.state`.
 *
 * Molde: `capability/evolution.ts:110 applyCandidate` — recebe estado atual e
 * proposto, devolve veredito com `why` por modo de falha nomeado. FORMA
 * copiada, não o código: `applyCandidate` é tipada em `CapabilityContent`/
 * `TrustState`; generalizá-la para servir aos dois seria a abstração
 * especulativa que este projeto já rejeitou.
 *
 *   STATE MACHINE HAS EDGES, NOT JUST NODES
 *
 * `SUCCEEDED` e `FAILED` são terminais: o record em si é imutável (ADR-049,
 * nenhuma transição reescreve o conteúdo de um checkpoint terminal) e nenhuma
 * OUTRA transição de estado sai deles dentro da MESMA linhagem — decisão do
 * operador (2026-09-07): a única aresta que um terminal abre é `-> READY`, e
 * essa aresta não continua a linhagem, ela INICIA UMA TAREFA NOVA
 * (`statement` obrigatório, `attempt` reinicia em 1, `contract_id`/
 * `plan_node_id` não herdados — ver `advanceCheckpoint` em `checkpoint.ts`).
 * `previous_checkpoint_id` do novo `READY` aponta para o terminal, então a
 * chain continua uma única árvore, sem raiz nova nem `task_id`.
 *
 * Retry (attempt+1, mesmo statement) é outra coisa: um NOVO checkpoint
 * (`previous_checkpoint_id` apontando para o terminal), nunca uma aresta desta
 * tabela — ver `applyCheckpointRetry` abaixo.
 */
import type { CheckpointState } from "./schemas.js";

export type CheckpointTransitionVerdict =
  | { readonly allowed: true; readonly why: string }
  | { readonly allowed: false; readonly why: string };

/** Arestas legais. Ausência da lista = recusa — nunca "permitido por omissão". */
const ALLOWED_TRANSITIONS: Readonly<Record<CheckpointState, readonly CheckpointState[]>> = {
  PENDING: ["READY", "BLOCKED", "SUPERSEDED"],
  READY: ["RUNNING", "BLOCKED", "SUPERSEDED"],
  RUNNING: ["VERIFYING", "FAILED", "BLOCKED", "SUPERSEDED"],
  VERIFYING: ["SUCCEEDED", "FAILED", "HUMAN_REQUIRED", "SUPERSEDED"],
  BLOCKED: ["READY", "HUMAN_REQUIRED", "SUPERSEDED"],
  HUMAN_REQUIRED: ["READY", "BLOCKED", "SUPERSEDED"],
  /** Única saída de um terminal: nasce TAREFA NOVA em READY, não continuação da linhagem — ver docstring acima. */
  SUCCEEDED: ["READY"],
  FAILED: ["READY"],
  SUPERSEDED: ["READY"],
};

/** Os estados terminais (record imutável, ADR-049): concluído, falho ou retirado por decisão. */
export function isTerminalState(state: CheckpointState): state is "SUCCEEDED" | "FAILED" | "SUPERSEDED" {
  return state === "SUCCEEDED" || state === "FAILED" || state === "SUPERSEDED";
}

/**
 * O checkpoint proposto pode suceder o atual na cadeia?
 *
 * Duas recusas, cada uma por um modo de falha nomeado:
 *
 *  1. Auto-transição — um checkpoint novo que repete o estado do pai não é
 *     progresso; é o mesmo defeito que o CAS de `store.ts` produz quando dois
 *     escritores concorrentes disputam o mesmo `RUNNING` (ver contrafactual
 *     de dispatch duplicado): o segundo re-lê o head já avançado e tenta a
 *     MESMA transição de novo — aqui é onde ela é recusada.
 *  2. Fora da lista de arestas — inclusive pular etapa (`SUCCEEDED ->
 *     RUNNING`, `PENDING -> SUCCEEDED`) e sair de um terminal para qualquer
 *     estado que não `READY` (a única saída — ver `isTerminalState`).
 */
/**
 * Arestas legais que saem de `state`, direto de `ALLOWED_TRANSITIONS` — sem
 * duplicar a tabela. Terminal (`SUCCEEDED`/`FAILED`) devolve `["READY"]`: a
 * única saída, e ela nasce TAREFA NOVA, não continuação — ver docstring do
 * módulo. Consumidor típico: uma linha de apresentação barata (`checkpoint.ts`
 * `describeCheckpointTaskLine`) que mostra "próximo: X | Y" sem reimplementar
 * a tabela de arestas.
 */
export function nextStatesOf(state: CheckpointState): readonly CheckpointState[] {
  // SUPERSEDED sai da APRESENTAÇÃO (não da tabela): vale de todo estado aberto e
  // é retirada por decisão, não passo do trabalho — listá-la em toda linha é ruído.
  return ALLOWED_TRANSITIONS[state].filter((s) => s !== "SUPERSEDED");
}

export function applyCheckpointTransition(
  atual: CheckpointState,
  proposto: CheckpointState
): CheckpointTransitionVerdict {
  if (atual === proposto) {
    return {
      allowed: false,
      why: `"${atual}" -> "${proposto}" é auto-transição — um checkpoint novo precisa mudar de estado, não repetir o pai`,
    };
  }

  const permitidos = ALLOWED_TRANSITIONS[atual];
  if (!permitidos.includes(proposto)) {
    const detalhe = isTerminalState(atual)
      ? `"${atual}" é terminal e imutável — de um terminal só nasce TAREFA NOVA em "READY", nunca "${proposto}"`
      : permitidos.length > 0
        ? `de "${atual}" só se vai para: ${permitidos.join(", ")}`
        : `"${atual}" é terminal — nenhuma transição sai dele nesta fatia`;
    return {
      allowed: false,
      why: `"${atual}" -> "${proposto}" não é uma transição válida. ${detalhe}`,
    };
  }

  return { allowed: true, why: `"${atual}" -> "${proposto}" permitido` };
}

/**
 * Harness V1 slice 2 — RETRY continua sendo um caminho SEPARADO de
 * `FAILED -> READY` via `applyCheckpointTransition`, mesmo agora que essa
 * aresta existe em `ALLOWED_TRANSITIONS` (decisão do operador, 2026-09-07):
 * os dois produzem um checkpoint `READY` novo, mas com semântica diferente.
 * `applyCheckpointTransition("FAILED", "READY")` é TAREFA NOVA — `attempt`
 * reinicia em 1, nada herdado além do link causal. `applyCheckpointRetry` é a
 * MESMA tarefa tentada de novo — `attempt` incrementa, `statement` é herdado.
 * Retry nunca reescreve o terminal — cabeça nova, `previous_checkpoint_id`
 * apontando para o `FAILED`.
 *
 *   RETRY IS A NEW NODE, NOT A NEW EDGE OUT OF A TERMINAL —
 *   AND NOT THE SAME EDGE AS "NEW TASK FROM TERMINAL"
 *
 * Duas recusas nomeadas: predecessor não é `FAILED` (nada a retentar), ou
 * orçamento de tentativas esgotado (`attempt >= maxAttempts`) — a mesma regra
 * que fecha o Contrafactual C ("terceiro dispatch impossível").
 */
export function applyCheckpointRetry(
  predecessorState: CheckpointState,
  attempt: number,
  maxAttempts: number
): CheckpointTransitionVerdict {
  if (predecessorState !== "FAILED") {
    return {
      allowed: false,
      why: `retry só parte de um checkpoint "FAILED" — predecessor está em "${predecessorState}"`,
    };
  }
  if (attempt >= maxAttempts) {
    return {
      allowed: false,
      why: `attempt ${attempt} já atingiu max_attempts ${maxAttempts} — orçamento de retry esgotado`,
    };
  }
  return {
    allowed: true,
    why: `retry attempt ${attempt} -> ${attempt + 1}, dentro do orçamento (max ${maxAttempts})`,
  };
}
