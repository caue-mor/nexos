/**
 * Projeção SOMENTE LEITURA do Store no vault do Obsidian (nexos://decision/obsidian-vault-novo).
 *
 *     node console/build-obsidian.mjs "<vault>" [raiz-do-nexos-cli]
 *
 * Grava `nexos/decisoes/` com uma nota por decisão ATIVA + um índice. Tudo é GERADO:
 * cada nota leva `gerado_por` e o `source_ref` do record, e a pasta é regerada a cada
 * rodada. Nunca escreve no Store — o caminho de volta é inbox/ → candidato → validação.
 *
 * Reusa `runJson` do collect (mesma fonte canônica do console: `nexos decision`).
 * Não usa `collectAll`: ele roda o painel inteiro (~2s) e descarta o `source_ref`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, runJson } from './collect.mjs';

export const GERADO_POR = 'console/build-obsidian.mjs';
const DIR = join('nexos', 'decisoes');
const REF = /nexos:\/\/decision\/([a-z0-9][a-z0-9-]*)/g;
const TIPOS = { constraint: 'Restrições', decision: 'Decisões', preference: 'Preferências' };

const chave = (h) => (h.source_ref || '').replace('nexos://decision/', '') || h.id;
const yaml = (v) => JSON.stringify(v ?? null);  // string JSON é YAML válido e escapa aspas/quebras

/** Referência a outra decisão vira link do Obsidian; aresta real no grafo, não enfeite. */
export function linkarDecisoes(texto, existentes) {
  return String(texto ?? '').replace(REF, (m, k) => (existentes.has(k) ? `[[${DIR}/${k}|${k}]]` : m));
}

