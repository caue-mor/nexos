/**
 * NEXOS — projeção de memória como FILA DE DECISÃO, não como lista.
 *
 * Um candidato que ninguém decide morre como proposta. A tela existe para que
 * isso não aconteça em silêncio: mostra quantos esperam, há quanto tempo, quem
 * propôs e qual a evidência.
 *
 * Puro: recebe os records já lidos.
 */

export const CANDIDATE_KIND = 'memory_candidate';

/**
 * LER O DIRETORIO NAO E LER A FILA.
 *
 * O Store guarda HISTORICO: cada correcao, promocao ou deprecacao cria um
 * record novo na mesma linhagem e o antigo continua no disco. Contar arquivos
 * conta historia como se fosse fila pendente.
 *
 * Medido em 2026-09-18: 259 arquivos com kind=memory_candidate no diretorio
 * contra 87 na fila real do funil canonico. E o filtro obvio NAO resolve: so
 * 86 carregam `deprecation` no topo; os outros 86 sao superados por linhagem,
 * que exige o reader do core para resolver.
 *
 * Por isso esta projecao NAO reimplementa o funil: marca a propria contagem
 * como nao-canonica e diz o que falta. Reimplementar leitura do Store numa
 * tela e exatamente como o erro nasceu.
 */
export const COUNT_SOURCE = {
  canonical: false,
  what: 'contagem de arquivos no diretorio: inclui linhagens superadas e depreciadas',
  needed: 'nexos memory --review --json (o funil canonico; --review ja existe, falta saida de maquina)',
  predicate: 'src/lib/capsule/reader.ts isDeprecated + resolucao de head por linhagem',
};

/** Quem pode promover. Resposta curta: agente nenhum. */
export const PROMOTION = /** @type {const} */ ({
  ACTOR: 'human',
  CHANNEL: '/dev/tty',
  WHY: 'gate-promocao-memoria-fase-1-tty: promoção exige aprovação humana lida do terminal controlador; ausência de tty recusa fail-closed',
});

/** Faixas de espera. A mais velha primeiro — é a que está morrendo. */
export const AGE_BUCKETS = /** @type {const} */ ([
  { key: 'mais de 14 dias', minDays: 14 },
  { key: '7 a 14 dias', minDays: 7 },
  { key: '1 a 7 dias', minDays: 1 },
  { key: 'hoje', minDays: 0 },
]);

export class MemoryContractError extends Error {}

/** @param {{kind?: string}} r */
export function isCandidate(r) {
  return r.kind === CANDIDATE_KIND;
}

/**
 * Dias de espera. `now` é injetado — teste de idade que lê o relógio real
 * mede a máquina, não a lógica.
 * @param {{created_at?: string}} r
 * @param {Date} now
 */
export function waitingDays(r, now) {
  if (!r.created_at) return null; // sem data não é zero dia: é desconhecido
  const t = Date.parse(r.created_at);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

/** @param {number|null} days */
export function bucketOf(days) {
  if (days === null) return 'idade desconhecida';
  for (const b of AGE_BUCKETS) if (days >= b.minDays) return b.key;
  return 'hoje';
}

/**
 * Evidência ausente é o que torna um candidato indecidível: sem ela o dono não
 * tem como julgar, e a fila trava por falta de matéria-prima, não de tempo.
 * @param {{content?: {evidence?: string}}} r
 */
export function hasEvidence(r) {
  const e = r.content?.evidence;
  return typeof e === 'string' && e.trim().length > 0;
}

/**
 * @param {Array<any>} records
 * @param {Date} [now]
 */
export function projectMemory(records, now = new Date()) {
  if (!Array.isArray(records)) throw new MemoryContractError('records não é uma lista');

  const candidates = [];
  const canonical = [];
  for (const r of records) (isCandidate(r) ? candidates : canonical).push(r);

  const queue = candidates
    .map((r) => {
      const days = waitingDays(r, now);
      return {
        id: r.id,
        days,
        bucket: bucketOf(days),
        createdAt: r.created_at ?? null,
        proposedBy: r.content?.origin_note ?? null,
        fact: r.content?.fact ?? null,
        evidence: r.content?.evidence ?? null,
        hasEvidence: hasEvidence(r),
        proposedKind: r.content?.proposed_kind ?? null,
      };
    })
    // Mais velho primeiro: a fila é de decisão, e o topo é o que está morrendo.
    // `null` (idade desconhecida) vai para o fim, nunca se disfarça de novo.
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));

  const byBucket = {};
  for (const item of queue) byBucket[item.bucket] = (byBucket[item.bucket] || 0) + 1;

  const byProposer = {};
  for (const item of queue) {
    const k = item.proposedBy ?? '(não declarado)';
    byProposer[k] = (byProposer[k] || 0) + 1;
  }

  return {
    countSource: COUNT_SOURCE,
    queue,
    canonical,
    byBucket,
    byProposer,
    promotion: PROMOTION,
    stats: {
      total: records.length,
      // NOME E AVISO: isto conta arquivos, nao a fila. Ver COUNT_SOURCE.
      candidatesInDirectory: queue.length,
      candidates: queue.length,
      canonical: canonical.length,
      withoutEvidence: queue.filter((q) => !q.hasEvidence).length,
      oldestDays: queue[0]?.days ?? null,
      // Nenhum agente promove. O número é sempre zero, e é de propósito.
      promotableByAgent: 0,
    },
  };
}
