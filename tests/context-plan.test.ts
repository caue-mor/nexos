/**
 * P3 — o ContextPlan.
 *
 * O que estes testes protegem: que o item que não coube deixe de virar um
 * número e passe a ser alcançável, sem que a lista de ponteiros coma o
 * orçamento do corpo.
 */
import { describe, expect, it } from "vitest";
import {
  POINTER_BUDGET_FRACTION,
  buildContextPlan,
  pointerBytes,
  pointersOf,
} from "../src/lib/context-plan.js";
import type { ContextPack, PackedItem } from "../src/lib/context-assembler.js";

const item = (over: Partial<PackedItem> = {}): PackedItem => ({
  // `id` identifica a revisão, `sourceRef` identifica a cabeça — tornou-se
  // obrigatório em 99c5774. Quem precisar de duas revisões distintas passa
  // `id` via `over`.
  id: "knw_01TEST0000000000000000000",
  sourceRef: "nexos://gotcha/x",
  family: "KnowledgeRecord",
  kind: "gotcha",
  title: "um gotcha",
  fields: {},
  bytes: 100,
  score: 1,
  why: "1 termo do intent: hook",
  matchedTerms: ["hook"],
  producerId: "nexos-cli:test",
  projectId: "prj_test",
  evidenceRefs: [],
  ...over,
});

const pack = (over: Partial<ContextPack> = {}): ContextPack => ({
  projectRoot: "/tmp/p",
  intent: "mexer no hook",
  budgetBytes: 8192,
  usedBytes: 0,
  items: [],
  omitted: [],
  anomalies: [],
  ...over,
});

describe("buildContextPlan — papéis", () => {
  it("project_state entra como ALWAYS, o resto como SELECTED", () => {
    const p = buildContextPlan(
      pack({
        items: [
          item({ kind: "project_state", sourceRef: "nexos://project-state", title: "estado" }),
          item({ kind: "gotcha" }),
        ],
      })
    );
    expect(p.fragments[0]?.role).toBe("ALWAYS");
    expect(p.fragments[1]?.role).toBe("SELECTED");
    expect(p.telemetry.counts.always).toBe(1);
    expect(p.telemetry.counts.selected).toBe(1);
  });

  it("o `why` do assembler é herdado, nunca reescrito", () => {
    const p = buildContextPlan(pack({ items: [item({ why: "razão original" })] }));
    expect(p.fragments[0]?.why).toBe("razão original");
  });

  it("não reordena — a ordem do assembler é a ordem de relevância", () => {
    const p = buildContextPlan(
      pack({ items: [item({ sourceRef: "a" }), item({ sourceRef: "b" }), item({ sourceRef: "c" })] })
    );
    expect(p.fragments.map((f) => f.sourceRef)).toEqual(["a", "b", "c"]);
  });
});

describe("ponteiros — o que não coube deixa de sumir", () => {
  it("omitido por BUDGET vira POINTER alcançável", () => {
    const p = buildContextPlan(
      pack({ omitted: [{ sourceRef: "nexos://gotcha/nao-coube", reason: "BUDGET" }] })
    );
    const ptrs = pointersOf(p);
    expect(ptrs).toHaveLength(1);
    expect(ptrs[0]?.sourceRef).toBe("nexos://gotcha/nao-coube");
  });

  it("omitido por NO_SIGNAL NÃO vira ponteiro — apontar o irrelevante é ruído", () => {
    const p = buildContextPlan(
      pack({ omitted: [{ sourceRef: "nexos://gotcha/sem-relacao", reason: "NO_SIGNAL" }] })
    );
    expect(pointersOf(p)).toHaveLength(0);
    expect(p.telemetry.counts.dropped).toBe(1);
  });

  it("ponteiro custa MUITO menos que o corpo", () => {
    const custo = pointerBytes("nexos://gotcha/x", "um gotcha");
    expect(custo).toBeLessThan(item().bytes);
  });

  it("a lista de ponteiros não engole o orçamento do corpo", () => {
    const muitos = Array.from({ length: 500 }, (_, i) => ({
      sourceRef: `nexos://gotcha/${i}-com-referencia-bem-longa-para-custar-bytes`,
      reason: "BUDGET" as const,
    }));
    const p = buildContextPlan(pack({ budgetBytes: 8192, omitted: muitos }));
    expect(p.telemetry.pointerBytes).toBeLessThanOrEqual(8192 * POINTER_BUDGET_FRACTION);
    expect(p.telemetry.counts.pointers).toBeLessThan(500);
  });

  it("o que passou do teto de ponteiros é CONTADO, não escondido", () => {
    const muitos = Array.from({ length: 500 }, (_, i) => ({
      sourceRef: `nexos://gotcha/${i}-com-referencia-bem-longa-para-custar-bytes`,
      reason: "BUDGET" as const,
    }));
    const p = buildContextPlan(pack({ budgetBytes: 8192, omitted: muitos }));
    expect(p.telemetry.counts.pointers + p.telemetry.counts.dropped).toBe(500);
  });
});

describe("telemetria — o orçamento foi para onde", () => {
  it("bytes por kind somam o corpo", () => {
    const p = buildContextPlan(
      pack({
        items: [
          item({ kind: "project_state", bytes: 300 }),
          item({ kind: "gotcha", bytes: 100 }),
          item({ kind: "gotcha", bytes: 50 }),
        ],
      })
    );
    expect(p.telemetry.bytesByKind["gotcha"]).toBe(150);
    expect(p.telemetry.bytesByKind["project_state"]).toBe(300);
    expect(p.telemetry.bodyBytes).toBe(450);
  });

  it("anomalias do Store continuam visíveis no plano", () => {
    const p = buildContextPlan(pack({ anomalies: [{ sourceRef: "x", state: "DIVERGED" }] }));
    expect(p.telemetry.counts.anomalies).toBe(1);
  });

  it("pack vazio produz plano vazio, sem inventar fragmento", () => {
    const p = buildContextPlan(pack());
    expect(p.fragments).toHaveLength(0);
    expect(p.telemetry.bodyBytes).toBe(0);
  });
});
