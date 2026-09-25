/**
 * C12.5 — accounting de linhagem por source_ref.
 *
 * Lê a capsule REAL e reporta, por família, o estado de cada partição. Todos os
 * números são DERIVADOS do disco — nenhum é codificado, inclusive `records_total`
 * (supersessão faz o físico passar do lógico por construção).
 *
 *   PHYSICAL RECORD COUNT != LOGICAL CURRENT KNOWLEDGE COUNT
 *
 * Uso:  npx tsx scripts/c12-heads.ts [family] [rootPath]
 */
import { resolveHeadsBySource, headFor } from "../src/lib/capsule/head-resolver.js";
import { forProject } from "../src/lib/capsule/paths.js";
import type { RecordFamily } from "../src/lib/capsule/ids.js";
import { readdir } from "node:fs/promises";

const family = (process.argv[2] ?? "Decision") as RecordFamily;
const root = process.argv[3] ?? process.cwd();

const report = await resolveHeadsBySource(root, family);

if (report.state === "UNREADABLE") {
  console.error(`UNREADABLE — a capsule não pôde ser lida. Nada é afirmado.`);
  for (const issue of report.issues) {
    console.error(`  [${issue.level}] ${issue.code}: ${issue.detail}`);
  }
  process.exit(1);
}

const { bySource } = report;

/** Contagem física, do disco — nunca inferida do mapa lógico. */
let recordsTotal = 0;
try {
  recordsTotal = (await readdir(forProject(root).familyDir(family))).filter((f) =>
    f.endsWith(".yaml")
  ).length;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const counts = { CURRENT: 0, DIVERGED: 0, MALFORMED: 0 };
const rows: string[] = [];

for (const source of [...bySource.keys()].sort()) {
  const state = headFor(bySource, source);
  if (state.state === "ABSENT") continue; // inalcançável: a chave veio do mapa
  counts[state.state]++;

  const detail =
    state.state === "CURRENT"
      ? state.record.id
      : state.state === "DIVERGED"
        ? `heads=${state.heads.join(",")}`
        : state.issues.map((i) => i.code).join(",");
  rows.push(`  ${state.state.padEnd(9)} ${source}  →  ${detail}`);
}

console.log(`family                ${family}`);
console.log(`source_refs           ${bySource.size}`);
console.log(`current_heads         ${counts.CURRENT}`);
console.log(`diverged              ${counts.DIVERGED}`);
console.log(`malformed             ${counts.MALFORMED}`);
console.log(`records_total         ${recordsTotal}   (derivado do disco)`);
console.log(`superseded_records    ${recordsTotal - counts.CURRENT - counts.DIVERGED}`);
console.log("");
for (const row of rows) console.log(row);

/** Gate: divergência ou malformação não são "aviso" — são parada. */
if (counts.DIVERGED > 0 || counts.MALFORMED > 0) process.exit(2);
