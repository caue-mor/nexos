import { describe, expect, it } from 'vitest';
import {
  COUNT_SOURCE, MemoryContractError, PROMOTION,
  bucketOf, hasEvidence, isCandidate, projectMemory, waitingDays,
} from './memory-projection.mjs';

const NOW = new Date('2026-09-18T12:00:00Z');
const rec = (id, kind, createdAt, over = {}) => ({
  id, kind, created_at: createdAt,
  content: { fact: `f-${id}`, evidence: `e-${id}`, origin_note: 'sessao x', proposed_kind: 'gotcha', ...over },
});

describe('candidato contra canônico', () => {
  it('só memory_candidate é candidato', () => {
    expect(isCandidate({ kind: 'memory_candidate' })).toBe(true);
    expect(isCandidate({ kind: 'gotcha' })).toBe(false);
  });

  it('separa a fila do acervo', () => {
    const p = projectMemory([
      rec('a', 'memory_candidate', '2026-09-18T00:00:00Z'),
      rec('b', 'gotcha', '2026-09-01T00:00:00Z'),
    ], NOW);
    expect(p.stats.candidates).toBe(1);
    expect(p.stats.canonical).toBe(1);
  });
});

describe('idade sem ler o relógio real', () => {
  it('conta dias de espera contra o now injetado', () => {
    expect(waitingDays({ created_at: '2026-09-11T12:00:00Z' }, NOW)).toBe(7);
    expect(waitingDays({ created_at: '2026-09-18T11:00:00Z' }, NOW)).toBe(0);
  });

  it('sem data é DESCONHECIDO, não zero', () => {
    expect(waitingDays({}, NOW)).toBeNull();
    expect(waitingDays({ created_at: 'não-é-data' }, NOW)).toBeNull();
    expect(bucketOf(null)).toBe('idade desconhecida');
  });

  it('classifica nas faixas certas', () => {
    expect(bucketOf(21)).toBe('mais de 14 dias');
    expect(bucketOf(9)).toBe('7 a 14 dias');
    expect(bucketOf(3)).toBe('1 a 7 dias');
    expect(bucketOf(0)).toBe('hoje');
  });
});

describe('a fila põe o mais velho no topo', () => {
  const p = projectMemory([
    rec('novo', 'memory_candidate', '2026-09-18T09:00:00Z'),
    rec('velho', 'memory_candidate', '2026-08-28T09:00:00Z'),
    rec('medio', 'memory_candidate', '2026-09-15T09:00:00Z'),
  ], NOW);

  it('ordena por espera decrescente', () => {
    expect(p.queue.map((q) => q.id)).toEqual(['velho', 'medio', 'novo']);
    expect(p.stats.oldestDays).toBe(21);
  });

  it('idade desconhecida vai para o fim, nunca se disfarça de novo', () => {
    const q = projectMemory([
      rec('sem-data', 'memory_candidate', undefined),
      rec('com-data', 'memory_candidate', '2026-09-17T09:00:00Z'),
    ], NOW).queue;
    expect(q[q.length - 1].id).toBe('sem-data');
  });
});

describe('candidato sem evidência é indecidível', () => {
  it('conta os que não dão ao dono como julgar', () => {
    const p = projectMemory([
      rec('ok', 'memory_candidate', '2026-09-18T09:00:00Z'),
      rec('vazio', 'memory_candidate', '2026-09-18T09:00:00Z', { evidence: '   ' }),
      rec('nulo', 'memory_candidate', '2026-09-18T09:00:00Z', { evidence: undefined }),
    ], NOW);
    expect(p.stats.withoutEvidence).toBe(2);
    expect(hasEvidence(rec('x', 'memory_candidate', NOW.toISOString()))).toBe(true);
  });
});

describe('nenhum agente promove, e o número é zero de propósito', () => {
  it('declara o ator e o canal do gate', () => {
    const p = projectMemory([rec('a', 'memory_candidate', '2026-09-18T09:00:00Z')], NOW);
    expect(p.stats.promotableByAgent).toBe(0);
    expect(p.promotion.ACTOR).toBe('human');
    expect(p.promotion.CHANNEL).toBe('/dev/tty');
    expect(PROMOTION.WHY).toMatch(/fail-closed/);
  });
});

describe('a contagem se declara nao-canonica', () => {
  it('avisa que conta arquivos, nao a fila', () => {
    // 259 arquivos no diretorio contra 87 na fila real. Ler o diretorio conta
    // historia como se fosse pendencia, e o filtro por `deprecation` sozinho
    // nao fecha: metade e superada por linhagem.
    const p = projectMemory([rec('a', 'memory_candidate', '2026-09-18T09:00:00Z')], NOW);
    expect(p.countSource.canonical).toBe(false);
    expect(p.countSource.needed).toMatch(/--review/);
    expect(p.stats.candidatesInDirectory).toBe(p.stats.candidates);
    expect(COUNT_SOURCE.predicate).toMatch(/isDeprecated/);
  });
});

describe('contrato', () => {
  it('recusa entrada que não é lista', () => {
    expect(() => projectMemory(null)).toThrow(MemoryContractError);
  });
});
