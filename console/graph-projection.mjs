/**
 * NEXOS — projeção do grafo do NexOS.
 *
 * STORE/MAP = AUTHORITY, JARVIS = PROJECTION. Este módulo não lê disco, não
 * consulta o Store e não gera grafo: recebe o `.nexos/map/graph.json` já lido e
 * devolve o view model. Puro de propósito — é o que permite testar o
 * comportamento da tela sem DOM, sem jsdom e sem navegador.
 *
 * ponytail: JS + JSDoc em vez de TS porque `tsconfig.include` é ["src/**\/*"],
 * então console/ não é typechecked e um .ts aqui fingiria um gate que não existe.
 * Mesmo arquivo roda no vitest e no <script type="module">, sem build.
 */

/** Procedência de um nó ou aresta, derivada do dado — nunca inventada. */
export const PROVENANCE = /** @type {const} */ ({
  FACT: 'FACT',
  INFERRED: 'INFERRED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Estados da acceptance que o dado de hoje NÃO sustenta.
 *
 * Declarados, não inventados: STALE exige comparar graph.generated_at com o
 * HEAD do repositório, e FAILED mora na família checkpoint/evidence do Store.
 * Nenhum dos dois é derivável de graph.json. A interface mostra "não
 * implementado" em vez de pintar um estado que ninguém mediu.
 */
export const NOT_IMPLEMENTED = /** @type {const} */ ({
  STALE: 'exigiria comparar a data desta leitura com a última alteração do projeto',
  FAILED: 'essa informação fica no registro de tarefas, não neste mapa',
});

/** Canal visual de cada procedência. A cor fica livre para categoria do nó. */
export const PROVENANCE_CHANNEL = /** @type {const} */ ({
  FACT: { border: 'solid', opacity: 1 },
  INFERRED: { border: 'dashed', opacity: 0.85 },
  UNKNOWN: { border: 'dotted', opacity: 0.55 },
});

/**
 * @typedef {object} RawNode
 * @property {string} id
 * @property {string} path
 * @property {string} kind
 * @property {string} certainty
 * @property {{file?: string, source?: string}} [provenance]
 * @property {string|null} [last_changed_commit]
 * @property {string|null} [last_changed_at]
 */

/**
 * @typedef {object} RawEdge
 * @property {string} from
 * @property {string} [to]
 * @property {string} specifier
 * @property {string} resolution
 * @property {string} certainty
 * @property {{file?: string, source?: string}} [provenance]
 * @property {string} id
 */

/** Erro de contrato do grafo — falha alto, nunca silencioso. */
export class GraphContractError extends Error {}

/**
 * Valida o shape mínimo antes de qualquer projeção.
 * @param {unknown} raw
 * @returns {{nodes: RawNode[], edges: RawEdge[], generated_at?: string, files_scanned?: number}}
 */
export function assertGraph(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new GraphContractError('graph.json não é um objeto');
  }
  const g = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(g.nodes)) {
    // Regressão real: até 2026-09-18 o graph.json tinha só `edges`, e derivar
    // nós das arestas apagava 259 arquivos isolados de 576.
    throw new GraphContractError('graph.json sem nodes[] — 45% dos arquivos ficariam invisíveis');
  }
  if (!Array.isArray(g.edges)) throw new GraphContractError('graph.json sem edges[]');
  return /** @type {any} */ (g);
}

/**
 * Procedência de uma aresta. `unresolved` é o único UNKNOWN honesto:
 * o alvo foi visto no código e não foi encontrado no projeto.
 * @param {RawEdge} edge
 */
export function edgeProvenance(edge) {
  if (edge.resolution === 'unresolved') return PROVENANCE.UNKNOWN;
  if (edge.certainty === 'INFERRED') return PROVENANCE.INFERRED;
  if (edge.certainty === 'OBSERVED') return PROVENANCE.FACT;
  return PROVENANCE.UNKNOWN;
}

/**
 * Procedência de um nó. Vem de `certainty`, nunca das arestas: um arquivo
 * observado continua observado mesmo que todo import dele seja duvidoso.
 * @param {RawNode} node
 */
