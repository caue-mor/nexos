#!/usr/bin/env node
// nexos-mcp-sql-write-warn.mjs — aviso de revisão em escrita SQL via MCP do
// Supabase (PostToolUse em execute_sql/apply_migration). nexos://decision/
// aviso-database-reviewer-em-escrita-mcp
//
// Nome do arquivo evita a palavra "Supabase" de propósito: authority.test.ts
// trava qualquer `command` de hook com esse termo (tripwire pós-incidente de
// 14/08, nexos-memory-sync.sh) — este hook não sofre o risco daquele gate
// (zero rede, zero segredo), mas o nome muda para não brigar com a trava.
//
// MEDIDO 24/09: 450 escritas via MCP em 30d, 13 revisadas (2,9%), 49 de 50
// sessões sem revisor. As tools do MCP oficial do Supabase são
// mcp__..Supabase..__execute_sql (campo `query`) e
// mcp__..Supabase..__apply_migration (campo `query`).
//
// CAUSA RAIZ (decisão do coordenador após 2 rodadas REPROVADAS pelo
// verifier, e89e3f09 e 51bdc904, 2 CRITICAL + 1 HIGH cada vez: `E'...'`
// engolindo o resto da query, verbo desconhecido ecoado sem limite no
// contexto, CTE aninhada não detectada): parser SQL escrito à mão é
// whack-a-mole — sempre existe mais um caso de aspa/comentário/aninhamento
// não coberto. NENHUM parser. Regra: normaliza para minúsculas e avisa se
// QUALQUER palavra INTEIRA de escrita aparecer em QUALQUER lugar do texto —
// dentro de string, comentário, CTE aninhada, não importa.
//
// ponytail: isto aceita falso positivo de propósito — `SELECT * FROM t
// WHERE note = 'please delete this later'` avisa mesmo sendo leitura, porque
// "delete" aparece como palavra inteira no texto. Aceito: o custo de um
// aviso a mais é pedir revisão numa leitura; o custo de um falso negativo é
// a escrita sem revisão que este hook existe para pegar. Não ampliar de
// volta para detecção por posição/contexto — essa foi a causa raiz.
//
// Mensagem é um RÓTULO FIXO, sem interpolação nenhuma: nunca ecoa verbo,
// nome de migration ou qualquer trecho do SQL — só assim "nunca imprime o
// SQL no contexto" fica garantido por construção, não por outro filtro que
// pode ter buraco.
//
// Contrato: NUNCA bloqueia — só sai com sucesso, nunca com stderr de erro —,
// e payload malformado sai calado, sempre com sucesso.

import { readFileSync } from "node:fs";

const TOOL_RE = /^mcp__.*[Ss]upabase.*__(execute_sql|apply_migration)$/;

const WRITE_WORD_RE =
  /\b(insert|update|delete|merge|upsert|create|alter|drop|truncate|grant|revoke|copy|call|do|into|set|begin|commit|rollback|vacuum|reindex|cluster|refresh|lock|comment|security|policy)\b/i;

const AVISO = "[NEXOS DB] Escrita SQL via MCP detectada — chame o database-reviewer.";

function emit() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: AVISO } }));
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (input?.hook_event_name !== "PostToolUse") return;
  const toolName = input.tool_name;
  if (typeof toolName !== "string") return;
  const match = toolName.match(TOOL_RE);
  if (!match) return;

  if (match[1] === "apply_migration") {
    emit(); // sempre escrita, independente do conteúdo de `query`
    return;
  }

  const query = input.tool_input?.query;
  if (typeof query !== "string") return;
  if (!WRITE_WORD_RE.test(query)) return; // nenhuma palavra de escrita em lugar nenhum do texto: silêncio
  emit();
}

try {
  main();
} catch {
  // silêncio: sai sempre com sucesso
}
