/**
 * A projeção lê arquivos que OUTRA ferramenta escreve, e essa ferramenta
 * pode mudar de formato — ou parar de regenerar um deles — sem avisar. As
 * fixtures são escritas aqui, não tiradas da saída real:
 *
 *   TESTE QUE LÊ A SAÍDA REAL PASSA A MEDIR O REPO, NÃO O CÓDIGO
 *
 * O `graphify-out/` deste projeto muda a cada commit. Um teste ancorado
 * nele ficaria vermelho por motivo alheio e verde por coincidência.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projetarGraphify, pastaMaisRecente, PERGUNTA_PT } from './graphify-projection.mjs';

let raiz;
beforeEach(() => { raiz = mkdtempSync(join(tmpdir(), 'nexos-graphify-')); });
afterEach(() => { rmSync(raiz, { recursive: true, force: true }); });

/**
 * Monta a saída do graphify. `data` nula escreve na RAIZ, que é onde a
 * ferramenta mantém o estado vivo; com data, escreve numa pasta de backup.
 */
function montar(data, { analise, grafo, rotulos } = {}) {
  const dir = data ? join(raiz, 'graphify-out', data) : join(raiz, 'graphify-out');
  mkdirSync(dir, { recursive: true });
  if (analise !== null) writeFileSync(join(dir, '.graphify_analysis.json'), JSON.stringify(analise ?? {}));
  if (grafo !== null) writeFileSync(join(dir, 'graph.json'), JSON.stringify(grafo ?? { nodes: [], links: [] }));
  if (rotulos) writeFileSync(join(dir, '.graphify_labels.json'), JSON.stringify(rotulos));
  return dir;
}

const NO = (over = {}) => ({
  id: 'src_lib_paths_forproject',
  label: 'forProject()',
  source_file: 'src/lib/paths.ts',
  source_location: 'L109',
  file_type: 'code',
  _callable: true,
  community: 6,
  ...over,
});

