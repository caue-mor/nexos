/**
 * `nexos learn` — a v1 propõe candidato e PARA.
 *
 * O detector red→green é testado em isolamento porque é o ÚNICO fato que o
 * comando afirma sozinho: tudo mais vem declarado por quem roda. E o caso que
 * ele precisa acertar não é o feliz — é o de MESMO commit, que no acervo real
 * deste repo era 10 das 16 transições (re-run, árvore suja, flaky). Um detector
 * que aprende com flaky ensina a suíte a mentir.
 */
import { describe, it, expect } from "vitest";
import { redGreenCrossCommit } from "../src/commands/learn.js";

interface Ev {
  readonly id: string;
  readonly gate?: string;
  readonly commit?: string;
  readonly observed_pass?: boolean;
  readonly finished_at?: string;
}

const ev = (id: string, gate: string, pass: boolean, commit: string, t: string): Ev => ({
  id,
  gate,
  observed_pass: pass,
  commit,
  finished_at: t,
});

describe("redGreenCrossCommit", () => {
  it("acha a transição que atravessa commit", () => {
    const achados = redGreenCrossCommit([
      ev("ev_1", "test", false, "aaaaaaaa1111", "2026-09-17T10:00:00Z"),
      ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-17T11:00:00Z"),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0]).toContain("test");
    expect(achados[0]).toContain("aaaaaaaa");
    expect(achados[0]).toContain("bbbbbbbb");
  });

  /**
   * O caso que decide o valor do detector. Sem este filtro, o "sinal de
   * aprendizado" seria majoritariamente ruído de re-execução.
   */
  it("IGNORA red→green no MESMO commit — re-run, árvore suja, flaky", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_1", "test", false, "aaaaaaaa1111", "2026-09-17T10:00:00Z"),
        ev("ev_2", "test", true, "aaaaaaaa1111", "2026-09-17T10:05:00Z"),
      ])
    ).toEqual([]);
  });

  it("não confunde gates diferentes", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_1", "lint", false, "aaaaaaaa1111", "2026-09-17T10:00:00Z"),
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-17T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("green→red não é aprendizado — é regressão, e sai por outra porta", () => {
    expect(
      redGreenCrossCommit([
        ev("ev_1", "build", true, "aaaaaaaa1111", "2026-09-17T10:00:00Z"),
        ev("ev_2", "build", false, "bbbbbbbb2222", "2026-09-17T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("ordena por tempo, não pela ordem de leitura do diretório", () => {
    const achados = redGreenCrossCommit([
      ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-17T11:00:00Z"),
      ev("ev_1", "test", false, "aaaaaaaa1111", "2026-09-17T10:00:00Z"),
    ]);
    expect(achados, "lido fora de ordem e ainda assim detectado").toHaveLength(1);
  });

  it("evidence sem gate ou sem veredito é descartada, não adivinhada", () => {
    expect(
      redGreenCrossCommit([
        { id: "ev_1", commit: "aaaaaaaa1111", finished_at: "2026-09-17T10:00:00Z" },
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-17T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("commit ausente de um dos lados não vira transição", () => {
    expect(
      redGreenCrossCommit([
        { id: "ev_1", gate: "test", observed_pass: false, finished_at: "2026-09-17T10:00:00Z" },
        ev("ev_2", "test", true, "bbbbbbbb2222", "2026-09-17T11:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("acervo vazio devolve vazio, sem explodir", () => {
    expect(redGreenCrossCommit([])).toEqual([]);
  });
});
