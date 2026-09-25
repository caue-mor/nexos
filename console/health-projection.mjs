/**
 * NEXOS — projeção de saúde do NexOS neste projeto.
 * Responde "o NexOS está inteiro aqui?" a partir de `nexos doctor --project --json`.
 *
 * Puro: recebe o JSON já lido. Não executa comando, não lê disco.
 */

/** Ordem de gravidade. O maior manda na tela. */
export const SEVERITY = /** @type {const} */ ({
  OK: 0, INFO: 1, DRIFT: 2, BLOCKED: 3, UNKNOWN: 4,
});

/**
 * Estado do doctor → severidade. Um estado que não conhecemos vira UNKNOWN,
 * nunca OK: interface que pinta de verde o que não entende é pior que erro.
 */
export const STATE_SEVERITY = /** @type {const} */ ({
  HEALTHY: SEVERITY.OK,
  DRIFTED: SEVERITY.DRIFT,
  PARTIAL: SEVERITY.DRIFT,
  LEGACY: SEVERITY.DRIFT,
  NOT_ADOPTED: SEVERITY.INFO,
  CONFLICT: SEVERITY.BLOCKED,
  CORRUPT: SEVERITY.BLOCKED,
  UNSUPPORTED: SEVERITY.BLOCKED,
  DEGRADED: SEVERITY.BLOCKED,
});

export class HealthContractError extends Error {}

/** @param {unknown} raw */
export function assertDoctor(raw) {
  if (raw === null || typeof raw !== 'object') throw new HealthContractError('doctor json não é objeto');
  const d = /** @type {Record<string, unknown>} */ (raw);
  if (typeof d.state !== 'string') throw new HealthContractError('doctor json sem state');
  if (!Array.isArray(d.evidence)) throw new HealthContractError('doctor json sem evidence[]');
  if (!Array.isArray(d.plan)) throw new HealthContractError('doctor json sem plan[]');
  return /** @type {any} */ (d);
}

/**
 * Um item do plano é ACIONÁVEL só se traz o comando que o executa.
 * PRESERVE sem comando é aviso, não tarefa — e misturar os dois faz a tela
 * prometer um botão que não existe.
 * @param {{action: string, command?: string}} item
 */
export function isActionable(item) {
  return typeof item.command === 'string' && item.command.length > 0;
}

/** @param {unknown} raw */
export function projectHealth(raw) {
  const d = assertDoctor(raw);
  const severity = STATE_SEVERITY[d.state] ?? SEVERITY.UNKNOWN;

  /** Junta plano e evidência pela área: o "o que fazer" ao lado do "por quê". */
  const byArea = new Map();
  for (const e of d.evidence) {
    if (!byArea.has(e.area)) byArea.set(e.area, { area: e.area, evidence: [], plan: [] });
    byArea.get(e.area).evidence.push(e.detail);
  }
  for (const p of d.plan) {
    if (!byArea.has(p.area)) byArea.set(p.area, { area: p.area, evidence: [], plan: [] });
    byArea.get(p.area).plan.push({ ...p, actionable: isActionable(p) });
  }

  const areas = [...byArea.values()].map((a) => ({
    ...a,
    // Área citada em reasons é a que explica o estado — sobe na tela.
    blamed: d.reasons?.some((r) => r.toLowerCase().includes(a.area.replace('-', ' ')) || r.toLowerCase().includes(a.area)) ?? false,
  }));

  const actionable = d.plan.filter(isActionable);
  return {
    state: d.state,
    severity,
    known: d.state in STATE_SEVERITY,
    reasons: d.reasons ?? [],
    rootPath: d.rootPath ?? null,
    projectId: d.projectId ?? null,
    areas,
    actionable,
    advisoryOnly: d.plan.filter((p) => !isActionable(p)),
    stats: { areas: areas.length, planItems: d.plan.length, actionable: actionable.length, reasons: (d.reasons ?? []).length },
  };
}

/**
 * O que a tela de health NÃO pode responder com o dado de hoje.
 *
 * Está VAZIO, e chegou a esse estado em vez de nascer assim. As duas lacunas
 * declaradas aqui foram fechadas por contrato no core, não por conveniência:
 *   - WORK_STATE     → `nexos boot --json` (dc30823b), leitura pura verificada
 *   - CHECKPOINT_HEAD → `nexos checkpoint --json` (84091e65)
 *
 * Declarar a lacuna foi o que a fechou: o pedido nasceu da tela que se recusou
 * a inventar o campo. Mantido como objeto para que a próxima lacuna tenha onde
 * ser declarada em vez de virar um valor estimado.
 */
export const HEALTH_GAPS = /** @type {const} */ ({});
