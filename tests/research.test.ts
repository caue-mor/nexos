/**
 * `validarFontes` é a única borda real do `nexos research`: o pareamento
 * posicional entre `--source`, `--claim` e `--confidence`.
 *
 * O teste existe porque uma verificação independente encontrou este caminho
 * CRASHANDO — `throw` dentro de um `.map()`, stack trace na cara do usuário por
 * esquecer um `--claim`, enquanto todas as outras bordas do mesmo arquivo
 * respondem com uma linha vermelha e exit 1.
 *
 *   FAIL CLOSED != FAIL LEGÍVEL
 *
 * Nada era gravado nos dois casos. Só um deles dizia ao usuário o que fazer.
 */
import { describe, it, expect } from "vitest";
import { validarFontes } from "../src/commands/research.js";

describe("research · validarFontes", () => {
  it("aceita fonte, claim e confiança pareados", () => {
    expect(validarFontes(["https://a"], ["afirma X"], ["OFFICIAL"])).toBeNull();
  });

  it("confiança ausente cai para SINGLE_SOURCE, não reprova", () => {
    expect(validarFontes(["https://a"], ["afirma X"], [])).toBeNull();
  });

  it("recusa (sem crashar) fonte sem claim pareado", () => {
    const r = validarFontes(["https://a"], [], ["OFFICIAL"]);
    expect(r).not.toBeNull();
    expect(r).toContain("sem --claim pareado");
  });

  it("recusa claim vazio — string em branco não é afirmação", () => {
    expect(validarFontes(["https://a"], ["   "], [])).toContain("sem --claim pareado");
  });

  it("recusa confiança fora do enum, dizendo a posição", () => {
    const r = validarFontes(["https://a", "https://b"], ["x", "y"], ["OFFICIAL", "TALVEZ"]);
    expect(r).toContain("posição 2");
    expect(r).toContain("OFFICIAL | CORROBORATED | SINGLE_SOURCE");
  });

  it("valida a SEGUNDA fonte, não só a primeira", () => {
    expect(validarFontes(["https://a", "https://b"], ["x"], [])).toContain("https://b");
  });

  it("sem fontes não é problema desta função — quem recusa é o comando", () => {
    expect(validarFontes([], [], [])).toBeNull();
  });
});