/** `#2A` no texto do Store é rótulo, não tag: sem o escape o Obsidian cria a tag e polui o painel de tags. */
const semTag = (t) => t.replace(/(^|\s)#(?=[^\s#])/g, '$1\\#');

export const ehGerado = (texto) => new RegExp(`^gerado_por: "?${GERADO_POR.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"?$`, 'm').test(texto);

/**
 * A Base é do gerador pelo NOME, não pelo carimbo: ao salvar a view (ordenar, redimensionar
 * coluna) o Obsidian reserializa o YAML e apaga os comentários — medido 23/09 no 1.13.6.
 * O comentário `gerado_por` fica só como aviso para quem abre o arquivo.
 */
const BASE_NOME = 'decisoes.base';

/**
 * Tabela nativa (core plugin Bases) das decisões, uma aba por tipo. Sintaxe:
 * raw/obsidian/2026-09-23/en/Bases/Bases syntax.md:14-61 e :180-207. Estática, mas
 * regerada junto com as notas: é projeção, e aba mexida na UI volta ao gerar de novo.
 */
const BASE_DECISOES = [
  `# gerado_por: ${GERADO_POR}`,
  '# Projeção do Store, somente leitura: editar aqui será sobrescrito na próxima geração.',
  'filters:',
  '  and:',
  `    - file.inFolder("${DIR}")`,
  `    - 'tipo == "decisao"'`,
  // `note.` obrigatório: sem ele o displayName é ignorado no Obsidian 1.13.6, embora o
  // exemplo da doc (Bases syntax.md:32-33) use a chave sem prefixo. Medido na UI em 23/09.
  'properties:',
  '  note.tipo_continuidade:',
  '    displayName: Tipo',
  '  note.source_ref:',
  '    displayName: Fonte no Store',
  'views:',
  '  - type: table',
  '    name: Por tipo',
  '    groupBy:',
  '      property: note.tipo_continuidade',
  '      direction: ASC',
  '    order:',
  '      - file.name',
  '      - tipo_continuidade',
  '      - source_ref',
  ...Object.entries(TIPOS).flatMap(([t, nome]) => [
    '  - type: table',
    `    name: ${nome}`,
    `    filters: 'tipo_continuidade == "${t}"'`,
    '    order:',
    '      - file.name',
    '      - source_ref',
  ]),
  '',
].join('\n');

/** Pura: heads de `nexos decision` → { caminhoRelativo: conteudo }. Só ativas entram. */
export function renderizarDecisoes(heads, { geradoEm }) {
  const ativas = heads.filter((h) => h?.content?.continuity?.status === 'active');
  const existentes = new Set(ativas.map(chave));
  const notas = {};
  for (const h of ativas) {
    const c = h.content ?? {}; const cont = c.continuity ?? {};
    notas[join(DIR, `${chave(h)}.md`)] = [
      '---',
      'tipo: decisao',
      `tipo_continuidade: ${yaml(cont.type)}`,
      `source_ref: ${yaml(h.source_ref)}`,
      `record_id: ${yaml(h.id)}`,
      'status: active',
      `origem: GERADO-DO-STORE`,
      'cssclasses:', '  - nexos-gerado',  // snippet .obsidian/snippets/nexos.css marca a nota como projeção
      `gerado_por: ${GERADO_POR}`,
      `gerado_em: ${yaml(geradoEm)}`,
      '---',
      // o Obsidian já mostra o nome do arquivo como título; H1 igual a ele aparecia duplicado
      ...(c.title && c.title !== chave(h) ? [`# ${c.title}`, ''] : []),
      '> Projeção do Store, somente leitura: editar aqui não muda a decisão e será sobrescrito.',
      '',
      semTag(linkarDecisoes(c.decision, existentes)),
      '',
      ...(cont.conditions ? ['## Condições', '', semTag(linkarDecisoes(cont.conditions, existentes)), ''] : []),
      ...(cont.applicability ? ['## Onde vale', '', semTag(linkarDecisoes(cont.applicability, existentes)), ''] : []),
      ...(cont.reported_source_ref ? ['## Fonte relatada', '', semTag(linkarDecisoes(cont.reported_source_ref, existentes)), ''] : []),
    ].join('\n');
  }
  const porTipo = {};
  for (const h of ativas) (porTipo[h.content?.continuity?.type ?? 'decision'] ??= []).push(h);
  notas[join(DIR, 'index.md')] = [
    '---', 'tipo: indice', 'origem: GERADO-DO-STORE', 'cssclasses:', '  - nexos-gerado', `gerado_por: ${GERADO_POR}`, `gerado_em: ${yaml(geradoEm)}`, '---',
    '# Decisões ativas do NexOS', '',
    `${ativas.length} ativas, projetadas do Store (\`nexos decision\`). Revogadas ficam de fora; o histórico continua no Store.`, '',
    `![[${DIR}/decisoes.base]]`, '',
    ...Object.keys(porTipo).sort().flatMap((t) => [
      `## ${TIPOS[t] ?? t} (${porTipo[t].length})`, '',
      ...porTipo[t].sort((a, b) => chave(a).localeCompare(chave(b))).map((h) => `- [[${DIR}/${chave(h)}|${chave(h)}]]`), '',
    ]),
  ].join('\n');
  notas[join(DIR, BASE_NOME)] = BASE_DECISOES;
  return notas;
}

/** Impura: apaga só o que ela mesma gerou, depois grava. Nota sem carimbo nunca é apagada. */
export function gravarNoVault(vault, notas) {
  const dir = join(vault, DIR);
  mkdirSync(dir, { recursive: true });
  const preservadas = []; const conflitos = []; let gravadas = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === BASE_NOME) { rmSync(p); continue; }
    if (!f.endsWith('.md')) continue;
    if (ehGerado(readFileSync(p, 'utf8'))) rmSync(p);
    else preservadas.push(f);
  }
  for (const [rel, conteudo] of Object.entries(notas)) {
    const p = join(vault, rel);
    if (existsSync(p)) { conflitos.push(rel); continue; }  // nota humana com o mesmo nome: nunca sobrescrita
    writeFileSync(p, conteudo); gravadas += 1;
  }
  return { gravadas, preservadas, conflitos };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const vault = process.argv[2];
  if (!vault || !existsSync(vault)) { console.error('uso: node console/build-obsidian.mjs "<vault>" [raiz]'); process.exit(2); }
  const root = process.argv[3] ?? findRoot();
  const r = runJson(root, ['decision']);
  if (!r.ok || !Array.isArray(r.data)) { console.error(`indisponível: ${r.unavailable ?? 'formato inesperado'}`); process.exit(1); }
  const notas = renderizarDecisoes(r.data, { geradoEm: new Date().toISOString() });
  const res = gravarNoVault(vault, notas);
  const ativas = Object.keys(notas).filter((k) => k.endsWith('.md')).length - 1;  // menos o index.md
  console.log(`decisões: ${r.data.length} heads · ${ativas} ativas projetadas · ${res.gravadas} arquivos gravados em ${DIR}/`);
  for (const p of res.preservadas) console.log(`  preservada (sem carimbo de gerado): ${p}`);
  for (const p of res.conflitos) console.log(`  CONFLITO, não sobrescrita: ${p}`);
}
