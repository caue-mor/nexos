import fs from "fs-extra";
import { forProject } from "../src/lib/capsule/paths.js";
import { parseCanonical } from "../src/lib/capsule/codec.js";
import { CapsuleRecordSchema } from "../src/lib/capsule/schemas.js";

async function main(): Promise<void> {
  const root = process.env.C12_READ_ROOT!;
  const dir = forProject(root).familyDir("Decision");
  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml"));
  const ids: string[] = [];
  let validos = 0;
  for (const f of arquivos) {
    const r = CapsuleRecordSchema.safeParse(parseCanonical(await fs.readFile(`${dir}/${f}`, "utf8")));
    if (r.success && r.data.family === "Decision") {
      validos++;
      ids.push(r.data.content.title.split(":")[0]!);
    }
  }
  console.log(`  válidos: ${validos} / ${arquivos.length}`);
  console.log(`  ADRs   : ${ids.sort().join(" ")}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
