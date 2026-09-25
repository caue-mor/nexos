/**
 * C1.1c — o produtor de fechamento de sessão: `Stop`, `StopFailure`,
 * `SessionEnd`. Um comando, ramificado por `hook_event_name`, com
 * abertura/fechamento cruzando no mesmo módulo via marcador de disco.
 *
 *   CODE EXISTS != WIRED
 *   FAIL-CLOSED EM AUTORIZAÇÃO · FAIL-OPEN EM OBSERVAÇÃO
 *
 * Corte presence/capability/observations
 * (nexos://decision/p0-corte-presence-capability-observations): a família
 * `HostObservation` saiu do Store, e com ela o `session.ended` que
 * `SessionEnd` publicava. O comando `claude-session-close` continua
 * registrado (o hook do host continua chamando os três eventos) mas não
 * escreve mais no Store — `Stop`/`StopFailure` seguem atualizando o MARCADOR
 * local (`SessionCloseMarker`, mesmo padrão de `presentationCacheFile`) com o
 * desfecho do último turno; `SessionEnd` só lê esse marcador para reportar
 * `lastTurn` ao chamador e o limpa — fim do ciclo local, sem publicação.
 *
 * ─── por que identidade não sai do cwd ──────────────────────────────────────
 *
 * Mesma razão dos irmãos: `input.cwd`, quando presente, é OBSERVAÇÃO, nunca
 * alimenta a resolução. A identidade vem de `CLAUDE_PROJECT_DIR`, resolvido
 * pelo `ProjectResolver`.
 *
 * ─── por que nada aqui pode lançar ─────────────────────────────────────────
 *
 * Observação que quebra o host é pior que observação perdida — stdout fica
 * vazio, diagnóstico vai para stderr, exit code é sempre 0.
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolveProject } from "../../lib/project-resolver.js";
import { presentationCacheFile } from "../../lib/host/state-presentation.js";
import { writeSessionClosed } from "../../lib/capsule/session-events.js";

/** `"completed" | "failed" | "none"` — desfecho do último turno observado. */
export type LastTurnOutcome = "completed" | "failed" | "none";

/**
 * Portado de `lib/host/session-observation.ts` (removido no corte
 * presence/capability/observations — nexos://decision/p0-corte-presence-capability-observations,
 * junto de `buildSessionCloseObservation`/`HostObservation`). Este marcador
 * NUNCA foi Store: só existe para o `SessionEnd` desta MESMA sessão saber o
 * desfecho do último turno sem reabrir o transcript do host.
 */
export interface SessionCloseMarker {
  readonly turn?: "completed" | "failed";
  /** Herdado de `StopFailure`. Presente só quando `turn === "failed"`. */
  readonly failure_detail?: string;
}

/** Só os campos declarados — nunca payload cru do host. */
function serializeSessionCloseMarker(marker: SessionCloseMarker): string {
  return JSON.stringify(marker);
}

/** `unknown` + type guard. Corrompido/ilegível vira `undefined`, nunca lança. */
function parseSessionCloseMarker(raw: string): SessionCloseMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const marker: SessionCloseMarker = {};
  if (obj.turn === "completed" || obj.turn === "failed") (marker as { turn?: "completed" | "failed" }).turn = obj.turn;
  if (typeof obj.failure_detail === "string" && obj.failure_detail.trim()) {
    (marker as { failure_detail?: string }).failure_detail = obj.failure_detail;
  }
  return marker;
}

/** Eventos que este adapter reconhece. Fonte nova em versão futura do host é DESCARTADA, não adivinhada. */
const EVENTOS = ["Stop", "StopFailure", "SessionEnd"] as const;

/** Forma bruta do stdin, para os três eventos. Tudo `unknown`: nada é confiável antes do check. */
export interface SessionCloseHookInput {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  /** Só em `SessionEnd` — lista documentada em `SESSION_END_REASONS`, tratada como descritiva. */
  readonly reason?: unknown;
  readonly permission_mode?: unknown;
  /** Só em `StopFailure`. */
  readonly error?: unknown;
  /** Só em `StopFailure`, opcional (`hooks.md`). Não usado hoje — `error` já é o texto curto exigido. */
  readonly error_details?: unknown;
  /** Observacional. NUNCA alimenta a resolução de identidade. */
  readonly cwd?: unknown;
}

