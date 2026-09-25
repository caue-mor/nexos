/**
 * SECRET AUTHORITY — o invariante que faltava.
 *
 *   SENSITIVITY DECLARED != SECRET PROTECTED
 *   SECRET METADATA != SECRET MATERIAL
 *
 * O envelope do Capsule já declarava `SensitivityClass` com `secret` e
 * `Portability` com `prohibited`. Medido em 15/08: NENHUM writer consultava
 * esses campos. `assertPublishable` validava o schema e nada mais, então um
 * record marcado `secret` podia carregar qualquer texto — inclusive o valor.
 *
 * ENFORCEMENT POR ESTRUTURA, NÃO POR REGEX. Um scanner de padrões conhecidos
 * (`sk-`, `eyJ`, `Bearer`) é defesa em profundidade útil, mas não é autoridade:
 * ele erra em segredo de formato novo e dá falso conforto. Aqui a regra é
 * ALLOWLIST DE CAMPOS — sob `classification: secret`, o content só pode conter
 * campos de REFERÊNCIA. Campo desconhecido é recusado sem tentar adivinhar se o
 * conteúdo "parece" segredo.
 */

/** Campos que descrevem ONDE mora um segredo — nunca o segredo. */
export const SECRET_REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  "logical_name",
  "project",
  "environment",
  "source_type",
  "source_resource",
  "source_key",
  "relation",
  "status",
  "evidence_refs",
  "why",
  "discovered_at",
  "allowed_consumers",
  "allowed_operations",
]);

export interface SecretGuardInput {
  readonly sensitivity?: { readonly classification?: string };
  readonly portability?: string;
  readonly content?: unknown;
}

export class SecretMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretMaterialError";
  }
}

/**
 * Recusa material secreto na fronteira de escrita.
 *
 * Só age quando o record se declara `secret`. Não tenta classificar records que
 * não se declararam — adivinhar sensibilidade alheia é como um scanner universal
 * vira autoridade por acidente.
 */
export function assertNoSecretMaterial(record: SecretGuardInput): void {
  const classification = record.sensitivity?.classification;
  if (classification !== "secret") return;

  /**
   * PORTABLE SECRET REF != PORTABLE SECRET. Um record `secret` que se declara
   * `portable` afirma que pode atravessar clone e máquina — e material secreto
   * não pode. Referência portátil deve ser classificada pelo que ela é
   * (metadata), não marcada `secret` e liberada para viajar.
   *
   * `machine_local` (Effective Host Surface Resolver V1) entra no MESMO portão.
   * Não é sinônimo de `local`: hoje não existe roteamento físico por
   * portabilidade — todo record cai em `records/`, que É o canal portável
   * (git, ADR-044). Um record `secret` marcado `machine_local` viajaria pelo
   * mesmo canal que um `portable`, só que com a promessa (não cumprida por
   * infraestrutura nenhuma) de nunca sair desta máquina. Recusar aqui evita
   * que a promessa vire a única defesa.
   */
  if (record.portability === "portable" || record.portability === "machine_local") {
    throw new SecretMaterialError(
      `record classification=secret com portability=${record.portability} — material secreto não atravessa ` +
        "clone nem confia em 'só nesta máquina' sem roteamento físico que garanta isso. " +
        "Use portability 'local' ou 'prohibited'. Nada foi escrito — FAIL CLOSED."
    );
  }

  const content = record.content;
  if (content === null || typeof content !== "object") {
    throw new SecretMaterialError(
      "record classification=secret sem content estruturado — referência de segredo exige campos declarados. " +
        "Nada foi escrito — FAIL CLOSED."
    );
  }

  const desconhecidos = Object.keys(content as Record<string, unknown>).filter(
    (k) => !SECRET_REFERENCE_FIELDS.has(k)
  );
  if (desconhecidos.length > 0) {
    throw new SecretMaterialError(
      `record classification=secret com campo fora do contrato de referência: ${desconhecidos.join(", ")}. ` +
        `Sob 'secret' só se persiste ONDE o segredo mora, nunca o segredo. ` +
        `Permitidos: ${[...SECRET_REFERENCE_FIELDS].join(", ")}. Nada foi escrito — FAIL CLOSED.`
    );
  }
}

