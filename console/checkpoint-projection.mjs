/**
 * NEXOS — projeção da cadeia de checkpoints e evidência.
 * Puro: recebe a lista de checkpoints já lida. Não toca disco.
 */

export const TERMINAL = /** @type {const} */ (['SUCCEEDED', 'FAILED', 'BLOCKED']);
export const OPEN = /** @type {const} */ (['PENDING', 'READY', 'RUNNING', 'VERIFYING', 'HUMAN_REQUIRED']);

export class ChainContractError extends Error {}

/** @param {{id?: string, content?: {state?: string}}} cp */
export function isTerminal(cp) {
  return TERMINAL.includes(/** @type {any} */ (cp.content?.state));
}

/**
 * Terminal SEM motivo registrado. É o defeito que a tela existe para expor:
 * medido no Store em 2026-09-18, 0 de 25 FAILED e 0 de 15 BLOCKED tinham
 * `content.verification` — o estado terminou e ninguém registrou por quê.
 * @param {{content?: {state?: string, verification?: unknown}}} cp
 */
export function isTerminalWithoutReason(cp) {
  return isTerminal(cp) && cp.content?.verification == null;
}

/**
 * ONE HOP != THE CHAIN.
 *
 * A Evidence amarra ao ELO QUE PROVOU — em geral o registro em VERIFYING — e a
 * cadeia avanca para SUCCEEDED com outro id. Medir so o elo terminal e olhar
 * um salto e chamar de cadeia.
 *
 * Medido em 2026-09-18: campo `content.verification` ausente em 85 de 111
 * terminais, MAS 111 de 111 alcancam evidencia andando `previous_checkpoint_id`
 * — 86 deles a um unico salto. O campo falta; a informacao nao se perdeu.
 *
 * Mostrar so o primeiro numero faz a tela mentir por omissao, que e
 * exatamente o que ela existe para impedir.
 *
 * @param {Array<any>} checkpoints
 * @param {Set<string>|Map<string, unknown>} evidenceSubjects ids citados por evidence
 * @param {number} [maxHops]
 */
export function evidenceReachability(checkpoints, evidenceSubjects, maxHops = 20) {
  const has = (id) => (evidenceSubjects instanceof Set ? evidenceSubjects.has(id) : evidenceSubjects.get(id) !== undefined);
  const byId = new Map(checkpoints.map((c) => [c.id, c]));
  const terminals = checkpoints.filter(isTerminal);

  const hops = {};
  let reachable = 0;
  let unreachable = 0;
  const orphans = [];

  for (const cp of terminals) {
    let id = cp.id;
    let n = 0;
    let found = false;
    const seen = new Set();
    while (id && byId.has(id) && n <= maxHops) {
      if (seen.has(id)) break; // ciclo: dado corrompido nao trava a tela
      seen.add(id);
      if (has(id)) { found = true; break; }
      id = byId.get(id).previous_checkpoint_id;
      n += 1;
    }
    if (found) { reachable += 1; hops[n] = (hops[n] || 0) + 1; }
    else { unreachable += 1; orphans.push({ id: cp.id, state: cp.content?.state }); }
  }

  return {
    terminals: terminals.length,
    reachable,
    unreachable,
    orphans,
    hops,
    // O unico numero que justifica alarme: terminal que nao alcanca NADA.
    trulyUnprovable: unreachable,
  };
}

/**
 * Reconstrói a cadeia por previous_checkpoint_id.
 * Detecta e REPORTA quebras em vez de silenciá-las: um elo apontando para um
 * id ausente é corrupção de continuidade, e esconder isso na renderização é o
 * mesmo erro que apagar o arquivo órfão do grafo.
 * @param {Array<any>} checkpoints
 */
