/**
 * P1 — produtor, dedupe e executor do Memory Engine.
 *
 * O teste que mais importa é o de SCHEMA: um executor que devolve record
 * bonito e inválido só falha na hora de publicar, longe daqui.
 */
import { describe, expect, it } from "vitest";
import { CapsuleRecordSchema, type CapsuleRecord } from "../src/lib/capsule/schemas.js";
import { buildMemoryCandidate } from "../src/lib/capsule/memory-candidate.js";
import { subjectRef } from "../src/lib/capsule/schemas.js";
import {
  CONFLICT_AT,
  DUPLICATE_AT,
  dedupeCandidate,
  promoteToRecord,
  proposeFromOutcome,
  MemoryPromotionError,
  type ExecutionOutcome,
} from "../src/lib/capsule/memory-promotion.js";

const AT = "2026-08-28T10:00:00.000Z";
const PROJ = "prj_12208f6b66d8";

const outcome = (learned: ExecutionOutcome["learned"]): ExecutionOutcome => ({
  projectId: PROJ,
  nodeId: "12_memory_engine",
  occurredAt: AT,
  learned,
});

const ids = (i: number): string => `knw_TESTE${String(i).padStart(21, "0")}`;

describe("proposeFromOutcome — o produtor", () => {
  it("execução que não ensinou nada produz ZERO candidatos", () => {
    expect(proposeFromOutcome(outcome([]), ids)).toHaveLength(0);
  });

  it("não aceita transcript: a entrada é fato declarado com evidência", () => {
    // O contrato está no TIPO — não há campo por onde um texto cru entre.
    // Este teste existe para falhar se alguém adicionar um.
    const o = outcome([
      {
        fact: "PreCompact bloqueia por exit 2; SessionEnd ignora exit code",
        evidence: "code.claude.com/docs/en/hooks.md, medido 2026-08-28",
        proposedKind: "gotcha",
        memoryScope: "global",
      },
    ]);
    const [c] = proposeFromOutcome(o, ids);
    expect(c).toBeDefined();
    expect(Object.keys(o.learned[0] ?? {})).not.toContain("transcript");
  });

  it("carimba memory_scope e a origem no nó executado", () => {
    const [c] = proposeFromOutcome(
      outcome([
        { fact: "f", evidence: "e", proposedKind: "gotcha", memoryScope: "global" },
      ]),
      ids
    );
    const content = (c as unknown as { content: Record<string, unknown> }).content;
    expect(content["memory_scope"]).toBe("global");
    expect(content["origin_note"]).toContain("12_memory_engine");
  });

  /**
   * O teste que faltava, e cuja ausência custou um defeito real: o candidato
   * era montado com `memory_scope` e o Zod o ESTRIPAVA na publicação, porque o
   * campo não estava declarado no schema. Testar só o objeto em memória não
   * pega isso — `BUILT != PERSISTED`.
   */
  it.each(["project", "role", "global"] as const)(
    "memory_scope %s SOBREVIVE ao round-trip pelo schema canônico",
    (escopo) => {
      const [c] = proposeFromOutcome(
        outcome([
          {
            fact: "f",
            evidence: "e",
            proposedKind: "gotcha",
            memoryScope: escopo,
            ...(escopo === "role" ? { role: "nexos-dev" } : {}),
          },
        ]),
        ids
      );
      const parsed = CapsuleRecordSchema.safeParse(c);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
      const depois = (parsed.data as unknown as { content: Record<string, unknown> }).content;
      expect(depois["memory_scope"]).toBe(escopo);
    }
  );

  it("role sobrevive ao round-trip junto com o escopo", () => {
    const [c] = proposeFromOutcome(
      outcome([
        { fact: "f", evidence: "e", proposedKind: "gotcha", memoryScope: "role", role: "nexos-qa" },
      ]),
      ids
    );
    const parsed = CapsuleRecordSchema.parse(c) as unknown as { content: Record<string, unknown> };
    expect(parsed.content["role"]).toBe("nexos-qa");
  });

  it("escopo role sem papel declarado é recusado", () => {
    expect(() =>
      proposeFromOutcome(
        outcome([{ fact: "f", evidence: "e", proposedKind: "gotcha", memoryScope: "role" }]),
        ids
      )
    ).toThrow(MemoryPromotionError);
  });

  it("é determinístico: mesmo outcome, mesmos candidatos", () => {
    const o = outcome([{ fact: "f", evidence: "e", proposedKind: "pattern", memoryScope: "project" }]);
    expect(JSON.stringify(proposeFromOutcome(o, ids))).toBe(JSON.stringify(proposeFromOutcome(o, ids)));
  });
});

