import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HEALTH_GAPS, HealthContractError, SEVERITY,
  assertDoctor, isActionable, projectHealth,
} from './health-projection.mjs';

const doctor = (over = {}) => ({
  state: 'HEALTHY', rootPath: '/r', projectId: 'prj_x', reasons: [],
  evidence: [{ area: 'map', detail: 'fresh' }],
  plan: [], ...over,
});

describe('contrato do doctor json', () => {
  it('recusa payload sem state, evidence ou plan', () => {
    expect(() => assertDoctor({})).toThrow(/sem state/);
    expect(() => assertDoctor({ state: 'HEALTHY' })).toThrow(/sem evidence/);
    expect(() => assertDoctor({ state: 'HEALTHY', evidence: [] })).toThrow(/sem plan/);
    expect(() => assertDoctor(null)).toThrow(HealthContractError);
  });
});

describe('estado desconhecido nunca vira verde', () => {
  it('um state que a tela não conhece é UNKNOWN, não OK', () => {
    const p = projectHealth(doctor({ state: 'ALGO_NOVO' }));
    expect(p.severity).toBe(SEVERITY.UNKNOWN);
    expect(p.known).toBe(false);
  });

  it('HEALTHY é OK e DRIFTED é DRIFT', () => {
    expect(projectHealth(doctor()).severity).toBe(SEVERITY.OK);
    expect(projectHealth(doctor({ state: 'DRIFTED' })).severity).toBe(SEVERITY.DRIFT);
  });

  it('CORRUPT e CONFLICT são BLOCKED', () => {
    expect(projectHealth(doctor({ state: 'CORRUPT' })).severity).toBe(SEVERITY.BLOCKED);
    expect(projectHealth(doctor({ state: 'CONFLICT' })).severity).toBe(SEVERITY.BLOCKED);
  });
});

describe('acionável exige o comando, não a boa vontade', () => {
  it('item sem command é aviso, não tarefa', () => {
    expect(isActionable({ action: 'PRESERVE', detail: 'x' })).toBe(false);
    expect(isActionable({ action: 'UPDATE', detail: 'x', command: 'nexos install' })).toBe(true);
    expect(isActionable({ action: 'UPDATE', detail: 'x', command: '' })).toBe(false);
  });

  it('separa plano acionável de aviso', () => {
    const p = projectHealth(doctor({
      plan: [
        { action: 'UPDATE', area: 'global-install', detail: 'a', command: 'nexos install' },
        { action: 'PRESERVE', area: 'claude-md', detail: 'b' },
      ],
    }));
    expect(p.actionable).toHaveLength(1);
    expect(p.advisoryOnly).toHaveLength(1);
  });
});

describe('plano e evidência ficam juntos pela área', () => {
  it('a área carrega o porquê e o o-quê-fazer', () => {
    const p = projectHealth(doctor({
      evidence: [{ area: 'global-install', detail: '2 desatualizados' }],
      plan: [{ action: 'UPDATE', area: 'global-install', detail: 'atualizar', command: 'nexos install' }],
    }));
    const area = p.areas.find((a) => a.area === 'global-install');
    expect(area.evidence).toEqual(['2 desatualizados']);
    expect(area.plan[0].actionable).toBe(true);
  });

  it('área que só aparece no plano não some da tela', () => {
    const p = projectHealth(doctor({ evidence: [], plan: [{ action: 'UPDATE', area: 'orfa', detail: 'x' }] }));
    expect(p.areas.map((a) => a.area)).toContain('orfa');
  });
});

describe('as lacunas declaradas foram fechadas por contrato', () => {
    it('não sobra nenhuma lacuna aberta', () => {
      // Este teste já afirmou o contrário: WORK_STATE e CHECKPOINT_HEAD eram
      // lacunas reais, declaradas em vez de estimadas. Declará-las foi o que
      // produziu `boot --json` e `checkpoint --json`. Se uma nova lacuna
      // aparecer, ela entra aqui e este teste falha — que é o comportamento
      // certo: lacuna nova tem que ser decidida, não absorvida em silêncio.
      expect(Object.keys(HEALTH_GAPS)).toEqual([]);
    });
  });

describe('controle real — o doctor deste projeto, não uma fixture', () => {
  // O binário precisa de dist/, que é build e não é versionado: um worktree
  // não tem. Por isso o comando roda SEMPRE da raiz do checkout principal,
  // localizada subindo até achar dist/index.js — nunca um path fixo.
  const root = (() => {
    for (let dir = process.cwd(), i = 0; i < 6; i += 1, dir = resolve(dir, '..')) {
      if (existsSync(join(dir, 'dist', 'index.js')) && existsSync(join(dir, 'bin', 'nexos.js'))) return dir;
    }
    return null;
  })();

  it.skipIf(root === null)('projeta o json que o binário produz agora', () => {
    const out = execFileSync('node', ['bin/nexos.js', 'doctor', '--project', '--json'], {
      cwd: /** @type {string} */ (root), encoding: 'utf8', timeout: 60000,
    });
    const p = projectHealth(JSON.parse(out));
    expect(p.known, `state "${p.state}" não está mapeado em STATE_SEVERITY`).toBe(true);
    expect(p.stats.areas).toBeGreaterThan(0);
    expect(p.actionable.every((a) => typeof a.command === 'string')).toBe(true);
  });
});
