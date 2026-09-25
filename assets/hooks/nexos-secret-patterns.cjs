/**
 * NexOS Secret Patterns — CANONICAL authority for the hot-path logging hooks.
 *
 *   ONE CANONICAL LIST, REAL IMPORT WHERE POSSIBLE
 *
 * SECRET BOUNDARY V0 (slice B) measured THREE independent secret-pattern
 * definitions already alive in this repo: `SEGREDO` (`src/lib/evidence.ts`,
 * TypeScript, redacts gate stdout/stderr before it becomes an Evidence
 * record), the pattern list inline in `nexos-governance-capture.js`
 * (CommonJS, classifies + redacts tool_input/tool_output before the
 * `secret_detected`/`sensitive_file_access` governance event is persisted),
 * and the scanner's own list in `scripts/scan-secrets.mjs` (ESM, whole-repo
 * content scan with different false-positive tolerance — e.g. its GitHub/JWT
 * patterns are intentionally stricter to avoid tripping on prose that merely
 * MENTIONS a prefix). Fixing the two NEW sinks (`nexos-instinct-observer.js`,
 * `nexos-exec-log.js`) by giving each its OWN pattern list would have made
 * five. That is the defect this file exists to close.
 *
 * `.cjs` extension is deliberate, not cosmetic: `package.json` at the repo
 * root declares `"type": "module"`, so a plain `.js` file under `assets/`
 * would be loaded as ESM by Node whenever the nearest ancestor `package.json`
 * is THIS repo's (e.g. running tests in-tree) — `require()` would throw
 * `ERR_REQUIRE_ESM`. `.cjs` forces CommonJS regardless of the ancestor
 * `package.json`, in-repo AND once deployed to `~/.claude/skills/nexos/scripts/`
 * (where there is no ancestor `package.json` at all, so Node already defaults
 * to CommonJS there — `.cjs` makes the two environments agree instead of
 * merely happening to agree).
 *
 * THIS is now the canonical definition for the three hot-path hooks
 * (`nexos-governance-capture.js`, `nexos-instinct-observer.js`,
 * `nexos-exec-log.js`) — all three `require()` this file directly, so they
 * cannot textually diverge from one another (there is nothing to compare:
 * they share the same array in memory).
 *
 * `src/lib/evidence.ts` (`SEGREDO`) and `scripts/scan-secrets.mjs` (its own
 * `SECRET_PATTERNS`) CANNOT `require()` this file the same way:
 *   - `evidence.ts` compiles under `tsc` with `rootDir: "src"` and no
 *     `allowJs` — importing a `.cjs` file living under `assets/` (excluded
 *     from the TS program) is not representable without a hand-written
 *     ambient `.d.ts`, and would still leave `dist/lib/evidence.js` needing a
 *     relative path back into `assets/` that survives packaging. Not worth
 *     it for a handful of shared regexes.
 *   - `scripts/scan-secrets.mjs` COULD `import` this file (Node's CJS/ESM
 *     interop handles a static `module.exports = { A, B }` object fine), but
 *     it deliberately keeps its OWN, stricter patterns for whole-repo content
 *     scanning (see the comment above `SECRET_PATTERNS` in that file) — the
 *     two scanners answer different questions (repo source vs. one JSON tool
 *     call) and forcing identical regexes would either weaken the repo scan
 *     or make hook classification too strict to be useful.
 * Both are checked for DRIFT instead, by
 * `scripts/verify-secret-pattern-conformance.mts` (static source-text
 * comparison, same technique as
 * `scripts/verify-quality-recipe-conformance.mts`) — real import where the
 * runtime allows it, static conformance where it does not.
 */
'use strict';

/** The 7 forms SECRET BOUNDARY V0 requires coverage for, plus `aws_key`
 * (carried over from the pre-existing governance-capture list; not part of
 * the required 7 but harmless to keep), plus the provider-key forms added by
 * PROVIDER KEY PARITY below. */
const SECRET_PATTERNS = [
  { name: 'aws_key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/i },
  { name: 'generic_secret', pattern: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: 'supabase_key', pattern: /sbp_[a-f0-9]{40}/i },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/i },
  { name: 'database_url', pattern: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/i },

  /**
   * ── PROVIDER KEY PARITY (2026-09-22) ──
   *
   *   SCANNER DE REPO != GUARD DE RUNTIME
   *
   * MEDIDO depois de uma chave de API do Context7 ser colada direto no chat:
   * `redact()` devolveu a linha byte a byte igual, e
   * `assertNoSecretPatternMatch` deixaria o valor entrar no Store. Ao
   * investigar, o defeito maior não era a forma nova — era a ASSIMETRIA:
   * `scripts/scan-secrets.mjs`, o scanner dos ARQUIVOS do repo, já conhecia
   * SEIS formas de provider que este canônico não conhecia, e é este canônico
   * que alimenta os três hooks de hot-path E o guard de todo write do Store.
   * O lado que protege o que o usuário COLA e o que o agente GRAVA era o mais
   * fraco dos dois.
   *
   * Os seis corpos abaixo são copiados VERBATIM de `scan-secrets.mjs` — não
   * reescritos. Uma nona definição divergente da mesma forma é exatamente o
   * defeito que `verify-secret-pattern-conformance.mts` existe para impedir;
   * texto idêntico deixa a porta aberta para, um dia, aquele arquivo passar a
   * importar daqui em vez de manter a própria cópia.
   *
   * `ctx7_key` é a única forma genuinamente nova (nenhuma das listas do repo a
   * conhecia) e por isso é a única cujo corpo foi escrito aqui: prefixo
   * próprio seguido de UUID, ancorado em hex para que prosa que só MENCIONA
   * `ctx7sk-` não dispare.
   *
   * O CRITÉRIO, declarado: entram aqui as formas em que uma lista do repo já
   * reconhecia e a outra não (paridade medida). Uma forma que NENHUMA das
   * listas reconhece — Stripe, Figma, Linear e a cauda longa de providers — é
   * decisão de escopo, não paridade, e não entra por arrastão.
   */
  { name: 'ctx7_key', pattern: /ctx7sk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai_key', pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: 'npm_token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'gitlab_token', pattern: /glpat-[A-Za-z0-9_-]{20}/ },
];

