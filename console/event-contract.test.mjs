import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_REQUIRED, EventContractError, KNOWN_TYPES,
  assertEnvelope, projectSessionEvents, sessionRecordToEvent,
} from './event-contract.mjs';

const rec = (over = {}) => ({
  id: 'ses_01ABC', kind: 'started', created_at: '2026-09-19T02:05:31.945Z',
  project_id: 'prj_x', scope: { kind: 'session', ref: 'sessao-real-123' },
  content: { host: 'maquina', cwd: '/repo', agent_ref: null, checkpoint_id: 'chk_1' },
  ...over,
});

describe('o envelope segue o contrato do SDK', () => {
  it('exige os campos que sdk/events.ts declara', () => {
    expect(ENVELOPE_REQUIRED).toEqual(['id', 'ts', 'type', 'payload']);
    expect(() => assertEnvelope({ id: 'a', ts: 'b', type: 'x.y' })).toThrow(/payload/);
    expect(() => assertEnvelope({ ts: 'b', type: 'x.y', payload: {} })).toThrow(/id/);
  });

  it('type precisa ser dominio.acao — envelope inválido FALHA, não é silenciado', () => {
    expect(() => assertEnvelope({ id: 'a', ts: 'b', type: 'semponto', payload: {} })).toThrow(/dominio\.acao/);
    expect(() => assertEnvelope(null)).toThrow(EventContractError);
  });
});

describe('sessionId vem de scope.ref, nunca do id do record', () => {
  it('correlaciona pela sessão, não pelo ULID do record', () => {
    // O schema diz: "correlacionam-se por scope.ref, nunca pelo id do record"
    // — dois eventos da mesma sessão têm ids diferentes.
    const e = sessionRecordToEvent(rec());
    expect(e.sessionId).toBe('sessao-real-123');
    expect(e.id).toBe('ses_01ABC');
    expect(e.sessionId).not.toBe(e.id);
  });

  it('started e closed da mesma sessão compartilham sessionId e diferem em id', () => {
    const a = sessionRecordToEvent(rec({ id: 'ses_A', kind: 'started' }));
    const b = sessionRecordToEvent(rec({ id: 'ses_B', kind: 'closed' }));
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.id).not.toBe(b.id);
    expect([a.type, b.type]).toEqual(['session.started', 'session.closed']);
  });
});

describe('tipo desconhecido é marcado, não descartado', () => {
  it('kind fora do vocabulário vira evento com known=false', () => {
    const e = sessionRecordToEvent(rec({ kind: 'hibernated' }));
    expect(e.type).toBe('session.hibernated');
    expect(e.known).toBe(false);
    expect(KNOWN_TYPES).not.toContain('session.hibernated');
  });

  it('a projeção expõe os tipos desconhecidos em vez de engolir', () => {
    const p = projectSessionEvents([rec(), rec({ id: 'x', kind: 'hibernated' })]);
    expect(p.unknownTypes).toEqual(['session.hibernated']);
    expect(p.stats.total).toBe(2);
  });
});

describe('controle negativo — record inválido é REJEITADO e contado', () => {
  it('record sem kind não vira evento silencioso', () => {
    const p = projectSessionEvents([rec(), { id: 'quebrado' }]);
    expect(p.stats.total).toBe(1);
    expect(p.stats.rejected).toBe(1);
    expect(p.rejected[0].why).toMatch(/sem kind/);
  });

  it('recusa entrada que não é lista', () => {
    expect(() => projectSessionEvents(null)).toThrow(EventContractError);
  });
});

describe('ordem e proveniência', () => {
  it('mais recente primeiro', () => {
    const p = projectSessionEvents([
      rec({ id: 'velho', created_at: '2026-09-18T00:00:00Z' }),
      rec({ id: 'novo', created_at: '2026-09-19T00:00:00Z' }),
    ]);
    expect(p.events.map((e) => e.id)).toEqual(['novo', 'velho']);
  });

  it('declara de qual contrato veio', () => {
    expect(projectSessionEvents([]).contract).toMatch(/sdk\/events\.ts/);
  });
});
