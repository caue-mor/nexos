import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRoot, readFamily, runJson } from './collect.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-collect-'));

/** Record no formato real do Store, com a indentação que importa. */
const DECISION_REVOKED = `admission:
  approved_at: 2026-09-14T21:51:25.423Z
  status: admitted
content:
  continuity:
    revocation_reason: "Substituída por outra decisão"
    status: revoked
  decision: "texto da decisão"
  title: decisao-revogada
created_at: 2026-09-14T21:51:25.423Z
id: dec_TESTE1
`;

const DECISION_ACTIVE = `admission:
  status: admitted
content:
  continuity:
    status: active
  title: decisao-viva
created_at: 2026-09-15T00:00:00.000Z
id: dec_TESTE2
`;

describe('o parser não confunde admission.status com o status da decisão', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.yaml'), DECISION_REVOKED);
  writeFileSync(join(dir, 'b.yaml'), DECISION_ACTIVE);
  const recs = readFamily(dir);

  it('lê o status de dentro de continuity, indentado a 4', () => {
    const revogada = recs.find((r) => r.id === 'dec_TESTE1');
    // A regressão real: `  status` vale "admitted" nos dois arquivos, e ler
    // esse campo reportava 0 revogadas onde havia 8.
    expect(revogada.content.status).toBe('revoked');
    expect(revogada.content.revocation_reason).toMatch(/Substituída/);
  });

  it('não marca a ativa como revogada', () => {
    expect(recs.find((r) => r.id === 'dec_TESTE2').content.status).toBe('active');
    expect(recs.find((r) => r.id === 'dec_TESTE2').content.revocation_reason).toBeNull();
  });

  it('campo ausente vira null, não string vazia', () => {
    expect(recs.find((r) => r.id === 'dec_TESTE2').content.state).toBeNull();
  });
});

describe('readFamily é defensivo com o diretório', () => {
  it('diretório inexistente devolve lista vazia, não explode', () => {
    expect(readFamily(join(tmp(), 'nao-existe'))).toEqual([]);
  });

  it('ignora o que não é .yaml e o que não é arquivo', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x.yaml'), 'id: ok\n');
    writeFileSync(join(dir, 'leia-me.txt'), 'ruído');
    mkdirSync(join(dir, 'subdir.yaml')); // diretório com extensão .yaml derrubava a leitura
    expect(readFamily(dir).map((r) => r.id)).toEqual(['ok']);
  });
});

describe('runJson degrada em vez de derrubar o console', () => {
  it('comando inexistente vira indisponibilidade com motivo, não exceção', () => {
    const r = runJson(tmp(), ['comando-que-nao-existe', '--json']);
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
    expect(r.unavailable).toMatch(/comando-que-nao-existe/);
  });

  it('a mensagem é uma linha só — o console mostra motivo, não stack trace', () => {
    const r = runJson(tmp(), ['x']);
    expect(r.unavailable.includes('\n')).toBe(false);
  });
});

describe('findRoot', () => {
  it('devolve null quando não há checkout acima', () => {
    expect(findRoot(tmp())).toBeNull();
  });

  it('acha a raiz que tem dist/index.js E bin/nexos.js', () => {
    const root = tmp();
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'dist', 'index.js'), '');
    writeFileSync(join(root, 'bin', 'nexos.js'), '');
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findRoot(deep)).toBe(root);
  });

  it('não aceita raiz com dist/ mas sem bin/ — é o worktree, e lá o CLI não roda', () => {
    const root = tmp();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.js'), '');
    expect(findRoot(root)).toBeNull();
  });
});
