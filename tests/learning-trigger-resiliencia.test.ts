/**
 * O gatilho NUNCA pode derrubar a transição do checkpoint.
 *
 *   TRABALHO VERIFICADO É SOBERANO
 *
 * `proporAoConcluir` roda depois de o SUCCEEDED estar publicado. Se ele
 * lançasse, o comando morreria APÓS o Store já ter o checkpoint — deixando o
 * operador sem saber se o trabalho fechou. Perder o registro de um trabalho
 * verificado porque a proposta de memória falhou é trocar o certo pelo
 * acessório.
 */
import { describe, it, expect } from "vitest";
import { proporAoConcluir } from "../src/lib/learning-trigger.js";

describe("learning-trigger · resiliência", () => {
  it("root inexistente não lança — devolve motivo e segue", async () => {
    const r = await proporAoConcluir("/caminho/que/nao/existe", "chk_x", "chk_y", "tarefa", "prj_z");
    expect(r.candidatos).toEqual([]);
    expect(r.motivo).not.toBe("");
  });

  it("sem evidence do subject, não propõe — e isso é o caso comum", async () => {
    const r = await proporAoConcluir(process.cwd(), "chk_x", "chk_subject_inexistente", "tarefa", "prj_z");
    expect(r.candidatos).toEqual([]);
    expect(r.motivo).toContain("red→green");
  });
});
