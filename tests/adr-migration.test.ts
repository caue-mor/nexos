/**
 * C12.5 — migração de ADRs. A1..A9, com os 4 contrafactuais obrigatórios.
 *
 * ```
 * ULID É A IDENTIDADE ATRIBUÍDA · source_ref É A CHAVE DE RECONCILIAÇÃO
 * PARSE COMPLETE != PUBLISH EVERYTHING
 * NO RECORD != EMPTY RECORD
 * ```
 *
 * Nenhum teste escreve na origem nem no `.nexos` do projeto.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { parseAdrMonolith, selecionarBatch } from "../src/lib/capsule/adr-parser.js";
import { mapearAdr, validarRecord, sourceRefDe, legacyIdsJaMigrados } from "../src/lib/capsule/adr-migrator.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { initializeForReconciliation } from "../src/lib/capsule/migration-classifier.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const MONOLITO = [
  "# Decisions",
  "",
  "## ADR-001: Primeira decisão",
  "- **Contexto**: precisava escolher algo",
  "- **Decisão**: escolhemos A",
  "- **Consequência**: B fica de fora",
  "",
  "## ADR-002: Segunda decisão",
  "- **Contexto**: outro problema",
  "- **Decisão**: escolhemos C",
  "",
].join("\n");

const OPTS = { projectId: "prj_teste", now: "2026-08-14T00:00:00Z" };

describe("C12.5 · parser do monolito", () => {
  it("A1 parseia os dois ADRs e o conjunto FECHA", () => {
    const r = parseAdrMonolith(MONOLITO);
    expect(r.parsed).toHaveLength(2);
    expect(r.headingsSeen).toBe(2);
    expect(r.malformed).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.parsed.length + r.malformed.length).toBe(r.headingsSeen);
  });

  it("A2 detecta ID duplicado — nunca publica em cima", () => {
    const r = parseAdrMonolith(`${MONOLITO}\n## ADR-001: repetido\ncorpo\n`);
    expect(r.duplicates).toEqual(["ADR-001"]);
  });

  it("A3 detecta gap na sequência — buraco é fato, não erro", () => {
    const r = parseAdrMonolith("## ADR-001: a\nx\n\n## ADR-004: b\ny\n");
    expect(r.gaps).toEqual([2, 3]);
  });

  it("A4 CONTRAFATUAL — cabeçalho corrompido vira `malformed`, não some", () => {
    // casa a família mas não o formato: sem `:` e com colchete
    const r = parseAdrMonolith("## [ADR-009] sem dois pontos\ncorpo\n");
    expect(r.parsed).toHaveLength(0);
    expect(r.malformed).toHaveLength(1);
    expect(r.headingsSeen).toBe(1);
    // e o conjunto ainda fecha — FAILED PARSE é issue explícito
    expect(r.parsed.length + r.malformed.length).toBe(r.headingsSeen);
  });

  it("A5 seleção é por IDENTIDADE, não por posição no arquivo", () => {
    const invertido = parseAdrMonolith(
      "## ADR-002: segunda\nx\n\n## ADR-001: primeira\ny\n"
    );
    expect(selecionarBatch(invertido.parsed, 1, new Set()).map((a) => a.legacyId)).toEqual(["ADR-001"]);
    // já migrado sai da seleção
    expect(selecionarBatch(invertido.parsed, 1, new Set(["ADR-001"])).map((a) => a.legacyId)).toEqual(["ADR-002"]);
  });
});

describe("C12.5 · mapeamento", () => {
  it("A6 campo ausente na fonte fica AUSENTE no record — nunca texto de migração", () => {
    // Este teste afirmava o oposto até 14/08: exigia `consequences[0]` contendo
    // "não registrou". Era o GOTCHA-044 codificado como expectativa — eu tinha
    // escrito a frase E o teste que a validava.
    //   ABSENCE = FIELD ABSENT · TRUTH RECORD != MIGRATION COMMENT
    const [, adr2] = parseAdrMonolith(MONOLITO).parsed;
    const r = mapearAdr(adr2!, OPTS) as CapsuleRecord & {
      content: { consequences?: string[]; decision?: string };
    };

    expect(validarRecord(r).ok).toBe(true);
    expect(r.content.consequences).toBeUndefined(); // ausente, não frase
    expect(JSON.stringify(r)).not.toContain("não registrou");
    expect(r.content.decision).toBeDefined(); // e o que existe na fonte sobrevive
  });

  it("A7 source_ref deriva da identidade semântica, e o corpo do monolito NÃO entra inteiro", () => {
    const [adr1] = parseAdrMonolith(MONOLITO).parsed;
    const r = mapearAdr(adr1!, OPTS);
    expect(r.provenance.source_ref).toBe(sourceRefDe("ADR-001"));
    expect(r.provenance.source_ref).not.toContain("linha");
    expect(JSON.stringify(r)).not.toContain("# Decisions"); // TRUTH RECORD != EVIDENCE ARTIFACT
  });

  it("A8 CONTRAFATUAL — record sem NENHUM dos três é RECUSADO antes de publicar", () => {
    // Até 14/08 este teste removia só `decision` e exigia recusa, porque os três
    // eram obrigatórios — e era essa obrigatoriedade que forçava o migrador a
    // inventar texto (GOTCHA-044). Agora os três são opcionais, e o que o
    // refinement impede é o outro extremo: um Decision sem decisão nenhuma.
    const [adr1] = parseAdrMonolith(MONOLITO).parsed;
    const base = mapearAdr(adr1!, OPTS) as unknown as Record<string, unknown>;

    // remover UM continua válido — a ausência é legítima
    const semDecision = { ...base, content: { ...(base.content as object), decision: undefined } };
    delete (semDecision.content as Record<string, unknown>).decision;
    expect(validarRecord(semDecision as CapsuleRecord).ok).toBe(true);

    // remover os TRÊS não é decisão nenhuma
    const vazio = { ...base, content: { title: "só título" } };
    const v = validarRecord(vazio as CapsuleRecord);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/ao menos um|context|decision|consequences/);
  });
});

describe("C12.5 · publicação e reconciliação", () => {
  it("A9 CONTRAFATUAL — republicar o MESMO record não cria duplicata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-adr-"));
    await fs.ensureDir(path.join(root, ".nexos", "memory"));
    const init = await initializeForReconciliation(root, { projectName: "teste" });

    const [adr1] = parseAdrMonolith(MONOLITO).parsed;
    const record = mapearAdr(adr1!, { ...OPTS, projectId: init.projectId });

    expect((await publishCanonical(root, record)).outcome).toBe("CREATED");
    expect((await publishCanonical(root, record)).outcome).toBe("ALREADY_PUBLISHED");

    const dir = path.join(root, ".nexos", "records", "decisions");
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".yaml"))).toHaveLength(1);

    // e a reconciliação por procedência reconhece o item legado
    expect(await legacyIdsJaMigrados(root)).toEqual(new Set(["ADR-001"]));

    await fs.remove(root);
  });

  it("A10 CONTRAFATUAL — fontes diferentes NÃO colidem na mesma identidade", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-adr2-"));
    await fs.ensureDir(path.join(root, ".nexos", "memory"));
    const init = await initializeForReconciliation(root, { projectName: "teste" });

    const [adr1, adr2] = parseAdrMonolith(MONOLITO).parsed;
    const r1 = mapearAdr(adr1!, { ...OPTS, projectId: init.projectId });
    const r2 = mapearAdr(adr2!, { ...OPTS, projectId: init.projectId });

    expect(r1.id).not.toBe(r2.id);
    expect(r1.provenance.source_ref).not.toBe(r2.provenance.source_ref);
    expect((await publishCanonical(root, r1)).outcome).toBe("CREATED");
    expect((await publishCanonical(root, r2)).outcome).toBe("CREATED");

    expect(await legacyIdsJaMigrados(root)).toEqual(new Set(["ADR-001", "ADR-002"]));
    await fs.remove(root);
  });
});
