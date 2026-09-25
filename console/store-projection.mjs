/**
 * NEXOS — projeção de decisions e research.
 * Puro: recebe os records já lidos.
 */

/** Uma decisão revogada continua no Store e NÃO pode sumir da tela: some do vigor, não da história. */
export function isRevoked(d) {
  const s = (d.content?.status ?? d.status ?? '').toLowerCase();
  return s === 'revoked' || s === 'revogada'
    || d.content?.revoked_at != null
    || d.content?.revocation_reason != null;
}

/** Decisão sem consequência declarada é regra sem custo conhecido. */
export function hasConsequences(d) {
  const c = d.content?.consequences;
  return typeof c === 'string' ? c.trim().length > 0 : Array.isArray(c) ? c.length > 0 : false;
}

/**
 *   O ID JÁ CARREGA A HORA — NÃO PRECISA DE CAMPO NOVO
 *
 * Os ids são ULID (`dec_01M32VPAKBVVA2AV5QYDYRPTYF`): os dez primeiros
 * caracteres depois do prefixo são o instante em base32 de Crockford,
 * milissegundos desde a época. Duas consequências que a tela usa:
 * ordenar por id É ordenar por tempo, e a data sai sem ler mais nada.
 *
 * Id fora desse formato devolve `null` em vez de uma data inventada — uma
 * data errada num painel é pior que um campo vazio.
 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function instanteDoId(id) {
  const m = /^[a-z]+_([0-9A-HJKMNP-TV-Z]{10})/.exec(String(id ?? ''));
  if (!m) return null;
  let ms = 0;
  for (const c of m[1]) {
    const v = B32.indexOf(c);
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function projectDecisions(records, { agora = Date.now(), recentes = 6 } = {}) {
  if (!Array.isArray(records)) throw new TypeError('decisions não é lista');
  const active = records.filter((d) => !isRevoked(d));
  const revoked = records.filter(isRevoked);
  /**
   * As últimas decisões, com quantos dias têm. É o que responde "o que
   * aconteceu de importante?" — pergunta que a primeira tela não
   * respondia: um experimento reprovado por gate, com revert e decisão
   * registrada, não aparecia em lugar nenhum da visão geral.
   */
  const ultimas = [...records]
    .map((d) => ({ d, em: instanteDoId(d.id) }))
    .filter((x) => x.em !== null)
    .sort((a, b) => b.em - a.em)
    .slice(0, recentes)
    .map(({ d, em }) => ({
      id: d.id,
      titulo: d.content?.title ?? d.source_ref ?? d.id,
      revogada: isRevoked(d),
      diasAtras: Math.max(0, Math.floor((agora - em) / 86400000)),
      /** A regra em si, cortada: a tela mostra o suficiente para decidir se abre. */
      resumo: typeof d.content?.decision === 'string' ? d.content.decision : null,
    }));
  return {
    active, revoked, ultimas,
    withoutConsequences: active.filter((d) => !hasConsequences(d)),
    stats: {
      total: records.length,
      active: active.length,
      revoked: revoked.length,
      withoutConsequences: active.filter((d) => !hasConsequences(d)).length,
    },
  };
}

/**
 * Research com acervo vazio ou quase vazio é a informação, não a ausência dela.
 * `emptyIsTheFinding` faz a tela dizer isso em vez de mostrar uma lista em branco.
 */
/**
 * LINHAGEM DIVERGENTE TORNA RECORD INVISÍVEL, NÃO INEXISTENTE.
 *
 * Records que compartilham o mesmo `source_ref` formam uma linhagem com
 * múltiplas cabeças (DIVERGED), e o leitor canônico descarta o conjunto
 * inteiro em vez de escolher uma. O resultado é acervo que existe no disco e
 * não existe para nenhum consumidor.
 *
 * Medido em 2026-09-18: 5 records de research no disco, 1 legível. Os outros
 * 4 compartilham `nexos://research` — entre eles pesquisa sobre o payload do
 * evento Stop e sobre session_id de subagente. Não é acervo vazio: é acervo
 * mudo, que é pior, porque parece ausência de trabalho.
 */
export function divergedLineages(records) {
  const byRef = new Map();
  for (const r of records) {
    const ref = r.content?.source_ref ?? r.source_ref ?? null;
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(r);
  }
  return [...byRef.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([ref, list]) => ({
      sourceRef: ref,
      count: list.length,
      records: list.map((r) => ({ id: r.id, question: r.content?.question ?? null })),
    }));
}

export function projectResearch(records, { thinThreshold = 5 } = {}) {
  if (!Array.isArray(records)) throw new TypeError('research não é lista');
  const diverged = divergedLineages(records);
  const invisible = diverged.reduce((n, d) => n + d.count, 0);
  const withSources = records.filter((r) => {
    const s = r.content?.sources;
    return Array.isArray(s) ? s.length > 0 : typeof s === 'string' && s.trim().length > 0;
  });
  return {
    records, withSources, diverged,
    emptyIsTheFinding: records.length <= thinThreshold,
    stats: {
      onDisk: records.length,
      invisibleByLineage: invisible,
      readable: records.length - invisible,
      total: records.length,
      withSources: withSources.length,
      withoutSources: records.length - withSources.length,
      thinThreshold,
    },
  };
}
