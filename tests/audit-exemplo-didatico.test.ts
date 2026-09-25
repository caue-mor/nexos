/**
 * EXEMPLO DIDÁTICO != REFERÊNCIA EXECUTÁVEL
 *
 * MEDIDO em 2026-09-20 neste host: 6 dos 32 `broken-reference` (19%) eram o
 * autor mostrando ao leitor o que ELE vai criar — nunca arquivo que a peça
 * precisa ter. Acusar isso gasta a atenção de quem audita no ruído e ensina a
 * ignorar a lista inteira.
 *
 * A regra não é lista dos casos encontrados. São dois sinais gerais:
 * convenção de placeholder no caminho, e entrypoint genérico SEM diretório.
 * O segundo saiu de medição: das 280 referências que RESOLVEM neste host, 10
 * são basename solto — e são nomes de domínio (`recalc.py`, `run.js`), nunca
 * `app.js`. Skill real guarda o que executa em `scripts/`.
 */
import { describe, it, expect } from "vitest";
import { referenciasCitadas } from "../src/lib/capabilities/audit.js";

const citados = (texto: string): readonly string[] =>
  referenciasCitadas(texto, "/fixture/skills/exemplo/SKILL.md", "/fixture/home").map((r) => r.citado);

describe("audit: exemplo didático não é referência quebrada", () => {
  it.each([
    ["convenção your_", "Rode `python your_automation.py` para testar."],
    ["caminho /path/to/", "Aponte para `/path/to/storage_state.js` no config."],
    ["entrypoint app", "Crie um `app.js` e chame `node app.js`."],
    ["entrypoint main", "O seu `main.py` deve expor a função."],
    ["entrypoint server", "Suba com `python server.py`."],
    ["convenção my_", "Salve como `my_config.py` e edite."],
  ])("%s é ignorado", (_caso, texto) => {
    expect(citados(texto)).toEqual([]);
  });

  /**
   * CONTROLE NEGATIVO — sem isto a regra vira absolvição geral e o detector
   * deixa de detectar, que é pior que o falso positivo que ele corrige.
   */
  it("CONTROLE: o mesmo nome genérico COM diretório continua sendo referência real", () => {
    /**
     * `scripts/main.py` prova intenção de dependência: o autor não está
     * mostrando o entrypoint do leitor, está apontando para dentro da própria
     * peça. Se não existir, é broken e tem de aparecer.
     */
    expect(citados("Execute `python scripts/main.py` agora.")).toEqual(["scripts/main.py"]);
    expect(citados("Veja `scripts/app.js` para o exemplo.")).toEqual(["scripts/app.js"]);
  });

  it("CONTROLE: basename solto que NÃO é entrypoint genérico continua real", () => {
    /**
     * `run.js` e `recalc.py` foram medidos como referências VÁLIDAS neste host,
     * soltas, e de domínio. A regra não pode absolver todo arquivo sem pasta —
     * seria o falso negativo que ela deveria impedir.
     */
    expect(citados("Rode `node run.js` depois.")).toEqual(["run.js"]);
    expect(citados("Chame `python recalc.py` no fim.")).toEqual(["recalc.py"]);
  });

  it("CONTROLE: placeholder com colchete/ângulo continua ignorado (regra anterior intacta)", () => {
    expect(citados("Use `scripts/<nome>.py` conforme o domínio.")).toEqual([]);
  });

  it("a regra atua no CAMINHO, não na linha inteira", () => {
    /**
     * Lição já paga neste repo: filtrar a linha por causa de um marcador
     * escondia script morto em tabela markdown. Um exemplo e uma dependência
     * real na MESMA frase têm de sair separados.
     */
    expect(citados("Troque `your_file.py` e rode `python scripts/real.py`.")).toEqual(["scripts/real.py"]);
  });
});
