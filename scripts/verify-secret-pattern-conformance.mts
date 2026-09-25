/**
 * SECRET PATTERN CONFORMANCE — the detector for "a fourth/fifth authority
 * reintroduced silently."
 *
 *   ONE CANONICAL LIST · REAL IMPORT WHERE POSSIBLE · STATIC CHECK ELSEWHERE
 *
 * SECRET BOUNDARY V0 (slice A) added `SECRET_PATTERNS` to
 * `nexos-governance-capture.js` and left a comment saying a conformance gate
 * "in the style of `scripts/verify-quality-recipe-conformance.mts`" would be
 * needed if the list were ever duplicated — but never built it. Slice B
 * needed to fix TWO more sinks (`nexos-instinct-observer.js`,
 * `nexos-exec-log.js`); giving each its own copy would have made FOUR/FIVE
 * competing pattern lists (counting `SEGREDO` in `src/lib/evidence.ts` and
 * `scan-secrets.mjs`'s own list, both pre-existing). This script is that gate,
 * finally built: static source inspection (regex/text checks against known
 * consumer files), same technique as the precedent above — cheap to run,
 * cheap to reason about, targeted exactly at this defect.
 *
 * CANONICAL: `assets/hooks/nexos-secret-patterns.cjs`.
 *
 *   REAL IMPORT (checked here as "is this file wired to canonical, with no
 *   competing local array"):
 *     - assets/hooks/nexos-governance-capture.js
 *     - assets/hooks/nexos-instinct-observer.js
 *     - assets/hooks/nexos-exec-log.js
 *     - scripts/scan-local-secrets.mjs
 *     - scripts/scan-secrets.mjs (partial: only its `supabase_key` entry —
 *       the rest of its list is deliberately its own, see that file)
 *
 *   STATIC CONFORMANCE (checked here as "has this file's OWN pattern drifted
 *   from canonical for the specific forms it claims to share"), because the
 *   runtime cannot import canonical across this boundary:
 *     - src/lib/evidence.ts (`SEGREDO`) — TypeScript, `tsc` with
 *       `rootDir: "src"` and no `allowJs`; importing a `.cjs` under
 *       `assets/` (excluded from the TS program) is not representable
 *       without a hand-written ambient `.d.ts`, and would still need a
 *       relative path from `dist/lib/evidence.js` back into `assets/` that
 *       survives packaging. `SEGREDO` also legitimately covers formats
 *       canonical does not (`sk-`, `sk_live_`, `npg_`) — it answers a
 *       different question (redact gate stdout/stderr) — so this is a
 *       COVERAGE check on the forms the two lists DO share, not a demand
 *       that the two lists be identical.
 *     - src/lib/capsule/secret-guard.ts (`CANONICAL_SECRET_PATTERNS`) — same
 *       `tsc` boundary as `evidence.ts`. Unlike `SEGREDO`, this mirror exists
 *       to answer the EXACT same question as canonical (free-text `content`
 *       scan across every Store write, SECRET BOUNDARY V0 follow-up), so the
 *       check demands IDENTITY of EVERY pattern body, not partial coverage —
 *       the count is read from canonical at runtime, never written here: a
 *       number cravado num comentário é o que envelhece quando a lista cresce.
 *
 *   uso: npx tsx scripts/verify-secret-pattern-conformance.mts
 */
import fs from "fs-extra";
import path from "node:path";
import ts from "typescript";
import { SECRET_PATTERNS as CANONICAL } from "../assets/hooks/nexos-secret-patterns.cjs";

const ROOT = process.cwd();
const provas: Array<{ n: string; ok: boolean; detail: string }> = [];
const checar = (n: string, ok: boolean, detail: string): void => void provas.push({ n, ok, detail });

console.log("\n── SECRET PATTERN CONFORMANCE ──\n");

const canonicalByName = new Map(CANONICAL.map((p) => [p.name, p.pattern] as const));