/**
 *   `MARKED`  — Stop/StopFailure gravou o desfecho do turno no marcador local
 *   `CLOSED`  — SessionEnd encerrou o ciclo local (marcador limpo). NÃO
 *               publica no Store — `HostObservation`/`session.ended` saíram
 *               no corte presence/capability/observations
 *               (nexos://decision/p0-corte-presence-capability-observations).
 *   `SKIPPED` — condição normal sem o que fazer (evento não reconhecido,
 *               sem identidade)
 *   `FAILED`  — tentou e não deu; o host segue intacto
 */
export type SessionCloseResult =
  | { readonly state: "MARKED"; readonly turn: "completed" | "failed" }
  | {
      readonly state: "CLOSED";
      readonly lastTurn: LastTurnOutcome;
      /**
       * Registro de sessão (18/09) — presente só quando `writeSessionClosed`
       * falhou (fail-open absoluto, `session-events.ts`). O ciclo local
       * segue fechado (`CLOSED` é sempre o estado, mesmo com a escrita
       * falhando) — o registro é observação, nunca autoridade sobre "a
       * sessão encerrou".
       */
      readonly sessionRecordDiagnostic?: string;
    }
  /**
   * `expected: true` — o pulo é o comportamento correto neste ambiente
   * (projeto sem Store é a maioria das máquinas). `false` — o
   * ambiente está quebrado e ninguém saberia:
   *
   *   INDISTINGUISHABLE SUCCESS
   *
   * MEDIDO por outra sessão em 2026-09-19: com e sem `CLAUDE_PROJECT_DIR`, o
   * comando sai `exit=0` e escreve `0 bytes` nos dois casos. Fazer o trabalho
   * e não fazer produziam a MESMA observação, e o `reason` — uma frase
   * correta e acionável — nunca era impresso. Pior que pulo silencioso: pulo
   * indistinguível de sucesso, que nenhum operador poderia ter notado.
   */
  | { readonly state: "SKIPPED"; readonly reason: string; readonly expected: boolean }
  | { readonly state: "FAILED"; readonly reason: string };

const MARKER_SUFFIX = "-close";

function markerFile(projectLocator: string, sessionId: string): string {
  return presentationCacheFile(projectLocator, sessionId, MARKER_SUFFIX);
}

