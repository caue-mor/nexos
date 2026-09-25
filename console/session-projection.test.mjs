import { describe, expect, it } from 'vitest';
import { EMPTY_MEANING, OBSERVED_STATUS, REGISTRY_INCOMPLETE, projectSessions } from './session-projection.mjs';

const NOW = new Date('2026-09-18T22:00:00Z');
const s = (id, over = {}) => ({
  id, project_id: 'prj_x', host: 'claude-code', cwd: '/repo', agent_ref: null,
  started_at: '2026-09-18T21:00:00Z', last_activity_at: null, checkpoint_id: null,
  status: 'ACTIVE', ...over,
});

describe('ACTIVE é observação, não verificação', () => {
  it('o significado fica declarado na projeção', () => {
    const p = projectSessions([s('a')], NOW);
    expect(p.observedStatus.ACTIVE).toMatch(/não é prova/);
    expect(OBSERVED_STATUS.CLOSED).toMatch(/observado/);
  });

  it('não inventa estado derivado da idade', () => {
    // Uma sessão de 10 horas continua ACTIVE. "Provavelmente morreu" seria
    // um estado que ninguém mediu.
    const p = projectSessions([s('velha', { started_at: '2026-09-18T12:00:00Z' })], NOW);
    expect(p.rows[0].status).toBe('ACTIVE');
    expect(p.rows[0].ageMinutes).toBe(600);
  });
});

describe('a tela declara que o registro está incompleto', () => {
  it('carrega a medição, a causa e a consequência', () => {
    // 2 de 7 aberturas, 0 fechamentos. Mostrar "2 abertas" sem isto seria
    // número bonito e falso.
    const p = projectSessions([s('a')], NOW);
    expect(p.registryIncomplete.medido).toMatch(/1 sessão real/);
    expect(p.registryIncomplete.porque).toMatch(/não houve oportunidade/);
    expect(REGISTRY_INCOMPLETE.consequencia).toMatch(/amostra pequena/);
  });
});

describe('zero registradas não é zero rodando', () => {
  it('lista vazia carrega o que o zero significa', () => {
    // Medido: a tela mostrou 0 enquanto três sessões operavam o checkout.
    // E remoção manual de record produz o mesmo zero, indistinguível de perda.
    const p = projectSessions([], NOW);
    expect(p.emptyMeaning).toBe(EMPTY_MEANING);
    expect(p.emptyMeaning).toMatch(/não é zero sessões rodando/);
  });

  it('lista não vazia não carrega o aviso', () => {
    expect(projectSessions([s('a')], NOW).emptyMeaning).toBeNull();
  });
});

describe('last_activity_at nulo é NÃO SABIDO', () => {
  it('marca o desconhecido em vez de tratar como zero', () => {
    const p = projectSessions([s('a'), s('b', { last_activity_at: '2026-09-18T21:50:00Z' })], NOW);
    expect(p.stats.withoutLastActivity).toBe(1);
    expect(p.rows.find((r) => r.id === 'a').lastActivityKnown).toBe(false);
  });
});

describe('checkout compartilhado é o achado que a tela existe para mostrar', () => {
  it('sinaliza mais de uma ACTIVE no mesmo cwd', () => {
    const p = projectSessions([s('a'), s('b'), s('c', { cwd: '/outro' })], NOW);
    expect(p.stats.sharedCheckouts).toBe(1);
    expect(p.sharedCheckouts[0]).toEqual({ cwd: '/repo', active: 2 });
  });

  it('uma ACTIVE sozinha não é colisão', () => {
    expect(projectSessions([s('a'), s('b', { status: 'CLOSED' })], NOW).stats.sharedCheckouts).toBe(0);
  });

  it('sessão sem cwd não inventa agrupamento', () => {
    const p = projectSessions([s('a', { cwd: null }), s('b', { cwd: null })], NOW);
    expect(p.sharedCheckouts[0].cwd).toBe('(sem cwd)');
  });
});
