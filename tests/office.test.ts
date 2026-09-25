/**
 * `montarView` decide o que conta como ENTREGA e o que conta como trabalho
 * ABERTO. É a única lógica real do `nexos office` — o resto é impressão.
 *
 * Dois defeitos medidos ao rodar o comando pela primeira vez estão travados
 * aqui, porque os dois produziam uma página que PARECIA certa:
 *
 *   CURRENT HEAD != EVERY CHECKPOINT — a cadeia é append-only, então montar as
 *   entregas a partir dos heads devolvia UM checkpoint. Medido no repo real: 1
 *   head contra 409 no disco, 64 deles SUCCEEDED. A página dizia "0 entregue".
 *
 *   O campo do objetivo é `global_goal`, não `goal`. Ler a chave errada não
 *   falha: devolve string vazia, a seção some, e ninguém nota que o projeto
 *   perdeu o objetivo na vista.
 */
import { describe, it, expect } from "vitest";
import { montarView } from "../src/commands/office.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const chk = (id: string, state: string, statement: string, created: string): CapsuleRecord =>
  ({ id, family: "ProjectCheckpoint", created_at: created, content: { state, statement } }) as unknown as CapsuleRecord;

const estado = (campos: Record<string, string>): CapsuleRecord =>
  ({
    id: "knw_state",
    family: "KnowledgeRecord",
    kind: "project_state",
    created_at: "2026-09-18T00:00:00Z",
    content: campos,
  }) as unknown as CapsuleRecord;

describe("office · montarView", () => {
  it("SUCCEEDED é entrega; READY/RUNNING/VERIFYING é trabalho aberto", () => {
    const v = montarView([
      chk("chk_1", "SUCCEEDED", "entregou A", "2026-09-01T00:00:00Z"),
      chk("chk_2", "RUNNING", "fazendo B", "2026-09-02T00:00:00Z"),
      chk("chk_3", "READY", "vai fazer C", "2026-09-03T00:00:00Z"),
    ]);
    expect(v.entregas.map((e) => e.id)).toEqual(["chk_1"]);
    expect(v.emCurso.map((e) => e.id).sort()).toEqual(["chk_2", "chk_3"]);
  });

  /**
   * FAILED fica em ABERTO de propósito. Contá-lo como entrega, ou omiti-lo, é
   * como trabalho reprovado desaparece do radar — foi o que aconteceu nesta
   * própria sessão com quatro verificações reprovadas.
   */
  it("FAILED conta como trabalho aberto, nunca como entrega nem silêncio", () => {
    const v = montarView([chk("chk_x", "FAILED", "reprovou", "2026-09-01T00:00:00Z")]);
    expect(v.entregas).toHaveLength(0);
    expect(v.emCurso).toHaveLength(1);
    expect(v.emCurso[0]?.texto).toContain("[FAILED]");
  });

  /**
   * A cadeia publica um record por TRANSIÇÃO com o mesmo statement. Sem dedupe,
   * uma tarefa que passou por READY→RUNNING→VERIFYING→SUCCEEDED apareceria
   * quatro vezes, e a contagem de entregas mentiria por um fator de quatro.
   */
  it("uma tarefa que atravessou a cadeia aparece UMA vez, no estado mais recente", () => {
    const v = montarView([
      chk("chk_a1", "READY", "a mesma tarefa", "2026-09-01T00:00:00Z"),
      chk("chk_a2", "RUNNING", "a mesma tarefa", "2026-09-01T01:00:00Z"),
      chk("chk_a3", "VERIFYING", "a mesma tarefa", "2026-09-01T02:00:00Z"),
      chk("chk_a4", "SUCCEEDED", "a mesma tarefa", "2026-09-01T03:00:00Z"),
    ]);
    expect(v.entregas).toHaveLength(1);
    expect(v.entregas[0]?.id, "o mais recente vence").toBe("chk_a4");
    expect(v.emCurso, "as transições anteriores não são trabalho aberto").toHaveLength(0);
  });

  it("o objetivo vem de global_goal — controle negativo do campo errado", () => {
    expect(montarView([estado({ global_goal: "a meta" })]).objetivo).toBe("a meta");
    expect(montarView([estado({ goal: "a meta" })]).objetivo, "`goal` não é o campo").toBe("");
  });

  it("estado, próxima ação, blocker e decisão pendente saem do project_state", () => {
    const v = montarView([
      estado({ current_state: "aqui", next_action: "depois", blocker: "travado", human_decision: "escolha" }),
    ]);
    expect([v.estado, v.proxima, v.blocker, v.decisaoPendente]).toEqual(["aqui", "depois", "travado", "escolha"]);
  });

  it("decisão revogada não entra nas ativas", () => {
    const viva = { id: "dec_1", family: "Decision", created_at: "2026-09-02T00:00:00Z", content: { title: "viva" } };
    const morta = {
      id: "dec_2",
      family: "Decision",
      created_at: "2026-09-01T00:00:00Z",
      content: { title: "morta", continuity: { status: "revoked" } },
    };
    const v = montarView([viva, morta] as unknown as CapsuleRecord[]);
    expect(v.decisoes.map((d) => d.id)).toEqual(["dec_1"]);
  });

  it("Store vazio devolve vista vazia, sem explodir e sem inventar", () => {
    const v = montarView([]);
    expect([v.objetivo, v.estado, v.proxima]).toEqual(["", "", ""]);
    expect([v.entregas.length, v.emCurso.length, v.decisoes.length]).toEqual([0, 0, 0]);
  });
});