/**
 * DEFESA EM PROFUNDIDADE PROMETIDA ACIMA, agora construída: um scanner de
 * padrões conhecidos que roda em TODO record — não só sob `classification:
 * secret` — porque o defeito medido foi exatamente esse: `nexos state --set`,
 * `nexos decision --set` e `nexos memory --fact` gravavam um token `ghp_...`
 * em texto puro com `classification: internal`. `assertNoSecretMaterial`
 * acima nunca via esse conteúdo — ela só age quando o record JÁ SE DECLAROU
 * secreto. Aqui a regra é a oposta: olha `content` de QUALQUER record.
 *
 *   SENSITIVITY DECLARED != SECRET PROTECTED  vale nos dois sentidos —
 *   um record que NÃO se declara secreto também não ganha passe livre.
 *
 * Espelho do canônico `assets/hooks/nexos-secret-patterns.cjs`
 * (`SECRET_PATTERNS`, `KNOWN_PLACEHOLDERS`) — NÃO um catálogo novo. Import
 * real não é representável aqui pelo mesmo motivo documentado para `SEGREDO`
 * em `src/lib/evidence.ts` (ver aquele arquivo e
 * `scripts/verify-secret-pattern-conformance.mts`): `tsc` roda com
 * `rootDir: "src"` e sem `allowJs`, e `assets/` está excluído do program —
 * `require()`/`import` de um `.cjs` de lá não sobrevive a `dist/`. Drift
 * contra o canônico é fechado por CONFORMIDADE ESTÁTICA (bloco novo naquele
 * script), exigindo IDENTIDADE byte-a-byte do corpo de cada regex — mais
 * estrito que a checagem de `SEGREDO` (que é só COBERTURA DE CONCEITO),
 * porque aqui as duas listas respondem exatamente a mesma pergunta: "isto
 * tem a forma de uma credencial conhecida?".
 */
/** Exportado só para `tests/secret-guard.test.ts` provar, via `createRequire`
 * do `.cjs` real, que este espelho não divergiu — a mesma garantia do bloco 7
 * de `scripts/verify-secret-pattern-conformance.mts`, agora também na suíte
 * que roda de fato (`npx vitest run`), não só num script standalone. */
export const CANONICAL_SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "aws_key", pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/i },
  { name: "generic_secret", pattern: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "github_token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: "supabase_key", pattern: /sbp_[a-f0-9]{40}/i },
  { name: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/i },
  { name: "database_url", pattern: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/i },

  /**
   * PROVIDER KEY PARITY (2026-09-22) — espelho exato do bloco de mesmo nome em
   * `assets/hooks/nexos-secret-patterns.cjs`, onde a justificativa medida está
   * escrita por extenso. Aqui só o invariante: este arquivo responde à MESMA
   * pergunta que o canônico, para TODOS os nomes, então a divergência de um
   * único corpo de regex é o defeito — e é o bloco 7 de
   * `verify-secret-pattern-conformance.mts` que a pega.
   */
  { name: "ctx7_key", pattern: /ctx7sk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai_key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "npm_token", pattern: /npm_[A-Za-z0-9]{36}/ },
  { name: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "google_api_key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "gitlab_token", pattern: /glpat-[A-Za-z0-9_-]{20}/ },
];

/** Mesmos LITERAIS EXATOS de `KNOWN_PLACEHOLDERS` no canônico — fixtures
 * públicas conhecidas (doc da AWS, fixtures desta suíte) que NUNCA devem
 * bloquear uma escrita só por casar a forma de uma credencial. */
const CANONICAL_KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "AKIAIOSFODNN7EXAMPLE",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0." + "F".repeat(20),
  "sbp_" + "a1b2c3d4e5".repeat(4),
  "ghp_" + "a1B2c3D4e5".repeat(4),
  "Bearer " + "a1B2c3D4e5F6".repeat(2),
]);

interface SecretPatternMatch {
  readonly path: string;
  readonly patternName: string;
}

/** Casa `text` contra cada padrão canônico. Uma ocorrência só conta quando
 * NÃO é um placeholder conhecido — mesma semântica de `matchedPatternNames`
 * em `scripts/scan-local-secrets.mjs`: comparação por IGUALDADE EXATA do
 * trecho casado, nunca substring. */
function matchCanonicalPattern(text: string, path: string): SecretPatternMatch | undefined {
  for (const { name, pattern } of CANONICAL_SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    const matches = text.match(global);
    if (matches && matches.some((m) => !CANONICAL_KNOWN_PLACEHOLDERS.has(m))) {
      return { path, patternName: name };
    }
  }
  return undefined;
}

/** Varre `value` recursivamente (objetos e arrays) até a primeira string que
 * casa um padrão canônico — `path` acumula o caminho de campos para a
 * mensagem de recusa (nunca o valor). */
function findSecretPatternMatch(value: unknown, path: string): SecretPatternMatch | undefined {
  if (typeof value === "string") return matchCanonicalPattern(value, path);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSecretPatternMatch(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const found = findSecretPatternMatch(v, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Recusa QUALQUER record (família, kind ou comando, tanto faz) cujo
 * `content` contenha texto com a FORMA de uma credencial canônica conhecida
 * — independente de `sensitivity.classification`. Roda em TODO write, não só
 * sob `secret`, porque esse é justamente o buraco que este guard fecha.
 *
 * A mensagem nomeia o CAMINHO do campo e o NOME do padrão — nunca o valor
 * casado, nem em parte: ecoar um fragmento do token no erro reintroduziria o
 * mesmo vazamento que a recusa existe para impedir.
 */
export function assertNoSecretPatternMatch(record: SecretGuardInput): void {
  const found = findSecretPatternMatch(record.content, "content");
  if (!found) return;
  throw new SecretMaterialError(
    `campo "${found.path}" contém texto com a forma de uma credencial conhecida (padrão: ${found.patternName}). ` +
      "Store nunca persiste segredo em texto livre, mesmo fora de classification=secret. " +
      "Nada foi escrito — FAIL CLOSED."
  );
}