// ── 0 · canônico cobre as 7 formas exigidas por SECRET BOUNDARY V0 ──
const REQUIRED_FORMS = [
  "supabase_key",
  "jwt",
  "github_token",
  "bearer_token",
  "database_url",
  "generic_secret",
  "private_key",
] as const;
const missingForms = REQUIRED_FORMS.filter((name) => !canonicalByName.has(name));
checar(
  "0 canônico cobre as 7 formas exigidas",
  missingForms.length === 0,
  missingForms.length === 0
    ? [...canonicalByName.keys()].join(", ")
    : `formas ausentes no canônico: ${missingForms.join(", ")}`
);

/**
 * Um elemento de array é uma "entrada de padrão de segredo" quando é um
 * object literal com AMBAS as propriedades da forma canônica
 * (`{ name: 'x', pattern: /.../ }`, ver `nexos-secret-patterns.cjs`):
 * `name` como STRING LITERAL e `pattern` como REGEX LITERAL. Estrutural, não
 * por nome — `SECRET_PATTERNS_LOCAL`, `MY_PATTERNS`, `LOCAL_PATTERNS` ou
 * qualquer outro identificador batem igual, porque nenhum deles muda o SHAPE
 * do object literal.
 *
 * Risco de falso positivo medido e descartado: `ti?.pattern` em
 * `nexos-instinct-observer.js` é um PropertyAccessExpression (leitura de uma
 * propriedade de outro objeto), nunca um PropertyAssignment dentro de um
 * object literal — `ts.isPropertyAssignment` não o alcança. `DANGEROUS_COMMANDS`
 * e `SENSITIVE_PATHS` em `nexos-governance-capture.js` são arrays de REGEX
 * LITERAIS NUS (sem wrapper `{ name, pattern }`) — não objetos — também fora
 * do alcance deste shape, de propósito: alargar a detecção para "array de
 * regexes soltos" apitaria falso nestes dois arrays legítimos e não
 * relacionados a segredo.
 */
function isPatternEntry(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  let hasNameString = false;
  let hasPatternRegex = false;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (key === "name" && ts.isStringLiteral(prop.initializer)) hasNameString = true;
    if (key === "pattern" && ts.isRegularExpressionLiteral(prop.initializer)) hasPatternRegex = true;
  }
  return hasNameString && hasPatternRegex;
}

/** Varre o AST inteiro do arquivo atrás de QUALQUER array literal que
 * contenha ao menos um elemento no shape de `isPatternEntry` — uma lista de
 * padrões de segredo concorrente à canônica, com o nome de variável que for. */