describe('degrada sem esconder a lacuna', () => {
  it('sem graphify-out, diz o que fazer', () => {
    const p = projetarGraphify(raiz);
    expect(p.medido).toBe(false);
    expect(p.motivo, 'o motivo tem que dizer o comando').toMatch(/graphify/);
  });

  it('com a pasta mas sem análise legível, diz qual leitura falhou', () => {
    montar(null, { analise: null, grafo: { nodes: [] } });
    const p = projetarGraphify(raiz);
    expect(p.medido).toBe(false);
    expect(p.motivo).toMatch(/estado atual|2026-09-21/);
  });

  it('JSON corrompido não derruba a tela', () => {
    const dir = join(raiz, 'graphify-out');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.graphify_analysis.json'), '{ isto não é json');
    writeFileSync(join(dir, 'graph.json'), '{}');
    expect(() => projetarGraphify(raiz)).not.toThrow();
    expect(projetarGraphify(raiz).medido).toBe(false);
  });

  it('pasta com nome fora do padrão de data é ignorada, não ordenada errado', () => {
    montar('2026-09-20', { analise: { gods: [] }, grafo: { nodes: [] } });
    mkdirSync(join(raiz, 'graphify-out', 'rascunho'), { recursive: true });
    expect(pastaMaisRecente(join(raiz, 'graphify-out'))).toMatch(/2026-09-20$/);
  });

  it('a cópia mais recente vence quando não há estado vivo', () => {
    montar('2026-09-01', { analise: { gods: [] }, grafo: { nodes: [] } });
    montar('2026-09-21', { analise: { gods: [] }, grafo: { nodes: [] } });
    const p = projetarGraphify(raiz);
    expect(p.pasta).toBe('2026-09-21');
    expect(p.fonte).toBe('backup');
  });

  /**
   *   A PASTA COM DATA É BACKUP; O ESTADO VIVO ESTÁ NA RAIZ
   *
   * O log da ferramenta diz "backed up curated graph (5 files) ->
   * 2026-09-20/": as pastas datadas são cópias feitas ANTES de cada
   * reconstrução. Ler a pasta é ler um ciclo atrasado, sempre — medido,
   * o backup de hoje já diverge do vivo em 1 nó de 5720, sem nada avisar.
   */
  it('a raiz vence a cópia datada', () => {
    montar('2026-09-21', { analise: {}, grafo: { nodes: [NO({ id: 'velho', label: 'velho()' })], links: [] } });
    montar(null, { analise: {}, grafo: { nodes: [NO({ id: 'novo', label: 'novo()' })], links: [{ source: 'novo', target: 'novo' }] } });
    const p = projetarGraphify(raiz);
    expect(p.fonte, 'o estado vivo tem que ganhar do backup').toBe('viva');
    expect(p.concentradores[0].rotulo).toBe('novo()');
  });
});

describe('o que dá para calcular do mapa fresco não se lê da análise velha', () => {
  /**
   * A análise deste repositório dizia `degree: 35` para `forProject()`
   * enquanto o grafo do MESMO dia dava 148 — ela é de agosto, de um grafo
   * muito menor. Grau é contagem de arestas: o grafo de hoje basta.
   */
  it('o grau vem do grafo, não do número que a análise guardou', () => {
    montar(null, {
      analise: { gods: [{ id: 'qualquer', label: 'forProject()', degree: 35 }] },
      /*
       * Cada aresta soma 1 para CADA ponta, então nove arestas saindo do
       * mesmo nó empatariam os dois em 9. A primeira versão deste teste
       * fazia exatamente isso e cobrava uma ordem que o empate não
       * garante — o teste estava errado, não o código. Aqui as nove
       * chegam de nós DIFERENTES.
       */
      grafo: {
        nodes: [NO(), ...Array.from({ length: 9 }, (_, i) => NO({ id: `o${i}`, label: `outra${i}()` }))],
        links: Array.from({ length: 9 }, (_, i) => ({ source: `o${i}`, target: 'src_lib_paths_forproject' })),
      },
    });
    const [c] = projetarGraphify(raiz).concentradores;
    expect(c.rotulo).toBe('forProject()');
    expect(c.ligacoes, 'o 35 da análise não pode aparecer como número de hoje').toBe(9);
  });

  it('ordena pelo mais ligado e leva arquivo e linha junto', () => {
    montar(null, {
      analise: {},
      grafo: {
        nodes: [
          NO({ id: 'a', label: 'pouco()' }),
          NO({ id: 'b', label: 'muito()', source_file: 'src/b.ts', source_location: 'L7' }),
          NO({ id: 'c', label: 'terceiro()' }),
        ],
        links: [{ source: 'a', target: 'b' }, { source: 'c', target: 'b' }],
      },
    });
    const [primeiro] = projetarGraphify(raiz).concentradores;
    expect(primeiro.rotulo).toBe('muito()');
    expect(primeiro.onde, 'sem arquivo e linha a tabela é só um ranking').toBe('src/b.ts:7');
  });

  /**
   * O grafo mistura arquivo, função, classe e documento no mesmo saco.
   * `schemas.ts` e `forProject()` são peças muito diferentes.
   */
  it('classifica o que é cada peça em vez de chamar tudo de nó', () => {
    montar(null, {
      analise: {},
      grafo: {
        nodes: [
          NO({ id: 'f', label: 'f()' }),
          NO({ id: 'c', label: 'C', _callable_class: true }),
          NO({ id: 'arq', label: 'x.ts', _callable: false, source_location: 'L1' }),
          NO({ id: 'doc', label: 'leia.md', _callable: false, file_type: 'document' }),
        ],
        links: [{ source: 'f', target: 'c' }, { source: 'arq', target: 'doc' }],
      },
    });
    const tipos = Object.fromEntries(projetarGraphify(raiz).concentradores.map((c) => [c.rotulo, c.tipo]));
    expect(tipos['f()']).toBe('função');
    expect(tipos['C']).toBe('classe');
    expect(tipos['x.ts']).toBe('arquivo');
    expect(tipos['leia.md']).toBe('documento');
  });

  it('conta as peças que nenhuma aresta toca', () => {
    montar(null, {
      analise: {},
      grafo: {
        nodes: [NO({ id: 'a' }), NO({ id: 'b' }), NO({ id: 'sozinho' })],
        links: [{ source: 'a', target: 'b' }],
      },
    });
    expect(projetarGraphify(raiz).totais.semLigacao).toBe(1);
  });
});

describe('coerência entre os dois arquivos é MEDIDA, não suposta', () => {
  /**
   *   ZERO CRUZAMENTOS É A ASSINATURA DE DUAS EXECUÇÕES DIFERENTES
   *
   * Medido no repositório real por verificação independente:
   * `.graphify_analysis.json` tem hash IDÊNTICO nas seis pastas diárias,
   * todas com mtime de 15/08, enquanto `graph.json` tem seis hashes
   * diferentes. Nenhum dos 10 ids da análise existe no grafo de hoje.
   *
   * O sinal forte não é a data — é se os identificadores se encontram.
   * Uma versão anterior CONTORNAVA essa divergência caindo para o nome do
   * símbolo, e com isso escondeu a causa por trás de um remédio que
   * funcionava.
   */
  it('acusa quando nenhum id da análise existe no grafo', () => {
    montar(null, {
      analise: { gods: [{ id: 'formato_antigo', label: 'f()', degree: 3 }] },
      grafo: { nodes: [NO({ id: 'formato_novo', label: 'f()' })], links: [] },
    });
    const { coerencia } = projetarGraphify(raiz);
    expect(coerencia.idsQueCruzam).toBe(0);
    expect(coerencia.mesmaExecucao, 'zero cruzamentos = execuções diferentes').toBe(false);
  });

  it('reconhece quando os dois saíram juntos', () => {
    montar(null, {
      analise: { gods: [{ id: 'src_lib_paths_forproject', label: 'forProject()', degree: 3 }] },
      grafo: { nodes: [NO()], links: [] },
    });
    expect(projetarGraphify(raiz).coerencia.mesmaExecucao).toBe(true);
  });

  /**
   * Casar um tamanho contado hoje com uma coesão calculada em outra
   * execução produz uma linha que parece certa e não é — que é pior do que
   * uma célula vazia.
   */
  it('a coesão some quando as duas fontes não batem', () => {
    montar(null, {
      analise: { gods: [{ id: 'velho', label: 'f()', degree: 1 }], cohesion: { 6: 0.9 } },
      grafo: { nodes: [NO()], links: [] },
    });
    expect(projetarGraphify(raiz).comunidades[0].coesao).toBeNull();
  });

  it('a coesão fica quando as fontes batem', () => {
    montar(null, {
      analise: { gods: [{ id: 'src_lib_paths_forproject', label: 'forProject()', degree: 1 }], cohesion: { 6: 0.9 } },
      grafo: { nodes: [NO()], links: [] },
    });
    expect(projetarGraphify(raiz).comunidades[0].coesao).toBe(0.9);
  });
});

describe('as duas datas nunca viram uma só', () => {
  /**
   * Esta parte já esteve errada nas DUAS direções: primeiro lendo só
   * `mtime` (mostrou "37 dias", pareceu absurdo e foi "corrigido"), depois
   * lendo só o nome da pasta (mostrou "hoje" para uma análise de agosto).
   * As duas datas existem, são de coisas diferentes, e divergem de verdade.
   */
  it('a data do grafo e a da análise são medidas separadamente', () => {
    const dir = montar(null, { analise: { gods: [] }, grafo: { nodes: [] } });
    const agosto = new Date('2026-08-15T00:52:00Z');
    const setembro = new Date('2026-09-21T14:56:00Z');
    utimesSync(join(dir, '.graphify_analysis.json'), agosto, agosto);
    utimesSync(join(dir, 'graph.json'), setembro, setembro);

    const p = projetarGraphify(raiz, { agora: Date.parse('2026-09-21T20:00:00Z') });
    expect(p.grafo.em).toBe('2026-09-21');
    expect(p.analise.em, 'a análise não é regenerada; a data dela é outra').toBe('2026-08-15');
    expect(p.grafo.diasAtras).toBe(0);
    expect(p.analise.diasAtras).toBe(37);
    expect(p.defasagemDias, 'a distância entre as duas é o que a tela precisa dizer').toBe(37);
  });
});

describe('a tela fala português', () => {
  const comPerguntas = (questions, rotulos) => {
    montar(null, { analise: { questions }, grafo: { nodes: [] }, rotulos });
    return projetarGraphify(raiz).perguntas;
  };

  it('troca o número do grupo pelo nome que a ferramenta deu', () => {
    const [q] = comPerguntas(
      [{ type: 'low_cohesion', question: 'Should `Community 4` be split into smaller, more focused modules?', why: 'Cohesion score 0.05493863237872589' }],
      { 4: 'memory-recall.ts' }
    );
    expect(q.pergunta, '"Community 4" não diz nada a quem lê').toContain('memory-recall.ts');
    expect(q.pergunta).not.toContain('Community');
    expect(q.porque, '17 casas decimais é ruído').toContain('5,5%');
    expect(q.porque).not.toContain('0.0549');
  });

  it('uma ponte para um grupo só não vira plural', () => {
    const [q] = comPerguntas(
      [{ type: 'bridge_node', question: 'Why does `f()` connect `Community 1` to `Community 2`?', why: 'High betweenness centrality (0.019)' }],
      { 1: 'a', 2: 'b' }
    );
    expect(q.pergunta).toMatch(/ao «b»\?$/);
    expect(q.pergunta).not.toMatch(/outros 1 grupos/);
  });

  it('lista longa de grupos é truncada, não despejada', () => {
    const alvos = Array.from({ length: 9 }, (_, i) => `\`Community ${i + 2}\``).join(', ');
    const [q] = comPerguntas(
      [{ type: 'bridge_node', question: `Why does \`f()\` connect \`Community 1\` to ${alvos}?`, why: null }],
      {}
    );
    expect(q.pergunta).toMatch(/e mais 6\?/);
  });

  /**
   * Um tipo novo do graphify não pode virar linha em branco: fica em
   * inglês, marcado, para alguém traduzir.
   */
  it('tipo desconhecido segue visível em vez de sumir', () => {
    const [q] = comPerguntas([{ type: 'tipo_novo', question: 'Why is this here?', why: 'porque sim' }], {});
    expect(q.pergunta).toBe('Why is this here?');
    expect(q.tipoPt).toBeNull();
    expect(q.cru, 'a tela precisa poder marcar o que não foi traduzido').toBe(true);
  });

  it('os três tipos conhecidos têm tradução', () => {
    for (const t of ['bridge_node', 'isolated_nodes', 'low_cohesion']) {
      expect(PERGUNTA_PT[t], `${t} sem tradução`).toBeTruthy();
    }
  });
});

describe('totais e teto', () => {
  /** N grupos, o grupo `i` com `N - i` peças. */
  const grafoCom = (n) => ({
    nodes: Array.from({ length: n }, (_, i) =>
      Array.from({ length: n - i }, (_, j) => NO({ id: `n${i}_${j}`, label: `n${i}_${j}`, community: i }))
    ).flat(),
    links: [],
  });

  it('grupos além do teto são contados, não descartados em silêncio', () => {
    montar(null, { analise: {}, grafo: grafoCom(45) });
    const p = projetarGraphify(raiz);
    expect(p.comunidades.length).toBe(40);
    expect(p.comunidadesOmitidas, 'o resto tem que aparecer como número').toBe(5);
    expect(p.totais.grupos, 'o total conta TODOS, não só os exibidos').toBe(45);
  });

  it('o teto corta a cauda, nunca os maiores', () => {
    montar(null, { analise: {}, grafo: grafoCom(45) });
    expect(projetarGraphify(raiz).comunidades[0].tamanho, 'o maior grupo tem que estar na lista').toBe(45);
  });

  it('análise vazia não quebra os totais', () => {
    montar(null, { analise: {}, grafo: { nodes: [], links: [] } });
    const p = projetarGraphify(raiz);
    expect(p.medido).toBe(true);
    expect(p.totais.coesaoMedia).toBeNull();
    expect(p.concentradores).toEqual([]);
  });
});