/** Melhor esforço: marcador ausente/corrompido é `undefined` — o chamador trata como "nenhum turno observado ainda". */
async function readMarker(file: string): Promise<SessionCloseMarker | undefined> {
  try {
    return parseSessionCloseMarker(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Melhor esforço: marcador é otimização de fechamento, não contrato — falha aqui não propaga. */
async function writeMarker(file: string, marker: SessionCloseMarker): Promise<void> {
  try {
    await writeFile(file, serializeSessionCloseMarker(marker), "utf-8");
  } catch {
    /* ver comentário acima */
  }
}

/** Melhor esforço: apagar o marcador de um ciclo já encerrado nunca propaga falha. */
async function clearMarker(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* ausente já é o estado desejado */
  }
}

/**
 * NUNCA lança. Entrada inválida, binding ausente, projeto não governado e
 * sessão já fechada são todos `SKIPPED`/`MARKED` — condições normais.
 */
export async function runSessionCloseAdapter(
  input: SessionCloseHookInput,
  env: NodeJS.ProcessEnv
): Promise<SessionCloseResult> {
  const evento = input.hook_event_name;
  if (typeof evento !== "string" || !(EVENTOS as readonly string[]).includes(evento)) {
    return { state: "SKIPPED", reason: `evento não reconhecido: ${JSON.stringify(evento)}`, expected: true };
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (sessionId === "") {
    return { state: "SKIPPED", reason: "session_id ausente — sem correlação não há o que marcar", expected: false };
  }

  /** MISSING HOST PROJECT BINDING != FALL BACK TO LIVE CWD — mesmo gate dos irmãos. */
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    return { state: "SKIPPED", reason: "CLAUDE_PROJECT_DIR ausente — identidade não vem do cwd do hook", expected: false };
  }

  try {
    const resolution = await resolveProject({ cwd: projectDir });
    if (resolution.identitySource !== "manifest" || !resolution.canonicalProjectId) {
      return { state: "SKIPPED", reason: "projeto sem Store — nenhuma trilha onde escrever", expected: true };
    }

    const file = markerFile(resolution.bootstrapLocator, sessionId);

    /**
     * CICLO DE VIDA = do `SessionStart` até o `SessionEnd` que o fecha — não
     * do processo do host, que sobrevive a `SessionEnd` quando a sessão é
     * RETOMADA com o MESMO `session_id` (`resume`). `Stop`/`StopFailure`
     * SOBRESCREVEM o marcador inteiro — um turno novo depois de um
     * fechamento é evidência de que um ciclo NOVO começou nesta mesma sessão.
     * Sem publicação no Store, `SessionEnd` não precisa mais distinguir
     * "já fechei este ciclo" de "ciclo novo": ele só reporta `lastTurn` e
     * limpa o marcador, sempre — idempotente por construção.
     */
    if (evento === "Stop") {
      await writeMarker(file, { turn: "completed" });
      return { state: "MARKED", turn: "completed" };
    }

    if (evento === "StopFailure") {
      const detail =
        typeof input.error === "string" && input.error.trim() ? input.error.trim() : "erro não especificado pelo host";
      await writeMarker(file, { turn: "failed", failure_detail: detail });
      return { state: "MARKED", turn: "failed" };
    }

    // SessionEnd — encerra o ciclo local.
    const existente = await readMarker(file);
    const lastTurn: LastTurnOutcome =
      existente?.turn === "completed" ? "completed" : existente?.turn === "failed" ? "failed" : "none";

    await clearMarker(file);

    /**
     * Registro de sessão (18/09) — o evento `closed` da family `Session`
     * (`schemas.ts`). `writeSessionClosed` NUNCA lança (fail-open absoluto,
     * `session-events.ts`); falha aqui vira diagnóstico, nunca muda o
     * resultado do fechamento local (o marcador já foi limpo acima,
     * independentemente).
     */
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason : null;
    const publish = await writeSessionClosed({
      rootPath: resolution.rootPath,
      projectId: resolution.canonicalProjectId,
      sessionId,
      reason,
    });
    return {
      state: "CLOSED",
      lastTurn,
      ...(publish.ok
        ? {}
        : { sessionRecordDiagnostic: `[nexos claude-session-close] registro de sessão não publicado: ${publish.detail}\n` }),
    };
  } catch (error) {
    return { state: "FAILED", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Entrypoint do hook. stdout SEMPRE vazio — silêncio é a resposta. Exit code SEMPRE 0. */
export async function claudeSessionClose(): Promise<void> {
  let input: SessionCloseHookInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    input = parsed as SessionCloseHookInput;
  } catch {
    /** stdin vazio ou malformado: nada a observar, e nada a reclamar ao host. */
    return;
  }

  const result = await runSessionCloseAdapter(input, process.env);
  if (result.state === "FAILED") {
    process.stderr.write(`[nexos claude-session-close] observação não persistida: ${result.reason}\n`);
  }
  if (result.state === "CLOSED" && result.sessionRecordDiagnostic) {
    process.stderr.write(result.sessionRecordDiagnostic);
  }
  /**
   * Pulo INESPERADO fala; pulo esperado continua mudo.
   *
   * A distinção não é estética: sem Capsule canônica o pulo é o certo, e é o
   * caso da maioria das máquinas — imprimir ali poluiria stderr em todo
   * projeto que não usa NexOS. Já `CLAUDE_PROJECT_DIR` ou `session_id`
   * ausentes descrevem um ambiente de hook quebrado, e é exatamente aí que
   * ninguém era avisado.
   *
   * stderr e não stdout: o host trata stdout de hook como protocolo.
   * Fail-open intacto — isto informa, nunca muda o desfecho.
   */
  if (result.state === "SKIPPED" && !result.expected) {
    process.stderr.write(`[nexos claude-session-close] nada registrado: ${result.reason}\n`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
