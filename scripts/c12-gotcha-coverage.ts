/**
 * C12.6 — cobertura da classe GOTCHA e contabilidade de conteúdo.
 *
 * Responde duas perguntas que `head count` não responde:
 *
 *   quantos blocos são REPRESENTÁVEIS pelo schema (e quais não são, e por quê)
 *   para cada rótulo da fonte: representado canonicamente, ou não projetado
 *
 *   HEAD COUNT != CONTENT COVERAGE
 *
 * Nada é publicado. Mede e reporta.
 *
 * Uso:  npx tsx scripts/c12-gotcha-coverage.ts
 */
import fs from "fs-extra";
import { parseGotchaMonolith } from "../src/lib/capsule/gotcha-parser.js";
import {
  mapearGotcha,
  validarRecord,
  sourceRefDe,
  GOTCHA_SOURCE_FILE,
} from "../src/lib/capsule/gotcha-migrator.js";
import { LABEL_MAP, DATE_LABELS } from "../src/lib/capsule/gotcha-labels.js";

const OPTS = {
  projectId: "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR",
  now: "2026-08-14T12:00:00.000Z",
};

const rel = parseGotchaMonolith(await fs.readFile(GOTCHA_SOURCE_FILE, "utf8"));

if (rel.gotchas.length + rel.otherLegacy.length + rel.malformed.length !== rel.headingsSeen) {
  console.error("ABORTADO — o conjunto não fecha.");
  process.exit(1);
}

const representaveis: string[] = [];
const naoRepresentaveis: Array<{ id: string; line: number; labels: string[]; erro: string }> = [];
const refs = new Set<string>();

const pendentes: string[] = [];

for (const b of rel.gotchas) {
  let record;
  try {
    record = mapearGotcha(b, OPTS);
  } catch (e) {
    /** Bloqueado por curadoria humana — não é falha, é decisão pendente. */
    if (e instanceof Error && e.name === "CuradoriaPendenteError") {
      pendentes.push(b.legacyId);
      continue;
    }
    throw e;
  }
  const v = validarRecord(record);
  if (v.ok) {
    representaveis.push(b.legacyId);
    refs.add(sourceRefDe(b));
  } else {
    naoRepresentaveis.push({
      id: b.legacyId,
      line: b.line,
      labels: b.labels.map((l) => l.label),
      erro: v.errors.join("; "),
    });
  }
}

console.log(`gotcha source items      ${rel.gotchas.length}`);
console.log(`outros itens legados     ${rel.otherLegacy.length}  (${rel.otherLegacy.map((o) => o.legacyId).join(", ")})`);
console.log(`representáveis           ${representaveis.length}/${rel.gotchas.length}`);
console.log(`source_refs distintos    ${refs.size}`);
console.log(`não representáveis       ${naoRepresentaveis.length}`);
console.log(`PENDENTE curadoria       ${pendentes.length}  (${pendentes.join(", ")})`);

if (naoRepresentaveis.length > 0) {
  console.log(`\n── NÃO REPRESENTÁVEIS ──`);
  for (const n of naoRepresentaveis) {
    console.log(`  ${n.id}  L${n.line}`);
    console.log(`     rótulos: ${n.labels.join(" · ") || "(nenhum)"}`);
  }
}

/** Cobertura por rótulo da fonte: representado, ou não projetado (fonte preservada). */
const reivindicados = new Map<string, string>();
for (const [campo, aliases] of Object.entries(LABEL_MAP)) {
  for (const a of aliases) reivindicados.set(a, campo);
}
for (const d of DATE_LABELS) reivindicados.set(d, "(não projetado — DATE != EVIDENCE)");

const ocorrencias = new Map<string, number>();
for (const b of rel.gotchas) {
  for (const l of b.labels) ocorrencias.set(l.label, (ocorrencias.get(l.label) ?? 0) + 1);
}

let repr = 0;
let naoProj = 0;
for (const [label, n] of ocorrencias) {
  const campo = reivindicados.get(label);
  if (campo && !campo.startsWith("(")) repr += n;
  else naoProj += n;
}

console.log(`\n── CONTABILIDADE DE CONTEÚDO (ocorrências de rótulo) ──`);
console.log(`  total na fonte                 ${[...ocorrencias.values()].reduce((a, b) => a + b, 0)}`);
console.log(`  representadas canonicamente    ${repr}`);
console.log(`  NÃO projetadas (fonte mantida) ${naoProj}`);
console.log(`  perdidas                       0   ← a fonte é preservada, nada é apagado`);

console.log(`\n── RÓTULOS NÃO PROJETADOS, por frequência ──`);
const naoProjetados = [...ocorrencias.entries()]
  .filter(([label]) => {
    const c = reivindicados.get(label);
    return !c || c.startsWith("(");
  })
  .sort((a, b) => b[1] - a[1]);
for (const [label, n] of naoProjetados.slice(0, 10)) {
  console.log(`  ${String(n).padStart(3)}×  ${label}`);
}
console.log(`  (${naoProjetados.length} rótulos distintos)`);

if (naoRepresentaveis.length > 0) process.exit(2);
