import pc from "picocolors";
import { loadFamilyForResolution } from "../lib/capsule/head-resolver.js";
import { resolveCommandRoot, resolveProject } from "../lib/project-resolver.js";
import { writeSessionForgotten } from "../lib/capsule/session-events.js";
import type { CapsuleRecord, SessionStartedSchema, SessionClosedSchema, SessionForgottenSchema } from "../lib/capsule/schemas.js";
import type { z } from "zod";

type SessionStarted = z.infer<typeof SessionStartedSchema>;
type SessionClosed = z.infer<typeof SessionClosedSchema>;
type SessionForgotten = z.infer<typeof SessionForgottenSchema>;

/**
 * `nexos sessions [--json]` — registro de sessão (18/09), contrato de
 * leitura para a frente JARVIS. Dobra os dois eventos da family `Session`
 * (`started`/`closed`, `schemas.ts`) por `scope.ref` (o `session_id` real) —
 * a MESMA correlação que `session-events.ts` grava, nunca uma segunda
 * derivação. Ver a docstring de `SessionStartedSchema` para o porquê do
 * desenho event-log.
 *
 * Schema `--json`:
 *   { "sessions": [ { "id", "project_id", "host", "cwd", "agent_ref",
 *       "started_at", "last_activity_at", "checkpoint_id", "status" } ] }
 *
 * `last_activity_at`/`agent_ref`/`checkpoint_id`/`project_id`/`host`/`cwd`
 * saem `null` EXPLÍCITO quando não observados — nunca omitidos (mesma
 * disciplina de `nexos checkpoint --json`). `status` é OBSERVADO
 * ("CLOSED" ⟺ existe um evento `closed` para este `session_id`), nunca
 * INFERIDO por idade: uma sessão sem `closed` fica `"ACTIVE"` para sempre no
 * dado bruto — decidir que ela provavelmente morreu é julgamento de quem
 * CONSOME (`started_at` na mão), nunca deste comando.
 */
export interface SessionsOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  /** `nexos sessions --forget <session_id>` — retira a sessão de circulação (nunca apaga o disco). Exige `--why`. */
  readonly forget?: string;
  readonly why?: string;
  /** Ator DECLARADO do `--forget` — `ACTOR != PRODUCER`, mesmo eixo de `nexos memory --deprecate --by`. */
  readonly by?: string;
}

interface SessionRowJson {
  readonly id: string;
  readonly project_id: string | null;
  readonly host: string | null;
  readonly cwd: string | null;
  readonly agent_ref: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly checkpoint_id: string | null;
  readonly status: "ACTIVE" | "CLOSED";
}

interface SessionBucket {
  started?: SessionStarted;
  closed?: SessionClosed;
  /** Presente = `nexos sessions --forget` retirou esta sessão de circulação. Nunca aparece em `rows`. */
  forgotten?: SessionForgotten;
}

/** `scope.ref` quando `scope.kind === "session"` — `null` pra qualquer outra forma (nunca deveria acontecer nesta family). */
function sessionIdOf(scope: SessionStarted["scope"]): string | null {
  return typeof scope === "object" && scope !== null && scope.kind === "session" ? scope.ref : null;
}

function foldRows(records: readonly { record: CapsuleRecord }[]): SessionRowJson[] {
  const bySessionId = new Map<string, SessionBucket>();
  for (const entry of records) {
    const r = entry.record;
    if (r.family !== "Session") continue;
    const sessionId = sessionIdOf(r.scope);
    if (!sessionId) continue;
    const bucket = bySessionId.get(sessionId) ?? {};
    if (r.kind === "started") {
      bucket.started = r;
    } else if (r.kind === "forgotten") {
      bucket.forgotten = r;
    } else if (!bucket.closed || r.created_at > bucket.closed.created_at) {
      // Duplicata rara (SessionEnd disparando mais de uma vez): fica o mais recente.
      bucket.closed = r;
    }
    bySessionId.set(sessionId, bucket);
  }

  const rows: SessionRowJson[] = [];
  for (const [sessionId, { started, closed, forgotten }] of bySessionId) {
    // `--forget` retira de circulação: fora do disco NADA muda, só some da LEITURA — mesma doutrina de `nexos memory --deprecate`.
    if (forgotten) continue;
    rows.push({
      id: sessionId,
      project_id: started?.project_id ?? closed?.project_id ?? null,
      host: started?.content.host ?? null,
      cwd: started?.content.cwd ?? null,
      agent_ref: started?.content.agent_ref ?? null,
      started_at: started?.created_at ?? null,
      last_activity_at: closed?.created_at ?? null,
      checkpoint_id: started?.content.checkpoint_id ?? null,
      status: closed ? "CLOSED" : "ACTIVE",
    });
  }
  rows.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  return rows;
}

