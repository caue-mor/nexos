/**
 * C12.5 passo 1 — reconciliar a árvore REAL. Canônico ao lado do legado.
 *
 * Usa `initializeForReconciliation`, nunca `initializeCapsule`.
 *   CREATE != RECONCILE   ·   ROLLBACK MINE != DELETE THEIRS
 */
import fs from "fs-extra";
import path from "node:path";
import { createHash } from "node:crypto";
import { initializeForReconciliation, classifyForReconciliation } from "../src/lib/capsule/migration-classifier.js";
import { classifyCapsule } from "../src/lib/capsule/initializer.js";

const ROOT = process.cwd();
const LEGADO = ["memory", "logs", "dev-scripts"] as const;

async function hashDir(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (d: string): Promise<void> => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else h.update(e.name).update(await fs.readFile(full));
    }
  };
  await walk(dir);
  return h.digest("hex");
}

async function main(): Promise<void> {
  console.log("\nC12.5 · reconciliação da árvore REAL\n");

  // ── antes ──
  const antes: Record<string, string> = {};
  for (const d of LEGADO) antes[d] = await hashDir(path.join(ROOT, ".nexos", d));
  console.log("  legado ANTES:");
  for (const d of LEGADO) console.log(`    ${d.padEnd(12)} ${antes[d]!.slice(0, 16)}`);

  const pre = await classifyForReconciliation(ROOT);
  console.log(`\n  preflight: reconciliável=${pre.reconcilable} · conflitos=${pre.conflicting.join(",") || "nenhum"}`);
  if (!pre.reconcilable) {
    console.error("  ABORTADO — resolver conflitos antes.");
    process.exit(1);
  }

  // ── reconciliar ──
  const r = await initializeForReconciliation(ROOT, { projectName: "nexos-cli" });
  console.log(`\n  ${r.created ? "CRIADO" : "JÁ EXISTIA"} · project_id ${r.projectId}`);
  console.log(`  preservados: ${r.preserved.join(", ")}`);

  // ── depois ──
  console.log("\n  legado DEPOIS:");
  let intacto = true;
  for (const d of LEGADO) {
    const agora = await hashDir(path.join(ROOT, ".nexos", d));
    const ok = agora === antes[d];
    if (!ok) intacto = false;
    console.log(`    ${d.padEnd(12)} ${agora.slice(0, 16)} ${ok ? "INTACTO" : "*** ALTERADO ***"}`);
  }

  const p = await import("../src/lib/capsule/paths.js").then((m) => m.forProject(ROOT));
  console.log("\n  canônico:");
  for (const [nome, alvo] of [
    ["manifest.yaml", p.manifest()],
    [".gitignore", p.capsuleGitignore()],
    ["records/", p.recordsRoot()],
    [".local/", path.join(p.capsuleDir(), ".local")],
  ] as const) {
    console.log(`    ${nome.padEnd(14)} ${(await fs.pathExists(alvo)) ? "existe" : "AUSENTE"}`);
  }

  // O modo normal TEM de continuar recusando — se aceitar, a fronteira quebrou.
  const normal = await classifyCapsule(ROOT);
  console.log(`\n  classifyCapsule (modo normal): ${normal.state}`);
  console.log(
    normal.state === "CONFLICTING_EXISTING"
      ? "  Migration Plane é o ÚNICO caminho que tolera legado ✓"
      : "  *** o modo normal passou a aceitar legado — fronteira quebrada ***"
  );

  if (!intacto) {
    console.error("\nFALHA: fonte legada foi alterada.");
    process.exit(1);
  }
  console.log("\nreconciliação OK — legado byte-preserved\n");
}

main().catch((e) => {
  console.error("\nFALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});
