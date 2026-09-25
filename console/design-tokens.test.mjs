/**
 *   TOKEN COPIADO É TOKEN QUE VAI DIVERGIR
 *
 * O painel e o mapa do código são dois HTML avulsos abertos por `file://`:
 * não há folha de estilo comum para eles compartilharem, então cada um
 * declara o próprio `:root`. Os valores são os mesmos POR CONVENÇÃO — e
 * convenção não é verificação.
 *
 * Medido: `--dim` no mapa continuou em #6e7c70 depois que o painel subiu
 * para #78867a por reprovar contraste (4,44 contra o mínimo de 4,5). Ninguém
 * notou, porque as duas telas nunca aparecem lado a lado.
 *
 * A alternativa estrutural — fazer o gerador do mapa injetar o mesmo bloco
 * do gerador do painel — mexe em dois geradores para um problema que um
 * teste pega. Se um terceiro artefato aparecer, aí a injeção paga.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const ler = (f) => fs.readFileSync(path.join(aqui, f), 'utf-8');

/** `--nome: valor` em qualquer lugar do arquivo, último vencendo. */
const tokens = (txt) => {
  const m = new Map();
  for (const [, k, v] of txt.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/g)) m.set(k, v.trim());
  return m;
};

/**
 * Mesmo papel, nomes diferentes: o painel fala `--text`/`--muted`, o mapa
 * fala `--fg`/`--dim`, e `design.css` prefixa tudo com `color-`. O par é
 * declarado aqui porque NOME IGUAL NÃO É GARANTIA DE PAPEL IGUAL — casar por
 * nome automaticamente deixaria justamente estes de fora.
 */
const PAPEIS = [
  { papel: 'fundo da página',   painel: 'bg',      mapa: 'bg',      css: 'color-bg' },
  { papel: 'linha divisória',   painel: 'line',    mapa: null,      css: 'color-line' },
  { papel: 'texto principal',   painel: 'text',    mapa: 'fg',      css: 'color-text' },
  { papel: 'texto secundário',  painel: 'muted',   mapa: 'dim',     css: 'color-muted' },
  { papel: 'verde de destaque', painel: 'primary', mapa: 'primary', css: 'color-primary' },
  { papel: 'aviso',             painel: 'warning', mapa: 'warn',    css: 'color-warning' },
];

const T = {
  painel: tokens(ler('console-template.html')),
  mapa: tokens(ler('view-template.html')),
  css: tokens(ler('design.css')),
};

describe('os três arquivos de estilo dizem a mesma cor', () => {
  it('os tokens foram encontrados — o parser não quebrou', () => {
    for (const [onde, m] of Object.entries(T))
      expect(m.size, `nenhum token lido em ${onde}`).toBeGreaterThan(4);
  });

  for (const { papel, ...onde } of PAPEIS) {
    it(`${papel} tem o mesmo valor nos três`, () => {
      const vistos = [];
      for (const [arquivo, nome] of Object.entries(onde)) {
        if (!nome) continue;
        const v = T[arquivo].get(nome);
        expect(v, `--${nome} sumiu de ${arquivo}`).toBeDefined();
        vistos.push([arquivo, v.toLowerCase()]);
      }
      const valores = [...new Set(vistos.map(([, v]) => v))];
      expect(valores.length,
        `${papel} divergiu: ${vistos.map(([a, v]) => `${a}=${v}`).join(', ')}`
      ).toBe(1);
    });
  }
});
