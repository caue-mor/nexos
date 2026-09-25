/**
 * Worker de processo para `authority-race.test.ts` — corrida real de dois
 * processos OS disputando a eleição de authority (TOFU ou reclaim) do MESMO
 * `project_id`. Publica via `publishSuperseding`, não `publishCanonical` cru:
 * o defeito medido cobre tanto a eleição de authority (`authority.ts`) quanto
 * a dupla resolução dentro do laço CAS de superseding (`store.ts`) — as duas
 * causas precisam ser exercitadas juntas, como no experimento original.
 *
 * Nunca roda em produção — só `authority-race.test.ts` invoca via `spawn`.
 * Reporta o desfecho em uma linha JSON no stdout; nunca deixa exceção subir crua.
 */
import { publishSuperseding } from "../../src/lib/capsule/store.js";
import { readCurrentRecords } from "../../src/lib/capsule/reader.js";
import { newRecordId } from "../../src/lib/capsule/ids.js";
import { makeGotcha } from "../capsule-fixtures.js";
import type { CapsuleRecord } from "../../src/lib/capsule/schemas.js";

const [root, nexosHome, projectId, sourceRef, label] = process.argv.slice(2);
if (!root || !nexosHome || !projectId || !sourceRef || !label) {
  console.error("uso: authority-race-worker.mts <root> <nexosHome> <projectId> <sourceRef> <label>");
  process.exit(2);
}

async function headAtual(): Promise<{ id: string } | undefined> {
  const r = await readCurrentRecords(root, { kind: "gotcha", nexosHome });
  if (!r.ok) return undefined;
  const atual = r.records.find((x) => x.sourceRef === sourceRef);
  return atual ? { id: (atual.record as { id: string }).id } : undefined;
}

try {
  const result = await publishSuperseding(root, {
    family: "KnowledgeRecord",
    sourceRef,
    readHead: headAtual,
    buildRecord: (head) =>
      makeGotcha({
        project_id: projectId,
        id: newRecordId("KnowledgeRecord"),
        provenance: {
          source_ref: sourceRef,
          producer_id: `authority-race:${label}`,
          submitted_at: new Date().toISOString(),
        },
        ...(head ? { supersedes: head.id } : {}),
      }) as CapsuleRecord,
    nexosHome,
  });

  console.log(
    JSON.stringify({
      ok: true,
      outcome: result.outcome,
      authorityOutcome: result.authority.outcome,
      activeRoot: result.authority.activeRoot,
      canonicalPath: result.canonicalPath,
      recordId: result.record.id,
      attempts: result.attempts,
    })
  );
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
