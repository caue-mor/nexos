import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ehGerado, gravarNoVault, linkarDecisoes, renderizarDecisoes } from './build-obsidian.mjs';

const head = (k, over = {}, cont = {}) => ({
  id: `dec_${k}`, source_ref: `nexos://decision/${k}`, applicability: 'project',
  content: { title: k, decision: `regra de ${k}`, continuity: { type: 'decision', status: 'active', ...cont }, ...over },
});
const EM = '2026-09-23T00:00:00.000Z';
const dirs = [];
const vault = () => { const d = mkdtempSync(join(tmpdir(), 'vault-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('projeção de decisões no vault', () => {
  it('só decisões ativas entram, cada uma com source_ref e carimbo de gerado', () => {
    const n = renderizarDecisoes([head('a'), head('b', {}, { status: 'revoked' })], { geradoEm: EM });
    expect(Object.keys(n).sort()).toEqual(['nexos/decisoes/a.md', 'nexos/decisoes/decisoes.base', 'nexos/decisoes/index.md']);
    const a = n['nexos/decisoes/a.md'];
    expect(a).toContain('source_ref: "nexos://decision/a"');
    expect(ehGerado(a)).toBe(true);
    expect(a).toContain('cssclasses:\n  - nexos-gerado');  // marca visual de projeção
    expect(n['nexos/decisoes/index.md']).toContain('cssclasses:\n  - nexos-gerado');
    expect(n['nexos/decisoes/index.md']).toContain('1 ativas');
  });

  it('referência a outra decisão ATIVA vira link; a desconhecida fica como texto', () => {
    const t = linkarDecisoes('ver nexos://decision/a e nexos://decision/zzz', new Set(['a']));
    expect(t).toBe('ver [[nexos/decisoes/a|a]] e nexos://decision/zzz');
  });

  it('sem título duplicado: o Obsidian já mostra o nome do arquivo; H1 só quando o título difere', () => {
    const n = renderizarDecisoes([head('a'), head('b', { title: 'Título próprio' })], { geradoEm: EM });
    expect(n['nexos/decisoes/a.md']).not.toMatch(/^# /m);
    expect(n['nexos/decisoes/b.md']).toMatch(/^# Título próprio$/m);
  });

  it('"#2A" no texto da decisão não vira tag do Obsidian; âncora de URL e título ficam intactos', () => {
    const n = renderizarDecisoes([head('t', { decision: '#2A fechado e #2B aberto; ver https://x.y/p#frag' }, { conditions: 'nota #3' })], { geradoEm: EM });
    const t = n['nexos/decisoes/t.md'];
    expect(t).toContain('\\#2A fechado e \\#2B aberto; ver https://x.y/p#frag');
    expect(t).toContain('nota \\#3');
  });

  it('texto com aspas e quebra de linha não quebra o frontmatter', () => {
    const n = renderizarDecisoes([head('q', { title: 'x' }, { type: 'di"ce\nx' })], { geradoEm: EM });
    expect(n['nexos/decisoes/q.md']).toContain('tipo_continuidade: "di\\"ce\\nx"');
  });

  it('regeração apaga a nota gerada que saiu do Store e preserva a nota humana', () => {
    const v = vault();
    gravarNoVault(v, renderizarDecisoes([head('a'), head('velha')], { geradoEm: EM }));
    writeFileSync(join(v, 'nexos/decisoes/minha-nota.md'), '# escrita à mão\n');
    const r = gravarNoVault(v, renderizarDecisoes([head('a')], { geradoEm: EM }));
    expect(readdirSync(join(v, 'nexos/decisoes')).sort()).toEqual(['a.md', 'decisoes.base', 'index.md', 'minha-nota.md']);
    expect(r.preservadas).toEqual(['minha-nota.md']);
    expect(r.conflitos).toEqual([]);  // a Base gerada é regerada, não vira conflito na 2a rodada
  });

  it('Base regravada pelo Obsidian (sem os comentários) continua sendo regerada', () => {
    const v = vault();
    gravarNoVault(v, renderizarDecisoes([head('a')], { geradoEm: EM }));
    // medido 23/09: ao salvar a view, o app reserializa o YAML e apaga os comentários
    writeFileSync(join(v, 'nexos/decisoes/decisoes.base'), 'filters:\n  and:\n    - file.inFolder("nexos/decisoes")\n');
    const r = gravarNoVault(v, renderizarDecisoes([head('a')], { geradoEm: EM }));
    expect(r.conflitos).toEqual([]);
    expect(readFileSync(join(v, 'nexos/decisoes/decisoes.base'), 'utf8')).toContain('views:');
  });

  it('a Base é YAML válido, carimbada, com uma aba por tipo, e o índice a embute', () => {
    const n = renderizarDecisoes([head('a')], { geradoEm: EM });
    const base = n['nexos/decisoes/decisoes.base'];
    expect(base).toMatch(/^# gerado_por: console\/build-obsidian\.mjs$/m);  // aviso para humano, não carimbo
    const doc = parse(base);
    expect(doc.filters.and).toEqual(['file.inFolder("nexos/decisoes")', 'tipo == "decisao"']);
    expect(doc.views.map((v) => v.name)).toEqual(['Por tipo', 'Restrições', 'Decisões', 'Preferências']);
    expect(doc.views[1].filters).toBe('tipo_continuidade == "constraint"');
    expect(doc.properties['note.tipo_continuidade'].displayName).toBe('Tipo');  // sem `note.` o app ignora
    expect(n['nexos/decisoes/index.md']).toContain('![[nexos/decisoes/decisoes.base]]');
  });

  it('nota humana com o mesmo nome de uma decisão nunca é sobrescrita', () => {
    const v = vault();
    gravarNoVault(v, {});
    writeFileSync(join(v, 'nexos/decisoes/a.md'), '# minha versão\n');
    const r = gravarNoVault(v, renderizarDecisoes([head('a')], { geradoEm: EM }));
    expect(r.conflitos).toEqual(['nexos/decisoes/a.md']);
    expect(readFileSync(join(v, 'nexos/decisoes/a.md'), 'utf8')).toBe('# minha versão\n');
  });

  it('mesma entrada e mesma data geram o mesmo conteúdo (regerável)', () => {
    const hs = [head('b'), head('a', { decision: 'depende de nexos://decision/b' })];
    expect(renderizarDecisoes(hs, { geradoEm: EM })).toEqual(renderizarDecisoes([...hs].reverse(), { geradoEm: EM }));
  });
});
