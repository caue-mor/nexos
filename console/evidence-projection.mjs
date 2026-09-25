/**
 * NEXOS — projeção de Evidence.
 *
 * Dois campos existem porque um valor único respondia por condições com ações
 * OPOSTAS, e a tela precisa preservar essa distinção em vez de reagregar:
 *
 *  - `outcome`: passed | failed | did_not_run. Exit code não distinguia
 *    "rodou e falhou" de "não rodou": o primeiro é um defeito para corrigir,
 *    o segundo é um gate que ninguém executou. Tratar os dois como "não passou"
 *    faz gate ausente se disfarçar de gate reprovado.
 *  - `deliberately_unbound`: ausência de `subject_ref` não distinguia
 *    "avulsa de propósito" de "perdeu a amarração".
 *
 * Puro: recebe os records já lidos.
 */

export const OUTCOME = /** @type {const} */ (['passed', 'failed', 'did_not_run']);

/** Legado = anterior ao campo. NÃO é "não rodou": é "ninguém registrou o quê". */
export function isLegacyOutcome(ev) {
  return !('outcome' in ev) || ev.outcome == null;
}

/**
 * Exit code 0 NÃO prova passed num record legado: o gate pode não ter rodado.
 * Por isso o legado fica numa categoria própria em vez de ser adivinhado.
 */
export function outcomeOf(ev) {
  if (isLegacyOutcome(ev)) return 'UNKNOWN_LEGACY';
  return OUTCOME.includes(ev.outcome) ? ev.outcome : 'UNKNOWN_VALUE';
}

/** Três estados de amarração, não dois. */
export function bindingOf(ev) {
  if (ev.subject_ref) return 'BOUND';
  if (ev.deliberately_unbound === true) return 'UNBOUND_ON_PURPOSE';
  return 'UNBOUND_UNKNOWN'; // pode ser qualquer um dos dois — e é o ponto
}

export function projectEvidence(records) {
  if (!Array.isArray(records)) throw new TypeError('evidence não é lista');

  const byOutcome = {};
  const byBinding = {};
  const byGate = {};
  for (const ev of records) {
    const o = outcomeOf(ev);
    byOutcome[o] = (byOutcome[o] || 0) + 1;
    const b = bindingOf(ev);
    byBinding[b] = (byBinding[b] || 0) + 1;
    if (ev.gate) byGate[ev.gate] = (byGate[ev.gate] || 0) + 1;
  }

  const legacy = records.filter(isLegacyOutcome).length;
  return {
    byOutcome, byBinding, byGate,
    stats: {
      total: records.length,
      legacy,
      // O que os legados NÃO sabem: se o gate rodou. A tela diz isso.
      legacyShare: records.length ? legacy / records.length : 0,
      bound: byBinding.BOUND ?? 0,
      unboundOnPurpose: byBinding.UNBOUND_ON_PURPOSE ?? 0,
      unboundUnknown: byBinding.UNBOUND_UNKNOWN ?? 0,
    },
    gaps: {
      LEGACY_OUTCOME: 'provas gravadas antes desta distinção existir: não dá para saber se a verificação falhou ou se nem chegou a rodar',
      LEGACY_BINDING: 'não dá para saber se a prova ficou solta de propósito ou se perdeu a ligação com a tarefa',
    },
  };
}
