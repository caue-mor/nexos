/**
 * CONTRAFACTUAL D — prova que o detector de conformidade pode ir RED.
 *
 *   A GATE THAT CANNOT GO RED IS NOT A GATE
 *
 * Reintroduz um array `GATES` hardcoded de volta em `src/commands/verify.ts`
 * (`nexos verify`) — e espera que `scripts/verify-quality-recipe-conformance.mts`
 * reprove. Restaura byte a byte depois da mutação e roda de novo, esperando PASS.
 *
 * A mutação irmã — PERMISSION P2.1, o identificador `GATE_MARKERS` de volta
 * em `permission-gate.ts` — saiu junto do arquivo e do motor que confiava em
 * marcador textual para `remote_push`, removidos por inteiro com a camada de
 * autorização (nexos://decision/p1-0-remover-authorization-layer). Não há
 * mais "forma certa de derivar" o marcador, nem arquivo onde reintroduzi-lo.
 *
 *   uso: npx tsx scripts/counterfactual-quality-recipe.mts
 */
import fs from "fs-extra";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const NEXOS_VERIFY_FILE = path.join(REPO, "src/commands/verify.ts");
const VERIFY_SCRIPT = path.join(REPO, "scripts/verify-quality-recipe-conformance.mts");

function runVerify(): { readonly exitCode: number; readonly output: string } {
  try {
    const out = execFileSync("npx", ["tsx", VERIFY_SCRIPT], { cwd: REPO, encoding: "utf-8" });
    return { exitCode: 0, output: out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

async function mutateAndVerify(
  label: string,
  file: string,
  originalContent: string,
  mutate: (content: string) => string,
  expectFail: string
): Promise<{ readonly label: string; readonly redOk: boolean; readonly detail: string }> {
  const mutated = mutate(originalContent);
  if (mutated === originalContent) {
    throw new Error(`${label}: mutação não mudou nada — o padrão de busca não bateu no arquivo`);
  }
  await fs.writeFile(file, mutated, "utf-8");

  const result = runVerify();
  const failed = result.exitCode !== 0;
  const hitExpected = result.output.includes(expectFail);

  return {
    label,
    redOk: failed && hitExpected,
    detail: failed
      ? hitExpected
        ? `RED como esperado — reprovou em: "${expectFail}"`
        : `RED mas não na prova esperada ("${expectFail}") — ver output`
      : `NÃO ficou RED — o detector continuou PASS com a autoridade duplicada reintroduzida (FALHA DO GATE)`,
  };
}

async function main(): Promise<void> {
  console.log("\n── CONTRAFACTUAL D — quality recipe conformance ──\n");

  const originalNexosVerify = await fs.readFile(NEXOS_VERIFY_FILE, "utf-8");

  const provas: Array<{ label: string; redOk: boolean; detail: string }> = [];

  console.log("  reintroduzindo array GATES hardcoded em src/commands/verify.ts...");
  const pGates = await mutateAndVerify(
    "nexos-verify-hardcode",
    NEXOS_VERIFY_FILE,
    originalNexosVerify,
    (c) =>
      c.replace(
        'const recipe = await resolveProjectQualityRecipe(root);',
        'const GATES = [{ gate: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] }]; // ponytail: contrafactual\nconst recipe = await resolveProjectQualityRecipe(root);'
      ),
    "1 src/commands/verify.ts deriva de resolveProjectQualityRecipe"
  );
  provas.push(pGates);
  console.log(`      ${pGates.redOk ? "RED confirmado" : "FALHOU EM FICAR RED"} — ${pGates.detail}`);

  await fs.writeFile(NEXOS_VERIFY_FILE, originalNexosVerify, "utf-8");
  const restoredGates = runVerify();
  const gatesRestoredGreen = restoredGates.exitCode === 0;
  console.log(`      restaurado → ${gatesRestoredGreen ? "GREEN" : "AINDA RED (restauração falhou!)"}`);

  const nexosVerifyBytesMatch = (await fs.readFile(NEXOS_VERIFY_FILE, "utf-8")) === originalNexosVerify;
  console.log(`\n  restauração byte a byte: src/commands/verify.ts ${nexosVerifyBytesMatch ? "OK" : "DIVERGIU"}`);

  const tudoOk = provas.every((p) => p.redOk) && gatesRestoredGreen && nexosVerifyBytesMatch;
  console.log(
    `\n${tudoOk ? "PASS" : "FAIL"} — contrafactual ${tudoOk ? "provou que o detector pega a autoridade duplicada e volta limpo" : "TEM PROBLEMA — ver acima"}\n`
  );
  process.exit(tudoOk ? 0 : 1);
}

await main();
