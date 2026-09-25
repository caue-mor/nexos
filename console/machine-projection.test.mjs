import { describe, it, expect } from 'vitest';
import { projectMachine } from './machine-projection.mjs';

const amostra = (o = {}) => ({ cores: 10, load1: 4.7, sessions: 4, projects: 74, denied: [], ...o });

describe('projeção dos sentidos da máquina', () => {
  it('carga vira por-core, que é o número comparável', () => {
    expect(projectMachine(amostra()).loadPerCore).toBe(0.47);
    expect(projectMachine(amostra()).loadLabel).toBe('folgada');
  });

  it('saturação é por core, não pelo load cru', () => {
    expect(projectMachine(amostra({ load1: 12 })).loadLabel).toBe('saturada');
    expect(projectMachine(amostra({ load1: 12, cores: 32 })).loadLabel).toBe('folgada');
  });

  /** Dado ausente NUNCA vira 0 — é a regra que o INVOKED do console já custou uma vez. */
  it('campo ausente é null declarado, nunca zero', () => {
    const p = projectMachine({ denied: ['ps: EPERM'] });
    expect(p.sessions).toBeNull();
    expect(p.loadPerCore).toBeNull();
    expect(p.loadLabel).toBe('desconhecida');
    expect(p.sessions).not.toBe(0);
  });

  it('o que o ambiente negou atravessa declarado', () => {
    expect(projectMachine(amostra({ denied: ['ps: EPERM', 'os.uptime: EPERM'] })).denied).toHaveLength(2);
  });

  it('amostra ausente não inventa máquina', () => {
    expect(projectMachine(null).available).toBe(false);
  });
});
