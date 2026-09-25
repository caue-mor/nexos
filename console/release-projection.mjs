/**
 * CONSOLE — projeção da cadeia de release.
 *
 * Quatro instalações independentes que NADA sincroniza:
 *   SOURCE   commit do worktree
 *   BUILD    commit carimbado em dist/build-info.json
 *   RUNTIME  o dist que o binário do PATH executa — é ELE que roda nos hooks
 *   ASSETS   a versão que `nexos install` projetou em ~/.claude
 *
 * A ironia que esta aba existe para não repetir: o aviso de runtime velho foi
 * construído para detectar exatamente este caso, e vive na versão NÃO
 * instalada. O detector não roda porque o que ele detecta é verdade sobre ele
 * mesmo. Uma tela que mostrasse "tudo verde" teria o mesmo defeito.
 */

export const LINKS = /** @type {const} */ (['SOURCE', 'BUILD', 'RUNTIME', 'ASSETS']);

export const SYNC = /** @type {const} */ ({
  MATCH: 'MATCH',
  BEHIND: 'BEHIND',
  DIVERGED: 'DIVERGED',
  UNKNOWN: 'UNKNOWN',
});

/** A ação corretiva é uma só, e é do dono. */
export const REMEDY = /** @type {const} */ ({
  what: 'reinstalar o global a partir deste worktree',
  command: 'npm run build && nexos install',
  whose: 'dono — muda ~/.claude, fora do alcance de agente',
});

/**
 * REQUISITO DURO: elo não observado NUNCA vira verde.
 *
 * Sem binário no PATH, dist sem build-info, marcador ilegível — todos viram
 * UNKNOWN, visualmente distinto de MATCH. Silêncio passando por cadeia
 * íntegra é precisamente como este detector mente.
 *
 * @param {{value: string|null, distance: number|null}} link
 * @param {string|null} reference
 */
export function syncStateOf(link, reference) {
  if (link.value == null || reference == null) return SYNC.UNKNOWN;
  if (link.value === reference) return SYNC.MATCH;
  if (link.distance == null) return SYNC.DIVERGED; // difere, e não sabemos o quanto
  return link.distance > 0 ? SYNC.BEHIND : SYNC.DIVERGED;
}

/**
 * "58 commits atrás" é acionável; "diferente" não é.
 * @param {{distance: number|null}} link
 */
export function distanceLabel(link) {
  if (link.distance == null) return 'distância não medida';
  if (link.distance === 0) return 'em dia';
  return `${link.distance} commit${link.distance === 1 ? '' : 's'} atrás`;
}

/**
 * @param {{SOURCE: any, BUILD: any, RUNTIME: any, ASSETS: any}} observed
 */
export function projectRelease(observed) {
  if (observed === null || typeof observed !== 'object') throw new TypeError('observed não é objeto');
  const reference = observed.SOURCE?.value ?? null;

  const links = LINKS.map((name) => {
    const link = observed[name] ?? { value: null, distance: null };
    // SOURCE é a referência: comparar consigo mesmo é sempre MATCH, exceto se
    // nem ele foi observado.
    // `compareTo` permite que um elo tenha referência PRÓPRIA. ASSETS usa a
    // versão do package.json: comparar versão semântica com hash de commit
    // nunca bate, e um vermelho que nunca apaga não informa nada.
    const ref = link.compareTo !== undefined ? link.compareTo : reference;
    const state = name === 'SOURCE'
      ? (link.value == null ? SYNC.UNKNOWN : SYNC.MATCH)
      : syncStateOf(link, ref);
    return {
      name,
      value: link.value,
      distance: link.distance,
      distanceLabel: distanceLabel(link),
      state,
      observed: link.value != null,
      note: link.note ?? null,
    };
  });

  const outOfSync = links.filter((l) => l.state === SYNC.BEHIND || l.state === SYNC.DIVERGED);
  const unknown = links.filter((l) => l.state === SYNC.UNKNOWN);
  const worst = links.reduce((m, l) => Math.max(m, l.distance ?? 0), 0);

  return {
    links, reference, remedy: REMEDY,
    stats: {
      total: links.length,
      inSync: links.filter((l) => l.state === SYNC.MATCH).length,
      outOfSync: outOfSync.length,
      // UNKNOWN conta separado de outOfSync: "não sei" não é "está errado",
      // e nenhum dos dois é "está certo".
      unknown: unknown.length,
      worstDistance: worst,
    },
    // Só é íntegra se TODOS foram observados E batem. Um UNKNOWN impede.
    healthy: outOfSync.length === 0 && unknown.length === 0,
  };
}
