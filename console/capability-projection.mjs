/**
 * NEXOS — projeção da escada de capabilities.
 *
 * A distinção que a tela existe para tornar óbvia: o inventário sabe o que
 * EXISTE, não o que FUNCIONA. `invocation` é o mecanismo declarado, não prova
 * de que a coisa foi invocada alguma vez.
 *
 * Puro: recebe o `nexos capabilities --json` já lido.
 */

/**
 * Os degraus. Cada um exige evidência PRÓPRIA — subir por herança é como um
 * inventário vira relatório de eficácia sem medir nada.
 */
export const LADDER = /** @type {const} */ ([
  'DISCOVERED',  // o host conhece
  'INSTALLED',   // está no disco
  'LISTED',      // aparece no catálogo, custando contexto
  'INVOCABLE',   // pode ser chamada — exige habilitada E descoberta possível
  'INVOKED',     // foi chamada ao menos uma vez
  'EFFECTIVE',   // a chamada produziu o resultado esperado
]);

/**
 * Degraus que o INVENTÁRIO sozinho não sustenta.
 *
 *   ZERO POR CONSTRUÇÃO NÃO É ZERO MEDIDO
 *
 * `INVOKED` esteve aqui como permanente e deixou de ser: `capabilities
 * --usage` passou a varrer transcritos e contar invocação real. Um degrau
 * fixado em 0 com um comentário explicando que não há dado vira afirmação
 * FALSA no instante em que o produtor nasce — e o teste escrito contra a
 * ausência trava o zero em vez de pegar a mentira.
 *
 * Por isso `INVOKED` agora é condicional: some daqui quando `usage` é
 * passado, permanece quando não é. `EFFECTIVE` continua sem produtor algum.
 */
export const UNMEASURED_SEM_USAGE = /** @type {const} */ ({
  INVOKED: 'exige varredura de transcritos — rode com --usage (custa ~34s)',
  EFFECTIVE: 'registro de RESULTADO por capability não existe — é a lacuna reconhecida e aberta',
});

/** Sem o `--usage`, o único degrau que o inventário não alcança é EFFECTIVE. */
export const UNMEASURED_COM_USAGE = /** @type {const} */ ({
  EFFECTIVE: UNMEASURED_SEM_USAGE.EFFECTIVE,
});

/** @deprecated nome antigo, mantido para não quebrar importador externo. */
export const UNMEASURED = UNMEASURED_SEM_USAGE;

export class CapabilityContractError extends Error {}

/** Nosso = distribuído pelo NexOS. O resto é alheio, e medir capability alheia não é trabalho nosso. */
export function isOurs(item) {
  return item.source === 'project';
}

/**
 * ATENCAO AO NOME: isto mede O QUE NOSSO SCANNER LEU, nao o que existe.
 *
 * Medido em 2026-09-18 sobre os 199 itens que o scanner reporta sem
 * description: 114 TEM `description:` no proprio arquivo e 84 nao tem
 * frontmatter algum. `extractFrontmatter` devolve null em tres condicoes
 * distintas — sem frontmatter, sem fechamento e YAML invalido — e as tres
 * colapsam em string vazia, indistinguivel de "o autor nao escreveu".
 *
 * PARSE FAILURE != ABSENT FIELD. As acoes corretivas sao opostas: escrever
 * descricao, consertar delimitador, consertar YAML. E o host enxerga skills
 * que nosso scanner nao enxerga, entao "invisivel" seria afirmacao falsa.
 *
 * O contrato de `capabilities --audit` vai separar os tres casos. Ate la a
 * tela rotula o que o dado e: leitura do nosso scanner.
 */
export function readableByOurScanner(item) {
  return typeof item.description === 'string' && item.description.trim().length > 0;
}

/** @deprecated nome enganoso — mantido só para não quebrar chamador antigo. */
export const isDiscoverable = readableByOurScanner;

/**
 * Degrau máximo PROVADO por este item. Nunca passa de INVOCABLE: os dois
 * degraus seguintes não têm dado nenhum, e inferi-los seria inventar eficácia.
 */
export function provenRung(item) {
  if (item.enabled === false) return 'INSTALLED';   // no disco, fora do catálogo ativo
  if (!readableByOurScanner(item)) return 'LISTED'; // nosso scanner nao leu a description; NAO prova que falta
  return 'INVOCABLE';
}

/** @param {unknown} raw */
export function assertCapabilities(raw) {
  if (raw === null || typeof raw !== 'object') throw new CapabilityContractError('capabilities json não é objeto');
  const c = /** @type {any} */ (raw);
  if (!Array.isArray(c.items)) throw new CapabilityContractError('capabilities json sem items[]');
  return c;
}

/** @param {unknown} raw */
/**
 * Os três casos que colapsavam em "sem description", agora separados.
 * As ações corretivas são OPOSTAS e por isso o balde único era inútil:
 *   NO_FRONTMATTER → escrever o bloco
 *   UNTERMINATED   → consertar o delimitador `---`
 *   INVALID_YAML   → consertar a sintaxe
 * Um quarto caso é o único que o rótulo antigo descrevia: campo realmente ausente.
 */
