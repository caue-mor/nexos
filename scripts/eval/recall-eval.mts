/**
 * Eval do recall de memória (UserPromptSubmit) — proposta OSB 3 do Jarvis, 23/09.
 *
 * NÃO substitui `nexos memory --eval` (src/lib/memory-eval.ts, golden set de
 * docs/memory-eval): aquela régua mede o RANKING da busca (recall@5/MRR) e o
 * schema dela exige um record esperado por caso. Esta mede o caminho de
 * INJEÇÃO automática: o limiar de `qualifica`, a abstenção em pedido sem
 * relação e o ruído por injeção. Linha de base das duas em 23/09: busca
 * recall@5 59,7% / MRR 0,55 (67 casos); injeção acerto 69% / MRR 0,58 (16+3).
 *
 * Casos escritos à mão em recall-cases.jsonl: pedido em linguagem natural e o
 * record que DEVERIA voltar ([] = deveria abster). Roda o adapter real contra um
 * Store e mede: acerto (esperado aparece), acerto no top 3, MRR, ruído (refs por
 * injeção) e abstenção nos negativos. Rode contra uma CÓPIA do Store: o recall
 * grava log de recuperação no projeto.
 *
 *   node --import tsx scripts/eval/recall-eval.mts <casos.jsonl> <raiz-do-projeto>
 */
import { readFileSync } from "node:fs";
import { runMemoryRecallAdapter } from "../../src/host/claude/memory-recall.js";

interface Caso {
  readonly prompt: string;
  readonly expect: readonly string[];
}

const [casosPath, raiz] = process.argv.slice(2);
if (!casosPath || !raiz) {
  console.error("uso: recall-eval.mts <casos.jsonl> <raiz-do-projeto>");
  process.exit(2);
}
const casos = readFileSync(casosPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Caso);

let positivos = 0, acertos = 0, top3 = 0, rrSoma = 0, negativos = 0, absteve = 0, refsSoma = 0, injecoes = 0;
for (const [i, caso] of casos.entries()) {
  const r = await runMemoryRecallAdapter(
    { hook_event_name: "UserPromptSubmit", session_id: `eval-recall-${Date.now()}-${i}`, cwd: raiz, prompt: caso.prompt },
    { CLAUDE_PROJECT_DIR: raiz }
  );
  const refs = r.state === "RECALL" ? [...r.text.matchAll(/source_ref: (\S+)/g)].map((m) => m[1]) : [];
  if (refs.length > 0) {
    injecoes++;
    refsSoma += refs.length;
  }
  if (caso.expect.length === 0) {
    negativos++;
    if (refs.length === 0) absteve++;
    console.log(`${refs.length === 0 ? "ABSTEVE " : "INJETOU "} ${String(refs.length).padStart(2)} refs · ${caso.prompt}`);
    continue;
  }
  positivos++;
  const rank = refs.findIndex((ref) => caso.expect.includes(ref));
  if (rank >= 0) {
    acertos++;
    rrSoma += 1 / (rank + 1);
    if (rank < 3) top3++;
  }
  console.log(`${rank >= 0 ? `ACERTO#${rank + 1}` : "ERRO    "} ${String(refs.length).padStart(2)} refs · ${r.state} · ${caso.prompt}`);
}
const pct = (a: number, b: number) => `${b === 0 ? 0 : Math.round((100 * a) / b)}%`;
console.log(
  `\nacerto ${acertos}/${positivos} (${pct(acertos, positivos)}) · top3 ${top3}/${positivos} (${pct(top3, positivos)}) · MRR ${(rrSoma / Math.max(positivos, 1)).toFixed(2)}` +
    ` · abstenção ${absteve}/${negativos} · refs por injeção ${(refsSoma / Math.max(injecoes, 1)).toFixed(1)}`
);
