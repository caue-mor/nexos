/**
 * C12.6 — Projection Audit V3, sobre CANONICAL SEMANTIC UNITS.
 *
 *   AUDITOR UNIT MUST MATCH PRODUCER UNIT
 *
 * O denominador é DERIVADO do que o producer emite, não herdado de uma contagem
 * anterior: um bloco legado pode produzir N records (split autorizado), e a
 * cobertura é verificada contra os records reais.
 *
 * Uso:  npx tsx scripts/c12-gotcha-projection-audit.ts
 */
import fs from "fs-extra";
import { parseGotchaMonolith } from "../src/lib/capsule/gotcha-parser.js";
import {
  mapearGotchaRecords,
  validarRecord,
  GOTCHA_SOURCE_FILE,
} from "../src/lib/capsule/gotcha-migrator.js";
import { splitDe } from "../src/lib/capsule/gotcha-split.js";
import { coberturaSemantica, type Classe } from "../src/lib/capsule/gotcha-coverage.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const OPTS = {
  projectId: "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR",
  now: "2026-08-14T12:00:00.000Z",
};

const rel = parseGotchaMonolith(await fs.readFile(GOTCHA_SOURCE_FILE, "utf8"));

if (rel.gotchas.length + rel.otherLegacy.length + rel.malformed.length !== rel.headingsSeen) {
  console.error("ABORTADO — o conjunto não fecha.");
  process.exit(1);
}

const refs = new Map<string, number>();
const porClasse = new Map<Classe, number>();
const naoProjetado = new Map<string, { n: number; tipo: string; amostra: string }>();

let unidadesSemanticas = 0;
let recordsProduzidos = 0;
let splits = 0;
let invalidos = 0;
let unidadesFonte = 0;

for (const b of rel.gotchas) {
  if (splitDe(b.legacyId, b.title)) splits++;

  let records: CapsuleRecord[];
  try {
    records = mapearGotchaRecords(b, OPTS);
  } catch (e) {
    console.error(`  PRODUCER FALHOU ${b.legacyId}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  recordsProduzidos += records.length;
  for (const r of records) {
    unidadesSemanticas++;
    if (!validarRecord(r).ok) invalidos++;
    const ref = (r as { provenance: { source_ref: string } }).provenance.source_ref;
    refs.set(ref, (refs.get(ref) ?? 0) + 1);
  }

  /** Cobertura verificada contra os records REAIS deste bloco. */
  for (const u of coberturaSemantica(b, records)) {
    unidadesFonte++;
    porClasse.set(u.classe, (porClasse.get(u.classe) ?? 0) + 1);
    if (u.classe === "REAL_UNACCOUNTED") {
      const chave = `${u.tipo}:${u.nome}`;
      const atual = naoProjetado.get(chave);
      if (atual) atual.n++;
      else naoProjetado.set(chave, { n: 1, tipo: u.tipo, amostra: u.amostra });
    }
  }
}

const duplicados = [...refs.entries()].filter(([, n]) => n > 1);

/**
 * Ordem de relato: projetado → preservado → metadado → bloqueio. O denominador
 * é derivado da fonte; a soma tem que fechar contra ele.
 */
const ORDEM: readonly Classe[] = [
  "CANONICAL_TRUTH",
  "CANONICAL_EVIDENCE",
  "PRESERVED_NONPROJECTED_V1",
  "PRESERVED_SOURCE_HISTORY",
  "PRESERVED_DOCUMENTATION_RATIONALE",
  "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
  "SOURCE_METADATA",
  "SOURCE_TAXONOMY_METADATA",
  "LEGACY_OPERATIONAL_STATE",
  "EVIDENCE_REQUIRES_DESTINATION",
  "INTENTIONALLY_NONCANONICAL",
  "DUPLICATE_ALIAS",
  "REAL_UNACCOUNTED",
];

console.log(`── IDENTIDADE ──`);
console.log(`  legacy_blocks              ${rel.gotchas.length}`);
console.log(`  split_blocks               ${splits}`);
console.log(`  canonical_semantic_units   ${unidadesSemanticas}`);
console.log(`  records_produzidos         ${recordsProduzidos}`);
console.log(`  source_refs distintos      ${refs.size}`);
console.log(`  duplicidades               ${duplicados.length}`);
console.log(`  invalidos                  ${invalidos}`);
console.log(`  sem reconciliação          ${[...refs.keys()].filter((r) => !r).length}`);
console.log(`  outros_legados             ${rel.otherLegacy.length} (${rel.otherLegacy.map((o) => o.legacyId).join(", ")})`);

console.log(`\n── COBERTURA DE CONTEÚDO (unidades da fonte: ${unidadesFonte}) ──`);
let soma = 0;
for (const classe of ORDEM) {
  const n = porClasse.get(classe) ?? 0;
  if (n === 0) continue;
  console.log(`  ${String(n).padStart(4)}  ${classe}`);
  soma += n;
}
/** Classe fora de ORDEM é defeito do relator, não zero. Nunca somir em silêncio. */
for (const [classe, n] of porClasse.entries()) {
  if (ORDEM.includes(classe)) continue;
  console.log(`  ${String(n).padStart(4)}  ${classe}   ⚠ FORA DA ORDEM DE RELATO`);
  soma += n;
}
console.log(`  ${String(soma).padStart(4)}  TOTAL   ${soma === unidadesFonte ? "✓ fecha" : "✗ NÃO FECHA"}`);

const projected = (porClasse.get("CANONICAL_TRUTH") ?? 0) + (porClasse.get("CANONICAL_EVIDENCE") ?? 0);
const preservado = ORDEM.filter((c) => c.startsWith("PRESERVED_")).reduce(
  (a, c) => a + (porClasse.get(c) ?? 0),
  0
);
const realUnaccounted = porClasse.get("REAL_UNACCOUNTED") ?? 0;

console.log(`\n  PROJECTED                  ${projected}`);
console.log(`  PRESERVED (4 classes)      ${preservado}`);
console.log(`  outras classificações      ${unidadesFonte - projected - preservado - realUnaccounted}`);
console.log(`  REAL_UNACCOUNTED           ${realUnaccounted}`);

if (naoProjetado.size > 0) {
  console.log(`\n── REAL_UNACCOUNTED, agrupado (${naoProjetado.size} distintos) ──`);
  for (const [chave, v] of [...naoProjetado.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(v.n).padStart(3)}  ${chave.slice(0, 56).padEnd(56)} ${v.amostra.slice(0, 46)}`);
  }
}

if (duplicados.length > 0) {
  console.log(`\n── SOURCE_REFS DUPLICADOS ──`);
  for (const [ref, n] of duplicados) console.log(`  ${n}x  ${ref}`);
  process.exit(2);
}

/**
 * O gate semântico de C12.6. `UNRESOLVED = 0` era o critério errado — misturava
 * conteúdo perdido com conteúdo conscientemente preservado.
 *
 *   SEMANTIC ACCOUNTING CLOSED != LEGACY RETIREMENT SAFE
 */
if (soma !== unidadesFonte) {
  console.error(`\n✗ ACCOUNTING NÃO FECHA — ${soma} classificadas vs ${unidadesFonte} da fonte`);
  process.exit(3);
}
if (realUnaccounted > 0) {
  console.error(`\n✗ BLOQUEIO C12.6 — REAL_UNACCOUNTED = ${realUnaccounted}`);
  process.exit(4);
}
console.log(`\n✓ SEMANTIC ACCOUNTING CLOSED — REAL_UNACCOUNTED = 0`);
