import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, join as _j, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CapabilityContractError, LADDER, UNMEASURED,
  assertCapabilities, isOurs, projectCapabilities, provenRung, readableByOurScanner,
} from './capability-projection.mjs';

const cap = (over = {}) => ({
  kind: 'skill', id: 'x', name: 'x', source: 'personal', invocation: 'Skill tool',
  description: 'faz algo', enabled: true, listing_chars: 100, ...over,
});

describe('propriedade', () => {
  it('nosso é source=project; o resto é alheio', () => {
    expect(isOurs(cap({ source: 'project' }))).toBe(true);
    expect(isOurs(cap({ source: 'personal' }))).toBe(false);
    expect(isOurs(cap({ source: 'plugin' }))).toBe(false);
  });
});

describe('a escada não sobe por herança', () => {
  it('desabilitada para em INSTALLED, mesmo com description', () => {
    expect(provenRung(cap({ enabled: false }))).toBe('INSTALLED');
  });

  it('description que NOSSO SCANNER não leu para em LISTED — não prova que falta', () => {
    // 114 dos 199 reportados "sem description" TÊM o campo no arquivo: o
    // parser falha em 3 condições distintas e as três viram string vazia.
    // PARSE FAILURE != ABSENT FIELD, então o degrau para em LISTED sem
    // afirmar que a capability é inalcançável.
    expect(provenRung(cap({ description: '' }))).toBe('LISTED');
    expect(provenRung(cap({ description: undefined }))).toBe('LISTED');
    expect(readableByOurScanner(cap({ description: '   ' }))).toBe(false);
  });

  it('habilitada e descritível chega a INVOCABLE — e para aí', () => {
    expect(provenRung(cap())).toBe('INVOCABLE');
  });

  it('INVOKED e EFFECTIVE nunca são inferidos', () => {
    const p = projectCapabilities({ items: [cap(), cap(), cap()] });
    expect(p.byRung.INVOKED).toBe(0);
    expect(p.byRung.EFFECTIVE).toBe(0);
    expect(p.stats.highestProvenRung).toBe('INVOCABLE');
    expect(UNMEASURED.EFFECTIVE).toMatch(/não existe/);
  });

  it('os degraus não medidos aparecem com zero, não ausentes', () => {
    // Ausente na tela parece "não se aplica"; o que é, é "ninguém mediu".
    const p = projectCapabilities({ items: [cap()] });
    expect(Object.keys(p.byRung)).toEqual(expect.arrayContaining(['INVOKED', 'EFFECTIVE']));
    expect(LADDER).toContain('EFFECTIVE');
  });
});

describe('os três casos ficam separados, porque as correções são opostas', () => {
  it('agrupa por frontmatter_issue em vez de um balde só', () => {
    const p = projectCapabilities({ items: [
      cap({ description: '', frontmatter_issue: 'INVALID_YAML' }),
      cap({ description: '', frontmatter_issue: 'INVALID_YAML' }),
      cap({ description: '', frontmatter_issue: 'UNTERMINATED' }),
      cap({ description: '' }),
    ] });
    expect(p.byIssue.INVALID_YAML).toBe(2);
    expect(p.byIssue.UNTERMINATED).toBe(1);
    expect(p.byIssue.NO_FRONTMATTER_OR_UNKNOWN).toBe(1);
  });

  it('cada causa carrega a ação corretiva, que é diferente em cada uma', () => {
    const p = projectCapabilities({ items: [cap()] });
    expect(p.issueMeaning.UNTERMINATED).toMatch(/delimitador/);
    expect(p.issueMeaning.INVALID_YAML).toMatch(/sintaxe/);
    expect(p.issueMeaning.NO_FRONTMATTER).toMatch(/escrever/);
  });

  it('item legível não entra em nenhum balde de problema', () => {
    expect(projectCapabilities({ items: [cap()] }).byIssue).toEqual({});
  });
});

describe('contrato', () => {
  it('recusa payload sem items[]', () => {
    expect(() => assertCapabilities({})).toThrow(/sem items/);
    expect(() => assertCapabilities(null)).toThrow(CapabilityContractError);
  });
});

describe('controle real — o inventário desta máquina', () => {
  const root = (() => {
    for (let dir = process.cwd(), i = 0; i < 6; i += 1, dir = resolve(dir, '..')) {
      if (existsSync(join(dir, 'dist', 'index.js')) && existsSync(join(dir, 'bin', 'nexos.js'))) return dir;
    }
    return null;
  })();
  // Sem skills nem agentes no host não há inventário a projetar: o runner do CI
  // tem HOME vazio e `capabilities --json` devolve 0 itens (medido 23/09,
  // run 35848529645). Onde o inventário existe, 0 continua sendo falha.
  const temInventario = ['skills', 'agents'].some((d) => {
    try { return readdirSync(join(homedir(), '.claude', d)).length > 0; } catch { return false; }
  });

  it.skipIf(root === null || !temInventario)('projeta o capabilities --json real', () => {
    const out = execFileSync('node', ['bin/nexos.js', 'capabilities', '--json'], {
      cwd: /** @type {string} */ (root), encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    });
    const p = projectCapabilities(JSON.parse(out));
    expect(p.stats.total).toBeGreaterThan(0);
    // A soma dos degraus provados tem que fechar com o total — nenhum item
    // pode sumir da escada por cair num galho não previsto.
    const proven = ['INSTALLED', 'LISTED', 'INVOCABLE'].reduce((s, k) => s + (p.byRung[k] || 0), 0);
    expect(proven).toBe(p.stats.total);
    expect(p.stats.ours + p.stats.foreign).toBe(p.stats.total);
    expect(p.byRung.INVOKED).toBe(0);
  });
});

/**
 * ZERO POR CONSTRUÇÃO NÃO É ZERO MEDIDO — o achado da verificação
 * independente (nexos://gotcha/verificacao-independente-do-console-...).
 * O teste anterior travava `INVOKED: 0` como comportamento correto; era
 * correto só enquanto não existia produtor.
 */
describe('INVOKED: 0 é ausência de medição, nunca ausência de uso', () => {
  const inv = { items: [cap(), cap()] };

  it('sem usage, INVOKED fica 0 E declarado não medido', () => {
    const p = projectCapabilities(inv);
    expect(p.byRung.INVOKED).toBe(0);
    expect(p.unmeasured.INVOKED).toBeTruthy();
    expect(p.usageScan).toBeNull();
  });

  it('com usage real, INVOKED sai de não-medido e traz o denominador', () => {
    const p = projectCapabilities(inv, {
      scan: { transcriptsRead: 1665, linesRead: 907591, unreadable: 0 },
      invoked: Array.from({ length: 23 }, (_, i) => ({ nome: `c${i}` })),
    });
    expect(p.byRung.INVOKED).toBe(23);
    expect(p.unmeasured.INVOKED).toBeUndefined();
    expect(p.usageScan.transcriptsRead).toBe(1665);
  });

  /**
   * CONTROLE NEGATIVO do erro que quase apagou os três providers:
   * varredura que não leu nada não pode promover o degrau.
   */
  it('varredura vazia NÃO conta como medição', () => {
    const p = projectCapabilities(inv, { scan: { transcriptsRead: 0, linesRead: 0 }, invoked: [] });
    expect(p.byRung.INVOKED).toBe(0);
    expect(p.unmeasured.INVOKED).toBeTruthy();
    expect(p.usageScan).toBeNull();
  });
});
