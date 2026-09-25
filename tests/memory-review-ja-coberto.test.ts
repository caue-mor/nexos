/**
 * Candidato cuja lição JÁ está no acervo promovido não é decisão humana.
 *
 *   DEDUPE ENTRE CANDIDATOS NÃO É DEDUPE CONTRA O ACERVO
 *
 * MEDIDO em 2026-09-19: a fila tinha 114 candidatos parados há 22 dias, e o
 * review comparava candidato com candidato. Nove deles já existiam como
 * gotcha promovido — seis com similaridade 1.00, texto idêntico. Eram
 * decisões humanas pedidas para conhecimento que já estava canônico.
 *
 * O número que importa não é quantos itens há, é quantas decisões sobram:
 *
 *     114 candidatos
 *      -9 já no acervo
 *     -44 caem em 14 temas (cada tema = 1 decisão)
 *     ---
 *      75 decisões humanas reais
 *
 * Este arquivo trava a matemática e o lado que erra: preferir mostrar a
 * esconder. Um falso positivo aqui some com um candidato legítimo da fila, e
 * o custo disso é maior que o de pedir uma decisão a mais.
 */
import { describe, it, expect } from "vitest";
import { termosDe } from "../src/lib/context-assembler.js";

/** A mesma conta do comando, isolada para poder ser exercitada. */
function jaCoberto(fato: string, acervo: readonly string[], limiar = 0.35): number | null {
  const tc = termosDe(fato);
  if (tc.size === 0) return null;
  let melhor = 0;
  for (const texto of acervo) {
    const tp = termosDe(texto);
    if (tp.size === 0) continue;
    let inter = 0;
    for (const t of tc) if (tp.has(t)) inter += 1;
    const jaccard = inter / (tc.size + tp.size - inter);
    if (jaccard > melhor) melhor = jaccard;
  }
  return melhor >= limiar ? Math.round(melhor * 100) / 100 : null;
}

const ACERVO = [
  "Binario global instalado pode ser mais antigo que o dist do repo MESMA VERSAO NAO E MESMO CODIGO",
  "O campo freshness do record e constante e nenhum leitor existe no codigo",
];

describe("dedupe contra o acervo promovido", () => {
  it("texto idêntico ao de um gotcha promovido é coberto", () => {
    expect(jaCoberto(ACERVO[0]!, ACERVO)).toBe(1);
  });

  it("reformulação próxima também é coberta", () => {
    const s = jaCoberto("O binario global instalado pode ser mais antigo que o dist do repo", ACERVO);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(0.35);
  });

  /**
   * CONTROLE NEGATIVO — o que mais importa. Sem ele, baixar o limiar até
   * esvaziar a fila passaria nos dois testes acima e SUMIRIA com candidatos
   * legítimos, que é o pior resultado possível aqui.
   */
  it("lição diferente NÃO é coberta, mesmo compartilhando vocabulário técnico", () => {
    expect(jaCoberto("O doctor le o Store em tres modulos e paga o parse tres vezes", ACERVO)).toBeNull();
    expect(jaCoberto("A media query declarada antes da regra base e codigo morto", ACERVO)).toBeNull();
  });

  it("acervo vazio nunca cobre nada — ausência de comparação não é cobertura", () => {
    expect(jaCoberto("qualquer lição nova", [])).toBeNull();
  });

  it("fato vazio devolve null em vez de casar com tudo", () => {
    expect(jaCoberto("", ACERVO)).toBeNull();
  });
});

describe("a conta de decisões humanas reais", () => {
  /**
   * `candidatos - jaCoberto - emCluster + clustersReais`. Cada cluster vira
   * UMA decisão; candidato coberto vira NENHUMA.
   */
  const decisoes = (total: number, cobertos: number, emCluster: number, clusters: number): number =>
    total - cobertos - emCluster + clusters;

  it("reproduz o número medido no Store real", () => {
    expect(decisoes(114, 9, 44, 14)).toBe(75);
  });

  it("sem clusters e sem cobertos, toda a fila é decisão", () => {
    expect(decisoes(114, 0, 0, 0)).toBe(114);
  });

  /** CONTROLE: um cluster de 2 economiza 1 decisão, nunca 2. */
  it("cluster de 2 tira exatamente uma decisão", () => {
    expect(decisoes(10, 0, 2, 1)).toBe(9);
  });
});
