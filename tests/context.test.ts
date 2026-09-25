/**
 * `descrever` decide o RÓTULO de cada achado do `nexos context`.
 *
 * O teste existe por um defeito medido: a primeira versão lia `kind` de dentro
 * de `content`, mas ele mora no ENVELOPE. Resultado — todo gotcha do acervo
 * saía rotulado "KnowledgeRecord", a família em vez do que a coisa é, e a
 * camada L0 ("quanto existe") informava o tipo errado para 13 de 29 achados.
 *
 *   ENVELOPE FIELD != CONTENT FIELD
 */
import { describe, it, expect } from "vitest";
import { descrever } from "../src/commands/context.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const rec = (extra: Record<string, unknown>): CapsuleRecord => extra as unknown as CapsuleRecord;

describe("context · descrever", () => {
  it("gotcha é rotulado pelo kind do ENVELOPE, não pela família", () => {
    const d = descrever(rec({ family: "KnowledgeRecord", kind: "gotcha", content: { title: "T", rule: "R" } }));
    expect(d.tipo).toBe("gotcha");
    expect(d.titulo).toBe("T");
  });

  it("controle negativo: kind dentro de content NÃO conta — era o bug", () => {
    const d = descrever(rec({ family: "KnowledgeRecord", content: { kind: "gotcha", title: "T" } }));
    expect(d.tipo, "kind em content não pode ser lido como rótulo").not.toBe("gotcha");
  });

  it("Decision usa title + decision", () => {
    const d = descrever(rec({ family: "Decision", content: { title: "chave", decision: "a regra" } }));
    expect(d.tipo).toBe("decisão");
    expect(d.corpo).toBe("a regra");
  });

  it("Research usa question + findings", () => {
    const d = descrever(rec({ family: "Research", content: { question: "P?", findings: "achado" } }));
    expect(d.tipo).toBe("pesquisa");
    expect(d.titulo).toBe("P?");
    expect(d.corpo).toBe("achado");
  });

  it("kind desconhecido vira o próprio kind, não a família", () => {
    expect(descrever(rec({ family: "KnowledgeRecord", kind: "memory_candidate", content: {} })).tipo).toBe(
      "memory_candidate"
    );
  });

  it("sem kind nenhum cai para a família, sem explodir", () => {
    expect(descrever(rec({ family: "Decision", content: {} })).tipo).toBe("decisão");
    expect(descrever(rec({ family: "TaskMandate", content: {} })).tipo).toBe("TaskMandate");
  });
});