export async function sessions(options: SessionsOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  if (options.forget !== undefined) {
    await forget(root, options);
    return;
  }

  const loaded = await loadFamilyForResolution(root, "Session");

  if (loaded.state !== "LOADED") {
    if (options.json) {
      console.log(JSON.stringify({ sessions: [], error: loaded.state }));
    } else {
      console.log(pc.red(`  x leitura de sessões: ${loaded.state}`));
    }
    process.exitCode = 1;
    return;
  }

  const rows = foldRows(loaded.records);

  if (options.json) {
    console.log(JSON.stringify({ sessions: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(pc.dim("  (nenhuma sessão registrada ainda)"));
    return;
  }
  for (const row of rows) {
    const statusLabel = row.status === "ACTIVE" ? pc.green(row.status) : pc.dim(row.status);
    console.log(`  ${row.id}  ${statusLabel}  ${row.host ?? "?"}  ${row.started_at ?? "?"}`);
  }
}

/**
 * `nexos sessions --forget <session_id> --why "<motivo>"` — ver a docstring
 * de `SessionForgottenSchema` (`schemas.ts`): retira a sessão de circulação
 * PUBLICANDO um evento novo, nunca apagando nem reescrevendo os records
 * `started`/`closed` originais. `DEPRECATED != DELETED`.
 *
 * Exige a sessão existir (tem `started` na family) antes de aceitar — nunca
 * publica um `forgotten` órfão que aponta pra um `session_id` que a family
 * nunca viu.
 */
async function forget(root: string, options: SessionsOptions): Promise<void> {
  const sessionId = (options.forget ?? "").trim();
  const reason = (options.why ?? "").trim();

  if (reason === "") {
    console.log(
      pc.red(
        "  x --forget exige --why: retirar uma sessão de circulação sem motivo registrado é apagar história."
      )
    );
    process.exitCode = 1;
    return;
  }

  const resolution = await resolveProject({ cwd: root });
  if (resolution.identitySource !== "manifest" || !resolution.canonicalProjectId) {
    console.log(pc.red("  x projeto sem Store — não há onde registrar."));
    process.exitCode = 1;
    return;
  }

  const loaded = await loadFamilyForResolution(root, "Session");
  if (loaded.state !== "LOADED") {
    console.log(pc.red(`  x leitura de sessões: ${loaded.state}`));
    process.exitCode = 1;
    return;
  }
  const existe = loaded.records.some(
    (entry) => entry.record.family === "Session" && sessionIdOf(entry.record.scope) === sessionId
  );
  if (!existe) {
    console.log(pc.red(`  x sessão "${sessionId}" não encontrada nesta family — nada a esquecer.`));
    process.exitCode = 1;
    return;
  }

  const actorRef = (options.by ?? "").trim() || "policy:nexos-sessions-forget";
  const result = await writeSessionForgotten({
    rootPath: root,
    projectId: resolution.canonicalProjectId,
    sessionId,
    reason,
    actorRef,
  });
  if (!result.ok) {
    console.log(pc.red(`  x não foi possível registrar: ${result.detail}`));
    process.exitCode = 1;
    return;
  }

  console.log(pc.green(`  + sessão ${sessionId} retirada de circulação.`));
  console.log(pc.dim(`    motivo: ${reason}`));
  console.log(pc.dim(`    ator: ${actorRef}`));
  console.log(pc.dim(`    os records de ${sessionId} continuam no disco — só a LEITURA muda.`));
}
