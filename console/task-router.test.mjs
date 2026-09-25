import { describe, expect, it } from 'vitest';
import { ROTAS, formatar, rotear } from './task-router.mjs';

/**
 * Cada caso aqui é um erro REAL cometido em 2026-09-19, com a regra já
 * guardada no Store, e que o recall por palavra não recuperou.
 */
const CASOS_REAIS = [
  ['quantos candidatos de memoria existem no diretorio .nexos/records', /ONE WRITE FUNNEL/],
  ['essa função está sendo usada? posso remover?', /NOT FOUND BY GREP/],
  ['o produtor perde 8 de 10 sessões', /ARQUIVO MODIFICADO/],
  ['o Event Schema já está implementado', /escada-de-prova/],
  ['gerar o painel de dentro do worktree', /STORE VIVE NO WORKTREE/],
];

describe('roteia por tarefa o que o recall por palavra perdeu', () => {
  for (const [prompt, regra] of CASOS_REAIS) {
    it(`"${prompt.slice(0, 44)}…"`, () => {
      const r = rotear(prompt);
      expect(r.length, 'nenhuma rota casou').toBeGreaterThan(0);
      expect(r[0].regra).toMatch(regra);
    });
  }
});

describe('CONTROLE NEGATIVO — não roteia o que não é tarefa conhecida', () => {
  it('pergunta fora do escopo não inventa rota', () => {
    // Sem isto, o roteador "acerta" tudo e não informa nada.
    expect(rotear('qual a melhor cor para o botão')).toEqual([]);
    expect(rotear('bom dia')).toEqual([]);
    expect(formatar(rotear('bom dia'))).toBeNull();
  });
});

describe('acento e caixa não decidem se a regra chega', () => {
  it('"diretório" e "diretorio" roteiam igual', () => {
    // O recall atual falhava por isto: quem escreve sem acento não acha.
    expect(rotear('contar arquivos no DIRETÓRIO')[0]?.regra).toBe(rotear('contar arquivos no diretorio')[0]?.regra);
  });
});

describe('uma tarefa pode cair em mais de uma regra', () => {
  it('devolve todas, ordenadas por força — esconder a segunda é o defeito do recall de 3 itens', () => {
    const r = rotear('quantos arquivos isolados existem e posso remover?');
    expect(r.length).toBeGreaterThan(1);
    expect(r[0].forca).toBeGreaterThanOrEqual(r[1].forca);
  });
});

describe('cada rota carrega o que o AGENTS.md do Trinity carrega', () => {
  it('comando exato, o que não fazer, e critério de pronto', () => {
    for (const rota of ROTAS) {
      expect(rota.comando, `${rota.tarefa} sem comando`).toBeTruthy();
      expect(rota.naoFaca, `${rota.tarefa} sem antipadrão`).toBeTruthy();
      expect(rota.prontoQuando, `${rota.tarefa} sem critério de pronto`).toBeTruthy();
      expect(rota.regra, `${rota.tarefa} sem regra`).toBeTruthy();
    }
  });

  it('o formato de injeção traz o comando e o critério', () => {
    const txt = formatar(rotear('quantos candidatos existem'));
    expect(txt).toMatch(/FAÇA:/);
    expect(txt).toMatch(/NÃO FAÇA:/);
    expect(txt).toMatch(/PRONTO QUANDO:/);
  });
});
