import fs from "fs-extra";
import { parseAdrMonolith } from "../src/lib/capsule/adr-parser.js";
import { medirPresenca, chaveMatriz } from "../src/lib/capsule/adr-labels.js";

async function main(): Promise<void> {
  const r = parseAdrMonolith(await fs.readFile(".nexos/memory/project/decisions.md", "utf8"));
  const matriz: Record<string, string[]> = {};
  for (const a of r.parsed) {
    const k = chaveMatriz(medirPresenca(a.body));
    (matriz[k] = matriz[k] ?? []).push(a.legacyId);
  }

  console.log("\nMATRIZ DE PRESENÇA — D=decision C=context X=consequences\n");
  let soma = 0;
  for (const k of ["111", "110", "101", "100", "011", "010", "001", "000"]) {
    const n = matriz[k]?.length ?? 0;
    soma += n;
    console.log(`  ${k}  ${String(n).padStart(3)}`);
  }
  console.log(`  ${"".padEnd(3)} ${"─".repeat(4)}`);
  console.log(`  soma ${String(soma).padStart(3)}  (ADRs ${r.parsed.length}) ${soma === r.parsed.length ? "FECHA" : "*** NAO FECHA ***"}`);

  const zeros = matriz["000"] ?? [];
  console.log(`\n  grupo 000 (${zeros.length}): ${zeros.join(" ") || "(vazio)"}`);
  console.log(`  ao menos um campo: ${r.parsed.length - zeros.length} / ${r.parsed.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
