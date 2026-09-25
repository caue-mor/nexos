import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GraphContractError,
  PROVENANCE,
  assertGraph,
  edgeProvenance,
  lastChanged,
  nodeDetail,
  nodeProvenance,
  projectGraph,
} from './graph-projection.mjs';

const node = (id, over = {}) => ({
  id, path: id, kind: 'file', certainty: 'OBSERVED',
  provenance: { file: id, source: 'import-scan' },
  last_changed_commit: 'abc1234', last_changed_at: '2026-09-18T00:00:00Z', ...over,
});
const edge = (from, to, over = {}) => ({
  from, to, specifier: to ?? 'x', resolution: to ? 'resolved' : 'external',
  certainty: 'OBSERVED', provenance: { file: from, source: 'import-scan' },
  id: `${from}->${to}`, ...over,
});

describe('contrato do graph.json', () => {
  it('recusa grafo sem nodes[], que é a regressão que apagava 259 arquivos', () => {
    expect(() => assertGraph({ edges: [] })).toThrow(GraphContractError);
    expect(() => assertGraph({ edges: [] })).toThrow(/sem nodes/);
  });

  it('recusa grafo sem edges[]', () => {
    expect(() => assertGraph({ nodes: [] })).toThrow(/sem edges/);
  });

  it('recusa não-objeto', () => {
    expect(() => assertGraph(null)).toThrow(GraphContractError);
    expect(() => assertGraph('graph')).toThrow(GraphContractError);
  });
});

describe('os três estados que o dado sustenta', () => {
  it('OBSERVED vira FACT e INFERRED vira INFERRED, no nó', () => {
    expect(nodeProvenance(node('a'))).toBe(PROVENANCE.FACT);
    expect(nodeProvenance(node('b', { certainty: 'INFERRED' }))).toBe(PROVENANCE.INFERRED);
  });

  it('certainty desconhecida não vira FACT por omissão', () => {
    expect(nodeProvenance(node('c', { certainty: 'QUALQUER' }))).toBe(PROVENANCE.UNKNOWN);
  });

  it('aresta unresolved é UNKNOWN mesmo com certainty OBSERVED', () => {
    // O scan VIU o import (OBSERVED) e não achou o alvo (unresolved).
    // Pintar isso de FACT seria afirmar uma dependência que ninguém encontrou.
    expect(edgeProvenance(edge('a', undefined, { resolution: 'unresolved', certainty: 'OBSERVED' })))
      .toBe(PROVENANCE.UNKNOWN);
  });

  it('aresta externa resolvida continua FACT', () => {
    expect(edgeProvenance(edge('a', undefined, { resolution: 'external' }))).toBe(PROVENANCE.FACT);
  });
});

describe('STALE e FAILED ficam declarados, não inventados', () => {
  it('a projeção carrega o motivo de cada um não estar implementado', () => {
    const p = projectGraph({ nodes: [node('a')], edges: [] });
    expect(p.notImplemented.STALE).toMatch(/data desta leitura/);
    expect(p.notImplemented.FAILED).toMatch(/registro de tarefas/);
  });
});

describe('null em last_changed_commit é NÃO SABIDO, não "nunca mudou"', () => {
  it('distingue conhecido de desconhecido', () => {
    expect(lastChanged(node('a')).known).toBe(true);
    expect(lastChanged(node('b', { last_changed_commit: null })).known).toBe(false);
    expect(lastChanged(node('c', { last_changed_commit: null })).commit).toBeNull();
  });
});

describe('o órfão aparece — era o que o schema antigo apagava', () => {
  const graph = {
    nodes: [node('a.ts'), node('b.ts'), node('sozinho.ts')],
    edges: [edge('a.ts', 'b.ts')],
    files_scanned: 3,
  };

  it('lista o nó sem nenhuma aresta nos dois sentidos', () => {
    expect(projectGraph(graph).orphans).toEqual(['sozinho.ts']);
  });

  it('o órfão continua sendo um nó completo, com painel próprio', () => {
    const detail = nodeDetail(projectGraph(graph), 'sozinho.ts');
    expect(detail).not.toBeNull();
    expect(detail.isOrphan).toBe(true);
    expect(detail.provenance).toBe(PROVENANCE.FACT);
  });

  it('todo nó escaneado está na projeção, não só os conectados', () => {
    const p = projectGraph(graph);
    expect(p.stats.nodes).toBe(p.stats.filesScanned);
  });
});

describe('isolado não é o mesmo que não participa', () => {
  const g = {
    nodes: [
      node('codigo.ts'), node('sozinho.ts'),
      node('LEIAME.md', { linkable: false }),
      node('config.json', { linkable: false }),
    ],
    edges: [edge('codigo.ts', undefined, { resolution: 'external' })],
    files_scanned: 4,
  };

  it('markdown e json sem aresta NÃO entram como isolados', () => {
    // Regressão real: contar não-participantes como isolados virou 245 linhas
    // de ruído sobre 3 achados. A lista abria com .gitignore.
    const p = projectGraph(g);
    expect(p.orphans).toEqual(['sozinho.ts']);
    expect(p.stats.nonParticipating).toBe(2);
  });

  it('sem o campo linkable, nada é filtrado — grafo antigo segue legível', () => {
    const antigo = { nodes: [node('a.ts'), node('b.md')], edges: [], files_scanned: 2 };
    expect(projectGraph(antigo).orphans.sort()).toEqual(['a.ts', 'b.md']);
  });
});

describe('painel do nó selecionado', () => {
  const p = projectGraph({
    nodes: [node('a.ts'), node('b.ts'), node('c.ts')],
    edges: [edge('a.ts', 'b.ts'), edge('c.ts', 'b.ts'), edge('a.ts', undefined, { resolution: 'unresolved' })],
  });

  it('popula dependências e dependentes nos dois sentidos', () => {
    expect(nodeDetail(p, 'a.ts').dependencies).toHaveLength(2);
    expect(nodeDetail(p, 'b.ts').dependents.map((d) => d.from).sort()).toEqual(['a.ts', 'c.ts']);
  });

  it('dá canal visual próprio à procedência, deixando a cor livre para categoria', () => {
    expect(nodeDetail(p, 'a.ts').channel.border).toBe('solid');
  });

  it('devolve null para id inexistente em vez de um nó vazio', () => {
    expect(nodeDetail(p, 'nao-existe.ts')).toBeNull();
  });
});

describe('controle real — o graph.json deste checkout, não uma fixture', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let found = null;
  for (let dir = here, i = 0; i < 6; i += 1, dir = resolve(dir, '..')) {
    const candidate = join(dir, '.nexos', 'map', 'graph.json');
    if (existsSync(candidate)) { found = candidate; break; }
  }

  // Repo público (export sem .nexos) não tem mapa: pula em vez de reprovar.
  it.skipIf(found === null)('encontra o graph.json do repositório', () => {
    expect(found, 'nenhum .nexos/map/graph.json encontrado subindo 6 níveis').not.toBeNull();
  });

  it.skipIf(found === null)('ou tem nodes[] e projeta, ou é recusado com a mensagem certa', () => {
    const raw = JSON.parse(readFileSync(found, 'utf8'));
    if (!Array.isArray(raw.nodes)) {
      // Estado legado: exatamente o grafo que apagava o arquivo isolado.
      expect(() => projectGraph(raw)).toThrow(/sem nodes/);
      return;
    }
    const p = projectGraph(raw);
    expect(p.stats.nodes).toBe(raw.files_scanned);
    expect(p.stats.nodes).toBeGreaterThan(0);
    expect(p.orphans.length).toBeLessThan(p.stats.nodes);
  });
});
