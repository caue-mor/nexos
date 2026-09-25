/**
 * Reader pós-clone. Prova que o record clonado resolve pelo caminho canônico —
 * `forProject` + `parseCanonical` + schema — e não só que o arquivo existe.
 */
import fs from "fs-extra";
import path from "node:path";
import { forProject } from "../src/lib/capsule/paths.js";
import { parseCanonical } from "../src/lib/capsule/codec.js";
import { CapsuleRecordSchema } from "../src/lib/capsule/schemas.js";

async function main(): Promise<void> {
  const root = process.env.C12_READ_ROOT;
  if (!root) throw new Error("C12_READ_ROOT ausente");

  const p = forProject(root);
  const dir = p.familyDir("Decision");
  const arquivo = (await fs.readdir(dir)).find((f) => f.endsWith(".yaml"));
  if (!arquivo) throw new Error(`nenhum record em ${dir}`);

  const bruto = parseCanonical(await fs.readFile(path.join(dir, arquivo), "utf8"));
  const v = CapsuleRecordSchema.safeParse(bruto);
  if (!v.success) {
    console.log(`INVALIDO ${v.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    process.exit(1);
  }
  const r = v.data;
  console.log(`VALIDO ${r.id} | ${r.family} | origin=${r.origin} | ${JSON.stringify(r.content).slice(0, 45)}`);
}

main().catch((e) => {
  console.log(`ERRO ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