export function buildChains(checkpoints) {
  if (!Array.isArray(checkpoints)) throw new ChainContractError('checkpoints não é uma lista');
  const byId = new Map(checkpoints.map((c) => [c.id, c]));
  const hasChild = new Set();
  const danglingLinks = [];

  for (const cp of checkpoints) {
    const prev = cp.previous_checkpoint_id;
    if (prev == null) continue;
    if (!byId.has(prev)) danglingLinks.push({ id: cp.id, missing: prev });
    else hasChild.add(prev);
  }

  // Head = ninguém aponta para ele como anterior.
  const heads = checkpoints.filter((c) => !hasChild.has(c.id));
  const roots = checkpoints.filter((c) => c.previous_checkpoint_id == null);
  return { byId, heads, roots, danglingLinks };
}

/**
 * Caminha da cabeça até a raiz. `limit` corta ciclo — cadeia circular é dado
 * corrompido, e a tela não pode travar por causa dele.
 * @param {Map<string, any>} byId
 * @param {string} headId
 * @param {number} [limit]
 */
export function walkChain(byId, headId, limit = 1000) {
  const out = [];
  const seen = new Set();
  let id = headId;
  while (id && byId.has(id) && out.length < limit) {
    if (seen.has(id)) return { chain: out, truncated: true, reason: 'ciclo detectado' };
    seen.add(id);
    const cp = byId.get(id);
    out.push(cp);
    id = cp.previous_checkpoint_id;
  }
  const truncated = out.length >= limit;
  return { chain: out, truncated, reason: truncated ? 'limite atingido' : null };
}

/** @param {Array<any>} checkpoints */
export function projectCheckpoints(checkpoints) {
  const { byId, heads, roots, danglingLinks } = buildChains(checkpoints);
  /**
   *   RECORD COM ESTADO BLOCKED != TRABALHO BLOQUEADO
   *
   * O Store é linhagem IMUTÁVEL: cada tarefa nova nasce do terminal anterior
   * por `previous_checkpoint_id`. O estado de um record SUPERADO descreve o
   * passado daquela cadeia, nunca a situação de agora.
   *
   * MEDIDO em 2026-09-19 na máquina do dono: 460 checkpoints, UMA linhagem,
   * UM head. `byState` acusava 15 BLOCKED e 9 HUMAN_REQUIRED; nos heads são
   * 0 e 0 — o head único está em VERIFYING. A tela publicava "15 tarefas
   * bloqueadas" e o doc 14 usava o mesmo número como pré-condição para não
   * construir o daemon.
   *
   * Os dois ficam, com nomes que dizem o que são: `byState` é HISTÓRICO
   * (quantos estados daquele tipo já existiram) e `byStateHead` é AGORA.
   * Quem responde "o que está pendente" é sempre o segundo.
   */
  const byState = {};
  for (const cp of checkpoints) {
    const s = cp.content?.state ?? 'SEM_ESTADO';
    byState[s] = (byState[s] || 0) + 1;
  }
  const byStateHead = {};
  for (const cp of heads) {
    const s = cp.content?.state ?? 'SEM_ESTADO';
    byStateHead[s] = (byStateHead[s] || 0) + 1;
  }

  const terminals = checkpoints.filter(isTerminal);
  const withoutReason = checkpoints.filter(isTerminalWithoutReason);
  /** Por estado, quantos terminais ficaram sem motivo — é o que a tela destaca. */
  const reasonGap = {};
  for (const cp of terminals) {
    const s = cp.content.state;
    reasonGap[s] = reasonGap[s] || { total: 0, missing: 0 };
    reasonGap[s].total += 1;
    if (cp.content?.verification == null) reasonGap[s].missing += 1;
  }

  return {
    byId, heads, roots, danglingLinks,
    byState,
    byStateHead,
    terminals,
    withoutReason,
    reasonGap,
    stats: {
      total: checkpoints.length,
      heads: heads.length,
      roots: roots.length,
      terminals: terminals.length,
      terminalsWithoutReason: withoutReason.length,
      danglingLinks: danglingLinks.length,
    },
  };
}
