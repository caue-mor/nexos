/**
 * MIGRADOR DA LINHAGEM DE RESEARCH — `nexos://research` literal -> por pergunta.
 *
 *   APAGAR RECORD A MAO E INDISTINGUIVEL DE RECORD PERDIDO
 *
 * Por isso este script NUNCA remove nada. Ele REPUBLICA o conteudo sob o
 * `source_ref` correto, preservando o `observed_at` original e CITANDO o
 * record de origem. Os antigos ficam no disco, na linhagem podre, como
 * historico — invisiveis ao leitor canonico e inofensivos: medido em
 * 2026-09-18, `readCurrentRecords({families:["Research"]})` devolve
 * `ok: true` com a anomalia DIVERGED isolada, sem contaminar os legiveis.
 *
 * DRY-RUN POR PADRAO. `--apply` escreve. A escrita no Store canonico e do
 * master (BOARD: "Store (.nexos/): so o master escreve") — este script existe
 * pronto para ele rodar, nao para a frente paralela executar.
 */
import fs from "fs-extra";
import path from "node:path";
import YAML from "yaml";
import { publishCanonical } from "../dist/lib/capsule/store.js";
import { newRecordId } from "../dist/lib/capsule/ids.js";
import { subjectRef } from "../dist/lib/capsule/schemas.js";
import type { CapsuleRecord } from "../dist/lib/capsule/schemas.js";

const LINHAGEM_PODRE = "nexos://research";
const PRODUCER = "nexos-research-migrator";

interface Antigo {
  readonly file: string;
  readonly id: string;
  readonly question: string;
  readonly record: Record<string, unknown>;
}

async function lerAntigos(root: string): Promise<readonly Antigo[]> {
  const dir = path.join(root, ".nexos", "records", "research");
  if (!(await fs.pathExists(dir))) return [];
  const out: Antigo[] = [];
  for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith(".yaml"))) {
    const r = YAML.parse(await fs.readFile(path.join(dir, f), "utf-8")) as Record<string, unknown>;
    const prov = (r["provenance"] ?? {}) as Record<string, unknown>;
    if (prov["source_ref"] !== LINHAGEM_PODRE) continue;
    const content = (r["content"] ?? {}) as Record<string, unknown>;
    out.push({ file: f, id: String(r["id"]), question: String(content["question"] ?? ""), record: r });
  }
  return out;
}

/** Perguntas que JA existem na linhagem correta — migrar inverteria a ordem. */
async function jaMigradas(root: string): Promise<ReadonlySet<string>> {
  const dir = path.join(root, ".nexos", "records", "research");
  const out = new Set<string>();
  for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith(".yaml"))) {
    const r = YAML.parse(await fs.readFile(path.join(dir, f), "utf-8")) as Record<string, unknown>;
    const prov = (r["provenance"] ?? {}) as Record<string, unknown>;
    const ref = String(prov["source_ref"] ?? "");
    if (ref !== LINHAGEM_PODRE && ref.startsWith(`${LINHAGEM_PODRE}/`)) out.add(ref);
  }
  return out;
}

function migrado(antigo: Antigo, agora: string): CapsuleRecord {
  const r = antigo.record;
  return {
    ...r,
    id: newRecordId("Research"),
    created_at: agora,
    provenance: {
      producer_id: PRODUCER,
      source_ref: `${LINHAGEM_PODRE}/${subjectRef(antigo.question)}`,
      submitted_at: agora,
      /** CITA a origem: migrar sem dizer de onde veio e perder a proveniencia. */
      migrated_from: antigo.id,
    },
  } as unknown as CapsuleRecord;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const aplicar = process.argv.includes("--apply");
  const antigos = await lerAntigos(root);
  const corretas = await jaMigradas(root);
  const agora = new Date().toISOString();

  console.log(`linhagem podre: ${antigos.length} record(s)\n`);
  let migra = 0;
  let pula = 0;
  for (const a of antigos) {
    const destino = `${LINHAGEM_PODRE}/${subjectRef(a.question)}`;
    if (corretas.has(destino)) {
      pula += 1;
      console.log(`  PULA  ${a.id}`);
      console.log(`        ja existe na linhagem correta: ${destino}`);
      console.log(`        migrar faria o ANTIGO superseder o NOVO — decisao de conteudo, nao de migracao\n`);
      continue;
    }
    migra += 1;
    console.log(`  ${aplicar ? "MIGRA" : "MIGRARIA"}  ${a.id} -> ${destino}`);
    if (aplicar) await publishCanonical(root, migrado(a, agora));
  }
  console.log(`\nmigrar: ${migra}  ·  pular: ${pula}  ·  remover: 0 (nunca)`);
  if (!aplicar) console.log("\nDRY-RUN — nada escrito. `--apply` para valer.");
}

void main();
