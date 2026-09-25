import fs from "fs-extra";
import { parseAdrMonolith } from "../src/lib/capsule/adr-parser.js";

const tem = (b: string, ...nomes: string[]): boolean =>
  nomes.some((n) => new RegExp(`\\*\\*${n}[^*]*\\*\\*\\s*:`, "i").test(b));

async function main(): Promise<void> {
  const r = parseAdrMonolith(await fs.readFile(".nexos/memory/project/decisions.md", "utf8"));
  let d = 0, c = 0, ctx = 0, completos = 0;
  const semDecisao: string[] = [];
  const semConsequencia: string[] = [];

  for (const a of r.parsed) {
    const D = tem(a.body, "Decisao", "Decisão");
    const C = tem(a.body, "Consequencia", "Consequência");
    const X = tem(a.body, "Motivacao", "Motivação", "Contexto", "Problema", "Trigger");
    if (D) d++; else semDecisao.push(a.legacyId);
    if (C) c++; else semConsequencia.push(a.legacyId);
    if (X) ctx++;
    if (D && C && X) completos++;
  }

  console.log(`ADRs no total          : ${r.parsed.length}`);
  console.log(`com Decisao            : ${d}`);
  console.log(`com Consequencia(s)    : ${c}`);
  console.log(`com contexto/motivacao : ${ctx}`);
  console.log(`com os TRES            : ${completos}`);
  console.log(`\nsem Decisao (${semDecisao.length}): ${semDecisao.join(" ")}`);
  console.log(`sem Consequencia (${semConsequencia.length}): ${semConsequencia.slice(0, 20).join(" ")}${semConsequencia.length > 20 ? " …" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
