import { describe, expect, it } from 'vitest';
import { bindingOf, isLegacyOutcome, outcomeOf, projectEvidence } from './evidence-projection.mjs';

const ev = (over = {}) => ({ id: 'ev_x', gate: 'test', exit_code: 0, ...over });

describe('outcome separa três condições que exit code confundia', () => {
  it('passed, failed e did_not_run são distintos', () => {
    expect(outcomeOf(ev({ outcome: 'passed' }))).toBe('passed');
    expect(outcomeOf(ev({ outcome: 'failed' }))).toBe('failed');
    expect(outcomeOf(ev({ outcome: 'did_not_run' }))).toBe('did_not_run');
  });

  it('record legado NÃO vira did_not_run nem passed por dedução', () => {
    // exit_code 0 não prova que o gate rodou: o campo existe justamente
    // porque "não rodou" e "rodou e passou" davam o mesmo código.
    expect(outcomeOf(ev({ exit_code: 0 }))).toBe('UNKNOWN_LEGACY');
    expect(outcomeOf(ev({ exit_code: 1 }))).toBe('UNKNOWN_LEGACY');
    expect(isLegacyOutcome(ev({ outcome: null }))).toBe(true);
  });

  it('valor fora do vocabulário não é silenciado', () => {
    expect(outcomeOf(ev({ outcome: 'talvez' }))).toBe('UNKNOWN_VALUE');
  });
});

describe('amarração tem três estados, não dois', () => {
  it('distingue de-propósito de não-sabido', () => {
    expect(bindingOf(ev({ subject_ref: 'chk_1' }))).toBe('BOUND');
    expect(bindingOf(ev({ deliberately_unbound: true }))).toBe('UNBOUND_ON_PURPOSE');
    expect(bindingOf(ev({}))).toBe('UNBOUND_UNKNOWN');
  });

  it('deliberately_unbound false não vira de-propósito', () => {
    expect(bindingOf(ev({ deliberately_unbound: false }))).toBe('UNBOUND_UNKNOWN');
  });
});

describe('a projeção declara o que o acervo legado não sabe', () => {
  it('conta legados e nomeia as duas lacunas', () => {
    const p = projectEvidence([ev({ outcome: 'passed' }), ev({}), ev({})]);
    expect(p.stats.legacy).toBe(2);
    expect(p.stats.legacyShare).toBeCloseTo(2 / 3);
    expect(p.gaps.LEGACY_OUTCOME).toMatch(/nem chegou a rodar/);
    expect(p.gaps.LEGACY_BINDING).toMatch(/perdeu a ligação/);
  });

  it('recusa entrada que não é lista', () => {
    expect(() => projectEvidence(null)).toThrow(TypeError);
  });
});
