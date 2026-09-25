/**
 * Gera console/graph-view.html AUTO-CONTIDO a partir do .nexos/map/graph.json.
 *
 * Auto-contido de propósito: dados embutidos, zero fetch. Abre por duplo clique
 * em file:// sem servidor e sem CORS — que é como esta tela pôde ser verificada
 * por um humano enquanto bind de porta e file:// estão negados no sandbox.
 *
 * Uso:  node console/build-view.mjs <caminho/para/graph.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVENANCE_CHANNEL, projectGraph } from './graph-projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
if (!source) {
  console.error('uso: node console/build-view.mjs <graph.json>');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(source, 'utf8'));
const projection = projectGraph(raw); // lança se o contrato quebrar — nunca gera tela sobre grafo inválido

// Cor = CATEGORIA (diretório de topo). Procedência NÃO usa cor: sai por borda
// e opacidade, senão as duas variáveis colidem no mesmo canal.
const TABLEAU = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'];
const bucket = (path) => (path.includes('/') ? path.split('/')[0] : '(raiz)');
const categories = [...new Set(raw.nodes.map((n) => bucket(n.path)))].sort();
const colorOf = (path) => TABLEAU[categories.indexOf(bucket(path)) % TABLEAU.length];

const DASH = { solid: false, dashed: [8, 4], dotted: [2, 3] };

// Fica fora do DESENHO quem não tem o que desenhar, por dois motivos distintos:
//  - NÃO PARTICIPA (242): markdown, configuração, script. O extrator não lê
//    dependência deles; não é achado, é natureza do arquivo.
//  - ISOLADO (3): código que participa e mesmo assim não tem ligação nenhuma.
//    Esse é achado de verdade, e vai para a lista lateral com destaque.
// Misturar os dois era o que virava 245 linhas de ruído sobre 3 achados.
const foraDoDesenho = new Set([...projection.orphans, ...projection.nonParticipating]);
const nodes = raw.nodes.filter((n) => !foraDoDesenho.has(n.id)).map((n) => {
  const view = projection.nodes.get(n.id);
  const channel = PROVENANCE_CHANNEL[view.provenance];
  return {
    id: n.id,
    // Rótulo só nos mais usados. 588 nomes sobrepostos num layout de força
    // produzem ruído, não informação; o resto aparece no hover e ao selecionar.
    label: view.dependents.length >= 8 ? n.path.split('/').pop() : undefined,
    title: `${n.path}\n${view.provenance}`,
    color: { background: colorOf(n.path), border: view.provenance === 'FACT' ? colorOf(n.path) : '#ffffff' },
    shapeProperties: { borderDashes: DASH[channel.border] },
    borderWidth: view.provenance === 'FACT' ? 1 : 3,
    opacity: channel.opacity,
    value: Math.max(1, view.dependents.length),
  };
});

const ids = new Set(raw.nodes.map((n) => n.id));
const edges = raw.edges
  .filter((e) => e.to && ids.has(e.to) && ids.has(e.from))
  .map((e) => {
    const p = e.resolution === 'unresolved' ? 'UNKNOWN' : e.certainty === 'INFERRED' ? 'INFERRED' : 'FACT';
    return { from: e.from, to: e.to, dashes: DASH[PROVENANCE_CHANNEL[p].border] || false, color: { opacity: PROVENANCE_CHANNEL[p].opacity } };
  });

const detail = {};
for (const [id, view] of projection.nodes) {
  detail[id] = {
    path: view.node.path,
    kind: view.node.kind,
    provenance: view.provenance,
    source: view.node.provenance?.source ?? null,
    lastChanged: view.lastChanged,
    isOrphan: view.dependencies.length === 0 && view.dependents.length === 0,
    dependencies: view.dependencies.map((d) => ({ to: d.to, specifier: d.specifier, provenance: d.provenance, resolution: d.resolution })),
    dependents: view.dependents.map((d) => ({ from: d.from, provenance: d.provenance })),
  };
}

// Distribuição real por canal. Sem isto a legenda promete três estados numa
// tela onde todos os nós são FACT — mentira por omissão.
const provenanceCounts = { nodes: {}, edges: {} };
for (const v of projection.nodes.values()) provenanceCounts.nodes[v.provenance] = (provenanceCounts.nodes[v.provenance] || 0) + 1;
for (const v of projection.nodes.values()) for (const d of v.dependencies) provenanceCounts.edges[d.provenance] = (provenanceCounts.edges[d.provenance] || 0) + 1;

const payload = JSON.stringify({ nodes, edges, detail, provenanceCounts, nonParticipating: projection.nonParticipating, stats: projection.stats, generatedAt: projection.generatedAt, notImplemented: projection.notImplemented, orphans: projection.orphans, categories, colors: categories.map((c, i) => TABLEAU[i % TABLEAU.length]) });

const vendor = readFileSync(join(here, 'vendor', 'vis-network.min.js'), 'utf8');
const html = readFileSync(join(here, 'view-template.html'), 'utf8')
  .replace('/*__VENDOR__*/', () => vendor)   // callback: o minificado tem const html = readFileSync(join(here, 'view-template.html'), 'utf8').replace('/*__PAYLOAD__*/null', payload); e $1 que quebrariam replace literal
  .replace('/*__PAYLOAD__*/null', () => payload);
const out = process.env.NEXOS_GRAPH_OUT ?? join(here, 'graph-view.html');
writeFileSync(out, html);

// Mesmo gate do painel: script inline inválido = tela em branco.
{
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const [i, src] of blocos.entries()) {
    try { new Function(src); }
    catch (err) {
      console.error(`\nSINTAXE INVÁLIDA no bloco ${i + 1}/${blocos.length}: ${err.message}`);
      process.exit(1);
    }
  }
}
console.log(`gerado ${out}`);
console.log(`  ${nodes.length} no desenho · ${projection.stats.nonParticipating} não participam · ${edges.length} ligações · ${projection.stats.orphans} isolados (em lista, fora do grafo) · ${projection.stats.unresolvedEdges} não resolvidas`);
