/**
 * DELEGAÇÃO DE CONTINUIDADE — `next_action` que manda LER um documento.
 *
 *   MENTIONING A FILE != DELEGATING TO IT
 *
 * DEFEITO medido em 28/08 no `project-state` head de
 * `AIFirst/projects/1-marketing`: o Store — a autoridade declarada — mandava a
 * proxima sessao ler `docs/meta-hub-b2b/RETOMADA-PROXIMA-SESSAO.md` para saber
 * o que fazer. A autoridade apontando para a projecao.
 *
 * A parte cara do teste NAO e o caso real (grupo 1) — e o POSITIVO (grupo 2):
 * dos 193 `next_action` reais medidos nos tres projetos, 190 citam comando,
 * codigo ou nada, e um criterio que reprovasse a mencao a arquivo mataria os
 * 190. `documentoDelegado` flagra 3/193 (1,6%), os tres literalmente
 * "Ler PROXIMA-SESSAO.md".
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import { documentoDelegado } from "../src/lib/capsule/schemas.js";

describe("documentoDelegado · o caso real", () => {
  it("o head de 1-marketing, verbatim: delega a continuidade ao markdown", () => {
    const real =
      "PRIMEIRO COMANDO: nexos boot. DEPOIS: ler " +
      "docs/meta-hub-b2b/RETOMADA-PROXIMA-SESSAO.md, que tem o roteiro completo, " +
      "a lista integral de pendencias com checkbox e as 8 armadilhas que ja " +
      "morderam nesta sessao.";
    expect(documentoDelegado(real)).toBe("docs/meta-hub-b2b/RETOMADA-PROXIMA-SESSAO.md");
  });

  it("as duas outras delegacoes reais (nexos-cli e PROJETO-A), verbatim", () => {
    expect(documentoDelegado("Ler PROXIMA-SESSAO.md. Continuar C2 (aplicacao da proposta).")).toBe(
      "PROXIMA-SESSAO.md"
    );
    expect(
      documentoDelegado("Ler PROXIMA-SESSAO.md primeiro. Decisao na mesa: ativar PILOT.")
    ).toBe("PROXIMA-SESSAO.md");
  });
});

/**
 * O POSITIVO. Cada string aqui e texto REAL de `next_action` medido nos tres
 * Stores, ou o texto que o checkpoint automatico produz. Um so falso positivo
 * neste bloco poe o aviso no caminho do comando obrigatorio de fim de sessao.
 */
describe("documentoDelegado · o que passa sem atrito", () => {
  const legitimos: readonly (readonly [string, string])[] = [
    ["comando", "Rodar PRIMEIRO npm run verify:work-graph — o grafo decide o que falta."],
    ["ponteiro de codigo", "Ver src/lib/host/presence-observation.ts:42 antes de mexer no gate."],
    ["arquivo como objeto de acao", "Corrigir src/services/contatos.ts e o page.tsx do dashboard."],
    ["config citada", "Aplicar claude/settings.json e assets/policies/agent-registry.yaml."],
    [
      "documento como APOIO, sem verbo de leitura",
      "Gravar o screencast em 7 das 8 permissoes; a evidencia pronta esta em " +
        "docs/meta/app-review-evidencia-2026-08-26.md.",
    ],
    [
      "verbo DENTRO do nome do arquivo (o falso positivo que `\\b` produzia)",
      "Roteiro cena a cena em docs/meta/app-review-evidencia-2026-08-26.md.",
    ],
    /**
     * Este caso e SINTETICO, e esta aqui por medicao: mutando so o lookahead
     * do verbo, os 12 testes continuavam verdes — o corpus real nunca poe um
     * verbo no FIM de um token de caminho, entao o lookbehind ficava sem
     * guard. `docs/app-review,` tem `-` antes e `,` depois: so o lookbehind o
     * barra.
     */
    [
      "verbo no fim de um token de caminho (exercita o lookbehind sozinho)",
      "Fechar o docs/app-review, e depois publicar o plano.md.",
    ],
    /**
     * Espelho do de cima, pela mesma medicao: mutando so o LOOKBEHIND os 13
     * ficavam verdes. Aqui `read` comeca um token (`read-me`), entao o
     * lookbehind o aceita e so o lookahead o barra. Os dois guards cobrem
     * lados opostos do token — nenhum e redundante, e agora nenhum e sem
     * teste.
     */
    [
      "verbo no inicio de um token de caminho (exercita o lookahead sozinho)",
      "Conferir o read-me do pacote e publicar o plano.md.",
    ],
    ["campo ausente", ""],
  ];

  for (const [nome, texto] of legitimos) {
    it(`passa: ${nome}`, () => {
      expect(documentoDelegado(texto)).toBeUndefined();
    });
  }

  it("undefined nao e sinal — `NO SIGNAL != INVALID SIGNAL`", () => {
    expect(documentoDelegado(undefined)).toBeUndefined();
  });

  /**
   * FATIA 3: o checkpoint automatico (`session-checkpoint.ts`) parou de
   * derivar `next_action` do Work Graph — ele so republica o que o Store ja
   * tinha declarado (`ramosDeclarados`). `proximaAcaoDerivada`, o texto que
   * este teste checava, foi removido junto por nao ter mais chamador: sem
   * producao de texto nenhuma, nao ha o que este alarme pudesse disparar
   * sozinho a cada PreCompact. Ver `tests/session-checkpoint.test.ts` para a
   * garantia atual (`next_action` declarado sobrevive ao checkpoint).
   */
});

/**
 * O aviso vive em `state.ts` e e AVISO, nao recusa — `HOT PATH REFUSAL !=
 * FREE REFUSAL`. Um refactor que o transformasse em `process.exitCode = 1`
 * destruiria snapshot irreproduzivel no fim de sessao; este teste e o guard.
 */
describe("superficie · avisa e publica", () => {
  it("`state.ts` chama `documentoDelegado` e NAO aborta por causa dele", async () => {
    const code = await fs.readFile("src/commands/state.ts", "utf-8");
    expect(code).toMatch(/documentoDelegado\(options\.next\)/);
    const bloco = code.slice(code.indexOf("const delegado ="));
    const ateOFimDoIf = bloco.slice(0, bloco.indexOf("\n  }\n") + 5);
    expect(ateOFimDoIf).not.toMatch(/exitCode|return;|throw /);
  });
});
