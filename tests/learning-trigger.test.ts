/**
 * O gatilho automático do learning loop.
 *
 *   EVENTO QUE PODERIA DISPARAR != CAPABILITY REALMENTE CONSUMIDA
 *
 * `nexos learn` existia com ZERO caller automático — dependia de alguém
 * lembrar de digitá-lo. Uma capability que exige memória humana para registrar
 * memória é a definição do problema que ela deveria resolver.
 *
 * O que estes testes seguram é a RÉGUA, não a fiação: qual SUCCEEDED merece
 * candidato. Um gatilho que propõe sempre inunda o Store; um que nunca propõe
 * é o que tínhamos.
 */
import { describe, it, expect } from "vitest";
import { redGreenCrossCommit } from "../src/lib/learning-trigger.js";
import type { EvidenceFile } from "../src/lib/learning-trigger.js";

const ev = (id: string, gate: string, pass: boolean, commit: string, t: string): EvidenceFile => ({
  id,
  gate,
  observed_pass: pass,
  commit,
  finished_at: t,
});

describe("learning-trigger · redGreenCrossCommit", () => {
  it("transição que atravessa commit é sinal de aprendizado", () => {
    const a = redGreenCrossCommit([
      ev("ev_1", "test", false, "aaaaaaaa1111", "2026-09-18T10:00:00Z"),
      ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
    ]);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("test");
  });

  /**
   * O caso que decide se o gatilho presta. No acervo real deste repo, 10 das
   * 16 transições red→green eram no MESMO commit: re-run, árvore suja, flaky.
   * Sem este filtro o "sinal de aprendizado" seria majoritariamente ruído — e
   * um detector que aprende com flaky ensina a suíte a mentir.
   */
  it("MESMO commit não é aprendizado — é re-run, árvore suja ou flaky", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_1", "test", false, "aaaaaaaa1111", "2026-09-18T10:00:00Z"),
        ev("ev_2", "test", true, "aaaaaaaa1111", "2026-09-18T10:05:00Z"),
      ])
    ).toEqual([]);
  });

  it("green→red é regressão, não aprendizado — sai por outra porta", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_1", "build", true, "aaaaaaaa1111", "2026-09-18T10:00:00Z"),
        ev("ev_2", "build", false, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("gates diferentes não se misturam", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_1", "lint", false, "aaaaaaaa1111", "2026-09-18T10:00:00Z"),
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("ordena por tempo, não pela ordem de leitura do diretório", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
        ev("ev_1", "test", false, "aaaaaaaa1111", "2026-09-18T10:00:00Z"),
      ])
    ).toHaveLength(1);
  });

  it("evidence sem gate, sem veredito ou sem commit é descartada, nunca adivinhada", () => {
    expect(
      redGreenCrossCommit([
        { id: "ev_1", commit: "aaaaaaaa1111", finished_at: "2026-09-18T10:00:00Z" },
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
      ])
    ).toEqual([]);
    expect(
      redGreenCrossCommit([
        { id: "ev_1", gate: "test", observed_pass: false, finished_at: "2026-09-18T10:00:00Z" },
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("acervo vazio não propõe nada, e isso é o caso COMUM, não erro", () => {
    expect(redGreenCrossCommit([])).toEqual([]);
  });
});

/**
 * O candidato tem de citar TODOS os gates que viraram verde.
 *
 *   UM SINAL RELATADO != TODOS OS SINAIS OBSERVADOS
 *
 * A primeira versão usava `observados[0]` na regra: com `lint` e `test`
 * virando verde no mesmo trabalho, o candidato mencionava um e escondia o
 * outro. Quem lesse a memória depois concluiria que só um gate estivera
 * quebrado — e é exatamente a conclusão errada que o learning loop existe
 * para evitar.
 */
describe("learning-trigger · todos os gates, não só o primeiro", () => {
  it("dois gates red→green produzem DOIS achados, não um", () => {
    const achados = redGreenCrossCommit([
      ev("ev_1", "lint", false, "aaaaaaaa1111", "2026-09-18T10:00:00Z"),
      ev("ev_2", "lint", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z"),
      ev("ev_3", "test", false, "aaaaaaaa1111", "2026-09-18T10:01:00Z"),
      ev("ev_4", "test", true, "bbbbbbbb2222", "2026-09-18T11:01:00Z"),
    ]);
    expect(achados).toHaveLength(2);
    expect(achados.join(" ")).toContain("lint");
    expect(achados.join(" "), "o segundo gate não pode sumir do relato").toContain("test");
  });
});