function hasCompetingPatternArray(src: string, filename: string): boolean {
  const sourceFile = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isArrayLiteralExpression(node) && node.elements.some(isPatternEntry)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Um hook está "wired" quando `require(...)` referencia
 * `nexos-secret-patterns.cjs` E não contém, em lugar nenhum do arquivo, um
 * array literal concorrente no shape canônico (`hasCompetingPatternArray`,
 * acima) — checagem ESTRUTURAL, não por nome de variável. A versão anterior
 * (`/const\s+SECRET_PATTERNS\s*=\s*\[/`) deixava passar verde qualquer
 * reintrodução batizada com outro nome (`SECRET_PATTERNS_LOCAL`,
 * `MY_PATTERNS`, `LOCAL_PATTERNS`, ...) — o defeito que esta reescrita fecha.
 */
/**
 * HOOK AUSENTE != HOOK APROVADO, E TAMBÉM != GATE QUEBRADO.
 *
 *   GATE QUE NÃO RODA NÃO É GATE
 *
 * MEDIDO em 2026-09-22: os três hooks abaixo foram removidos do pacote em
 * `abbcb4d3 refactor(p1.0b): remove non-authorizing hook noise`, e este gate
 * nunca foi atualizado — `fs.readFile` estourava ENOENT e derrubava o script
 * INTEIRO no bloco 1, antes de qualquer prova rodar. Como o gate está no CI
 * (`.github/workflows/ci.yml`) e nenhum teste da suíte o invoca (só o citam em
 * comentário), a suíte seguia verde por cima de um gate morto: os blocos 4–7,
 * que protegem os consumidores VIVOS, não eram executados havia commits.
 *
 * Ausência passa, mas passa DECLARADA, nunca em silêncio: um hook que não
 * existe não tem lista de padrões concorrente para divergir. O dente do gate
 * continua inteiro para o caso que importa — se o arquivo voltar a existir sem
 * `require` do canônico, ou com array próprio, o bloco reprova como sempre
 * reprovou.
 */
function checarHookWired(nome: string, relativo: string): Promise<void> {
  const absoluto = path.join(ROOT, relativo);
  if (!fs.existsSync(absoluto)) {
    checar(`${nome} — ausente do pacote, nada a verificar`, true, "hook removido do pacote; sem arquivo não há lista concorrente. Se voltar, este bloco volta a exigir o require do canônico");
    return Promise.resolve();
  }
  return fs.readFile(absoluto, "utf-8").then((src) => {
    const wired = /require\(.*nexos-secret-patterns\.cjs.*\)/.test(src);
    const hasOwnArray = hasCompetingPatternArray(src, relativo);
    checar(
      `${nome} importa o canônico, sem lista própria concorrente`,
      wired && !hasOwnArray,
      !wired
        ? "não faz require de nexos-secret-patterns.cjs — pode estar definindo padrões próprios de novo"
        : hasOwnArray
          ? "importa o canônico MAS ainda declara, em algum lugar do arquivo, um array literal no shape { name: string, pattern: /regex/ } — lista de padrões concorrente, qualquer que seja o nome da variável"
          : "importa o canônico, sem array concorrente no shape canônico"
    );
  });
}

await checarHookWired("1 assets/hooks/nexos-governance-capture.js", "assets/hooks/nexos-governance-capture.js");
await checarHookWired("2 assets/hooks/nexos-instinct-observer.js", "assets/hooks/nexos-instinct-observer.js");
await checarHookWired("3 assets/hooks/nexos-exec-log.js", "assets/hooks/nexos-exec-log.js");

// ── 4 · scripts/scan-local-secrets.mjs importa o canônico (real import, sem fallback próprio) ──
const scanLocalSrc = await fs.readFile(path.join(ROOT, "scripts/scan-local-secrets.mjs"), "utf-8");
const scanLocalImports = /from\s+["']\.\.\/assets\/hooks\/nexos-secret-patterns\.cjs["']/.test(scanLocalSrc);
checar(
  "4 scripts/scan-local-secrets.mjs importa o canônico",
  scanLocalImports,
  scanLocalImports ? "import real de nexos-secret-patterns.cjs" : "não importa o canônico — pode ter definido padrões próprios"
);

// ── 5 · scripts/scan-secrets.mjs reusa o `supabase_key` do canônico (real import), não uma cópia literal ──
const scanSecretsSrc = await fs.readFile(path.join(ROOT, "scripts/scan-secrets.mjs"), "utf-8");
const importsCanonicalPatterns = /from\s+["']\.\.\/assets\/hooks\/nexos-secret-patterns\.cjs["']/.test(scanSecretsSrc);
const hasOwnSupabaseLiteral = /\/sbp_\[a-f0-9\]\{40\}\/i/.test(scanSecretsSrc);
checar(
  "5 scripts/scan-secrets.mjs reusa supabase_key do canônico (não uma quinta cópia)",
  importsCanonicalPatterns && !hasOwnSupabaseLiteral,
  !importsCanonicalPatterns
    ? "não importa nexos-secret-patterns.cjs"
    : hasOwnSupabaseLiteral
      ? "importa o canônico MAS ainda mantém um literal /sbp_[a-f0-9]{40}/i próprio — cópia reintroduzida"
      : "usa CANONICAL_HOOK_PATTERNS.find(...).pattern em vez de literal próprio"
);

/**
 * ── 6 · src/lib/evidence.ts (SEGREDO) — COVERAGE, não identidade ──
 *
 * `SEGREDO` não pode importar o canônico (ver cabeçalho). O que ESTE bloco
 * prova é mais estreito, de propósito: para a forma que as duas listas
 * genuinamente COMPARTILHAM hoje (bearer token — os dois corpos de regex já
 * são texto idêntico), a igualdade textual é exigida e protegida contra
 * deriva silenciosa. Para jwt/database-url, os dois arquivos respondem
 * perguntas diferentes com precisão diferente de propósito (ver comentário
 * de `SEGREDO` em evidence.ts) — aqui só se exige que o CONCEITO continue
 * presente (substring), nunca que os dois regexes sejam o mesmo.
 */
const evidenceSrc = await fs.readFile(path.join(ROOT, "src/lib/evidence.ts"), "utf-8");
const canonicalBearerSource = canonicalByName.get("bearer_token")?.source ?? "";
checar(
  "6a src/lib/evidence.ts (SEGREDO) — bearer token IDÊNTICO ao canônico (não coverage-level: os dois já eram o mesmo texto)",
  canonicalBearerSource.length > 0 && evidenceSrc.includes(canonicalBearerSource),
  canonicalBearerSource.length > 0 && evidenceSrc.includes(canonicalBearerSource)
    ? "fragmento de bearer_token do canônico presente, verbatim, em SEGREDO"
    : `fragmento esperado ausente/divergente: ${JSON.stringify(canonicalBearerSource)}`
);
const coversJwtConcept = /eyJ/.test(evidenceSrc) && canonicalByName.has("jwt");
const coversDatabaseUrlConcept = /postgres/.test(evidenceSrc) && /postgres/.test(canonicalByName.get("database_url")?.source ?? "");
checar(
  "6b src/lib/evidence.ts (SEGREDO) — conceito jwt continua presente (coverage, não identidade — ver cabeçalho)",
  coversJwtConcept,
  coversJwtConcept ? "ambos mencionam o prefixo eyJ de um JWT" : "SEGREDO não menciona mais 'eyJ' — cobertura de JWT pode ter sido removida"
);
checar(
  "6c src/lib/evidence.ts (SEGREDO) — conceito database URL (postgres) continua presente (coverage, não identidade)",
  coversDatabaseUrlConcept,
  coversDatabaseUrlConcept
    ? "ambos mencionam o esquema postgres"
    : "SEGREDO ou o canônico pararam de mencionar 'postgres' — cobertura pode ter sido removida de um dos dois lados"
);

/**
 * ── 7 · src/lib/capsule/secret-guard.ts (`CANONICAL_SECRET_PATTERNS`) —
 * IDENTIDADE, não coverage ──
 *
 * Mesmo impedimento estrutural de `SEGREDO` (bloco 6 acima): `secret-guard.ts`
 * também mora sob `src/`, mesmo `tsc` sem `allowJs`. A diferença é o
 * CONTRATO: `assertNoSecretPatternMatch` existe para responder exatamente a
 * MESMA pergunta que o canônico ("isto tem a forma de uma credencial
 * conhecida?"), para TODOS os nomes — não uma seleção parcial como
 * `SEGREDO`. Por isso a exigência aqui é IDENTIDADE do corpo de CADA padrão
 * (`.source`), não só de um fragmento compartilhado.
 */
const secretGuardSrc = await fs.readFile(path.join(ROOT, "src/lib/capsule/secret-guard.ts"), "utf-8");
const secretGuardDrift = CANONICAL.filter((p) => !secretGuardSrc.includes(p.pattern.source));
checar(
  `7 src/lib/capsule/secret-guard.ts (CANONICAL_SECRET_PATTERNS) — todos os ${String(CANONICAL.length)} padrões IDÊNTICOS ao canônico`,
  secretGuardDrift.length === 0,
  secretGuardDrift.length === 0
    ? `os ${String(CANONICAL.length)} corpos de regex do canônico estão presentes, verbatim, em secret-guard.ts`
    : `padrões divergentes/ausentes em secret-guard.ts: ${secretGuardDrift.map((p) => p.name).join(", ")}`
);

for (const p of provas) console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.n} — ${p.detail}`);
const falhas = provas.filter((p) => !p.ok);
console.log(`\n${falhas.length === 0 ? "PASS" : "FAIL"} — ${provas.length - falhas.length}/${provas.length} provas\n`);
process.exit(falhas.length === 0 ? 0 : 1);
