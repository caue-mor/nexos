/**
 * D3 (chk_01M2EE9N5EEET94B5PFPHBGTDN) — `bisectWorkersForFactor` substitui
 * os níveis fixos (`cpuCount * [1,2,3,4]`) de `calibrateLoad`
 * (`repro-session-start-host.mts`), que pulavam a faixa ENTRE dois níveis
 * mesmo quando o alvo caía exatamente nela (medido: um nível dava 1,45x, o
 * próximo 2,3x, e um alvo de 1,78x nunca era medido em lugar nenhum). O
 * medidor real spawna processos de carga de verdade; aqui é uma TABELA
 * determinística — prova o ALGORITMO de bissecção, não o custo de spawnar
 * processos (isso já é exercitado, sem determinismo de CI, pelo script
 * manual `repro-session-start-host.mts`, fora do escopo de teste automático).
 */
import { describe, it, expect } from "vitest";
import { bisectWorkersForFactor, type WorkerFactorMeasurer } from "../scripts/lib/session-start-harness.mjs";

/** factor(workers) linear: 10 -> 1.0x, 40 -> 4.0x — cobre a faixa 1.45x-2.3x do achado real, incluindo o meio nunca medido (1.78x, em w=17.8). */
function linearMeasurer(calls: number[]): WorkerFactorMeasurer {
  return async (workers: number) => {
    calls.push(workers);
    const factor = 1.0 + (workers - 10) * 0.1;
    return { factor, samples: [factor] };
  };
}

describe("bisectWorkersForFactor", () => {
  it("alvo ENTRE dois níveis fixos antigos (1.78x, entre 1.45x@w=20 e 2.3x@w=30) ⇒ isolável, mede o meio nunca medido antes", async () => {
    const calls: number[] = [];
    const result = await bisectWorkersForFactor(linearMeasurer(calls), 1.78, 0.15, { minWorkers: 10, maxWorkers: 40 });
    expect(result.isolable).toBe(true);
    expect(Math.abs(result.achievedFactor - 1.78)).toBeLessThanOrEqual(0.15);
    // a bissecção precisou medir ALGO estritamente entre os dois extremos —
    // nunca só os quatro níveis fixos originais (10/20/30/40).
    expect(calls.some((w) => w > 10 && w < 40 && w !== 20 && w !== 30)).toBe(true);
  });

  it("alvo abaixo do mínimo de workers ⇒ resolve já no primeiro ponto, sem bissectar", async () => {
    const calls: number[] = [];
    const result = await bisectWorkersForFactor(linearMeasurer(calls), 0.5, 0.15, { minWorkers: 10, maxWorkers: 40 });
    expect(result.workers).toBe(10);
    expect(calls).toEqual([10]);
  });

  it("alvo acima do que o teto de workers alcança ⇒ isolable:false, devolve o MELHOR medido (nunca um fator fabricado)", async () => {
    const calls: number[] = [];
    const result = await bisectWorkersForFactor(linearMeasurer(calls), 100, 0.15, { minWorkers: 10, maxWorkers: 40 });
    expect(result.isolable).toBe(false);
    expect(result.achievedFactor).toBeCloseTo(4.0, 5); // fator real no teto (w=40), nunca 100
    expect(result.workers).toBe(40);
  });

  it("teto de tentativas esgotado sem cair na tolerância ⇒ isolable:false, ainda devolve o melhor medido até ali", async () => {
    const calls: number[] = [];
    // tolerância minúscula — quase impossível bater exato por bissecção binária em poucas tentativas.
    const result = await bisectWorkersForFactor(linearMeasurer(calls), 1.783, 0.0001, {
      minWorkers: 10,
      maxWorkers: 40,
      maxAttempts: 2,
    });
    expect(result.isolable).toBe(false);
    expect(result.achievedFactor).toBeGreaterThan(0);
  });
});
