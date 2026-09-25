#!/usr/bin/env node
/**
 * Motor determinístico da base de conhecimento (nexos://decision/obsidian-vault-novo).
 *
 *   raw/     fonte bruta, imutável, com MANIFEST.tsv (sha256, url, bytes, caminho)
 *   wiki/    só o LLM escreve; toda nota declara `fonte:` apontando para raw/
 *   outputs/ respostas renderizadas
 *
 * Compilar é trabalho do LLM. Este script faz só o que é mecânico:
 *   index  gera wiki/<assunto>/index.md a partir do llms.txt de uma captura
 *   lint   bruto alterado, fonte inexistente, link quebrado, nota órfã
 *
 * Uso:
 *   node scripts/kb/kb.mjs index <vault> <captura relativa ao vault> <assunto>
 *   node scripts/kb/kb.mjs lint  <vault>
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

// `\` fecha o alvo: em tabela o Obsidian escreve o alias como [[alvo\|texto]] (achado do Jarvis, 23/09).
const LINK = /\[\[([^\]|#^\\]+)/g;
// Link dentro de código é exemplo, não ligação: bloco cercado e trecho inline saem antes da busca.
const CODIGO = /```[\s\S]*?```|`[^`\n]*`/g;

function arquivos(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith('.') ? [] : e.isDirectory() ? arquivos(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function manifesto(capturaAbs) {
  const linhas = readFileSync(join(capturaAbs, 'MANIFEST.tsv'), 'utf8').split('\n').filter(Boolean);
  return linhas.map((l) => {
    const [sha, url, bytes, caminho] = l.split('\t');
    return { sha, url, bytes: Number(bytes), caminho };
  });
}

function frontmatter(texto) {
  const m = /^---\n([\s\S]*?)\n---/.exec(texto);
  if (!m) return {};
  const fm = {};
  let lista = null;
  for (const linha of m[1].split('\n')) {
    const item = /^\s+-\s+(.+)$/.exec(linha);
    if (item && lista) { fm[lista].push(item[1].trim()); continue; }
    const kv = /^([\w-]+):\s*(.*)$/.exec(linha);
    if (!kv) continue;
    lista = kv[2] === '' ? kv[1] : null;
    fm[kv[1]] = kv[2] === '' ? [] : kv[2].trim();
  }
  return fm;
}

// Texto do llms.txt vem de fora (doc capturada): < e > viram entidade antes de entrar na nota.
const semHtml = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function index(vault, captura, assunto) {
  const capturaAbs = join(vault, captura);
  const porUrl = new Map(manifesto(capturaAbs).map((e) => [e.url, e.caminho]));
  const wikiDir = join(vault, 'wiki', assunto);
  // Chave = caminho relativo, nunca o nome final: agent-sdk/skills não é skills (medido 23/09).
  const notas = new Set(arquivos(wikiDir).map((f) => relative(wikiDir, f).replace(/\.md$/, '')));
  const saida = [
    '---',
    'tipo: indice',
    `fonte: ${join(captura, 'llms.txt')}`,
    `gerado_por: scripts/kb/kb.mjs index`,
    '---',
    `# ${assunto}: índice`,
    '',
    `Gerado do llms.txt de \`${captura}\`. **compilada** = já tem nota na wiki; **bruto** = só a fonte.`,
    '',
  ];
  let total = 0, compiladas = 0;
  for (const linha of readFileSync(join(capturaAbs, 'llms.txt'), 'utf8').split('\n')) {
    const secao = /^(#{2,4})\s+(.+)$/.exec(linha); // pt-br.md usa ####
    if (secao) { saida.push('', `${secao[1]} ${semHtml(secao[2])}`, ''); continue; }
    const item = /^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/.exec(linha);
    if (!item) continue;
    const [, titulo, url, descricao = ''] = item;
    const caminho = porUrl.get(url);
    const slug = (/\/docs\/(?:[a-z]{2}\/)?(.+)$/.exec(url)?.[1] ?? basename(url)).replace(/\.md$/, '');
    total += 1;
    const compilada = notas.has(slug);
    if (compilada) compiladas += 1;
    const alvo = compilada ? `[[wiki/${assunto}/${slug}|compilada]]` : '';
    const bruto = caminho ? `[[${join(captura, caminho)}|bruto]]` : '*(fora da captura)*';
    saida.push(`- **${semHtml(titulo)}**: ${semHtml(descricao)} ${[alvo, bruto].filter(Boolean).join(' · ')}`.trimEnd());
  }
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, 'index.md'), saida.join('\n') + '\n');
  return { total, compiladas };
}

export function lint(vault) {
  const achados = [];
  const todos = arquivos(vault);
  const nomes = new Set(todos.flatMap((f) => {
    const rel = relative(vault, f);
    return [rel, rel.replace(/\.md$/, ''), basename(f), basename(f, '.md')].map((s) => s.toLowerCase());
  }));

  for (const m of todos.filter((f) => basename(f) === 'MANIFEST.tsv')) {
    const dir = m.slice(0, -'MANIFEST.tsv'.length);
    for (const e of manifesto(dir)) {
      const alvo = join(dir, e.caminho);
      if (!existsSync(alvo)) { achados.push(['erro', 'bruto-ausente', relative(vault, alvo)]); continue; }
      const sha = createHash('sha256').update(readFileSync(alvo)).digest('hex');
      if (sha !== e.sha) achados.push(['erro', 'bruto-alterado', relative(vault, alvo)]);
    }
  }

  const notas = [...arquivos(join(vault, 'wiki')), ...arquivos(join(vault, 'outputs'))].filter((f) => f.endsWith('.md'));
  const citadas = new Set();
  for (const nota of notas) {
    const texto = readFileSync(nota, 'utf8');
    const rel = relative(vault, nota);
    if (rel.startsWith('wiki/')) {
      const fonte = frontmatter(texto).fonte;
      const fontes = Array.isArray(fonte) ? fonte : fonte ? [fonte] : [];
      if (fontes.length === 0) achados.push(['erro', 'sem-fonte', rel]);
      for (const f of fontes) if (!existsSync(join(vault, f))) achados.push(['erro', 'fonte-inexistente', `${rel} -> ${f}`]);
    }
    for (const [, alvo] of texto.replace(CODIGO, '').matchAll(LINK)) {
      const t = alvo.trim().toLowerCase();
      if (!nomes.has(t) && !nomes.has(basename(t))) achados.push(['erro', 'link-quebrado', `${rel} -> ${alvo}`]);
      citadas.add(basename(t).replace(/\.md$/, ''));
    }
  }
  for (const nota of notas.filter((f) => relative(vault, f).startsWith('wiki/'))) {
    const nome = basename(nota, '.md').toLowerCase();
    if (nome !== 'index' && !citadas.has(nome)) achados.push(['aviso', 'orfa', relative(vault, nota)]);
  }
  return achados;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, vault, ...resto] = process.argv.slice(2);
  if (cmd === 'index' && vault && resto.length === 2) {
    const r = index(vault, resto[0], resto[1]);
    console.log(`index: ${r.total} paginas, ${r.compiladas} compiladas`);
  } else if (cmd === 'lint' && vault) {
    const achados = lint(vault);
    for (const [nivel, tipo, onde] of achados) console.log(`${nivel.padEnd(5)} ${tipo.padEnd(18)} ${onde}`);
    const erros = achados.filter(([n]) => n === 'erro').length;
    console.log(`lint: ${erros} erro(s), ${achados.length - erros} aviso(s)`);
    process.exit(erros ? 1 : 0);
  } else {
    console.error('uso: kb.mjs index <vault> <captura> <assunto> | kb.mjs lint <vault>');
    process.exit(2);
  }
}
