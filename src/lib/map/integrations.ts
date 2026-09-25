/**
 * P1.4 fatia A (A12) — sinais de INTEGRAÇÃO por evidência genérica: host de
 * URL externa em string literal do código incluído, e marcas de mock/parcial
 * (arquivo mock|fake|stub, `throw` de "not implemented"/"não
 * implementado"/TODO). Tudo `MapFact` com `fact: "integration"` — o mesmo
 * vocabulário que `stack-detector.ts` já usa para SDKs conhecidos por
 * dependência (`stripe`, `openai`, ...), discriminado por
 * `provenance.field`. Uso real (dependência importada) vs só declarada é
 * cruzado por `architecture.ts` contra o grafo — este módulo só observa
 * CONTEÚDO, nunca resolve import.
 *
 *   SEM NOME DE FORNECEDOR DO PROJETO NO CÓDIGO — nenhuma lista fixa de SDK
 *   além da já existente em `stack-detector.ts` (genérica, por pacote npm
 *   conhecido); host de URL vem do texto observado, nunca de um nome
 *   hardcoded.
 */
import { stripCommentLines } from "./routes.js";
import { isTestFile } from "./auth.js";
import { isEvidenceEligible } from "./evidence-scope.js";
import type { MapFact } from "./stack-detector.js";

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

const URL_RE = /https?:\/\/[^\s"'`<>]+/g;
const MOCK_NAME_RE = /\b(mock|fake|stub)s?\b/i;
const PARTIAL_THROW_RE = /throw\b[^;\n]*?(not implemented|não implementado|TODO)[^;\n]*;?/gi;

export function detectIntegrationSignalsInFile(relFile: string, rawContent: string): MapFact[] {
  if (isTestFile(relFile) || !isEvidenceEligible(relFile)) return [];
  const content = stripCommentLines(rawContent);
  const facts: MapFact[] = [];

  const baseName = relFile.split("/").pop() ?? relFile;
  if (MOCK_NAME_RE.test(baseName)) {
    facts.push({
      fact: "integration",
      value: relFile,
      certainty: "OBSERVED",
      provenance: { file: relFile, field: "mock_file" },
    });
  }

  for (const m of content.matchAll(PARTIAL_THROW_RE)) {
    facts.push({
      fact: "integration",
      value: `${relFile}:${lineOf(content, m.index ?? 0)}`,
      certainty: "OBSERVED",
      provenance: { file: relFile, field: "partial_todo_throw" },
    });
  }

  for (const m of content.matchAll(URL_RE)) {
    let host: string | undefined;
    try {
      host = new URL(m[0]).host;
    } catch {
      continue;
    }
    if (!host) continue;
    facts.push({
      fact: "integration",
      value: host,
      certainty: "OBSERVED",
      provenance: { file: relFile, field: "endpoint_referenced" },
    });
  }

  return facts;
}