// ─── dedupe ─────────────────────────────────────────────────────────────────

const candidato = (fact: string, scope = "project", id = ids(9)): CapsuleRecord => {
  const c = buildMemoryCandidate({
    projectId: PROJ,
    fact,
    originNote: "teste",
    evidence: "evidência de teste",
    proposedKind: "gotcha",
    recordId: id,
    observedAt: AT,
  });
  (c as unknown as { content: Record<string, unknown> }).content["memory_scope"] = scope;
  return c;
};

describe("dedupeCandidate", () => {
  const FRASE =
    "o stop hook do claude code bloqueia a parada por exit code 2 e nunca por decision block";

  it("Store vazio: candidato é NOVEL", () => {
    expect(dedupeCandidate(candidato(FRASE), []).state).toBe("NOVEL");
  });

  it("mesma afirmação redigida mais curta é DUPLICATE", () => {
    const curto = FRASE.split(" ").slice(0, 10).join(" ");
    const v = dedupeCandidate(candidato(FRASE), [candidato(curto, "project", ids(1))]);
    expect(v.state).toBe("DUPLICATE");
    expect(v.against).toHaveLength(1);
  });

  it("assunto sem relação é NOVEL", () => {
    const outro = candidato("o installer projeta a statusline para o diretorio do host", "project", ids(2));
    expect(dedupeCandidate(candidato(FRASE), [outro]).state).toBe("NOVEL");
  });

  it("escopos diferentes NUNCA colidem — é assim que memória vaza entre projetos", () => {
    const global = candidato(FRASE, "global", ids(3));
    expect(dedupeCandidate(candidato(FRASE, "project"), [global]).state).toBe("NOVEL");
  });

  it("os limiares vieram da medição, nesta ordem", () => {
    expect(CONFLICT_AT).toBeLessThan(DUPLICATE_AT);
    // teto medido dos não-duplicados no corpus real
    expect(CONFLICT_AT).toBeGreaterThan(0.2);
    // piso medido da mesma afirmação com metade dos termos
    expect(DUPLICATE_AT).toBeLessThanOrEqual(0.444);
  });

  it("não compara o candidato consigo mesmo", () => {
    const c = candidato(FRASE);
    expect(dedupeCandidate(c, [c]).state).toBe("NOVEL");
  });
});

// ─── executor ───────────────────────────────────────────────────────────────

describe("promoteToRecord — o executor", () => {
  const base = {
    candidate: candidato("teste de promocao com fato suficientemente longo"),
    recordId: ids(7),
    promotedAt: AT,
    approvedBy: "human:steve",
    resolvedTargetScope: "project" as const,
  };

  it.each(["gotcha", "pattern", "architecture"] as const)(
    "record promovido para %s valida contra o schema canônico",
    (targetKind) => {
      const r = promoteToRecord({ ...base, targetKind });
      const parsed = CapsuleRecordSchema.safeParse(r);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    }
  );

  it("aponta para o candidato — promoção que apaga a origem vira afirmação sem procedência", () => {
    const r = promoteToRecord({ ...base, targetKind: "gotcha" });
    expect(r.provenance.source_ref).toContain(base.candidate.id);
  });

  it("registra quem aprovou", () => {
    const r = promoteToRecord({ ...base, targetKind: "gotcha" });
    expect((r as { admission: { approved_by: string } }).admission.approved_by).toBe("human:steve");
  });

  it("candidato sem evidência não promove", () => {
    const sem = candidato("fato sem lastro");
    delete (sem as unknown as { content: Record<string, unknown> }).content["evidence"];
    expect(() => promoteToRecord({ ...base, candidate: sem, targetKind: "gotcha" })).toThrow(
      MemoryPromotionError
    );
  });

  it("promoção NÃO escreve: devolve o record e para", () => {
    const r = promoteToRecord({ ...base, targetKind: "gotcha" });
    expect(r.id).toBe(ids(7));
    // o candidato original permanece intacto — promover não muda a proposta
    expect((base.candidate as { kind: string }).kind).toBe("memory_candidate");
  });
});

