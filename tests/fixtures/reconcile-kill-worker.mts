/**
 * Worker de processo para CF-R4 (kill -9 no meio da migração).
 *
 * Nunca roda em produção — só o teste `reconciliation-contract.test.ts` o
 * invoca via `spawn`. Atrasa a escrita do `manifest.yaml` (o commit point
 * exclusivo de `initializeForReconciliation`) o suficiente para o processo pai
 * mandar SIGKILL ENTRE a criação de `records/`/`.local/gitignore` e o commit —
 * a janela exata em que um crash real deixaria estado pela metade.
 *
 * `ponytail: delay artificial só aqui, nunca em src/ — é o menor jeito de
 * tornar determinística uma janela de corrida que em produção dura
 * microssegundos.`
 */
import fs from "fs-extra";
import { initializeForReconciliation } from "../../src/lib/capsule/migration-classifier.js";

const root = process.argv[2];
if (!root) {
  console.error("root ausente");
  process.exit(2);
}

const original = fs.writeFile.bind(fs);
const mutableFs = fs as unknown as { writeFile: typeof fs.writeFile };
mutableFs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
  const [target] = args;
  if (typeof target === "string" && target.endsWith("manifest.yaml")) {
    // Sinaliza ao pai que passou por dirs+.gitignore e está prestes a
    // commitar — é o momento certo para o SIGKILL.
    process.stdout.write("READY\n");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  return original(...args);
}) as typeof fs.writeFile;

await initializeForReconciliation(root, { projectName: "cf-r4-kill" });
console.log("DONE");
