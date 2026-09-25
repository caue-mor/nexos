import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ChainContractError, buildChains, evidenceReachability, isTerminal, isTerminalWithoutReason,
  projectCheckpoints, walkChain,
} from './checkpoint-projection.mjs';

const cp = (id, state, prev = null, over = {}) => ({
  id, previous_checkpoint_id: prev,
  content: { state, statement: `s-${id}`, attempt: 1, actor_ref: 'papel:x', ...over },
});

describe('terminal e motivo', () => {
  it('SUCCEEDED, FAILED e BLOCKED são terminais; VERIFYING não', () => {
    expect(isTerminal(cp('a', 'SUCCEEDED'))).toBe(true);
    expect(isTerminal(cp('b', 'FAILED'))).toBe(true);
    expect(isTerminal(cp('c', 'BLOCKED'))).toBe(true);
    expect(isTerminal(cp('d', 'VERIFYING'))).toBe(false);
  });

  it('terminal sem content.verification é terminal sem motivo', () => {
    expect(isTerminalWithoutReason(cp('a', 'FAILED'))).toBe(true);
    expect(isTerminalWithoutReason(cp('b', 'FAILED', null, { verification: { why: 'x' } }))).toBe(false);
  });

  it('aberto sem motivo NÃO conta — só terminal precisa justificar', () => {
    expect(isTerminalWithoutReason(cp('c', 'RUNNING'))).toBe(false);
  });
});

describe('ONE HOP != THE CHAIN — evidência a um salto ainda é evidência', () => {
  const chain = [
    cp('done', 'SUCCEEDED', 'verify'),
    cp('verify', 'VERIFYING', 'run'),
    cp('run', 'RUNNING', null),
  ];

  it('terminal sem evidência própria alcança pelo antecessor', () => {
    // A Evidence amarra ao elo que PROVOU (VERIFYING), e a cadeia avança
    // para SUCCEEDED com outro id. Medir só o terminal reportava perda total
    // onde 100% era alcançável.
    const r = evidenceReachability(chain, new Set(['verify']));
    expect(r.reachable).toBe(1);
    expect(r.unreachable).toBe(0);
    expect(r.hops['1']).toBe(1);
  });

  it('conta zero salto quando a evidência está no próprio terminal', () => {
    expect(evidenceReachability(chain, new Set(['done'])).hops['0']).toBe(1);
  });

  it('só alarma quando a cadeia inteira não alcança nada', () => {
    const r = evidenceReachability(chain, new Set(['outro']));
    expect(r.trulyUnprovable).toBe(1);
    expect(r.orphans[0].id).toBe('done');
  });

  it('não trava em ciclo', () => {
    const ciclo = [cp('a', 'FAILED', 'b'), cp('b', 'READY', 'a')];
    expect(() => evidenceReachability(ciclo, new Set())).not.toThrow();
  });
});

describe('cadeia', () => {
  const list = [cp('c3', 'SUCCEEDED', 'c2'), cp('c2', 'RUNNING', 'c1'), cp('c1', 'READY')];

  it('acha a cabeça e a raiz', () => {
    const { heads, roots } = buildChains(list);
    expect(heads.map((h) => h.id)).toEqual(['c3']);
    expect(roots.map((r) => r.id)).toEqual(['c1']);
  });

  it('caminha da cabeça à raiz na ordem', () => {
    const { byId } = buildChains(list);
    expect(walkChain(byId, 'c3').chain.map((c) => c.id)).toEqual(['c3', 'c2', 'c1']);
  });

  it('REPORTA elo quebrado em vez de esconder', () => {
    const { danglingLinks } = buildChains([cp('x', 'READY', 'nao-existe')]);
    expect(danglingLinks).toEqual([{ id: 'x', missing: 'nao-existe' }]);
  });

  it('não trava em ciclo', () => {
    const { byId } = buildChains([cp('a', 'READY', 'b'), cp('b', 'READY', 'a')]);
    const r = walkChain(byId, 'a');
    expect(r.truncated).toBe(true);
    expect(r.reason).toMatch(/ciclo/);
  });

  it('recusa entrada que não é lista', () => {
    expect(() => buildChains(null)).toThrow(ChainContractError);
  });
});

