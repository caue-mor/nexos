/**
 * A extração do subject, pela FUNÇÃO REAL que o comando usa.
 *
 *   TESTED != WIRED
 *
 * A primeira tentativa de guardar isto declarava uma CÓPIA da leitura dentro
 * do próprio arquivo de teste, com um comentário afirmando que a cópia
 * denunciaria mudanças no original. A frase era falsa — uma cópia local não
 * denuncia nada — e uma verificação independente provou por mutação: reverter
 * `checkpoint.ts` para ler `previous_checkpoint_id` de `content` deixava 28/28
 * testes verdes.
 *
 * Agora o teste importa `subjectDoCheckpoint`, que é a MESMA função que
 * `src/commands/checkpoint.ts` chama. Mutá-la mata estes testes.
 */
import { describe, it, expect } from "vitest";
import { subjectDoCheckpoint, projectIdDoCheckpoint, cortarStatement } from "../src/lib/learning-trigger.js";

/** A forma exata com que o Store publica um checkpoint. */
const recordComoOStorePublica = {
  id: "chk_NOVO",
  family: "ProjectCheckpoint",
  previous_checkpoint_id: "chk_ANTERIOR",
  project_id: "prj_X",
  content: { state: "SUCCEEDED", statement: "tarefa" },
};

describe("learning-trigger · extração do subject (função real)", () => {
  it("o subject sai do ENVELOPE", () => {
    expect(subjectDoCheckpoint(recordComoOStorePublica)).toBe("chk_ANTERIOR");
  });

  it("o project sai do ENVELOPE", () => {
    expect(projectIdDoCheckpoint(recordComoOStorePublica)).toBe("prj_X");
  });

  /**
   * O bug original: o mesmo campo dentro de `content` NÃO pode ser aceito. Se
   * alguém "consertar" a função para olhar os dois lugares, este teste cai —
   * e é o que impede a leitura errada de voltar disfarçada de tolerância.
   */
  it("o MESMO campo dentro de content é ignorado — era assim que o gatilho morria calado", () => {
    const soEmContent = {
      id: "chk_NOVO",
      family: "ProjectCheckpoint",
      project_id: "prj_X",
      content: { state: "SUCCEEDED", previous_checkpoint_id: "chk_ANTERIOR" },
    };
    expect(subjectDoCheckpoint(soEmContent), "ler de content devolvia undefined sem erro").toBe("");
  });

  it("raiz de cadeia (sem previous) devolve vazio, e o caller não chama o gatilho", () => {
    expect(subjectDoCheckpoint({ id: "chk_ROOT", content: {} })).toBe("");
    expect(projectIdDoCheckpoint({ id: "chk_ROOT", content: {} })).toBe("");
  });

  it("valor não-string é rejeitado, nunca coagido", () => {
    expect(subjectDoCheckpoint({ previous_checkpoint_id: 42 })).toBe("");
    expect(subjectDoCheckpoint({ previous_checkpoint_id: null })).toBe("");
    expect(subjectDoCheckpoint(undefined)).toBe("");
  });
});

/**
 *   TRUNCAR NO MEIO DA PALAVRA PRODUZ MEMÓRIA ILEGÍVEL
 *
 * A regra do candidato é o que um humano lê no gate de promoção. Um corte cego
 * em N caracteres entrega "...o executor não julga se ca" — e regra terminada
 * em fragmento é regra que ninguém aplica.
 *
 * Nenhum teste alcançava `cortarStatement`: a mutação que trocava o corte por
 * `slice(0, limite)` liso deixava a suíte inteira verde. O anterior guardava
 * isto comparando `X.split(" ").pop()` com `longo.slice(0, X.length).split(" ").pop()`
 * — os dois lados eram a mesma expressão, então a comparação era verdadeira
 * com qualquer implementação. Estes usam texto FIXO, com o corte esperado
 * escrito à mão.
 */
describe("cortarStatement", () => {
  const frase = "o executor não julga se cabe ao verificador independente";

  it("não termina em fragmento de palavra", () => {
    // 27 chars cai dentro de "cabe"; o corte tem de recuar para antes dela.
    expect(cortarStatement(frase, 27)).toBe("o executor não julga se…");
  });

  it("devolve o texto intacto quando cabe", () => {
    expect(cortarStatement(frase, 500)).toBe(frase);
  });

  it("normaliza espaço em branco antes de medir", () => {
    expect(cortarStatement("  a\n\n  b  ", 99)).toBe("a b");
  });

  it("palavra única maior que o teto ainda é cortada — senão o teto não é teto", () => {
    expect(cortarStatement("chk_01M2SV96R89WDSVQ8TMECTCZDV", 10)).toBe("chk_01M2SV…");
  });
});