export function nodeProvenance(node) {
  if (node.certainty === 'OBSERVED') return PROVENANCE.FACT;
  if (node.certainty === 'INFERRED') return PROVENANCE.INFERRED;
  return PROVENANCE.UNKNOWN;
}

/**
 * `null` em last_changed_commit significa NÃO SABIDO, jamais "nunca mudou".
 * A distinção é da interface, então ela sai explícita do view model.
 * @param {RawNode} node
 */
export function lastChanged(node) {
  const commit = node.last_changed_commit ?? null;
  if (commit === null) return { known: false, commit: null, at: null };
  return { known: true, commit, at: node.last_changed_at ?? null };
}

/**
 * View model completo. Uma passada pelas arestas, índices por nó.
 * @param {unknown} raw
 */
export function projectGraph(raw) {
  const g = assertGraph(raw);
  /** @type {Map<string, {node: RawNode, provenance: string, dependencies: any[], dependents: any[], lastChanged: any}>} */
  const byId = new Map();

  for (const node of g.nodes) {
    byId.set(node.id, {
      node,
      provenance: nodeProvenance(node),
      dependencies: [],
      dependents: [],
      lastChanged: lastChanged(node),
    });
  }

  let unresolved = 0;
  for (const edge of g.edges) {
    const provenance = edgeProvenance(edge);
    if (provenance === PROVENANCE.UNKNOWN) unresolved += 1;
    const link = { edge, provenance, specifier: edge.specifier, to: edge.to ?? null, resolution: edge.resolution };
    byId.get(edge.from)?.dependencies.push(link);
    if (edge.to && byId.has(edge.to)) {
      byId.get(edge.to)?.dependents.push({ ...link, from: edge.from });
    }
  }

  /**
   * ISOLADO != NÃO PARTICIPA.
   *
   * Um arquivo sem aresta só é achado se ele PODERIA ter arestas. Markdown,
   * JSON e shell não participam do grafo de dependência: contá-los como
   * isolados transformava 3 achados reais em 245 linhas de ruído — foi o que
   * o dono chamou de "poluído", e a lista abria com .gitignore.
   *
   * `linkable` vem do scan (map-scan.ts) e carrega as duas metades da régua:
   * extensão que o extrator lê E não ser material que o scan já exclui.
   * Sem o campo, nada é filtrado: grafo antigo continua legível, só não ganha
   * a separação.
   */
  const orphans = [];
  const nonParticipating = [];
  for (const [id, view] of byId) {
    const semAresta = view.dependencies.length === 0 && view.dependents.length === 0;
    if (!semAresta) continue;
    const participa = view.node.linkable !== false;
    if (participa) orphans.push(id);
    else nonParticipating.push(id);
  }

  return {
    nodes: byId,
    orphans,
    nonParticipating,
    stats: {
      nodes: g.nodes.length,
      edges: g.edges.length,
      orphans: orphans.length,
      nonParticipating: nonParticipating.length,
      unresolvedEdges: unresolved,
      filesScanned: g.files_scanned ?? null,
    },
    generatedAt: g.generated_at ?? null,
    notImplemented: NOT_IMPLEMENTED,
  };
}

/**
 * Painel do nó selecionado. Devolve `null` para id inexistente em vez de
 * inventar um nó vazio — a tela precisa saber a diferença.
 * @param {ReturnType<typeof projectGraph>} projection
 * @param {string} id
 */
export function nodeDetail(projection, id) {
  const view = projection.nodes.get(id);
  if (!view) return null;
  return {
    id,
    path: view.node.path,
    kind: view.node.kind,
    provenance: view.provenance,
    channel: PROVENANCE_CHANNEL[/** @type {keyof typeof PROVENANCE_CHANNEL} */ (view.provenance)],
    source: view.node.provenance?.source ?? null,
    lastChanged: view.lastChanged,
    dependencies: view.dependencies,
    dependents: view.dependents,
    isOrphan: view.dependencies.length === 0 && view.dependents.length === 0,
  };
}