describe('a lacuna de motivo por estado é o que a tela destaca', () => {
  it('conta total e faltantes por estado terminal', () => {
    const p = projectCheckpoints([
      cp('a', 'FAILED'), cp('b', 'FAILED'),
      cp('c', 'SUCCEEDED', null, { verification: { ok: true } }),
      cp('d', 'SUCCEEDED'), cp('e', 'RUNNING'),
    ]);
    expect(p.reasonGap.FAILED).toEqual({ total: 2, missing: 2 });
    expect(p.reasonGap.SUCCEEDED).toEqual({ total: 2, missing: 1 });
    expect(p.reasonGap.RUNNING).toBeUndefined();
    expect(p.stats.terminalsWithoutReason).toBe(3);
  });

  it('checkpoint sem estado não é silenciado', () => {
    const p = projectCheckpoints([{ id: 'x', previous_checkpoint_id: null, content: {} }]);
    expect(p.byState.SEM_ESTADO).toBe(1);
  });
});

describe('controle real — os checkpoints deste Store', () => {
  // provisório: lê o disco porque não existe comando que liste a cadeia em
  // JSON. O contrato foi pedido ao core; quando existir, a fonte vira ele.
  const root = (() => {
    for (let dir = process.cwd(), i = 0; i < 6; i += 1, dir = resolve(dir, '..')) {
      const d = join(dir, '.nexos', 'records', 'checkpoints');
      if (existsSync(d) && existsSync(join(dir, 'dist', 'index.js'))) return d;
    }
    return null;
  })();

  it.skipIf(root === null)('mede a lacuna de motivo no Store real', () => {
    const list = readdirSync(root)
      .filter((f) => f.endsWith('.yaml') && statSync(join(root, f)).isFile())
      .map((f) => {
        const t = readFileSync(join(root, f), 'utf8');
        return {
          id: (t.match(/^id: *(\S+)/m) || [])[1],
          previous_checkpoint_id: (t.match(/^previous_checkpoint_id: *(\S+)/m) || [])[1] ?? null,
          content: {
            state: (t.match(/^  state: *(\w+)/m) || [])[1],
            verification: /^  verification:/m.test(t) ? {} : null,
          },
        };
      });

    const p = projectCheckpoints(list);
    expect(p.stats.total).toBeGreaterThan(0);
    // Invariante do defeito medido: FAILED e BLOCKED não registram motivo.
    // Se algum dia passar a registrar, este teste falha — e a falha é a boa notícia.
    for (const state of ['FAILED', 'BLOCKED']) {
      if (p.reasonGap[state]) {
        expect(p.reasonGap[state].missing).toBe(p.reasonGap[state].total);
      }
    }
    expect(p.stats.terminalsWithoutReason).toBeGreaterThan(0);
  });
});

/**
 * RECORD COM ESTADO BLOCKED != TRABALHO BLOQUEADO
 *
 * Achado depois que o painel publicou "15 tarefas bloqueadas" e o doc 14 usou
 * o número como pré-condição de arquitetura. Medido: 460 checkpoints, UMA
 * linhagem, UM head — nos heads, 0 BLOCKED.
 */
describe('pendência vem do head, histórico vem de todos', () => {
  /** Corrente: r1 -> r2 -> r3. Só r3 é o agora. */
  const corrente = [
    { id: 'r1', previous_checkpoint_id: null, content: { state: 'BLOCKED' } },
    { id: 'r2', previous_checkpoint_id: 'r1', content: { state: 'HUMAN_REQUIRED' } },
    { id: 'r3', previous_checkpoint_id: 'r2', content: { state: 'VERIFYING' } },
  ];

  it('byState conta a história inteira da cadeia', () => {
    const p = projectCheckpoints(corrente);
    expect(p.byState.BLOCKED).toBe(1);
    expect(p.byState.HUMAN_REQUIRED).toBe(1);
  });

  it('byStateHead conta só o agora — e não há bloqueio nenhum', () => {
    const p = projectCheckpoints(corrente);
    expect(p.byStateHead.BLOCKED).toBeUndefined();
    expect(p.byStateHead.HUMAN_REQUIRED).toBeUndefined();
    expect(p.byStateHead.VERIFYING).toBe(1);
  });

  it('bloqueio REAL no head aparece', () => {
    const p = projectCheckpoints([
      ...corrente.slice(0, 2),
      { id: 'r3', previous_checkpoint_id: 'r2', content: { state: 'BLOCKED' } },
    ]);
    expect(p.byStateHead.BLOCKED).toBe(1);
    expect(p.byState.BLOCKED).toBe(2);
  });

  /** Correntes paralelas: dois heads, duas pendências reais. */
  it('linhagens independentes somam seus próprios heads', () => {
    const p = projectCheckpoints([
      { id: 'a1', previous_checkpoint_id: null, content: { state: 'BLOCKED' } },
      { id: 'b1', previous_checkpoint_id: null, content: { state: 'BLOCKED' } },
    ]);
    expect(p.byStateHead.BLOCKED).toBe(2);
  });
});
