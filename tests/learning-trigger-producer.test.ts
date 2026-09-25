/**
 * `PRODUCER != SIGNATURE`.
 *
 * O gatilho automático escrevia pelo canal comum e saía carimbado
 * `nexos-memory-candidate`, indistinguível de escrita à mão. A única pista de
 * que ele havia agido era `content.origin_note`.
 *
 * CUSTO MEDIDO deste defeito, em 2026-09-18: três agentes contaram
 * `producer_id` no Store, não acharam nenhum registro do gatilho e concluíram
 * que o learning loop estava morto. Ele tinha produzido 3 candidatos, um deles
 * PROMOVIDO para memória real. Contar quem ASSINOU não conta quem CAUSOU
 * quando o canal de escrita é compartilhado.
 */
import { describe, it, expect } from "vitest";
import { buildMemoryCandidate } from "../src/lib/capsule/memory-candidate.js";
import { proposeFromOutcome } from "../src/lib/capsule/memory-promotion.js";
import type { ExecutionOutcome } from "../src/lib/capsule/memory-promotion.js";
import { LEARNING_TRIGGER_PRODUCER } from "../src/lib/learning-trigger.js";

const producerDe = (r: unknown): unknown =>
  ((r as { provenance?: Record<string, unknown> }).provenance ?? {})["producer_id"];

const entrada = {
  projectId: "prj_TESTE",
  fact: "um fato observado",
  originNote: "execução do nó chk_X",
  evidence: "comando que prova",
  proposedKind: "gotcha" as const,
  recordId: "knw_TESTE",
  observedAt: "2026-09-18T00:00:00.000Z",
};

const outcome = (): ExecutionOutcome => ({
  projectId: "prj_TESTE",
  nodeId: "chk_X",
  occurredAt: "2026-09-18T00:00:00.000Z",
  learned: [{ fact: "um fato observado", evidence: "prova", proposedKind: "gotcha", memoryScope: "project" }],
});

describe("learning-trigger · assinatura do produtor", () => {
  it("sem producerId, o default continua sendo a escrita à mão", () => {
    expect(producerDe(buildMemoryCandidate(entrada))).toBe("nexos-memory-candidate");
  });

  it("com producerId, o candidato carrega QUEM causou", () => {
    const r = buildMemoryCandidate({ ...entrada, producerId: LEARNING_TRIGGER_PRODUCER });
    expect(producerDe(r)).toBe("nexos-learning-trigger");
  });

  it("proposeFromOutcome repassa o produtor — é por aqui que o gatilho escreve", () => {
    const [r] = proposeFromOutcome(outcome(), () => "knw_A", LEARNING_TRIGGER_PRODUCER);
    expect(producerDe(r)).toBe("nexos-learning-trigger");
  });

  it("proposeFromOutcome SEM produtor não inventa assinatura", () => {
    const [r] = proposeFromOutcome(outcome(), () => "knw_B");
    expect(producerDe(r)).toBe("nexos-memory-candidate");
  });

  it("a assinatura é distinguível da escrita à mão — senão o campo não serve", () => {
    expect(LEARNING_TRIGGER_PRODUCER).not.toBe("nexos-memory-candidate");
  });
});
