/**
 * CHAVES DE PROVIDER — a assimetria entre o scanner de repo e o guard de runtime.
 *
 *   SCANNER DE REPO != GUARD DE RUNTIME
 *
 * MEDIDO em 2026-09-22, depois de o dono colar uma chave de API do Context7
 * direto no chat: o detector canônico (`assets/hooks/nexos-secret-patterns.cjs`,
 * que alimenta os três hooks de hot-path E o `assertNoSecretPatternMatch` de
 * todo write do Store) tinha OITO formas, e nenhuma delas casava a chave.
 * `redact()` devolveu a linha byte a byte igual.
 *
 * O agravante não é a forma nova: `scripts/scan-secrets.mjs` — o scanner de
 * ARQUIVOS do repo — já conhecia SEIS formas de provider (`sk-ant-`,
 * `sk-proj-`, `AIza`, `npm_`, `glpat-`, `xox*-`) que o guard de RUNTIME não
 * conhecia. A cobertura divergiu, e o lado fraco era exatamente o que protege
 * o que o usuário COLA e o que o agente GRAVA — o caminho mais quente dos dois.
 *
 * Por isso os corpos de regex das seis formas compartilhadas são copiados
 * VERBATIM do scanner, em vez de reescritos: uma nona definição divergente da
 * mesma forma é o defeito que `verify-secret-pattern-conformance.mts` existe
 * para impedir.
 *
 * Os valores abaixo são SINTÉTICOS — construídos por repetição de alfabeto,
 * nunca credencial de serviço nenhum. Nenhum valor real entra em teste, log,
 * transcript ou Store.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { assertNoSecretPatternMatch, CANONICAL_SECRET_PATTERNS, SecretMaterialError } from "../src/lib/capsule/secret-guard.js";

const require_ = createRequire(import.meta.url);
const canonico = require_("../assets/hooks/nexos-secret-patterns.cjs") as {
  redact: (s: string) => string;
  SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }>;
};

const rep = (alfabeto: string, n: number): string => alfabeto.repeat(Math.ceil(n / alfabeto.length)).slice(0, n);
const HEX = "0123456789abcdef";
const ALNUM = "aA1bB2cC3dD4eE5fF6gG7hH8iI9jJ0kK";

/** Uma forma sintética por padrão novo. A chave é o `name` da entrada
 * canônica, para que um rename silencioso do padrão derrube este teste. */
const SINTETICOS: ReadonlyArray<readonly [name: string, valor: string]> = [
  ["ctx7_key", `ctx7sk-${rep(HEX, 8)}-${rep(HEX, 4)}-${rep(HEX, 4)}-${rep(HEX, 4)}-${rep(HEX, 12)}`],
  ["anthropic_key", `sk-ant-api03-${rep(ALNUM, 95)}`],
  ["openai_key", `sk-proj-${rep(ALNUM, 64)}`],
  ["npm_token", `npm_${rep(ALNUM, 36)}`],
  ["slack_token", `xoxb-${rep("123456789", 12)}-${rep(ALNUM, 24)}`],
  ["google_api_key", `AIza${rep(ALNUM, 35)}`],
  ["gitlab_token", `glpat-${rep(ALNUM, 20)}`],
];

describe("canônico · formas de chave de provider", () => {
  it.each(SINTETICOS)("%s é redigido por redact()", (_nome, valor) => {
    const linha = `chave: ${valor}`;
    const saida = canonico.redact(linha);
    expect(saida).not.toContain(valor);
    expect(saida).toContain("[REDACTED]");
  });

  it.each(SINTETICOS)("%s existe como entrada nomeada no canônico", (nome) => {
    expect(canonico.SECRET_PATTERNS.map((p) => p.name)).toContain(nome);
  });
});

describe("Store · FAIL CLOSED para chave de provider", () => {
  it.each(SINTETICOS)("%s em content livre recusa a escrita", (_nome, valor) => {
    expect(() => assertNoSecretPatternMatch({ content: { fact: `a chave e ${valor}` } })).toThrow(SecretMaterialError);
  });

  it("a recusa nomeia o padrão e o campo, NUNCA o valor", () => {
    const valor = `ctx7sk-${rep(HEX, 8)}-${rep(HEX, 4)}-${rep(HEX, 4)}-${rep(HEX, 4)}-${rep(HEX, 12)}`;
    try {
      assertNoSecretPatternMatch({ content: { fact: valor } });
      expect.unreachable("deveria ter recusado");
    } catch (erro) {
      const msg = String((erro as Error).message);
      expect(msg).toContain("ctx7_key");
      expect(msg).toContain("content.fact");
      // O invariante que mais importa: nem o valor, nem um prefixo útil dele.
      expect(msg).not.toContain(valor);
      expect(msg).not.toContain(valor.slice(0, 12));
    }
  });
});

/**
 * CONTROLES NEGATIVOS — sem estes, um padrão frouxo passaria verde e o
 * FAIL CLOSED do Store começaria a recusar escrita legítima. Falso positivo
 * aqui não é ruído: é gravação bloqueada.
 */
describe("controles negativos · prosa que MENCIONA o prefixo não é credencial", () => {
  it.each([
    "o prefixo ctx7sk- identifica uma chave do Context7",
    "use sk-ant-... como formato da chave Anthropic",
    "instale com npm_config_registry=https://registry.npmjs.org",
    "a variável GOOGLE_API_KEY vai no ambiente, nunca no código",
    "xox- não é um token, é um prefixo truncado",
    "glpat- sozinho não casa nada",
  ])("%s", (linha) => {
    expect(canonico.redact(linha)).toBe(linha);
    expect(() => assertNoSecretPatternMatch({ content: { fact: linha } })).not.toThrow();
  });
});

/** O espelho de `secret-guard.ts` não pode ficar para trás do canônico — é a
 * mesma exigência de IDENTIDADE que o bloco 7 do conformance faz, medida aqui
 * pelo runtime em vez de por texto-fonte. */
describe("espelho · secret-guard acompanha o canônico", () => {
  it("todo padrão canônico tem corpo idêntico em CANONICAL_SECRET_PATTERNS", () => {
    const espelho = new Map(CANONICAL_SECRET_PATTERNS.map((p) => [p.name, p.pattern.source]));
    const divergentes = canonico.SECRET_PATTERNS.filter((p) => espelho.get(p.name) !== p.pattern.source).map((p) => p.name);
    expect(divergentes).toEqual([]);
  });
});
