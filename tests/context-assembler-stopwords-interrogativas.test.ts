/**
 * `termosDe` — interrogativas e verbos vazios não discriminam assunto.
 *
 *   UM TERMO EM COMUM NÃO É RELEVÂNCIA
 *
 * MEDIDO em 2026-09-19, com o controle negativo que expôs o defeito: o prompt
 * "qual a receita de bolo de cenoura com cobertura" — assunto sem nenhuma
 * relação com este projeto — RECUPERAVA memória e injetava no contexto.
 *
 * Os termos casados eram `qual` (interrogativa) e `cobertura` (homônimo de
 * cobertura de testes). Dois termos bastam para `qualifica()` em
 * `memory-recall.ts:175`, e ali dois termos genéricos valiam tanto quanto
 * dois específicos.
 *
 * O homônimo NÃO se resolve por lista de stopword, e não é isso que este
 * teste trava: com `qual` fora, sobra UM termo, e `qualifica` passa a exigir
 * sinal forte de frase — que é o comportamento correto para um casamento
 * fraco. A lista fecha a classe; a arquitetura de qualificação faz o resto.
 */
import { describe, it, expect } from "vitest";
import { termosDe } from "../src/lib/context-assembler.js";

describe("interrogativas e verbos de suporte não viram termo de busca", () => {
  it("o prompt do controle negativo sobra apenas com o homônimo", () => {
    const t = termosDe("qual a receita de bolo de cenoura com cobertura");
    /** `qual` fora: é interrogativa, nunca diz sobre o quê se pergunta. */
    expect(t.has("qual")).toBe(false);
    /** `cobertura` FICA: é homônimo real, e listá-lo cegaria busca legítima. */
    expect(t.has("cobertura")).toBe(true);
    /** Sobra 1 termo relevante para o corpus — abaixo do piso de 2 de `qualifica`. */
    expect([...t].filter((x) => x !== "receita" && x !== "bolo" && x !== "cenoura")).toEqual(["cobertura"]);
  });

  it("verbos de suporte saem: o segundo caso medido", () => {
    const t = termosDe("vou afirmar que a correcao funcionou sem ter rodado nada");
    for (const vazio of ["vou", "ter", "nada"]) expect(t.has(vazio)).toBe(false);
    /** O que sobra é o que de fato diz o assunto. */
    expect(t.has("correcao")).toBe(true);
    expect(t.has("afirmar")).toBe(true);
  });

  /**
   * CONTROLE POSITIVO — sem ele, engordar a lista de stopwords até cegar a
   * busca passaria nos dois testes acima. Termo técnico não pode sumir.
   */
  it.each([
    ["corrigir bug no parser de YAML do frontmatter", ["parser", "yaml", "frontmatter", "corrigir", "bug"]],
    ["como revalidar um fato antigo do Store", ["revalidar", "fato", "antigo", "store"]],
    ["o checkpoint ficou em VERIFYING sem evidencia", ["checkpoint", "verifying", "evidencia"]],
  ])("termo técnico sobrevive: %s", (prompt, esperados) => {
    const t = termosDe(prompt);
    for (const e of esperados) expect(t.has(e)).toBe(true);
  });

  /** As levas anteriores continuam valendo — regressão de lista é silenciosa. */
  it("as classes já fechadas seguem fora", () => {
    const t = termosDe("nao foi isso mas tambem nao era aquilo quando estar aqui");
    for (const antigo of ["nao", "isso", "tambem", "quando", "estar", "aqui"]) {
      expect(t.has(antigo)).toBe(false);
    }
  });
});
