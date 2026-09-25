/**
 * Fatia A — rodada de correção (R1): escopo de EVIDÊNCIA genérica
 * (auth/integrações) é só código de aplicação — nunca lockfile
 * (package-lock.json/yarn.lock/pnpm-lock.yaml), nunca markdown/docs, nunca
 * `.claude/**` (tooling do host, não da app), nunca artefato gerado.
 * `.nexos/**`/`graphify-out/**` já saem do escopo inteiro em `map-scan.ts`
 * (`ALWAYS_SKIP_PREFIXES`) — esta função cobre o que SOBRA depois disso.
 *
 * Medido na cópia real do Fintech: `package-lock.json`, "Default module
 * (1).md" e `.claude/agent-memory/*.md` viravam candidato/endpoint por o
 * scan rodar os detectores de auth/integração sobre QUALQUER arquivo de
 * texto, sem filtro de extensão nem de diretório de tooling.
 */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

export function isEvidenceEligible(relFile: string): boolean {
  if (relFile === ".claude" || relFile.startsWith(".claude/")) return false;
  const dot = relFile.lastIndexOf(".");
  const ext = dot >= 0 ? relFile.slice(dot) : "";
  return CODE_EXTENSIONS.has(ext);
}
