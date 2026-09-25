/**
 * O payload é montado por PICK explícito de campos (`build-console.mjs`), e o
 * template lê `C.<campo>` em runtime. Nada liga os dois — um campo novo na
 * projeção que a tela passa a usar simplesmente chega `undefined`.
 *
 *   CAMPO NA PROJEÇÃO != CAMPO NO PAYLOAD
 *
 * Foi assim que `usageScan` quase entregou uma tela que mostra `INVOKED 23`
 * e, na linha abaixo, "não foi medido nesta execução". Os testes de projeção
 * passavam — o campo existia no retorno. Ninguém verificava a travessia.
 *
 * Teste ESTÁTICO de propósito: lê os dois arquivos e compara. Não gera
 * painel, não roda `nexos`, não depende de Store.
 *
 * A primeira versão deste teste casava TODO `C.<campo>` do arquivo e
 * acusou 5 campos inexistentes: `C` é alias reusado — `D.checkpoints` numa
 * seção, `D.capabilities` na outra. `BUSCA CASA TOKEN, VERIFICAÇÃO PRECISA
 * DE PREDICADO`: o escopo é delimitado pelas declarações do alias, nunca
 * pelo nome dele.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(dir, 'console-template.html'), 'utf-8');
const builder = fs.readFileSync(path.join(dir, 'build-console.mjs'), 'utf-8');

/** O bloco `capabilities: ... { ... }` do pick — só ele governa essa seção. */
const pickCapabilities = builder.slice(
  builder.indexOf('capabilities: !capabilities'),
  builder.indexOf('decisions:', builder.indexOf('capabilities: !capabilities'))
);

describe('travessia projeção -> payload -> template', () => {
  it('todo C.<campo> lido pelo template existe no pick do payload', () => {
    const inicio = template.indexOf('const C = D.capabilities;');
    expect(inicio, 'alias da seção de capabilities não encontrado').toBeGreaterThan(0);
    const proximoAlias = template.indexOf('const C = D.', inicio + 1);
    const escopo = template.slice(inicio, proximoAlias > 0 ? proximoAlias : undefined);
    const usados = [...escopo.matchAll(/\bC\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    expect(usados.length).toBeGreaterThan(0);
    const faltando = [...new Set(usados)].filter((c) => !pickCapabilities.includes(`${c}:`));
    expect(faltando, `campos lidos pela tela e ausentes do payload: ${faltando.join(', ')}`).toEqual([]);
  });

  /**
   * `machine` entra no payload inteiro (sem pick), então o risco aqui não é
   * campo esquecido — é a PROJEÇÃO parar de emitir um campo que a tela lê.
   *
   * Alias `MAQ`, não `M`: a primeira tentativa usou uma letra e colidiu com
   * outra seção, acusando 3 campos falsos — o MESMO erro que o comentário do
   * topo deste arquivo descreve, cometido duas linhas abaixo dele. Delimitar
   * escopo por regex conserta o teste; nome distinto conserta a classe.
   */
  it('todo M.<campo> lido pela tela existe na projeção da máquina', async () => {
    const { projectMachine } = await import('./machine-projection.mjs');
    const emitidos = new Set(Object.keys(projectMachine({ cores: 1, load1: 1, sessions: 1, projects: 1, denied: [] })));
    const usados = [...new Set([...template.matchAll(/\bMAQ\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
    expect(usados.length).toBeGreaterThan(0);
    const faltando = usados.filter((c) => !emitidos.has(c));
    expect(faltando, `campos lidos pela tela e ausentes da projeção: ${faltando.join(', ')}`).toEqual([]);
  });

  it('machine atravessa o payload como objeto inteiro', () => {
    expect(builder).toContain('machine,');
  });

  /**
   * O template declara `C` QUATRO vezes com objetos diferentes (linha 110 em
   * desestruturação, e depois checkpoints, memory.canonical, capabilities).
   * Cobrir isso por escopo de regex não escala — este teste ancora os campos
   * que a seção de PENDÊNCIAS lê, que é onde o número falso saiu para a tela.
   */
  it('byStateHead atravessa — pendência não pode voltar a contar histórico', () => {
    expect(builder).toContain('byStateHead: checkpoints.byStateHead');
    expect(template).toContain('C.byStateHead');
    expect(template, 'pendência lendo byState de novo é a regressão').not.toContain('C.byState.BLOCKED');
    expect(template).not.toContain('C.byState.HUMAN_REQUIRED');
  });

  it('usageScan atravessa — regressão do INVOKED que contradizia a si mesmo', () => {
    expect(pickCapabilities).toContain('usageScan:');
    expect(template).toContain('C.usageScan');
  });
});