/**
 * Escape hatch SÓ PARA TESTE: prova, por sink, que a redação abaixo tem
 * dente — o contrafactual precisa conseguir desligá-la sem mutar nenhum
 * arquivo rastreado. Exige um TOKEN específico, não `'1'`/`'true'`: uma env
 * var genérica vazando para um processo real não deve conseguir desarmar a
 * redação por acidente.
 *
 * Nome do env var e do token são exportados (abaixo) para que os testes de
 * CADA sink usem a MESMA constante em vez de recriar a string mágica três
 * vezes — divergência aqui seria um kill switch com dois nomes, um dos quais
 * ninguém aciona.
 */
const REDACTION_KILL_SWITCH_ENV = 'NEXOS_SECRET_REDACTION_TEST_DISABLE';
const REDACTION_KILL_SWITCH_TOKEN = 'unsafe-for-tests-only';
const redactionDisabledForTest =
  process.env[REDACTION_KILL_SWITCH_ENV] === REDACTION_KILL_SWITCH_TOKEN;

/**
 * PATTERN NAME IS NOT PROVENANCE — casar um dos `SECRET_PATTERNS` acima prova
 * "isto TEM A FORMA de uma credencial", nunca "isto É uma credencial de
 * verdade". Nasceu em `scripts/scan-secrets.mjs` (allowlist de UM literal,
 * `AKIAIOSFODNN7EXAMPLE` — o access key ID de exemplo que a própria doc da
 * AWS publica) e é EXTRAÍDO para cá, canônico, para que qualquer consumidor
 * que precise da mesma checagem — `scan-secrets.mjs` (import real, ver
 * abaixo) e `scripts/scan-local-secrets.mjs` (classificação de confiança:
 * `bearer_token` e as demais formas HIGH só contam quando o valor casado NÃO
 * é um destes) — comparem contra a MESMA lista em vez de cada um manter a
 * sua.
 *
 * Cada entrada é o LITERAL EXATO de uma fixture pública conhecida deste
 * repo, nunca um padrão amplo — um "nome parecido" não deve abrir a porta que
 * o literal exato fecha (mesma justificativa que `scan-secrets.mjs` já
 * documentava para a entrada da AWS).
 */
const KNOWN_PLACEHOLDERS = new Set([
  // AWS IAM docs — access key ID de exemplo oficial (docs.aws.amazon.com/IAM).
  'AKIAIOSFODNN7EXAMPLE',
  // `FAKE_JWT` — mesmo literal exato reusado em
  // tests/{scan-local-secrets,exec-log-redaction,instinct-observer-redaction,
  // governance-capture-redaction}.test.ts.
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0.' + 'F'.repeat(20),
  // `FAKE_SUPABASE_TOKEN` — mesmo literal exato reusado nos 3 arquivos de
  // teste de redação acima.
  'sbp_' + 'a1b2c3d4e5'.repeat(4),
  // `FAKE_GITHUB_TOKEN` — idem.
  'ghp_' + 'a1B2c3D4e5'.repeat(4),
  // `FAKE_BEARER` — idem. Corpo do token distintivo o bastante para não
  // colidir por acaso com uma credencial real.
  'Bearer ' + 'a1B2c3D4e5F6'.repeat(2),
]);

/** `true` quando `value` é EXATAMENTE um dos placeholders/fixtures públicas
 * conhecidas acima — nunca por substring, nunca por prefixo. */
function isKnownPlaceholder(value) {
  return typeof value === 'string' && KNOWN_PLACEHOLDERS.has(value);
}

/** Redige todas as formas conhecidas em `text`, substituindo cada
 * ocorrência por `[REDACTED]` — preserva a FORMA/estrutura ao redor
 * (útil para auditoria), nunca o valor. */
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  if (redactionDisabledForTest) return text;
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    out = out.replace(global, '[REDACTED]');
  }
  return out;
}

module.exports = {
  SECRET_PATTERNS,
  redact,
  REDACTION_KILL_SWITCH_ENV,
  REDACTION_KILL_SWITCH_TOKEN,
  KNOWN_PLACEHOLDERS,
  isKnownPlaceholder,
};
