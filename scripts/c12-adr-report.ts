import fs from "fs-extra";
import { parseAdrMonolith } from "../src/lib/capsule/adr-parser.js";

async function main(): Promise<void> {
  const texto = await fs.readFile(".nexos/memory/project/decisions.md", "utf8");
  const r = parseAdrMonolith(texto);
  const nums = r.parsed.map((a) => Number(a.legacyId.slice(4))).sort((a, b) => a - b);

  console.log("\nPARSE do monolito de ADRs\n");
  console.log(`  cabeçalhos vistos   : ${r.headingsSeen}`);
  console.log(`  ADRs parseados      : ${r.parsed.length}`);
  console.log(`  malformados         : ${r.malformed.length}`);
  console.log(`  duplicados          : ${r.duplicates.join(", ") || "nenhum"}`);
  console.log(`  faixa               : ADR-${String(nums[0]).padStart(3,"0")} .. ADR-${String(nums[nums.length-1]).padStart(3,"0")}`);
  console.log(`  gaps                : ${r.gaps.length ? r.gaps.join(", ") : "nenhum"}`);
  console.log(`  fecha o conjunto?   : ${r.parsed.length + r.malformed.length === r.headingsSeen ? "SIM" : "NAO"}`);
  if (r.malformed.length) { console.log("\n  malformados:"); r.malformed.slice(0,8).forEach((m)=>console.log(`    ${m}`)); }
  console.log("\n  primeiros 5 por identidade:");
  [...r.parsed].sort((a,b)=>Number(a.legacyId.slice(4))-Number(b.legacyId.slice(4))).slice(0,5)
    .forEach((a)=>console.log(`    ${a.legacyId}  ${a.title.slice(0,58)}`));
  console.log("");
}
main().catch((e) => { console.error(e); process.exit(1); });