export const FRONTMATTER_ISSUE = /** @type {const} */ ({
  NO_FRONTMATTER: 'sem bloco de frontmatter: escrever o bloco',
  UNTERMINATED: 'frontmatter sem `---` de fechamento: consertar o delimitador',
  INVALID_YAML: 'YAML inválido: consertar a sintaxe',
});

export function projectCapabilities(raw, usage) {
  const c = assertCapabilities(raw);
  const items = c.items;

  const byRung = {};
  const byKind = {};
  const bySource = {};
  /**
   *   CATÁLOGO NÃO É DISPONIBILIDADE
   *
   * O painel anunciava "645 DISPONÍVEIS" com 483 delas desligadas — 75%.
   * O número estava certo como contagem de catálogo e errado como resposta
   * à pergunta que o cartão fazia. É a mesma falsa competência que o
   * roteador produz ao sugerir skill de anúncios para uma tarefa de
   * segurança porque as de segurança estão COLD: os dois dizem ao usuário
   * que ele tem uma capacidade que ele não tem.
   *
   * `enabled: false` já vinha na saída de `capabilities --json`; a tela é
   * que não lia. Ativas e desligadas passam a ser contadas juntas, por
   * tipo e por origem, porque o recorte é onde o número fala: `command`
   * tem 270 no catálogo e 14 ativas.
   */
  const ativasPorKind = {};
  const ativasPorSource = {};
  let ativas = 0;
  let ours = 0;
  let unreadableByOurScanner = 0;
  let unreadableChars = 0;
  const byIssue = {};
  let disabled = 0;

  for (const it of items) {
    const rung = provenRung(it);
    byRung[rung] = (byRung[rung] || 0) + 1;
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    /* Ausência de `enabled` conta como ativa: o campo é recente e um item
       antigo sem ele não deve ser declarado desligado por omissão. */
    if (it.enabled !== false) {
      ativas += 1;
      ativasPorKind[it.kind] = (ativasPorKind[it.kind] || 0) + 1;
      ativasPorSource[it.source] = (ativasPorSource[it.source] || 0) + 1;
    }
    if (isOurs(it)) ours += 1;
    if (!readableByOurScanner(it)) unreadableByOurScanner += 1;
    if (it.enabled === false) disabled += 1;
    if (!readableByOurScanner(it)) {
      unreadableChars += it.listing_chars ?? 0;
      // Sem `frontmatter_issue` a causa é desconhecida — e desconhecida não é
      // "campo ausente". O balde separado impede a volta do rótulo único.
      const issue = it.frontmatter_issue ?? 'NO_FRONTMATTER_OR_UNKNOWN';
      byIssue[issue] = (byIssue[issue] || 0) + 1;
    }
  }

  // Os degraus não medidos entram explicitamente com 0 — ausente na tela
  // pareceria "não se aplica", e o que é, é "ninguém mediu".
  for (const rung of ['INVOKED', 'EFFECTIVE']) byRung[rung] = 0;

  /**
   * `usage` é OPT-IN e traz seu próprio denominador.
   *
   *   DENOMINADOR ZERO NÃO É NUMERADOR ZERO
   *
   * `transcriptsRead: 0` significa "não varremos nada", NUNCA "ninguém
   * invocou" — é a distinção que quase apagou três providers do catálogo.
   * Por isso a varredura vazia NÃO promove o degrau: sem transcrito lido,
   * `INVOKED` continua não medido.
   */
  const lidos = Number(usage?.scan?.transcriptsRead ?? 0);
  const mediu = Boolean(usage) && lidos > 0;
  if (mediu) byRung.INVOKED = Array.isArray(usage.invoked) ? usage.invoked.length : 0;

  return {
    items,
    byRung,
    byIssue,
    issueMeaning: FRONTMATTER_ISSUE,
    byKind,
    bySource,
    ativasPorKind,
    ativasPorSource,
    unmeasured: mediu ? UNMEASURED_COM_USAGE : UNMEASURED_SEM_USAGE,
    /** Denominador sempre à vista: a tela nunca mostra o numerador sozinho. */
    usageScan: mediu
      ? { transcriptsRead: lidos, linesRead: Number(usage?.scan?.linesRead ?? 0), unreadable: Number(usage?.scan?.unreadable ?? 0) }
      : null,
    duplicates: c.duplicates ?? [],
    variants: c.variants ?? [],
    stats: {
      total: items.length,
      ativas,
      desligadas: items.length - ativas,
      ours,
      foreign: items.length - ours,
      disabled,
      // NOME E AVISO. Ver readableByOurScanner: a maioria TEM description.
      unreadableByOurScanner,
      unreadableChars,
      duplicates: (c.duplicates ?? []).length,
      variants: (c.variants ?? []).length,
      listingChars: c.listing_chars_total ?? null,
      // Teto honesto: nada sobe acima de INVOCABLE com o dado de hoje.
      highestProvenRung: 'INVOCABLE',
    },
  };
}
