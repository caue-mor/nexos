/**
 * BASELINE dos limiares de dedupe — mede antes de calibrar.
 *
 *   THRESHOLD SEM BASELINE == CHUTE COM DUAS CASAS DECIMAIS
 *
 * Roda a sobreposição de Jaccard sobre TODOS os pares de records de
 * conhecimento do Store real deste repo e imprime a distribuição. Os limiares
 * de `memory-promotion.ts` saem daqui, não de gosto.
 *
 * Uso: npx tsx scripts/memory-dedupe-baseline.mts
 */
import { readCurrentRecords, contentOf } from "../src/lib/capsule/reader.js";
import { termosDe } from "../src/lib/context-assembler.js";

const KINDS = new Set(["gotcha", "pattern", "architecture"]);

function sobreposicao(a: string, b: string): number {
  const ta = termosDe(a);
  const tb = termosDe(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let comuns = 0;
  for (const t of ta) if (tb.has(t)) comuns += 1;
  return comuns / (ta.size + tb.size - comuns);
}

function textoDe(r: unknown): string {
  const c = contentOf(r as never);
  return [c["fact"], c["title"], c["rule"], c["practice"], c["subject"], c["model"]]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join(" ");
}

const res = await readCurrentRecords(process.cwd());
if (res.ok !== true) {
  console.error("Store ilegível:", JSON.stringify(res).slice(0, 400));
  process.exit(1);
}

const conhecimento = res.records.filter((r) => {
  const k = (r.record as { kind?: string }).kind;
  return typeof k === "string" && KINDS.has(k);
});

const textos = conhecimento.map((r) => ({ id: r.record.id, texto: textoDe(r.record) })).filter((t) => t.texto !== "");

console.log(`records de conhecimento: ${conhecimento.length} · com texto: ${textos.length}`);

const scores: Array<{ a: string; b: string; s: number }> = [];
for (let i = 0; i < textos.length; i += 1) {
  for (let j = i + 1; j < textos.length; j += 1) {
    const a = textos[i];
    const b = textos[j];
    if (a === undefined || b === undefined) continue;
    scores.push({ a: a.id, b: b.id, s: sobreposicao(a.texto, b.texto) });
  }
}
scores.sort((x, y) => y.s - x.s);

console.log(`pares comparados: ${scores.length}`);
if (scores.length === 0) {
  console.log("sem pares — nada a calibrar");
  process.exit(0);
}

const buckets = [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.3, 0.2, 0.1];
console.log("\ndistribuição acumulada (pares com sobreposição >= x):");
for (const b of buckets) {
  const n = scores.filter((s) => s.s >= b).length;
  const pct = ((n / scores.length) * 100).toFixed(2);
  console.log(`  >= ${b.toFixed(2)}  ${String(n).padStart(6)} pares  ${pct.padStart(6)}%`);
}

const p = (q: number): number => scores[Math.min(scores.length - 1, Math.floor(scores.length * q))]?.s ?? 0;
console.log(
  `\nmax=${scores[0]?.s.toFixed(3)} p99=${p(0.01).toFixed(3)} p95=${p(0.05).toFixed(3)} ` +
    `p50=${p(0.5).toFixed(3)}`
);

console.log("\ntop 12 pares mais sobrepostos (candidatos a duplicata real):");
for (const s of scores.slice(0, 12)) {
  const ta = textos.find((t) => t.id === s.a)?.texto ?? "";
  const tb = textos.find((t) => t.id === s.b)?.texto ?? "";
  console.log(`  ${s.s.toFixed(3)}  ${s.a.slice(0, 12)} | ${s.b.slice(0, 12)}`);
  console.log(`         A: ${ta.slice(0, 96)}`);
  console.log(`         B: ${tb.slice(0, 96)}`);
}

/**
 * O corpus não tem duplicata — o máximo acima é o teto dos NÃO-duplicados.
 * Falta o outro lado da fronteira: quanto pontua o MESMO fato dito com menos
 * palavras. Reescrever os records seria fabricar dado; encurtá-los não é —
 * é o mesmo texto com um pedaço a menos, que é a forma real de uma proposta
 * repetida chegar (o mesmo aprendizado, redigido mais curto).
 */
console.log("\n── mesma afirmação, redigida mais curta (piso da duplicata real) ──");
for (const frac of [0.8, 0.6, 0.5, 0.4, 0.3]) {
  const amostras: number[] = [];
  for (const t of textos) {
    const termos = [...termosDe(t.texto)];
    if (termos.length < 8) continue;
    const curto = termos.slice(0, Math.max(1, Math.floor(termos.length * frac))).join(" ");
    amostras.push(sobreposicao(t.texto, curto));
  }
  if (amostras.length === 0) continue;
  amostras.sort((a, b) => a - b);
  const min = amostras[0] ?? 0;
  const med = amostras[Math.floor(amostras.length / 2)] ?? 0;
  console.log(
    `  ${(frac * 100).toFixed(0).padStart(3)}% dos termos → min=${min.toFixed(3)} mediana=${med.toFixed(3)} (n=${amostras.length})`
  );
}
