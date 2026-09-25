/**
 * C12.6 — alias collision gate + auditoria de evidência real.
 *
 * Mede, por BLOCO, quantos rótulos da MESMA semântica aparecem:
 *
 *   0    campo ausente
 *   1    mapeamento direto
 *   >1   COLISÃO — não se escolhe first/last, não se concatena. Inspeciona-se.
 *
 *   ALIAS NORMALIZATION != VALUE COLLISION RESOLUTION
 *
 * E separa `Data` de evidência: `DATE != EVIDENCE`. A conclusão anterior de que
 * "evidence é universal 45/45" vinha de contar `Data`, que é a data do finding,
 * não prova dele. Aqui evidence é medida só por rótulos que carregam prova,
 * medição, observação, comando/output ou referência.
 *
 * Uso:  npx tsx scripts/c12-gotcha-alias-audit.ts
 */
import fs from "fs-extra";
import { parseGotchaMonolith, type GotchaBlock } from "../src/lib/capsule/gotcha-parser.js";
import { LABEL_MAP, DATE_LABELS } from "../src/lib/capsule/gotcha-labels.js";

const SOURCE = ".nexos/memory/project/gotchas.md";

/**
 * DERIVADO do `LABEL_MAP`, nunca copiado.
 *
 *   AUDITOR UNIT MUST MATCH PRODUCER UNIT
 *
 * A versão anterior mantinha uma cópia literal do mapa e ela divergiu: `rule`
 * entrou no producer e não aqui, então este gate reportava `Regra` (6
 * ocorrências) como "rótulo sem campo canônico" e não media colisão nenhuma
 * nesse campo. Mesma classe do defeito que o audit V3 corrigiu — um auditor que
 * lê o próprio mapa, e não o produtor, mente com números.
 *
 * `DATE != EVIDENCE`: `Data` continua fora, medida à parte.
 */
const ALIASES: Record<string, readonly string[]> = LABEL_MAP;

const texto = await fs.readFile(SOURCE, "utf8");
const rel = parseGotchaMonolith(texto);

if (rel.gotchas.length + rel.otherLegacy.length + rel.malformed.length !== rel.headingsSeen) {
  console.error("ABORTADO — o conjunto não fecha.");
  process.exit(1);
}

const blocos = rel.gotchas;

const contarAliases = (b: GotchaBlock, aceitos: readonly string[]): string[] =>
  b.labels.filter((l) => aceitos.includes(l.label)).map((l) => l.label);

console.log(`blocos GOTCHA        ${blocos.length}\n`);
console.log(`── ALIAS COLLISION GATE ──`);
console.log(`  ${"campo".padEnd(14)} ${"zero".padStart(5)} ${"um".padStart(4)} ${">1".padStart(4)}`);

const colisoes: Array<{ campo: string; bloco: GotchaBlock; achados: string[] }> = [];

for (const [campo, aceitos] of Object.entries(ALIASES)) {
  let zero = 0;
  let um = 0;
  let mais = 0;

  for (const b of blocos) {
    const achados = contarAliases(b, aceitos);
    if (achados.length === 0) zero++;
    else if (achados.length === 1) um++;
    else {
      mais++;
      colisoes.push({ campo, bloco: b, achados });
    }
  }
  console.log(
    `  ${campo.padEnd(14)} ${String(zero).padStart(5)} ${String(um).padStart(4)} ${String(mais).padStart(4)}`
  );
}

console.log(`\n── DATE != EVIDENCE ──`);
const comData = blocos.filter((b) => contarAliases(b, DATE_LABELS).length > 0).length;
const comEvidence = blocos.filter((b) => contarAliases(b, ALIASES.evidence ?? []).length > 0).length;
console.log(`  blocos com 'Data'            ${comData}/${blocos.length}`);
console.log(`  blocos com evidência REAL    ${comEvidence}/${blocos.length}`);
console.log(`  (o 45/45 anterior contava Data — mapeamento retirado)`);

if (colisoes.length > 0) {
  console.log(`\n── COLISÕES A INSPECIONAR (${colisoes.length}) ──`);
  for (const c of colisoes) {
    console.log(`  ${c.campo}  ${c.bloco.legacyId}  linha ${c.bloco.line}`);
    console.log(`     ${c.bloco.title.slice(0, 70)}`);
    for (const a of c.achados) {
      const v = c.bloco.labels.find((l) => l.label === a)?.value ?? "";
      console.log(`     • ${a}: ${v.slice(0, 90)}${v.length > 90 ? "…" : ""}`);
    }
  }
}

/** Todo rótulo que nenhum campo canônico reivindica — base do accounting de perda. */
const reivindicados = new Set([...Object.values(ALIASES).flat(), ...DATE_LABELS]);
const orfaos = new Map<string, number>();
for (const b of blocos) {
  for (const l of b.labels) {
    if (reivindicados.has(l.label)) continue;
    orfaos.set(l.label, (orfaos.get(l.label) ?? 0) + 1);
  }
}
console.log(`\n── RÓTULOS SEM CAMPO CANÔNICO (${orfaos.size} distintos) ──`);
for (const [label, n] of [...orfaos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(3)}×  ${label}`);
}
console.log(`  … total de ocorrências órfãs: ${[...orfaos.values()].reduce((a, b) => a + b, 0)}`);
