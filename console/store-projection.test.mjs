import { describe, expect, it } from 'vitest';
import { divergedLineages, hasConsequences, isRevoked, projectDecisions, projectResearch } from './store-projection.mjs';

const dec = (id, over = {}) => ({ id, content: { title: id, decision: 'd', consequences: 'c', status: 'active', ...over } });

describe('decisões', () => {
  it('revogada é detectada por status ou por revoked_at', () => {
    expect(isRevoked(dec('a', { status: 'revoked' }))).toBe(true);
    expect(isRevoked(dec('b', { revoked_at: '2026-01-01' }))).toBe(true);
    expect(isRevoked(dec('c'))).toBe(false);
    // Regressão real: admission.status é sempre "admitted" e ler esse campo
    // reportava 0 revogadas onde havia 8. A revogação mora em
    // content.continuity.status / revocation_reason.
    expect(isRevoked(dec('d', { status: 'admitted' }))).toBe(false);
    expect(isRevoked(dec('e', { revocation_reason: 'substituída por X' }))).toBe(true);
  });

  it('revogada continua contada — some do vigor, não da história', () => {
    const p = projectDecisions([dec('a'), dec('b', { status: 'revoked' })]);
    expect(p.stats.total).toBe(2);
    expect(p.stats.active).toBe(1);
    expect(p.stats.revoked).toBe(1);
  });

  it('decisão sem consequência é regra sem custo conhecido', () => {
    expect(hasConsequences(dec('a', { consequences: '  ' }))).toBe(false);
    expect(hasConsequences(dec('b', { consequences: [] }))).toBe(false);
    expect(hasConsequences(dec('c', { consequences: ['x'] }))).toBe(true);
    expect(projectDecisions([dec('d', { consequences: '' })]).stats.withoutConsequences).toBe(1);
  });
});

describe('linhagem divergente: invisível não é inexistente', () => {
  const rec = (id, ref, q) => ({ id, content: { source_ref: ref, question: q, sources: ['u'] } });

  it('agrupa records que compartilham source_ref', () => {
    // 4 records com o mesmo ref viram uma linhagem DIVERGED e o leitor
    // canônico descarta o conjunto inteiro. Existem no disco, não existem
    // para nenhum consumidor.
    const d = divergedLineages([
      rec('a', 'nexos://research', 'q1'), rec('b', 'nexos://research', 'q2'),
      rec('c', 'nexos://research/unico', 'q3'),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0].count).toBe(2);
    expect(d[0].sourceRef).toBe('nexos://research');
  });

  it('separa o que está no disco do que é legível', () => {
    const p = projectResearch([
      rec('a', 'nexos://research', 'q1'), rec('b', 'nexos://research', 'q2'),
      rec('c', 'nexos://research/unico', 'q3'),
    ]);
    expect(p.stats.onDisk).toBe(3);
    expect(p.stats.invisibleByLineage).toBe(2);
    expect(p.stats.readable).toBe(1);
  });

  it('record sem source_ref não inventa linhagem', () => {
    expect(divergedLineages([{ id: 'x', content: {} }, { id: 'y', content: {} }])).toEqual([]);
  });
});

describe('research: acervo vazio é o achado', () => {
  it('marca acervo fino em vez de mostrar lista em branco', () => {
    expect(projectResearch([]).emptyIsTheFinding).toBe(true);
    expect(projectResearch([{ content: { sources: ['u'] } }]).emptyIsTheFinding).toBe(true);
    expect(projectResearch(Array.from({ length: 6 }, () => ({ content: { sources: ['u'] } }))).emptyIsTheFinding).toBe(false);
  });

  it('separa research sem fonte — achado sem fonte não é pesquisa', () => {
    const p = projectResearch([{ content: { sources: [] } }, { content: { sources: ['http://x'] } }]);
    expect(p.stats.withoutSources).toBe(1);
    expect(p.stats.withSources).toBe(1);
  });

  it('recusa entrada que não é lista', () => {
    expect(() => projectResearch(null)).toThrow(TypeError);
    expect(() => projectDecisions(null)).toThrow(TypeError);
  });
});
