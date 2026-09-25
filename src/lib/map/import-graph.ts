/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — grafo de imports.
 *
 *   OWN SCAN IS AUTHORITY · GRAPHIFY IS A PROVIDER
 *
 * Arestas OBSERVED vêm de leitura própria (regex de import/require/from em
 * TS/JS/Python) — nunca de terceiros. Graphify, quando `graphify-out/graph.json`
 * existe, entra como fonte SECUNDÁRIA: suas arestas de import
 * (`relation` em imports/imports_from/dynamic_import/re_exports) chegam
 * INFERRED com `provenance.source: "graphify"`, e só viram OBSERVED quando
 * uma aresta PRÓPRIA já provou o mesmo par file→file — nunca o contrário.
 * Ausência ou JSON quebrado do graphify nunca derruba o scan próprio.
 *
 * P1.4 fatia A (A8) — `resolution` declara o que a aresta É, sem fingir
 * certeza que não existe: `resolved` (specifier bateu em um arquivo do
 * projeto — relativo ou alias de tsconfig/jsconfig — `to` presente),
 * `external` (specifier bare — pacote de terceiro/builtin — `package`
 * presente, `to` ausente: NUNCA resolvido contra `node_modules`), `unresolved`
 * (parecia interno — relativo ou casou um padrão de alias — mas nenhum
 * arquivo correspondente existe no disco).
 */
export type EdgeResolution = "resolved" | "external" | "unresolved";

export interface GraphEdge {
  readonly from: string;
  /** Texto cru do import — o que o código realmente escreveu, antes de qualquer resolução. */
  readonly specifier: string;
  /**
   * Aresta que só existe no código-fonte: `import type` some no `tsc`.
   *
   *   IMPORT DE TIPO NÃO EXISTE EM RUNTIME
   *
   * Ausente (não `false`) quando a aresta carrega valor — presença é o dado,
   * e omitir no caso comum mantém o artefato menor. Quem pergunta sobre
   * RUNTIME (ciclo, ordem de inicialização, impacto real) filtra por isto;
   * quem pergunta sobre o texto ignora.
   */
  readonly typeOnly?: true;
  /** Só presente quando `resolution === "resolved"`. */
  readonly to?: string;
  readonly resolution: EdgeResolution;
  /** Nome do pacote bare (`react`, `@scope/pkg`) — só presente quando `resolution === "external"`. */
  readonly package?: string;
  readonly certainty: "OBSERVED" | "INFERRED";
  readonly provenance: { readonly file: string; readonly source: "import-scan" | "graphify" };
}

export interface RawImportRef {
  readonly specifier: string;
  readonly line: number;
  /**
   * O import carrega só TIPO e é apagado na compilação?
   *
   *   IMPORT DE TIPO NÃO EXISTE EM RUNTIME
   *
   * MEDIDO em 2026-09-18: uma busca de ciclos sobre este grafo devolveu 5
   * ciclos; ao separar aresta de VALOR de aresta de TIPO, 4 deles têm pelo
   * menos um elo `import type` e simplesmente não existem depois do `tsc`.
   * Um é real (`reader -> checkpoint -> context-assembler -> reader`). Quem
   * fosse consertar os 5 gastaria o esforço em 4 ciclos que não existem — e
   * pior, poderia "consertar" quebrando código correto.
   *
   * Vale para qualquer análise que pergunte o que ACONTECE, não o que está
   * escrito: ciclo, ordem de inicialização, impacto de mudança em runtime.
   */
  readonly typeOnly: boolean;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

const JS_IMPORT_FROM = /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
const JS_IMPORT_BARE = /\bimport\s+["']([^"']+)["']/g;
const JS_REQUIRE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const JS_DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const PY_FROM_IMPORT = /^\s*from\s+([\w.]+)\s+import\b/gm;
/** `[\w., ]+` inclui vírgula/espaço — `import os, sys` precisa capturar a lista inteira para o split abaixo separar cada módulo. */
const PY_IMPORT = /^\s*import\s+([\w., ]+)/gm;

/** PURA: extrai especificadores crus (não resolvidos) + linha, de um arquivo TS/JS/Python. */

/**
 * `import type X from` e `import { type A, type B } from` são apagados pelo
 * compilador; `import { type A, B } from` NÃO é — basta um membro de valor
 * para a aresta existir em runtime. O predicado é "TODOS os membros são
 * tipo", nunca "a palavra type aparece".
 */
function importaSoTipo(declaracao: string): boolean {
  if (/\bimport\s+type\b/.test(declaracao)) return true;
  const chaves = declaracao.match(/\{([\s\S]*?)\}/);
  if (!chaves?.[1]) return false;
  const membros = chaves[1]
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  return membros.length > 0 && membros.every((m) => /^type\s/.test(m));
}

export function extractImportRefs(relFile: string, content: string): RawImportRef[] {
  const refs: RawImportRef[] = [];
  const seen = new Set<string>();
  const push = (specifier: string, index: number, typeOnly = false) => {
    const key = `${specifier}@${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ specifier, line: lineOf(content, index), typeOnly });
  };

  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(relFile)) {
    for (const m of content.matchAll(JS_IMPORT_FROM)) if (m[1]) push(m[1], m.index ?? 0, importaSoTipo(m[0]));
    for (const m of content.matchAll(JS_IMPORT_BARE)) if (m[1]) push(m[1], m.index ?? 0);
    for (const m of content.matchAll(JS_REQUIRE)) if (m[1]) push(m[1], m.index ?? 0);
    for (const m of content.matchAll(JS_DYNAMIC_IMPORT)) if (m[1]) push(m[1], m.index ?? 0);
  } else if (relFile.endsWith(".py")) {
    for (const m of content.matchAll(PY_FROM_IMPORT)) if (m[1]) push(m[1], m.index ?? 0);
    for (const m of content.matchAll(PY_IMPORT)) {
      for (const name of (m[1] ?? "").split(",")) {
        const trimmed = name.trim();
        if (trimmed) push(trimmed, m.index ?? 0);
      }
    }
  }
  return refs;
}

/**
 * PURA: funde arestas próprias (`ownEdges`) com as do graphify
 * (`graphifyFileEdges`, já reduzidas a pares file→file pelo chamador —
 * `project-map.ts` faz a leitura de `graphify-out/graph.json` e a tradução
 * de node id → `source_file`, que é I/O). Uma aresta do graphify que bate
 * EXATAMENTE (mesmo from/to) com uma aresta própria RESOLVIDA não duplica: a
 * própria já é OBSERVED e continua sendo a única entrada para aquele par.
 * Uma aresta sintética do graphify não tem o texto original do import — o
 * campo `specifier` grava o próprio `to` como melhor esforço, sinalizado por
 * `provenance.source: "graphify"` para quem ler saber que não é literal.
 */
export function mergeGraphifyEdges(
  ownEdges: readonly GraphEdge[],
  graphifyFileEdges: readonly { readonly from: string; readonly to: string }[]
): GraphEdge[] {
  const ownPairs = new Set(ownEdges.filter((e) => e.to !== undefined).map((e) => `${e.from}|${e.to}`));
  const merged = [...ownEdges];
  const addedInferred = new Set<string>();
  for (const { from, to } of graphifyFileEdges) {
    const key = `${from}|${to}`;
    if (ownPairs.has(key) || addedInferred.has(key)) continue;
    addedInferred.add(key);
    merged.push({
      from,
      specifier: to,
      to,
      resolution: "resolved",
      certainty: "INFERRED",
      provenance: { file: from, source: "graphify" },
    });
  }
  return merged;
}
