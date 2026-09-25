/**
 * C12.4 — preflight de reconciliação contra a árvore REAL. Zero escrita.
 *
 * Responde "esta árvore pode ser reconciliada?" sem afirmar "esta árvore já é
 * uma Capsule canônica" — `RECONCILABLE != CANONICAL`.
 */
import { classifyForReconciliation, LEGACY_SEMANTICS } from "../src/lib/capsule/migration-classifier.js";
import { classifyCapsule } from "../src/lib/capsule/initializer.js";

async function main(): Promise<void> {
  const root = process.env.C12_ROOT ?? process.cwd();
  const pre = await classifyForReconciliation(root);

  console.log(`\nC12.4 PREFLIGHT — ${root}\n`);
  for (const e of pre.entries) {
    const semantica = LEGACY_SEMANTICS[e.name];
    console.log(`  ${e.class.padEnd(21)} ${e.name.padEnd(14)} ${semantica ? semantica.class : ""}`);
  }

  console.log("");
  console.log(`  reconcilável        : ${pre.reconcilable}`);
  console.log(`  legado tolerado     : ${pre.legacyTolerated.join(", ") || "(nenhum)"}`);
  console.log(`  conflitos           : ${pre.conflicting.join(", ") || "(nenhum)"}`);
  console.log(`  já tem canônico     : ${pre.hasCanonical}`);

  // O modo NORMAL tem de continuar recusando — se passar a aceitar, a fatia falhou.
  const normal = await classifyCapsule(root);
  console.log(`  classifyCapsule     : ${normal.state}`);
  console.log("");
  console.log(
    pre.reconcilable && normal.state !== "VALID_TARGET"
      ? "RECONCILABLE != CANONICAL — reconciliável, e ainda assim não é Capsule válida"
      : pre.reconcilable
        ? "reconciliável E já canônica"
        : "NÃO reconciliável — resolver os conflitos primeiro"
  );
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
