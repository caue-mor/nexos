/**
 * SECRET SHIELD — o consumidor que faltava para `redact()`.
 *
 *   CAPABILITY INSTALADA SEM CONSUMO NÃO É CAPABILITY
 *
 * MEDIDO em 2026-09-23: `redact()` do canônico tinha ZERO consumidores vivos —
 * os três hooks que o chamavam saíram em `abbcb4d3`, e a única menção restante
 * ao nome era um comentário histórico. Ao mesmo tempo, os três hooks que o
 * NexOS instala em `UserPromptSubmit` (o único evento que vê o que o humano
 * digita) não mencionavam segredo em lugar nenhum.
 *
 * Não era limitação do host: `code.claude.com/docs/en/hooks.md` diz que exit
 * code 2 em `UserPromptSubmit` "blocks prompt processing and erases the
 * prompt", e o prompt bloqueado não entra no transcript. O mecanismo existia e
 * ninguém tinha ligado.
 *
 * Este arquivo mede o escudo pelo CONTRATO DO HOST — processo de verdade,
 * stdin de verdade, exit code de verdade — e não pela função interna. Um teste
 * que só chamasse a função não provaria a única coisa que importa aqui: que o
 * Claude Code recebe 2 e apaga o prompt.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(RAIZ, "assets/hooks/nexos-secret-shield.cjs");

const rep = (a: string, n: number): string => a.repeat(Math.ceil(n / a.length)).slice(0, n);
const HEX = "0123456789abcdef";

/** Sintético: construído por repetição, nunca credencial de serviço nenhum. */
const CHAVE_CTX7 = `ctx7sk-${rep(HEX, 8)}-${rep(HEX, 4)}-${rep(HEX, 4)}-${rep(HEX, 4)}-${rep(HEX, 12)}`;
const CHAVE_GITHUB = `ghp_${"Z9y8X7w6V5".repeat(4)}`;

const rodar = (payload: string): { status: number | null; stderr: string } => {
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf-8" });
  return { status: r.status, stderr: r.stderr ?? "" };
};
const comPrompt = (prompt: string): string => JSON.stringify({ prompt });

describe("secret shield · bloqueia (exit 2 apaga o prompt no host)", () => {
  it.each([
    ["chave de provider isolada", CHAVE_CTX7],
    ["chave no meio de uma frase", `a minha chave e ${CHAVE_CTX7} ok?`],
    ["forma de token do github", `token ${CHAVE_GITHUB}`],
  ])("%s", (_nome, texto) => {
    expect(rodar(comPrompt(texto)).status).toBe(2);
  });

  it("a mensagem nomeia o PADRÃO e nunca o valor — nem prefixo útil", () => {
    const { stderr } = rodar(comPrompt(`chave ${CHAVE_CTX7}`));
    expect(stderr).toContain("ctx7_key");
    expect(stderr).not.toContain(CHAVE_CTX7);
    expect(stderr).not.toContain(CHAVE_CTX7.slice(0, 14));
  });
});

/**
 * CONTROLES NEGATIVOS — exit 2 APAGA o texto do humano. Falso positivo aqui
 * não é ruído, é trabalho perdido, e o escudo seria arrancado na terceira vez.
 * As três formas genéricas do canônico ficam de fora DE PROPÓSITO; estes casos
 * travam essa decisão para que ninguém a desfaça sem ver o porquê.
 */
describe("secret shield · deixa passar", () => {
  it.each([
    ["prompt comum", "roda os testes e commita"],
    ["prosa que só MENCIONA o prefixo", "o prefixo ctx7sk- identifica a chave do Context7"],
    ["generic_secret: código colado para revisão", 'no codigo tem token: "abc12345678" — revisa'],
    ["bearer_token: exemplo de curl", 'curl -H "Authorization: Bearer abcdef123456789" http://x'],
    ["database_url: string de README", "a url e postgres://localhost:5432/dev"],
  ])("%s", (_nome, texto) => {
    expect(rodar(comPrompt(texto)).status).toBe(0);
  });

  it("fixture pública conhecida não é credencial", () => {
    expect(rodar(comPrompt(`token ${"ghp_" + "a1B2c3D4e5".repeat(4)}`)).status).toBe(0);
  });
});

/**
 * FAIL OPEN é escolha declarada, não descuido: um escudo quebrado que engole
 * todo prompt torna a sessão inutilizável e é arrancado no mesmo dia. O Store
 * segue FAIL CLOSED atrás disto, que é onde fechar custa barato.
 */
describe("secret shield · fail open em entrada que não dá para interpretar", () => {
  it.each([
    ["stdin que não é JSON", "nao-e-json"],
    ["JSON sem campo prompt", '{"outro":"x"}'],
    ["prompt vazio", '{"prompt":""}'],
    ["stdin vazio", ""],
  ])("%s", (_nome, payload) => {
    expect(rodar(payload).status).toBe(0);
  });
});

describe("secret shield · está ligado no host", () => {
  it("assets/settings.json declara o escudo em UserPromptSubmit", async () => {
    const fs = await import("fs-extra");
    const settings = (await fs.default.readJson(path.join(RAIZ, "assets/settings.json"))) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const comandos = (settings.hooks["UserPromptSubmit"] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(comandos.some((c) => c.includes("nexos-secret-shield.cjs"))).toBe(true);
  });

  /** O escudo tem de correr ANTES dos hooks que emitem contexto: um hook que
   * já imprimiu não desfaz a impressão quando o seguinte bloqueia. */
  it("é o PRIMEIRO hook do evento", async () => {
    const fs = await import("fs-extra");
    const settings = (await fs.default.readJson(path.join(RAIZ, "assets/settings.json"))) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const comandos = (settings.hooks["UserPromptSubmit"] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(comandos[0]).toContain("nexos-secret-shield.cjs");
  });
});
