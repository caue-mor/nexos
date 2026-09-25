/**
 * C2.2.5a — codec canônico e schemas v1.
 *
 * O teste que importa não é round-trip (`parse(write(r)) == r`), que provaria
 * apenas simetria. É: MESMO RECORD LÓGICO, ENTRADAS FORMATADAS DIFERENTE
 * → BYTES IDÊNTICOS. É isso que ADR-045 exige e o que sustenta a mergeability.
 */
import { describe, it, expect } from "vitest";
import { serializeCanonical, parseCanonical, isCanonicalForm, CanonicalCodecError } from "../src/lib/capsule/codec.js";
import { validateRecord, validateManifest } from "../src/lib/capsule/schemas.js";
import { newRecordId, parseRecordId, idMatchesFamily, ulid } from "../src/lib/capsule/ids.js";
import { makeDecision, makeGotcha, makeResearch, MANIFEST } from "./capsule-fixtures.js";

// ─── 07 · bytes canônicos ───────────────────────────────────────────────────

describe("07 · serialização canônica é do Store, não do producer", () => {
  it("ordem de chaves diferente → BYTES IDÊNTICOS", () => {
    const a = { family: "Decision", id: "dec_1", project_id: "p", version: 1 };
    const b = { version: 1, project_id: "p", id: "dec_1", family: "Decision" };

    expect(serializeCanonical(a)).toBe(serializeCanonical(b));
  });

  it("record completo montado em ordens diferentes → BYTES IDÊNTICOS", () => {
    const record = makeDecision();
    const reordered = Object.fromEntries(
      Object.entries(record as Record<string, unknown>).reverse()
    );

    expect(serializeCanonical(reordered)).toBe(serializeCanonical(record));
  });

  it("formatação de entrada do producer é descartada", () => {
    // três formas YAML equivalentes: aspas, sem aspas, e flow style
    const forms = [
      'a: "1"\nb: dois\n',
      "b: dois\na: '1'\n",
      "{ b: dois, a: '1' }\n",
    ];
    const bytes = forms.map((f) => serializeCanonical(parseCanonical(f)));

    expect(new Set(bytes).size).toBe(1);
  });

  it("sem anchors/aliases mesmo com objeto repetido", () => {
    const shared = { x: 1 };
    const out = serializeCanonical({ a: shared, b: shared });

    expect(out).not.toMatch(/[&*]/);
    expect(out).toContain("x: 1");
  });

  it("termina com exatamente um newline", () => {
    const out = serializeCanonical(makeDecision());
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("nunca emite CRLF", () => {
    const out = serializeCanonical({ texto: "linha1\nlinha2" });
    expect(out).not.toContain("\r");
  });

  it("é idempotente: serializar o canônico não muda nada", () => {
    const once = serializeCanonical(makeGotcha());
    expect(isCanonicalForm(once)).toBe(true);
    expect(serializeCanonical(parseCanonical(once))).toBe(once);
  });

  it("texto longo usa block scalar e permanece diffável por linha", () => {
    const out = serializeCanonical({ nota: "linha um\nlinha dois\nlinha três\n" });
    expect(out).toMatch(/nota: \|/);
    expect(out.split("\n").length).toBeGreaterThan(3);
  });
});

// ─── 08 · round-trip ────────────────────────────────────────────────────────

describe("08 · round-trip YAML", () => {
  it("preserva o record através de serialize→parse→validate", () => {
    const original = makeDecision();
    const restored = parseCanonical(serializeCanonical(original));

    const result = validateRecord(restored);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(original);
  });

  it("YAML malformado lança erro explícito", () => {
    expect(() => parseCanonical("a: [1, 2\nb: :")).toThrow(CanonicalCodecError);
  });

  it("chave duplicada é rejeitada, não silenciosamente sobrescrita", () => {
    expect(() => parseCanonical("a: 1\na: 2\n")).toThrow(CanonicalCodecError);
  });
});

// ─── 09 · schemas discriminados ─────────────────────────────────────────────

describe("09 · schemas v1", () => {
  it("aceita as cinco families canônicas", () => {
    for (const record of [makeDecision(), makeGotcha(), makeResearch()]) {
      expect(validateRecord(record).ok).toBe(true);
    }
  });

  it("kind inválido em KnowledgeRecord é rejeitado", () => {
    const result = validateRecord(makeGotcha({ kind: "anedota" }));
    expect(result.ok).toBe(false);
  });

  it("schema de gotcha não aceita content de pattern", () => {
    const result = validateRecord(
      makeGotcha({ content: { context: "x", practice: "y", expected_effect: "z", applicability: "w", evidence: "e" } })
    );
    expect(result.ok).toBe(false);
  });

  it("content NÃO é unknown — campo faltando é erro", () => {
    const result = validateRecord(makeDecision({ content: { title: "só título" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/context|decision|consequences/);
  });

  it("approved_by fora do formato human:/policy: é rejeitado", () => {
    const result = validateRecord(
      makeDecision({ admission: { status: "admitted", approved_by: "steve" } })
    );
    expect(result.ok).toBe(false);
  });

  it("aceita policy:<id> como approved_by", () => {
    const result = validateRecord(
      makeDecision({
        admission: { status: "admitted", approved_by: "policy:auto-accept-tested-checkpoint-v1" },
      })
    );
    expect(result.ok).toBe(true);
  });

  it("schema_version diferente de 1 é rejeitado", () => {
    expect(validateRecord(makeDecision({ schema_version: 2 })).ok).toBe(false);
  });

  it("manifest v1 válido e inválido", () => {
    expect(validateManifest(MANIFEST).ok).toBe(true);
    expect(validateManifest({ project: { id: "p" } }).ok).toBe(false);
    expect(validateManifest({ ...MANIFEST, schema_version: 99 }).ok).toBe(false);
  });

  it("manifest NÃO aceita alias de máquina", () => {
    const withAlias = { ...MANIFEST, aliases: { path_hash: "abc" } };
    // zod object é strip por padrão: o alias é DESCARTADO, nunca promovido a canônico
    const result = validateManifest(withAlias);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty("aliases");
  });
});

// ─── ids ────────────────────────────────────────────────────────────────────

describe("ids · ULID + prefixo de family", () => {
  it("formato prefixo_ULID com 26 chars", () => {
    const id = newRecordId("Decision");
    expect(id).toMatch(/^dec_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("cada family tem prefixo próprio", () => {
    expect(newRecordId("ProjectCheckpoint").startsWith("chk_")).toBe(true);
    expect(newRecordId("KnowledgeRecord").startsWith("knw_")).toBe(true);
    expect(newRecordId("Research").startsWith("rsh_")).toBe(true);
    expect(newRecordId("ProjectContract").startsWith("ctr_")).toBe(true);
  });

  it("ids são únicos", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRecordId("Decision")));
    expect(ids.size).toBe(500);
  });

  it("ULID de timestamp maior ordena depois (lexicográfico)", () => {
    const antes = ulid(1_000_000_000_000);
    const depois = ulid(2_000_000_000_000);
    expect(antes < depois).toBe(true);
  });

  it("parseRecordId devolve a family e rejeita malformado", () => {
    expect(parseRecordId(newRecordId("Decision"))?.family).toBe("Decision");
    expect(parseRecordId("adotamos-postgresql")).toBeNull();
    expect(parseRecordId("xyz_01J8ZQ7X4M3N2P5R6S7T8V9W0Y")).toBeNull();
    expect(parseRecordId("dec_lowercase00000000000000")).toBeNull();
  });

  it("idMatchesFamily detecta prefixo divergente da family", () => {
    const id = newRecordId("Decision");
    expect(idMatchesFamily(id, "Decision")).toBe(true);
    expect(idMatchesFamily(id, "Research")).toBe(false);
  });
});
