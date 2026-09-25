import { describe, expect, it } from 'vitest';
import { REMEDY, SYNC, distanceLabel, projectRelease, syncStateOf } from './release-projection.mjs';

const chain = (over = {}) => ({
  SOURCE: { value: 'aaa', distance: 0 },
  BUILD: { value: 'aaa', distance: 0 },
  RUNTIME: { value: 'aaa', distance: 0 },
  ASSETS: { value: 'aaa', distance: 0 },
  ...over,
});

describe('null NUNCA vira verde', () => {
  it('elo não observado é UNKNOWN, não MATCH', () => {
    expect(syncStateOf({ value: null, distance: null }, 'aaa')).toBe(SYNC.UNKNOWN);
    expect(syncStateOf({ value: 'aaa', distance: 0 }, null)).toBe(SYNC.UNKNOWN);
  });

  it('cadeia com um elo não observado NÃO é saudável', () => {
    // Silêncio passando por cadeia íntegra é como este detector mente.
    const p = projectRelease(chain({ RUNTIME: { value: null, distance: null } }));
    expect(p.healthy).toBe(false);
    expect(p.stats.unknown).toBe(1);
    expect(p.stats.outOfSync).toBe(0); // "não sei" não é "está errado"
  });

  it('SOURCE ausente derruba a referência inteira', () => {
    const p = projectRelease(chain({ SOURCE: { value: null, distance: null } }));
    expect(p.links.every((l) => l.state === SYNC.UNKNOWN)).toBe(true);
    expect(p.healthy).toBe(false);
  });
});

describe('distância é acionável; "diferente" não é', () => {
  it('reporta quantos commits atrás', () => {
    expect(distanceLabel({ distance: 69 })).toBe('69 commits atrás');
    expect(distanceLabel({ distance: 1 })).toBe('1 commit atrás');
    expect(distanceLabel({ distance: 0 })).toBe('em dia');
  });

  it('distância não medida se declara em vez de virar zero', () => {
    expect(distanceLabel({ distance: null })).toBe('distância não medida');
    expect(syncStateOf({ value: 'bbb', distance: null }, 'aaa')).toBe(SYNC.DIVERGED);
  });

  it('guarda a pior distância da cadeia', () => {
    const p = projectRelease(chain({ RUNTIME: { value: 'zzz', distance: 69 } }));
    expect(p.stats.worstDistance).toBe(69);
    expect(p.links.find((l) => l.name === 'RUNTIME').state).toBe(SYNC.BEHIND);
  });
});

describe('cadeia íntegra exige todos observados E batendo', () => {
  it('quatro iguais e observados é saudável', () => {
    expect(projectRelease(chain()).healthy).toBe(true);
    expect(projectRelease(chain()).stats.inSync).toBe(4);
  });

  it('um atrás derruba', () => {
    expect(projectRelease(chain({ ASSETS: { value: 'old', distance: 3 } })).healthy).toBe(false);
  });
});

describe('elo com referência própria não dá alarme falso', () => {
  it('ASSETS compara com a versão do pacote, não com o hash do commit', () => {
    // Regressão real: com tudo instalado certo, ASSETS aparecia DIVERGED
    // porque 6.5.2 nunca igualaria um hash de commit. Vermelho que nunca
    // apaga ensina o usuário a ignorar a tela.
    const p = projectRelease(chain({ ASSETS: { value: '6.5.2', distance: null, compareTo: '6.5.2' } }));
    expect(p.links.find((l) => l.name === 'ASSETS').state).toBe(SYNC.MATCH);
    expect(p.healthy).toBe(true);
  });

  it('versão de pacote diferente da instalada continua sendo divergência', () => {
    const p = projectRelease(chain({ ASSETS: { value: '6.5.1', distance: null, compareTo: '6.5.2' } }));
    expect(p.links.find((l) => l.name === 'ASSETS').state).toBe(SYNC.DIVERGED);
  });
});

describe('a ação corretiva é uma só e tem dono', () => {
  it('a projeção carrega comando e de quem é', () => {
    const p = projectRelease(chain());
    expect(p.remedy.command).toMatch(/nexos install/);
    expect(REMEDY.whose).toMatch(/dono/);
  });

  it('recusa entrada inválida', () => {
    expect(() => projectRelease(null)).toThrow(TypeError);
  });
});
