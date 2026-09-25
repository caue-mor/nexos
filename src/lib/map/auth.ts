/**
 * P1.4 fatia A (A11) — sinais de AUTH por evidência genérica: nome de
 * path/export sugerindo autenticação, e leitura do header `authorization`.
 * Tudo aqui é `MapFact` com `fact: "auth"` — mesmo vocabulário que
 * `stack-detector.ts` já usa para dependências conhecidas (`next-auth`,
 * `clerk`, ...), só que por CONTEÚDO em vez de por manifest. `certainty`
 * nunca vira `OBSERVED` para o candidato por nome (nome sozinho sugere, não
 * prova — contrato: "presença ≠ aprovação de segurança"); só a leitura do
 * header é `OBSERVED` (o código realmente lê aquele header).
 *
 * PURA: recebe conteúdo + path relativo, devolve fatos. Consumidores (quem
 * importa o módulo candidato) são calculados por quem já tem o grafo —
 * `architecture.ts`, na hora de renderizar — para não duplicar a resolução
 * de imports aqui.
 */
import { stripCommentLines, exportedNamesOf } from "./routes.js";
import { isEvidenceEligible } from "./evidence-scope.js";
import type { MapFact } from "./stack-detector.js";

const AUTH_KEYWORDS = ["auth", "authenticate", "authorize", "session", "jwt", "apikey", "api-key", "verifytoken"];

function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function nameSuggestsAuth(name: string): boolean {
  const normalized = normalize(name);
  return AUTH_KEYWORDS.some((k) => normalized.includes(normalize(k)));
}

/** Fixture/teste destes MESMOS detectores não deve virar sinal — mesma razão documentada em `map-scan.ts` para routes/database. */
export function isTestFile(relFile: string): boolean {
  return relFile.startsWith("tests/") || relFile.includes("/__tests__/") || /\.(test|spec)\.[jt]sx?$/.test(relFile);
}

const HEADER_AUTHORIZATION_RE = /headers?(?:\.get\(\s*["']authorization["']\s*\)|\[\s*["']authorization["']\s*\]|\.authorization\b)/i;

/**
 * R2 — NO MÁXIMO um fato `candidate_module` por arquivo: nome de path e
 * export(s) sugestivos se AGREGAM em `matchedBy`, nunca viram fatos
 * separados (a real Fintech tinha 2 fatos pro MESMO `src/lib/auth.ts`,
 * dobrando a citação e confundindo a leitura do consumidor no grafo).
 */
export function detectAuthSignalsInFile(relFile: string, rawContent: string): MapFact[] {
  if (isTestFile(relFile) || !isEvidenceEligible(relFile)) return [];
  const content = stripCommentLines(rawContent);
  const facts: MapFact[] = [];

  const matchedBy: string[] = [];
  const pathSegments = relFile.replace(/\.\w+$/, "").split("/");
  if (pathSegments.some((segment) => nameSuggestsAuth(segment))) matchedBy.push("nome do path");

  for (const name of exportedNamesOf(content)) {
    if (nameSuggestsAuth(name)) {
      matchedBy.push(`export ${name}`);
      break; // um sinal de export por arquivo já basta — evita ruído de vários exports batendo
    }
  }

  if (matchedBy.length > 0) {
    facts.push({
      fact: "auth",
      value: relFile,
      certainty: "INFERRED",
      provenance: { file: relFile, field: "candidate_module" },
      matchedBy,
    });
  }

  if (HEADER_AUTHORIZATION_RE.test(content)) {
    facts.push({
      fact: "auth",
      value: relFile,
      certainty: "OBSERVED",
      provenance: { file: relFile, field: "header_authorization_read" },
    });
  }

  return facts;
}
