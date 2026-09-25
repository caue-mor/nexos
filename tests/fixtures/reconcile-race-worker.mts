/**
 * Worker de processo para CF-C1/CF-C3 (corrida real entre dois
 * `initializeForReconciliation` no mesmo projeto `LEGACY_RECONCILABLE`).
 *
 * Diferente de `reconcile-kill-worker.mts` (que força uma janela artificial
 * para simular `kill -9`), este worker NÃO atrasa nada — a corrida aqui é a
 * concorrência real de dois processos OS distintos batendo no mesmo `wx` ao
 * mesmo tempo, sem instrumentação.
 *
 * Nunca roda em produção — só os testes de concorrência o invocam via
 * `spawn`. Reporta o desfecho em uma linha JSON no stdout; nunca deixa uma
 * exceção subir crua (isso é o próprio comportamento que o node PROJECT
 * BOOTSTRAP corrigiu — o worker precisa continuar podendo distinguir
 * "perdi a corrida" de "erro real").
 */
import { initializeForReconciliation } from "../../src/lib/capsule/migration-classifier.js";

const root = process.argv[2];
const projectName = process.argv[3] ?? "race";
if (!root) {
  console.error("root ausente");
  process.exit(2);
}

try {
  const r = await initializeForReconciliation(root, { projectName });
  console.log(JSON.stringify({ ok: true, created: r.created, projectId: r.projectId }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      errorName: error instanceof Error ? error.constructor.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    })
  );
  process.exitCode = 1;
}