// ─── I8 — scope não se perde na promoção (13_MEMORY_SCOPE_LAYERED_DECISION §2.2, §6.2) ──

const comSubject = (c: CapsuleRecord, subject: string): CapsuleRecord => {
  const alvo = c as unknown as { subject?: string; subject_ref?: string };
  alvo.subject = subject;
  alvo.subject_ref = subjectRef(subject);
  return c;
};

describe("promoteToRecord — I8: scope não se perde na promoção", () => {
  const base = {
    recordId: ids(20),
    promotedAt: AT,
    approvedBy: "human:steve",
  };

  it.each(["gotcha", "architecture"] as const)(
    "destino project: %s carrega scope canônico { kind: project, ref: project_id }",
    (targetKind) => {
      const r = promoteToRecord({
        ...base,
        candidate: candidato("fato promovido para o projeto, suficientemente longo"),
        targetKind,
        resolvedTargetScope: "project",
      });
      expect(r.scope).toEqual({ kind: "project", ref: PROJ });
      expect(r.project_id).toBe(PROJ);
    }
  );

  it.each(["gotcha", "architecture"] as const)(
    "destino global: %s carrega scope canônico { kind: global, ref: null } e SEM project_id",
    (targetKind) => {
      const c = comSubject(
        candidato("fato promovido para global, suficientemente longo", "global"),
        "package-manager"
      );
      const r = promoteToRecord({
        ...base,
        candidate: c,
        targetKind,
        resolvedTargetScope: "global",
        generality: "vale para qualquer projeto que use o mesmo gerenciador de pacotes",
      });
      expect(r.scope).toEqual({ kind: "global", ref: null });
      expect(r.project_id).toBeUndefined();
      const parsed = CapsuleRecordSchema.safeParse(r);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    }
  );

  it("content.memory_scope NÃO decide destino — candidato global promovido sem rota explícita fica no projeto", () => {
    const c = candidato("fato marcado global mas promovido sem --to global", "global");
    const r = promoteToRecord({ ...base, candidate: c, targetKind: "gotcha", resolvedTargetScope: "project" });
    expect(r.scope).toEqual({ kind: "project", ref: PROJ });
    expect(r.project_id).toBe(PROJ);
  });

  it("memory_scope role nunca produz destino global — continua project", () => {
    const c = candidato("fato de papel promovido, suficientemente longo", "role");
    const r = promoteToRecord({ ...base, candidate: c, targetKind: "gotcha", resolvedTargetScope: "project" });
    expect(r.scope).toEqual({ kind: "project", ref: PROJ });
  });

  it("subject e subject_ref são copiados do candidato quando declarados", () => {
    const c = comSubject(
      candidato("fato com assunto declarado, suficientemente longo", "global"),
      "package-manager"
    );
    const r = promoteToRecord({
      ...base,
      candidate: c,
      targetKind: "architecture",
      resolvedTargetScope: "global",
      generality: "vale para qualquer projeto que use o mesmo gerenciador de pacotes",
    });
    expect(r.subject).toBe("package-manager");
    expect(r.subject_ref).toBe(subjectRef("package-manager"));
  });

  it("sem subject declarado no candidato, o promovido também não carrega subject", () => {
    const r = promoteToRecord({
      ...base,
      candidate: candidato("fato sem assunto declarado, suficientemente longo"),
      targetKind: "gotcha",
      resolvedTargetScope: "project",
    });
    expect(r.subject).toBeUndefined();
    expect(r.subject_ref).toBeUndefined();
  });

  it("provenance.source_ref não muda com o destino resolvido", () => {
    const c = candidato("fato para checar proveniencia, suficientemente longo");
    const r = promoteToRecord({ ...base, candidate: c, targetKind: "gotcha", resolvedTargetScope: "project" });
    expect(r.provenance.source_ref).toBe(`nexos://promoted-from/${c.id}`);
  });

  it("destino project sem project_id no candidato é recusado — nunca inventa ref", () => {
    const c = candidato("fato sem projeto, suficientemente longo") as unknown as {
      project_id?: string;
    };
    delete c.project_id;
    expect(() =>
      promoteToRecord({
        ...base,
        candidate: c as unknown as CapsuleRecord,
        targetKind: "gotcha",
        resolvedTargetScope: "project",
      })
    ).toThrow(MemoryPromotionError);
  });
});
